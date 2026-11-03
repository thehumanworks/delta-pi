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
import { hasWorktreeMount, threadCreate, threadWatch, verifiedContract, watchEvents } from '../cli/delta-cli.ts'
import { CHILD_CONTRACT_VERSION } from '../cli/thread-commands.ts'
import type { RecordedMessage, Update } from '../recording/content.ts'
import { loseExecution } from '../recording/delivery.ts'
import { cleanTitle, promptTitle } from '../recording/title.ts'
import { attachWorktree, mountCheckout } from '../sharing/checkout.ts'

/** The environment variable a recorded session passes its thread to the sessions it starts in. */
export const PARENT_ENV = 'DELTA_PI_PARENT'
/** A subagent extension may name the child's thread; otherwise the child's first prompt names it. */
export const NAME_ENV = 'DELTA_PI_SUBAGENT_NAME'
const DEFAULT_NAME = 'Subagent'

/** What a recorded session tells the sessions it starts. */
export type ParentLink = {
  thread: string
  /** The parent thread as `thread create --parent` takes it. */
  reference: string
  /** The parent's producer external ID: the parent session's ID. */
  sender: string
  /** The directories the parent works in; a child working in one of them shares its worktrees. */
  directories: string[]
}

/** The value this runtime put in the environment, so it only ever withdraws its own. */
let exported: string | undefined

/**
 * Tell the sessions this one starts where its thread is. Only a top-level recorded session does, and
 * only once its thread exists and its CLI records children; a subagent's own subagents hang under
 * the session that started it, since they inherit its link.
 */
export function exportParent(host: Host, binding: Binding | undefined) {
  if (!binding?.thread || !binding.snapshot || binding.child) return
  if ((verifiedContract(binding.session) ?? 0) < CHILD_CONTRACT_VERSION) return
  const directories = [
    binding.joined ? binding.directory : binding.checkout,
    ...(binding.mounts ?? []).map((mount) => mount.directory),
  ].filter((directory): directory is string => !!directory)
  const link: ParentLink = {
    thread: binding.thread,
    reference: binding.locator ?? binding.thread,
    sender: binding.session,
    directories,
  }
  const value = JSON.stringify(link)
  if (host.env.get(PARENT_ENV) === value) return
  host.env.set(PARENT_ENV, value)
  exported = value
  host.ui.debug(`Sessions this one starts record under Delta thread ${binding.thread}.`)
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
  if (
    !isJsonObject(parsed) ||
    !isNonEmptyString(parsed.thread) ||
    !isNonEmptyString(parsed.reference) ||
    !isNonEmptyString(parsed.sender) ||
    !Array.isArray(parsed.directories) ||
    !parsed.directories.every(isNonEmptyString)
  )
    return
  return { thread: parsed.thread, reference: parsed.reference, sender: parsed.sender, directories: parsed.directories }
}

/**
 * The recorded session that started this one, when it is still live, or `stale` when the link is left
 * in an environment that outlived its session, as a long-running worker's is.
 */
export async function childLink(host: Host, session: string): Promise<ParentLink | 'stale' | undefined> {
  const link = parentLink(host.env.get(PARENT_ENV))
  if (!link || link.sender === session) return
  const parent = await storedBinding(host, key(link.sender))
  if (!parent?.snapshot || parent.thread !== link.thread || parent.endedAt !== undefined) return 'stale'
  return link
}

/** Make this new session a subagent recorded under `link`'s thread; its thread is created with its first record. */
export async function beginChild(host: Host, session: string, link: ParentLink) {
  const cwd = host.session.cwd()
  // A subagent working in a checkout of its own, such as a Git worktree, even one inside its parent's
  // checkout, attaches that checkout to its thread while it runs there. One working in its parent's
  // checkout shares the parent's worktrees, and one that works nowhere in Git has no files to share.
  const root = await gitRoot(host, cwd)
  const shared =
    root === undefined
      ? link.directories.find((directory) => isWithin(cwd, directory))
      : link.directories.find((directory) => samePath(directory, root))
  const own = shared === undefined ? root : undefined
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
        parent: link.reference,
        sender: link.sender,
        ...childName(host),
        sharesParentCheckout: shared !== undefined,
        root: shared ?? own ?? cwd,
      },
    })
  })
  host.ui.debug(`This session records as a subagent under Delta thread ${link.thread}.`)
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

async function createChildThread(host: Host, binding: Binding, check: () => Promise<void>): Promise<Binding> {
  const child = binding.child!
  const created = await threadCreate(host, {
    externalId: binding.session,
    parent: {
      reference: child.parent,
      name: child.name,
      ...(child.sharesParentCheckout ? { worktrees: 'shared' as const } : {}),
    },
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

async function gitRoot(host: Host, cwd: string): Promise<string | undefined> {
  try {
    const result = await host.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd })
    return result.exitCode === 0 && !result.isStdoutTruncated ? result.stdout.trim() || undefined : undefined
  } catch {
    return undefined
  }
}

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
        await loseExecution(host, session, sequence, "Someone took this subagent's thread over in Delta")
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
