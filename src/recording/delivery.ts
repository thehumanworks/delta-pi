/**
 * Recording a session into its thread: staging records in the outbox, delivering them in order with
 * retries, turn executions, checkout verification, capture failures, and refused offline changes.
 */
import { join } from 'node:path'
import { exists, list, readText, remove, size, writePrivate } from '../core/files.ts'
import type { Host } from '../core/host.ts'
import { isJsonObject } from '../core/json.ts'
import { isWithin } from '../core/paths.ts'
import {
  activation,
  type Binding,
  boundDirectory,
  digest,
  isPaused,
  load,
  pauseCheckout,
  recoveryAdvice,
  recoveryCommand,
  report,
  requests,
  resumeCheckout,
  save,
  serial,
  sessions,
  type SessionState,
  stateFor,
  stillActive,
} from '../core/session-state.ts'
import { errorText } from '../core/text.ts'
import {
  requireContract,
  threadAppend,
  threadDiscard,
  threadFork,
  threadStatus,
  verifiedContract,
} from '../cli/delta-cli.ts'
import {
  appendFailure,
  classifyCommandFailure,
  DeltaCommandError,
  DeltaSendError,
  JoinNotReadyError,
  permanentFailureAdvice,
  type ThreadTurn,
  validateJoinedMounts,
  validateThreadCheckout,
  validateThreadFrontier,
} from '../cli/thread-commands.ts'
import { activationIncomplete, captureDecided, outbox } from '../setup/activation.ts'
import { notifyOnce } from '../setup/interaction.ts'
import {
  childFields,
  childNeedsSetup,
  ensureChildThread,
  exportParent,
  followChildTurn,
  stopChildTurn,
} from '../subagents/subagents.ts'
import { beginShare } from '../sharing/share.ts'
import { liveFor, rememberStatus } from '../watch/watch.ts'
import { settleRemote } from '../watch/rows.ts'
import {
  absolutePath,
  messageUpdates,
  type PriorFile,
  recordedMessage,
  toolCallsOf,
  type Translation,
  type Update,
} from './content.ts'
import { deliveryFailure, deliveryRetryDelay } from './delivery-policy.ts'
import {
  acknowledgedOutboxFiles,
  acknowledgedPrefix,
  appendBatch,
  type Entry,
  outboxChunks,
  pendingRecordTurn,
} from './outbox.ts'
import type { AgentMessage } from '@earendil-works/pi-agent-core'

export type RecordBody = { update: Update; turnSequence?: number }
export type CleanupPlan = {
  session: string
  root: string
  next: number
  pending: { sequence: number; files: string[] }[]
}
const LIVE_ACTIVITY_ORIGIN = {
  work_origin: 'external_agent',
  interaction_surface: 'cli',
} as const
type LiveActivityKind = 'user_message' | 'agent_message' | 'agent_thought' | 'tool_call' | 'edit'
let drainTask: Promise<void> | undefined
/** A Fork & Restore or Discard the person started, so the two cannot both run at once. */
let resolving = false
/** The arguments of each recorded tool call and the file each write replaced, until its result is recorded. */
const toolInputs = new Map<string, unknown>()
const priorFiles = new Map<string, PriorFile>()
/** Builds a unified patch between two texts; `index.ts` supplies pi's own, which its edit tool uses. */
let unifiedPatch: Translation['patch']
/** A write replacing a file larger than this records which file it changed, without its patch. */
const PRIOR_FILE_LIMIT = 1024 * 1024

export function usePatchBuilder(patch: Translation['patch']) {
  unifiedPatch = patch
}

/**
 * Whether this session records offline, with `append --acknowledge local` answering without the
 * server. An automatic or shared session does once its CLI is verified: it writes to its own thread,
 * and Delta's background uploader pushes what it acknowledged locally. A joined session writes into
 * someone else's thread, so it keeps server-confirmed delivery and holds pi while Delta is
 * unreachable.
 */
export function recordsOffline(session: string, binding: Binding | undefined): boolean {
  return !!binding && !binding.joined && verifiedContract(session) !== undefined
}

/** Mark a row observed live in this pi process, without changing imported history. */
export function liveActivity(update: Update): Update {
  let activityKind: LiveActivityKind | undefined
  if (
    update.sessionUpdate === 'user_message' ||
    update.sessionUpdate === 'agent_message' ||
    update.sessionUpdate === 'agent_thought'
  )
    activityKind = update.sessionUpdate
  else if (update.sessionUpdate === 'tool_call_update') {
    const structuredEdit =
      Array.isArray(update.content) && update.content.some((item) => isJsonObject(item) && item.type === 'diff')
    activityKind = structuredEdit ? 'edit' : 'tool_call'
  }
  if (!activityKind) return update
  const metadata = isJsonObject(update._meta) ? update._meta : {}
  const delta = isJsonObject(metadata.delta) ? metadata.delta : {}
  return {
    ...update,
    _meta: { ...metadata, delta: { ...delta, ...LIVE_ACTIVITY_ORIGIN, activity_kind: activityKind } },
  }
}

export async function stageRecord(host: Host, binding: Binding, body: RecordBody): Promise<Binding> {
  return stageOutboxRecord(host, binding.session, binding, body)
}

/** Stage one record in the outbox folder `folder`, which holds one recorded conversation's records. */
export async function stageOutboxRecord<T extends { next: number; pending: Entry[] }>(
  host: Host,
  folder: string,
  binding: T,
  body: RecordBody,
): Promise<T> {
  const sequence = binding.next
  const line = JSON.stringify({ schemaVersion: 1, sequence, ...body }) + '\n'
  const files: string[] = []
  for (const chunk of outboxChunks(line, sequence)) {
    const path = join(outbox, folder, `${sequence}-${files.length}.json`)
    await writePrivate(path, chunk)
    files.push(path)
  }
  // Only reference fully written immutable files. An interrupted write leaves orphans.
  binding.pending.push({ sequence, files, digest: await digest(line) })
  binding.next = sequence + 1
  return binding
}

async function writeRecord(host: Host, binding: Binding, body: RecordBody): Promise<Binding> {
  const next = await stageRecord(host, binding, body)
  await save(host, next)
  return next
}

async function readRecord(entry: Entry): Promise<string> {
  const line = (await Promise.all(entry.files.map((path) => readText(path)))).join('')
  if ((await digest(line)) !== entry.digest)
    throw new Error(`outbox record ${entry.sequence} changed on disk; sharing paused`)
  return line
}

export async function collectAcknowledgedOutbox(plan: CleanupPlan) {
  const { session, root, next, pending } = plan
  if (!/^[A-Za-z0-9_-]+$/.test(session)) throw new Error('Invalid outbox session directory')
  const frontier = pending.reduce((value, entry) => Math.min(value, entry.sequence), next)
  if (frontier <= 1) return
  const directory = join(root, session)
  if (!(await exists(directory))) return
  // Only explicit files are removed; nothing follows a link or recurses.
  for (const file of acknowledgedOutboxFiles(directory, next, pending, await list(directory))) await remove(file)
}

/** Schedule from an acknowledged saved binding, never from mutable staging state. */
export function scheduleOutboxCleanup(host: Host, binding: Binding) {
  const runtime = sessions.get(binding.session)
  if (!runtime) return
  runtime.cleanupPlan = {
    session: binding.session,
    root: outbox,
    next: binding.next,
    pending: binding.pending.map((entry) => ({ sequence: entry.sequence, files: [...entry.files] })),
  }
  if (runtime.cleanupTask) return
  const task = cleanupOutbox(host, binding.session)
  runtime.cleanupTask = task
  void task
    .finally(() => {
      if (runtime.cleanupTask === task) runtime.cleanupTask = undefined
    })
    .catch((error: unknown) =>
      reportCleanupIssue(host, binding.session, `Delta outbox cleanup failed: ${errorText(error)}`),
    )
}

function reportCleanupIssue(host: Host, session: string, message: string) {
  const runtime = stateFor(session)
  const changed = runtime.cleanupError !== message
  runtime.cleanupError = message
  // Neither cleanup nor its reporting can be a prerequisite for delivery.
  host.ui.invalidate()
  if (changed) host.ui.note(message, 'warning')
}

async function cleanupOutbox(host: Host, session: string) {
  const runtime = stateFor(session)
  while (runtime.cleanupPlan) {
    const plan = runtime.cleanupPlan
    runtime.cleanupPlan = undefined
    const frontier = plan.pending.reduce((value, entry) => Math.min(value, entry.sequence), plan.next)
    if (frontier <= (runtime.cleanedThrough ?? 1)) continue
    try {
      await collectAcknowledgedOutbox(plan)
      runtime.cleanedThrough = frontier
      const hadError = runtime.cleanupError !== undefined
      runtime.cleanupError = undefined
      if (hadError) host.ui.invalidate()
    } catch (error) {
      reportCleanupIssue(
        host,
        session,
        `Delivered Delta records could not be removed from the local outbox: ${errorText(error)}. Delivery can continue; cleanup retries on later acknowledgments or session activation.`,
      )
      return
    }
  }
}

/**
 * Whether pi works in `directory`: its working directory is there or below it. Pi's tools resolve
 * relative paths against that directory, so a subdirectory is still the same checkout.
 */
export function isInDirectory(host: Host, directory: string) {
  return isWithin(host.session.cwd(), directory)
}

/** A joined session runs only with pi in its directory, so pi's tools reach every mounted worktree. */
function requireJoinedDirectory(host: Host, binding: Binding) {
  if (host.session.id() !== binding.session || !binding.directory || !isInDirectory(host, binding.directory))
    throw new JoinNotReadyError(
      `This joined session must run in ${binding.directory}. Run ${recoveryCommand(binding)} to open a session there; no other checkout will be attached`,
    )
}

/** Status observes the common owner's mounts; watcher lifetime is not checkout ownership. */
export async function verifyCheckout(host: Host, binding: Binding) {
  if (!boundDirectory(binding)) throw new Error('the checkout has not been attached; saved messages remain queued')
  if (binding.joined) requireJoinedDirectory(host, binding)
  const status = await threadStatus(host, binding.locator ?? binding.thread!, binding.session)
  validateThreadFrontier(status, binding)
  if (binding.joined) validateJoinedMounts(status, binding.mounts ?? [])
  else validateThreadCheckout(status, binding)
  const runtime = sessions.get(binding.session)
  if (runtime) {
    resumeCheckout(runtime, 'verification')
    runtime.joinFailure = undefined
  }
  await rememberStatus(host, binding.session, status)
  return status
}

/**
 * Resolves true only when every pending record was delivered; stopping early because of a pause or
 * session change is not success. Rejects with the refusal, and appends nothing, when the CLI's
 * recording contract is one this extension does not speak.
 */
async function drainPending(host: Host, session: string): Promise<boolean> {
  const delivering = () => activation.session === session && sessions.has(session) && !isPaused(sessions.get(session)!)
  while (delivering()) {
    let binding = await serial(async () => load(host, session))
    const current = stillActive(session)
    // A subagent's thread is created under its parent's with its first records, and its own checkout
    // is attached and mounted before they are sent; a step that failed is retried here.
    if (binding.pending.length && childNeedsSetup(binding)) {
      await requireContract(host, session)
      try {
        binding = await ensureChildThread(host, binding, () => delivering() && current())
      } catch (error) {
        // Preparing the thread of a session that ended stops there; that is not a failure to show.
        if (!delivering() || !current()) return false
        throw error
      }
      // The running turn is followed once its thread exists, whichever attempt finished setting it up.
      if (stateFor(session).currentTurnId !== undefined) followChildTurn(host, session)
    }
    if (!binding.thread || !binding.pending.length) return true
    // A recovered outbox checks the CLI's contract before its first append, so an incompatible CLI
    // records nothing. An answer that arrives after the session ended or was activated again belongs
    // to that earlier lifetime: it neither appends nor reports.
    try {
      await requireContract(host, session)
    } catch (error) {
      if (!delivering() || !current()) return false
      throw error
    }
    if (!delivering() || !current()) return false
    // A subagent's thread has no checkout of its own to verify; its parent's checkout is checked there.
    if (!binding.child) {
      try {
        await verifyCheckout(host, binding)
      } catch (error) {
        // An unanswered check says nothing about the checkout. A session that records offline still
        // delivers, acknowledged locally, and checks the checkout again once the server answers;
        // any other session waits, and drain decides how long to keep asking.
        const state = sessions.get(session)
        const permanent = classifyCommandFailure(error) === 'permanent'
        if (state && permanent) pauseCheckout(state, 'verification')
        if (permanent || !recordsOffline(session, binding)) throw error
      }
    }
    const { count, fenced, failure } = await appendPending(
      host,
      {
        reference: binding.child?.reference ?? binding.locator ?? binding.thread,
        thread: binding.thread,
        externalId: binding.session,
        local: recordsOffline(session, binding),
      },
      binding.pending,
    )
    if (count) {
      await serial(async () => {
        const current = await load(host, session)
        const acknowledged = { ...current, pending: current.pending.slice(count) }
        await save(host, acknowledged)
        scheduleOutboxCleanup(host, acknowledged)
      })
    }
    // A `fenced` receipt names the turn Delta already superseded. A fence for the running turn
    // stops it now, even if the watcher is lagging or disconnected; a fence for any other
    // sequence, including an earlier turn's late output, changes nothing. Delivery never waits
    // on the stop, so a slow or failed abort cannot hold up the outbox.
    const running = binding.execution?.sequence
    if (running !== undefined && fenced.includes(running))
      void loseExecution(host, session, running, 'Shared execution was superseded').catch((error: unknown) =>
        report(host, error),
      )
    if (failure) throw failure
  }
  return false
}

/**
 * Send the leading pending records to `target.reference` in one bounded append, as `externalId`.
 *
 * Returns how many leading records Delta acknowledged, the turns it fenced among them, and why the
 * rest were not acknowledged. Throws only when the append's outcome is unknown, so nothing counts as
 * acknowledged.
 */
export async function appendPending(
  host: Host,
  target: { reference: string; thread: string; externalId: string; local: boolean },
  pending: readonly Entry[],
): Promise<{ count: number; fenced: number[]; failure?: DeltaCommandError }> {
  // Keep stdout well below the 4 MiB capture limit.
  const batch: Entry[] = []
  const turnSequences: (number | undefined)[] = []
  let collected = { input: '', bytes: 0, count: 0 }
  for (const entry of pending) {
    const line = await readRecord(entry)
    const turnSequence = pendingRecordTurn(line, entry.sequence)
    const next = appendBatch(collected, line)
    if (!next) break
    collected = next
    batch.push(entry)
    turnSequences.push(turnSequence)
    if (collected.bytes >= 2_000_000) break
  }
  const result = await threadAppend(host, target, collected.input)
  const { count, fenced } = acknowledgedPrefix(
    result.stdout,
    target.thread,
    batch.map((entry, index) => ({ sequence: entry.sequence, turnSequence: turnSequences[index] })),
  )
  const failure =
    result.exitCode !== 0
      ? appendFailure(result.stdout, result.stderr, result.exitCode)
      : count !== batch.length
        ? new DeltaCommandError('invalid_acknowledgment', 'the append acknowledgment did not match the records sent')
        : undefined
  return { count, fenced, failure }
}

/** A turn's scoped running record, naming this extension's version. */
export function runningUpdate(host: Host): Update {
  const version = host.plugin.version
  const producerVersion =
    version.length <= 32 && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version) ? version : undefined
  return {
    sessionUpdate: 'state_update',
    state: 'running',
    ...(producerVersion ? { _meta: { delta: { producer_version: producerVersion } } } : {}),
  }
}

async function beginExecution(host: Host, session: string, turnId: string) {
  await serial(async () => {
    const running = runningUpdate(host)
    let binding = await load(host, session)
    // A delayed completion must not close this new turn. Finish only the stored
    // predecessor, then persist the new start and local identity in one manifest.
    if (binding.execution && !binding.execution.endSequence) {
      binding = await stageRecord(host, binding, {
        turnSequence: binding.execution.sequence,
        update: { sessionUpdate: 'state_update', state: 'idle' },
      })
    }
    const sequence = binding.next
    binding = await stageRecord(host, binding, { turnSequence: sequence, update: running })
    binding.execution = { sequence, turnId }
    binding.lastTurnSequence = sequence
    await save(host, binding)
    stateFor(session).nativeTurns.set(turnId, sequence)
  })
}

/**
 * How long a turn's end waits for its finish to reach the thread before going on in the background:
 * a normal append is delivered before pi goes idle, and a slower one keeps draining, retried by the
 * outbox on the next activation if pi exits first.
 */
const TURN_COMPLETE_DELIVERY_BUDGET_MS = 5_000

/**
 * Stage a turn's idle finish and clear its execution, then deliver it.
 *
 * The finish is durable before this returns. A turn's end bounds its delivery to
 * {@link TURN_COMPLETE_DELIVERY_BUDGET_MS}, then continues in the background, and the outbox
 * carries the finish on a later activation. Recovery and shutdown paths keep waiting, so their
 * pending records are delivered.
 */
async function endExecution(
  host: Host,
  session: string,
  sequence: number,
  isCurrent = () => true,
  delivery: 'await' | 'bounded' | 'background' = 'await',
  stopReason?: 'end_turn' | 'cancelled' | 'refusal' | 'error',
) {
  await serial(async () => {
    if (!isCurrent()) return
    let binding = await load(host, session)
    const execution = binding.execution
    if (!isCurrent() || !execution || execution.sequence !== sequence) return
    if (!execution.endSequence) {
      binding = await stageRecord(host, binding, {
        turnSequence: sequence,
        update: {
          sessionUpdate: 'state_update',
          state: 'idle',
          ...(stopReason ? { stopReason } : {}),
          ...(stopReason === 'error'
            ? { error: { code: -32603, message: 'External producer reported an error' } }
            : {}),
        },
      })
    }
    delete binding.execution
    await save(host, binding, isCurrent)
  })
  if (!isCurrent()) return
  if (delivery === 'await') await drain(host, session)
  else if (delivery === 'background') void drain(host, session).catch((error: unknown) => report(host, error))
  else await deliverWithin(host, session, TURN_COMPLETE_DELIVERY_BUDGET_MS)
}

/** Delivers within `budgetMs`, letting the outbox finish a slower append in the background. */
export async function deliverWithin(host: Host, session: string, budgetMs: number): Promise<void> {
  const cancelled = new AbortController()
  const delivery = drain(host, session).catch((error: unknown) => report(host, error))
  const expiry = host.clock.sleep(budgetMs, { signal: cancelled.signal }).catch(() => undefined)
  await Promise.race([delivery, expiry])
  cancelled.abort()
}

export async function loseExecution(
  host: Host,
  session: string,
  sequence: number,
  reason: string,
  isCurrent = () => true,
) {
  const runtime = stateFor(session)
  let turnId = runtime.binding?.execution?.sequence === sequence ? runtime.binding.execution.turnId : undefined
  try {
    await serial(async () => {
      if (!isCurrent()) return
      const binding = await load(host, session)
      if (!isCurrent() || binding.execution?.sequence !== sequence) {
        turnId = undefined
        return
      }
      turnId = binding.execution.turnId
      await save(host, { ...binding, execution: { ...binding.execution, lost: true } }, isCurrent)
    })
  } catch (error) {
    report(host, error)
  }
  if (!isCurrent()) return
  // Remember the loss so late output keeps this turn's sequence, which Delta fences.
  if (turnId) runtime.lostTurns.add(turnId)
  if (!turnId || runtime.nativeTurns.get(turnId) !== sequence) return endExecution(host, session, sequence, isCurrent)
  if (runtime.aborting.has(turnId)) return
  runtime.aborting.add(turnId)
  try {
    host.turn.abort()
    if (!isCurrent()) return
    host.ui.note(`${reason}; stopped pi's turn. Tool effects already performed are not rolled back.`, 'warning')
  } finally {
    try {
      await endExecution(host, session, sequence, isCurrent)
    } finally {
      // Hold the guard until the finish is durable, so a duplicate supersession or a fenced receipt
      // for the same turn that is already in flight cannot abort it a second time.
      runtime.aborting.delete(turnId)
    }
  }
}

export async function observeTurn(host: Host, session: string, turn: ThreadTurn, isCurrent = () => true) {
  const execution = stateFor(session).binding?.execution
  if (!isCurrent() || !execution || execution.sequence !== turn.sequence || execution.endSequence) return
  if (turn.status === 'superseded')
    await loseExecution(host, session, turn.sequence, 'Shared execution was superseded', isCurrent)
}

/**
 * Close a turn this session left open. Saved turn IDs are not authority to abort anything in a new
 * runtime: only a turn observed starting in this runtime can still be running here.
 */
export async function recoverExecution(host: Host, session: string) {
  const runtime = stateFor(session)
  const execution = (await serial(() => load(host, session))).execution
  if (!execution) return
  if (execution.turnId && runtime.nativeTurns.has(execution.turnId) && !execution.lost && !execution.endSequence) return
  if (execution.turnId && runtime.nativeTurns.get(execution.turnId) === execution.sequence) host.turn.abort()
  await endExecution(host, session, execution.sequence)
}

export async function drain(host: Host, session: string): Promise<void> {
  if (activation.session !== session || isPaused(stateFor(session))) return
  if (drainTask) {
    await drainTask
    if (activation.session !== session || isPaused(stateFor(session))) return
    if ((await serial(() => load(host, session))).pending.length) return drain(host, session)
    return
  }
  const task = drainPending(host, session).then(
    (delivered) => {
      const state = sessions.get(session)
      if (!delivered || activation.session !== session || !state) return
      endDeliveryFailures(state)
      // The session's thread exists now, so the subagents it starts can hang their threads under it.
      exportParent(host, state.binding)
      if (!state.captureFailure && !isPaused(state)) host.ui.status(undefined)
      // A delivery that succeeds again clears any pinned failure notice.
      host.ui.invalidate()
    },
    (error: unknown) => failDelivery(host, session, error),
  )
  drainTask = task
  try {
    await task
  } finally {
    if (drainTask === task) drainTask = undefined
  }
}

/**
 * Classify a failed drain, schedule its retry or pause sharing, and show the person why.
 * Failures that are not Delta command errors, such as a changed outbox file, pass through unchanged.
 * Queued records keep their sequence, so an unchanged retry is always safe.
 */
function failDelivery(host: Host, session: string, error: unknown): never {
  if (!(error instanceof DeltaCommandError)) throw error
  const state = sessions.get(session)
  // A session that ended or was replaced must not retry, pause, or speak in the active one's transcript.
  if (!state || activation.session !== session) throw new DeltaSendError(error.message, false)
  const decision = deliveryFailure(state, error, state.pauses.has('verification'))
  const { retry: willRetry } = decision
  Object.assign(state, decision.state)
  const failure = new DeltaSendError(error.message, willRetry)
  // The server refused this thread's recorded changes; an offline session keeps its records queued
  // and the band offers the person Fork & Restore or Discard instead of advice to repair a cause.
  const refused = error.code === 'reload_required' && recordsOffline(session, state.binding)
  if (refused) state.refusedOffline = true
  const pausedText = refused
    ? "Delta couldn't publish this thread's offline changes. Run /delta resolve to choose Fork & Restore or Discard."
    : `Delta sharing paused: ${failure.message}. The message stays queued. ${permanentFailureAdvice(error.code, !!state.binding?.autoUpload, error.reason)}, then ${recoveryAdvice(state.binding)}.`
  if (!willRetry) pauseCheckout(state, decision.pause, pausedText)
  else scheduleSendRetry(host, session, error.hints.retryAfterMs)
  state.retryReason = willRetry ? failure.message : undefined
  const text = willRetry ? `${failure.message}. The message stays queued and sending will be retried.` : pausedText
  // The band is the status surface: it shows the retry or the pause until delivery recovers.
  host.ui.invalidate()
  // A repeating failure is shown once however its message varies; the band stays current.
  if (decision.show) host.ui.note(text, willRetry ? 'warning' : 'error')
  throw failure
}

export function endDeliveryFailures(state: SessionState) {
  state.retryAttempts = 0
  state.deliveryNotice = undefined
  state.retryReason = undefined
  state.refusedOffline = false
  state.retryTimer?.cancel()
  state.retryTimer = undefined
}

/** The CLI's `retryAfterMs` can lengthen the exponential backoff but never shorten it, so a tiny hint cannot spin. */
function scheduleSendRetry(host: Host, session: string, retryAfterMs?: number) {
  const state = sessions.get(session)
  if (!state || activation.session !== session || state.retryTimer) return
  const delay = deliveryRetryDelay(state.retryAttempts++, retryAfterMs)
  // A timer rather than a sleep: the handler that hit the failure may finish long before the retry.
  state.retryTimer = host.clock.after(delay, () => {
    state.retryTimer = undefined
    if (activation.session === session) void drain(host, session).catch((error: unknown) => report(host, error))
  })
}

async function recordCaptureFailure(host: Host, session: string, error: unknown) {
  const state = stateFor(session)
  state.captureFailure = errorText(error)
  try {
    await serial(async () => save(host, { ...(await load(host, session)), captureFailure: state.captureFailure }))
  } catch {
    // An unavailable store cannot preserve its own failure across a restart.
  }
  const execution = state.binding?.execution
  if (execution) {
    try {
      await loseExecution(host, session, execution.sequence, 'Local conversation capture failed')
    } catch (failure) {
      report(host, failure)
    }
  }
  report(host, error)
}

async function persistUpdates(host: Host, session: string, updates: Update[], turnSequence?: number) {
  const unsaved = stateFor(session).unsaved
  try {
    await serial(async () => {
      if (unsaved.length) {
        unsaved.push({ updates, turnSequence })
        return
      }
      let state = await load(host, session)
      for (const [index, update] of updates.entries()) {
        try {
          state = await writeRecord(host, state, { update, turnSequence })
        } catch (error) {
          unsaved.push({ updates: updates.slice(index), turnSequence })
          throw error
        }
      }
    })
  } catch (error) {
    await recordCaptureFailure(host, session, error)
  }
}

export async function flushUnsaved(host: Host, session: string) {
  const runtime = stateFor(session)
  const unsaved = runtime.unsaved
  while (unsaved.length) {
    const first = unsaved[0]
    if (!first) break
    await serial(async () => {
      let state = await load(host, session)
      while (first.updates.length) {
        const update = first.updates[0]
        if (!update) break
        state = await writeRecord(host, state, { update, turnSequence: first.turnSequence })
        first.updates.shift()
      }
      unsaved.shift()
    })
  }
  if (runtime.captureFailure) {
    await serial(async () => {
      const state = await load(host, session)
      delete state.captureFailure
      await save(host, state)
    })
    runtime.captureFailure = undefined
  }
}

/**
 * Begin the person's choice for a refused offline thread. The command runs in the background, and
 * its result clears the refusal so the queued records can drain.
 */
export function beginRefusalResolution(host: Host, session: string, kind: 'fork' | 'discard'): boolean {
  if (resolving || !stateFor(session).refusedOffline) return false
  resolving = true
  host.clock.after(0, async () => {
    try {
      await resolveRefusal(host, session, kind)
    } catch (error) {
      reportRefusal(host, session, error)
    } finally {
      resolving = false
    }
  })
  return true
}

/**
 * Run the person's choice for the local changes Delta refused: **Fork & Restore** forks them into a
 * kept thread and then discards them from the original, while **Discard** discards them outright.
 * Either way the original is the server's view again when it finishes, a fork is named once, and the
 * queued records drain into the original.
 */
async function resolveRefusal(host: Host, session: string, kind: 'fork' | 'discard'): Promise<void> {
  const state = sessions.get(session)
  if (!state || activation.session !== session) return
  const thread = (await serial(() => load(host, session))).thread
  if (!thread) return
  // Fork first: it copies the refused changes into a kept thread, and the discard then resets the original.
  const forked = kind === 'fork' ? await threadFork(host, thread) : undefined
  await threadDiscard(host, thread)
  endDeliveryFailures(state)
  resumeCheckout(state, 'delivery')
  host.ui.invalidate()
  if (forked)
    notifyOnce(
      host,
      `Delta kept this thread's offline changes in the new thread "${forked.thread_id}"; this thread carries on without them.`,
    )
  host.ui.debug(
    kind === 'fork'
      ? "Delta forked this thread's offline changes into a kept thread."
      : "Delta discarded this thread's offline changes.",
  )
  void drain(host, session).catch((error: unknown) => report(host, error))
}

/** Show why the person's Fork & Restore or Discard did not resolve the refusal; the choice stays available. */
function reportRefusal(host: Host, session: string, error: unknown) {
  const state = sessions.get(session)
  if (!state || activation.session !== session) return
  host.ui.note(
    `Delta could not resolve this thread's offline changes: ${errorText(error)}. The records stay queued.`,
    'error',
  )
  host.ui.invalidate()
}

/**
 * The turn a row belongs to: the running turn's own staged start, the sequence a turn that lost the
 * thread keeps (which Delta fences), or, between turns, the latest start's.
 */
function contentTurn(runtime: SessionState): number | undefined {
  const execution = runtime.binding?.execution
  const running = runtime.currentTurnId
  if (running !== undefined) {
    if (execution?.turnId === running) return execution.sequence
    if (runtime.lostTurns.has(running)) return runtime.binding?.lastTurnSequence
    return undefined
  }
  return execution?.sequence ?? runtime.binding?.lastTurnSequence
}

let turnCount = 0

/**
 * Pi's run started: bind it as the current turn and open its execution, or lose the execution at
 * once when observation or capture is unavailable.
 */
export async function startTurn(host: Host) {
  const session = host.session.id()
  const runtime = stateFor(session)
  if (runtime.currentTurnId !== undefined) return
  const turnId = `turn-${host.clock.now().toString(36)}-${++turnCount}`
  runtime.currentTurnId = turnId
  runtime.promptEntering = false
  await captureDecided(session)
  if (!runtime.binding?.snapshot) return
  try {
    await beginExecution(host, session, turnId)
    // A session that records offline keeps its turn while the watcher is down, and a delivery pause
    // stops delivery rather than pi: observation and delivery are not required to record, and a
    // transient refusal queues rather than stopping the turn. A verification pause still stops it.
    const offline = recordsOffline(session, runtime.binding) || !!runtime.binding?.child
    const blockingPause = offline ? runtime.pauses.has('verification') : isPaused(runtime)
    const observationDown = !offline && !activationIncomplete(runtime) && !liveFor(session)
    if (blockingPause || runtime.captureFailure || observationDown)
      await loseExecution(
        host,
        session,
        runtime.nativeTurns.get(turnId)!,
        'Delta observation or capture is unavailable',
      )
    else {
      void drain(host, session).catch((error: unknown) => report(host, error))
      if (runtime.binding?.child) followChildTurn(host, session)
    }
  } catch (error) {
    // Never run output that cannot be tied to its turn: stop the turn whose start could not be saved.
    host.turn.abort()
    await recordCaptureFailure(host, session, error)
  }
}

/**
 * Pi settled: stage the turn's finish, then release the remote rows held while it ran and start a
 * share asked for during the turn.
 */
export async function completeTurn(host: Host, stopReason: 'end_turn' | 'cancelled' | 'error' | undefined) {
  const session = host.session.id()
  const runtime = stateFor(session)
  const turnId = runtime.currentTurnId
  runtime.currentTurnId = undefined
  runtime.promptEntering = false
  const sequence = turnId === undefined ? undefined : runtime.nativeTurns.get(turnId)
  if (turnId !== undefined) runtime.nativeTurns.delete(turnId)
  // Every call of the run has its result by now; what was kept for one that never reported is dropped.
  toolInputs.clear()
  priorFiles.clear()
  stopChildTurn()
  if (sequence !== undefined) {
    try {
      await endExecution(host, session, sequence, () => true, 'bounded', stopReason)
    } catch (error) {
      report(host, error)
    }
  }
  // Remote rows held back while this turn ran reach the model now, between turns.
  void settleRemote(host, session)?.catch((error: unknown) => report(host, error))
  if (requests.shareAfterTurn?.session === session) {
    const queued = requests.shareAfterTurn
    requests.shareAfterTurn = undefined
    beginShare(host, queued)
  }
}

/** Remember what a write call replaces, so its record carries the change as a patch. */
export async function rememberPriorFile(host: Host, toolCallId: string, input: unknown) {
  const path = isJsonObject(input) && typeof input.path === 'string' ? input.path : undefined
  if (!path) return
  const binding = stateFor(host.session.id()).binding
  if (!binding?.snapshot) return
  const absolute = absolutePath(path, host.session.cwd())
  try {
    if (!(await exists(absolute))) {
      priorFiles.set(toolCallId, { existed: false })
      return
    }
    priorFiles.set(
      toolCallId,
      (await size(absolute)) <= PRIOR_FILE_LIMIT
        ? { existed: true, text: await readText(absolute) }
        : { existed: true },
    )
  } catch {
    priorFiles.set(toolCallId, { existed: true })
  }
}

/** The translation context for a binding's records. */
export function translationFor(host: Host, binding: Binding | undefined): Translation {
  return {
    root: boundDirectory(binding) ?? childFields(binding)?.root,
    cwd: host.session.cwd(),
    inputs: toolInputs,
    priorFiles,
    patch: unifiedPatch,
  }
}

/** How many of the session's committed messages recording has looked at; later ones are new. */
let seenMessages = 0
/** The recording of committed messages in progress, so each call records after the one before it. */
let recording: Promise<void> = Promise.resolve()

/**
 * Leave what the session held when this runtime started to its earlier recording, or to the export a
 * share makes, and record only what pi commits from now on.
 */
export function recordFromNow(host: Host) {
  seenMessages = host.session.committed().length
}

/**
 * Record, in order, each message pi committed to the session since the last call. Pi commits a message
 * once every extension's `message_end` has run, so this records what the session keeps, as any
 * extension redacted or replaced it, and the shell commands the person ran, which have no `message_end`.
 */
export function recordCommitted(host: Host): Promise<void> {
  const step = recording.then(async () => {
    const committed = host.session.committed()
    const fresh = committed.slice(seenMessages)
    // A session pi no longer reports never rewinds what was seen.
    seenMessages = Math.max(seenMessages, committed.length)
    for (const { id, message } of fresh)
      try {
        // Entry IDs are unique only within their session.
        await recordMessage(host, message, `${host.session.id()}:${id}`)
      } catch (error) {
        host.ui.debug(`Recording a message failed: ${errorText(error)}`)
      }
  })
  recording = step.catch(() => {})
  return step
}

/**
 * How a settled run ended, for its finish record: only a reply that stopped normally is `end_turn`, and a
 * finish pi does not name, such as a reply cut at its length limit, is left unspecified.
 */
export function turnStopReason(
  aborted: boolean,
  lastStop: string | undefined,
): 'end_turn' | 'cancelled' | 'error' | undefined {
  if (aborted || lastStop === 'aborted') return 'cancelled'
  if (lastStop === 'error') return 'error'
  return lastStop === 'stop' ? 'end_turn' : undefined
}

/** A message pi finished is recorded under the turn it belongs to. */
export async function recordMessage(host: Host, message: AgentMessage, id: string) {
  const recorded = recordedMessage(message)
  if (!recorded) return
  const session = host.session.id()
  await captureDecided(session)
  const runtime = stateFor(session)
  if (!runtime.binding?.snapshot) return
  for (const [toolCallId, input] of toolCallsOf(recorded)) toolInputs.set(toolCallId, input)
  const updates = messageUpdates(recorded, id, translationFor(host, runtime.binding))
    .map(liveActivity)
    .map((update) => childFields(runtime.binding)?.attribute(update, recorded) ?? update)
  const turnSequence = contentTurn(runtime)
  for (const update of updates) {
    const tool =
      update.sessionUpdate === 'tool_call_update' && typeof update.toolCallId === 'string'
        ? update.toolCallId
        : undefined
    if (tool && !runtime.toolTurns.has(tool)) runtime.toolTurns.set(tool, turnSequence)
    await persistUpdates(host, session, [update], tool ? runtime.toolTurns.get(tool) : turnSequence)
  }
  if (recorded.role === 'toolResult') {
    toolInputs.delete(recorded.toolCallId)
    priorFiles.delete(recorded.toolCallId)
    runtime.toolTurns.delete(recorded.toolCallId)
  }
  if (!runtime.captureFailure && runtime.binding.thread)
    void drain(host, session).catch((error: unknown) => report(host, error))
}
