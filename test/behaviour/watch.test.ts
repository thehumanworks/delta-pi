// The thread watch: its readiness, reconnection and failures, and what ending a session while it starts
// leaves behind. Ported from the upstream plugin's engine tests (hooks/register.test.ts, "the watch") onto
// the kit.
import { afterEach, expect, test } from 'vitest'
import { type Kit, startDelta } from '../kit/index.ts'

let kits: Kit[] = []
afterEach(async () => {
  for (const kit of kits.reverse()) {
    kit.expectClean()
    await kit.stop()
  }
  kits = []
})

const NOT_NOW = (dialog: { title: string }) => (dialog.title.includes('Set it up now?') ? 'Not now' : undefined)
const SHARE = (dialog: { title: string }) =>
  dialog.title.includes('Who should see this session?') ? 'Share with Zed' : undefined
/** The band's marks: the watch is live, or still connecting or reconnecting. */
const LIVE = '●'
const PENDING = '◌'

const watches = (kit: Kit) => kit.commands().filter((args) => args[0] === 'thread' && args[1] === 'watch')
const statuses = (kit: Kit) => kit.commands().filter((args) => args[0] === 'thread' && args[1] === 'status')
const records = (kit: Kit): any[] => kit.thread()?.records ?? []
/** The band as pi's RPC client shows it: one plain line. */
const band = (kit: Kit) => kit.pi.statuses.get('delta') ?? ''

/** A session shared with `/delta share`, as upstream's tests share theirs, once its watch is live. */
async function shared(options: Parameters<typeof startDelta>[0] = {}) {
  const kit = await startDelta({ answers: [NOT_NOW], ...options })
  kits.push(kit)
  await kit.until(() => kit.pi.dialogs.length === 1, 'the setup offer')
  await kit.pi.prompt('one')
  kit.pi.answers.push(SHARE)
  await kit.pi.command('delta', 'share')
  await kit.until(() => kit.pi.noticeTexts().some((text) => text.startsWith('Delta: Shared')), 'the share to finish')
  await kit.until(() => band(kit).startsWith(LIVE), 'the watch to be live')
  return kit
}

/** The thread the kit's session records into. */
const threadOf = (kit: Kit) => kit.thread()!.thread_id

test('watch_reset reconnects for a fresh snapshot', async () => {
  const kit = await shared()
  const before = watches(kit).length
  kit.world.endWatch(threadOf(kit), 1, { code: 'watch_reset', message: 'start a new watch', retryable: true })
  await kit.until(() => kit.pi.noticeTexts().some((text) => text.includes('watch_reset')), 'the reset to be noted')
  await kit.advance(1000)
  await kit.until(() => watches(kit).length === before + 1 && band(kit).startsWith(LIVE), 'a fresh watch')
  expect(await kit.pi.prompt('after reconnect')).toBe('settled')
  await kit.until(() => JSON.stringify(records(kit)).includes('Echo: after reconnect'), 'the prompt to be recorded')
})

test('a gone thread pauses sharing with its reason instead of reconnecting', async () => {
  const kit = await shared()
  kit.world.endWatch(threadOf(kit), 1, {
    code: 'not_visible',
    reason: 'thread_gone',
    message: 'The thread was deleted',
    retryable: false,
  })
  const paused = await kit.until(
    () => kit.pi.noticeTexts().find((text) => text.includes('not_visible (thread_gone)')),
    'the pause to be noted',
  )
  expect(paused).toContain('/delta-share')
  const count = watches(kit).length
  await kit.advance(120_000)
  expect(watches(kit)).toHaveLength(count)
  expect(band(kit)).toContain('not_visible')
  // A delivery pause stops delivery, not pi: the prompt is accepted while the reason stays shown.
  expect(await kit.pi.prompt('after deletion')).toBe('settled')
  expect(band(kit)).toContain('not_visible')
})

for (const code of ['failed', 'incompatible_app'])
  test(`a non-retryable ${code} watch error pauses participation`, async () => {
    const kit = await shared()
    kit.world.endWatch(threadOf(kit), 1, {
      code,
      reason: code === 'failed' ? 'storage' : code,
      message: 'cannot continue',
      retryable: false,
    })
    await kit.until(() => band(kit).includes(code), 'the pause to be shown')
    const count = watches(kit).length
    await kit.advance(120_000)
    expect(watches(kit)).toHaveLength(count)
    expect(band(kit)).toContain(code)
    // The pause stops delivery, not pi: the prompt is accepted while the reason stays shown.
    expect(await kit.pi.prompt('while paused')).toBe('settled')
  })

test('a retryable failed watch error reconnects like any lost connection', async () => {
  const kit = await shared()
  const before = watches(kit).length
  kit.world.endWatch(threadOf(kit), 1, {
    code: 'failed',
    reason: 'sync',
    message: 'synchronization stalled',
    retryable: true,
  })
  await kit.until(() => kit.pi.noticeTexts().some((text) => text.startsWith('Connection interrupted')), 'the drop')
  await kit.advance(1000)
  await kit.until(() => watches(kit).length === before + 1 && band(kit).startsWith(LIVE), 'a new watch')
  expect(await kit.pi.prompt('after reconnect')).toBe('settled')
  await kit.until(() => JSON.stringify(records(kit)).includes('Echo: after reconnect'), 'the prompt to be recorded')
})

/** End `kit`'s session as pi does when it quits, keeping its world, store and outbox for a resume. */
async function end(kit: Kit) {
  await kit.whileTimePasses(kit.pi.shutdown('quit'))
}

/** A new pi process resuming `kit`'s session in the same world; it starts unless `start` is false. */
async function resume(kit: Kit, start = true) {
  const again = await startDelta({ world: kit.world, session: kit.pi.session, start: false })
  kits.push(again)
  if (start) await again.pi.start()
  return again
}

const binding = async (kit: Kit) => (await kit.store.get(`session:${kit.pi.session.id}`)) as any

test("a status check that cannot reach Delta neither stops a shared session's delivery nor latches a pause", async () => {
  const kit = await shared()
  // A registered thread's status fails while Delta is unreachable; the records still go out,
  // acknowledged locally, and the checkout is checked again once the server answers.
  kit.world.fail('thread status', { times: 1_000, code: 'app_unavailable' })
  await kit.pi.prompt('run echo while-offline')
  await kit.until(() => JSON.stringify(records(kit)).includes('while-offline'), 'the tool call to be delivered')
  expect(records(kit).map((record) => record.sequence)).toEqual(records(kit).map((_, index) => index + 1))
  await kit.until(async () => (await binding(kit)).pending.length === 0, 'nothing to stay staged')
  kit.world.stopFailing('thread status')
  expect(await kit.pi.prompt('proceeds')).toBe('settled')
  await kit.until(() => JSON.stringify(records(kit)).includes('Echo: proceeds'), 'the next prompt to be delivered')
  expect(band(kit)).not.toContain('app_unavailable')
})

test('a large status bypasses short-command capture', async () => {
  const kit = await shared()
  await end(kit)
  // Fields the extension does not read can still make the status larger than a run captures.
  kit.world.patchStatus({ diagnostics: 'x'.repeat(4 * 1024 * 1024) })
  const again = await resume(kit)
  await again.until(() => band(again).startsWith(LIVE), 'the watch to be live')
  expect(await again.pi.prompt('run echo large-status')).toBe('settled')
  await again.until(() => JSON.stringify(records(again)).includes('large-status'), 'the turn to be delivered')
  const saved = await binding(again)
  expect(saved).toMatchObject({ thread: threadOf(again), pending: [] })
  expect(saved.next).toBe(records(again).length + 1)
})

test('a watch that has never been live says it is reconnecting while it retries', async () => {
  const kit = await shared()
  await end(kit)
  // After the restart, every attempt fails before the watch is ready, so it is never live.
  kit.world.fail('thread watch', { times: 1_000 })
  const again = await resume(kit)
  await again.until(() => band(again).startsWith(PENDING), 'the band to say it is reconnecting')
  expect(band(again)).not.toContain(LIVE)
  const attempts = watches(again).length
  await again.advance(1000)
  await again.until(() => watches(again).length > attempts, 'another attempt')
  await again.settle()
  expect(band(again).startsWith(PENDING)).toBe(true)
  expect(band(again)).not.toContain(LIVE)
})

test('reconnection retries with capped backoff and session end stops the idle child', async () => {
  const kit = await shared()
  await end(kit)
  // The third connection stays idle, never ready, so the band's grace runs out.
  kit.world.hold('thread watch', { after: 2 })
  const again = await resume(kit)
  const thread = threadOf(again)
  const attempts = () => watches(again).length
  const watching = () => again.running().some((args) => args[1] === 'watch')
  /** Wait until the watch running now has gone live: its status inspection has answered. */
  const live = async (inspections: number) => {
    await again.until(() => statuses(again).length > inspections && watching(), 'the watch to go live')
    await again.settle()
  }
  await live(0)
  expect(band(again).startsWith(LIVE)).toBe(true)
  // The first watch went live before it dropped, so the band waits out its grace.
  again.world.endWatch(thread)
  await again.until(() => !watching(), 'the watch to drop')
  expect(band(again).startsWith(LIVE)).toBe(true)
  await again.advance(999)
  expect(attempts()).toBe(1)
  let inspections = statuses(again).length
  await again.advance(1)
  await again.until(() => attempts() === 2, 'the second attempt')
  await live(inspections)
  expect(band(again).startsWith(LIVE)).toBe(true)
  // A live watch that drops looks live through its grace, reconnecting attempts included.
  again.world.endWatch(thread)
  await again.until(() => !watching(), 'the watch to drop again')
  expect(band(again).startsWith(LIVE)).toBe(true)
  inspections = statuses(again).length
  await again.advance(1999)
  expect(attempts()).toBe(2)
  await again.advance(1)
  await again.until(() => attempts() === 3 && watching(), 'the idle third attempt')
  expect(band(again).startsWith(LIVE)).toBe(true)
  // Past the grace, counted from the drop, the band admits to reconnecting.
  await again.advance(2000)
  expect(band(again).startsWith(PENDING)).toBe(true)
  expect(statuses(again)).toHaveLength(inspections)
  // Participation lasts as long as a watch, so every reconnection asks for it again.
  expect(watches(again).every((args) => args.includes('--participate'))).toBe(true)
  await end(again)
  expect(watching()).toBe(false)
  const ended = attempts()
  await again.advance(120_000)
  expect(attempts()).toBe(ended)
})

for (const nth of [1, 2])
  test(`ending during startup store read ${nth} cannot start the watcher`, async () => {
    const kit = await shared()
    await end(kit)
    const session = kit.pi.session.id
    // The first read is the session's binding, as activation loads it; the second the ledger of rows
    // pi's context already holds, as the watch loads it before it starts.
    const held = nth === 1 ? `session_${session}` : `appended_${session}`
    const release = kit.disk.hold('read', held)
    const again = await resume(kit, false)
    const reads = kit.disk.touched('read').length
    const starting = again.pi.start()
    await again.until(
      () =>
        kit.disk
          .touched('read')
          .slice(reads)
          .some((path) => path.includes(held)),
      'the held store read',
    )
    const ending = again.whileTimePasses(again.pi.shutdown('quit'))
    await again.settle()
    release()
    await ending
    await starting
    await again.advance(60_000)
    expect(watches(again)).toEqual([])
    expect(again.running()).toEqual([])
  })

test('ending during watch CLI resolution never spawns the obsolete command', async () => {
  const kit = await shared()
  await end(kit)
  const again = await resume(kit, false)
  // pi's extension finds the CLI once per session runtime, before its first command; the watch, and
  // every command after it, wait on that.
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  let resolving = false
  again.programs.set('sh', async (argv) => {
    if (argv[1] !== '-c' || !argv[2]?.includes('command -v delta')) return undefined
    resolving = true
    await held
    return undefined
  })
  const starting = again.pi.start()
  await again.until(() => resolving, 'the CLI to be resolved')
  const ending = again.whileTimePasses(again.pi.shutdown('quit'))
  await again.settle()
  release()
  await ending
  await starting
  await again.advance(60_000)
  expect(watches(again)).toEqual([])
  expect(statuses(again)).toEqual([])
  expect(again.running()).toEqual([])
})

test('ending during status CLI resolution never spawns the obsolete command', async () => {
  const kit = await shared()
  await end(kit)
  const again = await resume(kit, false)
  // The CLI is found once per session runtime, before the watch starts; what the status read waits on
  // once the watch is ready is the readiness check's read of the session's binding.
  const session = kit.pi.session.id
  let waiting = false
  const release = kit.disk.hold('read', (path) => {
    const holds = path.includes(`session_${session}`) && watches(again).length > 0
    waiting ||= holds
    return holds
  })
  const starting = again.pi.start()
  await again.until(() => waiting, 'the readiness check to wait')
  const ending = again.whileTimePasses(again.pi.shutdown('quit'))
  await again.settle()
  release()
  await ending
  await starting
  await again.advance(60_000)
  expect(watches(again)).toHaveLength(1)
  expect(statuses(again)).toEqual([])
  expect(again.running()).toEqual([])
})
