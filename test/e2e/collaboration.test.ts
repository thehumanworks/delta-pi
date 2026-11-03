import { afterEach, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXTENSION, FAKE_BIN, FAUX_MODEL, Pi, until, world, type World } from './harness.ts'

let current: { pis: Pi[]; world?: World } = { pis: [] }
afterEach(async () => {
  for (const pi of current.pis) await pi.stop()
  current.world?.cleanup()
  current = { pis: [] }
})

const ONBOARDING = (request: Record<string, any>) =>
  String(request.title).includes('Set it up now?') ? 'Not now' : undefined

function onlyThread(w: World) {
  const threads = Object.values(w.delta().threads)
  return threads.length === 1 ? threads[0] : undefined
}

/** Run the fake CLI as another producer would. */
function delta(w: World, ...args: string[]) {
  return JSON.parse(
    execFileSync(join(FAKE_BIN, 'delta'), ['--json', ...args], {
      env: { ...process.env, FAKE_DELTA_STATE: w.state },
    }).toString(),
  )
}

test('/delta-share exports the conversation so far, publishes it, and records live from then on', async () => {
  const w = world()
  const pi = Pi.start(w, { answers: [ONBOARDING] })
  current = { pis: [pi], world: w }
  await until(() => pi.dialogs.length === 1, 'the setup offer')
  await pi.prompt('before sharing')
  expect(w.delta().threads).toEqual({})
  pi.answers.push((request) => {
    expect(request.title).toContain('Who should see this session?')
    expect(request.options).toEqual(['Share with Zed', 'Just me (sync privately)', 'Type something…'])
    return 'Share with Zed'
  })
  await pi.command('/delta-share')
  const shared = await until(() => onlyThread(w)?.url && onlyThread(w), 'the thread to be shared')
  expect(shared.url).toBe(`https://delta.dev/join/share_${shared.thread_id}`)
  await until(() => pi.status()?.includes('✔ Shared'), 'the share to finish')
  expect(pi.status()).toContain(shared.url)
  expect(pi.status()).toContain('Shared with Zed')
  // The share is reported with how it was run, for Delta's telemetry.
  expect(w.calls().find((call) => call.argv.includes('share'))?.env.form).toBe('dedicated_command')
  // The earlier conversation arrives as history, without turns.
  const exported = await until(() => onlyThread(w)?.records.length >= 2 && onlyThread(w).records, 'the snapshot')
  expect(exported[0].update).toMatchObject({
    sessionUpdate: 'user_message',
    content: [{ type: 'text', text: 'before sharing' }],
  })
  expect(exported[0].turnSequence).toBeUndefined()
  expect(exported[1].update).toMatchObject({
    sessionUpdate: 'agent_message',
    content: [{ type: 'text', text: 'Echo: before sharing' }],
  })
  await pi.prompt('after sharing')
  const live = await until(
    () =>
      onlyThread(w).records.some((record: any) => JSON.stringify(record.update).includes('Echo: after sharing')) &&
      onlyThread(w).records,
    'the live turn',
  )
  const prompt = live.find((record: any) => JSON.stringify(record.update.content ?? '').includes('"after sharing"'))
  expect(prompt.turnSequence).toBeGreaterThan(0)

  // A teammate's message reaches the model's context between turns, drawn for the person.
  w.remote(shared.thread_id, {
    type: 'item',
    item: {
      id: 'remote-1',
      kind: 'user_message',
      after_id: null,
      turn_id: null,
      author: { user_id: 'u-ada', name: 'Ada' },
      created_at: 1,
      open: false,
      content: { text: 'Can you also check the tests?' },
    },
  })
  const row = await until(async () => {
    const messages = await pi.messages()
    return messages.find((message: any) => message.role === 'custom' && message.customType === 'delta')
  }, "the teammate's message")
  const message = row
  expect(message.display).toBe(true)
  expect(message.content).toContain('[Delta] Ada, user message (item remote-1):\nCan you also check the tests?')
  expect(message.details).toMatchObject({
    kind: 'message',
    author: 'Ada',
    agent: false,
    markdown: 'Can you also check the tests?',
  })
  // Remote activity is never recorded back into the thread.
  expect(onlyThread(w).records.some((record: any) => JSON.stringify(record).includes('check the tests'))).toBe(false)
}, 90_000)

test("a turn Delta hands to someone else stops pi's turn, and its late output keeps the lost turn", async () => {
  const w = world({ policy: { mode: 'organization', organization: 'org-1' } })
  const pi = Pi.start(w)
  current = { pis: [pi], world: w }
  await until(() => w.calls().some((call) => call.argv.includes('watch')), 'the thread watch to start')
  const settled = pi.events.filter((event) => event.type === 'agent_settled').length
  await pi.send({ type: 'prompt', message: 'run sleep 5' })
  const start = await until(
    () => onlyThread(w)?.records.find((record: any) => record.update.state === 'running'),
    "the turn's start to reach Delta",
  )
  w.remote(onlyThread(w).thread_id, { type: 'producer.turn', sequence: start.sequence, status: 'superseded' })
  const begun = Date.now()
  const ended = await until(
    () => pi.events.filter((event) => event.type === 'agent_settled').slice(settled)[0],
    'pi to stop',
    10_000,
  )
  // pi stopped the five-second command rather than finishing it.
  expect(ended.aborted).toBe(true)
  expect(Date.now() - begun).toBeLessThan(4_000)
  const idle = await until(
    () =>
      onlyThread(w).records.find(
        (record: any) => record.update.state === 'idle' && record.turnSequence === start.sequence,
      ),
    "the lost turn's finish",
  )
  expect(idle.sequence).toBeGreaterThan(start.sequence)
  expect(readFileSync(join(w.agentDir, 'delta', 'debug.log'), 'utf8')).toContain(
    "Shared execution was superseded; stopped pi's turn.",
  )
}, 60_000)

test('/delta-join mounts a shared thread and continues in a pi session in its folder', async () => {
  const w = world()
  // Someone else's thread, with their checkout attached and a message already in it.
  const other = join(w.base, 'other')
  mkdirSync(other, { recursive: true })
  const created = delta(w, 'thread', 'create', '--source', 'claude-code', '--external-id', 'teammate')
  const tree = delta(w, 'worktree', 'create', other)
  delta(w, 'worktree', 'attach', tree.reference, '--thread', created.thread_id)
  const { url } = delta(w, 'thread', 'share', created.thread_id, '--visibility', 'organization')
  w.remote(created.thread_id, {
    type: 'item',
    item: {
      id: 'earlier-1',
      kind: 'agent_message',
      after_id: null,
      turn_id: null,
      author: { user_id: null, name: 'Claude Code' },
      created_at: 1,
      open: false,
      content: { text: 'I fixed the parser.' },
    },
  })
  const pi = Pi.start(w, { answers: [ONBOARDING] })
  current = { pis: [pi], world: w }
  await until(() => pi.dialogs.length === 1, 'the setup offer')
  const before = (await pi.state()).sessionId
  await pi.command(`/delta-join ${url}`)
  const joined = await until(async () => {
    const state = await pi.state()
    return state.sessionId !== before && state
  }, 'pi to switch to the joined session')
  const session = joined.sessionId as string
  const folder = join(w.state, 'mounts', created.thread_id, session)
  expect(readFileSync(joined.sessionFile, 'utf8').split('\n')[0]).toContain(`"cwd":"${folder}"`)
  await until(
    () => w.calls().some((call) => call.argv.includes('watch') && call.argv.includes(session)),
    'the joined watch',
  )
  await pi.command('/delta link')
  await until(() => pi.notices().includes(url), "the joined thread's link")
  // The thread's conversation so far reaches the model's context.
  await until(async () => JSON.stringify(await pi.messages()).includes('I fixed the parser.'), "the thread's history")
  await pi.prompt('hello from the join')
  const thread = await until(() => {
    const found = w.delta().threads[created.thread_id]
    return (
      found.records.some((record: any) => JSON.stringify(record.update).includes('Echo: hello from the join')) && found
    )
  }, "the joined session's turn")
  expect(thread.records.every((record: any) => record.producer === session)).toBe(true)
  // A joined session never republishes or attaches a checkout of its own.
  expect(w.calls().filter((call) => call.argv.includes('attach'))).toHaveLength(1)
  expect(w.calls().some((call) => call.argv.includes('mount') && call.argv.includes('--join'))).toBe(true)
}, 90_000)

test('a pi process a recorded session starts records as a subagent in a child thread', async () => {
  const w = world({ policy: { mode: 'organization', organization: 'org-1' } })
  const pi = Pi.start(w)
  current = { pis: [pi], world: w }
  await until(() => w.calls().some((call) => call.argv.includes('watch')), 'the thread watch to start')
  const parent = (await pi.state()).sessionId as string
  await pi.prompt(
    `run pi --mode json -p --no-session -e ${EXTENSION} -e ${FAUX_MODEL} --provider faux --model faux-1 "inspect the parser" > /dev/null`,
    60_000,
  )
  const child = await until(
    () =>
      Object.values(w.delta().threads).find(
        (thread) => thread.parent && thread.records.some((record: any) => record.update.state === 'idle'),
      ),
    "the subagent's thread",
    30_000,
  )
  expect(child.name).toBe('inspect the parser')
  expect(child.worktrees).toEqual(onlyThreadOf(w).worktrees)
  const prompt = child.records.find((record: any) => record.update.sessionUpdate === 'user_message')
  expect(prompt.update._meta.delta.sender).toEqual({ external_id: parent })
  expect(child.records.some((record: any) => JSON.stringify(record.update).includes('Echo: inspect the parser'))).toBe(
    true,
  )
}, 120_000)

function onlyThreadOf(w: World) {
  return Object.values(w.delta().threads).find((thread) => !thread.parent)
}

test('a subagent working in a Git worktree of its own attaches that checkout to its thread while it runs', async () => {
  const w = world({ policy: { mode: 'organization', organization: 'org-1' } })
  const worktree = join(w.base, 'feature')
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'feature', worktree], { cwd: w.checkout })
  const pi = Pi.start(w)
  current = { pis: [pi], world: w }
  await until(() => w.calls().some((call) => call.argv.includes('watch')), 'the thread watch to start')
  await pi.prompt(
    `run cd ${worktree} && pi --mode json -p --no-session -e ${EXTENSION} -e ${FAUX_MODEL} --provider faux --model faux-1 "work on the feature" > /dev/null`,
    60_000,
  )
  const child = await until(
    () =>
      Object.values(w.delta().threads).find(
        (thread) => thread.parent && thread.records.some((record: any) => record.update.state === 'idle'),
      ),
    "the subagent's thread",
    30_000,
  )
  const own = w
    .delta()
    .worktrees.find((tree: any) => tree.directories.some((entry: any) => entry.directory === worktree))
  expect(child.worktrees).toEqual([own.reference])
  expect(onlyThreadOf(w).worktrees).not.toContain(own.reference)
  // The subagent's session ended with its process, which released the checkout.
  expect(own.directories[0].state).toBe('waiting')
  expect(w.calls().some((call) => call.argv.includes('mount') && call.argv.includes(worktree))).toBe(true)
}, 120_000)

test('/delta-share with addresses invites them, and "Just me" syncs privately to the selected team', async () => {
  const w = world()
  const pi = Pi.start(w, { answers: [ONBOARDING] })
  current = { pis: [pi], world: w }
  await until(() => pi.dialogs.length === 1, 'the setup offer')
  await pi.prompt('for ada')
  await pi.command('/delta-share ada@example.com')
  const invited = await until(() => onlyThread(w)?.invited && onlyThread(w), 'the invitation')
  expect(invited.invited).toEqual(['ada@example.com'])
  await until(
    () =>
      pi
        .notices()
        .some((text) => text.startsWith('Invited ada@example.com to this session. Link: https://delta.dev/join/')),
    "the invitation's notice",
  )
  await until(() => pi.status()?.includes('Invited 1 person'), "the band's outcome")
  await pi.stop()

  // A second session in the same checkout shares with nobody but its owner.
  const second = Pi.start(w, { answers: [] })
  current.pis.push(second)
  await second.prompt('just for me')
  second.answers.push((request) => {
    expect(request.options).toContain('Just me (sync privately)')
    return 'Just me (sync privately)'
  })
  await second.command('/delta-share')
  const session = (await second.state()).sessionId
  const create = await until(
    () =>
      w
        .calls()
        .find(
          (call) => call.argv.includes('create') && call.argv.includes(session) && call.argv.includes('--visibility'),
        ),
    'the private thread',
  )
  expect(create.argv).toEqual(expect.arrayContaining(['--organization', 'org-1', '--visibility', 'private']))
  await until(
    () => second.status()?.includes('Synced privately') || second.status()?.includes('Synced with Zed'),
    'the private sync',
  )
}, 90_000)
