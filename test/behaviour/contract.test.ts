// The recording contract a session negotiates with its Delta CLI, ported from the upstream plugin's
// engine tests (hooks/register.test.ts: the recording contract) onto the kit.
import { afterEach, expect, test } from 'vitest'
import { type Kit, startDelta } from '../kit/index.ts'
import { appends, binding, delivered, recording, records, seedPending, watches } from './recorded.ts'

let delta: Kit | undefined
afterEach(async () => {
  delta?.expectClean()
  await delta?.stop()
  delta = undefined
})

const NOT_NOW = (dialog: { title: string }) => (dialog.title.includes('Set it up now?') ? 'Not now' : undefined)
const NEWER = 'Update the Delta extension for pi'
const contractChecks = (kit: Kit) => kit.commands().filter((args) => args.join(' ') === 'thread contract').length
/** Where each command ran, in order, from `start`. */
const ranSince = (kit: Kit, start: number) =>
  kit
    .commands()
    .slice(start)
    .map((args) => args.slice(0, 2).join(' '))

test('a CLI that predates thread contract is treated as too old', async () => {
  delta = await startDelta({ answers: [NOT_NOW] })
  await delta.until(() => delta!.pi.dialogs.length === 1, 'the setup offer')
  // A CLI without the subcommand fails as clap does: usage on stderr, nothing on stdout.
  delta.world.answer('thread contract', {
    stderr: "error: unrecognized subcommand 'contract'\n\nUsage: delta thread <COMMAND>\n",
    exitCode: 2,
  })
  await delta.pi.command('delta', 'share')
  await delta.until(
    () =>
      delta!.pi.noticeTexts().some((text) => text.includes('This Delta is too old for this extension. Update Delta')),
    'the refusal',
  )
  expect(delta.thread()).toBeUndefined()
  expect(delta.commands().filter((args) => args[0] === 'thread' && args[1] !== 'contract')).toEqual([])
})

test('a resumed session refuses to participate against an incompatible contract', async () => {
  delta = await recording()
  await delta.pi.prompt('one')
  await delta.until(async () => (await binding(delta!)).pending.length === 0, 'the first turn to be delivered')
  await delta.whileTimePasses(delta.pi.shutdown('quit'))
  const { endedAt, ...saved } = await binding(delta)
  expect(endedAt).toBeDefined()
  const watched = watches(delta)
  const appended = appends(delta)
  // A resumed session checks again; a Delta that now speaks only a newer contract blocks it.
  delta.world.contract(9, 10)
  await delta.pi.start('resume')
  await delta.until(() => delta!.pi.noticeTexts().some((text) => text.includes(NEWER)), 'the refusal')
  await delta.settle()
  expect(await binding(delta)).toEqual(saved)
  expect(watches(delta)).toBe(watched)
  expect(delta.pi.statuses.get('delta')).toContain(NEWER)
  expect(await delta.pi.prompt('blocked')).toBe('handled')
  expect(delta.pi.noticeTexts().at(-1)).toContain(NEWER)
  expect(delta.pi.noticeTexts().at(-1)).toContain('The prompt was not submitted.')
  expect(appends(delta)).toBe(appended)
  expect(await binding(delta)).toEqual(saved)
})

test('an interrupted share negotiates the contract before recovering its outbox', async () => {
  delta = await recording()
  await delta.pi.prompt('one')
  await delta.until(() => delivered(delta!, 'Echo: one'), 'the first turn')
  await delta.whileTimePasses(delta.pi.shutdown('quit'))
  const sequence = (await binding(delta)).next
  // A thread and a queued record, but no committed snapshot: activation recovers the outbox without
  // starting participation, which is where the contract is otherwise read.
  await seedPending(delta, [{ schemaVersion: 1, sequence, update: { sessionUpdate: 'state_update', state: 'idle' } }], {
    snapshot: false,
  })
  // An incompatible CLI is refused before anything is appended.
  delta.world.contract(9, 10)
  let from = delta.commands().length
  await delta.pi.start('resume')
  await delta.until(() => delta!.pi.noticeTexts().some((text) => text.includes(NEWER)), 'the refusal')
  await delta.settle()
  expect(ranSince(delta, from)).toContain('thread contract')
  expect(ranSince(delta, from)).not.toContain('thread append')
  expect(records(delta).some((record) => record.sequence === sequence)).toBe(false)
  await delta.whileTimePasses(delta.pi.shutdown('quit'))
  // Against a compatible CLI, the contract is read before the recovered record is appended, and the
  // record names the producer, since Delta keeps that name.
  delta.world.contract(8, 8)
  from = delta.commands().length
  await delta.pi.start('resume')
  await delta.until(() => records(delta!).some((record) => record.sequence === sequence), 'the recovered record')
  const ran = ranSince(delta, from)
  expect(ran.indexOf('thread contract')).toBeGreaterThanOrEqual(0)
  expect(ran.indexOf('thread contract')).toBeLessThan(ran.indexOf('thread append'))
  expect(records(delta).find((record) => record.sequence === sequence)?.name).toBe('Pi')
  await delta.until(async () => (await binding(delta!)).pending.length === 0, 'the outbox to be acknowledged')
})

test('a contract answer for an ended session is neither remembered nor used once it resumes', async () => {
  delta = await recording()
  await delta.pi.prompt('one')
  await delta.until(() => delivered(delta!, 'Echo: one'), 'the first turn')
  await delta.whileTimePasses(delta.pi.shutdown('quit'))
  const sequence = (await binding(delta)).next
  await seedPending(delta, [{ schemaVersion: 1, sequence, update: { sessionUpdate: 'state_update', state: 'idle' } }], {
    snapshot: false,
  })
  // Recovery asks a CLI too old for this extension, and the session ends and resumes before the
  // answer arrives.
  delta.world.answer('thread contract', { stdout: '{"operation":"contract","min":1,"max":4}\n', exitCode: 0 })
  const answer = delta.world.hold('thread contract')
  const from = delta.commands().length
  await delta.pi.start('resume')
  await delta.until(() => ranSince(delta!, from).includes('thread contract'), 'the contract check')
  await delta.whileTimePasses(delta.pi.shutdown('quit'))
  const checks = contractChecks(delta)
  await delta.pi.start('resume')
  await delta.until(() => contractChecks(delta!) > checks, 'the resumed session to ask again')
  answer()
  await delta.until(() => records(delta!).some((record) => record.sequence === sequence), 'the recovered record')
  await delta.settle()
  // The stale refusal is neither remembered nor shown: the resumed session asked again and appended once.
  expect(contractChecks(delta)).toBe(checks + 1)
  expect(delta.pi.noticeTexts().filter((text) => text.includes('too old'))).toEqual([])
  expect(records(delta).filter((record) => record.sequence === sequence)).toHaveLength(1)
  await delta.until(async () => (await binding(delta!)).pending.length === 0, 'the outbox to be acknowledged')
})
