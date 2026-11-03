// /delta org and /delta-org, ported from the upstream plugin's engine tests
// (hooks/setup/organization.test.ts) onto the kit. Upstream's headless surface is pi's print and JSON modes.
import { afterEach, expect, test } from 'vitest'
import { answering, deltaAt, notes, opened, SELECTED, SETUP_OFFER } from '../kit/accounts.ts'
import { type Kit, startDelta } from '../kit/index.ts'

let delta: Kit | undefined
afterEach(async () => {
  delta?.expectClean()
  await delta?.stop()
  delta = undefined
})

const orgRuns = (kit: Kit) => kit.runs().filter((run) => run.argv[1] === 'org' || run.argv[2] === 'org')

test('organization commands return CLI output on a headless host using the selected executable', async () => {
  for (const mode of ['print', 'json'] as const) {
    delta = await startDelta({ mode, start: false })
    deltaAt(delta)
    await delta.pi.start()
    for (const [args, stdout] of [
      ['org list', '* org_one\tFirst team\n  org_two\tSecond team\n'],
      ['org current', 'org_one\tFirst team\n'],
      ['org switch org_two', 'org_two\tSecond team\n'],
      ['org invite ada@example.com, bo@example.com', 'Invited ada@example.com and bo@example.com\n'],
    ] as const) {
      delta.world.answer(args.split(' ').slice(0, 2).join(' '), { stdout, exitCode: 0 })
      await delta.pi.command('delta', args)
      expect(delta.stderr.at(-1)).toBe(`${stdout.trim()}\n`)
    }
    expect(orgRuns(delta).map((run) => run.argv)).toEqual([
      [SELECTED, 'org', 'list'],
      [SELECTED, 'org', 'current'],
      [SELECTED, 'org', 'switch', '--', 'org_two'],
      [SELECTED, 'org', 'invite', '--', 'ada@example.com', 'bo@example.com'],
    ])
    expect(delta.thread()).toBeUndefined()
    expect(delta.commands().some((args) => args[0] === 'auth')).toBe(false)
    delta.expectClean()
    await delta.stop()
    delta = undefined
  }
})

test('invalid organization syntax and CLI failures are returned without sharing', async () => {
  delta = await startDelta({ start: false })
  const { pi, world } = delta
  deltaAt(delta)
  pi.respond = answering({ [SETUP_OFFER]: 'Not now' })
  await pi.start()
  for (const args of ['org switch', 'org switch one two', 'org current extra', 'org create team']) {
    await pi.command('delta', args)
    expect(notes(delta).at(-1)).toContain('/delta org switch <ID>')
  }
  // An invite with no address runs nothing and says how to name one.
  await pi.command('delta', 'org invite nobody')
  const usage = notes(delta).at(-1)
  expect(usage).toContain('/delta-org invite <email>')
  expect(usage).toContain('https://dashboard.zed.dev')
  expect(orgRuns(delta)).toEqual([])
  world.answer('org switch', { stderr: 'organization is not a membership', exitCode: 1 })
  await pi.command('delta', 'org switch --help')
  expect(notes(delta).at(-1)).toBe('Delta team command failed: organization is not a membership')
  expect(orgRuns(delta).map((run) => run.argv)).toEqual([[SELECTED, 'org', 'switch', '--', '--help']])
  // Output past what a run captures is cut, and a cut selection is never shown as the answer.
  world.answer('org current', { stdout: `org_two\tSecond team\n${' '.repeat(4 * 1024 * 1024)}`, exitCode: 0 })
  await pi.command('delta', 'org current')
  expect(notes(delta).at(-1)).toBe(
    'Delta team command failed: Delta team output was truncated; check the selection with /delta-org current.',
  )
  expect(delta.thread()).toBeUndefined()
  expect(delta.commands().some((args) => args[0] === 'thread' && args[1] !== 'contract')).toBe(false)
})

test('bare /delta-org opens the selected team on the dashboard, and a headless session gets its link', async () => {
  delta = await startDelta({ start: false })
  const { pi, world } = delta
  world.organizations([
    { id: 'org-1', name: 'Zed', current: false },
    { id: 'org-2', name: 'Acme', current: true },
  ])
  pi.respond = answering({
    [SETUP_OFFER]: 'Not now',
    'What would you like to do with your team?': 'Manage team in browser',
  })
  await pi.start()
  await pi.command('delta-org', '')
  expect(notes(delta).at(-1)).toBe(
    "Opened Acme's members page in your browser: https://dashboard.zed.dev/org-2/members",
  )
  expect(opened(delta)).toEqual(['https://dashboard.zed.dev/org-2/members'])
  // Listing teams waits as long as any other Delta command.
  const lists = orgRuns(delta).filter((run) => run.argv.includes('list'))
  expect(lists.length).toBeGreaterThan(0)
  expect(lists.every((run) => run.timeoutMs === 120_000)).toBe(true)

  // A session with no dialogs, on the same machine, gets the link instead.
  const headless = await startDelta({ mode: 'print', world })
  await headless.pi.command('delta-org', 'manage')
  expect(headless.stderr.at(-1)).toBe("Manage Acme's members here: https://dashboard.zed.dev/org-2/members\n")
  expect(opened(headless)).toEqual([])
  expect(orgRuns(headless).every((run) => run.timeoutMs === 120_000)).toBe(true)
  headless.expectClean()
  await headless.stop()
})
