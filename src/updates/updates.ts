/**
 * Checking for a newer release of this extension, and updating it on request. Pi owns installation:
 * an update runs `pi update <source>` for the package source pi installed the extension from, then
 * reloads. Only npm sources are checked; local copies and git checkouts are left alone.
 */
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { readText } from '../core/files.ts'
import { activation, requests, sessions } from '../core/session-state.ts'
import type { Host } from '../core/host.ts'
import { isJsonObject, isNonEmptyString, isOneOf } from '../core/json.ts'
import { samePath } from '../core/paths.ts'
import { errorText } from '../core/text.ts'
import { claimInstallation, installation } from '../core/installation.ts'
import type { Timer } from '../core/clock.ts'
import { MINIMUM_PI_VERSION } from '../core/compatibility.ts'

const NOTIFICATIONS = 'plugin-update:notifications'
const CHECK = 'plugin-update:check'
const REMINDER = 'plugin-update:reminder'
/** One check an hour is shared by every pi process on the machine. */
export const CHECK_INTERVAL_MS = 60 * 60 * 1000
const CHECK_TIMEOUT_MS = 10_000
export const REMINDER_INTERVAL_MS = 24 * CHECK_INTERVAL_MS
const SCOPES = ['user', 'project'] as const
const USAGE =
  'Usage: /delta-plugin-update [check | later | notifications on | notifications off]. Updates this pi extension and reloads it. /delta-update updates the Delta app and CLI instead.'

/** Where pi installed the extension from: an npm package source, by name, for the user or a project. */
type Source = { source: string; name: string; scope: (typeof SCOPES)[number] }
/**
 * The hourly check every session shares: the source pi installed the copy running from `root` from,
 * as `pi list` in `cwd` lists it, the newest release that source follows, and the version on disk.
 * Without a source, that copy is not one this updater follows.
 */
export type Check = {
  checkedAt: number
  root: string
  cwd: string
  source?: Source
  latest?: string
  installed?: string
}

/** The newer release the band offers, once a check found one: on npm, or `ready`, installed and waiting for a reload. */
let available: { version: string; ready: boolean } | undefined
let observer: { timer?: { cancel(): void } } | undefined
/** Session shutdown also invalidates a command that is still installing. */
let generation = 0

/** `x.y.z`; anything else is not compared. */
function versionParts(version: string): number[] | undefined {
  const parts = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version)?.slice(1).map(Number)
  return parts?.every(Number.isSafeInteger) ? parts : undefined
}

/** Undefined for an unknown version, rather than guessing an order or recommending a downgrade. */
export function compareVersions(left: string, right: string): number | undefined {
  const a = versionParts(left)
  const b = versionParts(right)
  if (!a || !b) return
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index]! > b[index]! ? 1 : -1
  return 0
}

/**
 * The npm source in `pi list`'s output whose installed path is `root`, and whether the user or the
 * project installed it. pi lists each package's source, then the path it installed it at.
 */
export function sourceAt(listing: string, root: string): Source | undefined {
  const lines = stripVTControlCharacters(listing).split(/\r?\n/)
  let scope: Source['scope'] | undefined
  for (let index = 0; index < lines.length - 1; index++) {
    const line = lines[index]!.trim()
    if (line === 'User packages:') scope = 'user'
    if (line === 'Project packages:') scope = 'project'
    const parsed = npmSource(line.replace(/ \(filtered\)$/, ''))
    if (scope && parsed && samePath(lines[index + 1]!.trim(), root)) return { ...parsed, scope }
  }
}

function npmSource(source: string): Omit<Source, 'scope'> | undefined {
  const name = /^npm:((?:@[^/\s]+\/)?[^@\s]+)(?:@.+)?$/.exec(source)?.[1]
  if (name) return { source, name }
}

/** The band's notice of a newer release, while notifications are on and nothing installs. */
export function pluginUpdateNotice(): string | undefined {
  if (!available || installation()) return
  return available.ready
    ? `Delta extension ${available.version} is installed · /delta-plugin-update to reload`
    : `Delta extension ${available.version} is available · /delta-plugin-update`
}

/** Pi lists and installs packages with its own command; without it on PATH, say how to get it there. */
async function runPi(host: Host, args: string[], init: { cwd: string; timeoutMs: number }) {
  const advice = `Delta updates this extension with pi's own command: make pi available on PATH (pi ${MINIMUM_PI_VERSION} or newer), then retry /delta-plugin-update.`
  try {
    const result = await host.process.run(['pi', ...args], init)
    if (result.exitCode === 127) throw new Error(`The pi command was not found. ${advice}`)
    return result
  } catch (error) {
    if (/ENOENT|no such file|executable.*not found|command not found/i.test(errorText(error)))
      throw new Error(`Could not run the pi command. ${advice}`, { cause: error })
    throw error
  }
}

async function installedSource(host: Host, cwd: string): Promise<Source | undefined> {
  const listed = await runPi(host, ['list'], { cwd, timeoutMs: CHECK_TIMEOUT_MS })
  if (listed.exitCode !== 0 || listed.isStdoutTruncated || listed.isStderrTruncated)
    throw new Error(listed.stderr.trim() || 'pi could not list its packages')
  const source = sourceAt(listed.stdout, host.plugin.root)
  // Another package pi put where this copy runs from is not this extension's release channel.
  return source?.name === host.plugin.name ? source : undefined
}

/** Pi leaves exact npm versions fixed, including prerelease and build-qualified pins. */
function pinned(source: Source): boolean {
  const spec = source.source.slice(`npm:${source.name}@`.length).trim()
  return /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/.test(spec)
}

/** The current disk version is separate from the manifest this runtime loaded. */
async function installedVersion(host: Host, source: Source): Promise<string> {
  const manifest: unknown = JSON.parse(await readText(join(host.plugin.root, 'package.json')))
  if (
    !isJsonObject(manifest) ||
    manifest.name !== source.name ||
    typeof manifest.version !== 'string' ||
    !versionParts(manifest.version)
  )
    throw new Error('the installed Delta extension has no supported version')
  return manifest.version
}

async function latestVersion(host: Host, source: Source, cwd: string): Promise<string> {
  // npm resolves tags and ranges just as pi's updater does, without adding a semver dependency.
  if (source.source !== `npm:${source.name}`) {
    const result = await host.process.run(['npm', 'view', source.source.slice(4), 'version', '--json'], {
      cwd,
      timeoutMs: CHECK_TIMEOUT_MS,
    })
    if (result.exitCode !== 0 || result.isStdoutTruncated || result.isStderrTruncated)
      throw new Error(result.stderr.trim() || 'npm could not check the configured version')
    const value: unknown = JSON.parse(result.stdout)
    const versions: unknown[] = Array.isArray(value) ? value : [value]
    let latest: string | undefined
    for (const version of versions) {
      if (typeof version !== 'string' || !versionParts(version)) throw new Error('npm sent no supported version')
      if (!latest || compareVersions(version, latest) === 1) latest = version
    }
    if (!latest) throw new Error('npm sent no supported version')
    return latest
  }
  // The deadline is the session's clock, so a check that outlives it neither installs nor notifies.
  const request = new AbortController()
  let timer: Timer | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = host.clock.after(CHECK_TIMEOUT_MS, () => {
      request.abort()
      reject(new Error('the npm registry did not answer: the extension update check timed out'))
    })
  })
  let manifest: unknown
  try {
    const response = await Promise.race([
      fetch(`https://registry.npmjs.org/${source.name.replace('/', '%2F')}/latest`, { signal: request.signal }),
      deadline,
    ])
    if (!response.ok) throw new Error(`the npm registry answered ${response.status}`)
    manifest = await Promise.race([response.json(), deadline])
  } finally {
    timer?.cancel()
  }
  if (
    !isJsonObject(manifest) ||
    manifest.name !== source.name ||
    typeof manifest.version !== 'string' ||
    !versionParts(manifest.version)
  )
    throw new Error('the npm registry sent no supported version')
  return manifest.version
}

/** Validate shared state before letting it suppress discovery or supply a release. */
export function checkFrom(value: unknown): Check | undefined {
  const version = (field: unknown) => field === undefined || (typeof field === 'string' && !!versionParts(field))
  if (
    !isJsonObject(value) ||
    typeof value.checkedAt !== 'number' ||
    !Number.isFinite(value.checkedAt) ||
    value.checkedAt < 0 ||
    !isNonEmptyString(value.root) ||
    typeof value.cwd !== 'string' ||
    !version(value.latest) ||
    !version(value.installed)
  )
    return
  const check: Check = {
    checkedAt: value.checkedAt,
    root: value.root,
    cwd: value.cwd,
    ...(typeof value.latest === 'string' ? { latest: value.latest } : {}),
    ...(typeof value.installed === 'string' ? { installed: value.installed } : {}),
  }
  const source = value.source
  if (source === undefined) return check
  if (!isJsonObject(source) || typeof source.source !== 'string' || !isOneOf(source.scope, SCOPES)) return
  const parsed = npmSource(source.source)
  if (!parsed || parsed.name !== source.name) return
  return { ...check, source: { ...parsed, scope: source.scope } }
}

/**
 * Another session's check holds for the same running copy and, unless the user installed that copy
 * for every project, the same project.
 */
export function answersFor(check: Check, root: string, cwd: string): boolean {
  return samePath(check.root, root) && (check.source?.scope === 'user' || samePath(check.cwd, cwd))
}

/** A future timestamp is not a permanent throttle after the machine's clock moves backwards. */
export function recentlyChecked(checkedAt: number, now: number): boolean {
  return now >= checkedAt && now - checkedAt < CHECK_INTERVAL_MS
}

/**
 * Attempts, including failures, wait an hour; a failure retains the last known release. A session
 * reuses another's check when {@link answersFor} says it holds, and runs neither pi nor a request.
 */
async function check(host: Host, force = false, cwd = host.session.cwd()): Promise<Check> {
  const now = host.clock.now()
  const root = host.plugin.root
  const saved = checkFrom(await host.store.get(CHECK))
  const previous = saved && answersFor(saved, root, cwd) ? saved : undefined
  if (!force && previous && recentlyChecked(previous.checkedAt, now)) return previous
  await host.store.set(CHECK, { ...previous, checkedAt: now, root, cwd } satisfies Check)
  const source = await installedSource(host, cwd)
  const installed = source && !pinned(source) ? await installedVersion(host, source) : undefined
  const latest =
    !source || pinned(source)
      ? undefined
      : installed && compareVersions(installed, host.plugin.version) === 1
        ? installed
        : await latestVersion(host, source, cwd)
  const found = { checkedAt: now, root, cwd, source, latest, installed } satisfies Check
  await host.store.set(CHECK, found)
  return found
}

async function notificationsOn(host: Host): Promise<boolean> {
  return (await host.store.get(NOTIFICATIONS)) !== false
}

/** Check in the background now and hourly; a failed check only reaches the debug log. */
export function startPluginUpdates(host: Host) {
  if (observer || host.env.get('PI_OFFLINE') || !host.session.interactive()) return
  const current = {}
  observer = current
  // A check that outlives its session, the person's opt-out or an extension update shows nothing.
  const stillCurrent = async () =>
    observer === current && installation()?.kind !== 'plugin' && (await notificationsOn(host))
  const run = async () => {
    try {
      const enabled = await notificationsOn(host)
      if (observer !== current) return
      if (!enabled) return stopPluginUpdates()
      const { latest, installed } = await check(host)
      // A check that found no release this copy can take is not evidence that a notice is obsolete.
      if (!latest || !(await stillCurrent())) return
      if (compareVersions(latest, host.plugin.version) !== 1) {
        available = undefined
        return host.ui.invalidate()
      }
      const now = host.clock.now()
      const release = { version: latest, ready: !!installed && compareVersions(installed, host.plugin.version) === 1 }
      // A release is announced once a day, in whichever session sees it first; refreshing a notice must
      // not bring back one this session does not show.
      if (reminderIsSnoozed(await host.store.get(REMINDER), latest, now)) {
        if (available) available = release
        return host.ui.invalidate()
      }
      await host.store.set(REMINDER, { version: latest, until: now + REMINDER_INTERVAL_MS })
      if (!(await stillCurrent())) return
      available = release
      host.ui.invalidate()
      host.ui.note(
        release.ready
          ? `Delta extension ${latest} is installed and ready. Run /delta-plugin-update to reload.`
          : `Delta extension ${latest} is available (running: ${host.plugin.version}). Run /delta-plugin-update to update, or /delta-plugin-update notifications off to stop these notices.`,
      )
    } catch (error) {
      if (observer === current) host.ui.debug(`Delta extension update check: ${errorText(error)}`)
    }
  }
  const schedule = (delay: number) => {
    if (observer !== current) return
    observer.timer = host.clock.after(delay, async () => {
      await run()
      schedule(CHECK_INTERVAL_MS)
    })
  }
  schedule(0)
}

export function stopPluginUpdates() {
  generation++
  observer?.timer?.cancel()
  observer = undefined
  available = undefined
}

/** Reloading pi's extensions, which only a command handler may do. */
export type Reload = { reload?(): Promise<void> }

/** A snooze holds only its release, and at most a day, however the clock moves. */
export function reminderIsSnoozed(value: unknown, version: string, now: number): boolean {
  return (
    isJsonObject(value) &&
    value.version === version &&
    typeof value.until === 'number' &&
    value.until > now &&
    value.until <= now + REMINDER_INTERVAL_MS
  )
}

/** `/delta-plugin-update`: update and reload, check, snooze this release, or control notifications. */
export async function pluginUpdateCommand(host: Host, args: string, command?: Reload): Promise<{ text?: string }> {
  if (args === 'notifications on' || args === 'notifications off') {
    await host.store.set(NOTIFICATIONS, args === 'notifications on')
    stopPluginUpdates()
    if (args === 'notifications on') startPluginUpdates(host)
    host.ui.invalidate()
    return { text: `Delta extension update notifications are ${args === 'notifications on' ? 'on' : 'off'}.` }
  }
  if (args === 'later') {
    const version = available?.version
    const started = generation
    if (!pluginUpdateNotice() || !version) return { text: 'There is no Delta extension update notice to snooze.' }
    await host.store.set(REMINDER, { version, until: host.clock.now() + REMINDER_INTERVAL_MS })
    if (generation !== started) return {}
    stopPluginUpdates()
    startPluginUpdates(host)
    host.ui.invalidate()
    return { text: `Delta extension ${version} update notices are snoozed for 24 hours.` }
  }
  if (args && args !== 'check') return { text: USAGE }
  const session = host.session.id()
  const cwd = host.session.cwd()
  const epoch = activation.epoch
  const started = generation
  const current = () =>
    generation === started &&
    activation.epoch === epoch &&
    host.session.id() === session &&
    samePath(host.session.cwd(), cwd)
  if (!args && updateBusy(host, session)) return { text: BUSY }
  const release = args === 'check' ? undefined : claimInstallation('plugin')
  if (!args && !release)
    return {
      text:
        installation()?.kind === 'app'
          ? 'A Delta installation update is still running. Let it finish before updating the extension.'
          : 'A Delta extension update is already in progress. Wait for its result.',
    }
  let checking = true
  try {
    const { source, latest, installed } = await check(host, true, cwd)
    if (source && pinned(source))
      return { text: 'This copy of the Delta extension is pinned to an exact npm version, so pi leaves it as it is.' }
    if (!source || !latest || !installed)
      return {
        text: `This copy of the Delta extension (${host.plugin.root}) wasn't installed from npm, so pi leaves it as it is.`,
      }
    const newer = compareVersions(latest, host.plugin.version) === 1
    if (!newer) return { text: `The Delta extension ${host.plugin.version} is up to date.` }
    if (args === 'check' && compareVersions(installed, host.plugin.version) === 1)
      return {
        text: `Delta extension ${installed} is already installed (running: ${host.plugin.version}). Run /delta-plugin-update to reload.`,
      }
    if (args === 'check')
      return {
        text: `Delta extension ${latest} is available (installed: ${host.plugin.version}). Run /delta-plugin-update to update.`,
      }
    if (!current() || updateBusy(host, session)) return { text: BUSY }
    checking = false
    let version = installed
    const ready = compareVersions(version, host.plugin.version) === 1
    if (!ready) {
      host.ui.note(`Updating the Delta extension to ${latest}…`)
      const result = await runPi(host, ['update', source.source], { cwd, timeoutMs: 600_000 })
      if (result.exitCode !== 0)
        return {
          text: `pi couldn't update the Delta extension: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`,
        }
      const selected = await installedSource(host, cwd)
      if (selected?.source !== source.source)
        return {
          text: "pi's updated Delta extension installation could not be verified. Check pi list before retrying.",
        }
      version = await installedVersion(host, selected)
      await host.store.delete(CHECK)
      if (compareVersions(version, host.plugin.version) !== 1)
        return { text: `pi didn't install a newer Delta extension (installed: ${version}).` }
    }
    available = undefined
    if (!current() || updateBusy(host, session) || !command?.reload)
      return { text: `Updated the Delta extension to ${version}. Run /reload to use it.` }
    host.ui.note(
      ready
        ? `Delta extension ${version} is already installed; reloading.`
        : `Updated the Delta extension to ${version}; reloading.`,
    )
    // Pi replaces this runtime while it reloads, ending this session first; nothing after a reload may
    // use this session's pi context. A reload that returns without ending it was refused, as pi's
    // terminal refuses one while it compacts, with a warning of its own.
    let failure: unknown
    try {
      await command.reload()
    } catch (error) {
      failure = error
    }
    if (generation !== started) return {}
    if (await notificationsOn(host)) {
      available = { version, ready: true }
      host.ui.invalidate()
    }
    return {
      text: `Delta extension ${version} is installed but not active in this session yet: pi ${
        failure === undefined ? "didn't reload" : `couldn't reload (${errorText(failure)})`
      }. Run /reload once pi is idle, or start a new pi session.`,
    }
  } catch (error) {
    return {
      text: checking
        ? `Delta couldn't check for an extension update: ${errorText(error)}`
        : `pi couldn't update the Delta extension: ${errorText(error)}`,
    }
  } finally {
    release?.()
    // The band's notice gives way while an installation runs.
    host.ui.invalidate()
  }
}

const BUSY = 'Wait for the current pi turn, Delta share, or join to finish, then run /delta-plugin-update.'

/** Reloading must not tear down a turn, prompt admission, or a share/join transition. */
function updateBusy(host: Host, session: string): boolean {
  const state = sessions.get(session)
  return (
    !host.session.idle() ||
    !!requests.share ||
    !!requests.join ||
    !!requests.shareAfterTurn ||
    !!state?.currentTurnId ||
    !!state?.promptEntering ||
    !!state?.joining ||
    !!state?.restoring ||
    !!state?.binding?.joinTransition
  )
}
