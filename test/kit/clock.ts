/**
 * A clock tests move by hand: work scheduled for later runs only when `advance` reaches its time, so
 * retries, refreshes and budgets happen exactly when a test says. Work due now runs at once, as it would.
 */
import type { Clock, Timer } from '../../src/core/clock.ts'

type Scheduled = { at: number; order: number; run: () => unknown; cancelled: boolean }

export class MockClock implements Clock {
  private time = Date.UTC(2026, 0, 1)
  private order = 0
  private scheduled: Scheduled[] = []
  /** What scheduled work threw, as the system clock would swallow it, for a test to check. */
  readonly failures: unknown[] = []

  now(): number {
    return this.time
  }

  after(milliseconds: number, run: () => unknown): Timer {
    const entry: Scheduled = { at: this.time + Math.max(0, milliseconds), order: this.order++, run, cancelled: false }
    this.scheduled.push(entry)
    if (entry.at <= this.time) setImmediate(() => void this.runDue())
    return { cancel: () => (entry.cancelled = true) }
  }

  /** Run the work due by now, in order, without moving time. */
  private runDue() {
    for (;;) {
      const due = this.next(this.time)
      if (!due) return
      this.start(due)
    }
  }

  private next(by: number): Scheduled | undefined {
    this.scheduled = this.scheduled.filter((entry) => !entry.cancelled)
    const due = this.scheduled.filter((entry) => entry.at <= by).sort((a, b) => a.at - b.at || a.order - b.order)[0]
    if (due) this.scheduled = this.scheduled.filter((entry) => entry !== due)
    return due
  }

  /** As the system clock does: the work starts, and the clock does not wait for it, since it may itself wait on the clock. */
  private start(due: Scheduled) {
    void Promise.resolve()
      .then(due.run)
      .catch((error: unknown) => this.failures.push(error))
  }

  sleep(milliseconds: number, options: { signal?: AbortSignal } = {}): Promise<void> {
    const { signal } = options
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('sleep cancelled'))
      const timer = this.after(milliseconds, resolve)
      signal?.addEventListener(
        'abort',
        () => {
          timer.cancel()
          reject(new Error('sleep cancelled'))
        },
        { once: true },
      )
    })
  }

  /** How many timers are waiting. */
  get pending(): number {
    return this.scheduled.filter((entry) => !entry.cancelled).length
  }

  /**
   * Move time forward `milliseconds`, running each timer that falls due in order, and letting the work
   * each one starts run before the next falls due.
   */
  async advance(milliseconds: number, settle: () => Promise<void> = flush): Promise<void> {
    const target = this.time + milliseconds
    for (;;) {
      const due = this.next(target)
      if (!due) break
      this.time = Math.max(this.time, due.at)
      this.start(due)
      await settle()
    }
    this.time = target
    await settle()
  }
}

/** Let promise callbacks and I/O already under way run. */
export async function flush(): Promise<void> {
  for (let round = 0; round < 5; round++) await new Promise((resolve) => setImmediate(resolve))
}
