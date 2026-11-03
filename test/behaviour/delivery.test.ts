// Delivery to Delta, its failures and the recording contract, ported from the upstream plugin's engine
// tests (hooks/register.test.ts: recording, native turns, the recording contract) onto the kit.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { echoModel, type Kit, type Reply, startDelta } from '../kit/index.ts'
import { binding, bindingPath, restart, staged } from './recorded.ts'

let delta: Kit | undefined
afterEach(async () => {
  delta?.expectClean()
  await delta?.stop()
  delta = undefined
})

const PRIVATE = { mode: 'private', organization: 'org-1' }
const NOT_NOW = (dialog: { title: string }) => (dialog.title.includes('Set it up now?') ? 'Not now' : undefined)

/** A session in a repository that syncs privately, once it watches its thread. */
async function recording() {
  const kit = await startDelta({ policy: PRIVATE })
  await kit.until(() => kit.commands().some((args) => args.includes('watch')), 'the thread watch to start')
  return kit
}

const run = (command: string): Reply => ({ calls: [{ name: 'bash', arguments: { command } }] })
const appends = (kit: Kit) => kit.commands().filter((args) => args[0] === 'thread' && args[1] === 'append').length
const records = (kit: Kit): any[] => kit.thread()?.records ?? []
const delivered = (kit: Kit, text: string) => JSON.stringify(records(kit)).includes(text)

test('a failed append shows the CLI error in the transcript once, keeps the record queued, and retries it', async () => {
  delta = await recording()
  await delta.pi.prompt('one')
  await delta.until(() => delivered(delta!, 'Echo: one'), 'the first turn')
  delta.world.fail('thread append', { times: 100, code: 'failed' })
  await delta.pi.prompt('two')
  const shown = () => delta!.pi.noticeTexts().filter((text) => text.includes('failed as the test asked'))
  await delta.until(() => shown().length, 'the failure to be shown')
  await delta.advance(10_000)
  expect(delivered(delta, 'Echo: two')).toBe(false)
  // Nothing else happens to trigger delivery: the retry is scheduled by the failure itself.
  delta.world.stopFailing('thread append')
  await delta.advance(60_000)
  await delta.until(() => delivered(delta!, 'Echo: two'), 'the queued turn to be delivered on retry')
  expect(shown()).toHaveLength(1)
  expect(records(delta).map((record) => record.sequence)).toEqual(records(delta).map((_, index) => index + 1))
})

test('a permanent append failure pauses with its reason instead of retrying a poison record', async () => {
  delta = await recording()
  await delta.pi.prompt('one')
  await delta.until(() => delivered(delta!, 'Echo: one'), 'the first turn')
  delta.world.fail('thread append', { times: 100, code: 'invalid_record', retryable: false })
  await delta.pi.prompt('poison')
  const paused = () => delta!.pi.noticeTexts().filter((text) => text.includes('invalid_record'))
  await delta.until(() => paused().length, 'the pause to be shown')
  const attempts = appends(delta)
  await delta.advance(120_000)
  expect(appends(delta)).toBe(attempts)
  // The pause stops delivery, not pi: the next prompt is accepted, retries delivery once, and the reason
  // is shown once.
  expect(await delta.pi.prompt('still refused')).toBe('settled')
  expect(appends(delta)).toBeGreaterThan(attempts)
  expect(paused()).toHaveLength(1)
  // Once the cause is repaired, the next prompt delivers everything, in order.
  delta.world.stopFailing('thread append')
  await delta.pi.prompt('repaired')
  await delta.until(() => delivered(delta!, 'Echo: repaired'), 'the queued records')
  expect(records(delta).map((record) => record.sequence)).toEqual(records(delta).map((_, index) => index + 1))
  expect(delivered(delta, 'Echo: poison')).toBe(true)
})

test('a failure that lands after its session ended is neither retried nor shown', async () => {
  delta = await recording()
  await delta.pi.prompt('one')
  await delta.until(() => delivered(delta!, 'Echo: one'), 'the first turn')
  const release = delta.world.hold('thread append')
  delta.world.fail('thread append', { code: 'failed' })
  void delta.pi.submit('in flight')
  await delta.until(() => appends(delta!) >= 2, 'the append to start')
  const notices = delta.pi.notices.length
  await delta.whileTimePasses(delta.pi.newSessionIn())
  const attempts = appends(delta)
  release()
  await delta.settle()
  await delta.advance(120_000)
  // Only the new session's own commands may run; the ended one's failure is not retried for it.
  const ended = delta.pi.notices.slice(notices).filter((notice) => notice.text.includes('failed as the test asked'))
  expect(ended).toEqual([])
  expect(appends(delta)).toBeLessThanOrEqual(attempts + 1)
})

test('a CLI newer than this extension asks the person to update the extension', async () => {
  delta = await startDelta({ answers: [NOT_NOW] })
  await delta.until(() => delta!.pi.dialogs.length === 1, 'the setup offer')
  delta.world.contract(9, 10)
  await delta.pi.command('delta', 'share')
  await delta.until(
    () => delta!.pi.noticeTexts().some((text) => text.includes('Update the Delta extension for pi')),
    'the refusal',
  )
  expect(delta.thread()).toBeUndefined()
})

test('an out-of-range recording contract refuses to share, and a later retry checks again', async () => {
  delta = await startDelta({ answers: [NOT_NOW] })
  await delta.until(() => delta!.pi.dialogs.length === 1, 'the setup offer')
  delta.world.contract(7, 7)
  await delta.pi.command('delta', 'share')
  await delta.until(() => delta!.pi.noticeTexts().some((text) => text.includes('This Delta is too old')), 'the refusal')
  expect(delta.thread()).toBeUndefined()
  delta.world.contract(8, 8)
  delta.pi.answers.push((dialog) => (dialog.title.includes('Who should see') ? 'Share with Zed' : undefined))
  await delta.pi.command('delta', 'share')
  await delta.until(() => delta!.thread()?.url, 'the session to be shared')
})

test('the recording contract is checked once per session, not per command', async () => {
  delta = await recording()
  await delta.pi.prompt('one')
  await delta.pi.prompt('two')
  await delta.pi.command('delta', 'link')
  await delta.until(() => delivered(delta!, 'Echo: two'), 'both turns')
  expect(delta.commands().filter((args) => args.join(' ') === 'thread contract')).toHaveLength(1)
})

test('live turns report the installed extension version and only confirmed finish reasons', async () => {
  delta = await recording()
  delta.pi.model = () => ({ text: 'cut short', stopReason: 'length' })
  await delta.pi.prompt('one')
  delta.pi.model = () => ({ text: 'done' })
  await delta.pi.prompt('two')
  await delta.until(() => records(delta!).filter((record) => record.update.state === 'idle').length === 2, 'both turns')
  const { version } = JSON.parse(
    await import('node:fs').then((fs) => fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')),
  ) as { version: string }
  const starts = records(delta).filter((record) => record.update.state === 'running')
  expect(starts.map((record) => record.update._meta?.delta?.producer_version)).toEqual([version, version])
  const finishes = records(delta).filter((record) => record.update.state === 'idle')
  expect(finishes.map((record) => record.update.stopReason)).toEqual([undefined, 'end_turn'])
})

test('a queued own finish does not block a new prompt', async () => {
  delta = await recording()
  await delta.pi.prompt('one')
  await delta.until(() => delivered(delta!, 'Echo: one'), 'the first turn')
  const release = delta.world.hold('thread append')
  // The first turn's finish cannot be delivered while appends are held; the turn still ends.
  await delta.whileTimePasses(delta.pi.prompt('two'))
  // The next prompt is accepted at once, and its turn ends within its own delivery budget.
  expect(await delta.whileTimePasses(delta.pi.prompt('three'))).toBe('settled')
  release()
  await delta.until(() => delivered(delta!, 'Echo: three'), 'every turn')
  const states = records(delta)
    .filter((record) => record.update.sessionUpdate === 'state_update')
    .map((record) => record.update.state)
  expect(states).toEqual(['running', 'idle', 'running', 'idle', 'running', 'idle'])
})

/** Share with Zed, or keep a session already shared with Zed so. */
const SHARE_WITH_ZED = (dialog: { title: string; options?: string[] }) =>
  dialog.options?.find((option) => option === 'Share with Zed' || option === 'Keep current sharing')
const sequences = (kit: Kit) => records(kit).map((record) => record.sequence)
const pending = async (kit: Kit): Promise<number[]> =>
  ((await binding(kit))?.pending ?? []).map((entry: { sequence: number }) => entry.sequence)
/** The outbox's files for the session, by name. */
const outboxFiles = (kit: Kit): string[] => {
  const folder = join(kit.world.agentDir, 'delta', 'outbox', kit.pi.session.id)
  return existsSync(folder) ? readdirSync(folder).sort() : []
}

/** A session with a conversation so far, not yet shared. */
async function unshared(...prompts: string[]) {
  const kit = await startDelta({ answers: [NOT_NOW] })
  await kit.until(() => kit.pi.dialogs.length === 1, 'the setup offer')
  for (const prompt of prompts) await kit.pi.prompt(prompt)
  return kit
}

/** `/delta share` with Zed, as the person answers, until the share has finished one way or another. */
async function share(kit: Kit) {
  const shown = kit.pi.notices.length
  kit.pi.answers.push(SHARE_WITH_ZED)
  await kit.pi.command('delta', 'share')
  await kit.until(
    () =>
      kit.pi
        .noticeTexts()
        .slice(shown)
        .find((text) => text.startsWith('Delta: Shared') || text.includes('failed')),
    'the share to finish',
  )
  return kit.pi.noticeTexts().slice(shown)
}

/** A model that answers each request with the reply the test gives it, once the request has arrived. */
function heldModel(kit: Kit) {
  const waiting: ((reply: Reply) => void)[] = []
  kit.pi.model = () => new Promise((resolve) => waiting.push(resolve))
  return {
    async reply(reply: Reply) {
      await kit.until(() => waiting.length > 0, 'the model to be asked')
      waiting.shift()!(reply)
    },
    waiting: () => waiting.length,
  }
}

test('a partial append retains exactly the unacknowledged suffix and never restages the export', async () => {
  delta = await unshared('one')
  // Delta accepts the export's first record, then the append fails, and keeps failing until the
  // session has ended.
  delta.world.fail('thread append', { accept: 1, code: 'failed' })
  expect((await share(delta)).join('\n')).toContain('failed as the test asked')
  delta.world.fail('thread append', { times: 1000, code: 'failed' })
  expect(sequences(delta)).toEqual([1])
  // The export is the prompt, its reply and the thread's title; all but the first stay queued.
  const saved = await binding(delta)
  expect(saved).toMatchObject({ thread: delta.thread()!.thread_id, snapshot: true, next: 4 })
  expect(saved.pending.map((entry: { sequence: number }) => entry.sequence)).toEqual([2, 3])
  const exported = saved.pending.map((entry: { files: string[] }) => readFileSync(entry.files[0]!, 'utf8'))
  expect(exported[0]).toContain('Echo: one')
  expect(delta.thread()!.url).toBeTruthy()
  // A conversation that changed while the session was away never replaces the staged export.
  await delta.whileTimePasses(delta.pi.shutdown('quit'))
  delta.pi.session.entries.push({
    type: 'message',
    id: 'compacted',
    parentId: delta.pi.session.entries.at(-1)?.id ?? null,
    timestamp: '',
    message: { role: 'user', content: [{ type: 'text', text: 'compacted-away' }], timestamp: 0 },
  })
  await delta.pi.start('resume')
  delta.world.stopFailing('thread append')
  expect((await share(delta)).join('\n')).not.toContain('failed')
  await delta.until(async () => (await pending(delta!)).length === 0, 'the suffix to be delivered')
  expect(sequences(delta)).toEqual([1, 2, 3])
  const lines = records(delta)
    .slice(1)
    .map(({ producer: _producer, acknowledge: _acknowledge, name: _name, ...line }) => `${JSON.stringify(line)}\n`)
  expect(lines).toEqual(exported)
  expect((await binding(delta)).next).toBe(4)
  expect(JSON.stringify(records(delta))).not.toContain('compacted-away')
  for (const file of outboxFiles(delta))
    expect(
      readFileSync(join(delta.world.agentDir, 'delta', 'outbox', delta.pi.session.id, file), 'utf8'),
    ).not.toContain('compacted-away')
})

test('a lost acknowledgment replays identical records and accepts the advanced cumulative frontier', async () => {
  delta = await unshared('one', 'two')
  // Delta accepts every exported record, and its answer is lost.
  const lost = { error: { code: 'app_unavailable', message: 'the connection dropped', retryable: true } }
  delta.world.answer('thread append', { run: true, stdout: `${JSON.stringify(lost)}\n` })
  expect((await share(delta)).join('\n')).toContain('the connection dropped')
  // The export: two prompts, their replies, and the thread's title.
  const accepted = structuredClone(records(delta))
  expect(accepted.map((record) => record.sequence)).toEqual([1, 2, 3, 4, 5])
  expect(await pending(delta)).toEqual([1, 2, 3, 4, 5])
  // Sharing again sends the same records, which Delta acknowledges as already recorded.
  expect((await share(delta)).join('\n')).not.toContain('failed')
  await delta.until(async () => (await pending(delta!)).length === 0, 'the replay to be acknowledged')
  expect(records(delta)).toEqual(accepted)
  expect((await binding(delta)).next).toBe(6)
  // Nothing remains pending: the next turn takes the next sequences.
  await delta.pi.prompt('after replay')
  await delta.until(() => delivered(delta!, 'Echo: after replay'), 'the next turn')
  expect(sequences(delta)).toEqual(sequences(delta).map((_, index) => index + 1))
  expect(records(delta).slice(0, 5)).toEqual(accepted)
})

test('an acknowledgment that cannot be saved replays the exact marked record after restart', async () => {
  delta = await recording()
  const { pi } = delta
  await pi.prompt('one')
  await delta.until(async () => (await binding(delta!))?.title && !(await pending(delta!)).length, 'the first turn')
  const model = heldModel(delta)
  const turn = pi.submit('two')
  await delta.until(async () => model.waiting() && !(await pending(delta!)).length, 'the turn to run')
  const marked = (await binding(delta)).next
  // Staging succeeds; only saving Delta's acknowledgment of the reply fails.
  let failed = false
  delta.disk.fail(
    'write',
    (path) => !failed && path === bindingPath(delta!) && sequences(delta!).includes(marked) && (failed = true),
    { times: 1 },
  )
  await model.reply({ text: 'unsaved-ack' })
  await delta.until(() => failed, 'the acknowledgment to fail to save')
  const immutable = (await staged(delta)).find((record) => record.sequence === marked)
  expect(immutable.update._meta).toEqual({
    delta: { work_origin: 'external_agent', interaction_surface: 'cli', activity_kind: 'agent_message' },
  })
  const attempts = appends(delta)
  await delta.whileTimePasses(turn)
  await restart(delta)
  await delta.until(async () => !(await pending(delta!)).length, 'the replay to be acknowledged')
  expect(appends(delta)).toBeGreaterThan(attempts)
  const replayed = records(delta).filter((record) => record.sequence === marked)
  expect(replayed).toHaveLength(1)
  const { producer: _producer, acknowledge: _acknowledge, name: _name, ...line } = replayed[0]
  expect(line).toEqual(immutable)
  pi.model = echoModel
  await pi.prompt('after')
  await delta.until(() => delivered(delta!, 'Echo: after'), 'the next turn')
  expect(sequences(delta)).toEqual(sequences(delta).map((_, index) => index + 1))
})

test('a detached checkout pauses delivery until a later successful check lifts the pause it set', async () => {
  delta = await recording()
  const { pi } = delta
  await pi.prompt('one')
  await delta.until(async () => (await binding(delta!))?.title && !(await pending(delta!)).length, 'the first turn')
  const model = heldModel(delta)
  const turn = pi.submit('two')
  await delta.until(async () => model.waiting() && !(await pending(delta!)).length, 'the turn to run')
  const sent = sequences(delta).length
  delta.world.detach(delta.thread()!.thread_id)
  await model.reply(run('echo while-detached'))
  await delta.until(() => pi.noticeTexts().some((text) => text.includes('detached')), 'the pause')
  await delta.settle()
  const queued = await pending(delta)
  expect(queued.length).toBeGreaterThan(0)
  expect(sequences(delta)).toHaveLength(sent)
  // The pause is latched: reattachment alone does not restart delivery.
  delta.world.detach(delta.thread()!.thread_id, false)
  await model.reply({ text: 'still-paused' })
  await delta.whileTimePasses(turn)
  await delta.advance(120_000)
  await delta.settle()
  expect(sequences(delta)).toHaveLength(sent)
  expect((await pending(delta)).length).toBeGreaterThan(queued.length)
  // A prompt checks the checkout again, which lifts the pause that a failed check set.
  pi.model = () => ({ text: 'Echo: resumed' })
  expect(await pi.prompt('after reattachment')).toBe('settled')
  await delta.until(() => delivered(delta!, 'Echo: resumed'), 'the queued records')
  await delta.until(async () => !(await pending(delta!)).length, 'the outbox to be delivered')
  expect(sequences(delta)).toEqual(sequences(delta).map((_, index) => index + 1))
  expect(JSON.stringify(records(delta))).toContain('still-paused')
})

test('a growing backlog reports the same reason once, and ending the session cancels and resets its retry', async () => {
  delta = await recording()
  const { pi } = delta
  await pi.prompt('one')
  await delta.until(async () => (await binding(delta!))?.title && !(await pending(delta!)).length, 'the first turn')
  delta.world.fail('thread append', { times: 1000, code: 'failed' })
  // Each turn's delivery fails, so each failure carries a larger batch; the reason is shown once.
  for (const prompt of ['first', 'second', 'third']) await delta.whileTimePasses(pi.prompt(prompt))
  const shown = () => pi.noticeTexts().filter((text) => text.includes('failed as the test asked'))
  expect(shown()).toHaveLength(1)
  // Ending the session cancels its retry.
  await delta.whileTimePasses(pi.shutdown('quit'))
  const attempts = appends(delta)
  await delta.advance(120_000)
  await delta.settle()
  expect(appends(delta)).toBe(attempts)
  // The resumed session starts its backoff over rather than inheriting the old attempts.
  delta.world.fail('thread append', { times: 1, code: 'failed' })
  await pi.start('resume')
  await delta.until(() => appends(delta!) > attempts, 'the resumed session to try once')
  await delta.settle()
  expect(appends(delta)).toBe(attempts + 1)
  await delta.advance(2_000)
  await delta.until(async () => !(await pending(delta!)).length, 'the retry to deliver the backlog')
  expect(appends(delta)).toBe(attempts + 2)
  expect(sequences(delta)).toEqual(sequences(delta).map((_, index) => index + 1))
})

test('a drain that fails after its session ended cannot revive the session with a pause', async () => {
  delta = await recording()
  const { pi } = delta
  await pi.prompt('one')
  await delta.until(async () => (await binding(delta!))?.title && !(await pending(delta!)).length, 'the first turn')
  const model = heldModel(delta)
  const turn = pi.submit('two')
  await delta.until(async () => model.waiting() && !(await pending(delta!)).length, 'the turn to run')
  // The checkout check of the next delivery waits, and then Delta refuses it.
  const release = delta.world.hold('thread status')
  delta.world.fail('thread status', { code: 'not_visible', retryable: false })
  const checks = delta.commands().filter((args) => args[1] === 'status').length
  await model.reply({ text: 'in flight' })
  await delta.until(() => delta!.commands().filter((args) => args[1] === 'status').length > checks, 'the check')
  // pi quits without stopping its run; the refusal lands once the session has ended.
  await delta.whileTimePasses(pi.shutdown('quit'))
  release()
  await turn
  await delta.settle()
  // The resumed session is not paused by the old one's refused check, so it delivers what was queued.
  await pi.start('resume')
  await delta.until(() => delivered(delta!, 'in flight'), 'the queued records')
  await delta.until(async () => !(await pending(delta!)).length, 'the outbox to be delivered')
  expect(sequences(delta)).toEqual(sequences(delta).map((_, index) => index + 1))
  expect(
    pi.noticeTexts().filter((text) => text.includes('not_visible') || text.includes('failed as the test')),
  ).toEqual([])
})

test('outbox collection follows durable acknowledgments and never blocks delivery', async () => {
  delta = await startDelta({ policy: { mode: 'private', organization: 'org-1' }, start: false })
  const { pi } = delta
  const folder = join(delta.world.agentDir, 'delta', 'outbox', pi.session.id)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'notes.json'), 'not a record')
  // Removing delivered records fails: delivery goes on, and the files stay.
  const removal = delta.disk.fail('remove', '/outbox/', { times: Infinity })
  await pi.start()
  await delta.until(() => delta!.commands().some((args) => args.includes('watch')), 'the thread watch to start')
  await pi.prompt('one')
  await delta.until(async () => (await binding(delta!))?.title && !(await pending(delta!)).length, 'the first turn')
  await delta.until(() => pi.noticeTexts().some((text) => text.includes('could not be removed')), 'the warning')
  const first = outboxFiles(delta).filter((name) => name !== 'notes.json')
  expect(first.length).toBeGreaterThan(0)
  // The next records are staged but not delivered, so collection keeps them.
  removal()
  delta.world.fail('thread append', { times: 1000, code: 'failed' })
  await delta.whileTimePasses(pi.prompt('pending'))
  const queued = await pending(delta)
  expect(queued.length).toBeGreaterThan(0)
  await restart(delta)
  await delta.until(() => first.every((name) => !outboxFiles(delta!).includes(name)), 'the delivered files to go')
  const kept = outboxFiles(delta)
  expect(kept).toContain('notes.json')
  for (const sequence of queued) expect(kept).toContain(`${sequence}-0.json`)
  expect(readFileSync(join(folder, 'notes.json'), 'utf8')).toBe('not a record')
  // Delivery completes while the collector is blocked and failing.
  delta.disk.fail('remove', '/outbox/', { times: Infinity })
  const listing = delta.disk.hold('list', '/outbox/')
  delta.world.stopFailing('thread append')
  await delta.advance(60_000)
  await delta.until(async () => !(await pending(delta!)).length, 'the queued records to be delivered')
  expect(sequences(delta)).toEqual(sequences(delta).map((_, index) => index + 1))
  listing()
  await delta.settle()
  delta.disk.reset()
  await restart(delta)
  await delta.until(() => outboxFiles(delta!).join() === 'notes.json', 'only the unrelated file to remain')
})

test("an ended session's append that outlasts its budget is not delivered again beside the resumed session's", async () => {
  const ended = await recording()
  try {
    await ended.pi.prompt('one')
    await ended.until(async () => (await binding(ended))?.title && !(await pending(ended)).length, 'the first turn')
    // Delta is slow: the session's last append outlasts its shutdown budget and goes on after it ends.
    ended.world.hold('thread append')
    await ended.whileTimePasses(ended.pi.prompt('two'))
    await ended.whileTimePasses(ended.pi.shutdown('quit'))
    // The session resumes in the same pi process while that append is under way. The held append
    // stays held; Delta would take the resumed session's at once.
    ended.world.hold('thread append', { after: 1000 })
    delta = await startDelta({ world: ended.world, session: ended.pi.session })
    await delta.whileTimePasses(delta.pi.prompt('three'))
    // The resumed session waits for that append rather than acknowledging the same records beside it.
    expect(appends(delta)).toBe(0)
    delta.world.stopHolding('thread append')
    await delta.until(() => delivered(delta!, 'Echo: three'), "the resumed session's turn")
    await delta.until(async () => !(await pending(delta!)).length, 'the outbox to be delivered')
    expect(sequences(delta)).toEqual(sequences(delta).map((_, index) => index + 1))
    const states = records(delta).filter((record) => record.update.sessionUpdate === 'state_update')
    expect(states.map((record) => record.update.state)).toEqual([
      'running',
      'idle',
      'running',
      'idle',
      'running',
      'idle',
    ])
  } finally {
    delta?.expectClean()
    await delta?.stop()
    delta = undefined
    await ended.stop()
  }
})

test('records a failing disk could not save outlive their session in the pi process, and a share saves them', async () => {
  delta = await recording()
  const { pi } = delta
  await pi.prompt('one')
  await delta.until(async () => (await binding(delta!))?.title && !(await pending(delta!)).length, 'the first turn')
  // The disk refuses every outbox write: the turn is stopped, and what it said is kept in memory.
  const disk = delta.disk.fail('write', '/outbox/', { times: Infinity })
  await delta.whileTimePasses(pi.prompt('kept in memory'))
  expect(pi.aborts).toBe(1)
  // The session ends while the disk still fails, so its end cannot save them either.
  await delta.whileTimePasses(pi.shutdown('quit'))
  expect(delivered(delta, 'kept in memory')).toBe(false)
  disk()
  // Resumed in the same pi process, the session still holds them: capture stays paused until a share
  // saves and delivers them.
  await pi.start('resume')
  expect(await pi.prompt('refused')).toBe('handled')
  expect(pi.noticeTexts().at(-1)).toContain('local conversation capture is paused')
  pi.answers.push((dialog) => dialog.options?.find((option) => option.startsWith('Keep current sharing')))
  await pi.command('delta', 'share')
  await delta.until(() => delivered(delta!, 'kept in memory'), 'the kept records')
  await delta.until(async () => !(await pending(delta!)).length, 'the outbox to be delivered')
  expect(sequences(delta)).toEqual(sequences(delta).map((_, index) => index + 1))
  await delta.until(() => pi.noticeTexts().some((text) => text.startsWith('Delta: ')), 'the share to finish')
  expect(await pi.prompt('recorded again')).toBe('settled')
  await delta.until(() => delivered(delta!, 'Echo: recorded again'), 'the next turn')
})
