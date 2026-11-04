// A share's lifecycle across pi processes: what a share whose step failed, or whose answer or receipt was
// lost, leaves for a later pi to retry, and what resuming a shared session does and does not do. Ported
// from the upstream plugin's engine tests (hooks/register.test.ts, "sharing") onto the kit; a restart is
// a new pi process resuming the session on the same machine.
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { type Kit, startDelta } from '../kit/index.ts'
import type { World } from '../world.ts'
import {
  addMessage,
  binding,
  checkouts,
  exports,
  lost,
  manualWorld,
  missingCli,
  ran,
  records,
  setupCommands,
  share,
  shareAnswer,
  staged,
  unlisted,
} from './sharing-kit.ts'

let w: World | undefined
const kits: Kit[] = []
afterEach(async () => {
  for (const kit of kits.splice(0)) {
    kit.expectClean()
    await kit.stop()
  }
  w?.cleanup()
  w = undefined
})

/** A pi in a new checkout that records only what is shared. */
async function sharer(options: { start?: boolean } = {}): Promise<Kit> {
  w = manualWorld()
  const kit = await startDelta({ world: w, ...options })
  kits.push(kit)
  return kit
}

/** Wait a moment of real time for work already started, such as a late answer, to land. */
const moment = () => new Promise((resolve) => setTimeout(resolve, 300))

/**
 * End `kit`'s pi and resume its session in a new one, doing `before` in between, as a change made while
 * no pi runs. Unless `restoring`, this waits for the resumed session to restore its checkout's mount.
 */
async function resumed(kit: Kit, options: { before?: () => unknown; restoring?: boolean } = {}): Promise<Kit> {
  await kit.stop()
  // pi exits once its session has ended; in this process the ended runtime's last commands, such as a
  // delivery its shutdown budget cut short, still finish, so they finish before the next pi starts.
  await kit.until(() => kit.busy() === 0, 'the ended pi to finish its commands')
  await moment()
  await options.before?.()
  const next = await startDelta({ world: kit.world, session: kit.pi.session })
  kits.push(next)
  // Let the resumed session's activation run what it runs on its own.
  await next.settle()
  await next.advance(0)
  const saved = await binding(next)
  if (saved?.snapshot && saved.checkout && !options.restoring)
    await next.until(
      () => /Restored checkout synchronization|couldn.t restore/.test(next.pi.statuses.get('delta') ?? ''),
      'the checkout to be restored',
    )
  return next
}

const delivered = (kit: Kit, text: string) => JSON.stringify(records(kit)).includes(text)

test('failed attach preserves the staged manifest for retry', async () => {
  const operation = 'attach'
  const first = await sharer()
  await first.pi.prompt('one')
  await first.pi.prompt('two')
  first.world.answer('worktree attach', { stdout: lost(`${operation} unavailable`), exitCode: 2 })
  expect(await share(first)).toContain(`${operation} unavailable`)
  const manifest = await binding(first)
  const sequences = await staged(first)
  expect(manifest.snapshot).toBe(true)
  expect(sequences).toEqual(sequences.map((_, index) => index + 1))
  expect(manifest.next).toBe(sequences.length + 1)
  expect(manifest.thread).toBe(first.thread().thread_id)
  const pending = structuredClone(manifest.pending)
  expect(checkouts(first)).toEqual([])
  expect(records(first)).toEqual([])
  expect(ran(first)).not.toContain('thread watch')
  expect(first.thread().url).toBeNull()
  const messages = first.pi.messages().length
  expect(await first.pi.prompt('unsafe')).toBe('handled')
  expect(first.pi.messages()).toHaveLength(messages)
  // The transcript changes while no pi runs; the staged export stays as it was.
  const second = await resumed(first, { before: () => addMessage(first, 'changed export must not be imported') })
  expect(setupCommands(second)).toEqual([])
  expect((await binding(second)).pending).toEqual(pending)
  expect(second.thread().url).toBeNull()
  unlisted(second)
  expect(await share(second)).toBe(second.thread().url)
  // The retry attached the local worktree identity the failed attempt created.
  expect(second.world.delta().worktrees).toHaveLength(1)
  expect(exports(second)).toBe(1)
  expect(records(second).map((record) => record.sequence)).toEqual(sequences)
  expect(delivered(second, 'changed export')).toBe(false)
})

/**
 * Delta finishes a share's attach or publication, and its answer, or the binding that would have saved
 * it, is lost: a restart runs no setup, and the explicit retry finishes with the same setup.
 */
async function lostSetup(operation: 'attach' | 'share', failure: 'response' | 'receipt save', exitCode = 2) {
  const first = await sharer()
  await first.pi.prompt('one')
  const command = operation === 'attach' ? 'worktree attach' : 'thread share'
  // Delta did the step; its answer, or the binding that would have saved it, is lost.
  const done = () => (operation === 'attach' ? !!first.thread()?.worktrees.length : !!first.thread()?.url)
  let repair = () => {}
  if (failure === 'response') first.world.answer(command, { run: true, stdout: lost('setup receipt lost'), exitCode })
  else repair = first.disk.fail('write', (path) => path.includes('/store/') && done(), { times: 1000 })
  expect(await share(first)).toContain(failure === 'response' ? 'setup receipt lost' : 'failed')
  const manifest = await binding(first)
  expect(manifest.thread).toBe(first.thread().thread_id)
  expect(manifest.checkout).toBe(operation === 'attach' ? undefined : first.world.checkout)
  expect(manifest.url).toBeUndefined()
  const sequences = await staged(first)
  expect(sequences).toEqual(sequences.map((_, index) => index + 1))
  // Attached, and mounted only once the share went on to mount it.
  expect(checkouts(first).map((checkout) => checkout.state)).toEqual([operation === 'attach' ? 'waiting' : 'mounted'])
  const [checkout] = checkouts(first)
  expect(!!first.thread().url).toBe(operation === 'share')
  expect(records(first)).toEqual([])
  repair()
  const second = await resumed(first, {
    before: () => addMessage(first, 'changed export must not replace staged content'),
  })
  expect(setupCommands(second)).toEqual([])
  expect(!!second.thread().url).toBe(operation === 'share')
  expect(checkouts(second).map((entry) => entry.reference)).toEqual([checkout!.reference])
  if (operation === 'attach') {
    expect((await binding(second)).checkout).toBeUndefined()
    expect(records(second)).toEqual([])
  }
  unlisted(second)
  const url = await share(second)
  expect(url).toBe(second.thread().url)
  // No second local worktree identity, and the same one attached.
  expect(second.world.delta().worktrees).toHaveLength(1)
  expect(checkouts(second)).toEqual([{ ...checkout!, state: 'mounted' }])
  expect(await binding(second)).toMatchObject({
    thread: second.thread().thread_id,
    checkout: second.world.checkout,
    pending: [],
  })
  expect(exports(second)).toBe(1)
  expect(records(second)[0]).toMatchObject({ sequence: 1, update: { content: [{ text: 'one' }] } })
  expect(records(second).map((record) => record.sequence)).toEqual(sequences)
  expect(delivered(second, 'changed export')).toBe(false)
}

test('lost attach response with exit 1 preserves completed setup for explicit retry', () =>
  lostSetup('attach', 'response', 1))
test('lost attach receipt save preserves completed setup for explicit retry', () => lostSetup('attach', 'receipt save'))
test('lost share response preserves completed setup for explicit retry', () => lostSetup('share', 'response'))
test('lost share receipt save preserves completed setup for explicit retry', () => lostSetup('share', 'receipt save'))

/**
 * `thread create` creates the thread and its answer, the binding write that would save it, or the whole
 * local binding is lost: the retry resolves the same thread through the same producer.
 */
async function lostCreation(failure: 'response' | 'binding write' | 'local binding') {
  const first = await sharer()
  await first.pi.prompt('one')
  let repair = () => {}
  if (failure === 'binding write')
    repair = first.disk.fail('write', (path) => path.includes('/store/') && !!first.thread(), { times: 1000 })
  else first.world.answer('thread create', { run: true, stdout: lost('lost response'), exitCode: 2 })
  expect(await share(first)).toContain('failed')
  const thread = first.thread().thread_id
  expect((await binding(first)).thread).toBeUndefined()
  expect(checkouts(first)).toEqual([])
  expect(first.thread().url).toBeNull()
  expect(
    ran(first).filter((command) => ['worktree attach', 'thread share', 'thread append'].includes(command)),
  ).toEqual([])
  repair()
  const second = await resumed(first, {
    before: () => failure === 'local binding' && first.store.delete(`session:${first.pi.session.id}`),
  })
  expect(setupCommands(second)).toEqual([])
  expect(second.thread().url).toBeNull()
  expect(await share(second)).toBe(second.thread().url)
  // One thread, the same: creation found the one the lost answer made.
  expect(Object.keys(second.world.delta().threads)).toEqual([thread])
  expect(await binding(second)).toMatchObject({ thread, pending: [] })
  expect(checkouts(second)).toMatchObject([{ directory: second.world.checkout, state: 'mounted' }])
  // A lost binding exports the conversation again; nothing had reached the thread, so nothing repeats.
  expect(exports(second)).toBe(failure === 'local binding' ? 2 : 1)
  expect(records(second).filter((record) => record.update.sessionUpdate === 'user_message')).toHaveLength(1)
  expect(records(second).map((record) => record.sequence)).toEqual(records(second).map((_, index) => index + 1))
}

test('lost creation response retries the same source identity', () => lostCreation('response'))
test('lost creation binding write retries the same source identity', () => lostCreation('binding write'))
test('lost creation local binding retries the same source identity', () => lostCreation('local binding'))

test('a missing session binding cannot adopt a nonempty producer or import a regenerated suffix', async () => {
  const first = await sharer()
  await first.pi.prompt('one')
  await first.pi.prompt('two')
  await share(first)
  const ledger = records(first)
  const [checkout] = checkouts(first)
  // Lose the actual local identity and receipts, not merely change the remote frontier.
  const second = await resumed(first, {
    before: async () => {
      await first.store.delete(`session:${first.pi.session.id}`)
      addMessage(first, 'regenerated suffix must not be imported')
    },
  })
  const refusal = /Restore the matching producer state or start a new pi session/
  expect(await share(second)).toMatch(refusal)
  const unsafe = ['worktree attach', 'thread share', 'thread append']
  expect(ran(second).filter((command) => unsafe.includes(command))).toEqual([])
  expect((await binding(second)).thread).toBeUndefined()
  expect(records(second)).toEqual(ledger)
  expect(checkouts(second).map((entry) => entry.reference)).toEqual([checkout!.reference])
  expect(second.thread().url).toBeTruthy()
  const pending = structuredClone((await binding(second)).pending)
  expect(await second.pi.prompt('unsafe after reset')).toBe('handled')
  // The newly saved immutable plan still is not evidence of the lost identity.
  expect(await share(second)).toMatch(refusal)
  expect(exports(second)).toBe(2)
  expect(ran(second).filter((command) => unsafe.includes(command))).toEqual([])
  expect(records(second)).toEqual(ledger)
  expect(checkouts(second).map((entry) => entry.reference)).toEqual([checkout!.reference])
  expect(second.thread().url).toBeTruthy()
  expect((await binding(second)).pending).toEqual(pending)
})

/**
 * Resume a shared session whose checkout Delta still reports attached, or whose thread it no longer
 * reports published: the resume publishes and attaches nothing, and only an explicit share recovers.
 */
async function resumeObserves(state: 'attached' | 'unshared') {
  const first = await sharer()
  await first.pi.prompt('one')
  const url = await share(first)
  const shared = records(first).length
  const [checkout] = checkouts(first)
  await first.stop()
  // The session's end released its checkout.
  expect(checkouts(first).map((entry) => entry.state)).toEqual(['waiting'])
  // Delta no longer reports the thread as published, and access as only local.
  if (state === 'unshared')
    first.world.answer(
      'thread status',
      { patch: { url: null, visibility: null, access: { state: 'local_only', is_owner: null } } },
      { times: 1000 },
    )
  const second = await resumed(first)
  // A shell command is recorded either way. pi commits it at the next event the extension reads, the
  // prompt after it: delivered at once while the checkout is attached; while the thread is not
  // published that prompt is refused, and the command is staged for the share to deliver.
  await second.pi.shell('echo after resume')
  const submitted = await second.pi.prompt('continue after resume')
  if (state === 'attached') {
    expect(submitted).toBe('settled')
    await second.until(() => delivered(second, 'Echo: continue after resume'), 'the resumed turn')
    expect(delivered(second, 'echo after resume')).toBe(true)
    await second.until(async () => (await staged(second)).length === 0, 'the outbox to empty')
  } else {
    expect(submitted).toBe('handled')
    await second.advance(0)
    await second.quiet()
    expect(records(second)).toHaveLength(shared)
    const pending = (await binding(second)).pending
    expect(pending.map((entry: { sequence: number }) => entry.sequence)).toEqual([shared + 1])
    expect(readFileSync(pending[0].files[0], 'utf8')).toContain('echo after resume')
  }
  expect(setupCommands(second)).toEqual([])
  expect(checkouts(second)).toEqual([{ ...checkout!, state: 'mounted' }])
  second.world.stopAnswering('thread status')
  expect(await share(second)).toBe(url)
  expect(checkouts(second)).toEqual([{ ...checkout!, state: 'mounted' }])
  expect(second.world.delta().worktrees).toHaveLength(1)
  expect(await second.pi.prompt('after the share')).toBe('settled')
  await second.until(() => delivered(second, 'Echo: after the share'), 'the turn after the share')
  // The command run while sharing was refused reaches the thread once, in its place before the turn.
  const shell = records(second).flatMap((record, index) =>
    JSON.stringify(record).includes('echo after resume') ? [index] : [],
  )
  expect(shell).toHaveLength(1)
  if (state === 'unshared') expect(shell).toEqual([shared])
  expect(records(second).map((record) => record.sequence)).toEqual(records(second).map((_, index) => index + 1))
  expect((await binding(second)).pending).toEqual([])
  expect(exports(second)).toBe(1)
}

test('resume observes attached setup without publishing or reattaching', () => resumeObserves('attached'))
test('resume observes unshared setup without publishing or reattaching', () => resumeObserves('unshared'))

test('resume takes prompts while its checkout mount waits for Delta, and delivers them once it is back', async () => {
  const first = await sharer()
  await first.pi.prompt('one')
  await share(first)
  const shared = records(first).length
  await first.stop()
  // Offline, Delta holds a shared checkout's mount until it can connect.
  const connect = first.world.hold('worktree mount')
  const second = await resumed(first, { restoring: true })
  expect(checkouts(second).map((entry) => entry.state)).toEqual(['waiting'])
  expect(await second.pi.prompt('while the checkout restores')).toBe('settled')
  await second.advance(0)
  await moment()
  // The records queue until the checkout syncs again.
  expect(records(second)).toHaveLength(shared)
  connect()
  await second.until(async () => {
    await second.advance(1_000)
    return delivered(second, 'Echo: while the checkout restores')
  }, 'the queued turn')
  expect(checkouts(second).map((entry) => entry.state)).toEqual(['mounted'])
  await second.until(async () => !(await binding(second)).pending.length, 'the outbox to empty')
})

test('resume checks authenticated denied access without deriving it from a URL', async () => {
  const first = await sharer()
  await first.pi.prompt('one')
  const url = await share(first)
  expect(url).toBe(first.thread().url)
  const shared = records(first).length
  await first.stop()
  first.world.fail('thread status', { code: 'not_visible', retryable: false, times: 1000 })
  const second = await resumed(first)
  expect(await second.pi.prompt('participate')).toBe('handled')
  await second.pi.shell('echo local')
  await second.advance(0)
  await second.quiet()
  expect(records(second)).toHaveLength(shared)
  expect(setupCommands(second)).toEqual([])
  expect(await binding(second)).toMatchObject({ thread: second.thread().thread_id, url })
})

test('reference-bound checkout selection cannot silently switch or adopt ambiguous inventories', async () => {
  const first = await sharer()
  await first.pi.prompt('one')
  await share(first)
  const shared = records(first).length
  await first.stop()
  const saved = await binding(first)
  // A resume clears the end marker, so it is not part of the preserved binding.
  delete saved.endedAt
  await first.store.set(`session:${first.pi.session.id}`, saved)
  // Delta reports this checkout under another worktree's history.
  const other = { reference: 'different#t=0', checkouts: [{ directory: first.world.checkout, state: 'attached' }] }
  first.world.answer(
    'thread status',
    { patch: { worktrees: { status: 'available', items: [other] } } },
    { times: 1000 },
  )
  const second = await resumed(first)
  expect(await second.pi.prompt('unsafe')).toBe('handled')
  expect(await binding(second)).toEqual(saved)
  expect(records(second)).toHaveLength(shared)
  expect(setupCommands(second)).toEqual([])
  // Attaching again names that other history too; the share keeps the binding it had.
  second.world.answer('worktree attach', { patch: { reference: other.reference } })
  expect(await share(second)).toContain('Invalid worktree membership receipt')
  expect(await binding(second)).toEqual(saved)
})

test('resume with a missing CLI preserves the binding and asks for explicit setup', async () => {
  const kit = await sharer({ start: false })
  const cli = missingCli(kit)
  const seeded = {
    session: kit.pi.session.id,
    thread: 'thread_1',
    checkout: kit.world.checkout,
    snapshot: true,
    next: 1,
    pending: [],
  }
  await kit.store.set(`session:${kit.pi.session.id}`, seeded)
  await kit.pi.start('resume')
  await kit.settle()
  await kit.until(() => kit.pi.noticeTexts().length, 'what the session says')
  expect(cli.setups).toEqual(['discover'])
  expect(await binding(kit)).toEqual(seeded)
  expect(kit.commands()).toEqual([])
  expect(kit.pi.noticeTexts().join('\n')).toContain('Run /delta-share or /delta-join')
})

test('first explicit share installs a missing CLI, never plugin load or contract failure', async () => {
  const kit = await sharer({ start: false })
  const cli = missingCli(kit)
  kit.world.contract(0, 0)
  await kit.pi.start()
  await kit.settle()
  await kit.quiet()
  expect(cli.setups).toEqual([])
  expect(await share(kit)).toContain('too old')
  expect(cli.setups).toEqual(['discover', 'install'])
  expect(ran(kit).filter((command) => command.startsWith('thread ') && command !== 'thread contract')).toEqual([])
  expect(ran(kit).filter((command) => command.startsWith('worktree '))).toEqual([])
  kit.world.contract(8, 8)
  expect(await share(kit)).toBe(kit.thread().url)
  expect(cli.setups).toEqual(['discover', 'install'])
})

test('share stops when its session changes during installation', async () => {
  const kit = await sharer({ start: false })
  const cli = missingCli(kit)
  let release!: () => void
  cli.install = new Promise((resolve) => (release = resolve))
  await kit.pi.start()
  await kit.pi.prompt('original conversation')
  const original = kit.pi.session.id
  kit.pi.answers.push(shareAnswer)
  await kit.pi.command('delta', 'share')
  await kit.until(() => cli.setups.includes('install'), 'the installation to start')
  await kit.whileTimePasses(kit.pi.newSessionIn())
  const notices = kit.pi.notices.length
  release()
  await kit.advance(0)
  await moment()
  await kit.advance(0)
  await kit.quiet()
  expect(exports(kit, original)).toBe(0)
  expect(setupCommands(kit)).toEqual([])
  expect(kit.thread()).toBeUndefined()
  expect(await kit.store.get(`session:${original}`)).toBeUndefined()
  // The replacement hears nothing of the share its predecessor started.
  expect(kit.pi.notices.slice(notices)).toEqual([])
  kit.pi.answers.splice(0)
  expect(await kit.pi.prompt('continue here')).toBe('settled')
})

// Upstream's hooks/sharing/lifecycle.test.ts checks these through its helpers; pi decides them through
// `ctx.hasUI` and the share or join in flight, so they are checked here through what the person sees.

test('terminal and desktop are interactive, while headless hosts are not', async () => {
  w = manualWorld()
  // pi's terminal and an RPC client show dialogs (`hasUI`); print and JSON modes do not.
  const rpc = await startDelta({ world: w, mode: 'rpc' })
  kits.push(rpc)
  await rpc.pi.command('delta', 'share')
  await rpc.until(() => rpc.pi.dialogs.some((dialog) => dialog.title.includes('Who should see')), 'the question')
  await rpc.stop()
  const print = await startDelta({ world: w, mode: 'print' })
  kits.push(print)
  for (const action of ['share', 'join some-link', 'setup']) {
    const before = print.stderr.length
    await print.pi.command('delta', action)
    expect(print.stderr.slice(before).join('')).toMatch(
      /needs pi's interactive terminal or an RPC client that shows dialogs/,
    )
  }
  expect(print.pi.dialogs).toEqual([])
})

test('pending share and join operations hold prompts until the operation ends', async () => {
  const kit = await sharer()
  const { pi } = kit
  await pi.prompt('one')
  const created = kit.world.hold('thread create')
  pi.answers.push(shareAnswer)
  await pi.command('delta', 'share')
  await kit.until(() => ran(kit).includes('thread create'), 'the share to create its thread')
  expect(await pi.prompt('during the share')).toBe('handled')
  expect(pi.noticeTexts()).toContain(
    'Delta is sharing this session. Wait for the share result before submitting a prompt.',
  )
  created()
  await kit.until(() => pi.noticeTexts().some((text) => text.startsWith('Delta: Shared')), 'the share to finish')
  expect(await pi.prompt('after the share')).toBe('settled')

  // A teammate's shared thread, which a new session joins.
  const other = join(kit.world.base, 'other')
  mkdirSync(other, { recursive: true })
  const thread = kit.world.cli('thread', 'create', '--source', 'claude-code', '--external-id', 'teammate')
  const tree = kit.world.cli('worktree', 'create', other)
  kit.world.cli('worktree', 'attach', tree.reference, '--thread', thread.thread_id)
  const { url } = kit.world.cli('thread', 'share', thread.thread_id, '--visibility', 'organization')
  await kit.whileTimePasses(pi.newSessionIn())
  const mounted = kit.world.hold('thread mount')
  const joining = pi.command('delta-join', url)
  await kit.until(() => ran(kit).includes('thread mount'), 'the join to mount the thread')
  expect(await pi.prompt('during the join')).toBe('handled')
  expect(pi.noticeTexts()).toContain(
    'Delta is joining a shared thread. Wait for the join result before submitting a prompt.',
  )
  mounted()
  await joining
  await kit.until(
    () => pi.noticeTexts().some((text) => text.startsWith('Joined the Delta thread')),
    'the join to finish',
  )
  expect(await pi.prompt('after the join')).toBe('settled')
})
