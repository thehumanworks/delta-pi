import { afterEach, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { Pi, until, world, type World } from './harness.ts'

let current: { pis: Pi[]; world?: World } = { pis: [] }
afterEach(async () => {
  for (const pi of current.pis) await pi.stop()
  current.world?.cleanup()
  current = { pis: [] }
})

const RUN_HERE = (request: Record<string, any>) =>
  String(request.title).includes('wants to run the Delta thread') ? 'Run it here' : undefined

/** A recorded session, and a thread of its conversation a teammate started that shares its worktrees. */
async function conversation() {
  const w = world({ policy: { mode: 'organization', organization: 'org-1' } })
  const pi = Pi.start(w, { answers: [RUN_HERE] })
  current = { pis: [pi], world: w }
  const root = await until(
    () => Object.values(w.delta().threads).find((thread) => !thread.parent && thread.worktrees.length),
    'the session to record',
  )
  await until(() => w.calls().some((call) => call.argv.includes('watch')), 'the thread watch to start')
  const created = w.cli(
    ...['thread', 'create', '--source', 'other', '--external-id', 'teammate', '--parent', root.thread_id],
    ...['--name', 'Release notes', '--shared-worktrees'],
  )
  const thread = { thread_id: created.thread_id as string, reference: created.reference as string }
  w.remote(root.thread_id, {
    type: 'child',
    child: { ...thread, kind: 'subthread', name: 'Release notes', status: 'inactive' },
  })
  const session = (await pi.state()).sessionId as string
  await until(
    async () =>
      (await pi.messages()).some(
        (message) => typeof message.content === 'string' && message.content.includes('"Release notes" (inactive)'),
      ),
    'the threads note',
  )
  return { w, pi, session, thread, producer: `${session}-${thread.thread_id.slice(-12)}` }
}

const records = (w: World, thread: string, producer: string) =>
  (w.delta().threads[thread]?.records ?? []).filter((record: any) => record.producer === producer)

test('a message to a thread of the conversation runs it in a pi of its own, recorded on that thread', async () => {
  const { w, pi, session, thread, producer } = await conversation()
  await pi.prompt('message Release notes: Write the notes', 90_000)
  const recorded = records(w, thread.thread_id, producer)
  expect(recorded.map((record: any) => record.update.sessionUpdate)).toEqual([
    'state_update',
    'user_message',
    'agent_message',
    'state_update',
  ])
  expect(recorded[1].update.content).toEqual([{ type: 'text', text: 'Write the notes' }])
  expect(recorded[1].update._meta.delta.sender).toEqual({ external_id: session })
  expect(recorded[3].update).toMatchObject({ state: 'idle', stopReason: 'end_turn' })
  const result = (await pi.messages()).find((message) => message.role === 'toolResult')
  expect(result?.content[0].text).toBe(
    'The Delta thread "Release notes" finished its turn. Its reply:\n\nEcho: Write the notes',
  )
  // The thread's pi recorded as its own producer.
  expect(
    w.calls().filter((call) => call.argv.includes('append') && call.argv.includes(producer)).length,
  ).toBeGreaterThan(0)
}, 120_000)

test('stopping the turn that runs a thread stops its pi midway, which still records its turn as cancelled', async () => {
  const { w, pi, thread, producer } = await conversation()
  const settled = pi.events.filter((event) => event.type === 'agent_settled').length
  await pi.send({ type: 'prompt', message: 'message Release notes: run sleep 29.137' })
  // The thread's pi is inside its long command, still streaming its run to the session.
  await until(
    () =>
      records(w, thread.thread_id, producer).some((record: any) => record.update.sessionUpdate === 'tool_call_update'),
    'the thread run to be working',
    60_000,
  )
  await pi.send({ type: 'abort' })
  await until(
    () => pi.events.filter((event) => event.type === 'agent_settled').length > settled,
    'pi to settle',
    60_000,
  )
  const last = await until(
    () => records(w, thread.thread_id, producer).find((record: any) => record.update.state === 'idle'),
    "the thread run's end",
    30_000,
  )
  expect(last.update).toMatchObject({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'cancelled' })
  // Its pi stopped the command it ran.
  await until(() => {
    try {
      execFileSync('pgrep', ['-f', 'sleep 29.137'])
      return false
    } catch {
      return true
    }
  }, 'the command to stop')
}, 120_000)
