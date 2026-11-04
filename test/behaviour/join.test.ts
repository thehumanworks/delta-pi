import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { FakeSession, type Kit, startDelta } from '../kit/index.ts'
import { FAKE_BIN, type World } from '../world.ts'
import { itemFingerprint } from '../../src/watch/conversation.ts'

// pi on Windows keeps a `C:\` folder as a new session's directory; on this machine it would resolve the
// folder against the current one, so a session made for a Windows folder names it as Windows does.
vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const pi = await importOriginal<typeof import('@earendil-works/pi-coding-agent')>()
  const create: typeof pi.SessionManager.create = (cwd, sessionDir, options) => {
    const manager = pi.SessionManager.create(cwd, sessionDir, options)
    if (!/^[a-z]:\\/i.test(cwd)) return manager
    const header = manager.getHeader()
    return Object.assign(manager, { getHeader: () => header && { ...header, cwd } })
  }
  return { ...pi, SessionManager: Object.assign(Object.create(pi.SessionManager), { create }) }
})

let delta: Kit | undefined
afterEach(async () => {
  delta?.expectClean()
  await delta?.stop()
  delta = undefined
})

/** The setup offer a repository without a policy makes; these tests decline it. */
const NOT_NOW = (dialog: { title: string }) => (dialog.title.includes('Set it up now?') ? 'Not now' : undefined)

/**
 * A teammate's shared thread, with their checkouts attached: one folder, `other`, unless `worktrees`
 * names several. `teammate` names the producer, so a second thread needs another.
 */
function sharedThread(w: World, { worktrees = ['other'], teammate = 'teammate' } = {}) {
  const created = w.cli('thread', 'create', '--source', 'claude-code', '--external-id', teammate)
  for (const name of worktrees) addWorktree(w, created.thread_id, name, teammate)
  const shared = w.cli('thread', 'share', created.thread_id, '--visibility', 'organization')
  return { thread: created.thread_id as string, url: shared.url as string, share: shared.share_id as string }
}

/** A teammate's checkout `name` attached to `thread`; returns its reference. */
function addWorktree(w: World, thread: string, name: string, teammate = 'teammate'): string {
  const folder = join(w.base, teammate, name)
  mkdirSync(folder, { recursive: true })
  const tree = w.cli('worktree', 'create', folder)
  w.cli('worktree', 'attach', tree.reference, '--thread', thread)
  return tree.reference as string
}

/** The fake CLI's mount folders for `thread`, by owner, with whether each is still mounted. */
function threadMounts(w: World, thread: string): Record<string, string> {
  const folder = join(w.state, 'mounts', thread)
  return Object.fromEntries(
    w
      .delta()
      .worktrees.flatMap((tree) => tree.directories)
      .filter((entry: any) => entry.directory.startsWith(`${folder}/`))
      .map((entry: any) => [entry.directory.slice(folder.length + 1), entry.state]),
  )
}

/** The pi session files a join prepared in the agent directory. */
function preparedSessions(w: World): string[] {
  const root = join(w.agentDir, 'sessions')
  if (!existsSync(root)) return []
  return readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.jsonl'))
}

/** Every saved binding that still describes a join in progress. */
function transitions(w: World): string[] {
  const store = join(w.agentDir, 'delta', 'store')
  if (!existsSync(store)) return []
  return readdirSync(store).filter((name) => readFileSync(join(store, name), 'utf8').includes('joinTransition'))
}

async function joiner() {
  const kit = await startDelta({ answers: [NOT_NOW] })
  await kit.until(() => kit.pi.dialogs.length === 1, 'the setup offer')
  return kit
}

/** How many joins finished in `kit`'s pi, whichever session they finished in. */
const joins = (kit: Kit) => kit.pi.noticeTexts().filter((text) => text.startsWith('Joined the Delta thread')).length
const joined = (kit: Kit) => joins(kit) > 0

test("/delta-join mounts a shared thread and continues in a new session in the thread's folder", async () => {
  delta = await joiner()
  const { url } = sharedThread(delta.world)
  const before = delta.pi.session.id
  await delta.pi.command('delta-join', url)
  expect(delta.pi.session.id).not.toBe(before)
  await delta.until(() => joined(delta!), 'the join to finish')
  expect(transitions(delta.world)).toEqual([])
  expect(delta.pi.errors).toEqual([])
})

test('a switch pi fails before leaving the session unmounts the thread, says why, and leaves nothing behind', async () => {
  delta = await joiner()
  const { url, thread } = sharedThread(delta.world)
  const before = delta.pi.session.id
  delta.pi.nextSwitch = new Error('pi could not open the session')
  await delta.pi.command('delta-join', url)
  expect(delta.pi.session.id).toBe(before)
  expect(delta.pi.noticeTexts()).toContainEqual(expect.stringContaining('pi could not open the session'))
  expect(Object.values(threadMounts(delta.world, thread))).toEqual(['waiting'])
  expect(preparedSessions(delta.world)).toEqual([])
  expect(transitions(delta.world)).toEqual([])
})

test('a switch pi refuses leaves no prepared session or join behind', async () => {
  delta = await joiner()
  const { url, thread } = sharedThread(delta.world)
  delta.pi.nextSwitch = 'cancel'
  await delta.pi.command('delta-join', url)
  expect(Object.values(threadMounts(delta.world, thread))).toEqual(['waiting'])
  expect(preparedSessions(delta.world)).toEqual([])
  expect(transitions(delta.world)).toEqual([])
})

test('a join that could not finish in its new session finishes there when retried', async () => {
  delta = await joiner()
  const { url } = sharedThread(delta.world)
  // The mount the new session makes again fails once.
  delta.world.fail('thread mount', { after: 1 })
  await delta.pi.command('delta-join', url)
  const session = delta.pi.session.id
  await delta.until(
    () => delta!.pi.noticeTexts().some((text) => text.startsWith("Delta couldn't finish joining")),
    'the join to fail in its new session',
  )
  await delta.pi.command('delta-join', url)
  await delta.until(() => joined(delta!), 'the retried join to finish')
  // It finished in the session it had started, with the same owner, rather than starting another.
  expect(delta.pi.session.id).toBe(session)
  expect(preparedSessions(delta.world)).toHaveLength(1)
})

test('a joined session that ends while its mount starts leaves the thread unmounted', async () => {
  delta = await joiner()
  const { url, thread } = sharedThread(delta.world)
  const release = delta.world.hold('thread mount', { after: 1 })
  await delta.pi.command('delta-join', url)
  await delta.until(
    () => delta!.commands().filter((args) => args[0] === 'thread' && args[1] === 'mount').length === 2,
    'the new session to mount the thread',
  )
  await delta.whileTimePasses(delta.pi.newSessionIn())
  release()
  await delta.until(() => Object.keys(threadMounts(delta!.world, thread)).length, 'the late mount to start')
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(Object.values(threadMounts(delta.world, thread))).not.toContain('mounted')
})

test('a join that another session switch interrupts leaves nothing mounted or prepared, and does not switch', async () => {
  delta = await joiner()
  const { url, thread } = sharedThread(delta.world)
  const release = delta.world.hold('thread mount')
  const joining = delta.pi.command('delta-join', url)
  await delta.until(() => delta!.commands().some((args) => args[0] === 'thread' && args[1] === 'mount'), 'the mount')
  // The person starts a new session before the join's mount is ready.
  await delta.whileTimePasses(delta.pi.newSessionIn())
  const session = delta.pi.session.id
  release()
  await joining
  await delta.until(() => Object.keys(threadMounts(delta!.world, thread)).length, 'the late mount')
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(delta.pi.session.id).toBe(session)
  expect(Object.values(threadMounts(delta.world, thread))).not.toContain('mounted')
  expect(preparedSessions(delta.world)).toEqual([])
  expect(transitions(delta.world)).toEqual([])
})

/** The band's text, as a client without pi's terminal sees it. */
const band = (kit: Kit) => kit.pi.statuses.get('delta') ?? ''
/** Every note and notice shown, as one text. */
const shown = (kit: Kit) => kit.pi.noticeTexts().join('\n')
/** The delta commands `kit` ran that start with `words`. */
const ran = (kit: Kit, words: string) => kit.commands().filter((args) => args.join(' ').startsWith(words))
/** The binding the store holds for `session`. */
const bindingOf = (kit: Kit, session: string) => kit.store.get(`session:${session}`) as Promise<any>

/** A model whose reply waits until `release`, so a test can act while pi's turn runs. */
function heldModel(kit: Kit) {
  let release!: () => void
  const replied = new Promise<void>((resolve) => (release = resolve))
  let asked = false
  kit.pi.model = async () => {
    asked = true
    await replied
    return { text: 'Done.' }
  }
  return { release, asked: () => asked }
}

test('an incompatible recording contract refuses join before any transition, mount, or clear', async () => {
  delta = await joiner()
  const { url } = sharedThread(delta.world)
  delta.world.contract(0, 0)
  const before = delta.pi.session.id
  await delta.pi.command('delta-join', url)
  expect(shown(delta)).toContain('Update Delta')
  expect(delta.pi.session.id).toBe(before)
  expect(ran(delta, 'thread mount')).toEqual([])
  expect(ran(delta, 'thread watch')).toEqual([])
  expect(await bindingOf(delta, before)).toBeUndefined()
  expect(preparedSessions(delta.world)).toEqual([])
})

for (const [locator, title] of [
  [
    { code: 'invalid_reference' },
    'an invalid join locator (invalid_reference) suggests the share link, not the same locator',
  ],
  [
    { code: 'invalid_reference', reason: 'invalid_worktree_reference' },
    'an invalid join locator (invalid_worktree_reference) suggests the share link, not the same locator',
  ],
] as const)
  test(title, async () => {
    delta = await joiner()
    sharedThread(delta.world)
    const address = 'unsupported-thread-address'
    delta.world.answer('thread status', {
      stdout: `${JSON.stringify({ error: { ...locator, message: 'unsupported locator', retryable: false } })}\n`,
    })
    const before = delta.pi.session.id
    await delta.pi.command('delta-join', address)
    expect(shown(delta)).toContain("Use the thread's share link with /delta-join")
    expect(shown(delta)).not.toContain(`Retry /delta-join ${address}`)
    expect(delta.pi.session.id).toBe(before)
    expect(ran(delta, 'thread mount')).toEqual([])
    expect(preparedSessions(delta.world)).toEqual([])
  })

test('a join waits out a Delta daemon that is still connecting', async () => {
  delta = await joiner()
  const { url, thread } = sharedThread(delta.world)
  const before = delta.pi.session.id
  delta.world.fail('thread status', { code: 'failed', retryable: true })
  const joining = delta.pi.command('delta-join', url)
  await delta.until(() => band(delta!).includes('Waiting for Delta to connect'), 'the join to wait for Delta')
  expect(delta.pi.session.id).toBe(before)
  expect(ran(delta, 'thread mount')).toEqual([])
  await delta.advance(2_000)
  await joining
  expect(delta.pi.session.id).not.toBe(before)
  await delta.until(() => joined(delta!), 'the join to finish')
  expect(await bindingOf(delta, delta.pi.session.id)).toMatchObject({ thread, joined: true })
})

test('a join stops waiting for Delta after its retry budget and leaves the session as it was', async () => {
  delta = await joiner()
  const { url } = sharedThread(delta.world)
  const before = delta.pi.session.id
  delta.world.fail('thread status', { code: 'failed', retryable: true, times: 100 })
  const reads = () => ran(delta!, 'thread status').length
  const joining = delta.pi.command('delta-join', url)
  for (const [attempt, wait] of [2_000, 4_000, 8_000, 16_000].entries()) {
    await delta.until(() => reads() === attempt + 1, `status read ${attempt + 1}`)
    await delta.settle()
    await delta.advance(wait)
  }
  await joining
  // Waiting 30 more seconds would pass the 30-second budget, so the fifth answer is the last.
  expect(reads()).toBe(5)
  expect(shown(delta)).toContain('failed as the test asked. This session and folder were preserved.')
  expect(delta.pi.session.id).toBe(before)
  expect(ran(delta, 'thread mount')).toEqual([])
  expect(preparedSessions(delta.world)).toEqual([])
  // The join is over, so it no longer holds prompts.
  expect(await delta.pi.prompt('after the join')).toBe('settled')
})

test('busy and pending transitions refuse prompts and repeated join commands', async () => {
  delta = await joiner()
  const { url } = sharedThread(delta.world)
  const before = delta.pi.session.id
  // A join asked for while pi's turn runs is refused before it does anything.
  const model = heldModel(delta)
  const busy = delta.pi.submit('busy')
  await delta.until(model.asked, 'the turn to start')
  await delta.pi.command('delta-join', url)
  expect(shown(delta)).toContain('Wait for the current pi turn to finish before joining.')
  expect(ran(delta, 'thread')).toEqual([])
  model.release()
  await busy
  // While a join is under way, another join and a prompt are refused, and nothing reaches the model.
  delta.pi.model = () => {
    throw new Error('no prompt may reach the model while the join runs')
  }
  const release = delta.world.hold('thread status')
  const joining = delta.pi.command('delta-join', url)
  await delta.until(() => ran(delta!, 'thread status').length, 'the join to read the thread')
  await delta.pi.command('delta-join', url)
  expect(shown(delta)).toContain('A Delta join is already in progress. Wait for its result.')
  expect(await delta.pi.prompt('no execution')).toBe('handled')
  expect(shown(delta)).toContain(
    'Delta is joining a shared thread. Wait for the join result before submitting a prompt.',
  )
  release()
  await joining
  expect(delta.pi.session.id).not.toBe(before)
  await delta.until(() => joined(delta!), 'the join to finish')
  expect(ran(delta, 'thread mount').filter((args) => args.includes('--join'))).toHaveLength(1)
})

test('a session replacement during preflight capability inspection cannot mount or change the replacement cwd', async () => {
  delta = await joiner()
  const { url } = sharedThread(delta.world)
  // pi has no command list to inspect; the preflight's last step before anything changes is the thread's status.
  const release = delta.world.hold('thread status')
  const joining = delta.pi.command('delta-join', url)
  await delta.until(() => ran(delta!, 'thread status').length, 'the preflight to read the thread')
  await delta.whileTimePasses(delta.pi.newSessionIn())
  const replacement = delta.pi.session
  release()
  await joining
  await delta.settle()
  expect(delta.pi.session).toBe(replacement)
  expect(delta.pi.session.cwd).toBe(delta.world.checkout)
  expect(ran(delta, 'thread mount')).toEqual([])
  expect(ran(delta, 'thread watch')).toEqual([])
  expect(await bindingOf(delta, replacement.id)).toBeUndefined()
  expect(preparedSessions(delta.world)).toEqual([])
  expect(transitions(delta.world)).toEqual([])
  expect(delta.pi.contextMessages()).toEqual([])
})

test('terminal: a refused clear surfaces partial progress without enabling participation in the old cwd', async () => {
  delta = await joiner()
  const { url, thread } = sharedThread(delta.world)
  const before = delta.pi.session.id
  // pi's counterpart of a refused /clear: it refuses to switch to the session the join prepared.
  delta.pi.nextSwitch = 'cancel'
  await delta.pi.command('delta-join', url)
  expect(shown(delta)).toContain("Delta join failed: pi did not switch to the thread's session.")
  expect(band(delta)).toContain("pi did not switch to the thread's session")
  expect(delta.pi.session.id).toBe(before)
  expect(delta.pi.session.cwd).toBe(delta.world.checkout)
  expect(await bindingOf(delta, before)).toBeUndefined()
  expect(ran(delta, 'thread watch')).toEqual([])
  expect(Object.values(threadMounts(delta.world, thread))).toEqual(['waiting'])
  expect(preparedSessions(delta.world)).toEqual([])
  // The session that stayed is as it was: a prompt runs, and nothing records it.
  expect(await delta.pi.prompt('not shared')).toBe('settled')
  expect(delta.world.delta().threads[thread].records).toEqual([])
})

/** A pi that joined a teammate's shared thread and finished joining in the session it switched to. */
async function joinedThread(options: Parameters<typeof sharedThread>[1] = {}) {
  const kit = await joiner()
  const shared = sharedThread(kit.world, options)
  const before = kit.pi.session.id
  await kit.pi.command('delta-join', shared.url)
  await kit.until(() => joined(kit), 'the join to finish')
  return { kit, ...shared, before, session: kit.pi.session.id }
}

/** The records `thread` holds in the fake Delta. */
const recordsOf = (kit: Kit, thread: string): any[] => kit.world.delta().threads[thread]?.records ?? []
/** The turn starts and ends among `records`, by the turn they belong to. */
const turnStates = (records: any[], state: 'running' | 'idle') =>
  records
    .filter((record) => record.update.sessionUpdate === 'state_update' && record.update.state === state)
    .map((record) => record.turnSequence)
/** Whether a write is the store's write of `session`'s binding. */
const bindingWrite = (session: string) => (path: string) =>
  path.includes('store') && path.includes(`session_${session}`)

test('malformed watch output surfaces failure and reconnects', async () => {
  const { kit, thread } = await joinedThread()
  delta = kit
  kit.world.remoteRaw(thread, '{"type":"item","item":{"id":""}}\n')
  await kit.until(() => shown(kit).includes('Connection interrupted'), 'the watch to fail')
  expect(await kit.pi.prompt('invalid')).toBe('handled')
  expect(shown(kit)).toContain('The Delta watcher is not ready: Connection interrupted')
  // The bad line was a one-off: the watch Delta starts next reports the thread as it is.
  kit.world.forgetRemote(thread)
  await kit.advance(1_000)
  expect(await kit.pi.prompt('ready after automatic reconnect')).toBe('settled')
  await kit.until(() => JSON.stringify(recordsOf(kit, thread)).includes('ready after automatic reconnect'), 'the turn')
})

test('queued lifecycle survives disconnect and reconnect without replaying a prompt', async () => {
  const { kit, thread, session } = await joinedThread()
  delta = kit
  kit.world.fail('thread append', { times: 1_000, code: 'app_unavailable', retryable: true })
  const model = heldModel(kit)
  let asked = 0
  const reply = kit.pi.model
  kit.pi.model = (messages) => (asked++, reply(messages))
  const turn = kit.pi.submit('offline')
  await kit.until(model.asked, 'the turn to start')
  kit.world.endWatch(thread)
  await kit.until(() => shown(kit).includes("stopped pi's turn"), 'the drop to stop the turn')
  expect(kit.pi.aborts).toBe(1)
  model.release()
  await kit.whileTimePasses(turn)
  // The turn's start and its end are saved, once each, before anything reaches Delta.
  const pending = (await bindingOf(kit, session)).pending as { files: string[] }[]
  const queued = pending.map((entry) => JSON.parse(entry.files.map((file) => readFileSync(file, 'utf8')).join('')))
  expect(turnStates(queued, 'running')).toHaveLength(1)
  expect(turnStates(queued, 'idle')).toEqual(turnStates(queued, 'running'))
  kit.world.stopFailing('thread append')
  await kit.advance(60_000)
  await kit.until(async () => !(await bindingOf(kit, session)).pending.length, 'the queue to drain')
  const records = recordsOf(kit, thread)
  expect(turnStates(records, 'running')).toHaveLength(1)
  expect(turnStates(records, 'idle')).toEqual(turnStates(records, 'running'))
  expect(records.filter((record) => record.update.sessionUpdate === 'user_message')).toHaveLength(1)
  // Reconnecting replayed nothing to the model.
  expect(asked).toBe(1)
  expect(kit.pi.messages().filter((message) => message.role === 'user')).toHaveLength(1)
})

test('a prompt while a dropped watch is torn down is refused, then accepted once it reconnects', async () => {
  const { kit, thread, session } = await joinedThread()
  delta = kit
  const model = heldModel(kit)
  const turn = kit.pi.submit('owned')
  await kit.until(model.asked, 'the turn to start')
  await kit.until(() => JSON.stringify(recordsOf(kit, thread)).includes('owned'), 'the prompt to be recorded')
  await kit.settle()
  // Tearing the drop down marks pi's turn lost before it stops it; holding that write holds the teardown open.
  const release = kit.disk.hold('write', bindingWrite(session))
  const writes = kit.disk.touched('write').length
  kit.world.endWatch(thread)
  await kit.until(() => kit.disk.touched('write').slice(writes).some(bindingWrite(session)), 'the teardown')
  // pi's turn still runs, so the person's prompt steers it; sharing paused at the drop.
  expect(await kit.pi.prompt('during teardown')).toBe('handled')
  expect(shown(kit)).toContain('checkout sharing is paused')
  release()
  await kit.until(() => shown(kit).includes('Connection interrupted'), 'the teardown to finish')
  // The teardown stops pi's running turn, once.
  await kit.until(() => kit.pi.aborts > 0, "pi's turn to be stopped")
  model.release()
  await kit.whileTimePasses(turn)
  await kit.advance(1_000)
  expect(await kit.pi.prompt('after reconnect')).toBe('settled')
  expect(kit.pi.aborts).toBe(1)
  expect(kit.pi.messages().filter((message) => message.role === 'user')).toHaveLength(2)
})

test('a joined delivery refusal lifts only after explicit successful same-thread join verification', async () => {
  const { kit, thread, url, session } = await joinedThread()
  delta = kit
  kit.world.fail('thread append', { code: 'not_visible', retryable: false })
  await kit.pi.prompt('run echo still queued')
  await kit.until(() => shown(kit).includes('Delta sharing paused'), 'the refusal')
  expect(await kit.pi.prompt('cannot run yet')).toBe('handled')
  // The refused turn is held in the outbox, and nothing reached the thread.
  expect(recordsOf(kit, thread)).toEqual([])
  const queued = ((await bindingOf(kit, session)).pending as { files: string[] }[]).map((entry) =>
    JSON.parse(entry.files.map((file) => readFileSync(file, 'utf8')).join('')),
  )
  expect(JSON.stringify(queued)).toContain('still queued')
  // Watching again cannot lift a refusal.
  kit.world.endWatch(thread)
  await kit.until(() => shown(kit).includes('Connection interrupted'), 'the watch to drop')
  const watches = ran(kit, 'thread watch').length
  await kit.advance(1_000)
  await kit.until(() => ran(kit, 'thread watch').length > watches, 'the watch to reconnect')
  expect(await kit.pi.prompt('reconnect cannot authorize')).toBe('handled')
  // Nor can a join whose check finds the thread's access not granted.
  const status = kit.world.cli('thread', 'status', thread, '--source', 'pi', '--external-id', session)
  const localOnly = { ...status, access: { state: 'local_only', is_owner: null } }
  kit.world.answer('thread status', { stdout: `${JSON.stringify(localOnly)}\n`, exitCode: 0 }, { times: 20 })
  await kit.pi.command('delta-join', url)
  expect(await kit.pi.prompt('failed explicit check')).toBe('handled')
  kit.world.stopAnswering('thread status')
  await kit.pi.command('delta-join', url)
  expect(await kit.pi.prompt('authorized after explicit check')).toBe('settled')
  await kit.until(
    () => JSON.stringify(recordsOf(kit, thread)).includes('authorized after explicit check'),
    'the queued records and the new turn',
  )
  const records = recordsOf(kit, thread)
  // The refused turn's records went once each, as they were queued, and then only the authorized turn's;
  // none of the refused prompts did.
  expect(records.map((record) => record.sequence)).toEqual(records.map((_, index) => index + 1))
  expect(records.slice(0, queued.length).map(({ producer, acknowledge, name, ...record }) => record)).toEqual(queued)
  expect(new Set(records.slice(queued.length).map((record) => record.turnSequence)).size).toBe(1)
  for (const refused of ['cannot run yet', 'reconnect cannot authorize', 'failed explicit check'])
    expect(JSON.stringify(records)).not.toContain(refused)
  expect(ran(kit, 'thread create')).toEqual([])
  expect(ran(kit, 'thread share')).toEqual([])
  expect(ran(kit, 'worktree attach')).toEqual([])
})

/** A teammate's finished message in the thread, as `thread watch` reports it. */
function remoteItem(text: string, id = 'remote-1') {
  return {
    type: 'item',
    item: {
      id,
      kind: 'agent_message',
      after_id: null,
      turn_id: 'turn-remote',
      author: { user_id: 'user-ada', name: 'Ada', actor_id: 'actor-ada' },
      created_at: null,
      open: false,
      content: { text },
    },
  }
}

/** Append one record to `thread` as the pi producer `session`, as an earlier process with that ID would have. */
function appendAs(w: World, thread: string, session: string) {
  const record = { schemaVersion: 1, sequence: 1, update: { sessionUpdate: 'state_update', state: 'idle' } }
  execFileSync(
    join(FAKE_BIN, 'delta'),
    ['--json', 'thread', 'append', thread, '--source', 'pi', '--external-id', session],
    {
      input: `${JSON.stringify(record)}\n`,
      env: { ...process.env, FAKE_DELTA_STATE: w.state },
    },
  )
}

test('ending the fresh session during status cannot bind, watch, or add rows to its replacement', async () => {
  delta = await joiner()
  const { url, thread } = sharedThread(delta.world)
  delta.world.remote(thread, remoteItem('Must not enter a replacement session'))
  // The preflight reads the thread's status; the session the join switches into reads it again to check its mounts.
  const release = delta.world.hold('thread status', { after: 1 })
  await delta.pi.command('delta-join', url)
  const fresh = delta.pi.session
  await delta.until(() => ran(delta!, 'thread status').length === 2, 'the fresh session to check its mounts')
  await delta.whileTimePasses(delta.pi.newSessionIn(delta.world.checkout))
  const replacement = delta.pi.session
  release()
  await delta.settle()
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(await bindingOf(delta, fresh.id)).toMatchObject({ snapshot: false, joinTransition: { locator: url, thread } })
  expect(await bindingOf(delta, replacement.id)).toBeUndefined()
  expect(ran(delta, 'thread watch')).toEqual([])
  expect(delta.pi.contextMessages()).toEqual([])
  expect(delta.pi.session).toBe(replacement)
  expect(replacement.cwd).toBe(delta.world.checkout)
  expect(shown(delta)).not.toContain('Joined the Delta thread')
})

test('same-thread recovery interrupted during status preserves the replacement session and its live watcher', async () => {
  const { kit, url, thread, session } = await joinedThread()
  delta = kit
  const file = kit.pi.session.file
  const binding = await bindingOf(kit, session)
  // Recovery reads the thread, mounts again, then checks the mounts with a second read: hold only that one.
  const reads = ran(kit, 'thread status').length
  const release = kit.world.hold('thread status', { after: 1, times: 1 })
  const recovery = kit.pi.command('delta-join', url)
  await kit.until(() => ran(kit, 'thread status').length === reads + 2, 'the recovery to check the mounts')
  // The person leaves and resumes the joined session, which pi starts afresh.
  await kit.whileTimePasses(kit.pi.newSessionIn(kit.world.checkout))
  await kit.whileTimePasses(kit.pi.switchTo(file))
  await kit.until(() => band(kit).includes('Restored 1 worktree'), 'the resumed session to restore its worktrees')
  const watches = ran(kit, 'thread watch').length
  const commands = kit.commands().length
  const rows = kit.pi.contextMessages().length
  release()
  await recovery
  await kit.settle()
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(kit.pi.session.id).toBe(session)
  expect(kit.commands()).toHaveLength(commands)
  expect(ran(kit, 'thread watch')).toHaveLength(watches)
  expect(kit.pi.contextMessages()).toHaveLength(rows)
  expect(await bindingOf(kit, session)).toMatchObject({ thread, joined: true, owner: binding.owner })
  expect(await kit.pi.prompt('replacement remains ready')).toBe('settled')
  expect(ran(kit, 'thread watch')).toHaveLength(watches)
})

test('a nonempty fresh producer and a wrong project root never enable a completed binding', async () => {
  const first = await joiner()
  delta = first
  const { url, thread } = sharedThread(first.world)
  // Delta already holds a record from the producer of the session the join switches into.
  const release = first.world.hold('thread status', { after: 1, times: 1 })
  await first.pi.command('delta-join', url)
  const fresh = first.pi.session
  await first.until(() => ran(first, 'thread status').length === 2, 'the fresh session to check its producer')
  appendAs(first.world, thread, fresh.id)
  release()
  await first.until(() => shown(first).includes("Delta couldn't finish joining"), 'the join to stop')
  expect(shown(first)).toContain('Delta is ahead of this pi outbox')
  expect(await bindingOf(first, fresh.id)).toMatchObject({ snapshot: false, joinTransition: { thread } })
  expect(await first.pi.prompt('no sequence reuse')).toBe('handled')
  // pi resumes that session in the folder it was launched from, as it does when the person continues there.
  await first.crash()
  const second = await startDelta({
    world: first.world,
    session: new FakeSession(fresh.id, first.world.checkout, fresh.file),
  })
  try {
    await second.until(() => shown(second).includes("Delta couldn't finish joining"), 'the resumed join to stop')
    await second.pi.command('delta-join', url)
    expect(shown(second)).toContain(`pi did not start in the thread's folder`)
    expect(await bindingOf(second, fresh.id)).toMatchObject({ snapshot: false, joinTransition: { thread } })
    expect(await second.pi.prompt('wrong directory')).toBe('handled')
    expect(ran(second, 'thread watch')).toEqual([])
    expect(ran(second, 'thread mount')).toEqual([])
    // Only the earlier process's record is in the thread.
    expect(recordsOf(second, thread)).toHaveLength(1)
    second.expectClean()
  } finally {
    await second.stop()
  }
})

test('joining a different canonical thread preserves the previous joined producer', async () => {
  const { kit, session, directory } = await joinedThread().then(async (joined) => ({
    ...joined,
    directory: (await bindingOf(joined.kit, joined.session)).directory as string,
  }))
  delta = kit
  kit.world.fail('thread append', { times: 1_000, code: 'app_unavailable', retryable: true })
  await kit.whileTimePasses(kit.pi.prompt('run echo queued for the first thread'))
  const binding = await bindingOf(kit, session)
  expect(binding.pending.length).toBeGreaterThan(0)
  const second = sharedThread(kit.world, { teammate: 'another-teammate' })
  await kit.whileTimePasses(kit.pi.command('delta-join', second.url))
  await kit.until(() => joins(kit) === 2, 'the second join to finish')
  const fresh = await bindingOf(kit, kit.pi.session.id)
  expect(fresh).toMatchObject({ joined: true, thread: second.thread, next: 1, pending: [] })
  expect(fresh.directory).not.toBe(directory)
  // The first session keeps its producer and the records it has not delivered yet.
  expect(await bindingOf(kit, session)).toMatchObject(binding)
  for (const entry of binding.pending) for (const path of entry.files) expect(existsSync(path)).toBe(true)
  // Joining exports nothing: the second thread holds only what its own teammate recorded.
  expect(recordsOf(kit, second.thread)).toEqual([])
  expect(ran(kit, 'thread create')).toEqual([])
  expect(ran(kit, 'thread share')).toEqual([])
  expect(ran(kit, 'worktree attach')).toEqual([])
  kit.world.stopFailing('thread append')
})

test("another session in a joined thread's mount is refused before it snapshots, creates, or attaches", async () => {
  const { kit, url, session } = await joinedThread()
  delta = kit
  const { directory } = await bindingOf(kit, session)
  // The mounted worktree is a Git checkout, as Delta's are.
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, stdio: 'pipe' })
  git('init', '-q')
  git('remote', 'add', 'origin', 'https://example.com/other.git')
  await kit.whileTimePasses(kit.pi.newSessionIn(directory))
  const unbound = kit.pi.session.id
  const commands = kit.commands().length
  // The session is offered setup, which it declines, and shares with the team.
  const answer = (dialog: { title: string }) => (dialog.title.includes('Who should see') ? 'Share with Zed' : 'Not now')
  kit.pi.answers.push(answer, answer)
  await kit.pi.command('delta', 'share')
  await kit.until(() => shown(kit).includes("Delta didn't share this session"), 'the share to be refused')
  const refusal = kit.pi.noticeTexts().find((text) => text.startsWith("Delta didn't share this session"))!
  expect(refusal).toContain(`/delta-join ${url}`)
  // Retrying the share would be refused again, and the refusal staged nothing.
  expect(refusal).not.toContain('retry /delta-share')
  expect(refusal).not.toContain('saved records')
  const since = kit
    .commands()
    .slice(commands)
    .map((args) => args.slice(0, 2).join(' '))
  expect(since.filter((command) => ['thread create', 'worktree attach', 'thread share'].includes(command))).toEqual([])
  expect(await bindingOf(kit, unbound)).toBeUndefined()
  // A refused share leaves nothing that blocks the session.
  expect(await kit.pi.prompt('still usable')).toBe('settled')
})

test("the switch a join makes ends the previous session without releasing the joined session's mounts", async () => {
  const { kit, thread, session, before } = await joinedThread()
  delta = kit
  // pi ended the session the join started from to switch; the mount it made belongs to the joined session.
  expect(threadMounts(kit.world, thread)).toEqual({ [session]: 'mounted' })
  expect(await bindingOf(kit, session)).toMatchObject({ owner: session, joined: true })
  expect(before).not.toBe(session)
})

/**
 * Prompt `text` once a resumed joined session admits prompts. The band reports the restore just before
 * the session finishes recovering its last turn, while prompts still wait, so a prompt refused only for
 * that is sent again.
 */
async function promptOnceRestored(kit: Kit, text: string) {
  for (;;) {
    const notices = kit.pi.notices.length
    const outcome = await kit.pi.prompt(text)
    const restoring = kit.pi
      .noticeTexts()
      .slice(notices)
      .some((note) => note.includes("Delta is restoring this thread's worktrees"))
    if (outcome !== 'handled' || !restoring) return outcome
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** What the band starts with while a recorded session's watch is live. */
const LIVE = '● Delta · Syncing'
/** Wait until `session`'s outbox has nothing left to deliver. */
const delivered = (kit: Kit, session: string) =>
  kit.until(async () => !(await bindingOf(kit, session)).pending.length, 'the outbox to drain')

test('resume mounts again, moves Claude from its launch directory, and records only new rows', async () => {
  const first = await joiner()
  delta = first
  const { thread, share } = sharedThread(first.world)
  await first.pi.command('delta-join', share)
  await first.until(() => joined(first), 'the join to finish')
  const session = first.pi.session.id
  await first.pi.prompt('before leaving')
  await delivered(first, session)
  const binding = structuredClone(await bindingOf(first, session))
  const recorded = structuredClone(recordsOf(first, thread))
  await first.whileTimePasses(first.pi.shutdown('quit'))
  await first.crash()
  // Exiting released the checkouts.
  expect(Object.values(threadMounts(first.world, thread))).toEqual(['waiting'])
  // pi resumes the session in the thread's folder, which its file names: there is nothing to move.
  const release = first.world.hold('thread mount')
  const second = await startDelta({ world: first.world, session: first.pi.session })
  let third: Kit | undefined
  try {
    // Prompts wait while the worktrees come back, and the band shows the progress.
    await second.until(() => band(second).includes("Restoring the thread's worktrees"), 'the restore to start')
    expect(await second.pi.prompt('too early')).toBe('handled')
    expect(shown(second)).toContain("Delta is restoring this thread's worktrees")
    release()
    await second.until(() => band(second).includes('Restored 1 worktree'), 'the worktrees to be restored')
    expect(second.pi.session.cwd).toBe(binding.directory)
    expect(await bindingOf(second, session)).toEqual(binding)
    expect(ran(second, 'thread mount').length).toBeGreaterThan(0)
    expect(ran(second, 'thread mount').every((args) => !args.includes('--join'))).toBe(true)
    expect(await promptOnceRestored(second, 'run echo new local output')).toBe('settled')
    await delivered(second, session)
    // Only the new turn is recorded: nothing earlier is exported again.
    const records = recordsOf(second, thread)
    expect(records.slice(0, recorded.length)).toEqual(recorded)
    expect(records.slice(recorded.length).some((record) => JSON.stringify(record).includes('new local output'))).toBe(
      true,
    )
    expect(JSON.stringify(records.slice(recorded.length))).not.toContain('before leaving')
    expect(records.map((record) => record.sequence)).toEqual(records.map((_, index) => index + 1))
    await second.pi.command('delta', 'share')
    await second.until(() => shown(second).includes('/delta-join'), 'the share to be refused')
    for (const command of ['thread create', 'worktree attach', 'thread share']) expect(ran(second, command)).toEqual([])
    // Resuming again mounts again, in the same folder.
    await second.whileTimePasses(second.pi.shutdown('quit'))
    await second.crash()
    third = await startDelta({ world: first.world, session: second.pi.session })
    await third.until(() => band(third!).includes('Restored 1 worktree'), 'the worktrees to be restored again')
    expect(ran(third, 'thread mount').every((args) => !args.includes('--join'))).toBe(true)
    expect(Object.values(threadMounts(first.world, thread))).toContain('mounted')
    expect(third.pi.session.cwd).toBe(binding.directory)
    second.expectClean()
    third.expectClean()
  } finally {
    await third?.stop()
    await second.stop()
  }
})

test('terminal: repeated join aliases preserve the existing producer and pending immutable records, then deliver once', async () => {
  const { kit, thread, share, session } = await joinedThread()
  delta = kit
  await kit.pi.prompt('run echo recorded')
  await delivered(kit, session)
  const recorded = structuredClone(recordsOf(kit, thread))
  kit.world.fail('thread append', { times: 1_000, code: 'app_unavailable', retryable: true })
  await kit.whileTimePasses(kit.pi.prompt('run echo queued'))
  const binding = structuredClone(await bindingOf(kit, session))
  const files = binding.pending
    .flatMap((entry: { files: string[] }) => entry.files)
    .map((path: string) => [path, readFileSync(path, 'utf8')] as const)
  expect(binding.pending.length).toBeGreaterThan(0)
  expect(binding.lastTurnSequence).toBeGreaterThan(0)
  // A teammate's message the model has already read.
  const item = remoteItem('Already handed off', 'known')
  const ledger = { thread, items: { known: await itemFingerprint(item.item) } }
  await kit.store.set(`appended:${session}`, ledger)
  kit.world.remote(thread, item)
  kit.world.endWatch(thread)
  await kit.until(() => shown(kit).includes('Connection interrupted'), 'the watch to drop')
  const commands = kit.commands().length
  const rows = kit.pi.contextMessages().length
  // Joining again by the thread's ID reconnects this session as it is, while Delta still cannot be reached.
  await kit.pi.command('delta-join', thread)
  expect(kit.pi.session.id).toBe(session)
  expect(await bindingOf(kit, session)).toEqual(binding)
  for (const [path, content] of files) expect(readFileSync(path, 'utf8')).toBe(content)
  expect(recordsOf(kit, thread)).toEqual(recorded)
  expect(await kit.store.get(`appended:${session}`)).toEqual(ledger)
  expect(kit.pi.contextMessages()).toHaveLength(rows)
  // Recovery checks the sign-in, then only mounts, reads, watches and sends: no transition of its own.
  const recovery = ['auth status', 'thread mount', 'thread status', 'thread watch', 'thread append']
  const since = kit.commands().slice(commands)
  expect(since.map((args) => args.slice(0, 2).join(' ')).filter((command) => !recovery.includes(command))).toEqual([])
  // Joining again by its share ID, with Delta back, delivers what was queued, once.
  kit.world.stopFailing('thread append')
  await kit.pi.command('delta-join', share)
  await delivered(kit, session)
  const recovered = await bindingOf(kit, session)
  expect(recovered).toEqual({ ...binding, pending: [] })
  expect(recovered.lastTurnSequence).toBe(binding.lastTurnSequence)
  const records = recordsOf(kit, thread)
  expect(records.slice(0, recorded.length)).toEqual(recorded)
  expect(records.map((record) => record.sequence)).toEqual(records.map((_, index) => index + 1))
  expect(
    records.filter(
      (record) => record.update.sessionUpdate === 'user_message' && JSON.stringify(record).includes('run echo queued'),
    ),
  ).toHaveLength(1)
  expect(await kit.store.get(`appended:${session}`)).toEqual(ledger)
  expect(kit.pi.contextMessages()).toHaveLength(rows)
  // The reconnected conversation keeps reporting in the band.
  expect(band(kit)).toContain(LIVE)
  for (const command of ['thread create', 'worktree attach', 'thread share']) expect(ran(kit, command)).toEqual([])
})

/** The notes about the thread's worktrees the model was given, in order. */
const worktreeNotes = (kit: Kit) =>
  kit.pi
    .contextMessages()
    .map((message) => String(message.content))
    .filter((text) => text.startsWith("[Delta] This thread's worktrees changed"))
/** Whether the extension has added a note about the thread's worktrees to pi's context, from its debug log. */
const worktreeNoteSent = (kit: Kit) => {
  const log = join(kit.world.agentDir, 'delta', 'debug.log')
  return (
    existsSync(log) &&
    readFileSync(log, 'utf8').includes("Adding a row to pi's context: [Delta] This thread's worktrees changed")
  )
}
/** Where the fake Delta mounts `thread`'s worktrees for `owner`: the first one's checkout, and the folder of several. */
const mountPaths = (w: World, thread: string, owner: string) => ({
  first: join(w.state, 'mounts', thread, owner),
  folder: join(w.state, 'folders', thread, owner),
})
/** Report `thread`'s worktrees on its watch, as Delta does when a teammate attaches or detaches one. */
function reportWorktrees(w: World, thread: string) {
  const state = w.delta()
  const name = (reference: string) => state.worktrees.find((tree: any) => tree.reference === reference)?.name ?? 'repo'
  w.remote(thread, {
    type: 'worktrees',
    worktrees: state.threads[thread].worktrees.map((reference: string) => ({ reference, name: name(reference) })),
  })
}
const mountNames = async (kit: Kit, session: string) =>
  ((await bindingOf(kit, session)).mounts as { name: string }[]).map((mount) => mount.name)

test('a thread with three worktrees is joined in a thread folder and every worktree is checked before a prompt', async () => {
  const { kit, thread, session } = await joinedThread({ worktrees: ['delta', 'zed', 'web'] })
  delta = kit
  const { first, folder } = mountPaths(kit.world, thread, session)
  const binding = await bindingOf(kit, session)
  expect(binding.directory).toBe(folder)
  expect(binding.mounts.map((mount: any) => [mount.name, mount.directory])).toEqual([
    ['delta', first],
    ['zed', `${first}-zed`],
    ['web', `${first}-web`],
  ])
  expect(kit.pi.session.cwd).toBe(folder)
  const mounts = ran(kit, 'thread mount').length
  expect(await kit.pi.prompt('all mounted')).toBe('settled')
  // One worktree that is not mounted blocks the prompt, and both the refusal and the band name it.
  kit.world.markCheckout(`${first}-zed`, false)
  expect(await kit.pi.prompt('zed is not mounted')).toBe('handled')
  const refusal = kit.pi.noticeTexts().at(-1)!
  expect(refusal).toContain('"zed"')
  expect(refusal).not.toContain('"delta"')
  expect(band(kit)).toContain('zed')
  kit.world.markCheckout(`${first}-zed`, true)
  expect(await kit.pi.prompt('mounted again')).toBe('settled')
  expect(band(kit)).not.toContain('zed')
  expect(band(kit)).toContain(LIVE)
  // Checking a worktree reads its state; it does not mount anything again.
  expect(ran(kit, 'thread mount')).toHaveLength(mounts)
  expect(JSON.stringify(recordsOf(kit, thread))).not.toContain('zed is not mounted')
})

test('worktrees added and removed live update the mounts, tell Claude and the person, and move Claude to the thread folder once', async () => {
  const { kit, thread, session, url } = await joinedThread({ worktrees: ['delta'] })
  delta = kit
  const { first: own } = mountPaths(kit.world, thread, session)
  const mounts = () => ran(kit, 'thread mount').length
  const joinMounts = mounts()
  // The thread's list is reported again after a reconnect and changes nothing.
  kit.world.endWatch(thread)
  await kit.until(() => shown(kit).includes('Connection interrupted'), 'the watch to drop')
  const watches = ran(kit, 'thread watch').length
  await kit.advance(1_000)
  await kit.until(() => ran(kit, 'thread watch').length > watches && band(kit).includes(LIVE), 'the watch to reconnect')
  await kit.settle()
  await kit.quiet()
  expect(mounts()).toBe(joinMounts)
  expect(worktreeNotes(kit)).toEqual([])

  // A second worktree: pi stays in the first one's checkout and is told where the other is.
  addWorktree(kit.world, thread, 'zed')
  reportWorktrees(kit.world, thread)
  await kit.until(async () => (await mountNames(kit, session)).length === 2, 'the new worktree to be mounted')
  await kit.until(() => worktreeNotes(kit).length === 1, 'the model to be told')
  expect(mounts()).toBe(joinMounts + 1)
  expect(ran(kit, 'thread mount').map((args) => args.includes('--join'))).toEqual([true, false, false])
  expect(await bindingOf(kit, session)).toMatchObject({
    directory: own,
    mounts: [
      { name: 'delta', directory: own },
      { name: 'zed', directory: `${own}-zed` },
    ],
  })
  expect(worktreeNotes(kit)[0]).toContain(`- zed: ${own}-zed`)
  expect(worktreeNotes(kit)[0]).toContain(`This session's directory is ${own}`)
  // pi keeps one directory per session: instead of moving it, the band says how to open the thread folder.
  expect(kit.pi.session.cwd).toBe(own)
  expect(band(kit)).toContain('Thread worktrees changed: added zed · /delta-join opens the thread folder')
  expect(await kit.pi.prompt('two worktrees')).toBe('settled')

  // Worktrees come and go; the session stays where it is.
  const web = addWorktree(kit.world, thread, 'web')
  reportWorktrees(kit.world, thread)
  await kit.until(async () => (await mountNames(kit, session)).length === 3, 'web to be mounted')
  const zed = (await bindingOf(kit, session)).mounts[1].reference
  kit.world.cli('worktree', 'detach', zed, '--thread', thread)
  reportWorktrees(kit.world, thread)
  await kit.until(async () => (await mountNames(kit, session)).join() === 'delta,web', 'zed to be removed')
  kit.world.cli('worktree', 'detach', web, '--thread', thread)
  reportWorktrees(kit.world, thread)
  await kit.until(async () => (await mountNames(kit, session)).join() === 'delta', 'web to be removed')
  await kit.until(() => worktreeNotes(kit).length === 4, 'the model to be told of each change')
  expect((await bindingOf(kit, session)).directory).toBe(own)
  expect(kit.pi.session.cwd).toBe(own)
  expect(worktreeNotes(kit).at(-1)).toContain('removed web')
  expect(band(kit)).toContain('removed web')
  expect(shown(kit)).not.toContain(`Run /delta-join ${url} to continue in the thread folder`)
  expect(await kit.pi.prompt('back to one')).toBe('settled')
})

test('a worktree added during a turn waits for the turn to end before telling Claude and moving it', async () => {
  const { kit, thread, session } = await joinedThread()
  delta = kit
  const { first: own } = mountPaths(kit.world, thread, session)
  const model = heldModel(kit)
  const turn = kit.pi.submit('running')
  await kit.until(model.asked, 'the turn to start')
  addWorktree(kit.world, thread, 'zed')
  reportWorktrees(kit.world, thread)
  await kit.until(async () => (await mountNames(kit, session)).length === 2, 'the new worktree to be mounted')
  await kit.settle()
  // The note waits for the turn, which it must not interrupt.
  expect(worktreeNoteSent(kit)).toBe(false)
  expect(kit.pi.session.cwd).toBe(own)
  model.release()
  await turn
  await kit.until(() => worktreeNotes(kit).length === 1, 'the model to be told once the turn ended')
  // pi stays in its directory, as it keeps one per session.
  expect(kit.pi.session.cwd).toBe(own)
})

test('Windows mixed separators join and allow subdirectories but not sibling checkouts', async () => {
  // Paths are compared by how they are spelled, whatever the machine: only finding Delta differs on Windows.
  delta = await joiner()
  const { url } = sharedThread(delta.world)
  // Delta mounts under a Windows folder, and reports the checkout with mixed separators.
  const base = String.raw`C:\Workspace\zed\delta\.delta\worktrees\rn4eercbxvfw`
  delta.world.windowsMounts(base)
  await delta.pi.command('delta-join', url)
  await delta.until(() => joined(delta!), 'the join to finish')
  const session = delta.pi.session
  const directory = `${base}\\${session.id}\\other`
  expect(await bindingOf(delta, session.id)).toMatchObject({ joined: true, snapshot: true, directory })
  expect(session.cwd).toBe(directory)
  expect(await delta.pi.prompt('in the checkout')).toBe('settled')
  await delta.whileTimePasses(delta.pi.shutdown('quit'))
  await delta.crash()
  // pi's directory is the session's for its life, so a resume is how pi comes to work in another one.
  const resumeIn = async (cwd: string) => {
    const kit = await startDelta({
      world: delta!.world,
      session: new FakeSession(session.id, cwd, session.file),
    })
    try {
      await kit.until(
        () => band(kit).includes('Restored 1 worktree') || shown(kit).includes("couldn't restore"),
        'the restore',
      )
      const outcome = await promptOnceRestored(kit, `from ${cwd}`)
      kit.expectClean()
      return { outcome, shown: shown(kit) }
    } finally {
      await kit.stop()
    }
  }
  const inside = await resumeIn(`${directory}\\src`)
  expect(inside.outcome, inside.shown).toBe('settled')
  const outside = await resumeIn(`${directory}-other`)
  expect(outside.outcome).toBe('handled')
  expect(outside.shown).toContain(`pi is working in ${directory}-other, outside this session's folder ${directory}`)
})

test('the session a join switches into is not told it is unrecorded while its mount runs', async () => {
  delta = await joiner()
  const { url, thread } = sharedThread(delta.world)
  // Delta's mounts are Git checkouts of the teammate's repository.
  const mounts = join(delta.world.state, 'mounts', thread)
  delta.programs.set('git', (argv, init) =>
    String(init.cwd ?? '').startsWith(mounts) && argv.includes('--show-toplevel')
      ? { stdout: `${init.cwd}\n`, stderr: '', exitCode: 0, isStdoutTruncated: false, isStderrTruncated: false }
      : undefined,
  )
  const dialogs = delta.pi.dialogs.length
  const release = delta.world.hold('thread mount', { after: 1 })
  await delta.pi.command('delta-join', url)
  await delta.until(() => ran(delta!, 'thread mount').length === 2, 'the joined session to mount the thread')
  await delta.settle()
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(band(delta)).not.toMatch(/Not set up|Not syncing/)
  expect(delta.pi.dialogs.slice(dialogs)).toEqual([])
  release()
  await delta.until(() => joined(delta!), 'the join to finish')
  expect(band(delta)).not.toMatch(/Not set up|Not syncing/)
  expect(delta.pi.dialogs.slice(dialogs)).toEqual([])
})

test('terminal: a refused cd surfaces partial progress without enabling participation in the old cwd', async () => {
  const first = await joiner()
  delta = first
  const { url, thread } = sharedThread(first.world)
  const before = first.pi.session.id
  // pi's counterpart of a refused /cd: it opens the join's session where pi already is, as its terminal
  // does when the session's folder is missing and the person continues there.
  first.pi.nextSwitch = { cwd: first.world.checkout }
  await first.pi.command('delta-join', url)
  await first.until(() => shown(first).includes("Delta couldn't finish joining"), 'the join to stop')
  const fresh = first.pi.session
  expect(fresh.id).not.toBe(before)
  expect(fresh.cwd).toBe(first.world.checkout)
  expect(ran(first, 'thread watch')).toEqual([])
  const saved = await bindingOf(first, fresh.id)
  expect(saved).toMatchObject({ snapshot: false, joinTransition: { locator: url }, next: 1, pending: [] })
  const { directory } = saved.joinTransition
  expect(await first.pi.prompt('do not run here')).toBe('handled')
  // Sharing it instead is refused, runs nothing, and points back to the join.
  // The startup's background check for a Delta update may land at any time; it is not the share's.
  const sharing = () => first.commands().filter((args) => args[0] !== 'update')
  const commands = sharing().length
  await first.pi.command('delta', 'share')
  await first.until(() => shown(first).includes('This session joined an already shared thread'), 'the share refusal')
  expect(shown(first)).toContain(`/delta-join ${url}`)
  expect(sharing()).toHaveLength(commands)
  expect(await bindingOf(first, fresh.id)).toEqual(saved)
  expect(recordsOf(first, thread)).toEqual([])
  await first.whileTimePasses(first.pi.shutdown('quit'))
  await first.crash()
  // Started again where it is, the session stays blocked, says where it has to run, and keeps its join.
  const resume = (cwd: string) =>
    startDelta({ world: first.world, session: new FakeSession(fresh.id, cwd, fresh.file) })
  const second = await resume(first.world.checkout)
  try {
    await second.until(() => shown(second).includes("Delta couldn't finish joining"), 'the join to stop again')
    expect(shown(second)).toContain(directory)
    expect(await second.pi.prompt('still blocked after restart')).toBe('handled')
    await second.pi.command('delta-join', 'another-link')
    expect(shown(second)).toContain(`This session is joining ${url}; retry /delta-join with that link`)
    expect(await bindingOf(second, fresh.id)).toEqual(saved)
    second.expectClean()
  } finally {
    await second.stop()
  }
  // Opened in the thread's folder, it finishes the join it was started for, under the same owner.
  const third = await resume(directory)
  try {
    await third.until(() => joined(third), 'the join to finish in the folder')
    expect(await bindingOf(third, fresh.id)).toMatchObject({
      snapshot: true,
      joined: true,
      owner: saved.joinTransition.owner,
    })
    expect([...ran(first, 'thread mount'), ...ran(third, 'thread mount')]).toHaveLength(2)
    expect(await third.pi.prompt('in the folder')).toBe('settled')
    third.expectClean()
  } finally {
    await third.stop()
  }
})
