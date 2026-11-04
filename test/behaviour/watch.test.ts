// The thread watch: its readiness, reconnection and failures, and what ending a session while it starts
// leaves behind. Ported from the upstream plugin's engine tests (hooks/register.test.ts, "the watch") onto
// the kit.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
  await kit.quiet()
  const count = watches(kit).length
  await kit.advance(120_000)
  await kit.quiet()
  expect(watches(kit)).toHaveLength(count)
  expect(band(kit)).toContain('not_visible')
  // A delivery pause stops delivery, not pi: the prompt is accepted while the reason stays shown.
  expect(await kit.pi.prompt('after deletion')).toBe('settled')
  expect(band(kit)).toContain('not_visible')
})

/** A watch Delta ends with a non-retryable `code` pauses participation instead of reconnecting. */
const pausesOn = (code: string) => async () => {
  const kit = await shared()
  kit.world.endWatch(threadOf(kit), 1, {
    code,
    reason: code === 'failed' ? 'storage' : code,
    message: 'cannot continue',
    retryable: false,
  })
  await kit.until(() => band(kit).includes(code), 'the pause to be shown')
  await kit.quiet()
  const count = watches(kit).length
  await kit.advance(120_000)
  await kit.quiet()
  expect(watches(kit)).toHaveLength(count)
  expect(band(kit)).toContain(code)
  // The pause stops delivery, not pi: the prompt is accepted while the reason stays shown.
  expect(await kit.pi.prompt('while paused')).toBe('settled')
}
test('a non-retryable failed watch error pauses participation', pausesOn('failed'))
test('a non-retryable incompatible_app watch error pauses participation', pausesOn('incompatible_app'))

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
  /** Wait until the watch running now has been inspected: its status read ran and answered. */
  const live = async (inspections: number) => {
    await again.until(
      () => statuses(again).length > inspections && !again.running().some((args) => args[1] === 'status') && watching(),
      'the watch to be inspected',
    )
    await again.settle()
  }
  await again.until(() => band(again).startsWith(LIVE), 'the first watch to go live')
  // The first watch went live before it dropped, so the band waits out its grace.
  again.world.endWatch(thread)
  await again.until(() => !watching(), 'the watch to drop')
  expect(band(again).startsWith(LIVE)).toBe(true)
  await again.advance(999)
  await again.quiet()
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
  await again.quiet()
  expect(attempts()).toBe(2)
  await again.advance(1)
  await again.until(() => attempts() === 3 && watching(), 'the idle third attempt')
  expect(band(again).startsWith(LIVE)).toBe(true)
  // Past the grace, counted from the drop, the band admits to reconnecting.
  await again.advance(2000)
  await again.quiet()
  expect(band(again).startsWith(PENDING)).toBe(true)
  expect(statuses(again)).toHaveLength(inspections)
  // Participation lasts as long as a watch, so every reconnection asks for it again.
  expect(watches(again).every((args) => args.includes('--participate'))).toBe(true)
  await end(again)
  expect(watching()).toBe(false)
  await again.quiet()
  const ended = attempts()
  await again.advance(120_000)
  await again.quiet()
  expect(attempts()).toBe(ended)
})

/** Ending the session while startup's `nth` store read waits starts no watch for it. */
const endsDuringRead = (nth: 1 | 2) => async () => {
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
  await again.quiet()
  expect(watches(again)).toEqual([])
  expect(again.running()).toEqual([])
}
test('ending during startup store read 1 cannot start the watcher', endsDuringRead(1))
test('ending during startup store read 2 cannot start the watcher', endsDuringRead(2))

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
  await again.quiet()
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
  await again.quiet()
  expect(watches(again)).toHaveLength(1)
  expect(statuses(again)).toEqual([])
  expect(again.running()).toEqual([])
})

/** Change the fake Delta's state as Delta itself would, such as losing what it acknowledged. */
function editDelta(kit: Kit, change: (state: any) => void) {
  const path = join(kit.world.state, 'state.json')
  const state = JSON.parse(readFileSync(path, 'utf8'))
  change(state)
  writeFileSync(path, JSON.stringify(state, null, 2))
}

const appends = (kit: Kit) => kit.commands().filter((args) => args[0] === 'thread' && args[1] === 'append').length
/** The commands that create, attach or publish a thread or checkout, which a resume never runs again. */
const setupCommands = (kit: Kit) =>
  kit
    .commands()
    .map((args) => args.slice(0, 2).join(' '))
    .filter((command) =>
      ['thread create', 'thread share', 'thread invite', 'worktree create', 'worktree attach'].includes(command),
    )
/** The text of the records a binding has staged but Delta has not acknowledged. */
const stagedText = (pending: { files: string[] }[]) =>
  pending.flatMap((entry) => entry.files.map((file) => readFileSync(file, 'utf8'))).join('')

test('readiness with lost acknowledged history fails closed without reset or reimport', async () => {
  const kit = await shared()
  await end(kit)
  // Delta lost what it had acknowledged: the session's producer starts again at its first sequence.
  editDelta(kit, (state) => {
    for (const producer of Object.values<any>(state.producers)) producer.next = 1
  })
  const delivered = structuredClone(records(kit))
  // The share exported the conversation, its first prompt included.
  expect(JSON.stringify(delivered)).toContain('"text":"one"')
  const again = await resume(kit, false)
  const before = appends(again)
  await again.pi.start()
  await again.until(() => watches(again).length > 0, 'the watch to start')
  await again.advance(10_000)
  // A shell command run while Delta disagrees stays in the outbox.
  await again.pi.shell('echo queued while mismatched')
  await again.quiet()
  expect(appends(again)).toBe(before)
  expect(records(again)).toEqual(delivered)
  // The conversation was exported once, by the share: nothing stages it again.
  expect(stagedText((await binding(again)).pending)).not.toContain('"text":"one"')
  expect(await again.pi.prompt('continue')).toBe('handled')
  expect(appends(again)).toBe(before)
  expect(records(again)).toEqual(delivered)
  // Explicit sharing is not a reset either. The session is shared with Zed already, so the share keeps that.
  again.pi.answers.push((dialog) => dialog.options?.find((option) => option === 'Keep current sharing'))
  await again.pi.command('delta', 'share')
  await again.until(() => !band(again).includes('…'), 'the share to end')
  await again.quiet()
  expect(again.pi.noticeTexts().some((text) => text.startsWith('Delta: Shared'))).toBe(false)
  expect(again.pi.noticeTexts().at(-1)).toMatch(/^Delta sharing failed: Delta has lost acknowledged client history/)
  expect(appends(again)).toBe(before)
  expect(records(again)).toEqual(delivered)
  expect(stagedText((await binding(again)).pending)).not.toContain('"text":"one"')
  // The share attaches and publishes the same thread again before it waits for the watch; it creates none.
  expect(setupCommands(again)).toEqual(['worktree attach', 'thread share'])
})

test('unavailable inspection pauses participation and preserves binding and pending files across resume', async () => {
  const kit = await shared()
  let answer!: (text: string) => void
  kit.pi.model = () => new Promise((resolve) => (answer = (text) => resolve({ text })))
  const turn = kit.pi.submit('inspect')
  await kit.until(() => records(kit).some((record) => record.update.state === 'running'), 'the turn to start')
  // What the turn recorded so far has reached Delta before its checkout becomes unreadable.
  await kit.until(async () => (await binding(kit)).pending.length === 0, 'the turn so far to be delivered')
  await kit.until(() => !kit.running().some((args) => args[1] === 'status'), 'no status read in flight')
  const original = await binding(kit)
  const delivered = records(kit).length
  kit.world.patchStatus({
    worktrees: {
      status: 'unavailable',
      error: { code: 'failed', reason: 'storage', message: 'Attachment storage cannot be read' },
    },
  })
  answer('inspection-pending')
  await turn
  const saved = await kit.until(async () => {
    const current = await binding(kit)
    return current.pending.length && !kit.running().some((args) => args[1] === 'status') && current
  }, 'the turn to stay staged')
  expect(saved).toMatchObject({
    thread: original.thread,
    checkout: original.checkout,
    checkoutReference: original.checkoutReference,
    next: original.next + saved.pending.length,
    pending: [{ sequence: original.next }, ...saved.pending.slice(1)],
  })
  const files = new Map<string, string>(
    saved.pending.flatMap((entry: { files: string[] }) =>
      entry.files.map((file) => [file, readFileSync(file, 'utf8')]),
    ),
  )
  expect(stagedText(saved.pending)).toContain('inspection-pending')
  expect(await kit.pi.prompt('unsafe inspection')).toBe('handled')
  expect(kit.pi.noticeTexts().some((text) => text.includes('Attachment storage cannot be read'))).toBe(true)
  expect(records(kit)).toHaveLength(delivered)
  expect(await binding(kit)).toEqual(saved)
  await end(kit)
  const again = await resume(kit)
  await again.until(() => watches(again).length > 0, 'the watch to start')
  await again.advance(10_000)
  expect(await again.pi.prompt('still unavailable')).toBe('handled')
  expect(await binding(again)).toEqual(saved)
  for (const [path, contents] of files) expect(readFileSync(path, 'utf8')).toBe(contents)
  expect(setupCommands(again)).toEqual([])
  expect(records(again)).toHaveLength(delivered)
  await end(again)
  kit.world.patchStatus(undefined)
  const recovered = await resume(kit)
  await recovered.until(() => records(recovered).length > delivered, 'the staged turn to be delivered')
  expect(JSON.stringify(records(recovered).slice(delivered))).toContain('inspection-pending')
  await recovered.until(async () => (await binding(recovered)).pending.length === 0, 'the outbox to empty')
  expect(setupCommands(recovered)).toEqual([])
})

test('readiness processes turns and items while initial status is pending', async () => {
  const kit = await shared()
  await kit.pi.prompt('previous turn')
  const sequence = records(kit).findLast((record) => record.update.state === 'running').sequence
  await end(kit)
  // An execution the session left open, as one that ended mid-turn does: only the watch can close it.
  const saved = await binding(kit)
  await kit.store.set(`session:${kit.pi.session.id}`, {
    ...saved,
    execution: { sequence, turnId: 'previous-host-turn' },
  })
  const release = kit.world.hold('thread status')
  const again = await resume(kit, false)
  const starting = again.pi.start()
  await again.until(() => again.running().some((args) => args[1] === 'status'), 'the inspection to wait')
  const thread = threadOf(again)
  again.world.remote(
    thread,
    {
      type: 'item',
      item: {
        id: 'changed',
        kind: 'user_message',
        after_id: null,
        turn_id: null,
        author: { user_id: 'u-ada', name: 'Ada' },
        created_at: 1,
        open: false,
        content: { text: 'Changed during inspection' },
      },
    },
    { type: 'producer.turn', sequence, status: 'superseded' },
  )
  const recovered = await again.until(async () => {
    const current = await binding(again)
    return current.execution === undefined && current
  }, 'the superseded execution to be closed')
  expect(recovered.pending).not.toEqual([])
  expect(again.running().some((args) => args[1] === 'status')).toBe(true)
  release()
  await starting
  await again.until(async () => (await binding(again)).pending.length === 0, 'the closing record to be delivered')
  expect(setupCommands(again)).toEqual([])
})

/** A stopped observer's inspection that answers late, with a `failure` or a result, changes nothing. */
const lateInspection = (failure: boolean) => async () => {
  const kit = await shared()
  await end(kit)
  const saved = await binding(kit)
  // A resume clears the end marker, so it is not part of the preserved binding.
  delete saved.endedAt
  const release = kit.world.hold('thread status', { times: 1 })
  const first = await resume(kit, false)
  const starting = first.pi.start()
  await first.until(() => first.running().some((args) => args[1] === 'status'), 'the inspection to wait')
  await end(first)
  await starting
  const second = await resume(kit)
  await second.until(() => band(second).startsWith(LIVE), 'the restarted watch to be live')
  // The old inspection answers only now, after its observer stopped and a new one took over.
  if (failure) kit.world.fail('thread status', { code: 'unavailable', retryable: false })
  else kit.world.patchStatus({ url: 'https://delta.dev/join/old_inspection' })
  release()
  // The failure is used up once the old read answers with it. A result leaves no such sign, so the old
  // read gets a moment to answer; nothing below depends on it, since a stopped read's answer goes unheard.
  if (failure)
    await second.until(() => !existsSync(join(kit.world.state, 'fail-thread-status')), 'the old read to answer')
  else await new Promise((resolve) => setTimeout(resolve, 200))
  kit.world.stopFailing('thread status')
  kit.world.patchStatus(undefined)
  await second.settle()
  expect(await binding(second)).toEqual(saved)
  expect(band(second).startsWith(LIVE)).toBe(true)
  expect(await second.pi.prompt('after inspection restart')).toBe('settled')
}
test("a stopped observer's late status result cannot replace a restarted binding", lateInspection(false))
test("a stopped observer's late status error cannot replace a restarted binding", lateInspection(true))
