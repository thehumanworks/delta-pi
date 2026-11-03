// Automatic activation and offline recording, ported from the upstream plugin's engine tests
// (hooks/setup/auto.test.ts) onto the kit.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { FakeSession, type Kit, startDelta } from '../kit/index.ts'

let delta: Kit | undefined
afterEach(async () => {
  delta?.expectClean()
  await delta?.stop()
  delta = undefined
})

const PRIVATE = { mode: 'private', organization: 'org-1' }
const records = (kit: Kit): any[] => kit.thread()?.records ?? []
const delivered = (kit: Kit, text: string) => JSON.stringify(records(kit)).includes(text)
const ran = (kit: Kit, command: string) => kit.commands().some((args) => args.join(' ').startsWith(command))

test('a resumed session never activates', async () => {
  const base = await startDelta({ policy: { mode: 'organization', organization: 'org-1' }, start: false })
  // A session with a conversation already, as one resumed from before the repository synced.
  const session = new FakeSession('resumed-session', base.world.checkout, join(base.world.agentDir, 'resumed.jsonl'))
  session.entries.push({
    type: 'message',
    id: 'aaaaaaaa',
    parentId: null,
    timestamp: '',
    message: { role: 'user', content: [{ type: 'text', text: 'before' }], timestamp: 0 },
  })
  delta = await startDelta({ world: base.world, session })
  await delta.settle()
  await delta.pi.prompt('after')
  expect(ran(delta, 'thread create')).toBe(false)
  delta.expectClean()
  await delta.stop()
  delta = undefined
  await base.stop()
})

test('holds the first prompt and its turn until the automatic decision, so neither is lost', async () => {
  delta = await startDelta({ policy: PRIVATE, start: false })
  // Hold the contract check itself: the window before anything is staged.
  const release = delta.world.hold('thread contract')
  await delta.pi.start()
  const first = delta.pi.submit('first')
  await delta.settle()
  expect(delta.thread()).toBeUndefined()
  release()
  expect(await first).toBe('settled')
  await delta.until(() => delivered(delta!, 'Echo: first'), 'the first turn to reach Delta')
  const prompts = records(delta).filter((record) => record.update.sessionUpdate === 'user_message')
  expect(prompts.map((record) => record.update.content[0].text)).toEqual(['first'])
})

test('a CLI this extension cannot record against leaves automatic recording off and says which to update', async () => {
  delta = await startDelta({ policy: PRIVATE, start: false })
  delta.world.contract(1, 3)
  await delta.pi.start()
  await delta.until(
    () =>
      delta!.pi
        .noticeTexts()
        .some(
          (text) =>
            text === "This session isn't syncing: This Delta is too old for this extension. Update Delta to continue.",
        ),
    'the refusal',
  )
  await delta.pi.prompt('unrecorded')
  expect(delta.thread()).toBeUndefined()
})

test('a session that ends while its checkout is attached starts no watcher and gives no share advice', async () => {
  delta = await startDelta({ policy: PRIVATE, start: false })
  const release = delta.world.hold('worktree attach')
  await delta.pi.start()
  await delta.until(() => ran(delta!, 'worktree attach'), 'the attach to start')
  await delta.whileTimePasses(delta.pi.shutdown('quit'))
  release()
  await new Promise((resolve) => setTimeout(resolve, 300))
  await delta.settle()
  expect(ran(delta, 'thread watch')).toBe(false)
  expect(delta.pi.noticeTexts().filter((text) => text.includes('/delta-share'))).toEqual([])
})

test('keeps a prompt and its turn while Delta is unreachable, then delivers them once it is back', async () => {
  delta = await startDelta({ policy: PRIVATE })
  await delta.until(() => ran(delta!, 'thread watch'), 'the thread watch to start')
  for (const command of ['thread append', 'thread status'])
    delta.world.fail(command, { times: 1000, code: 'disconnected' })
  expect(await delta.pi.prompt('offline')).toBe('settled')
  // Records are appended with local acknowledgement, and the turn was not stopped.
  expect(delta.commands().some((args) => args.includes('--acknowledge') && args.includes('local'))).toBe(true)
  expect(delta.pi.noticeTexts().filter((text) => text.includes('stopped pi'))).toEqual([])
  expect(delivered(delta, 'Echo: offline')).toBe(false)
  for (const command of ['thread append', 'thread status']) delta.world.stopFailing(command)
  await delta.advance(120_000)
  await delta.until(() => delivered(delta!, 'Echo: offline'), 'the queued turn')
  const states = records(delta).filter((record) => record.update.sessionUpdate === 'state_update')
  expect(states.map((record) => record.update.state)).toEqual(['running', 'idle'])
})

test('Discard drops the refused changes and delivers the queued records', async () => {
  delta = await startDelta({ policy: PRIVATE })
  await delta.until(() => ran(delta!, 'thread watch'), 'the thread watch to start')
  writeFileSync(join(delta.world.state, 'refuse-appends'), '')
  expect(await delta.pi.prompt('one')).toBe('settled')
  await delta.until(
    () => delta!.pi.noticeTexts().some((text) => text.includes('Run /delta resolve')),
    'the refusal notice',
  )
  delta.pi.answers.push((dialog) => dialog.options?.find((option) => option.startsWith('Discard')))
  await delta.pi.command('delta', 'resolve')
  await delta.until(() => delivered(delta!, 'Echo: one'), 'the queued records')
  expect(ran(delta, 'thread discard')).toBe(true)
  expect(ran(delta, 'thread fork')).toBe(false)
})

const NOT_NOW = (dialog: { title: string }) => (dialog.title.includes('Set it up now?') ? 'Not now' : undefined)
/** The band as a client without pi's terminal shows it: one line, the status pi keeps under `delta`. */
const band = (kit: Kit) => kit.pi.statuses.get('delta') ?? ''
/** The reminder the band shows a session Delta does not sync, by what it tells the person. */
function reminderKind(kit: Kit): 'manual' | 'not set up' | 'none' {
  const text = band(kit)
  if (text.includes('Not syncing') && text.includes('/delta-share')) return 'manual'
  return text.includes('Not set up') && text.includes('/delta-setup') ? 'not set up' : 'none'
}
/** A dialog answer the test gives later: the dialog stays open until `answer` is called. */
function heldAnswer() {
  let answer!: (text: string | undefined) => void
  const held = () => new Promise<string | undefined>((resolve) => (answer = resolve))
  return { held, answer: (text: string | undefined) => answer(text) }
}

describe('automatic activation', () => {
  test('a new session without a policy never holds a prompt behind the open setup offer', async () => {
    const offer = heldAnswer()
    delta = await startDelta({ answers: [offer.held] })
    await delta.until(() => delta!.pi.dialogs.length === 1, 'the setup offer')
    let answered = false
    const submitted = delta.pi.submit('while the offer is open').then((result) => ((answered = true), result))
    await delta.until(() => answered, 'the prompt to run while the offer is still open')
    offer.answer('Not now')
    expect(await submitted).toBe('settled')
    await delta.until(
      () => delta!.pi.noticeTexts().some((text) => text.startsWith("Delta isn't set up here")),
      'the offer to be declined',
    )
  })

  test('quitting partway through setup offers it again', async () => {
    const wizard = heldAnswer()
    const base = await startDelta({ answers: ['Set up now', wizard.held] })
    // The wizard's first question is open and never answered.
    await base.until(() => base.pi.dialogs.length === 2, "the wizard's first question")
    const keys = await base.store.keys()
    const offered = keys.find((key) => key.startsWith('setup-offered:'))!
    expect(await base.store.get(offered)).toBe(true)
    await base.whileTimePasses(base.pi.shutdown('quit'))
    expect(await base.store.get(offered)).toBe(false)
    // The next session in the repository is offered setup again.
    delta = await startDelta({ world: base.world, answers: [NOT_NOW] })
    await delta.until(() => delta!.pi.dialogs.some((dialog) => dialog.title.includes('Set it up now?')), 'the offer')
    delta.expectClean()
    await delta.stop()
    delta = undefined
    base.expectClean()
    await base.stop()
  })

  const reminderCases: {
    title: string
    expected: ReturnType<typeof reminderKind>
    options?: Parameters<typeof startDelta>[0]
    arrange?: (kit: Kit) => Promise<void>
  }[] = [
    { title: 'band reminder: an unconfigured checkout is told how to set up', expected: 'not set up' },
    {
      title: 'band reminder: a Manual checkout is told how to share, not to set up',
      expected: 'manual',
      options: { policy: { mode: 'manual' } },
    },
    { title: 'band reminder: a headless session gets none', expected: 'none', options: { mode: 'print' } },
    {
      title: 'band reminder: a session with an unfinished join gets none',
      expected: 'none',
      // A join switched into this session and has not finished: pi started elsewhere than the thread's folder.
      arrange: async (kit) => {
        const session = kit.pi.session.id
        await kit.store.set(`session:${session}`, {
          session,
          snapshot: false,
          next: 1,
          pending: [],
          joinTransition: {
            session,
            cwd: kit.world.checkout,
            locator: 'x',
            thread: 'thread_x',
            owner: session,
            directory: join(kit.world.base, 'elsewhere'),
          },
        })
      },
    },
  ]
  for (const { title, expected, options, arrange } of reminderCases)
    test(title, async () => {
      delta = await startDelta({ ...options, start: false })
      // Every question is dismissed, as the upstream case answers none.
      delta.pi.answers.push(undefined, undefined)
      await arrange?.(delta)
      await delta.pi.start()
      await delta.settle()
      await delta.advance(0)
      await delta.until(
        () => expected === 'none' || reminderKind(delta!) === expected,
        `the band to show the ${expected} reminder`,
      )
      if (arrange) await delta.until(() => band(delta!).includes("couldn't finish joining"), 'the join failure')
      expect(reminderKind(delta)).toBe(expected)
      if (options?.mode === 'print') {
        // A headless session has no band at all, and is never offered setup.
        expect(delta.pi.statuses.get('delta')).toBeUndefined()
        expect(delta.pi.dialogs).toEqual([])
      }
      // The reminder lives on the band; the transcript never carries a line that a later share makes stale.
      const transcript = [...delta.pi.noticeTexts(), ...delta.stderr]
      expect(transcript.filter((text) => text.includes('Not syncing') || text.includes('Not set up'))).toEqual([])
    })

  test('the band switches from its reminder to Syncing as soon as the session is shared, and stays so on resume', async () => {
    const base = await startDelta({ answers: [undefined] })
    await base.until(() => reminderKind(base) === 'not set up', 'the setup reminder')
    // While the share runs, its progress takes the reminder's place.
    const release = base.world.hold('thread create')
    base.pi.answers.push((dialog) =>
      dialog.title.includes('Who should see this session?') ? 'Share with Zed' : undefined,
    )
    const sharing = base.pi.command('delta', 'share')
    await base.until(() => base.commands().some((args) => args.join(' ').startsWith('thread create')), 'the share')
    await base.until(() => reminderKind(base) === 'none', 'the share to replace the reminder')
    expect(band(base)).toContain('link appears when ready')
    release()
    await sharing
    await base.until(() => band(base).includes('Syncing'), 'the band to say Syncing')
    expect(reminderKind(base)).toBe('none')
    await base.whileTimePasses(base.pi.shutdown('quit'))
    delta = await startDelta({ world: base.world, session: base.pi.session })
    await delta.until(() => band(delta!).includes('Syncing'), 'the resumed band to say Syncing')
    expect(reminderKind(delta)).toBe('none')
    delta.expectClean()
    await delta.stop()
    delta = undefined
    base.expectClean()
    await base.stop()
  })
})

const DAY = 24 * 60 * 60 * 1000

describe('store retention', () => {
  /** Store a session that ended long ago, with its ledger; `overrides` change any binding field. */
  async function seedEnded(kit: Kit, id: string, overrides: Record<string, unknown> = {}) {
    const endedAt = kit.clock.now() - 10 * 365 * DAY
    await kit.store.set(`session:${id}`, { session: id, snapshot: true, next: 1, pending: [], endedAt, ...overrides })
    await kit.store.set(`appended:${id}`, { thread: 't', items: {} })
  }

  test('the store prunes a long-ended session through activation, and keeps every unsettled one', async () => {
    delta = await startDelta({ start: false, answers: [NOT_NOW] })
    await seedEnded(delta, 'expired')
    // Ended within the horizon: the kit's clock is not upstream's, so "recent" is a day ago.
    await seedEnded(delta, 'marked-recent', { endedAt: delta.clock.now() - DAY })
    await seedEnded(delta, 'keeper', { next: 5, pending: [{ sequence: 1, files: [], digest: 'x' }] })
    await seedEnded(delta, 'captured', { captureFailure: 'disk full' })
    await seedEnded(delta, 'joining', { joinTransition: { locator: 'x' } })
    await seedEnded(delta, 'live', { endedAt: undefined })
    await delta.pi.start()
    await delta.until(async () => {
      const keys = await delta!.store.keys()
      return !keys.includes('session:expired') && !keys.includes('appended:expired')
    }, 'the expired session to be pruned')
    const keys = await delta.store.keys()
    // Never a binding without an end marker, one within the horizon, or one something still needs.
    for (const id of ['live', 'marked-recent', 'keeper', 'captured', 'joining'])
      expect(keys).toEqual(expect.arrayContaining([`session:${id}`, `appended:${id}`]))
  })

  test('a session resumed in another process during pruning keeps its binding', async () => {
    delta = await startDelta({ start: false, answers: [NOT_NOW] })
    await seedEnded(delta, 'resumed')
    await seedEnded(delta, 'later')
    // Listing the store reads each binding once, and pruning reads each again before deciding. Hold
    // pruning's read of whichever binding it reads second: it has then read the first one.
    const binding = /session_(resumed|later)-/
    const reads = () => delta!.disk.touched('read').filter((path) => binding.test(path))
    const release = delta.disk.hold('read', binding, { after: 3 })
    await delta.pi.start()
    await delta.until(() => reads().length === 4, 'pruning to read its second session')
    const first = binding.exec(reads()[2]!)![1]!
    const second = first === 'resumed' ? 'later' : 'resumed'
    // A second pi process resumes the session pruning read first, which drops its end marker and
    // queues a record; nothing read before that may delete it afterwards.
    await delta.store.set(`session:${first}`, {
      session: first,
      snapshot: true,
      next: 2,
      pending: [{ sequence: 1, files: [], digest: 'x' }],
    })
    release()
    await delta.until(async () => !(await delta!.store.keys()).includes(`session:${second}`), 'pruning to finish')
    expect(await delta.store.get(`session:${first}`)).toMatchObject({ pending: [{ sequence: 1 }] })
  })
})

describe('the band on an automatic session', () => {
  /** Wait for the band to say `text`, moving the clock on a second at a time as Delta's upload is followed. */
  const bandSays = (kit: Kit, text: string) =>
    kit.until(async () => (await kit.advance(1_000), band(kit).includes(text)), `the band to say ${text}`)
  const link = (kit: Kit) => `https://delta.dev/join/share_${kit.thread()!.thread_id}`

  test('shows the link and its audience once Delta finishes the background upload, without a prompt or a share', async () => {
    delta = await startDelta({ policy: { mode: 'organization', organization: 'org-1' }, start: false })
    // `thread create` returns the upload intent before Delta registers the thread, so the first status
    // has no link. The upload is the band's operation, like a share's steps, so the one-row band shows it.
    delta.world.upload({ state: 'queued' })
    await delta.pi.start()
    await bandSays(delta, 'Waiting to sync…')
    // Delta registers the thread: the link appears, but the content upload still runs, so the
    // first-upload operation stays on the band's row.
    delta.world.upload({ state: 'uploading' })
    await bandSays(delta, link(delta))
    expect(band(delta)).toContain('Syncing to DeltaDB…')
    expect(band(delta)).not.toContain('Synced to DeltaDB')
    // Only Delta's confirmation of the content ends the first-upload operation.
    delta.world.upload({ state: 'uploaded' })
    await bandSays(delta, 'Synced to DeltaDB')
    expect(band(delta)).toContain(link(delta))
    expect(band(delta)).toContain('Shared with Zed')
    await delta.advance(5_000)
    expect(band(delta)).toContain(link(delta))
    expect(band(delta)).not.toContain('Synced to DeltaDB')
    // Organization mode reaches the organization through the upload, never through `thread share`.
    expect(ran(delta, 'thread share')).toBe(false)
  })

  const personalCases = [
    {
      mode: 'organization',
      title: 'a organization thread in a personal organization is synced, never shared, and offers no share control',
    },
    {
      mode: 'private',
      title: 'a private thread in a personal organization is synced, never shared, and offers no share control',
    },
  ] as const
  for (const { mode, title } of personalCases)
    test(title, async () => {
      // The fake account's login is `ada`, and its personal organization says so.
      delta = await startDelta({ policy: { mode, organization: 'org-personal' } })
      await bandSays(delta, "Synced with ada's Organization")
      expect(band(delta)).not.toContain('Shared with')
      // The one-line band is 200 columns, room for every control, so a share control would be drawn if offered.
      expect(band(delta)).not.toContain('/delta-share')
    })

  test('a failed background upload shows its reason on the band', async () => {
    delta = await startDelta({ policy: PRIVATE, start: false })
    // Delta registered the thread but rejected the content upload, so the link exists and the upload failed.
    delta.world.upload({ state: 'failed', error: 'storage quota exceeded' })
    await delta.pi.start()
    await bandSays(delta, 'Sync failed: storage quota exceeded')
    expect(band(delta)).toContain(link(delta))
    expect(band(delta)).not.toContain('Synced to DeltaDB')
  })

  test('follows the upload after activation even when the watcher never becomes ready', async () => {
    delta = await startDelta({ policy: PRIVATE, start: false })
    // The watcher never reports readiness, so only a status read made on its own can report the link.
    const release = delta.world.hold('thread watch')
    await delta.pi.start()
    await delta.until(() => ran(delta!, 'thread watch'), 'the watch to start')
    await bandSays(delta, link(delta))
    // The watch is still connecting, so the band's mark is the pending one, not the live one.
    expect(band(delta)).toMatch(/^◌/)
    release()
  })

  test('a private thread is labelled with its own organization and offers a share control that publishes the same thread', async () => {
    delta = await startDelta({ policy: { mode: 'private', organization: 'org-2' }, start: false })
    // The setting names an organization other than the current one, and status names none, as real CLIs
    // have answered; the band still names the setting's.
    delta.world.organizations([
      { id: 'org-1', name: 'Zed', current: true },
      { id: 'org-2', name: 'Personal', current: false },
    ])
    delta.world.upload({ state: 'uploaded', reportsOrganization: false })
    await delta.pi.start()
    await bandSays(delta, 'Synced with Personal')
    await delta.pi.prompt('before the share')
    const thread = delta.thread()!.thread_id
    const exported = () => records(delta!).filter((record) => record.update.sessionUpdate === 'user_message').length
    await delta.until(() => exported() === 1, 'the prompt to be recorded')
    // pi's band has no buttons: its share control names /delta-share, whose question offers the team.
    expect(band(delta)).toContain('/delta-share')
    delta.pi.answers.push((dialog) => dialog.options?.find((option) => option === 'Share with Personal'))
    await delta.pi.command('delta', 'share')
    await delta.until(() => ran(delta!, 'thread share'), 'the thread to be published')
    expect(delta.pi.dialogs.at(-1)?.options).toContain('Share with Personal')
    // The existing thread is published in place: no new thread, no re-export.
    await delta.until(() => delta!.pi.noticeTexts().some((text) => text.startsWith('Delta: Shared')), 'the share')
    expect(delta.thread()!.thread_id).toBe(thread)
    expect(delta.commands().filter((args) => args.join(' ').startsWith('thread create'))).toHaveLength(1)
    expect(exported()).toBe(1)
  })
})
