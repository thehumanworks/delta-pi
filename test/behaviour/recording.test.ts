import { afterEach, expect, test } from 'vitest'
import { type Kit, startDelta } from '../kit/index.ts'
import { RECORDED_TURNS } from '../world.ts'

let delta: Kit | undefined
afterEach(async () => {
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
