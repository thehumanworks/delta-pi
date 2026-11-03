// Automatic activation and offline recording, ported from the upstream plugin's engine tests
// (hooks/setup/auto.test.ts) onto the kit.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
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
