/**
 * Checking for a newer release of this extension, and updating it on request. Pi owns installation:
 * an update runs `pi update <source>` for the package source pi installed the extension from, then
 * reloads. Only npm sources are checked; local copies and git checkouts are left alone.
 */
import type { Host } from '../core/host.ts'
import { isJsonObject } from '../core/json.ts'
import { samePath } from '../core/paths.ts'
import { errorText } from '../core/text.ts'
import { claimInstallation, installation } from '../core/installation.ts'

const NOTIFICATIONS = 'plugin-update:notifications'
const CHECK = 'plugin-update:check'
/** One check an hour is shared by every pi process on the machine. */
const CHECK_INTERVAL_MS = 60 * 60 * 1000
const CHECK_TIMEOUT_MS = 10_000
const USAGE =
  'Usage: /delta-plugin-update [check | notifications on | notifications off]. Updates this pi extension and reloads it. /delta-update updates the Delta app and CLI instead.'

/** Where pi installed the extension from: an npm package source, by name. */
type Source = { source: string; name: string }
/** What the last check found, shared through the store. */
type Check = { checkedAt: number; name: string; latest: string }

/** The newer release the band offers, once a check found one. */
let available: string | undefined
let timer: { cancel(): void } | undefined

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
    const source = lines[index]!.trim()
    const path = lines[index + 1]!.trim()
    const name = /^npm:((?:@[^/\s]+\/)?[^@\s]+)(?:@\S+)?$/.exec(source)?.[1]
    if (name && samePath(path, root)) return { source, name }
  }
}

/** The band's notice of a newer release, while notifications are on. */
export function pluginUpdateNotice(): string | undefined {
  return available ? `Delta extension ${available} is available · /delta-plugin-update` : undefined
}

async function installedSource(host: Host): Promise<Source | undefined> {
  const listed = await host.process.run(['pi', 'list'], { timeoutMs: CHECK_TIMEOUT_MS })
  if (listed.exitCode !== 0 || listed.isStdoutTruncated)
    throw new Error(listed.stderr.trim() || 'pi could not list its packages')
  return sourceAt(listed.stdout, host.plugin.root)
}

async function latestVersion(name: string): Promise<string> {
  const response = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}/latest`, {
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`the npm registry answered ${response.status}`)
  const manifest: unknown = await response.json()
  if (!isJsonObject(manifest) || typeof manifest.version !== 'string')
    throw new Error('the npm registry sent no version')
  return manifest.version
}

/** Check for a newer release, reusing a check another process made within the hour unless `force`. */
async function check(host: Host, force = false): Promise<{ source?: Source; latest?: string }> {
  const source = await installedSource(host)
  if (!source) return {}
  const saved = (await host.store.get(CHECK)) as Check | undefined
  const fresh = !force && saved?.name === source.name && host.clock.now() - saved.checkedAt < CHECK_INTERVAL_MS
  const latest = fresh ? saved.latest : await latestVersion(source.name)
  if (!fresh) await host.store.set(CHECK, { checkedAt: host.clock.now(), name: source.name, latest } satisfies Check)
  return { source, latest }
}

async function notificationsOn(host: Host): Promise<boolean> {
  return (await host.store.get(NOTIFICATIONS)) !== false
}

/** Check in the background now and hourly; a failed check only reaches the debug log. */
export function startPluginUpdates(host: Host) {
  if (timer || process.env.PI_OFFLINE || !host.session.interactive()) return
  const run = async () => {
    try {
      if (!(await notificationsOn(host))) return
      const { latest } = await check(host)
      available = latest && compareVersions(latest, host.plugin.version) === 1 ? latest : undefined
      host.ui.invalidate()
    } catch (error) {
      host.ui.debug(`Delta extension update check: ${errorText(error)}`)
    }
  }
  const schedule = (delay: number) => {
    timer = host.clock.after(delay, async () => {
      await run()
      schedule(CHECK_INTERVAL_MS)
    })
  }
  schedule(0)
}

export function stopPluginUpdates() {
  timer?.cancel()
  timer = undefined
}

/** Reloading pi's extensions, which only a command handler may do. */
export type Reload = { reload?(): Promise<void> }

/** `/delta-plugin-update`: update and reload, `check`, or turn notifications on or off. */
export async function pluginUpdateCommand(host: Host, args: string, command?: Reload): Promise<{ text?: string }> {
  if (args === 'notifications on' || args === 'notifications off') {
    await host.store.set(NOTIFICATIONS, args === 'notifications on')
    if (args === 'notifications off') available = undefined
    host.ui.invalidate()
    return { text: `Delta extension update notifications are ${args === 'notifications on' ? 'on' : 'off'}.` }
  }
  if (args && args !== 'check') return { text: USAGE }
  let found: { source?: Source; latest?: string }
  try {
    found = await check(host, true)
  } catch (error) {
    return { text: `Delta couldn't check for an extension update: ${errorText(error)}` }
  }
  const { source, latest } = found
  if (!source || !latest)
    return {
      text: `This copy of the Delta extension (${host.plugin.root}) wasn't installed from npm, so pi leaves it as it is.`,
    }
  const newer = compareVersions(latest, host.plugin.version) === 1
  available = newer ? latest : undefined
  host.ui.invalidate()
  if (!newer) return { text: `The Delta extension ${host.plugin.version} is up to date.` }
  if (args === 'check')
    return {
      text: `Delta extension ${latest} is available (installed: ${host.plugin.version}). Run /delta-plugin-update to update.`,
    }
  const release = claimInstallation('plugin')
  if (!release)
    return {
      text:
        installation?.kind === 'app'
          ? 'A Delta installation update is still running. Let it finish before updating the extension.'
          : 'A Delta extension update is already in progress. Wait for its result.',
    }
  try {
    host.ui.note(`Updating the Delta extension to ${latest}…`)
    const result = await host.process.run(['pi', 'update', source.source], { timeoutMs: 600_000 })
    if (result.exitCode !== 0)
      return {
        text: `pi couldn't update the Delta extension: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`,
      }
    available = undefined
    if (!command?.reload) return { text: `Updated the Delta extension to ${latest}. Run /reload to use it.` }
    host.ui.note(`Updated the Delta extension to ${latest}; reloading.`)
    // Pi replaces this runtime while it reloads; nothing after it may use this session's pi context.
    await command.reload()
    return {}
  } finally {
    release()
  }
}
