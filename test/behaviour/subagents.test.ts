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
  await kit.until(() => kit.env.DELTA_PI_PARENT, 'the parent to export its thread')
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
