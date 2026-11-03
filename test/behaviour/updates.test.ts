// Updating the Delta app and CLI, and this extension, ported from the upstream plugin's engine tests
// (hooks/cli/install-update.test.ts, and hooks/register.test.ts: startup and commands, plugin updates)
// onto the kit.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { UPDATE_HELPER_ARGV } from '../fake-delta/cli.ts'
import { type Kit, startDelta } from '../kit/index.ts'
import type { Exit, Output, ProcessStream, RunResult } from '../../src/core/process.ts'

let delta: Kit | undefined
afterEach(async () => {
  delta?.expectClean()
  await delta?.stop()
  delta = undefined
  vi.unstubAllGlobals()
})

const NOT_NOW = (dialog: { title: string }) => (dialog.title.includes('Set it up now?') ? 'Not now' : undefined)

/** Start pi in a repository without a policy, its setup offer declined, once its startup update check ran. */
async function started(options: Parameters<typeof startDelta>[0] = {}) {
  const kit = await startDelta({ answers: [NOT_NOW], ...options })
  await kit.until(() => kit.pi.dialogs.length === 1, 'the setup offer')
  await kit.until(() => checks(kit) === 1, 'the startup update check')
  await kit.settle()
  return kit
}

/** How many read-only update checks ran. */
const checks = (kit: Kit) => kit.commands().filter((args) => args.join(' ') === 'update --check').length
/** The explicit updates the extension ran, without their check. */
const updates = (kit: Kit) =>
  kit.world.calls().filter((call) => call.argv[0] === 'update' && !call.argv.includes('--check'))
/** What the extension wrote to its debug log. */
const debugLog = (kit: Kit) => {
  const path = join(kit.world.agentDir, 'delta', 'debug.log')
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}
/** The band, as pi's status line shows it to a client without pi's terminal. */
const band = (kit: Kit) => kit.pi.statuses.get('delta') ?? ''
const notices = (kit: Kit) => kit.pi.noticeTexts()

/** Share the session with the team, and answer with its link. */
async function share(kit: Kit): Promise<string> {
  kit.pi.answers.push((dialog) =>
    dialog.title.includes('Who should see this session?') ? 'Share with Zed' : undefined,
  )
  await kit.pi.command('delta', 'share')
  const shared = await kit.until(
    () => notices(kit).find((text) => text.startsWith('Delta: Shared')),
    'the share to finish',
  )
  return shared.slice(shared.lastIndexOf(' ') + 1)
}

/** A typed update reply, as `delta update --json` writes it. */
const reply = (status: string, fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    schema_version: 1,
    status,
    current_version: '0.23.0',
    latest_version: '0.24.0',
    channel: 'stable',
    message: '',
    can_install: true,
    ...fields,
  })

test('a stalled startup check cannot block prompts or sharing and expires without a late notice', async () => {
  delta = await startDelta({ answers: [NOT_NOW], start: false })
  delta.world.release('0.24.0')
  const release = delta.world.hold('update --check')
  await delta.pi.start()
  await delta.until(() => checks(delta!) === 1, 'the startup update check')
  expect(await delta.pi.prompt('hello')).toBe('settled')
  expect(await share(delta)).toMatch(/^https:\/\//)
  await delta.advance(10_000)
  await delta.until(() => debugLog(delta!).includes('update check timed out'), 'the check to time out')
  release()
  // The held check answers once released; nothing waits for it any more.
  await new Promise((resolve) => setTimeout(resolve, 100))
  await delta.settle()
  expect(notices(delta).some((text) => text.includes('0.24.0 is available'))).toBe(false)
})

for (const command of ['delta-update', 'delta'] as const)
  test(`${command} explicitly updates with its telemetry command form`, async () => {
    delta = await started()
    delta.world.release('0.24.0')
    const release = delta.world.hold('update install')
    const before = notices(delta).length
    const updating = command === 'delta' ? delta.pi.command('delta', 'update') : delta.pi.command('delta-update')
    // The band draws the CLI's latest event in place of the last; the transcript only says it started.
    await delta.until(() => band(delta!).includes('45%'), 'the download to report its progress')
    expect(band(delta)).toContain('Downloading 0.24.0')
    expect(band(delta)).not.toContain('25%')
    expect(notices(delta).slice(before)).toEqual(['Updating Delta installation…'])
    release()
    await updating
    expect(notices(delta).at(-1)).toBe('Updated Delta to 0.24.0.')
    expect(band(delta)).not.toContain('Downloading')
    expect(updates(delta).map((call) => call.argv)).toEqual([['update', '--json']])
    expect(updates(delta)[0]!.env).toEqual({
      integration: 'pi',
      form: command === 'delta' ? 'delta_subcommand' : 'dedicated_command',
    })
  })

test('an installer the plugin did not ask for is refused and never started', async () => {
  delta = await started()
  delta.world.answer('update', {
    stdout: reply('install_ready', { install_argv: [...UPDATE_HELPER_ARGV, '0.24.0'] }),
    exitCode: 0,
  })
  await delta.pi.command('delta', 'update')
  expect(notices(delta).at(-1)).toContain('Unexpected Delta update response.')
  expect(delta.others().map((argv) => argv[0])).not.toContain(UPDATE_HELPER_ARGV[0])
})

for (const status of ['updated', 'install_ready'] as const)
  test(`read-only checks reject ${status}`, async () => {
    delta = await startDelta({ answers: [NOT_NOW], start: false })
    delta.world.answer('update --check', {
      stdout: reply(status, status === 'install_ready' ? { install_argv: [...UPDATE_HELPER_ARGV, '0.24.0'] } : {}),
      exitCode: 0,
    })
    await delta.pi.start()
    await delta.until(
      () => debugLog(delta!).includes('Unexpected installation change reported by a read-only update check'),
      'the check to refuse the change',
    )
    expect(notices(delta).some((text) => text.includes('0.24.0'))).toBe(false)
    expect(delta.others().map((argv) => argv[0])).not.toContain(UPDATE_HELPER_ARGV[0])
  })

test('a stalled explicit update times out and allows a later retry', async () => {
  delta = await started()
  delta.world.release('0.24.0')
  const release = delta.world.hold('update install')
  const updating = delta.pi.command('delta', 'update')
  await delta.until(() => band(delta!).includes('45%'), 'the download to report its progress')
  await delta.advance(600_000)
  await updating
  expect(notices(delta).at(-1)).toContain('update timed out')
  expect(band(delta)).not.toContain('Downloading')
  release()
  await delta.pi.command('delta', 'update')
  expect(notices(delta).at(-1)).toContain('Updated Delta to 0.24.0')
})

/** What each failure's answer must say for the person to act on it, and how the CLI fails that way. */
const FAILURES = {
  'old-cli': {
    advice: "unrecognized subcommand 'update'",
    answer: { stderr: "error: unrecognized subcommand 'update'", exitCode: 2 },
  },
  network: {
    advice: 'Check network access.',
    answer: {
      stdout: JSON.stringify({ error: { code: 'network_error', message: 'Check network access.', retryable: true } }),
      exitCode: 1,
    },
  },
  'app-running': {
    advice: 'Quit Delta and retry.',
    answer: {
      stdout: JSON.stringify({ error: { code: 'app_running', message: 'Quit Delta and retry.', retryable: true } }),
      exitCode: 1,
    },
  },
  // The CLI's own advice names `delta update`; the extension's names its own command.
  'app-working': {
    advice: 'Retry /delta-update once that work finishes.',
    answer: {
      stdout: JSON.stringify({
        error: {
          code: 'app_working',
          retryable: true,
          message:
            'Delta is running agent work, such as a turn or a terminal. Nothing was stopped; run `delta update` again once it finishes.',
        },
      }),
      exitCode: 2,
    },
  },
  malformed: { advice: 'https://delta.dev', answer: { stdout: '{}', exitCode: 0 } },
  crash: {
    advice: 'exited with code 101 without reporting a result',
    answer: { stderr: "thread 'main' panicked at src/main.rs:1:1:\nboom\n", exitCode: 101 },
  },
} as const

for (const [failure, { advice, answer }] of Object.entries(FAILURES))
  test(`${failure} update failures stay actionable and do not block sharing`, async () => {
    delta = await startDelta({ answers: [NOT_NOW], start: false })
    delta.world.answer('update --check', answer)
    delta.world.answer('update', answer)
    await delta.pi.start()
    await delta.until(
      () => [...notices(delta!), debugLog(delta!)].some((text) => text.includes('Delta update check:')),
      'the startup check to report its failure',
    )
    await delta.until(() => delta!.pi.dialogs.length === 1, 'the setup offer')
    await delta.pi.command('delta', 'update')
    const result = notices(delta).at(-1)!
    expect(result).toContain(advice)
    expect(result).not.toMatch(/panicked|`delta update` again/)
    expect(await share(delta)).toMatch(/^https:\/\//)
  })

for (const status of ['update_available', 'unsupported'] as const)
  test(`${status} preserves manual installation advice without offering an unsupported command`, async () => {
    const message =
      status === 'update_available'
        ? 'Quit Delta, then run the Windows installer from https://delta.dev.'
        : 'Update Delta through your package manager.'
    const answer = {
      stdout: reply(status, {
        can_install: false,
        message,
        ...(status === 'unsupported' ? { latest_version: null } : {}),
      }),
      exitCode: 0,
    }
    delta = await startDelta({ answers: [NOT_NOW], start: false })
    delta.world.answer('update --check', answer)
    delta.world.answer('update', answer)
    await delta.pi.start()
    const notice =
      status === 'update_available'
        ? `Delta 0.24.0 is available (installed: 0.23.0). ${message}`
        : `Delta update check: ${message}`
    await delta.until(() => notices(delta!).includes(notice), 'the startup notice')
    expect(notices(delta).filter((text) => text.includes(message))).toEqual([notice])
    await delta.pi.command('delta', 'update')
    expect(notices(delta).at(-1)).toBe(
      status === 'update_available'
        ? `Delta was not updated: ${message}`
        : `Delta cannot update this installation: ${message}`,
    )
  })

/** The Delta CLI `where.exe` finds on Windows. */
const WINDOWS_DELTA = 'C:\\Delta\\bin\\delta.exe'
/** What the Windows install helper asks of the person once its installer starts. */
const UPDATE_HELPER_APPROVAL = 'Approve the Windows installer prompt if one appears.'
const ran = (stdout: string, exitCode = 0, stderr = ''): RunResult => ({
  stdout,
  stderr,
  exitCode,
  isStdoutTruncated: false,
  isStderrTruncated: false,
})
const progressEvent = (fields: Record<string, unknown>) =>
  `${JSON.stringify({ schema_version: 1, type: 'progress', ...fields })}\n`

/**
 * A program's output as it goes: each piece in turn, waiting at each promise until it settles, then its
 * exit; `onStop` hears it stopped.
 */
function streamed(pieces: (Output | Promise<void>)[], code: number | null, onStop = () => {}): ProcessStream {
  let exit: Exit | undefined
  let halt!: () => void
  const halted = new Promise<void>((resolve) => (halt = resolve))
  return {
    pid: undefined,
    async next() {
      for (let piece = pieces.shift(); piece; piece = pieces.shift()) {
        if (!(piece instanceof Promise)) return { done: false, value: piece }
        await Promise.race([piece, halted])
        if (exit) break
      }
      return { done: true, value: exit ?? { code, signal: null } }
    },
    async return() {
      onStop()
      exit ??= { code: null, signal: 'SIGTERM' }
      halt()
      return { done: true, value: exit }
    },
  }
}

type HelperOutcome = 'installed' | 'restart' | 'unsaid' | 'crash' | { code: string; message: string }

/** Start pi on Windows, where `where.exe` finds Delta and its update helper does what `helper` says. */
async function onWindows(helper: {
  outcome: HelperOutcome
  hold?: Promise<void>
  stopped?: boolean
  started?: number[]
}) {
  const kit = await startDelta({ answers: [NOT_NOW], windows: true, start: false })
  kit.programs.set('where.exe', () => ran(`${WINDOWS_DELTA}\r\n`))
  kit.programs.set('delta-update-helper', () => {
    // The CLI has exited by now: the extension ran each download before its helper.
    helper.started?.push(updates(kit).length)
    const { outcome } = helper
    if (outcome === 'crash') return streamed([], 3221225477)
    const preparing = { stream: 'stderr', text: progressEvent({ phase: 'preparing', version: '0.24.0' }) } as const
    if (typeof outcome === 'object')
      return streamed(
        [
          preparing,
          { stream: 'stderr', text: `delta: ${outcome.message}\n` },
          { stream: 'stdout', text: JSON.stringify({ error: { ...outcome, retryable: false } }) },
        ],
        2,
      )
    const approval = JSON.stringify({
      schema_version: 1,
      type: 'action_required',
      action: 'approve_installer',
      message: UPDATE_HELPER_APPROVAL,
    })
    return streamed(
      [
        preparing,
        { stream: 'stderr', text: `${progressEvent({ phase: 'installing', version: '0.24.0' })}${approval}\n` },
        ...(helper.hold ? [helper.hold] : []),
        {
          stream: 'stdout',
          text: reply('updated', {
            message: 'Delta was updated.',
            ...(outcome === 'unsaid' ? {} : { restart_required: outcome === 'restart' }),
          }),
        },
      ],
      0,
      () => (helper.stopped = true),
    )
  })
  kit.world.release('0.24.0')
  await kit.pi.start()
  await kit.until(() => kit.pi.dialogs.length === 1, 'the setup offer')
  await kit.until(() => notices(kit).some((text) => text.includes('0.24.0 is available')), 'the startup check')
  return kit
}

const WINDOWS_OUTCOMES = {
  installed: 'Updated Delta to 0.24.0.',
  restart:
    'Updated Delta to 0.24.0. Windows reports that a restart is required to finish the installation; restart Windows, then pi.',
  refused: 'Delta installation update failed: update: app_running: Delta is running. Quit it, then update again.',
  crash:
    'Delta installation update failed: The Delta installer helper exited with code 3221225477. Run `delta update --check` before retrying /delta-update.',
  unsaid:
    'Delta installation update failed: Unexpected Delta update response. Update your Delta installation from https://delta.dev, then restart pi and retry /delta-update.',
} as const

test('on Windows the plugin runs the installer once the CLI exits and reports each outcome', async () => {
  const helper: Parameters<typeof onWindows>[0] = { outcome: 'installed', started: [] }
  delta = await onWindows(helper)
  for (const [outcome, expected] of Object.entries(WINDOWS_OUTCOMES)) {
    helper.outcome =
      outcome === 'refused'
        ? { code: 'app_running', message: 'Delta is running. Quit it, then update again.' }
        : (outcome as HelperOutcome)
    await delta.pi.command('delta', 'update')
    expect(notices(delta).at(-1)).toBe(expected)
  }
  const outcomes = Object.keys(WINDOWS_OUTCOMES).length
  expect(updates(delta).map((call) => call.argv)).toEqual(
    Array.from({ length: outcomes }, () => ['update', '--download-only', '--json']),
  )
  expect(delta.others().filter((argv) => argv[0] === UPDATE_HELPER_ARGV[0])).toEqual(
    Array.from({ length: outcomes }, () => [...UPDATE_HELPER_ARGV, '0.24.0']),
  )
  expect(helper.started).toEqual([1, 2, 3, 4, 5])
  // Each started installer asks for approval once, in full; a refused or crashed one never got that far.
  expect(notices(delta).filter((text) => text === UPDATE_HELPER_APPROVAL)).toHaveLength(3)
})

test('a Windows installer still running at the deadline is left to finish', async () => {
  let release!: () => void
  const helper: Parameters<typeof onWindows>[0] = {
    outcome: 'installed',
    hold: new Promise<void>((resolve) => (release = resolve)),
    stopped: false,
  }
  delta = await onWindows(helper)
  const updating = delta.pi.command('delta', 'update')
  await delta.until(() => notices(delta!).includes(UPDATE_HELPER_APPROVAL), 'the installer to ask for approval')
  // The band keeps a short state while the installer waits on the person; the transcript has the whole ask.
  await delta.until(() => band(delta!).includes('Waiting for installer approval'), 'the band to say so')
  await delta.advance(600_000)
  await updating
  expect(notices(delta).at(-1)).toBe(
    'Delta installation update failed: The Delta installer is still running after 10 minutes; it may be waiting for you to approve a Windows prompt. Let it finish, then run `delta update --check` before retrying /delta-update.',
  )
  expect(helper.stopped).toBe(false)
  release()
})

test('Windows update option failures preserve the CLI error even when update checks work', async () => {
  delta = await onWindows({ outcome: 'installed' })
  delta.world.answer('update --download-only', {
    stderr: "error: unexpected argument '--download-only' found\n\nUsage: delta.exe update [OPTIONS]\n",
    exitCode: 2,
  })
  await delta.pi.command('delta', 'update')
  const result = notices(delta).at(-1)!
  expect(result).toContain("error: unexpected argument '--download-only' found\n\nUsage: delta.exe update [OPTIONS]")
  expect(result).not.toContain('This Delta CLI does not support')
  expect(result).not.toContain('https://delta.dev')
  expect(delta.others().map((argv) => argv[0])).not.toContain(UPDATE_HELPER_ARGV[0])
})

/** This copy of the extension: where it runs from, and the version it runs. */
const ROOT = join(import.meta.dirname, '..', '..')
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { name: string; version: string }
const NAME = MANIFEST.name
const RUNNING = MANIFEST.version
const REGISTRY = `https://registry.npmjs.org/${NAME.replace('/', '%2F')}/latest`
const HOUR = 3_600_000
const DAY = 24 * HOUR

/**
 * The extension as pi installed it, and npm: `pi list` lists `source` at `path`, `pi update` installs
 * `latest`, and the registry answers `latest` (or `status`). Holds make a request or update wait.
 */
type Extension = {
  source: string
  path: string
  latest: string
  status: number
  holdFetch?: Promise<void>
  holdUpdate?: Promise<void>
  /** What a failing `pi update` says. */
  updateFailure?: string
  /** Whether the pi command is missing from PATH. */
  missing?: boolean
  fetches: string[]
  lists: number
  piUpdates: { argv: string[]; cwd?: string; timeoutMs?: number }[]
  /** Put `version` on disk where this copy runs from, as another pi's `pi update` would. */
  install(version: string): void
}

/** Start pi with update checks on, the extension installed from npm, and `0.2.0` released. */
async function withExtension(
  options: Parameters<typeof startDelta>[0] = {},
  change: (extension: Extension, kit: Kit) => void | Promise<void> = () => {},
) {
  const kit = await startDelta({
    answers: [NOT_NOW],
    ...options,
    env: { PI_OFFLINE: undefined, ...options.env },
    start: false,
  })
  const extension: Extension = {
    source: `npm:${NAME}`,
    path: ROOT,
    latest: '0.2.0',
    status: 200,
    fetches: [],
    lists: 0,
    piUpdates: [],
    install: (version) => void kit.disk.content(join(ROOT, 'package.json'), JSON.stringify({ ...MANIFEST, version })),
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { signal?: AbortSignal }) => {
      extension.fetches.push(String(url))
      const aborted = new Promise<never>((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted.')), { once: true }),
      )
      await Promise.race([extension.holdFetch, aborted])
      return extension.status === 200
        ? Response.json({ name: NAME, version: extension.latest })
        : new Response('', { status: extension.status })
    }),
  )
  kit.programs.set('pi', async (argv, init) => {
    if (extension.missing) throw Object.assign(new Error('spawn pi ENOENT'), { code: 'ENOENT' })
    if (argv[1] === 'list') {
      extension.lists++
      return ran(`User packages:\n  ${extension.source}\n    ${extension.path}\n`)
    }
    if (argv[1] !== 'update') return undefined
    extension.piUpdates.push({ argv, cwd: init.cwd, timeoutMs: init.timeoutMs })
    await extension.holdUpdate
    if (extension.updateFailure) return ran('', 1, extension.updateFailure)
    extension.install(extension.latest)
    return ran(`Updated ${argv[2]}\n`)
  })
  await change(extension, kit)
  await kit.pi.start()
  if (kit.pi.mode === 'rpc') await kit.until(() => kit.pi.dialogs.length === 1, 'the setup offer')
  await kit.settle()
  return { kit, extension }
}

/** Let the extension's file work under way, such as a background check's, finish. */
async function quiet(kit: Kit) {
  for (let touched = -1; touched !== kit.disk.touched().length;) {
    touched = kit.disk.touched().length
    await new Promise((resolve) => setTimeout(resolve, 20))
    await kit.settle()
  }
}

/** Let `milliseconds` pass, and the work that falls due finish. */
async function passes(kit: Kit, milliseconds: number) {
  await kit.advance(milliseconds)
  await quiet(kit)
}

/** The extension's notice in the band, if it shows one. */
const extensionNotice = (kit: Kit) =>
  /Delta extension \S+ is [^·]+· \/delta-plugin-update[^ ]*( to reload)?/.exec(band(kit))?.[0]
const announced = (kit: Kit, version: string) =>
  notices(kit).filter((text) => text.startsWith(`Delta extension ${version} is available (running: ${RUNNING})`))

describe('plugin updates', () => {
  test('startup and hourly checks notify without installing, and reminders survive another session', async () => {
    const { kit, extension } = await withExtension()
    delta = kit
    await kit.until(() => extensionNotice(kit), 'the notice')
    expect(extension.fetches).toEqual([REGISTRY])
    expect(extension.piUpdates).toEqual([])
    expect(announced(kit, '0.2.0')).toEqual([
      `Delta extension 0.2.0 is available (running: ${RUNNING}). Run /delta-plugin-update to update, or /delta-plugin-update notifications off to stop these notices.`,
    ])
    expect(extensionNotice(kit)).toBe('Delta extension 0.2.0 is available · /delta-plugin-update')
    await passes(kit, HOUR)
    await kit.until(() => extension.fetches.length === 2, 'the hourly check')
    await kit.settle()
    expect(announced(kit, '0.2.0')).toHaveLength(1)
    expect(extensionNotice(kit)).toBeDefined()
    const lists = extension.lists
    await kit.pi.newSessionIn()
    await quiet(kit)
    await kit.settle()
    // Within the hour, another session reuses the check: no request and no pi run; and the reminder
    // it showed is not repeated there within the day.
    expect(extension.fetches).toHaveLength(2)
    expect(extension.lists).toBe(lists)
    expect(extensionNotice(kit)).toBeUndefined()
    expect(announced(kit, '0.2.0')).toHaveLength(1)
    expect(extension.piUpdates).toEqual([])
  })

  test('the notice snoozes for a day, but a newer release gets its own notice', async () => {
    const { kit, extension } = await withExtension()
    delta = kit
    await kit.until(() => extensionNotice(kit), 'the notice')
    await kit.pi.command('delta-plugin-update', 'later')
    expect(extensionNotice(kit)).toBeUndefined()
    await passes(kit, HOUR)
    expect(extensionNotice(kit)).toBeUndefined()
    extension.latest = '0.3.0'
    await passes(kit, HOUR)
    await kit.until(() => extensionNotice(kit)?.includes('0.3.0'), 'the newer release')
    await kit.pi.command('delta-plugin-update', 'later')
    expect(extensionNotice(kit)).toBeUndefined()
    await passes(kit, DAY)
    await kit.until(() => extensionNotice(kit), 'the notice once the snooze ends')
    expect(extension.piUpdates).toEqual([])
  })

  test('notification opt-out persists and stops background requests, while manual check and re-enabling work', async () => {
    const { kit, extension } = await withExtension()
    delta = kit
    await kit.until(() => extensionNotice(kit), 'the notice')
    await kit.pi.command('delta-plugin-update', 'notifications off')
    expect(await kit.store.get('plugin-update:notifications')).toBe(false)
    expect(extensionNotice(kit)).toBeUndefined()
    await passes(kit, HOUR)
    expect(extension.fetches).toHaveLength(1)
    await kit.pi.newSessionIn()
    await quiet(kit)
    await passes(kit, 0)
    expect(extension.fetches).toHaveLength(1)
    await kit.pi.command('delta-plugin-update', 'check')
    expect(notices(kit).at(-1)).toContain('0.2.0 is available')
    expect(extension.fetches).toHaveLength(2)
    expect(extension.piUpdates).toEqual([])
    await kit.pi.command('delta-plugin-update', 'notifications on')
    expect(notices(kit).at(-1)).toContain('are on')
    await passes(kit, 0)
    expect(await kit.store.get('plugin-update:notifications')).toBe(true)
    // Enabling reuses the check that just ran.
    expect(extension.fetches).toHaveLength(2)
  })

  for (const command of ['delta', 'delta-plugin-update'] as const)
    test(`${command} updates at the installed scope and reloads immediately without a question`, async () => {
      const { kit, extension } = await withExtension({}, async (_, kit) => {
        await kit.store.set('plugin-update:notifications', false)
      })
      delta = kit
      await passes(kit, 0)
      // Opted out, nothing checks in the background.
      expect(extension.fetches).toEqual([])
      const dialogs = kit.pi.dialogs.length
      if (command === 'delta') await kit.pi.command('delta', 'plugin-update')
      else await kit.pi.command('delta-plugin-update')
      expect(extension.piUpdates).toEqual([
        { argv: ['pi', 'update', `npm:${NAME}`], cwd: kit.world.checkout, timeoutMs: 600_000 },
      ])
      expect(kit.pi.reloads).toBe(1)
      expect(notices(kit)).toContain('Updated the Delta extension to 0.2.0; reloading.')
      expect(kit.pi.dialogs).toHaveLength(dialogs)
      // The command's own check is the one request: the update needs to know there is a newer release.
      expect(extension.fetches).toEqual([REGISTRY])
    })

  test('a native download is offered as a reload, without network access or another installation', async () => {
    // Another pi process installed 0.2.0 where this copy runs from, which still runs the version it loaded.
    const { kit, extension } = await withExtension({}, (extension) => {
      extension.install('0.2.0')
      extension.status = 503
    })
    delta = kit
    await kit.until(() => extensionNotice(kit), 'the notice')
    expect(extensionNotice(kit)).toBe('Delta extension 0.2.0 is installed · /delta-plugin-update to reload')
    expect(notices(kit)).toContain('Delta extension 0.2.0 is installed and ready. Run /delta-plugin-update to reload.')
    await kit.pi.command('delta-plugin-update')
    expect(extension.fetches).toEqual([])
    expect(extension.piUpdates).toEqual([])
    expect(kit.pi.reloads).toBe(1)
  })

  test('a visible notice follows a native download and stays out of the way of a running turn or survey', async () => {
    const { kit, extension } = await withExtension()
    delta = kit
    await kit.until(() => extensionNotice(kit), 'the notice')
    expect(extensionNotice(kit)).toContain('is available')
    extension.install('0.2.0')
    await passes(kit, HOUR)
    await kit.until(() => extensionNotice(kit)?.includes('to reload'), 'the notice to offer a reload')
    // While a turn runs, the notice gives way and nothing reloads under it.
    let answer!: (text: string) => void
    kit.pi.model = () => new Promise((resolve) => (answer = (text) => resolve({ text })))
    const turn = kit.pi.submit('a long task')
    await kit.until(() => answer, 'the turn to run')
    expect(extensionNotice(kit)).toBeUndefined()
    await kit.pi.command('delta-plugin-update')
    expect(notices(kit).at(-1)).toContain('Wait for the current pi turn')
    expect(kit.pi.reloads).toBe(0)
    answer('Done.')
    await turn
    await kit.until(() => extensionNotice(kit), 'the notice once the turn ends')
    expect(extension.fetches).toHaveLength(1)
  })

  test('an app installation hides the update row and prevents plugin installation or reload', async () => {
    const { kit, extension } = await withExtension()
    delta = kit
    await kit.until(() => extensionNotice(kit), 'the notice')
    kit.world.release('0.24.0')
    const release = kit.world.hold('update install')
    const updating = kit.pi.command('delta', 'update')
    await kit.until(() => band(kit).includes('45%'), 'the app update to run')
    expect(extensionNotice(kit)).toBeUndefined()
    await kit.pi.command('delta', 'plugin-update')
    expect(notices(kit).at(-1)).toContain('installation update is still running')
    expect(extension.piUpdates).toEqual([])
    release()
    await updating
    expect(extensionNotice(kit)).toBeDefined()
    await kit.pi.command('delta', 'plugin-update')
    expect(extension.piUpdates).toHaveLength(1)
    expect(kit.pi.reloads).toBe(1)
  })

  test('a plugin install and its queued reload prevent a concurrent app installation', async () => {
    let releaseUpdate!: () => void
    let releaseReload!: () => void
    const { kit, extension } = await withExtension({}, (extension) => {
      extension.holdUpdate = new Promise<void>((resolve) => (releaseUpdate = resolve))
    })
    delta = kit
    kit.world.release('0.24.0')
    kit.pi.nextReload = new Promise<void>((resolve) => (releaseReload = resolve))
    const updating = kit.pi.command('delta', 'plugin-update')
    await kit.until(() => extension.piUpdates.length === 1, 'pi update')
    await kit.pi.command('delta', 'update')
    expect(notices(kit).at(-1)).toContain('extension update is in progress')
    releaseUpdate()
    await kit.until(() => notices(kit).includes('Updated the Delta extension to 0.2.0; reloading.'), 'the reload')
    await kit.pi.command('delta-update')
    expect(notices(kit).at(-1)).toContain('extension update is in progress')
    expect(updates(kit)).toEqual([])
    releaseReload()
    await updating
    expect(kit.pi.reloads).toBe(1)
    // Once the reloaded extension runs, the installation is free again.
    await kit.pi.command('delta', 'update')
    expect(notices(kit).at(-1)).toBe('Updated Delta to 0.24.0.')
  })

  test('a missing standalone Claude CLI has actionable advice and leaves background discovery quiet', async () => {
    const { kit, extension } = await withExtension({}, (extension) => {
      extension.missing = true
    })
    delta = kit
    await kit.until(() => debugLog(kit).includes('Delta extension update check:'), 'the failed check')
    expect(debugLog(kit)).toContain('on PATH')
    expect(notices(kit).join('\n')).not.toContain('on PATH')
    await kit.pi.command('delta-plugin-update')
    expect(notices(kit).at(-1)).toContain('make pi available on PATH')
    expect(extension.piUpdates).toEqual([])
  })

  test('a failed check preserves a known release and an existing notice', async () => {
    const { kit, extension } = await withExtension()
    delta = kit
    await kit.until(() => extensionNotice(kit), 'the notice')
    extension.status = 503
    await passes(kit, HOUR)
    await kit.until(() => extension.fetches.length === 2, 'the failed check')
    await kit.settle()
    expect(((await kit.store.get('plugin-update:check')) as { latest?: string }).latest).toBe('0.2.0')
    expect(extensionNotice(kit)).toBeDefined()
  })

  for (const kind of ['headless', 'network disabled', 'development'] as const)
    test(`background checking leaves ${kind} sessions alone`, async () => {
      const { kit, extension } = await withExtension(
        {
          // Any nonempty value opts out, including one that reads as false.
          ...(kind === 'network disabled' ? { env: { PI_OFFLINE: '0' } } : {}),
          ...(kind === 'headless' ? { mode: 'print' as const } : {}),
        },
        (extension) => {
          // This copy runs from a checkout (`pi -e`), while pi's npm installation is elsewhere.
          if (kind === 'development') extension.path = '/home/ada/.pi/agent/npm/node_modules/' + NAME
        },
      )
      delta = kit
      await passes(kit, 0)
      expect(extension.fetches).toEqual([])
      expect(extension.piUpdates).toEqual([])
      if (kind !== 'development') expect(extension.lists).toBe(0)
      if (kind === 'development') {
        await kit.pi.command('delta-plugin-update')
        expect(notices(kit).at(-1)).toContain("wasn't installed from npm, so pi leaves it as it is")
      }
    })

  test('failed discovery stays quiet and remains throttled', async () => {
    const { kit, extension } = await withExtension({}, (extension) => {
      extension.status = 503
    })
    delta = kit
    await kit.until(() => debugLog(kit).includes('Delta extension update check:'), 'the failed check')
    expect(debugLog(kit).match(/Delta extension update check:/g)).toHaveLength(1)
    expect(notices(kit).some((text) => text.includes('update check'))).toBe(false)
    expect(await kit.pi.prompt('keep working')).toBe('settled')
    await kit.pi.newSessionIn()
    await quiet(kit)
    await passes(kit, 0)
    expect(extension.fetches).toHaveLength(1)
    expect(extension.piUpdates).toEqual([])
  })

  test('a slow check times out, cannot install or notify late, and never overlaps its own timer', async () => {
    let release!: () => void
    const { kit, extension } = await withExtension({}, (extension) => {
      extension.holdFetch = new Promise<void>((resolve) => (release = resolve))
    })
    delta = kit
    await kit.until(() => extension.fetches.length === 1, 'the check')
    expect(await kit.pi.prompt('working')).toBe('settled')
    await passes(kit, 10_000)
    await kit.until(() => debugLog(kit).includes('timed out'), 'the check to time out')
    // A new session within the hour does not start another: the attempt counts.
    await kit.pi.newSessionIn()
    await quiet(kit)
    await passes(kit, 0)
    expect(extension.fetches).toHaveLength(1)
    release()
    await kit.settle()
    expect(notices(kit).some((text) => text.includes('Delta extension 0.2.0'))).toBe(false)
    expect(extensionNotice(kit)).toBeUndefined()
    expect(extension.piUpdates).toEqual([])
  })

  test('ending the session or opting out invalidates an in-flight notice', async () => {
    let release!: () => void
    const { kit, extension } = await withExtension({}, (extension) => {
      extension.holdFetch = new Promise<void>((resolve) => (release = resolve))
    })
    delta = kit
    await kit.until(() => extension.fetches.length === 1, 'the check')
    await kit.pi.command('delta-plugin-update', 'notifications off')
    await kit.pi.newSessionIn()
    await quiet(kit)
    release()
    await kit.settle()
    await passes(kit, HOUR)
    expect(extension.fetches).toHaveLength(1)
    expect(notices(kit).some((text) => text.includes('Delta extension 0.2.0'))).toBe(false)
    expect(extensionNotice(kit)).toBeUndefined()
  })

  test('installation failure never reloads, and a surviving watchdog reports a thrown reload failure', async () => {
    const { kit, extension } = await withExtension({}, (extension) => {
      extension.updateFailure = 'npm error 403 Forbidden - PUT https://registry.npmjs.org/'
    })
    delta = kit
    await kit.pi.command('delta-plugin-update')
    expect(notices(kit).at(-1)).toContain('403 Forbidden')
    expect(kit.pi.reloads).toBe(0)
    expect(extension.piUpdates).toHaveLength(1)
    extension.updateFailure = undefined
    kit.pi.nextReload = new Error('session was stopped')
    await kit.pi.command('delta-plugin-update')
    expect(notices(kit).at(-1)).toContain('session was stopped')
    expect(notices(kit).at(-1)).toContain('not active in this session yet')
    expect(kit.pi.reloads).toBe(0)
    // The installation is not claimed any more: a retry reloads what is installed.
    await kit.pi.command('delta-plugin-update')
    expect(kit.pi.reloads).toBe(1)
    expect(extension.piUpdates).toHaveLength(2)
  })

  test('an ordinary reload refusal response is not reported as successful activation', async () => {
    const { kit } = await withExtension()
    delta = kit
    await kit.until(() => extensionNotice(kit), 'the notice')
    // pi's terminal refuses a reload while it compacts, with a warning of its own, and returns.
    kit.pi.nextReload = 'refuse'
    await kit.pi.command('delta-plugin-update')
    expect(kit.pi.reloads).toBe(0)
    expect(notices(kit).at(-1)).toContain('not active in this session yet')
    expect(extensionNotice(kit)).toBe('Delta extension 0.2.0 is installed · /delta-plugin-update to reload')
  })

  test('concurrent explicit requests install once, and a directory transition suppresses the old reload', async () => {
    let release!: () => void
    const { kit, extension } = await withExtension({}, (extension) => {
      extension.holdUpdate = new Promise<void>((resolve) => (release = resolve))
    })
    delta = kit
    const updating = kit.pi.command('delta', 'plugin-update')
    await kit.until(() => extension.piUpdates.length === 1, 'pi update')
    await kit.pi.command('delta', 'plugin-update')
    expect(notices(kit).at(-1)).toContain('already in progress')
    await kit.pi.newSessionIn(kit.world.base)
    release()
    await updating
    await passes(kit, 0)
    expect(extension.piUpdates).toHaveLength(1)
    expect(kit.pi.reloads).toBe(0)
  })
})
