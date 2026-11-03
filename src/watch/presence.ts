import { conversationText } from './conversation.ts'
import { type Person, personKey } from '../band/status.ts'
import type { ThreadUser } from '../cli/thread-commands.ts'

type Timer = { cancel(): void }
type After = (milliseconds: number, action: () => void) => Timer
type Waiting = { timer: Timer; name: string }

/** How long a peer's connection must hold before it counts as an arrival. */
const ARRIVAL_SETTLE_MS = 3000
/** How long a peer may be gone before their departure counts. */
const DEPARTURE_GRACE_MS = 5000
/** How long the latest arrival stays highlighted. */
const ARRIVAL_HIGHLIGHT_MS = 4000

/** Debounce peer arrivals and departures without depending on a hook or global clock. */
export class PresenceTracker {
  private current?: Map<string, string>
  private announced?: Map<string, string>
  private arrivals = new Map<string, Waiting>()
  private departures = new Map<string, Waiting>()
  private arriving?: { user: string; timer: Timer }

  /**
   * Everyone settled in the thread, in arrival order: an arrival only after its debounce, and a
   * departure still listed, `leaving`, through its grace. The latest arrival is `arriving` while
   * its highlight lasts. Presence lists people, not clients, so this person is listed too while
   * another client of theirs is connected.
   */
  roster(): Person[] {
    return [...(this.announced ?? [])].map(([id, name]) => ({
      id,
      name,
      ...(this.arriving?.user === id ? { arriving: true } : {}),
      ...(this.departures.has(id) ? { leaving: true } : {}),
    }))
  }

  reset() {
    this.current = undefined
    this.announced = undefined
    for (const { timer } of this.arrivals.values()) timer.cancel()
    this.arrivals.clear()
    for (const { timer } of this.departures.values()) timer.cancel()
    this.departures.clear()
    this.arriving?.timer.cancel()
    this.arriving = undefined
  }

  update(users: readonly ThreadUser[], after: After, changed: () => void) {
    this.current = new Map(
      users.map((user) => [personKey(user), conversationText(user.name ?? '').trim() || 'Someone']),
    )
    // The first report after reconnect establishes a baseline, not arrivals.
    if (!this.announced) {
      this.announced = new Map(this.current)
      return
    }
    for (const [user, name] of this.current) {
      this.departures.get(user)?.timer.cancel()
      this.departures.delete(user)
      if (this.announced.has(user)) {
        this.arrivals.get(user)?.timer.cancel()
        this.arrivals.delete(user)
      } else if (!this.arrivals.has(user)) {
        const timer = after(ARRIVAL_SETTLE_MS, () => {
          if (this.arrivals.get(user)?.timer !== timer) return
          this.arrivals.delete(user)
          if (!this.current?.has(user)) return
          this.announced?.set(user, name)
          this.highlight(user, after, changed)
        })
        this.arrivals.set(user, { timer, name })
      }
    }
    for (const [user, entry] of this.arrivals)
      if (!this.current.has(user)) {
        entry.timer.cancel()
        this.arrivals.delete(user)
      }
    for (const [user, name] of this.announced)
      if (!this.current.has(user) && !this.departures.has(user)) {
        const timer = after(DEPARTURE_GRACE_MS, () => {
          if (this.departures.get(user)?.timer !== timer) return
          this.departures.delete(user)
          if (!this.current || this.current.has(user)) return
          this.announced?.delete(user)
          changed()
        })
        this.departures.set(user, { timer, name })
      }
  }

  private highlight(user: string, after: After, changed: () => void) {
    this.arriving?.timer.cancel()
    const timer = after(ARRIVAL_HIGHLIGHT_MS, () => {
      if (this.arriving?.timer !== timer) return
      this.arriving = undefined
      changed()
    })
    this.arriving = { user, timer }
    changed()
  }
}
