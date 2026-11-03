// pi's runs as Delta turns: their start and finish, the turn each record names, and what stops a turn
// that lost the thread, ported from the upstream plugin's engine tests (hooks/register.test.ts: native
// turns) onto the kit. Claude's turn.start and turn.complete are pi's agent_start and agent_settled.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { addRows, type PendingRow, RemoteView } from '../../src/watch/conversation.ts'
import { type Kit, type Reply } from '../kit/index.ts'
import type { FakePi } from '../kit/pi.ts'
import {
  appends,
  binding,
  bindingNow,
  bindingPath,
  finishes,
  recording,
  records,
  restart,
  seedPending,
  staged,
  starts,
} from './recorded.ts'

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string
}

let delta: Kit | undefined
afterEach(async () => {
  delta?.expectClean()
  await delta?.stop()
  delta = undefined
})

const SUPERSEDED =
  "Shared execution was superseded; stopped pi's turn. Tool effects already performed are not rolled back."

/** A model that answers each request with the reply the test gives it, once the request has arrived. */
function heldModel(kit: Kit) {
  const waiting: ((reply: Reply) => void)[] = []
  kit.pi.model = () => new Promise((resolve) => waiting.push(resolve))
  return {
    async reply(reply: Reply) {
      await kit.until(() => waiting.length > 0, 'the model to be asked')
      waiting.shift()!(reply)
    },
    waiting: () => waiting.length,
    /**
     * From now on, answer `reply` once pi's turn has been stopped: pi asks the model again only if the
     * stop has not yet reached it, and then the reply arrives after the stop, as a late one does.
     */
    afterStop(reply: Reply) {
      kit.pi.model = async () => {
        await kit.until(() => kit.pi.aborts > 0, "pi's turn to be stopped")
        return reply
      }
      for (const answer of waiting.splice(0))
        void kit.until(() => kit.pi.aborts > 0, 'the stop').then(() => answer(reply))
    },
  }
}

const thread = (kit: Kit): string => kit.thread()!.thread_id
const notices = (pi: FakePi, text: string) => pi.noticeTexts().filter((notice) => notice === text)
const run = (command: string): Reply => ({ calls: [{ name: 'bash', arguments: { command } }] })

test('a fenced receipt for the running turn aborts exactly that Claude turn with a notice', async () => {
  delta = await recording()
  const { pi } = delta
  const model = heldModel(delta)
  const turn = pi.submit('contested')
  await delta.until(() => starts(delta!).length === 1, 'the turn to start')
  const [sequence] = starts(delta)
  // Delta already superseded this turn, so the next record it sends comes back fenced.
  delta.world.supersede(thread(delta), sequence!)
  await model.reply(run('echo contested'))
  model.afterStop({ text: 'written after the loss' })
  await delta.until(() => pi.aborts > 0, "pi's turn to be stopped")
  expect(notices(pi, SUPERSEDED)).toHaveLength(1)
  await delta.until(async () => !(await binding(delta!)).execution, 'the execution to end')
  // The stop writes the turn's finish once, however the run then ends.
  await delta.whileTimePasses(turn)
  await delta.until(() => finishes(delta!).includes(sequence!), "the turn's finish")
  expect(pi.aborts).toBe(1)
  expect(finishes(delta).filter((finish) => finish === sequence)).toHaveLength(1)
  expect(notices(pi, SUPERSEDED)).toHaveLength(1)
})

test('a watch supersession and a fenced receipt for the same turn abort it once', async () => {
  delta = await recording()
  const { pi } = delta
  const model = heldModel(delta)
  const turn = pi.submit('contested')
  await delta.until(() => starts(delta!).length === 1, 'the turn to start')
  const [sequence] = starts(delta)
  // Both signals name the same turn: the watcher's supersession and the outbox's fence.
  delta.world.supersede(thread(delta), sequence!)
  delta.world.remote(thread(delta), { type: 'producer.turn', sequence, status: 'superseded' })
  await model.reply(run('echo contested'))
  model.afterStop({ text: 'late' })
  await delta.until(() => pi.aborts > 0, "pi's turn to be stopped")
  await delta.until(() => finishes(delta!).includes(sequence!), "the turn's finish")
  await delta.whileTimePasses(turn)
  await delta.settle()
  expect(pi.aborts).toBe(1)
  expect(notices(pi, SUPERSEDED)).toHaveLength(1)
  expect(finishes(delta).filter((finish) => finish === sequence)).toHaveLength(1)
})

test('ownership loss aborts exactly the bound native turn and fences its later output', async () => {
  delta = await recording()
  const { pi } = delta
  const model = heldModel(delta)
  const turn = pi.submit('long task')
  await model.reply(run('echo before loss'))
  await delta.until(() => starts(delta!).length === 1 && model.waiting(), 'the turn to run its command')
  const [sequence] = starts(delta)
  // A stale event for another turn is not this turn's loss. A teammate arriving after it shows the
  // watch has read it.
  delta.world.remote(
    thread(delta),
    { type: 'producer.turn', sequence: sequence! + 100, status: 'superseded' },
    { type: 'presence', users: [{ user_id: 'user-ada', name: 'Ada' }] },
  )
  await delta.until(
    async () => (await delta!.advance(1_000), pi.statuses.get('delta')?.includes('Ada')),
    'the watch to read the stale event',
  )
  expect(pi.aborts).toBe(0)
  delta.world.supersede(thread(delta), sequence!)
  delta.world.remote(thread(delta), { type: 'producer.turn', sequence, status: 'superseded' })
  await delta.until(() => pi.aborts > 0, "pi's turn to be stopped")
  // The reply the model was writing arrives after the loss; it keeps the lost turn, which Delta fences.
  model.afterStop({ text: 'written after loss' })
  await delta.whileTimePasses(turn)
  await delta.until(
    () => records(delta!).some((record) => JSON.stringify(record).includes('written after loss')),
    'the late output',
  )
  await delta.settle()
  expect(pi.aborts).toBe(1)
  // The thread's title, recorded once the turn ended, belongs to no turn.
  const later = records(delta).filter(
    (record) => record.sequence > sequence! && record.update.sessionUpdate !== 'session_info_update',
  )
  expect(later.length).toBeGreaterThan(0)
  for (const record of later) expect(record.turnSequence).toBe(sequence)
  expect(records(delta).filter((record) => record.update.sessionUpdate === 'user_message')).toHaveLength(1)
})

test("a fenced receipt for an earlier turn's late output leaves the running turn alone", async () => {
  delta = await recording()
  const { pi } = delta
  const model = heldModel(delta)
  const first = pi.submit('first')
  await delta.until(() => starts(delta!).length === 1 && model.waiting(), 'the first turn to run')
  const [earlier] = starts(delta)
  // Delivery is held, so what the first turn records after it lost the thread is still queued when the
  // next turn starts.
  const release = delta.world.hold('thread append')
  delta.world.supersede(thread(delta), earlier!)
  delta.world.remote(thread(delta), { type: 'producer.turn', sequence: earlier, status: 'superseded' })
  await delta.until(() => pi.aborts > 0, 'the first turn to be stopped')
  await model.reply({ text: 'slow-tool output' })
  await delta.whileTimePasses(first)
  const second = pi.submit('second')
  await delta.until(() => model.waiting(), 'the second turn to run')
  const saved = await binding(delta)
  const later = saved.execution.sequence
  expect(later).toBeGreaterThan(earlier!)
  // The late output keeps the earlier turn's sequence, so its fence must not touch the running one.
  release()
  await delta.until(() => starts(delta!).includes(later), "the second turn's start")
  await delta.settle()
  const late = records(delta).filter((record) => JSON.stringify(record).includes('slow-tool'))
  expect(late.length).toBeGreaterThan(0)
  expect(late.every((record) => record.turnSequence === earlier && record.disposition === 'fenced')).toBe(true)
  expect(pi.aborts).toBe(1)
  expect((await binding(delta)).execution).toMatchObject({ sequence: later })
  await model.reply({ text: 'second done' })
  await delta.whileTimePasses(second)
  await delta.until(() => finishes(delta!).includes(later), "the second turn's finish")
  expect(pi.aborts).toBe(1)
})

test('a raced busy start is observed independently of snapshots and cancels only its local ID', async () => {
  delta = await recording()
  const { pi } = delta
  const model = heldModel(delta)
  // Catch-up looked idle; another producer takes the thread before this turn's start reaches Delta.
  const sequence = (await binding(delta)).next
  delta.world.supersede(thread(delta), sequence)
  const raced = pi.submit('raced')
  await delta.until(() => pi.aborts > 0, "pi's turn to be stopped")
  await model.reply({ text: 'late' })
  await delta.whileTimePasses(raced)
  await delta.until(() => finishes(delta!).includes(sequence), "the turn's finish")
  expect(starts(delta)).toEqual([sequence])
  expect(records(delta).find((record) => record.sequence === sequence)?.turnSequence).toBe(sequence)
  expect(pi.aborts).toBe(1)
  // A prompt another extension refuses after Delta admitted it starts no turn.
  pi.others.set('input', [async () => ({ action: 'handled' })])
  expect(await pi.prompt('refused below')).toBe('handled')
  await delta.advance(60_000)
  await delta.settle()
  expect(starts(delta)).toEqual([sequence])
  expect(finishes(delta)).toEqual([sequence])
})

test('a failed durable start write aborts its local ID without publishing a partial start', async () => {
  delta = await recording()
  const { pi } = delta
  const before = await binding(delta)
  // The disk refuses every outbox write, so the turn's start cannot be saved.
  delta.disk.fail('write', '/outbox/', { times: Infinity })
  await delta.whileTimePasses(pi.prompt('cannot save'))
  expect(pi.aborts).toBe(1)
  await delta.settle()
  expect(starts(delta)).toEqual([])
  expect((await binding(delta)).next).toBe(before.next)
  expect(pi.statuses.get('delta-status')).toContain('Delta sharing paused')
})

test('live capture failure cancels the exact local turn even when the store is unavailable', async () => {
  delta = await recording()
  const { pi } = delta
  const model = heldModel(delta)
  const turn = pi.submit('capture')
  await delta.until(() => starts(delta!).length === 1 && model.waiting(), 'the turn to run')
  // From here the store cannot save anything, the capture failure itself included.
  delta.disk.fail('write', '/store/', { times: Infinity })
  await model.reply(run('echo captured'))
  model.afterStop({ text: 'late' })
  await delta.until(() => pi.aborts > 0, "pi's turn to be stopped")
  await delta.whileTimePasses(turn)
  expect(pi.aborts).toBe(1)
  // Capture stays paused, so the next prompt is refused rather than recorded with a gap.
  expect(await pi.prompt('blocked')).toBe('handled')
  expect(pi.noticeTexts().at(-1)).toContain('local conversation capture is paused')
})

test('restart delivers a queued abandoned start and its matching finish without aborting a saved Claude ID', async () => {
  delta = await recording()
  await delta.whileTimePasses(delta.pi.shutdown('quit'))
  const sequence = (await binding(delta)).next
  // An earlier pi process staged a turn's start and ended before delivering it or its finish.
  await seedPending(
    delta,
    [
      {
        schemaVersion: 1,
        sequence,
        turnSequence: sequence,
        update: { sessionUpdate: 'state_update', state: 'running' },
      },
    ],
    { execution: { sequence, turnId: 'old-process-id' } },
  )
  await delta.pi.start('resume')
  await delta.until(() => finishes(delta!).includes(sequence), 'the abandoned turn to finish')
  await delta.until(async () => (await binding(delta!)).pending.length === 0, 'the outbox to be delivered')
  expect(starts(delta)).toEqual([sequence])
  expect(finishes(delta)).toEqual([sequence])
  expect(delta.pi.aborts).toBe(0)
  expect(await binding(delta)).toMatchObject({ next: sequence + 2, pending: [] })
  expect((await binding(delta)).execution).toBeUndefined()
})

/** Recover a paused session as the person would: `/delta share`, keeping who sees it. */
async function share(kit: Kit) {
  kit.pi.answers.push((dialog) => dialog.options?.find((option) => option.startsWith('Keep current sharing')))
  await kit.pi.command('delta', 'share')
}

/** An append receipt for `sequence`, as Delta prints it, with `fields` changed. */
function receipt(kit: Kit, sequence: number, fields: Record<string, unknown> = {}) {
  const value: Record<string, unknown> = {
    operation: 'appended',
    thread_id: thread(kit),
    sequence,
    next_sequence: sequence + 1,
    duplicate: false,
    disposition: 'recorded',
    turn_sequence: sequence,
    version: 'v1',
    ...fields,
  }
  for (const [key, field] of Object.entries(value)) if (field === undefined) delete value[key]
  return `${JSON.stringify(value)}\n`
}

test('a malformed lifecycle receipt leaves its pending start unchanged without blocking entry', async () => {
  delta = await recording()
  const { pi } = delta
  const model = heldModel(delta)
  const sequence = (await binding(delta)).next
  // Delta records the start, but its receipt names no turn; after it, Delta cannot be reached.
  delta.world.answer('thread append', {
    run: true,
    stdout: receipt(delta, sequence, { turn_sequence: undefined }),
    exitCode: 0,
  })
  delta.world.fail('thread append', { after: 1, times: 1000, code: 'disconnected' })
  const turn = pi.submit('no receipt needed')
  await delta.until(() => model.waiting(), 'the turn to run')
  let saved = await binding(delta)
  expect(saved.execution).toMatchObject({ sequence })
  expect(saved.pending[0].sequence).toBe(sequence)
  const file = saved.pending[0].files[0]
  const immutable = readFileSync(file, 'utf8')
  await model.reply({ text: 'done' })
  expect(await delta.whileTimePasses(turn)).toBe('settled')
  expect(readFileSync(file, 'utf8')).toBe(immutable)
  delta.world.stopFailing('thread append')
  await share(delta)
  await delta.until(async () => (await binding(delta!)).pending.length === 0, 'the outbox to be delivered')
  saved = await binding(delta)
  expect(saved.execution).toBeUndefined()
  expect(starts(delta)).toEqual([sequence])
  expect(finishes(delta)).toEqual([sequence])
  expect(pi.aborts).toBe(0)
})

test('a malformed finish receipt and failed durable retry retain the immutable pending finish', async () => {
  delta = await recording()
  const { pi } = delta
  // The session's first turn names its thread; this test's turn comes after it.
  await pi.prompt('named')
  await delta.until(async () => (await binding(delta!)).title && !(await binding(delta!)).pending.length, 'the title')
  const model = heldModel(delta)
  const turn = pi.submit('owned')
  await delta.until(async () => model.waiting() && (await binding(delta!)).pending.length === 0, 'the turn to run')
  const sequence = starts(delta).at(-1)
  const finish = (await binding(delta)).next
  // The finish's receipt is for another operation; nothing else is left to send before it.
  delta.world.answer('thread append', {
    run: true,
    stdout: receipt(delta, finish, { operation: 'turn_ended', turn_sequence: sequence }),
    exitCode: 0,
  })
  await model.reply({})
  await delta.whileTimePasses(turn)
  await delta.until(async () => (await binding(delta!)).pending.length === 1, 'the finish')
  let saved = await binding(delta)
  expect(saved.execution).toBeUndefined()
  expect(saved.pending.map((entry: { sequence: number }) => entry.sequence)).toEqual([finish])
  const file = saved.pending[0].files[0]
  const immutable = readFileSync(file, 'utf8')
  // Saving the retried acknowledgment fails too, across a restart.
  const failing = delta.disk.fail(
    'write',
    (path) => path === bindingPath(delta!) && bindingNow(delta!)?.pending.length === 1,
    {
      times: Infinity,
    },
  )
  await restart(delta)
  await delta.until(() => delta!.pi.noticeTexts().some((text) => text.includes('ENOSPC')), 'the failed save')
  await delta.settle()
  expect(readFileSync(file, 'utf8')).toBe(immutable)
  expect((await binding(delta)).pending).toHaveLength(1)
  failing()
  await share(delta)
  await delta.until(async () => (await binding(delta!)).pending.length === 0, 'the outbox to be delivered')
  saved = await binding(delta)
  expect(saved.execution).toBeUndefined()
  expect(finishes(delta).filter((turn) => turn === sequence)).toHaveLength(1)
  expect(records(delta).find((record) => record.sequence === finish)?.turnSequence).toBe(sequence)
})

test('malformed saved control {"schemaVersion":2} is not translated or discarded', async () => {
  delta = await recording()
  await delta.whileTimePasses(delta.pi.shutdown('quit'))
  const sequence = (await binding(delta)).next
  await seedPending(delta, [{ schemaVersion: 2, sequence, turn: { action: 'claim' } }])
  // A resume clears the end marker, so it is not part of the preserved binding.
  const { endedAt, ...before } = await binding(delta)
  expect(endedAt).toBeDefined()
  const folder = join(delta.world.agentDir, 'delta', 'outbox', delta.pi.session.id)
  const files = () => readdirSync(folder).map((name) => [name, readFileSync(join(folder, name), 'utf8')])
  const kept = files()
  const appended = appends(delta)
  await delta.pi.start('resume')
  await delta.until(() => delta!.pi.statuses.get('delta-status')?.includes('invalid pending record'), 'the pause')
  await delta.settle()
  const { endedAt: _ended, ...after } = await binding(delta)
  expect(after).toEqual(before)
  expect(files()).toEqual(kept)
  expect(records(delta).some((record) => record.sequence >= sequence)).toBe(false)
  expect(appends(delta)).toBe(appended)
})

test('a prompt enters without delivery permission; actual start binds lifecycle before output', async () => {
  delta = await recording()
  const { pi } = delta
  const model = heldModel(delta)
  delta.world.fail('thread append', { times: 1000, code: 'disconnected' })
  const turn = pi.submit('build it')
  await delta.until(() => model.waiting(), 'the turn to run')
  expect(starts(delta)).toEqual([])
  const saved = await binding(delta)
  const { sequence } = saved.execution
  expect(saved.execution.turnId).toEqual(expect.any(String))
  expect((await staged(delta))[0]).toEqual({
    schemaVersion: 1,
    sequence,
    turnSequence: sequence,
    update: { sessionUpdate: 'state_update', state: 'running', _meta: { delta: { producer_version: version } } },
  })
  // Steering uses the local lifecycle even while the start is undelivered.
  expect(await pi.prompt('also test it')).toBe('steered')
  await model.reply({
    calls: [
      { name: 'bash', arguments: { command: 'echo make' } },
      { name: 'bash', arguments: { command: 'echo make test' } },
    ],
  })
  await model.reply({ text: 'built and tested' })
  await delta.whileTimePasses(turn)
  delta.world.stopFailing('thread append')
  await delta.advance(60_000)
  await delta.until(async () => (await binding(delta!)).pending.length === 0, 'the outbox to be delivered')
  const output = records(delta).filter((record) => record.update.sessionUpdate === 'tool_call_update')
  expect(output).toHaveLength(4)
  expect(output.every((record) => record.turnSequence === sequence)).toBe(true)
  const prompts = records(delta).filter((record) => record.update.sessionUpdate === 'user_message')
  expect(prompts.map((record) => record.turnSequence)).toEqual([sequence, sequence])
  expect(finishes(delta)).toEqual([sequence])
  const end = records(delta).find((record) => record.update.state === 'idle')
  expect(end.sequence).toBeGreaterThan(Math.max(...output.map((record) => record.sequence)))
  expect(pi.aborts).toBe(0)
})

test('a completion whose append outlasts the budget returns and leaves delivery to the outbox', async () => {
  delta = await recording()
  const { pi } = delta
  const model = heldModel(delta)
  const first = pi.submit('first')
  await model.reply(run('echo a'))
  await delta.until(
    async () => model.waiting() && (await binding(delta!)).pending.length === 0,
    'the first turn to run',
  )
  const [earlier] = starts(delta)
  // Hold the append as an upload that outlasts the turn's delivery budget.
  const release = delta.world.hold('thread append')
  let returned = false
  void first.then(() => (returned = true))
  await model.reply({ text: 'a done' })
  await delta.until(async () => (await staged(delta!)).some((record) => record.update.state === 'idle'), 'the finish')
  await delta.advance(4_000)
  await delta.settle()
  // The run waits for its finish within the budget before leaving the append to the outbox.
  expect(returned).toBe(false)
  await delta.advance(1_001)
  await delta.until(() => returned, 'the run to settle once the budget is spent')
  // The next turn starts and runs while that delivery is still held: its start and output are
  // recorded and scoped to it, behind the held finish.
  const second = pi.submit('second')
  await model.reply(run('echo b'))
  await model.reply({ text: 'b done' })
  await delta.whileTimePasses(second)
  const pending = await staged(delta)
  const later = pending.find((record) => record.update.state === 'running' && record.sequence > earlier!)
  expect(later.turnSequence).toBe(later.sequence)
  const tapped = pending.filter((record) => JSON.stringify(record).includes('echo b'))
  expect(tapped.length).toBeGreaterThan(0)
  expect(tapped.every((record) => record.turnSequence === later.sequence)).toBe(true)
  expect(pending.some((record) => record.update.state === 'idle' && record.turnSequence === earlier)).toBe(true)
  expect(finishes(delta)).toEqual([])
  release()
  await delta.until(() => finishes(delta!).length === 2, 'the held finishes')
  expect(finishes(delta)).toEqual([earlier, later.sequence])
})

test('an observer loss queued across session end cannot write or abort the restarted execution', async () => {
  delta = await recording()
  const { pi } = delta
  const model = heldModel(delta)
  void pi.submit('owned')
  await delta.until(async () => model.waiting() && (await binding(delta!)).pending.length === 0, 'the turn to run')
  const [sequence] = starts(delta)
  // Hold the loss at its first read of the binding, so it is still queued when the session ends.
  let first = true
  const release = delta.disk.hold('read', (path) => path === bindingPath(delta!) && first && !(first = false))
  delta.world.remote(thread(delta), { type: 'producer.turn', sequence, status: 'superseded' })
  await delta.until(() => !first, 'the loss to read the binding')
  // pi quits without stopping its run; the session resumes before the loss goes on.
  await delta.whileTimePasses(pi.shutdown('quit'))
  const restarting = pi.start('resume')
  release()
  await restarting
  await delta.until(() => finishes(delta!).includes(sequence!), 'the resumed session to close the turn')
  await delta.until(async () => (await binding(delta!)).pending.length === 0, 'the outbox to be delivered')
  await delta.settle()
  expect(pi.aborts).toBe(0)
  expect((await binding(delta)).execution).toBeUndefined()
  expect(finishes(delta)).toEqual(starts(delta))
  expect(pi.noticeTexts()).not.toContain(SUPERSEDED)
})

test('a remote Bash call reaches the receiver once with output (assistant row first)', async () => {
  delta = await recording()
  await delta.pi.prompt('run echo output')
  await delta.until(() => finishes(delta!).length === 1, 'the turn to reach Delta')
  const [sequence] = starts(delta)
  const lifecycle = records(delta).filter((record) => record.update.sessionUpdate === 'tool_call_update')
  expect(lifecycle).toHaveLength(2)
  const id = lifecycle[0].update.toolCallId
  expect(lifecycle.map((record) => [record.update.toolCallId, record.update._meta])).toEqual([
    [id, { delta: { work_origin: 'external_agent', interaction_surface: 'cli', activity_kind: 'tool_call' } }],
    [id, { delta: { work_origin: 'external_agent', interaction_surface: 'cli', activity_kind: 'tool_call' } }],
  ])
  // A teammate's view receives each record as Delta folds it into the call's item.
  const view = new RemoteView(thread(delta), { thread: thread(delta), items: {} })
  view.endSnapshot()
  const rows: PendingRow[] = []
  const sink = {
    append: async (row: PendingRow) => (rows.push(row), {}),
    save: async () => {},
    held: () => false,
    current: () => true,
    announce: () => {},
    debug: () => {},
    fail: (reason: string) => {
      throw new Error(reason)
    },
  }
  for (const [index, record] of lifecycle.entries()) {
    expect(record.turnSequence).toBe(sequence)
    const content = { ...view.items.get(id)?.content, ...record.update }
    view.upsert({
      id,
      kind: 'tool_call',
      after_id: null,
      turn_id: null,
      author: { user_id: 'u', name: 'Ada' },
      created_at: 1,
      open: content.status !== 'completed' && content.status !== 'failed',
      content,
    })
    await addRows(view, sink)
    // The open call is not drawn; its result draws it once, complete.
    expect(rows).toHaveLength(index)
  }
  expect(rows[0]!.text).toContain('tool call echo output')
  expect(rows[0]!.text).toContain('output')
  expect(rows[0]!.text).not.toContain('changed an earlier')
  const item = view.items.get(id)!
  view.upsert({ ...item, content: { ...item.content, rawOutput: 'genuinely edited output' } })
  expect((await view.nextRow())!.text).toContain('changed an earlier tool call echo output')
})
