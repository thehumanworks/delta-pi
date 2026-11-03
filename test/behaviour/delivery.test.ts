// Delivery to Delta, its failures and the recording contract, ported from the upstream plugin's engine
// tests (hooks/register.test.ts: recording, native turns, the recording contract) onto the kit.
import { afterEach, expect, test } from 'vitest'
import { type Kit, startDelta } from '../kit/index.ts'

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
