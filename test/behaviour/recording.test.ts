import { afterEach, expect, test } from 'vitest'
import { type Kit, startDelta } from '../kit/index.ts'
import { RECORDED_TURNS } from '../world.ts'

let delta: Kit | undefined
afterEach(async () => {
  delta?.expectClean()
  await delta?.stop()
  delta = undefined
})

test('a repository that syncs automatically records each turn, its tools and its title', async () => {
  delta = await startDelta({ policy: { mode: 'organization', organization: 'org-1' } })
  const { pi } = delta
  await delta.until(() => delta!.commands().some((args) => args.includes('watch')), 'the thread watch to start')
  await pi.prompt('hello there')
  await pi.prompt('run echo hi')
  const thread = await delta.until(
    () =>
      delta!.thread()?.records.some((record: any) => JSON.stringify(record.update).includes('Done.')) &&
      delta!.thread(),
    "the second turn's reply to reach Delta",
  )
  expect(thread.records.map((record: any) => record.sequence)).toEqual(
    thread.records.map((_: unknown, i: number) => i + 1),
  )
  // The real pi records the same (test/e2e/recording.test.ts).
  expect(thread.records.map((record: any) => record.update.sessionUpdate)).toEqual(RECORDED_TURNS)
  expect(
    thread.records
      .filter((record: any) => record.update.state === 'idle')
      .map((record: any) => record.update.stopReason),
  ).toEqual(['end_turn', 'end_turn'])
  expect(pi.errors).toEqual([])
})

test('a prompt queued while pi is still starting a run is taken into that run', async () => {
  delta = await startDelta({ policy: { mode: 'private', organization: 'org-1' } })
  const { pi } = delta
  await delta.until(() => delta!.commands().some((args) => args.includes('watch')), 'the thread watch to start')
  let start: (() => void) | undefined
  pi.starting = () => new Promise((resolve) => (start = resolve))
  const first = pi.submit('first')
  await delta.until(() => start, 'the run to start')
  expect(await pi.prompt('second')).toBe('steered')
  pi.starting = undefined
  start!()
  await first
  const thread = await delta.until(
    () => delta!.thread()?.records.some((record: any) => record.update.state === 'idle') && delta!.thread(),
    'the run to reach Delta',
  )
  const prompts = thread.records.filter((record: any) => record.update.sessionUpdate === 'user_message')
  expect(prompts.map((record: any) => record.update.content[0].text)).toEqual(['first', 'second'])
  // Both belong to the run's one turn.
  expect(new Set(prompts.map((record: any) => record.turnSequence)).size).toBe(1)
  expect(pi.noticeTexts()).toEqual([])
})
