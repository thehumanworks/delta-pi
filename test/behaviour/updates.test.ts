// Updating the Delta app and CLI, and this extension, ported from the upstream plugin's engine tests
// (hooks/cli/install-update.test.ts, and hooks/register.test.ts: startup and commands, plugin updates)
// onto the kit.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { UPDATE_HELPER_ARGV } from '../fake-delta/cli.ts'
import { type Kit, startDelta } from '../kit/index.ts'
import type { Exit, Output, ProcessStream, RunResult } from '../../src/core/process.ts'

let delta: Kit | undefined
afterEach(async () => {
  delta?.expectClean()
  await delta?.stop()
  delta = undefined
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

for (const command of ['delta'] as const)
  test(`${command} explicitly updates with its telemetry command form`, async () => {
    delta = await started()
    delta.world.release('0.24.0')
    const release = delta.world.hold('update install')
    const before = notices(delta).length
    const updating = delta.pi.command('delta', 'update')
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
    expect(updates(delta)[0]!.env).toEqual({ integration: 'pi', form: 'delta_subcommand' })
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
