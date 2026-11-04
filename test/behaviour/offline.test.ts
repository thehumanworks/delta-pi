// Offline recording of a session that writes to its own thread, ported from the upstream plugin's engine
// tests (hooks/setup/auto.test.ts, "offline recording") onto the kit: records are acknowledged locally
// while Delta is unreachable or refuses them, prompts and turns go on, and an automatic activation that
// could not finish completes later.
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { type Kit, startDelta } from '../kit/index.ts'

let delta: Kit | undefined
afterEach(async () => {
  delta?.expectClean()
  await delta?.stop()
  delta = undefined
})

const PRIVATE = { mode: 'private', organization: 'org-1' }
const NOT_NOW = (dialog: { title: string }) => (dialog.title.includes('Set it up now?') ? 'Not now' : undefined)
/** Delta cannot be reached: status reads and appends fail as retryable. */
const OFFLINE = ['thread append', 'thread status']

const records = (kit: Kit): any[] => kit.thread()?.records ?? []
const delivered = (kit: Kit, text: string) => JSON.stringify(records(kit)).includes(text)
const ran = (kit: Kit, command: string) => kit.commands().filter((args) => args.join(' ').startsWith(command)).length
const binding = (kit: Kit): Promise<any> => kit.store.get(`session:${kit.pi.session.id}`)
const band = (kit: Kit) => kit.pi.statuses.get('delta') ?? ''
/** The replies pi stopped: none, while the extension only pauses delivery. */
const aborted = (kit: Kit) =>
  kit.pi.messages().filter((message) => message.role === 'assistant' && message.stopReason === 'aborted')
const appendedLocally = (kit: Kit) =>
  kit.commands().some((args) => args.includes('--acknowledge') && args.includes('local'))

/** A session in a repository that syncs `policy` automatically, once it watches its thread. */
async function recording(policy: Record<string, unknown> = PRIVATE) {
  const kit = await startDelta({ policy })
  await kit.until(() => ran(kit, 'thread watch'), 'the thread watch to start')
  return kit
}

/** Make Delta refuse the thread's recorded changes, as an append that keeps failing until resolved. */
const refuseChanges = (kit: Kit) => writeFileSync(join(kit.world.state, 'refuse-appends'), '')
const refusal = "Delta couldn't publish this thread's offline changes."

describe('offline recording', () => {
  test('a /delta share session records offline like an automatic one', async () => {
    delta = await startDelta({ answers: [NOT_NOW] })
    await delta.until(() => delta!.pi.dialogs.length === 1, 'the setup offer')
    delta.pi.answers.push((dialog) =>
      dialog.title.includes('Who should see this session?') ? 'Share with Zed' : undefined,
    )
    await delta.pi.command('delta', 'share')
    await delta.until(() => delta!.pi.noticeTexts().some((text) => text.startsWith('Delta: Shared')), 'the share')
    // A shared thread is registered, so Delta's background uploader pushes what it acknowledges locally:
    // delivery while Delta is unreachable neither blocks pi nor drops the prompt.
    for (const command of OFFLINE) delta.world.fail(command, { times: 1000, code: 'app_unavailable' })
    expect(await delta.pi.prompt('shared offline')).toBe('settled')
    expect(aborted(delta)).toEqual([])
    expect(appendedLocally(delta)).toBe(true)
    expect((await binding(delta)).pending.length).toBeGreaterThan(0)
    for (const command of OFFLINE) delta.world.stopFailing(command)
    await delta.advance(120_000)
    await delta.until(async () => (await binding(delta!)).pending.length === 0, 'the queued records to drain')
    expect(delivered(delta, 'Echo: shared offline')).toBe(true)
  })

  test('a non-retryable refusal pauses delivery but never drops a prompt or publishes', async () => {
    delta = await recording()
    delta.world.fail('thread append', { times: 1000, code: 'not_visible', retryable: false })
    expect(await delta.pi.prompt('one')).toBe('settled')
    await delta.until(
      () => delta!.pi.noticeTexts().some((text) => text.includes('not_visible')),
      'the pause to be shown',
    )
    expect((await binding(delta)).pending.length).toBeGreaterThan(0)
    // A delivery pause stops delivery, not pi: the next prompt retries and is accepted.
    expect(await delta.pi.prompt('next')).toBe('settled')
    await delta.advance(120_000)
    await delta.quiet()
    // The turns ran to their end, and an automatic session never publishes as recovery.
    expect(aborted(delta)).toEqual([])
    expect(ran(delta, 'thread share')).toBe(0)
    expect((await binding(delta)).pending.length).toBeGreaterThan(0)
    delta.world.stopFailing('thread append')
  })

  test('a refused offline append pauses delivery, keeps prompts, and shows both controls until resolved', async () => {
    delta = await recording()
    refuseChanges(delta)
    expect(await delta.pi.prompt('one')).toBe('settled')
    await delta.until(() => delta!.pi.noticeTexts().some((text) => text.startsWith(refusal)), 'the refusal')
    // The records stay queued and pi keeps working: the pause stops delivery, not the turn.
    expect((await binding(delta)).pending.length).toBeGreaterThan(0)
    expect(aborted(delta)).toEqual([])
    // The band says why delivery stopped and, having no buttons in pi, names both choices and the command
    // that offers them.
    await delta.until(() => band(delta!).includes('Fork & Restore or Discard: /delta resolve'), 'both controls')
    expect(band(delta)).toContain(refusal)
    // A further prompt is accepted and its records stay queued, not lost.
    expect(await delta.pi.prompt('still here')).toBe('settled')
    expect((await binding(delta)).pending.length).toBeGreaterThan(0)
    expect(band(delta)).toContain('Fork & Restore')
    // Resolving it elsewhere lets the next append succeed, which clears the choice.
    rmSync(join(delta.world.state, 'refuse-appends'))
    expect(await delta.pi.prompt('resolved elsewhere')).toBe('settled')
    await delta.until(async () => (await binding(delta!)).pending.length === 0, 'the queued records to drain')
    expect(delivered(delta, 'Echo: still here')).toBe(true)
    await delta.until(() => !band(delta!).includes('Fork & Restore'), 'the choice to clear')
    expect(aborted(delta)).toEqual([])
  })

  test('a failed discard after a fork stays paused with the controls and can fork again', async () => {
    delta = await recording()
    refuseChanges(delta)
    expect(await delta.pi.prompt('one')).toBe('settled')
    await delta.until(() => band(delta!).includes('Fork & Restore'), 'the refusal')
    // The discard fails after the fork, so the refusal stays and the person may try again.
    delta.world.fail('thread discard', { code: 'failed', retryable: false })
    const fork = (dialog: { options?: string[] }) => dialog.options?.find((option) => option.startsWith('Fork'))
    delta.pi.answers.push(fork)
    await delta.pi.command('delta', 'resolve')
    await delta.until(
      () => delta!.pi.noticeTexts().some((text) => text.startsWith("Delta could not resolve this thread's")),
      'the failed discard',
    )
    expect(ran(delta, 'thread fork')).toBe(1)
    expect(ran(delta, 'thread discard')).toBe(1)
    expect((await binding(delta)).pending.length).toBeGreaterThan(0)
    expect(band(delta)).toContain('Fork & Restore or Discard: /delta resolve')
    // Forking again forks, discards, and drains what was queued.
    delta.pi.answers.push(fork)
    await delta.pi.command('delta', 'resolve')
    await delta.until(async () => (await binding(delta!)).pending.length === 0, 'the queued records to drain')
    expect(ran(delta, 'thread fork')).toBe(2)
    expect(ran(delta, 'thread discard')).toBe(2)
    expect(delivered(delta, 'Echo: one')).toBe(true)
    expect(band(delta)).not.toContain('Fork & Restore')
  })

  // Create and attach leave the same staged binding until both finish, so holding attach covers the
  // window for either.
  test('a prompt and rows arriving during activation are accepted and drain once it completes', async () => {
    delta = await startDelta({ policy: { mode: 'organization', organization: 'org-1' }, start: false })
    const release = delta.world.hold('worktree attach')
    await delta.pi.start()
    await delta.until(() => ran(delta!, 'worktree attach'), 'the attach to start')
    // The thread exists but the checkout is not attached: a prompt must still be accepted, and its turn
    // must not be stopped, while activation is in flight.
    expect((await binding(delta)).thread).toBeUndefined()
    // A command the person runs is a row of its own, which pi commits as the next event reads it.
    await delta.pi.shell('echo during-attach')
    expect(await delta.pi.prompt('during attach')).toBe('settled')
    expect(aborted(delta)).toEqual([])
    release()
    await delta.advance(120_000)
    await delta.until(async () => (await binding(delta!))?.thread && delivered(delta!, 'during-attach'), 'the drain')
    expect(await binding(delta)).toMatchObject({ thread: delta.thread()!.thread_id, checkout: delta.world.checkout })
    await delta.until(async () => (await binding(delta!)).pending.length === 0, 'the queued records to drain')
    expect(delivered(delta, 'Echo: during attach')).toBe(true)
    expect(ran(delta, 'thread share')).toBe(0)
  })

  test('a session that ended before activation finished completes it on resume without dropping a prompt or stopping its turn', async () => {
    const base = await startDelta({ policy: PRIVATE, start: false })
    base.world.fail('thread create', { times: 1000, code: 'app_unavailable' })
    await base.pi.start()
    await base.until(
      () => base.pi.noticeTexts().some((text) => text.includes('Delta retries on your next prompt')),
      'the failed activation',
    )
    expect(await binding(base)).toMatchObject({
      autoUpload: { mode: 'private', organization: 'org-1' },
      snapshot: true,
    })
    expect((await binding(base)).thread).toBeUndefined()
    // A prompt before the end gives the session a conversation to resume, recorded locally meanwhile.
    expect(await base.pi.prompt('before the end')).toBe('settled')
    await base.whileTimePasses(base.pi.shutdown('quit'))
    expect((await binding(base)).endedAt).toEqual(expect.any(Number))

    base.world.stopFailing('thread create')
    delta = await startDelta({ world: base.world, session: base.pi.session })
    expect(await delta.pi.prompt('after resume')).toBe('settled')
    expect(aborted(delta)).toEqual([])
    await delta.advance(120_000)
    await delta.until(async () => (await binding(delta!)).thread, 'the activation to complete')
    expect(await binding(delta)).toMatchObject({ thread: delta.thread()!.thread_id, checkout: delta.world.checkout })
    expect((await binding(delta)).endedAt).toBeUndefined()
    expect(delta.thread()).toMatchObject({ organization: 'org-1', visibility: 'private' })
    await delta.until(() => delivered(delta!, 'Echo: after resume'), 'the resumed turn')
    expect(delivered(delta, 'Echo: before the end')).toBe(true)
    expect(ran(delta, 'thread share')).toBe(0)
    delta.expectClean()
    await delta.stop()
    delta = undefined
    base.expectClean()
    await base.stop()
  })

  // Not one of upstream's: a retryable failure whose work Delta did is retried like any other, and
  // creation is idempotent, so the retry finds the thread the lost reply never named.
  test('a create whose reply was lost finishes activation on the next prompt, in the thread it created', async () => {
    delta = await startDelta({ policy: PRIVATE, start: false })
    const lost = { error: { code: 'app_unavailable', message: 'the connection dropped', retryable: true } }
    delta.world.answer('thread create', { run: true, stdout: `${JSON.stringify(lost)}\n` })
    await delta.pi.start()
    const retries =
      "Delta couldn't start syncing this session: thread create: app_unavailable: the connection dropped. Nothing is lost; Delta retries on your next prompt."
    await delta.until(() => delta!.pi.noticeTexts().includes(retries), 'the transient failure')
    expect(band(delta)).toContain(retries)
    expect(delta.thread()).toBeDefined()
    expect((await binding(delta)).thread).toBeUndefined()
    expect(await delta.pi.prompt('after the lost reply')).toBe('settled')
    await delta.until(() => delivered(delta!, 'Echo: after the lost reply'), 'the prompt to reach the thread')
    expect(Object.keys(delta.world.delta().threads)).toEqual([delta.thread()!.thread_id])
    expect(await binding(delta)).toMatchObject({ thread: delta.thread()!.thread_id, checkout: delta.world.checkout })
    expect(band(delta)).not.toContain("couldn't start syncing")
    expect(ran(delta, 'thread share')).toBe(0)
  })

  test('a policy naming an organization the account is not in records nothing and explains once per repository', async () => {
    delta = await startDelta({ policy: { mode: 'organization', organization: 'org-other' } })
    const explained = () =>
      delta!.pi.noticeTexts().filter((text) => text.includes("org-other, which your Delta account isn't a member of"))
        .length
    await delta.until(() => band(delta!).includes("isn't in this repo's team"), 'the refusal on the band')
    await delta.until(() => explained() === 1, 'the explanation')
    // The membership check runs before staging, so nothing is created or queued.
    expect(ran(delta, 'thread create')).toBe(0)
    expect(await binding(delta)).toBeUndefined()
    expect(await delta.pi.prompt('one')).toBe('settled')
    expect(ran(delta, 'thread create')).toBe(0)
    expect(await binding(delta)).toBeUndefined()
    // The next new session in the repository keeps the band line without repeating the explanation,
    // which the store remembers per repository.
    const remembered = () => delta!.disk.touched('read').filter((path) => path.includes('auto-refused')).length
    const readBefore = remembered()
    await delta.whileTimePasses(delta.pi.newSessionIn())
    await delta.until(() => band(delta!).includes("isn't in this repo's team"), 'the band line again')
    await delta.until(() => remembered() > readBefore, 'the explanation to be looked up')
    expect(await delta.pi.prompt('two')).toBe('settled')
    expect(explained()).toBe(1)
    expect(ran(delta, 'thread create')).toBe(0)
  })

  test('a permanent refusal during activation stops recording and removes what was queued', async () => {
    delta = await startDelta({ policy: PRIVATE, start: false })
    // Memberships aren't loaded, so only the create itself can refuse.
    delta.world.organizations([])
    delta.world.fail('thread create', { code: 'not_visible', reason: 'organization_not_member', retryable: false })
    const release = delta.world.hold('thread create')
    await delta.pi.start()
    await delta.until(() => ran(delta!, 'thread create'), 'the create to start')
    expect(await delta.pi.prompt('during create')).toBe('settled')
    expect(aborted(delta)).toEqual([])
    const queued: string[] = (await binding(delta)).pending.flatMap((entry: any) => entry.files)
    expect(queued.length).toBeGreaterThan(0)

    release()
    await delta.until(async () => (await binding(delta!)) === undefined, 'the staged binding to be removed')
    expect(queued.filter((path) => existsSync(path))).toEqual([])
    await delta.until(() => band(delta!).includes("isn't in this repo's team"), 'the refusal on the band')
    // Nothing retries: the next prompt is accepted without another create or a new queue.
    expect(await delta.pi.prompt('after')).toBe('settled')
    await delta.advance(120_000)
    await delta.quiet()
    expect(ran(delta, 'thread create')).toBe(1)
    expect(await binding(delta)).toBeUndefined()
  })
})
