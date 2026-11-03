import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { type Kit, startDelta } from '../kit/index.ts'
import type { World } from '../world.ts'

let delta: Kit | undefined
afterEach(async () => {
  delta?.expectClean()
  await delta?.stop()
  delta = undefined
})

/** The setup offer a repository without a policy makes; these tests decline it. */
const NOT_NOW = (dialog: { title: string }) => (dialog.title.includes('Set it up now?') ? 'Not now' : undefined)

/** A teammate's shared thread, with their checkout attached. */
function sharedThread(w: World) {
  const other = join(w.base, 'other')
  mkdirSync(other, { recursive: true })
  const created = w.cli('thread', 'create', '--source', 'claude-code', '--external-id', 'teammate')
  const tree = w.cli('worktree', 'create', other)
  w.cli('worktree', 'attach', tree.reference, '--thread', created.thread_id)
  const { url } = w.cli('thread', 'share', created.thread_id, '--visibility', 'organization')
  return { thread: created.thread_id as string, url: url as string }
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

const joined = (kit: Kit) => kit.pi.noticeTexts().some((text) => text.startsWith('Joined the Delta thread'))

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
