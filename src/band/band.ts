/**
 * The band above pi's editor: what it says about the watched thread, a running share, join or
 * installation update, an extension release, sync reminders, and its spinner.
 */
import type { Theme } from '@earendil-works/pi-coding-agent'
import {
  type Component,
  getCapabilities,
  hyperlink,
  styleTextWithAnsi,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui'
import type { Timer } from '../core/clock.ts'
import type { Host } from '../core/host.ts'
import { activation, type Binding, requests, sessions } from '../core/session-state.ts'
import type { UpdateStep } from '../cli/install-update.ts'
import {
  currentOrganizationId,
  isPersonalOrganizationId,
  loadOrganizationDirectory,
  organizationName,
} from '../setup/organizations.ts'
import { pluginUpdateNotice } from '../updates/updates.ts'
import { conversationWebLink, THOUGHT_KIND, toolCallParts } from '../watch/conversation.ts'
import { feed, presence, type RemoteTurn, watchedSession, watchStatus } from '../watch/watch.ts'
import { renderBand, SPINNER_FRAMES, type StatusSegment, statusSpinnerRunning, type StatusState } from './status.ts'

/** A share or join that the band is reporting: running, finished, or failed. */
type ProgressTone = 'active' | 'done' | 'error'
/** A share's or join's line in the band: what it says, how it went, and which of its steps it is on. */
export type Progress = { text: string; tone: ProgressTone; step?: [number, number] }

/**
 * What the band keeps of its own: the running share's or join's line, held through the operation and
 * briefly after success, and the band's timers. A watcher restart ends the timers but keeps the line.
 */
const bandState: {
  progress?: Progress
  /** The running installation update's latest step; a share's or join's line takes its place. */
  update?: UpdateStep
  /** Clears a finished operation's line; cancelled on teardown and by the next operation. */
  progressTimer?: Timer
  /** The animation's frame, live only while an operation or another participant's turn runs. */
  spinner?: { frame: number; timer?: Timer }
} = {}

/** The share or join line the band shows now, if any. */
export function reportedProgress(): Progress | undefined {
  return bandState.progress
}

/** A watcher restart ends the band's timers; a running share or join keeps its line, only its timer ends. */
export function stopBandTimers() {
  stopSpinner()
  bandState.progressTimer?.cancel()
  bandState.progressTimer = undefined
}
/** The band's animation: one braille cycle. */
const SPINNER_INTERVAL_MS = 120
/** How long a finished share or join stays in the band before clearing. */
const BAND_NOTICE_MS = 4_000
/** How long another participant's running turn may go without any activity before the band calls it quiet. */
const QUIET_AFTER_MS = 30_000
/** A remote thought or tool call shows as what its agent is doing once open this long, so a burst of quick calls does not flicker. */
const SHOW_ACTIVITY_AFTER_MS = 500

/** Drop a finished operation's notice so the band can show what happened next. */
export function clearDoneNotice() {
  if (bandState.progress?.tone !== 'done') return
  bandState.progressTimer?.cancel()
  bandState.progressTimer = undefined
  bandState.progress = undefined
}

/** Animate the band only while a live watch has a running turn, or an operation runs. */
export function syncSpinner(host: Host) {
  if (!spinnerRunning()) return stopSpinner()
  const spinner = bandState.spinner ?? { frame: 0 }
  bandState.spinner = spinner
  if (spinner.timer) return
  const tick = () => {
    if (bandState.spinner !== spinner) return
    spinner.timer = undefined
    spinner.frame = (spinner.frame + 1) % SPINNER_FRAMES.length
    host.ui.invalidate()
    if (spinnerRunning()) spinner.timer = host.clock.after(SPINNER_INTERVAL_MS, tick)
  }
  spinner.timer = host.clock.after(SPINNER_INTERVAL_MS, tick)
}

/** A running share or join animates wherever it runs; a turn animates only on a live watch. */
function spinnerRunning() {
  return statusSpinnerRunning({ ...feed, connection: watchStatus().actual, progress: currentProgress() })
}

function stopSpinner() {
  bandState.spinner?.timer?.cancel()
  bandState.spinner = undefined
}

/** Record what a share or join is doing and redraw; the band's animation follows it. */
export function setProgress(host: Host, text: string, tone: ProgressTone, step?: [number, number]) {
  bandState.progressTimer?.cancel()
  bandState.progressTimer = undefined
  bandState.progress = { text, tone, ...(step ? { step } : {}) }
  syncSpinner(host)
  host.ui.invalidate()
}

/** Finish an operation: a success clears after BAND_NOTICE_MS, a failure stays until replaced. */
export function finishProgress(host: Host, text: string, tone: 'done' | 'error') {
  setProgress(host, text, tone)
  if (tone !== 'done') return
  const timer = host.clock.after(BAND_NOTICE_MS, () => {
    if (bandState.progressTimer !== timer) return
    bandState.progressTimer = undefined
    bandState.progress = undefined
    syncSpinner(host)
    host.ui.invalidate()
  })
  bandState.progressTimer = timer
}

/** Show the installation update's latest step in place, or drop its line once it ends (undefined). */
export function showUpdateProgress(host: Host, step: UpdateStep | undefined) {
  bandState.update = step
  syncSpinner(host)
  host.ui.invalidate()
}

/** Drop an operation's band line, as a torn-down session does. */
export function clearProgress(host: Host) {
  bandState.progressTimer?.cancel()
  bandState.progressTimer = undefined
  bandState.progress = undefined
  syncSpinner(host)
  host.ui.invalidate()
}

/**
 * Whether the band has a Delta status to draw: a live watch, a share or join step, a failure, or the
 * reminder of a session Delta does not sync.
 */
function statusShown(): boolean {
  return !!watchedSession() || !!currentProgress() || !!watchStatus().error || !!activeReminder() || !!recording()
}

/** How the band reminds a session Delta does not sync, by the checkout's setting. */
export type SyncReminder = 'manual' | 'not set up'
const REMINDERS: Record<SyncReminder, { text: string; command: string }> = {
  manual: { text: 'Not syncing', command: '/delta-share' },
  'not set up': { text: 'Not set up', command: '/delta-setup' },
}

/**
 * The active session's reminder, while the band has nothing else to say. A running share or join,
 * a failure, or an unfinished join takes its place, and a syncing session's band says `Syncing`
 * instead, so the band always shows the current state.
 */
function activeReminder(): { text: string; command: string } | undefined {
  const runtime = sessions.get(activation.session)
  if (
    !runtime?.reminder ||
    currentProgress() ||
    watchStatus().error ||
    runtime.binding?.joinTransition ||
    runtime.binding?.snapshot
  )
    return
  return REMINDERS[runtime.reminder]
}

/** Whether the active session's conversation is captured for Delta, uploaded or still queued. */
function recording(): boolean {
  return !!sessions.get(watchedSession() ?? activation.session)?.binding?.snapshot
}

/**
 * What another participant's turn is doing: its newest thought or tool call open long enough to
 * show, how long that has been open, and how many of its other calls are.
 */
function remoteActivity(remote: RemoteTurn, now: number): NonNullable<StatusState['agent']>['doing'] {
  const shown = [...feed.openSince].flatMap(([id, since]) => {
    const item = feed.view?.items.get(id)
    const current = !remote.turnId || !item?.turn_id || item.turn_id === remote.turnId
    return item?.open &&
      current &&
      (item.kind === 'tool_call' || item.kind === THOUGHT_KIND) &&
      now - since >= SHOW_ACTIVITY_AFTER_MS
      ? [{ item, since }]
      : []
  })
  const newest = shown.reduce<(typeof shown)[number] | undefined>(
    (latest, entry) => (!latest || entry.since >= latest.since ? entry : latest),
    undefined,
  )
  if (!newest) return
  const tool = newest.item.kind === 'tool_call'
  return {
    text: tool ? toolCallParts(newest.item).name : 'thinking',
    tool,
    seconds: (now - newest.since) / 1000,
    more: shown.filter((entry) => entry !== newest && entry.item.kind === 'tool_call').length,
  }
}

/** Whether the band asked for the organization directory, which it reads once per runtime. */
let directoryRequested = false

/** What the band shows, at the moment it draws. */
function statusView(host: Host, animate = true): StatusState {
  const session = watchedSession()
  const state = session ? sessions.get(session) : sessions.get(activation.session)
  const watch = watchStatus()
  const remote = feed.turn.state === 'remote' ? feed.remoteTurn : undefined
  const now = host.clock.now()
  const since = remote?.since ?? now
  const silent = now - (remote?.heard ?? since)
  // A turn with an item still open, such as a long command, is working however long it is silent.
  const open = [...(feed.view?.items.values() ?? [])].some((item) => item.open)
  const doing = remote ? remoteActivity(remote, now) : undefined
  const binding = state?.binding
  // The visibility label names an organization; read the directory once, and redraw when it arrives.
  if (binding?.visibility && !directoryRequested) {
    directoryRequested = true
    void loadOrganizationDirectory(host).then(() => host.ui.invalidate())
  }
  const refused = state?.refusedOffline
  return {
    ...feed,
    recording: recording(),
    reminder: activeReminder(),
    // Within the grace after a drop, the band carries on as if the watch were live.
    connection: watch.connection,
    reconnecting: watch.reconnecting,
    ...(watch.error ? { error: watch.error } : {}),
    deliveryPause: refused ? undefined : (state?.pauses.get('delivery') ?? state?.pauses.get('verification')),
    retryReason: state?.retryTimer ? state.retryReason : undefined,
    progress: currentProgress(),
    spinner: animate ? bandState.spinner : undefined,
    link: statusLink(),
    audience: audienceLabel(binding),
    // A refused offline thread keeps its choice until the person forks the changes or discards them.
    conflict: refused ? { fork: 'Fork & Restore or Discard:', discard: '/delta resolve' } : undefined,
    // A personal organization has nobody to share with, so its threads offer no share control.
    share:
      binding?.visibility === 'private' &&
      !isPersonalOrganizationId(threadOrganization(binding) ?? currentOrganizationId ?? '')
        ? {
            label:
              requests.shareAfterTurn?.session === activation.session && state?.currentTurnId
                ? 'Sharing after this turn'
                : '/delta-share',
          }
        : undefined,
    people: presence.roster(),
    children: feed.children,
    childrenStale: watch.actual !== 'live',
    agent: remote
      ? {
          seconds: (now - since) / 1000,
          ...(!open && silent >= QUIET_AFTER_MS ? { quiet: silent / 1000 } : {}),
          ...(doing ? { doing } : {}),
        }
      : undefined,
  }
}

/**
 * Who can see the thread, apart from whether it has a link: `Synced with <org>` for a thread only
 * its owner sees (a private one, or any in a personal organization, which has no other members),
 * `Shared with <org>`, or `Unlisted`.
 */
function audienceLabel(binding: Binding | undefined): string | undefined {
  if (!binding?.visibility) return undefined
  if (binding.visibility === 'unlisted') return 'Unlisted'
  const organization = threadOrganization(binding) ?? currentOrganizationId
  const name = organizationName(organization) ?? 'your team'
  return binding.visibility === 'private' || isPersonalOrganizationId(organization ?? '')
    ? `Synced with ${name}`
    : `Shared with ${name}`
}

/**
 * The organization a session's thread uploads to. The organization the extension created the thread
 * under names it, since the CLI's status can report none even for a thread created with one.
 * Undefined for a thread shared without a saved team, or joined, which the caller names by the
 * current organization.
 */
export function threadOrganization(binding: Binding): string | undefined {
  return binding.autoUpload?.organization ?? binding.organization ?? binding.upload?.organization_id ?? undefined
}

/**
 * Delta's background upload of an automatic session, drawn on the band's row like a share's steps:
 * its first upload until Delta confirms it, then only a failure.
 */
function uploadProgress(binding: Binding | undefined): StatusState['progress'] {
  if (!binding?.autoUpload || !binding.thread) return undefined
  const upload = binding.upload
  if (upload?.state === 'failed')
    return { text: `Sync failed: ${upload.error?.message ?? upload.error?.reason ?? 'unknown reason'}`, tone: 'error' }
  if (binding.uploaded) return undefined
  // Delta reports a failure it retries itself as queued with its error, which is progress, not a failure.
  if (upload?.state === 'queued' && upload.error)
    return {
      text: `Retrying sync: ${upload.error.message || upload.error.reason || upload.error.code}`,
      tone: 'active',
    }
  return { text: upload?.state === 'queued' ? 'Waiting to sync…' : 'Syncing to DeltaDB…', tone: 'active' }
}

/** The operation the band draws: a share, join, or activation step, else an installation update, else an upload. */
function currentProgress(): StatusState['progress'] {
  const session = watchedSession()
  return (
    bandState.progress ??
    (bandState.update ? { text: 'Updating Delta', tone: 'active', update: bandState.update } : undefined) ??
    uploadProgress(session ? sessions.get(session)?.binding : undefined)
  )
}

/** The shared thread's link: the watched session's saved binding, which every status inspection keeps current. */
export function statusLink(): string | undefined {
  const session = watchedSession() ?? activation.session
  if (!session) return
  return conversationWebLink(sessions.get(session)?.binding?.url)
}

/** The terminal colors the band names, as SGR codes, so a person keeps one color everywhere. */
const ANSI: Record<string, string> = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  blueBright: '\x1b[94m',
  magentaBright: '\x1b[95m',
  cyanBright: '\x1b[96m',
}

/** A segment styled for the terminal. */
export function styled(segment: StatusSegment, theme: Theme): string {
  let text = segment.text
  if (segment.color === 'red') text = theme.fg('error', text)
  else if (segment.color === 'yellow') text = theme.fg('warning', text)
  else if (segment.color === 'green') text = theme.fg('success', text)
  else if (segment.color) text = styleTextWithAnsi(text, ANSI[segment.color], undefined, {})
  else if (segment.dim) text = theme.fg('dim', text)
  if (segment.bold) text = theme.bold(text)
  if (segment.inverse) text = theme.inverse(text)
  return text
}

function spans(segments: readonly StatusSegment[], theme: Theme): string {
  return segments.map((segment) => styled(segment, theme)).join('')
}

/** The band's lines for a terminal `width` columns wide: empty when Delta has nothing to say. */
export function bandLines(host: Host, theme: Theme, width: number): string[] {
  const update = pluginUpdateNotice()
  if (!statusShown() && !update) return []
  const lines: string[] = []
  if (statusShown()) {
    syncSpinner(host)
    const band = renderBand(statusView(host), { columns: width, terminal: true, rows: 4 })
    if (band.activity) lines.push(truncateToWidth(` ${spans(band.activity, theme)}`, width))
    if (band.childActivity) lines.push(truncateToWidth(` ${spans(band.childActivity, theme)}`, width))
    const { text, href, ownRow } = band.link ?? {}
    const link = text ? (href ? linkText(text, href, theme) : theme.fg('dim', text)) : ''
    const left = [
      `${styled(band.mark, theme)}${spans(band.label, theme)}`,
      link && !ownRow ? link : '',
      band.audience?.length ? spans(band.audience, theme) : '',
      band.share ? theme.fg('dim', band.share.label) : '',
      band.conflict ? theme.fg('warning', `${band.conflict.fork} ${band.conflict.discard}`) : '',
    ]
      .filter(Boolean)
      .join('  ')
    const right = spans(band.right, theme)
    const gap = width - 2 - visibleWidth(left) - visibleWidth(right)
    lines.push(
      right && gap >= 2
        ? ` ${left}${' '.repeat(gap)}${right} `
        : truncateToWidth(` ${left}${right ? `  ${right}` : ''}`, width),
    )
    if (link && ownRow) lines.push(truncateToWidth(`   ${link}`, width))
    if (band.detail) lines.push(truncateToWidth(`   ${spans(band.detail, theme)}`, width))
  }
  if (update) lines.push(truncateToWidth(` ${theme.fg('accent', '↑')} ${theme.fg('dim', update)}`, width))
  return lines
}

/** A link a terminal that supports it follows on a click. */
export function linkText(text: string, href: string, theme: Theme): string {
  const shown = theme.fg('accent', text)
  return getCapabilities().hyperlinks ? hyperlink(shown, href) : shown
}

/** The band as a pi widget: it draws the current state each time pi renders it. */
export class BandWidget implements Component {
  constructor(
    private readonly host: Host,
    private readonly theme: () => Theme,
  ) {}

  render(width: number): string[] {
    return bandLines(this.host, this.theme(), width)
  }

  invalidate() {}
}

/** The band as one plain line, for a client that shows a status line but no widgets, which it does not animate. */
export function bandText(host: Host): string | undefined {
  if (!statusShown()) return pluginUpdateNotice()
  const band = renderBand(statusView(host, false), { columns: 200, terminal: true, rows: 1 })
  const plain = (segments: readonly StatusSegment[] | undefined) =>
    (segments ?? []).map((segment) => segment.text).join('')
  return [
    plain([band.mark, ...band.label]),
    band.link?.text,
    plain(band.audience),
    band.share?.label,
    band.conflict ? `${band.conflict.fork} ${band.conflict.discard}` : undefined,
    plain(band.right),
    plain(band.detail),
  ]
    .filter(Boolean)
    .join('  ')
}
