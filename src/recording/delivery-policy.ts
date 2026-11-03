import { classifyCommandFailure, type DeltaCommandError } from '../cli/thread-commands.ts'

export type FailureStreak = {
  deliveryNotice?: string
}

/** Decide retries and pauses without touching timers, UI, or queued records. */
export function deliveryFailure(state: FailureStreak, error: DeltaCommandError, verificationPaused: boolean) {
  const retry = classifyCommandFailure(error) !== 'permanent'
  const notice = `${retry}:${error.code}`
  return {
    retry,
    // A failed checkout check pauses verification; a failure the envelope will not retry pauses delivery.
    pause: verificationPaused ? ('verification' as const) : ('delivery' as const),
    show: state.deliveryNotice !== notice,
    state: { deliveryNotice: notice },
  }
}

/** Server hints lengthen exponential backoff, with a five-minute upper bound. */
export function deliveryRetryDelay(attempt: number, retryAfterMs = 0): number {
  const backoff = Math.min(30_000, 2000 * 2 ** Math.min(attempt, 4))
  return Math.min(Math.max(retryAfterMs, backoff), 300_000)
}
