/**
 * Checking for a newer release of this extension, and updating it on request. Pi owns installation:
 * an update runs `pi update <source>` for the package source pi installed the extension from, then
 * reloads. Only npm sources are checked; local copies and git checkouts are left alone.
 */
import { join } from 'node:path'
import { readText } from '../core/files.ts'
import { activation, requests, sessions } from '../core/session-state.ts'
import type { Host } from '../core/host.ts'
import { isJsonObject } from '../core/json.ts'
import { samePath } from '../core/paths.ts'
import { errorText } from '../core/text.ts'
import { claimInstallation, installation } from '../core/installation.ts'

const NOTIFICATIONS = 'plugin-update:notifications'
const CHECK = 'plugin-update:check'
const REMINDER = 'plugin-update:reminder'
/** One check an hour is shared by every pi process on the machine. */
const CHECK_INTERVAL_MS = 60 * 60 * 1000
const CHECK_TIMEOUT_MS = 10_000
const REMINDER_INTERVAL_MS = 24 * CHECK_INTERVAL_MS
const USAGE =
  'Usage: /delta-plugin-update [check | later | notifications on | notifications off]. Updates this pi extension and reloads it. /delta-update updates the Delta app and CLI instead.'

/** Where pi installed the extension from: an npm package source, by name. */
type Source = { source: string; name: string }
/** What the last check found, shared through the store. */
type Check = { checkedAt: number; root: string; cwd: string; source?: Source; latest?: string; installed?: string }

/** The newer release the band offers, once a check found one. */
let available: string | undefined
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

/** The npm source in `pi list`'s output whose installed path is `root`. */
export function sourceAt(listing: string, root: string): Source | undefined {
  const lines = listing.split('\n')
  for (let index = 0; index < lines.length - 1; index++) {
    const source = lines[index]!.trim().replace(/ \(filtered\)$/, '')
    const path = lines[index + 1]!.trim()
    const parsed = npmSource(source)
    if (parsed && samePath(path, root)) return parsed
  }
}

function npmSource(source: string): Source | undefined {
  const name = /^npm:((?:@[^/\s]+\/)?[^@\s]+)(?:@.+)?$/.exec(source)?.[1]
  if (name) return { source, name }
}

/** The band's notice of a newer release, while notifications are on. */
export function pluginUpdateNotice(): string | undefined {
  return available && !installation() ? `Delta extension ${available} is available · /delta-plugin-update` : undefined
}

async function installedSource(host: Host, cwd: string): Promise<Source | undefined> {
  const listed = await host.process.run(['pi', 'list'], { cwd, timeoutMs: CHECK_TIMEOUT_MS })
  if (listed.exitCode !== 0 || listed.isStdoutTruncated || listed.isStderrTruncated)
    throw new Error(listed.stderr.trim() || 'pi could not list its packages')
  return sourceAt(listed.stdout, host.plugin.root)
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
  const response = await fetch(`https://registry.npmjs.org/${source.name.replace('/', '%2F')}/latest`, {
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`the npm registry answered ${response.status}`)
  const manifest: unknown = await response.json()
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
function checkFrom(value: unknown): Check | undefined {
  if (
    !isJsonObject(value) ||
    typeof value.checkedAt !== 'number' ||
    !Number.isFinite(value.checkedAt) ||
    value.checkedAt < 0 ||
    typeof value.root !== 'string' ||
    typeof value.cwd !== 'string' ||
    (value.latest !== undefined && (typeof value.latest !== 'string' || !versionParts(value.latest))) ||
    (value.installed !== undefined && (typeof value.installed !== 'string' || !versionParts(value.installed)))
  )
    return
  const source = value.source
  if (
    source !== undefined &&
    (!isJsonObject(source) ||
      typeof source.source !== 'string' ||
      !source.name ||
      npmSource(source.source)?.name !== source.name)
  )
    return
  return value as Check
}

/** Attempts, including failures, wait an hour; a failure retains the last known release. */
async function check(host: Host, force = false, cwd = host.session.cwd()): Promise<Check> {
  const now = host.clock.now()
  const root = host.plugin.root
  const saved = checkFrom(await host.store.get(CHECK))
  const previous = saved && samePath(saved.root, root) && samePath(saved.cwd, cwd) ? saved : undefined
  if (!force && previous && now >= previous.checkedAt && now - previous.checkedAt < CHECK_INTERVAL_MS) return previous
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
  const run = async () => {
    try {
      const enabled = await notificationsOn(host)
      if (observer !== current) return
      if (!enabled) return stopPluginUpdates()
      const { latest } = await check(host)
      const reminder = await host.store.get(REMINDER)
      const stillEnabled = await notificationsOn(host)
      if (observer !== current || !stillEnabled || installation()) return
      available =
        latest && compareVersions(latest, host.plugin.version) === 1 && !snoozed(reminder, latest, host.clock.now())
          ? latest
          : undefined
      host.ui.invalidate()
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

function snoozed(value: unknown, version: string, now: number): boolean {
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
    const version = available
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
      const result = await host.process.run(['pi', 'update', source.source], { cwd, timeoutMs: 600_000 })
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
    // Pi replaces this runtime while it reloads; nothing after it may use this session's pi context.
    await command.reload()
    return {}
  } catch (error) {
    return {
      text: checking
        ? `Delta couldn't check for an extension update: ${errorText(error)}`
        : `pi couldn't update the Delta extension: ${errorText(error)}`,
    }
  } finally {
    release?.()
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
