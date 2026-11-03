/** Admitting a prompt into a recorded session: what must be ready before the turn it starts is recorded. */
import type { Host } from '../core/host.ts'
import {
  activation,
  isPaused,
  pauseCheckout,
  pauseNotice,
  recoveryAdvice,
  requests,
  resumeCheckout,
  stateFor,
} from '../core/session-state.ts'
import { errorText } from '../core/text.ts'
import { classifyCommandFailure, JoinNotReadyError } from '../cli/thread-commands.ts'
import { activate, activationIncomplete, captureDecided, retryAutomaticActivation } from '../setup/activation.ts'
import { beginRestoreCheckout, checkoutNeedsMount } from '../sharing/checkout.ts'
import { ownsSteering, promptGate } from '../sharing/lifecycle.ts'
import { settleRemote, settling } from '../watch/rows.ts'
import { liveFor, startConversation } from '../watch/watch.ts'
import { recordsOffline, verifyCheckout } from './delivery.ts'
import { nameChild } from '../subagents/subagents.ts'

/**
 * Admit a prompt into a recorded session, or say why it is dropped: a running join or share refuses
 * it, and a recorded session's watcher, checkout and capture must be ready before the turn it starts
 * is recorded. `steering` is set for a prompt sent into a running turn.
 */
export async function admitPrompt(host: Host, text: string, steering: boolean): Promise<string | undefined> {
  const operation = promptGate({ joining: !!requests.join, sharing: !!requests.share })
  if (operation === 'joining')
    return 'Delta is joining a shared thread. Wait for the join result before submitting a prompt.'
  if (operation === 'sharing')
    return 'Delta is sharing this session. Wait for the share result before submitting a prompt.'
  const session = host.session.id()
  const runtime = stateFor(session)
  if (runtime.joinFailure) return `${runtime.joinFailure} The prompt was not submitted.`
  // A new session's prompt waits for its capture boundary, so a prompt sent right at startup is
  // recorded rather than lost before the session's recording is decided, and a joined session's
  // first prompt waits for the join to finish.
  await captureDecided(session)
  await runtime.joining
  if (runtime.joinFailure) return `${runtime.joinFailure} The prompt was not submitted.`
  // A reload can install this handler before the session's start ran.
  if (activation.session !== session || !runtime.binding) {
    try {
      await activate(host, session)
    } catch (error) {
      return `Delta conversation initialization failed: ${errorText(error)}. The prompt was not submitted.`
    }
  }
  const transition = runtime.binding?.joinTransition
  const blocked = promptGate({
    transition: !!transition,
    snapshot: !!runtime.binding?.snapshot,
    restoring: !!runtime.restoring,
  })
  if (blocked === 'transition' && transition)
    return `The Delta join is incomplete. Run /delta-join ${transition.locator} to retry; the prompt was not submitted.`
  if (blocked === 'restoring')
    return "Delta is restoring this thread's worktrees. Wait for the band to say they are restored, then try again. The prompt was not submitted."
  if (!runtime.binding?.snapshot) return
  // A subagent records offline into its own thread, named for its first prompt, and has no checkout
  // of its own to check.
  if (runtime.binding.child) {
    if (!steering) await nameChild(host, session, text)
    return
  }
  // A session that records offline does not wait for the watcher and never drops a prompt for a
  // delivery pause: the pause stops delivery, and this prompt retries delivery and any incomplete
  // automatic activation once. A poison record simply stays queued, its notice shown once.
  const offline = recordsOffline(session, runtime.binding)
  // An unfinished automatic activation records locally and retries from here, whether or not the
  // CLI has answered its contract yet; there is no thread to watch or verify until it completes.
  const incomplete = activationIncomplete(runtime)
  if (offline || incomplete) {
    if (runtime.pauses.has('delivery')) resumeCheckout(runtime, 'delivery')
    retryAutomaticActivation(host, session, runtime)
    // A checkout whose mount failed to come back, or ended, is restored again in the background.
    if (offline && !incomplete && checkoutNeedsMount(session, runtime.binding)) beginRestoreCheckout(host, session)
  } else if (runtime.pauses.has('delivery')) {
    // Watching again cannot lift a refusal, so do not restart the watcher for one.
    return `${runtime.pauses.get('delivery') ?? pauseNotice(runtime)} The prompt was not submitted.`
  }
  // A session that does not record offline still recovers the watcher here and refuses if it cannot.
  if (!offline && !incomplete && (!runtime.binding.thread || isPaused(runtime) || !liveFor(session))) {
    try {
      await startConversation(host, session)
    } catch (error) {
      return `The Delta watcher is not ready: ${errorText(error)}. ${recoveryAdvice(runtime.binding)}.`
    }
  }
  if (steering) {
    if (!ownsSteering(runtime.binding.execution, runtime.currentTurnId))
      return 'This pi turn no longer owns the shared conversation.'
    return
  }
  try {
    if (runtime.captureFailure || runtime.binding.captureFailure)
      throw new Error(`local conversation capture is paused; ${recoveryAdvice(runtime.binding)} before continuing`)
    // A prompt that arrives mid-activation records locally while create, upload, and attach finish,
    // and one that arrives while the checkout's mount is restored records locally until it is.
    if (!activationIncomplete(runtime) && !runtime.restoringCheckout) {
      await verifyCheckout(host, runtime.binding)
      if (isPaused(runtime)) throw new Error(pauseNotice(runtime))
    }
  } catch (error) {
    // Offline, an unanswered checkout check says nothing about the checkout: the records stay
    // queued and retry, so the prompt proceeds rather than being dropped. A non-retryable refusal
    // or a local persistence failure still stops it.
    if (!(offline && classifyCommandFailure(error) === 'transient' && !isPaused(runtime))) {
      // The band names a worktree or directory that is not ready, until a prompt finds it ready.
      if (error instanceof JoinNotReadyError) pauseCheckout(runtime, 'verification', error.message)
      return `Delta is not ready for this prompt: ${errorText(error)}. The prompt was not submitted.`
    }
  }
  // Remote activity that already completed precedes the prompt; later rows wait for its turn.
  await settleRemote(host, session)
  runtime.promptEntering = true
  // A prompt pi then fails to start, as without a model, must not hold remote rows back for good.
  host.clock.after(PROMPT_START_GRACE_MS, () => {
    if (!runtime.promptEntering || runtime.currentTurnId !== undefined) return
    runtime.promptEntering = false
    void settleRemote(host, session)
  })
  await settling
}

/** How long remote rows wait for an admitted prompt's turn to start before they stop waiting. */
const PROMPT_START_GRACE_MS = 30_000
