import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

test('marks recorded live Claude messages and tool activity', async () => {
  delta = await startDelta({ policy: { mode: 'private', organization: 'org-1' } })
  const { pi } = delta
  await delta.until(() => delta!.commands().some((args) => args.includes('watch')), 'the thread watch to start')
  pi.model = (messages) =>
    messages.at(-1)?.role === 'toolResult'
      ? { text: 'Changed.' }
      : {
          thinking: 'inspect',
          text: 'I will edit it.',
          calls: [{ name: 'write', arguments: { path: 'a.txt', content: 'new\n' } }],
        }
  await pi.prompt('change it')
  const live = await delta.until(() => {
    const records: any[] = delta!.thread()?.records ?? []
    return (
      records.some((record) => record.update._meta?.delta?.activity_kind === 'edit') &&
      records.filter((record) =>
        ['user_message', 'agent_message', 'agent_thought', 'tool_call_update'].includes(record.update.sessionUpdate),
      )
    )
  }, 'the edit to reach Delta')
  const origin = { work_origin: 'external_agent', interaction_surface: 'cli' }
  expect(live.map((record: any) => [record.update.sessionUpdate, record.update._meta])).toEqual([
    ['user_message', { delta: { ...origin, activity_kind: 'user_message' } }],
    [
      'agent_thought',
      {
        pi: { block: { type: 'thinking', thinking: 'inspect', thinkingSignature: 'signature' } },
        delta: { ...origin, activity_kind: 'agent_thought' },
      },
    ],
    ['agent_message', { delta: { ...origin, activity_kind: 'agent_message' } }],
    ['tool_call_update', { delta: { ...origin, activity_kind: 'tool_call' } }],
    ['tool_call_update', { delta: { ...origin, activity_kind: 'edit' } }],
    ['agent_message', { delta: { ...origin, activity_kind: 'agent_message' } }],
  ])
  const calls = live.filter((record: any) => record.update.sessionUpdate === 'tool_call_update')
  expect(new Set(calls.map((record: any) => record.update.toolCallId)).size).toBe(1)
})

test("two writes to one file in a reply record the second's change against the first's", async () => {
  delta = await startDelta({ policy: { mode: 'private', organization: 'org-1' } })
  const { pi } = delta
  await delta.until(() => delta!.commands().some((args) => args.includes('watch')), 'the thread watch to start')
  // pi prepares both calls before running either, and runs writes to one file in order.
  expect(pi.toolExecution).toBe('parallel')
  pi.model = (messages) =>
    messages.at(-1)?.role === 'toolResult'
      ? { text: 'Written twice.' }
      : {
          calls: [
            { name: 'write', arguments: { path: 'twice.txt', content: 'one\n' } },
            { name: 'write', arguments: { path: 'twice.txt', content: 'two\n' } },
            { name: 'write', arguments: { path: 'twice.txt', content: 'three\n' } },
          ],
        }
  await pi.prompt('write it three times')
  const diffs = await delta.until(() => {
    const records: any[] = delta!.thread()?.records ?? []
    const found = records.flatMap((record) => (record.update.content ?? []).filter((item: any) => item.type === 'diff'))
    return found.length === 3 && found
  }, 'the three writes to reach Delta')
  expect(diffs.map((diff: any) => diff.changes[0].operation)).toEqual(['add', 'modify', 'modify'])
  expect(diffs[0].patch.text).toContain('+one\n')
  expect(diffs[1].patch.text).toContain('-one\n+two\n')
  expect(diffs[2].patch.text).toContain('-two\n+three\n')
})

test('a message Delta cannot translate is logged and skipped, and recording goes on', async () => {
  delta = await startDelta({ policy: { mode: 'private', organization: 'org-1' } })
  const { pi } = delta
  await delta.until(() => delta!.commands().some((args) => args.includes('watch')), 'the thread watch to start')
  await pi.prompt('one')
  // A message holding a value JSON cannot write, committed between turns.
  pi.session.entries.push({
    type: 'message',
    id: 'untranslatable',
    parentId: pi.session.entries.at(-1)?.id ?? null,
    timestamp: '',
    message: { role: 'assistant', content: [{ type: 'custom', value: 1n }], stopReason: 'stop', timestamp: 0 },
  })
  await pi.prompt('two')
  const thread = await delta.until(
    () => JSON.stringify(delta!.thread()?.records ?? []).includes('Echo: two') && delta!.thread(),
    'the next turn',
  )
  // As the plugin's session.append hook fails open, the message is left out and logged for debugging.
  expect(thread.records.map((record: any) => record.sequence)).toEqual(
    thread.records.map((_: unknown, index: number) => index + 1),
  )
  const log = readFileSync(join(delta.world.agentDir, 'delta', 'debug.log'), 'utf8')
  expect(log).toContain('Recording a message failed: Do not know how to serialize a BigInt')
  expect(pi.noticeTexts()).toEqual([])
})
