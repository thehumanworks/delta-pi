/**
 * Recording pi's subagents, each into a child thread of its own. Pi has no subagents itself:
 * extensions run them as separate pi sessions, usually separate `pi` processes. A recorded session
 * tells everything it starts where its thread is, through the environment they inherit, and a pi
 * session that starts empty with that link, while the session that started it is still live,
 * records into a child thread under that one, its prompts attributed to the session that sent them.
 */
import type { Host } from '../core/host.ts'
import { isJsonObject, isNonEmptyString } from '../core/json.ts'
import { isWithin, samePath } from '../core/paths.ts'
import { type Binding, key, load, save, serial, stateFor, storedBinding } from '../core/session-state.ts'
import { errorText } from '../core/text.ts'
import type { ProcessStream } from '../core/process.ts'
import {
  checkoutSyncing,
  hasWorktreeMount,
  stopWorktreeMount,
  threadCreate,
  threadWatch,
  verifiedContract,
  watchEvents,
} from '../cli/delta-cli.ts'
import { CHILD_CONTRACT_VERSION, DeltaCommandError } from '../cli/thread-commands.ts'
import type { RecordedMessage, Update } from '../recording/content.ts'
import { loseExecution } from '../recording/delivery.ts'
import { cleanTitle, promptTitle } from '../recording/title.ts'
import { attachWorktree, mountCheckout } from '../sharing/checkout.ts'

/** The environment variable a recorded session passes its thread to the sessions it starts in. */
export const PARENT_ENV = 'DELTA_PI_PARENT'
/** A subagent extension may name the child's thread; otherwise the child's first prompt names it. */
export const NAME_ENV = 'DELTA_PI_SUBAGENT_NAME'
const DEFAULT_NAME = 'Subagent'

/**
 * What a recorded session tells the sessions it starts: which session it is, whose binding says where
 * it records and in which directories it works, and its thread once that exists.
 */
export type ParentLink = {
  /** The parent's producer external ID: the parent session's ID. */
  sender: string
  /** The parent's thread when the link was made; a parent that records elsewhere now left it stale. */
  thread?: string
}

/** The value this runtime put in the environment, so it only ever withdraws its own. */
let exported: string | undefined

/**
 * Tell the sessions this one starts that they are its subagents, once its CLI records children. A
 * top-level session does once its thread exists. A subagent does from its start, in place of the link
 * it inherited, so a subagent it starts hangs under its thread, which that one's creation waits for.
 */
export function exportParent(host: Host, binding: Binding | undefined) {
  if (!binding?.snapshot || (!binding.thread && !binding.child)) return
  if ((verifiedContract(binding.session) ?? 0) < CHILD_CONTRACT_VERSION) return
  const link: ParentLink = { sender: binding.session, ...(binding.thread ? { thread: binding.thread } : {}) }
  const value = JSON.stringify(link)
  if (host.env.get(PARENT_ENV) === value) return
  host.env.set(PARENT_ENV, value)
  exported = value
  host.ui.debug(
    binding.thread
      ? `Sessions this one starts record under Delta thread ${binding.thread}.`
      : "Sessions this one starts record under this subagent's Delta thread once it exists.",
  )
}

/** Stop telling new sessions to record under this one, as when it ends. */
export function withdrawParent(host: Host) {
  if (exported !== undefined && host.env.get(PARENT_ENV) === exported) host.env.set(PARENT_ENV, undefined)
  exported = undefined
}

/** The link in the environment, when it is well formed. */
export function parentLink(value: string | undefined): ParentLink | undefined {
  if (!value) return
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return
  }
  if (!isJsonObject(parsed) || !isNonEmptyString(parsed.sender)) return
  if (parsed.thread !== undefined && !isNonEmptyString(parsed.thread)) return
  return { sender: parsed.sender, ...(parsed.thread !== undefined ? { thread: parsed.thread } : {}) }
}

/** A live recorded session that started this one, and its binding as the store holds it. */
export type ChildParent = { link: ParentLink; parent: Binding }

/**
 * The recorded session that started this one, when it is still live, or `stale` when the link is left
 * in an environment that outlived its session, as a long-running worker's is.
 */
export async function childLink(host: Host, session: string): Promise<ChildParent | 'stale' | undefined> {
  const link = parentLink(host.env.get(PARENT_ENV))
  if (!link || link.sender === session) return
  const parent = await storedBinding(host, key(link.sender))
  if (!parent?.snapshot || parent.endedAt !== undefined) return 'stale'
  if (link.thread !== undefined && parent.thread !== link.thread) return 'stale'
  return { link, parent }
}

/**
 * The directories a session works in, which a subagent it starts shares when it works in one of them:
 * the session's checkout, or a joined session's directory and each worktree mounted for it; or the
 * directories a subagent works in.
 */
function workingDirectories(binding: Binding): string[] {
  if (binding.child) return binding.child.directories ?? [binding.child.root]
  return [
    binding.joined ? binding.directory : binding.checkout,
    ...(binding.mounts ?? []).map((mount) => mount.directory),
  ].filter((directory): directory is string => !!directory)
}

/** The reference `thread create --parent` takes for the thread `parent` records into, once it exists. */
function threadReference(parent: Binding): string | undefined {
  return parent.child ? parent.child.reference : (parent.locator ?? parent.thread)
}

/**
 * Make this new session a subagent recorded under the thread of the session that started it; its
 * thread is created with its first record.
 */
export async function beginChild(host: Host, session: string, { link, parent }: ChildParent) {
  const cwd = host.session.cwd()
  const directories = workingDirectories(parent)
  // A subagent working in a checkout of its own, such as a Git worktree, even one inside its parent's
  // checkout, attaches that checkout to its thread while it runs there. One working in its parent's
  // checkout shares the parent's worktrees, and one that works nowhere in Git has no files to share.
  const root = await gitRoot(host, cwd)
  const shared =
    root === undefined
      ? directories.find((directory) => isWithin(cwd, directory))
      : directories.find((directory) => samePath(directory, root))
  const own = shared === undefined ? root : undefined
  const reference = threadReference(parent)
  await serial(async () => {
    const existing = await load(host, session)
    if (existing.snapshot || existing.thread) return
    await save(host, {
      session,
      snapshot: true,
      next: 1,
      pending: [],
      ...(own ? { checkout: own } : {}),
      child: {
        ...(reference ? { parent: reference } : {}),
        sender: link.sender,
        ...childName(host),
        sharesParentCheckout: shared !== undefined,
        root: shared ?? own ?? cwd,
        directories: shared !== undefined ? directories : [own ?? cwd],
      },
    })
  })
  host.ui.debug(
    parent.thread
      ? `This session records as a subagent under Delta thread ${parent.thread}.`
      : `This session records as a subagent of session ${link.sender}, under its thread once that exists.`,
  )
}

/** The name the extension that started the subagent gave it, or the default its first prompt replaces. */
function childName(host: Host): { name: string; named?: true } {
  const name = cleanTitle(host.env.get(NAME_ENV), 80)
  return name ? { name, named: true } : { name: DEFAULT_NAME }
}

/** How a subagent's records differ: where paths are shown from, and who its prompts come from. */
export function childFields(binding: Binding | undefined) {
  const child = binding?.child
  if (!child) return
  return {
    root: child.root,
    /** A prompt reaches a subagent from the agent that started it, so it is shown as that agent's. */
    attribute(update: Update, message: RecordedMessage): Update {
      if (update.sessionUpdate !== 'user_message' || message.role !== 'user') return update
      return sentBy(update, child.sender)
    },
  }
}

/**
 * Attribute a recorded prompt to the recorded conversation that sent it, so Delta shows it as that
 * agent's words rather than the person's.
 */
export function sentBy(update: Update, sender: string): Update {
  if (update.sessionUpdate !== 'user_message') return update
  const metadata = isJsonObject(update._meta) ? update._meta : {}
  const delta = isJsonObject(metadata.delta) ? metadata.delta : {}
  return { ...update, _meta: { ...metadata, delta: { ...delta, sender: { external_id: sender } } } }
}

/** Name a subagent's thread for its first prompt, unless the extension that started it named it. */
export async function nameChild(host: Host, session: string, text: string) {
  const binding = stateFor(session).binding
  if (!binding?.child || binding.thread || binding.child.named) return
  const name = promptTitle(text)
  if (!name) return
  await serial(async () => {
    const current = await load(host, session)
    if (!current.child || current.thread) return
    await save(host, { ...current, child: { ...current.child, name } })
  })
}

/**
 * Whether the subagent still needs its thread created, or its own checkout attached or mounted, before
 * its records are sent.
 */
export function childNeedsSetup(binding: Binding): boolean {
  if (!binding.child) return false
  if (!binding.thread) return true
  return !!binding.checkout && (!binding.checkoutReference || !hasWorktreeMount(binding.session, binding.checkout))
}

/**
 * Create the subagent's child thread under its parent's, once, then attach its own checkout to it and
 * keep that mounted, before its records are sent. Each step is saved as it finishes, so one that fails
 * is retried with the next delivery; once the session is no longer `current`, nothing more starts, and
 * a mount that started meanwhile is stopped.
 */
export async function ensureChildThread(host: Host, binding: Binding, current: () => boolean): Promise<Binding> {
  const check = async () => {
    if (!current()) throw new Error("The subagent's session ended while its thread was being prepared")
  }
  // Nothing starts for a session that is no longer current, as after the contract check this follows.
  await check()
  let next = binding
  if (next.child && !next.thread) next = await createChildThread(host, next, check)
  const checkout = next.checkout
  if (!next.child || !next.thread || !checkout) return next
  if (!next.checkoutReference) {
    const checkoutReference = await attachWorktree(host, checkout, next.thread, undefined, check, next.session)
    await check()
    next = await serial(async () => {
      const saved = { ...(await load(host, binding.session)), checkoutReference, pendingWorktree: undefined }
      await save(host, saved)
      return saved
    })
  }
  // The mount keeps the checkout synchronized until the subagent's session ends.
  if (!hasWorktreeMount(next.session, checkout)) await mountCheckout(host, next, check)
  return next
}

/**
 * How long a subagent's end waits for Delta to stop syncing its own checkout after its mount ends.
 * Delta bounds the final upload at 5 seconds, then stops watching the directory.
 */
const CHILD_RELEASE_BUDGET_MS = 6_000
/** How often a finishing subagent's checkout is checked for Delta's release. */
const CHILD_RELEASE_POLL_MS = 100

/**
 * End the mount of a subagent's own checkout as its session ends, and wait, within a budget, until Delta
 * no longer syncs it: the code that started the subagent may remove that checkout, such as a Git
 * worktree it made for it, as soon as the subagent's pi exits. The thread keeps the checkout attached.
 */
export async function releaseChildCheckout(host: Host, binding: Binding | undefined) {
  const checkout = binding?.child ? binding.checkout : undefined
  if (!binding || !checkout) return
  try {
    // Delta finishes a checkout after its mount command ends, so it stops watching the directory first.
    if (await stopWorktreeMount(binding.session, checkout)) await awaitCheckoutReleased(host, checkout)
  } catch (error) {
    host.ui.debug(`Delta could not release this subagent's checkout: ${errorText(error)}`)
  }
}

/** Wait until Delta no longer syncs `directory`, within `CHILD_RELEASE_BUDGET_MS`. */
async function awaitCheckoutReleased(host: Host, directory: string) {
  const deadline = host.clock.now() + CHILD_RELEASE_BUDGET_MS
  for (;;) {
    const remaining = deadline - host.clock.now()
    if (remaining <= 0)
      throw new Error(
        `Delta was still syncing ${directory} ${CHILD_RELEASE_BUDGET_MS / 1000} seconds after its mount ended`,
      )
    if (!(await checkoutSyncing(host, directory, remaining))) return
    await host.clock.sleep(Math.min(CHILD_RELEASE_POLL_MS, remaining))
  }
}

async function createChildThread(host: Host, binding: Binding, check: () => Promise<void>): Promise<Binding> {
  const child = binding.child!
  // A subagent started before its parent's thread existed finds that thread in its parent's binding,
  // and retries while the parent's own delivery creates it.
  const parent = child.parent ?? (await parentThreadReference(host, child.sender))
  if (!parent)
    throw new DeltaCommandError('parent_pending', 'the session that started this subagent has no Delta thread yet', {
      retryable: true,
    })
  const created = await threadCreate(host, {
    externalId: binding.session,
    parent: {
      reference: parent,
      name: child.name,
      ...(child.sharesParentCheckout ? { worktrees: 'shared' as const } : {}),
    },
    check,
  })
  if (typeof created.reference !== 'string' || !created.reference)
    throw new Error("thread create: Delta returned no reference for the subagent's thread")
  const reference = created.reference
  // The thread exists now whether or not the session still does: saving it lets a resumed session
  // use it rather than create another.
  const saved = await serial(async () => {
    const current = await load(host, binding.session)
    const next = { ...current, thread: created.thread_id, child: { ...current.child!, reference } }
    await save(host, next)
    return next
  })
  await check()
  return saved
}

/** The reference of the thread the session `sender` records into, once it exists. */
async function parentThreadReference(host: Host, sender: string): Promise<string | undefined> {
  const parent = await storedBinding(host, key(sender))
  return parent?.snapshot ? threadReference(parent) : undefined
}

async function gitRoot(host: Host, cwd: string): Promise<string | undefined> {
  try {
    const result = await host.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd })
    return result.exitCode === 0 && !result.isStdoutTruncated ? result.stdout.trim() || undefined : undefined
  } catch {
    return undefined
  }
}

/** Why pi stops a subagent's turn that someone took over in Delta. */
export const CHILD_TAKEOVER = "Someone took this subagent's thread over in Delta"

/** The watch that follows a subagent's running turn, so a takeover in Delta stops it at once. */
let turnWatch: { sequence: number; stop: () => void } | undefined

/**
 * While a subagent's turn runs, watch its thread so a stop or a message in Delta, which supersedes
 * that turn, stops pi within moments rather than at the next append, which a long tool call can hold
 * back. A watch that fails is only logged: the next append's fence still stops the turn.
 */
export function followChildTurn(host: Host, session: string) {
  const binding = stateFor(session).binding
  const sequence = binding?.execution?.sequence
  const reference = binding?.child?.reference
  if (sequence === undefined || !reference || turnWatch?.sequence === sequence) return
  turnWatch?.stop()
  let stopped = false
  let stream: ProcessStream | undefined
  const watch = {
    sequence,
    stop: () => {
      stopped = true
      void stream?.return({ code: null, signal: 'SIGTERM' }).catch(() => {})
    },
  }
  turnWatch = watch
  void (async () => {
    stream = await threadWatch(host, reference, {
      externalId: session,
      proceed: () => !stopped && stateFor(session).binding?.execution?.sequence === sequence,
    })
    if (!stream || stopped) return
    for await (const event of watchEvents(stream)) {
      if (stopped) return
      const turn = event.type === 'producer.turn' ? event : event.type === 'ready' ? event.producer?.turn : undefined
      if (turn?.sequence === sequence && turn.status === 'superseded') {
        await loseExecution(host, session, sequence, CHILD_TAKEOVER)
        return
      }
    }
  })()
    .catch((error: unknown) => host.ui.debug(`Delta could not follow this subagent's turn: ${errorText(error)}`))
    .finally(() => {
      watch.stop()
      if (turnWatch === watch) turnWatch = undefined
    })
}

/** Stop following the subagent's turn, as when it ends. */
export function stopChildTurn() {
  turnWatch?.stop()
  turnWatch = undefined
}
