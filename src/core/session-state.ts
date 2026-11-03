/**
 * The session's state in this extension runtime and its binding in the store: whether it is
 * recorded, the join and share in flight, checkout pauses, and loading and saving bindings one at
 * a time. Pi replaces the runtime, and so this module's state, whenever it switches sessions.
 */
import type { Timer } from './clock.ts'
import { type Execution, restoreBinding } from './binding.ts'
import type { Host } from './host.ts'
import { errorText } from './text.ts'
import type { Entry } from '../recording/outbox.ts'
import type { Update } from '../recording/content.ts'
import type { CleanupPlan } from '../recording/delivery.ts'
import type { JoinPlan, JoinRequest } from '../sharing/join.ts'
import type { ShareRequest } from '../sharing/share.ts'
import type { SyncReminder } from '../band/band.ts'
import { DeltaSendError, type ThreadMount, type ThreadUpload } from '../cli/thread-commands.ts'

/** The upload a repository's policy asks an automatic session for. */
export type AutoUpload = { mode: 'private' | 'organization'; organization: string }
export type Binding = {
  session: string
  thread?: string
  /** The pasted locator remains resolvable after restarting with an empty local Delta cache. */
  locator?: string
  /** A session working in mounted copies of a thread's worktrees, not a checkout attached by this session. */
  joined?: true
  /** A fresh session awaiting its verified mount and directory; recording stays disabled. */
  joinTransition?: JoinPlan
  /** Last confirmed location of a shared session's attached checkout, not proof that the thread still owns it. */
  checkout?: string
  checkoutReference?: string
  /** Local identity saved before membership, so a lost attach receipt cannot create another worktree. */
  pendingWorktree?: { directory: string; reference: string }
  /** A joined session's mount owner: the session's own ID. */
  owner?: string
  /** The directory a joined session works in: the checkout of a thread's only worktree, else the thread folder. */
  directory?: string
  /** Every worktree of a joined session's thread, as the last `thread mount` placed them. */
  mounts?: ThreadMount[]
  url?: string
  /** The audience Delta reports for the thread, shown apart from the link. */
  visibility?: 'private' | 'organization' | 'unlisted'
  /** Delta's background upload of this thread, as status last reported it. */
  upload?: ThreadUpload
  /**
   * Delta confirmed this automatic session's first background upload. Recorded so the first-upload
   * operation stays over even if a later per-turn sync reports `uploading` again.
   */
  uploaded?: true
  /**
   * Set on a session that Delta's background uploader syncs: one this extension created from the
   * repository's policy, or one shared with "Just me". Such a session may participate while its
   * thread is still local-only.
   */
  autoUpload?: AutoUpload
  /**
   * The organization a shared session's thread was created under: the repository's saved team, or for
   * "Just me" without one, the organization selected in Delta.
   */
  organization?: string
  /**
   * When the session really ended, from the clock. Absent while it may still be live, so a session
   * in another process is never pruned; pruned sessions can no longer resume into their thread.
   */
  endedAt?: number
  snapshot: boolean
  captureFailure?: string
  next: number
  pending: Entry[]
  execution?: Execution
  lastTurnSequence?: number
  /** The last session title recorded for the thread, so each change is recorded once. */
  title?: string
  /** This session is a subagent recorded as a child thread of the session that started it. */
  child?: ChildOf
}

/** Where a subagent session's thread hangs: its parent's thread, and who sends its prompts. */
export type ChildOf = {
  /** The parent thread's reference, which `thread create --parent` takes. */
  parent: string
  /** The external ID of the parent's producer, which its prompts are attributed to. */
  sender: string
  /** The child thread's own reference, from its creation receipt; later commands use it. */
  reference?: string
  name: string
  /** The extension that started the subagent named it, so its first prompt does not. */
  named?: true
  /** Whether the child works in its parent's checkout, so its thread shares the parent's worktrees. */
  sharesParentCheckout: boolean
  /** The directory the child's paths are shown relative to: the parent's checkout it works in, or its own. */
  root: string
}

const encoder = new TextEncoder()
/**
 * The session this runtime records: `session` is the one activation last made current, `epoch`
 * counts activations and the session's end so work begun under an earlier one can tell it is stale,
 * and `activating` names the session an activation is underway for.
 */
export const activation = { session: '', epoch: 0, activating: '' }

/**
 * A check that `session` is still the recorded session, under the activation current when the check
 * was made: it turns false once the session ends or is activated again.
 */
export function stillActive(session: string): () => boolean {
  const epoch = activation.epoch
  return () => activation.session === session && activation.epoch === epoch
}
let queue: Promise<unknown> = Promise.resolve()
/**
 * The join and the share running now, and a share asked for while the session's turn ran, with whom;
 * that one starts when the turn ends.
 */
export const requests: {
  join?: JoinRequest
  share?: ShareRequest
  shareAfterTurn?: Omit<ShareRequest, 'cwd' | 'cancelled'>
} = {}
/**
 * `watcher`: observation is not live; the next live watch connection lifts it.
 * `verification`: a checkout check failed; a passing check lifts it.
 * `delivery`: Delta refused a record or the thread; only explicit share/join recovery lifts it.
 */
type CheckoutPause = 'watcher' | 'verification' | 'delivery'
export type SessionState = {
  binding?: Binding
  captureFailure?: string
  /** Why checkout sharing is paused; each reason is lifted only by its own recovery. */
  pauses: Map<CheckoutPause, string | undefined>
  /** Delivery retry bookkeeping; see failDelivery. */
  retryAttempts: number
  retryTimer?: Timer
  deliveryNotice?: string
  /** Why sending is being retried, for the band while the retry waits. */
  retryReason?: string
  /** The next status read while Delta's background upload has not yet published the link; see followUpload. */
  uploadRefresh?: Timer
  uploadRefreshAttempts?: number
  unsaved: { updates: Update[]; turnSequence?: number }[]
  /** The turn sequence each tool call was made under, so its result keeps it after the turn ends. */
  toolTurns: Map<string, number | undefined>
  cleanupTask?: Promise<void>
  cleanupError?: string
  cleanupPlan?: CleanupPlan
  cleanedThrough?: number
  /** The local turn each staged start belongs to, while that turn may still be running here. */
  nativeTurns: Map<string, number>
  aborting: Set<string>
  /** Turns that lost the shared thread, so their late output keeps its turn instead of waiting. */
  lostTurns: Set<string>
  currentTurnId?: string
  /** A partial session transition must not silently become an unshared executing session. */
  joinFailure?: string
  /** A local prompt is entering, so remote rows wait until it is dropped or its turn starts. */
  promptEntering?: boolean
  /** A joined session's mounts were confirmed in this runtime, and pi works in their directory. */
  mounted?: true
  /** What the band reminds an interactive session Delta does not sync, decided when the session starts. */
  reminder?: SyncReminder
  /**
   * Mounts are being restored for a resumed session; prompts wait. Separate from `mounted`, not a phase
   * of it: a restore mounts first and keeps prompts waiting until the watch has started.
   */
  restoring?: true
  /** A saved checkout's mount is being restored while prompts proceed and record locally. */
  restoringCheckout?: true
  /** A join that switched into this session is finishing; the first prompt waits for it. */
  joining?: Promise<void>
  /** The latest handling of a `worktrees` event; the next one waits for it. */
  mountRefresh?: Promise<void>
  /** Context rows for the model that wait for a turn to end. */
  notes: string[]
  /**
   * Delta refused this offline session's recorded changes; the band offers Fork & Restore or
   * Discard, and prompts keep retrying delivery until the person resolves it or an append succeeds.
   */
  refusedOffline?: boolean
}
export const sessions = new Map<string, SessionState>()

export function stateFor(session: string): SessionState {
  let state = sessions.get(session)
  if (!state) {
    state = {
      notes: [],
      unsaved: [],
      pauses: new Map(),
      retryAttempts: 0,
      toolTurns: new Map(),
      nativeTurns: new Map(),
      aborting: new Set(),
      lostTurns: new Set(),
    }
    sessions.set(session, state)
  }
  return state
}

/** `notice` tells the person what to do, and is shown when a prompt is refused because of this pause. */
export function pauseCheckout(state: SessionState, reason: CheckoutPause, notice?: string) {
  state.pauses.set(reason, notice)
}

export function resumeCheckout(state: SessionState, reason: CheckoutPause) {
  state.pauses.delete(reason)
}

export function isPaused(state: SessionState) {
  return state.pauses.size > 0
}

export function pauseNotice(state: SessionState) {
  return (
    [...state.pauses.values()].find((notice) => notice !== undefined) ??
    `checkout sharing is paused; ${recoveryAdvice(state.binding)}`
  )
}

export function serial<T>(task: () => Promise<T>): Promise<T> {
  const running = queue.then(task, task)
  queue = running.catch(() => {})
  return running
}

export function key(session: string) {
  return `session:${session}`
}
export function ledgerKey(session: string) {
  return `appended:${session}`
}

export function recoveryCommand(binding?: Binding) {
  const locator =
    binding?.joinTransition?.locator ?? (binding?.joined ? (binding.locator ?? binding.thread) : undefined)
  return locator ? `/delta-join ${locator}` : '/delta-share'
}

/**
 * What to tell a person to do next when Delta is not ready. A session this extension created itself
 * recovers on its own, so its advice never names `/delta share`, which stays the explicit publish
 * action for a manual session.
 */
export function recoveryAdvice(binding?: Binding): string {
  if (binding?.child) return 'recording retries on the next prompt'
  return binding?.autoUpload ? 'automatic recording retries on your next prompt' : `run ${recoveryCommand(binding)}`
}

export async function save(host: Host, value: Binding, isCurrent = () => true) {
  await host.store.set(key(value.session), value)
  // A session already ended must not be recreated by a late write.
  const state = sessions.get(value.session)
  if (state && isCurrent()) state.binding = value
}

/**
 * The binding saved under `storeKey`, as this extension wrote it. Only this extension writes binding
 * keys, so the value is taken to have a binding's shape; `restoreBinding` checks the fields delivery needs.
 */
export async function storedBinding(host: Host, storeKey: string): Promise<Binding | undefined> {
  return (await host.store.get(storeKey)) as Binding | undefined
}

export async function load(host: Host, session: string): Promise<Binding> {
  const previous = await storedBinding(host, key(session))
  if (!previous || previous.session !== session) return { session, snapshot: false, next: 1, pending: [] }
  return restoreBinding(previous)
}

export async function digest(input: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(input))
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** The directory a binding's records are checked against, or undefined while setup is incomplete. */
export function boundDirectory(binding?: Binding): string | undefined {
  if (!binding?.thread) return
  return binding.joined ? binding.directory : binding.checkout
}

export function report(host: Host, error: unknown) {
  // A delivery failure was already shown, with its retry or pause, where it was classified.
  if (error instanceof DeltaSendError) return
  const text = `Delta sharing paused: ${errorText(error)}. ${recoveryAdvice(sessions.get(activation.session)?.binding)}.`
  host.ui.status(text)
  host.ui.note(text, 'error')
}

/**
 * A session that ended cancels the share it ran, a share it asked for after its turn, and its join,
 * which learns the session pi switched to, `target`, so it can tell its own switch from another.
 */
export function cancelRequestsOf(session: string, target?: string) {
  if (requests.share?.session === session) {
    requests.share.cancelled = true
    requests.share = undefined
  }
  if (requests.shareAfterTurn?.session === session) requests.shareAfterTurn = undefined
  if (requests.join?.session === session) {
    requests.join.cancelled = true
    requests.join.handedTo = target
    requests.join = undefined
  }
}

/** A session that ended is no longer recorded here, and an activation underway for it is stale. */
export function endActivationOf(session: string) {
  if (activation.activating === session) {
    activation.epoch++
    activation.activating = ''
  }
  if (activation.session === session) {
    activation.epoch++
    activation.session = ''
  }
}

/** Drop what an ended session held for its turns, mounts and timers; its binding and unsaved rows stay. */
export function resetRuntime(runtime: SessionState) {
  runtime.mounted = undefined
  runtime.restoring = undefined
  runtime.restoringCheckout = undefined
  runtime.notes = []
  runtime.nativeTurns.clear()
  runtime.toolTurns.clear()
  runtime.lostTurns.clear()
  runtime.retryTimer?.cancel()
  runtime.retryTimer = undefined
  runtime.uploadRefresh?.cancel()
  runtime.uploadRefresh = undefined
  runtime.uploadRefreshAttempts = 0
  runtime.currentTurnId = undefined
  runtime.promptEntering = false
  runtime.reminder = undefined
}

/**
 * Mark when a session stopped here, on every end, a switch included: only a marked binding can be
 * pruned, since an unmarked one may be live in another pi process.
 */
export async function markEnded(host: Host, session: string) {
  try {
    const stored = await storedBinding(host, key(session))
    if (stored?.session === session && stored.endedAt === undefined)
      await host.store.set(key(session), { ...stored, endedAt: host.clock.now() })
  } catch {
    /* a session that cannot record its end is simply never pruned */
  }
}
