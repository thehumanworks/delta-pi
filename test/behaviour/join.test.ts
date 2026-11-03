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

for (const locator of [
  { code: 'invalid_reference' },
  { code: 'invalid_reference', reason: 'invalid_worktree_reference' },
] as const)
  test(`an invalid join locator (${locator.reason ?? locator.code}) suggests the share link, not the same locator`, async () => {
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
  expect(shown(delta)).toContain('Delta is joining a shared thread. Wait for the join result before submitting a prompt.')
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
