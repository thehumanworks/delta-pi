import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { type Kit, startDelta } from '../kit/index.ts'

const kits: Kit[] = []
afterEach(async () => {
  // Children first: they share their parent's world, which the parent's stop removes.
  for (const kit of kits) kit.expectClean()
  for (const kit of kits.reverse()) await kit.stop()
  kits.length = 0
})

/** A recorded session in a repository that syncs automatically, once it tells what it starts where its thread is. */
async function parent() {
  const kit = await startDelta({ policy: { mode: 'organization', organization: 'org-1' } })
  kits.push(kit)
  await kit.until(() => kit.env.DELTA_PI_PARENT?.includes('"thread"'), 'the parent to export its thread')
  return kit
}

/** A pi the parent's session starts, in `cwd`, with the environment it inherits. */
async function child(of: Kit, options: { cwd?: string; env?: Record<string, string> } = {}) {
  const kit = await startDelta({
    world: of.world,
    cwd: options.cwd ?? of.world.checkout,
    env: { DELTA_PI_PARENT: of.env.DELTA_PI_PARENT!, ...options.env },
  })
  kits.push(kit)
  return kit
}

/** The child thread the fake CLI holds, once it has a record matching `done`. */
function childThread(kit: Kit, done: (record: any) => boolean = () => true) {
  return Object.values(kit.world.delta().threads).find((thread) => thread.parent && thread.records.some(done))
}

const idle = (record: any) => record.update.state === 'idle'

/** A Git worktree of the checkout, on a branch of its own, at `path`. */
function worktree(kit: Kit, path: string) {
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'feature', path], { cwd: kit.world.checkout })
  return path
}

/** Where the fake CLI has `directory` mounted, if anywhere. */
function mountState(kit: Kit, directory: string) {
  return kit.world
    .delta()
    .worktrees.flatMap((tree) => tree.directories)
    .find((entry: any) => entry.directory === directory)?.state
}

test("a subagent in its parent's checkout records into a child thread that shares the parent's worktrees", async () => {
  const root = await parent()
  const sub = await child(root, { cwd: join(root.world.checkout) })
  await sub.pi.prompt('inspect the parser')
  const thread = await sub.until(() => childThread(sub, idle), "the subagent's finished turn")
  expect(thread.name).toBe('inspect the parser')
  expect(thread.worktrees).toEqual(root.thread()?.worktrees)
  const prompt = thread.records.find((record: any) => record.update.sessionUpdate === 'user_message')
  expect(prompt.update._meta.delta.sender).toEqual({ external_id: root.pi.session.id })
  expect(sub.commands().filter((args) => args[0] === 'worktree')).toEqual([])
  expect(sub.pi.errors).toEqual([])
})

test("a subagent in a Git worktree nested in its parent's checkout attaches that worktree, not the parent's", async () => {
  const root = await parent()
  const nested = worktree(root, join(root.world.checkout, '.worktrees', 'feature'))
  const sub = await child(root, { cwd: nested })
  await sub.pi.prompt('work on the feature')
  const thread = await sub.until(() => childThread(sub, idle), "the subagent's finished turn")
  const create = sub.commands().find((args) => args[0] === 'thread' && args[1] === 'create')
  expect(create).not.toContain('--shared-worktrees')
  expect(thread.worktrees).toHaveLength(1)
  expect(thread.worktrees).not.toEqual(root.thread()?.worktrees)
  expect(mountState(sub, nested)).toBe('mounted')
})

test("a subagent's checkout that failed to attach is attached and mounted with its next delivery", async () => {
  const root = await parent()
  const nested = worktree(root, join(root.world.checkout, '.worktrees', 'feature'))
  const sub = await child(root, { cwd: nested })
  root.world.fail('worktree list')
  await sub.pi.prompt('work on the feature')
  // A later delivery, or the retry after its backoff, attaches and mounts the checkout before sending.
  await sub.advance(60_000)
  const thread = await sub.until(() => childThread(sub, idle), "the subagent's finished turn")
  expect(thread.worktrees).toHaveLength(1)
  await sub.until(() => mountState(sub, nested) === 'mounted', 'the checkout to be mounted')
  expect(sub.commands().filter((args) => args.join(' ') === 'worktree list').length).toBeGreaterThan(1)
})

test('a subagent resumed after its process died closes the turn it left running', async () => {
  const root = await parent()
  const first = await child(root)
  first.pi.model = () => new Promise(() => {})
  void first.pi.submit('take a long time')
  const running = await first.until(
    () => childThread(first, (record) => record.update.state === 'running'),
    "the subagent's running turn",
  )
  const turn = running.records.find((record: any) => record.update.state === 'running').sequence
  await first.crash()
  kits.splice(kits.indexOf(first), 1)
  // A new pi process resumes the same session.
  const again = await startDelta({
    world: root.world,
    session: first.pi.session,
    env: { DELTA_PI_PARENT: root.env.DELTA_PI_PARENT! },
  })
  kits.push(again)
  const thread = await again.until(
    () => childThread(again, (record) => idle(record) && record.turnSequence === turn),
    'the abandoned turn to be closed',
  )
  expect(thread.records.filter((record: any) => record.update.state === 'idle')).toHaveLength(1)
})

test('a subagent that ends while its thread is created leaves no checkout mounted', async () => {
  const root = await parent()
  const nested = worktree(root, join(root.world.base, 'feature'))
  const sub = await child(root, { cwd: nested })
  const release = root.world.hold('thread create')
  void sub.pi.submit('work on the feature')
  await sub.until(
    () => sub.commands().some((args) => args[0] === 'thread' && args[1] === 'create'),
    'the thread to be created',
  )
  await sub.stop()
  kits.splice(kits.indexOf(sub), 1)
  release()
  await root.until(
    () => Object.values(root.world.delta().threads).some((thread) => thread.parent),
    'the late creation to finish',
  )
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(mountState(root, nested)).not.toBe('mounted')
  // The ended session says nothing about work it no longer owns.
  expect(sub.pi.noticeTexts()).toEqual([])
})

test('a session started with a link its parent no longer holds records nothing, though the repository syncs', async () => {
  const root = await parent()
  const link = root.env.DELTA_PI_PARENT!
  await root.pi.newSessionIn()
  const worker = await startDelta({ world: root.world, env: { DELTA_PI_PARENT: link } })
  kits.push(worker)
  await worker.pi.prompt('a task for the worker')
  await worker.settle()
  expect(worker.commands().some((args) => args[0] === 'thread' && args[1] === 'create')).toBe(false)
})

test('a subagent the extension named keeps that name, even the default one', async () => {
  const root = await parent()
  const sub = await child(root, { env: { DELTA_PI_SUBAGENT_NAME: 'Subagent' } })
  await sub.pi.prompt('inspect the parser')
  const thread = await sub.until(() => childThread(sub, idle), "the subagent's finished turn")
  expect(thread.name).toBe('Subagent')
})

test('a subagent whose checkout setup failed once is still followed for takeover once setup succeeds', async () => {
  const root = await parent()
  const nested = worktree(root, join(root.world.checkout, '.worktrees', 'feature'))
  const sub = await child(root, { cwd: nested })
  root.world.fail('worktree list')
  // The turn stays running, as during a long tool call, so only the watch can see a takeover.
  sub.pi.model = () => new Promise(() => {})
  void sub.pi.submit('a long task')
  const created = () => Object.values(sub.world.delta().threads).find((thread) => thread.parent)
  await sub.until(created, "the subagent's thread")
  await sub.advance(60_000)
  await sub.until(() => mountState(sub, nested) === 'mounted', 'the checkout to be mounted on retry')
  const reference = created()?.reference
  await sub.until(
    () => sub.commands().some((args) => args[0] === 'thread' && args[1] === 'watch' && args[2] === reference),
    "the subagent's turn to be followed",
  )
})

/** The notes saying pi stopped the kit's turn for a takeover in Delta; print mode writes them to stderr. */
const stoppedTurn = (kit: Kit) =>
  [...kit.pi.noticeTexts(), ...kit.stderr]
    .filter((text) => text.includes("stopped pi's turn"))
    .map((text) => text.trim())

/** The binding the subagent's session saved. */
const savedBinding = async (kit: Kit): Promise<any> => kit.store.get(`session:${kit.pi.session.id}`)

for (const foreground of [false, true]) {
  test(`a ${foreground ? 'foreground' : 'background'} subagent someone takes over in Delta is stopped`, async () => {
    const root = await parent()
    const sub = await child(root)
    // Someone takes the subagent's first turn over in Delta as it starts.
    root.world.fence(sub.pi.session.id, 1)
    // The subagent works until pi stops it, as during a long tool call.
    sub.pi.model = () => sub.until(() => stoppedTurn(sub).length > 0 && { text: 'Stopped.' }, 'the subagent to stop')
    if (foreground) {
      // A foreground subagent runs while its parent's turn waits for it, here inside the parent's model call.
      let waited: string | undefined
      root.pi.model = async (messages) => {
        if (messages.at(-1)?.role !== 'user') return { text: 'Done.' }
        waited = await sub.pi.prompt('inspect the parser')
        return { text: 'The subagent stopped.' }
      }
      await root.pi.prompt('delegate')
      expect(waited).toBe('settled')
    } else {
      await root.pi.prompt('delegate')
      await sub.pi.prompt('inspect the parser')
    }
    // The subagent's own turn stopped, once; its parent's turn ran to its end.
    expect(stoppedTurn(sub)).toEqual([
      "Someone took this subagent's thread over in Delta; stopped pi's turn. Tool effects already performed are not rolled back.",
    ])
    expect(stoppedTurn(root)).toEqual([])
    const finished = await root.until(
      () => root.thread()?.records.findLast((record: any) => record.update.state === 'idle'),
      "the parent's finished turn",
    )
    expect(finished.update.stopReason).toBe('end_turn')
  })
}

test('a subagent queues while Delta is unreachable and is delivered on retry', async () => {
  const root = await parent()
  const sub = await child(root)
  root.world.fail('thread append', { times: 1_000 })
  await sub.pi.prompt('inspect the parser')
  await sub.settle()
  const children = () => Object.values(sub.world.delta().threads).filter((thread) => thread.parent)
  expect(children().flatMap((thread) => thread.records)).toEqual([])
  expect((await savedBinding(sub)).pending).toHaveLength(4)
  root.world.stopFailing('thread append')
  await sub.advance(60_000)
  const thread = await sub.until(() => childThread(sub, idle), "the subagent's delivered turn")
  expect(thread.records.map((record: any) => [record.sequence, record.update.sessionUpdate])).toEqual([
    [1, 'state_update'],
    [2, 'user_message'],
    [3, 'agent_message'],
    [4, 'state_update'],
  ])
  expect((await savedBinding(sub)).pending).toEqual([])
})

test('a refusal Delta calls permanent stops recording the subagent, once', async () => {
  const root = await parent()
  const sub = await child(root)
  root.world.fail('thread create', { code: 'failed', retryable: false, times: 1_000 })
  await sub.pi.prompt('inspect the parser')
  await sub.pi.prompt('and the lexer')
  await sub.advance(60_000)
  root.world.stopFailing('thread create')
  expect(Object.values(sub.world.delta().threads).filter((thread) => thread.parent)).toEqual([])
  expect(sub.commands().filter((args) => args[0] === 'thread' && args[1] === 'create')).toHaveLength(1)
  expect(sub.pi.noticeTexts().filter((text) => text.includes('Delta stopped recording the subagent'))).toEqual([
    'Delta stopped recording the subagent "inspect the parser": thread create: failed: thread create failed as the test asked. Its records stay queued.',
  ])
  expect((await savedBinding(sub)).pending.length).toBeGreaterThan(0)
  // Its parent goes on recording.
  await root.pi.prompt('carry on')
  await root.until(
    () => root.thread()?.records.some((record: any) => JSON.stringify(record.update).includes('Echo: carry on')),
    "the parent's next turn",
  )
})

test("a subagent's run ends only once Delta stops syncing the worktree Claude may then remove", async () => {
  const root = await parent()
  const own = worktree(root, join(root.world.base, 'feature'))
  const sub = await child(root, { cwd: own })
  await sub.pi.prompt('work on the feature')
  await sub.until(() => mountState(sub, own) === 'mounted', 'the checkout to be mounted')
  const release = root.world.holdRelease()
  let ended = false
  const ending = sub.pi.shutdown('quit').then(() => (ended = true))
  // The mount command has ended, but Delta still syncs the directory, so the session's end waits.
  await sub.until(() => mountState(sub, own) === 'restoring', 'the mount to end')
  await sub.advance(1_000)
  expect(ended).toBe(false)
  release()
  // The next check of the directory finds it released.
  await sub.advance(1_000)
  await sub.until(() => ended, "the subagent's session to end")
  await ending
  expect(mountState(sub, own)).toBe('waiting')
})

test("a nested subagent's thread is under its parent subagent's, which prompts it, and shares that parent's checkout", async () => {
  const root = await parent()
  const own = worktree(root, join(root.world.base, 'feature'))
  const sub = await child(root, { cwd: own })
  // The subagent starts a subagent of its own in its worktree, and waits for it.
  let nested: Kit | undefined
  sub.pi.model = async (messages) => {
    if (messages.at(-1)?.role !== 'user') return { text: 'Done.' }
    nested = await child(sub, { cwd: own })
    await nested.pi.prompt('check the lexer')
    return { text: 'The lexer is fine.' }
  }
  await sub.pi.prompt('inspect the parser')
  const threads = () => Object.values(root.world.delta().threads)
  const outer = await root.until(
    () => threads().find((thread) => thread.parent === root.thread()?.thread_id && thread.records.some(idle)),
    "the subagent's finished turn",
  )
  const inner = await root.until(
    () => threads().find((thread) => thread.parent === outer.thread_id && thread.records.some(idle)),
    "the nested subagent's finished turn",
  )
  // The subagent attached its own worktree; the nested one works there too, so it shares that worktree.
  expect(outer.worktrees).toHaveLength(1)
  expect(outer.worktrees).not.toEqual(root.thread()?.worktrees)
  expect(inner.worktrees).toEqual(outer.worktrees)
  const create = nested!.commands().find((args) => args[0] === 'thread' && args[1] === 'create')
  expect(create).toContain('--shared-worktrees')
  expect(create?.[create.indexOf('--parent') + 1]).toBe(outer.reference)
  expect(nested!.commands().filter((args) => args[0] === 'worktree')).toEqual([])
  // The subagent sent the nested one its prompt.
  const prompt = inner.records.find((record: any) => record.update.sessionUpdate === 'user_message')
  expect(prompt.update._meta.delta.sender).toEqual({ external_id: sub.pi.session.id })
})

test("a subagent's subagent that starts before that subagent's thread exists records under it once it does", async () => {
  const root = await parent()
  const sub = await child(root)
  const release = root.world.hold('thread create')
  void sub.pi.submit('inspect the parser')
  await sub.until(
    () => sub.commands().some((args) => args[0] === 'thread' && args[1] === 'create'),
    "the subagent's thread to be created",
  )
  const nested = await child(sub)
  await nested.pi.prompt('check the lexer')
  // Its records wait for its parent's thread, rather than going under the session above.
  expect(nested.commands().some((args) => args[0] === 'thread' && args[1] === 'create')).toBe(false)
  release()
  const outer = await root.until(() => childThread(root, idle), "the subagent's finished turn")
  await nested.advance(60_000)
  const inner = await root.until(
    () =>
      Object.values(root.world.delta().threads).find(
        (thread) => thread.parent === outer.thread_id && thread.records.some(idle),
      ),
    "the nested subagent's finished turn",
  )
  expect(inner.name).toBe('check the lexer')
})

/** Dismiss the setup offer a session not recorded is shown. */
const NOT_NOW = (dialog: { title: string }) => (dialog.title.includes('Set it up now?') ? 'Not now' : undefined)

/** A session in a repository that does not sync on its own, not recorded until it is shared. */
async function unrecorded() {
  const kit = await startDelta({ answers: [NOT_NOW] })
  kits.push(kit)
  await kit.until(() => kit.pi.dialogs.length === 1, 'the setup offer')
  return kit
}

/** Share the session, as `/delta share` with Zed does, and wait until it is shared. */
async function share(kit: Kit) {
  kit.pi.answers.push((dialog) =>
    dialog.title.includes('Who should see this session?') ? 'Share with Zed' : undefined,
  )
  await kit.pi.command('delta', 'share')
  await kit.until(() => kit.pi.noticeTexts().some((text) => text.startsWith('Delta: Shared')), 'the share to finish')
}

test('a subagent running when sharing starts stops when Delta takes it over, and its own checkout reaches Delta', async () => {
  const root = await unrecorded()
  const own = worktree(root, join(root.world.base, 'feature'))
  // A subagent pi runs in a worktree of its own, as subagent extensions do, in print mode.
  const sub = await startDelta({
    world: root.world,
    cwd: own,
    mode: 'print',
    env: { DELTA_PI_PARENT: root.env.DELTA_PI_PARENT! },
  })
  kits.push(sub)
  root.world.fence(sub.pi.session.id, 1)
  // It runs a command while its parent is shared, then works until pi stops it.
  let shared!: () => void
  const sharing = new Promise<void>((resolve) => (shared = resolve))
  sub.pi.model = async (messages) => {
    if (messages.at(-1)?.role !== 'user')
      return sub.until(() => stoppedTurn(sub).length > 0 && { text: 'Stopped.' }, 'the subagent to stop')
    await sharing
    return { calls: [{ name: 'bash', arguments: { command: 'true' } }] }
  }
  const run = sub.pi.submit('fix the lexer')
  await share(root)
  shared()
  await run
  // Someone took it over in Delta as it began recording: its run stopped.
  expect(stoppedTurn(sub)).toEqual([
    "Someone took this subagent's thread over in Delta; stopped pi's turn. Tool effects already performed are not rolled back.",
  ])
  const thread = Object.values(root.world.delta().threads).find((candidate) => candidate.parent)
  expect(thread?.parent).toBe(root.thread()?.thread_id)
  expect(thread?.name).toBe('fix the lexer')
  expect(sub.commands().find((args) => args[0] === 'thread' && args[1] === 'create')).not.toContain(
    '--shared-worktrees',
  )
  // Its run ends in its own checkout: the mount stops, and the checkout stays attached to its thread.
  await sub.stop()
  kits.splice(kits.indexOf(sub), 1)
  const tree = root.world.delta().worktrees.find((entry) => entry.directories.some((dir: any) => dir.directory === own))
  expect(thread?.worktrees).toEqual([tree.reference])
  expect(mountState(root, own)).toBe('waiting')
})

test("a subagent whose parent is shared while it runs records its run so far in that run's turn, and what ran before as history", async () => {
  const root = await unrecorded()
  const sub = await startDelta({
    world: root.world,
    mode: 'print',
    env: { DELTA_PI_PARENT: root.env.DELTA_PI_PARENT! },
  })
  kits.push(sub)
  await sub.pi.prompt('read the docs')
  // Its next run is under way, waiting on its model, when its parent is shared.
  let answer!: (text: string) => void
  sub.pi.model = (messages) =>
    messages.at(-1)?.role === 'user'
      ? { calls: [{ name: 'bash', arguments: { command: 'echo tests pass' } }] }
      : new Promise((resolve) => (answer = (text) => resolve({ text })))
  const run = sub.pi.submit('run the tests')
  await sub.until(() => answer, 'the run to wait on its model')
  await share(root)
  expect(Object.values(root.world.delta().threads).filter((thread) => thread.parent)).toEqual([])
  answer('Tests pass.')
  await run
  const thread = await root.until(() => childThread(root, idle), "the subagent's finished run")
  expect(thread.parent).toBe(root.thread()?.thread_id)
  expect(thread.name).toBe('read the docs')
  expect(thread.worktrees).toEqual(root.thread()?.worktrees)
  const rows: unknown[][] = thread.records.map((record: any) => [
    record.update.sessionUpdate,
    record.update.state ?? record.update.content?.text ?? record.update.title ?? record.update.status,
    record.turnSequence,
  ])
  // The run under way when its parent was shared is its turn; the one before is history. A prompt is its parent's.
  const turn = thread.records.find((record: any) => record.update.state === 'running').turnSequence
  expect(rows.filter((row) => row[2] === undefined).map((row) => row[0])).toEqual(['user_message', 'agent_message'])
  expect(rows.filter((row) => row[2] === turn).map((row) => row[0])).toEqual([
    'state_update',
    'user_message',
    'tool_call_update',
    'tool_call_update',
    'agent_message',
    'state_update',
  ])
  expect(rows.at(-1)).toEqual(['state_update', 'idle', turn])
  const prompts = thread.records.filter((record: any) => record.update.sessionUpdate === 'user_message')
  expect(prompts.map((record: any) => record.update._meta.delta.sender)).toEqual([
    { external_id: root.pi.session.id },
    { external_id: root.pi.session.id },
  ])
})
