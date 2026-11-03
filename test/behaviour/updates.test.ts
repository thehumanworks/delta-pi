// Updating the Delta app and CLI, and this extension, ported from the upstream plugin's engine tests
// (hooks/cli/install-update.test.ts, and hooks/register.test.ts: startup and commands, plugin updates)
// onto the kit.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { UPDATE_HELPER_ARGV } from '../fake-delta/cli.ts'
import { type Kit, startDelta } from '../kit/index.ts'

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
