/**
 * `/delta join` and what a joined session keeps up: mounting the thread's worktrees, starting a pi
 * session in their folder, and restoring and releasing mounts.
 *
 * Pi works in one directory per session, so a join starts a session of its own in the thread's
 * folder: it mounts the thread for that session, writes the session's file there, and switches pi
 * into it. The new session finishes joining before its first prompt, and the session that joined
 * stays as it was, ready to resume.
 */
import { randomUUID } from 'node:crypto'
import { remove } from '../core/files.ts'
import type { Host } from '../core/host.ts'
import { samePath } from '../core/paths.ts'
import {
  activation,
  type Binding,
  isPaused,
  key,
  load,
  recoveryCommand,
  requests,
  resumeCheckout,
  save,
  serial,
  sessions,
  stateFor,
} from '../core/session-state.ts'
import { errorText } from '../core/text.ts'
import { AccessRequiredError, requireAuthentication } from '../cli/auth.ts'
import {
  type CommandForm,
  rememberContract,
  requireContract,
  resolveCli,
  stopSessionMounts,
  stopThreadMounts,
  threadMount,
  threadStatus,
} from '../cli/delta-cli.ts'
import { classifyCommandFailure, DeltaCommandError, type MountedThread } from '../cli/thread-commands.ts'
import { finishProgress, setProgress } from '../band/band.ts'
import {
  drain,
  endDeliveryFailures,
  flushUnsaved,
  isInDirectory,
  recoverExecution,
  verifyCheckout,
} from '../recording/delivery.ts'
import { deliveryRetryDelay } from '../recording/delivery-policy.ts'
import { finishRestoredActivation } from '../setup/activation.ts'
import { authenticationHost } from '../setup/interaction.ts'
import { deliverNote } from '../watch/rows.ts'
import { isCurrentReady, isRetrying, startConversation, statusFields, stopConversation } from '../watch/watch.ts'
import { joinPreflight, worktreeChanges } from './lifecycle.ts'

/** A join to finish in the session it switched into, whose mounts `owner` holds. */
export type JoinPlan = {
  session: string
  cwd: string
  locator: string
  thread: string
  owner: string
  directory: string
}
export type JoinRequest = {
  session: string
  cwd: string
  locator: string
  cancelled?: boolean
  /** The session file pi switched to when it ended this request's session. */
  handedTo?: string
  form?: CommandForm
}
/** Switching pi to another session, which only a command handler may do. */
export type SessionSwitch = { switchSession(path: string): Promise<{ cancelled: boolean }> }

/**
 * Join a thread: it is in progress from now, reported through the band, and refuses prompts until
 * the session it starts takes over. Runs inside the command, since switching sessions is a command's.
 */
export async function startJoin(host: Host, request: JoinRequest, replace: SessionSwitch) {
  requests.join = request
  setProgress(host, 'Checking access to the shared thread…', 'active')
  let mounted: { owner: string; thread: string } | undefined
  /** The session the join prepared to switch to, until pi has switched to it. */
  let prepared: { session: string; file: string } | undefined
  let switched = false
  try {
    assertJoinSession(host, request.session, request)
    const pending = await load(host, request.session)
    const runtime = stateFor(request.session)
    if (!host.session.idle() || runtime.promptEntering) throw new Error('Wait for pi to become idle before joining')
    if (runtime.restoring || runtime.restoringCheckout)
      throw new Error("Wait for Delta to finish restoring this session's worktrees before joining")
    // Refuse a CLI this extension cannot record against before anything is mounted.
    await resolveCli(host, (text) => setProgress(host, text, 'active'))
    const contractVersion = await requireContract(host, request.session)
    const check = async () => assertJoinSession(host, request.session, request)
    await requireAuthentication(authenticationHost(host), await resolveCli(host), check, async (text) => {
      await check()
      setProgress(host, 'Waiting for Delta sign-in…', 'active')
      host.ui.note(text)
    })
    await check()
    // A session a join switched into that could not finish joining retries in place, with the owner and
    // folder it was started for, rather than starting yet another session.
    const transition = pending.joinTransition
    if (transition) {
      if (runtime.joining) throw new Error('This session is still joining its thread; wait for that to finish')
      if (transition.locator !== request.locator)
        throw new Error(`This session is joining ${transition.locator}; retry /delta-join with that link`)
      const owns = () => !request.cancelled && activation.session === request.session
      const joining = completeJoinTransition(host, request.session, transition, owns)
      runtime.joining = joining
      await joining
      if (runtime.joining === joining) runtime.joining = undefined
      return
    }
    let status = pending.joined ? await readJoinStatus(host, request) : undefined
    assertJoinSession(host, request.session, request)
    // A joined session working in its thread's folder reconnects in place.
    if (
      pending.joined &&
      status?.thread_id === pending.thread &&
      pending.directory &&
      isInDirectory(host, pending.directory)
    ) {
      await reconnect(host, request)
      return
    }
    status ??= await readJoinStatus(host, request)
    assertJoinSession(host, request.session, request)
    if (joinPreflight(status) === 'access')
      throw new Error(
        'Joining requires authenticated access to an already shared thread; check your Delta sign-in and link',
      )
    // Refuse here what a mount could never satisfy, while this session is still untouched.
    if (joinPreflight(status) === 'empty') throw new Error('This thread has no worktree to join')
    const fresh = randomUUID()
    setProgress(host, "Mounting the thread's worktrees…", 'active')
    const mount = await threadMount(host, {
      session: fresh,
      thread: status.thread_id,
      locator: request.locator,
      owner: fresh,
      join: true,
      form: request.form,
      check,
    })
    mounted = { owner: fresh, thread: status.thread_id }
    await check()
    requireMounted(mount, status.thread_id)
    // The session the join starts records nothing until it has checked its mounts.
    const plan: JoinPlan = {
      session: request.session,
      cwd: request.cwd,
      locator: request.locator,
      thread: status.thread_id,
      owner: fresh,
      directory: mount.directory,
    }
    prepared = { session: fresh, file: await host.session.create(fresh, mount.directory, host.session.file()) }
    await save(host, { session: fresh, snapshot: false, next: 1, pending: [], joinTransition: plan })
    joinContracts.set(fresh, contractVersion)
    setProgress(host, "Starting a pi session in the thread's folder…", 'active')
    host.ui.debug(
      `Joining Delta in pi session ${fresh} at ${mount.directory}. Resume the previous session ${request.session} with /resume from ${request.cwd}.`,
    )
    await check()
    // Pi shuts this session down while it switches, which cancels this request and names the session it
    // switched to: once that is the prepared one, it owns the mount, and nothing below may use this
    // session's pi context. A switch that fails or is refused before that leaves this session as it was.
    const file = prepared.file
    const outcome = await replace.switchSession(file).catch((error: unknown) => {
      if (request.handedTo === file) return { cancelled: false }
      throw error
    })
    if (outcome.cancelled) throw new Error("pi did not switch to the thread's session")
    switched = true
  } catch (error) {
    if (switched || (prepared && request.handedTo === prepared.file)) return
    // The join did not hand its mount to the prepared session: nothing it made is left behind, even when
    // another switch ended this session first.
    if (mounted) await unmountThread(host, mounted.thread, mounted.owner)
    if (prepared) await abandonPrepared(host, prepared)
    if (request.cancelled) return
    const invalidLocator = error instanceof DeltaCommandError && error.code === 'invalid_reference'
    // Sign-in runs before anything changes, so an access requirement leaves nothing to preserve.
    const text =
      error instanceof AccessRequiredError
        ? error.message
        : `Delta join failed: ${errorText(error)}. ${
            invalidLocator
              ? "This session and folder were preserved. Use the thread's share link with /delta-join instead of retrying this locator."
              : `This session and folder were preserved. Retry /delta-join ${request.locator}.`
          }`
    setProgress(host, text, 'error')
    host.ui.note(text, 'error')
  } finally {
    if (requests.join === request) requests.join = undefined
  }
}

/** Remove what a join prepared for a session pi never switched to: its binding, contract and session file. */
async function abandonPrepared(host: Host, prepared: { session: string; file: string }) {
  joinContracts.delete(prepared.session)
  await host.store.delete(key(prepared.session))
  await remove(prepared.file)
}

/** The contract the session that joined verified, for the session it switched into. */
const joinContracts: Map<string, number> = ((globalThis as Record<symbol, unknown>)[
  Symbol.for('pi-delta.join-contracts')
] ??= new Map()) as never

/** Reconnect a joined session that already works in its thread's folder, keeping its checkouts and producer state. */
async function reconnect(host: Host, request: JoinRequest) {
  const session = request.session
  const runtime = stateFor(session)
  const check = async () => assertJoinSession(host, session, request)
  setProgress(host, 'Reconnecting to the shared thread…', 'active')
  await restoreMounts(host, session, check)
  await verifyCheckout(host, await load(host, session))
  await check()
  if (runtime.unsaved.length) await flushUnsaved(host, session)
  const binding = await load(host, session)
  if (runtime.captureFailure || binding.captureFailure)
    throw new Error(
      `a pi message could not be saved locally (${runtime.captureFailure ?? binding.captureFailure}); restore the outbox before retrying`,
    )
  resumeCheckout(runtime, 'delivery')
  endDeliveryFailures(runtime)
  runtime.joinFailure = undefined
  if (isRetrying()) await stopConversation()
  await check()
  await startConversation(host, session)
  await recoverExecution(host, session)
  await drain(host, session)
  await check()
  await verifyCheckout(host, await load(host, session))
  if (isPaused(runtime) || runtime.unsaved.length)
    throw new Error('Joined participation remains paused; saved records remain queued')
  host.ui.debug(
    `Reconnected to the joined Delta thread in pi session ${session}; the checkout and producer state were preserved.`,
  )
  finishProgress(host, 'Joined the shared thread', 'done')
}

/**
 * Finish a join in the session it switched into: take over the mount the joining session started
 * for it, check every worktree is mounted where pi works, and start recording live activity only.
 * A failure holds prompts until /delta join is run again.
 */
export async function completeJoinTransition(host: Host, session: string, plan: JoinPlan, owns: () => boolean) {
  const runtime = stateFor(session)
  try {
    setProgress(host, 'Connecting to the shared thread…', 'active')
    const verified = joinContracts.get(session)
    joinContracts.delete(session)
    if (verified !== undefined) rememberContract(session, verified)
    await requireContract(host, session)
    if (!owns()) return
    if (!isInDirectory(host, plan.directory))
      throw new Error(`pi did not start in the thread's folder ${plan.directory}; participation remains paused`)
    // Mounting again under the same owner is idempotent; it replaces the joining session's process.
    const mounted = await mountThread(
      host,
      { session, thread: plan.thread, locator: plan.locator, owner: plan.owner },
      { check: ownership(owns) },
    )
    if (!owns()) return
    requireMounted(mounted, plan.thread)
    const binding: Binding = {
      session,
      thread: plan.thread,
      locator: plan.locator,
      joined: true,
      owner: plan.owner,
      directory: plan.directory,
      mounts: mounted.worktrees,
      // snapshot means live recording is enabled, not that old history must be exported.
      snapshot: true,
      next: 1,
      pending: [],
    }
    const status = await verifyCheckout(host, binding)
    if (!owns()) return
    Object.assign(binding, statusFields(status))
    await serial(async () => save(host, binding, owns))
    runtime.binding = binding
    runtime.mounted = true
    runtime.joinFailure = undefined
    await startConversation(host, session)
    if (!owns()) return
    resumeCheckout(runtime, 'watcher')
    finishProgress(host, 'Joined the shared thread', 'done')
    host.ui.note(
      `Joined the Delta thread in ${plan.directory}. Its conversation so far reaches pi's context here; the session you joined from stays as it was (resume it with /resume).`,
    )
  } catch (error) {
    if (!owns()) return
    const text = `Delta couldn't finish joining the thread in this session: ${errorText(error)}. Run /delta-join ${plan.locator} to retry.`
    runtime.joinFailure = text
    setProgress(host, text, 'error')
    host.ui.note(text, 'error')
  }
}

/** How long a join waits out failures Delta marks retryable, such as a daemon still connecting. */
const JOIN_RETRY_BUDGET_MS = 30_000

/**
 * Reads the thread's status for a join, retrying failures Delta marks retryable.
 *
 * A join often runs right after the session starts, when Delta's daemon may still be connecting
 * and answers `disconnected`; a person waiting on the join should not have to retry that.
 */
async function readJoinStatus(host: Host, request: JoinRequest) {
  const deadline = host.clock.now() + JOIN_RETRY_BUDGET_MS
  for (let attempt = 0; ; attempt++) {
    try {
      return await threadStatus(host, request.locator, request.session)
    } catch (error) {
      const delay = deliveryRetryDelay(
        attempt,
        error instanceof DeltaCommandError ? error.hints.retryAfterMs : undefined,
      )
      if (classifyCommandFailure(error) !== 'transient' || host.clock.now() + delay > deadline) throw error
      setProgress(host, 'Waiting for Delta to connect…', 'active')
      await host.clock.sleep(delay)
      assertJoinSession(host, request.session, request)
    }
  }
}

function assertJoinSession(host: Host, session: string, request: JoinRequest) {
  if (request.cancelled || host.session.id() !== session)
    throw new Error('The pi session changed during join; the obsolete join was stopped')
}

/**
 * Keep the checkout of every worktree of a joined thread mounted for this session, as its thread's
 * attachments change, until this session stops the mount.
 */
export async function mountThread(
  host: Host,
  binding: { session: string; thread?: string; locator?: string; owner?: string },
  options: { reportJoin?: boolean; form?: CommandForm; check?: () => Promise<void> } = {},
): Promise<MountedThread> {
  const locator = binding.locator ?? binding.thread
  if (!locator) throw new Error('This session has no thread to mount')
  return threadMount(host, {
    session: binding.session,
    thread: binding.thread ?? locator,
    locator,
    owner: binding.owner ?? binding.session,
    join: !!options.reportJoin,
    form: options.form,
    ...(options.check ? { check: options.check } : {}),
  })
}

/** A mount's check that its session still owns it; one that no longer does is stopped, not kept. */
function ownership(owns: () => boolean): () => Promise<void> {
  return async () => {
    if (!owns()) throw new Error('The session ended while its thread was being mounted')
  }
}

/** What a mount that joining or restoring can use: the right thread, and something to work in. */
export function requireMounted(mounted: MountedThread, thread: string | undefined) {
  if (mounted.thread_id !== thread) throw new Error('Delta mounted a different thread; nothing was changed')
  if (!mounted.worktrees.length) throw new Error('This thread has no worktree to join')
}

/**
 * Mount a joined session's worktrees again. Mounting is idempotent: it restores what was removed
 * after the session's owner process last ran. Pi stays in the directory the session was joined in,
 * which must still be one of them.
 */
async function restoreMounts(host: Host, session: string, check: () => Promise<void>) {
  const binding = await serial(() => load(host, session))
  await check()
  const mounted = await mountThread(host, binding, { check })
  await check()
  requireMounted(mounted, binding.thread)
  const directory = binding.directory ?? mounted.directory
  const inside = [mounted.directory, ...mounted.worktrees.map((tree) => tree.directory)].some((candidate) =>
    samePath(candidate, directory),
  )
  if (!inside || !isInDirectory(host, directory))
    throw new Error(
      `this session works in ${directory}, which is no longer where Delta mounts the thread (${mounted.directory}); run /delta-join ${binding.locator ?? binding.thread} to open a session there`,
    )
  await serial(async () => {
    await check()
    await save(host, {
      ...(await load(host, session)),
      owner: binding.owner ?? session,
      directory,
      mounts: mounted.worktrees,
    })
  })
  stateFor(session).mounted = true
}

/**
 * Restore a resumed joined session in the background: prompts wait, and the band shows progress.
 */
export function beginRestore(host: Host, session: string) {
  const runtime = stateFor(session)
  if (runtime.restoring) return
  runtime.restoring = true
  setProgress(host, "Restoring the thread's worktrees…", 'active')
  const owns = () => activation.session === session && sessions.get(session) === runtime
  host.clock.after(0, async () => {
    try {
      await restoreMounts(host, session, async () => {
        if (!owns()) throw new Error('The session ended while its worktrees were being restored')
      })
      const binding = await serial(() => load(host, session))
      await startParticipation(host, session, binding, owns)
      if (!owns()) return
      finishProgress(
        host,
        `Restored ${binding.mounts?.length ?? 0} worktree${binding.mounts?.length === 1 ? '' : 's'}`,
        'done',
      )
      await finishRestoredActivation(host, session, binding, owns)
    } catch (error) {
      if (!owns()) return
      const text = `Delta couldn't restore this session's worktrees: ${errorText(error)}. Retry ${recoveryCommand(runtime.binding)}; prompts are held until then.`
      runtime.joinFailure = text
      setProgress(host, text, 'error')
      host.ui.note(text, 'error')
    } finally {
      runtime.restoring = undefined
    }
  })
}

/** Stop `owner`'s mount of `thread`, if this pi process still holds it; a failure is only logged. */
export async function unmountThread(host: Host, thread: string, owner: string) {
  try {
    await stopThreadMounts(owner)
  } catch (error) {
    host.ui.debug(`Delta could not stop ${thread}'s mount: ${String(error)}`)
  }
}

/** The worktrees of a joined thread changed: re-mount, then tell the model and the person. */
export function refreshMounts(host: Host, session: string, listed: { reference: string }[]) {
  const runtime = stateFor(session)
  runtime.mountRefresh = (runtime.mountRefresh ?? Promise.resolve())
    .then(() => applyWorktrees(host, session, listed))
    .catch((error: unknown) => {
      if (activation.session !== session) return
      const text = `Delta couldn't update this session's worktrees: ${errorText(error)}`
      setProgress(host, text, 'error')
      host.ui.note(text, 'error')
    })
}

async function applyWorktrees(host: Host, session: string, listed: { reference: string }[]) {
  const runtime = stateFor(session)
  if (activation.session !== session || !runtime.mounted) return
  const binding = await serial(() => load(host, session))
  const previous = binding.mounts
  if (!binding.joined || !previous) return
  // Every reconnect reports the current list; most of those change nothing.
  if (
    listed.length === previous.length &&
    listed.every((tree) => previous.some((mount) => mount.reference === tree.reference))
  )
    return
  const mounted = await mountThread(host, binding, { check: ownership(() => activation.session === session) })
  if (activation.session !== session || mounted.thread_id !== binding.thread) return
  await serial(async () => save(host, { ...(await load(host, session)), mounts: mounted.worktrees }))
  const { added, removed, moves } = worktreeChanges(previous, binding.directory, mounted)
  if (!added.length && !removed.length) return
  const names = (trees: { name: string }[]) => trees.map((tree) => tree.name).join(', ')
  const changes = [added.length ? `added ${names(added)}` : '', removed.length ? `removed ${names(removed)}` : '']
    .filter(Boolean)
    .join('; ')
  // The directory pi works in no longer holds the thread: a session of its own in the thread's
  // folder is the way back, since pi keeps one directory per session.
  const gone = removed.some((mount) => binding.directory !== undefined && samePath(mount.directory, binding.directory))
  finishProgress(
    host,
    `Thread worktrees changed: ${changes}${moves ? ` · /delta-join opens the thread folder` : ''}`,
    'done',
  )
  await deliverNote(
    host,
    session,
    [
      `[Delta] This thread's worktrees changed (${changes}). They are now:`,
      ...mounted.worktrees.map((tree) => `- ${tree.name}: ${tree.directory}`),
      gone
        ? `This session's directory ${binding.directory} is no longer one of them; use the paths above.`
        : `This session's directory is ${binding.directory}; use the paths above to work in the others.`,
    ].join('\n'),
  )
  if (gone)
    host.ui.note(
      `The worktree this session works in left the Delta thread. Run /delta-join ${binding.locator ?? binding.thread} to continue in the thread folder ${mounted.directory}.`,
      'warning',
    )
}

/** Check a joined session's mounts, then watch the thread; the watch lifts the watcher pause once live. */
export async function startParticipation(host: Host, session: string, binding: Binding, owns: () => boolean) {
  if (binding.joined) await verifyCheckout(host, binding)
  if (!owns()) return
  const ready = await startConversation(host, session)
  if (owns() && isCurrentReady(ready)) resumeCheckout(stateFor(session), 'watcher')
}

/**
 * A session's end releases its checkouts: Delta uploads what is left, then stops syncing them, and a
 * resumed session mounts them again. A reload keeps them, since the same session carries on; so does
 * the mount a join started for the session it switches into, which that session takes over.
 */
export async function releaseOnEnd(host: Host, session: string, reason: string) {
  if (reason === 'reload') return
  try {
    await stopSessionMounts(session)
  } catch (error) {
    host.ui.debug(`Delta mount process did not stop: ${String(error)}`)
  }
}
