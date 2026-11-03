import { afterEach, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { RECORDED_TURNS } from '../world.ts'
import { EXTENSION, FAUX_MODEL, PI, Pi, REDACTOR, until, world, type World } from './harness.ts'

let current: { pi?: Pi; world?: World } = {}
afterEach(async () => {
  await current.pi?.stop()
  current.world?.cleanup()
  current = {}
})

test('a repository that syncs automatically records each turn, its tools and its title', async () => {
  const w = world({ policy: { mode: 'organization', organization: 'org-1' } })
  const pi = Pi.start(w)
  current = { pi, world: w }
  // Activation creates the thread, attaches and mounts the checkout, and starts watching.
  await until(() => w.calls().some((call) => call.argv.includes('watch')), 'the thread watch to start')
  const session = (await pi.state()).sessionId as string
  await pi.prompt('hello there')
  await pi.prompt('run echo hi')
  const thread = await until(() => {
    const found = Object.values(w.delta().threads)[0]
    return (
      found?.records.some(
        (record: any) =>
          record.update.sessionUpdate === 'agent_message' && JSON.stringify(record.update).includes('Done.'),
      ) && found
    )
  }, "the second turn's reply to reach Delta")
  const updates = thread.records.map((record: any) => record.update)
  // The kit's fake pi records the same (test/behaviour/recording.test.ts), which keeps it honest.
  expect(updates.map((update: any) => update.sessionUpdate)).toEqual(RECORDED_TURNS)
  expect(thread.records.every((record: any) => record.producer === session && record.name === 'Pi')).toBe(true)
  // Sequences are consecutive from 1, and each turn opens with its running start.
  expect(thread.records.map((record: any) => record.sequence)).toEqual(
    thread.records.map((_: unknown, index: number) => index + 1),
  )
  const starts = thread.records.filter((record: any) => record.update.state === 'running')
  expect(starts).toHaveLength(2)
  for (const start of starts) expect(start.turnSequence).toBe(start.sequence)
  const prompt = thread.records.find((record: any) => record.update.sessionUpdate === 'user_message')
  expect(prompt.update.content).toEqual([{ type: 'text', text: 'hello there' }])
  expect(prompt.turnSequence).toBe(starts[0].sequence)
  expect(prompt.update._meta.delta).toMatchObject({ work_origin: 'external_agent', activity_kind: 'user_message' })
  expect(updates).toContainEqual(
    expect.objectContaining({ sessionUpdate: 'session_info_update', title: 'hello there' }),
  )
  const call = updates.find(
    (update: any) => update.sessionUpdate === 'tool_call_update' && update.status === 'in_progress',
  )
  expect(call).toMatchObject({ name: 'bash', title: 'echo hi', kind: 'execute', rawInput: { command: 'echo hi' } })
  const result = updates.find(
    (update: any) => update.sessionUpdate === 'tool_call_update' && update.status === 'completed',
  )
  expect(result.toolCallId).toBe(call.toolCallId)
  expect(JSON.stringify(result.content)).toContain('hi')
  const idles = thread.records.filter((record: any) => record.update.state === 'idle')
  expect(idles.map((record: any) => record.update.stopReason)).toEqual(['end_turn', 'end_turn'])
  // The checkout is attached to the thread and synchronized while pi runs.
  expect(thread.worktrees).toHaveLength(1)
  expect(w.delta().worktrees[0].directories[0]).toMatchObject({ directory: w.checkout, state: 'mounted' })
  expect(w.calls().every((call) => call.env.integration === 'pi')).toBe(true)
  await pi.stop()
  // Ending the session stops the checkout's mount, which Delta then stops syncing.
  await until(() => w.delta().worktrees[0].directories[0].state === 'waiting', 'the mount to stop')
}, 60_000)

test('a write is recorded as a diff with its patch', async () => {
  const w = world({ policy: { mode: 'private', organization: 'org-1' } })
  const pi = Pi.start(w)
  current = { pi, world: w }
  await until(() => w.calls().some((call) => call.argv.includes('watch')), 'the thread watch to start')
  await pi.prompt('write notes.txt first line')
  await pi.prompt('write notes.txt second line')
  // pi's tools drop a leading @ from a path, so this write replaces the same file.
  await pi.prompt('write @notes.txt third line')
  const thread = await until(() => {
    const found = Object.values(w.delta().threads)[0]
    return (
      found?.records.filter(
        (record: any) =>
          Array.isArray(record.update.content) && record.update.content.some((item: any) => item.type === 'diff'),
      ).length === 3 && found
    )
  }, 'every write to reach Delta')
  const diffs = thread.records.flatMap((record: any) =>
    Array.isArray(record.update.content) ? record.update.content.filter((item: any) => item.type === 'diff') : [],
  )
  expect(diffs[0].changes).toEqual([{ operation: 'add', path: `${w.checkout}/notes.txt` }])
  expect(diffs[0].patch.text).toContain('new file mode 100644\n--- /dev/null\n+++ b/notes.txt\n')
  expect(diffs[0].patch.text).toContain('+first line')
  expect(diffs[1].changes).toEqual([{ operation: 'modify', path: `${w.checkout}/notes.txt` }])
  expect(diffs[1].patch.text).toContain('--- a/notes.txt\n+++ b/notes.txt\n')
  expect(diffs[1].patch.text).toContain('-first line')
  expect(diffs[1].patch.text).toContain('+second line')
  expect(diffs[2].changes).toEqual([{ operation: 'modify', path: `${w.checkout}/notes.txt` }])
  expect(diffs[2].patch.text).toContain('-second line')
  expect(diffs[2].patch.text).toContain('+third line')
}, 60_000)

test("Delta records what the session keeps: a later extension's redaction, and the shell commands the person ran", async () => {
  const w = world({ policy: { mode: 'private', organization: 'org-1' } })
  const pi = Pi.start(w, { args: ['-e', REDACTOR] })
  current = { pi, world: w }
  await until(() => w.calls().some((call) => call.argv.includes('watch')), 'the thread watch to start')
  await pi.prompt('my password is hunter2')
  const shell = await pi.send({ type: 'bash', command: 'echo from the shell' })
  expect(shell.success).toBe(true)
  await pi.prompt('thanks [cut]')
  const thread = await until(() => {
    const found = Object.values(w.delta().threads)[0]
    return found?.records.some((record: any) => JSON.stringify(record.update).includes('Echo: thanks')) && found
  }, 'the second turn to reach Delta')
  // The extension cut the second reply at its length limit after Delta saw it; the finish says what pi kept.
  const finishes = thread.records.filter((record: any) => record.update.state === 'idle')
  expect(finishes.map((record: any) => record.update.stopReason)).toEqual(['end_turn', undefined])
  const recorded = JSON.stringify(thread.records)
  expect(recorded).not.toContain('hunter2')
  const prompts = thread.records.filter((record: any) => record.update.sessionUpdate === 'user_message')
  expect(prompts.map((record: any) => record.update.content[0].text)).toEqual([
    'my password is [redacted]',
    'Ran `echo from the shell`\n\n```\nfrom the shell\n```',
    'thanks [cut]',
  ])
}, 60_000)

test('a new session records into a thread of its own, and resuming the first carries on its thread', async () => {
  const w = world({ policy: { mode: 'organization', organization: 'org-1' } })
  const pi = Pi.start(w)
  current = { pi, world: w }
  await until(() => w.calls().some((call) => call.argv.includes('watch')), 'the thread watch to start')
  const first = await pi.state()
  await pi.prompt('first session')
  await until(
    () => Object.values(w.delta().threads)[0]?.records.some((record: any) => record.update.state === 'idle'),
    'the first turn',
  )
  await pi.send({ type: 'new_session' })
  // The new session is new, so the repository's policy records it into a thread of its own.
  await until(() => Object.keys(w.delta().threads).length === 2, "the second session's thread")
  await until(() => w.delta().worktrees[0].directories[0].state === 'mounted', "the second session's mount")
  await pi.prompt('second session')
  await pi.send({ type: 'switch_session', sessionPath: first.sessionFile })
  expect((await pi.state()).sessionId).toBe(first.sessionId)
  // Resuming restores the checkout's mount and the watch, and carries on the thread's sequence.
  await until(() => w.calls().filter((call) => call.argv.includes('mount')).length === 3, 'the restored mount')
  await pi.prompt('first again')
  const [one, two] = await until(() => {
    const threads = Object.values(w.delta().threads)
    return (
      threads[0]?.records.some((record: any) => JSON.stringify(record.update).includes('Echo: first again')) && threads
    )
  }, 'the resumed turn')
  expect(one.records.map((record: any) => record.sequence)).toEqual(
    one.records.map((_: unknown, index: number) => index + 1),
  )
  expect(one.records.every((record: any) => record.producer === first.sessionId)).toBe(true)
  expect(JSON.stringify(two.records)).toContain('Echo: second session')
  expect(JSON.stringify(one.records)).not.toContain('Echo: second session')
}, 90_000)

test("a prompt steered into a running turn is recorded in it, and teammates' rows wait for the turn to end", async () => {
  const w = world({ policy: { mode: 'organization', organization: 'org-1' } })
  const pi = Pi.start(w)
  current = { pi, world: w }
  await until(() => w.calls().some((call) => call.argv.includes('watch')), 'the thread watch to start')
  const settled = pi.events.filter((event) => event.type === 'agent_settled').length
  await pi.send({ type: 'prompt', message: 'run sleep 2' })
  const thread = () => Object.values(w.delta().threads)[0]
  const start = await until(
    () => thread()?.records.find((record: any) => record.update.state === 'running'),
    'the turn to start',
  )
  await pi.send({ type: 'prompt', message: 'also this', streamingBehavior: 'steer' })
  w.remote(thread().thread_id, {
    type: 'item',
    item: {
      id: 'mid-turn',
      kind: 'user_message',
      after_id: null,
      turn_id: null,
      author: { user_id: 'u-ada', name: 'Ada' },
      created_at: 1,
      open: false,
      content: { text: 'Mid-turn note' },
    },
  })
  await until(
    () => pi.events.filter((event) => event.type === 'agent_settled').length > settled,
    'the turn to end',
    20_000,
  )
  const records = await until(
    () => thread().records.some((record: any) => record.update.state === 'idle') && thread().records,
    "the turn's finish",
  )
  const steered = records.find((record: any) => JSON.stringify(record.update.content ?? '').includes('"also this"'))
  expect(steered.turnSequence).toBe(start.sequence)
  // The teammate's row reached the model only after the turn: it is after every message of the turn.
  const messages = await until(async () => {
    const all = await pi.messages()
    return all.some((message: any) => message.customType === 'delta') && all
  }, 'the held row')
  const row = messages.findIndex((message: any) => message.customType === 'delta')
  const lastOfTurn = messages.findLastIndex((message: any) => message.role === 'assistant')
  expect(row).toBeGreaterThan(lastOfTurn)
}, 60_000)

test('a print-mode run in a repository that syncs automatically is recorded before pi exits', async () => {
  const w = world({ policy: { mode: 'private', organization: 'org-1' } })
  current = { world: w }
  const output = execFileSync(
    PI,
    ['-p', '-e', EXTENSION, '-e', FAUX_MODEL, '--provider', 'faux', '--model', 'faux-1', 'one shot'],
    { cwd: w.checkout, env: w.env(), timeout: 60_000 },
  ).toString()
  expect(output).toContain('Echo: one shot')
  const thread = Object.values(w.delta().threads)[0]
  expect(thread.records.map((record: any) => record.update.sessionUpdate)).toEqual([
    'state_update',
    'user_message',
    'agent_message',
    'state_update',
    'session_info_update',
  ])
  // Nobody could sign in or answer setup, and the checkout's mount ended with pi.
  expect(w.calls().some((call) => call.argv.includes('login'))).toBe(false)
  expect(w.delta().worktrees[0].directories[0].state).toBe('waiting')
}, 60_000)
