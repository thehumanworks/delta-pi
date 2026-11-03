// The kit's own fault points work as the behaviour tests rely on them: a CLI answer replaced or lost, a
// watch ended, a file write failed or held, and another program stood in for.
import { afterEach, expect, test } from 'vitest'
import { type Kit, startDelta } from '../kit/index.ts'

let delta: Kit | undefined
afterEach(async () => {
  await delta?.stop()
  delta = undefined
})

const PRIVATE = { mode: 'private', organization: 'org-1' }
const watches = (kit: Kit) => kit.commands().filter((args) => args[0] === 'thread' && args[1] === 'watch').length

test('a lost answer leaves the work done in the fake Delta, and the extension sees only the answer', async () => {
  delta = await startDelta({ start: false, policy: PRIVATE })
  const lost = { error: { code: 'app_unavailable', message: 'the connection dropped', retryable: true } }
  delta.world.answer('thread create', { run: true, stdout: `${JSON.stringify(lost)}\n` })
  await delta.pi.start()
  await delta.until(() => delta!.thread(), 'the thread the lost answer created')
  await delta.until(
    () => delta!.pi.noticeTexts().some((text) => text.includes('the connection dropped')),
    'the failure the extension saw',
  )
})

test('an ended watch is started again', async () => {
  delta = await startDelta({ policy: PRIVATE })
  await delta.until(() => watches(delta!) === 1, 'the first watch')
  delta.world.endWatch(delta.thread()!.thread_id)
  await delta.until(async () => (await delta!.advance(5_000), watches(delta!) >= 2), 'the watch to restart')
})

test('a held write waits, and a failed one throws', async () => {
  delta = await startDelta({ start: false, policy: PRIVATE })
  const release = delta.disk.hold('write', 'outbox')
  const fail = delta.disk.fail('write', 'never-written')
  await delta.pi.start()
  void delta.pi.submit('hello')
  await delta.until(() => delta!.disk.touched('write').some((path) => path.includes('outbox')), 'an outbox write')
  expect(delta.thread()?.records ?? []).toEqual([])
  release()
  fail()
  await delta.until(() => delta!.thread()?.records.length, 'the held records to be delivered')
})

test('a program the test stands in for answers instead of the real one', async () => {
  delta = await startDelta()
  delta.programs.set('git', (argv) =>
    argv.includes('--version')
      ? { stdout: 'git version 0.0.0\n', stderr: '', exitCode: 0, isStdoutTruncated: false, isStderrTruncated: false }
      : undefined,
  )
  const { kitProcesses } = await import('../kit/processes.ts')
  const processes = kitProcesses(() => delta!.env, delta.programs)
  expect((await processes.run(['git', '--version'])).stdout).toBe('git version 0.0.0\n')
  expect(
    (await processes.run(['git', 'rev-parse', '--is-inside-work-tree'], { cwd: delta.world.checkout })).stdout,
  ).toBe('true\n')
})
