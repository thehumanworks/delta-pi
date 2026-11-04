import { afterEach, expect, test } from 'vitest'
import { type Kit, startDelta } from '../kit/index.ts'
import {
  binding,
  checkouts,
  exports,
  MANUAL,
  ran,
  records,
  setupCommands,
  share,
  staged,
  unlisted,
} from './sharing-kit.ts'

let delta: Kit | undefined
afterEach(async () => {
  delta?.expectClean()
  await delta?.stop()
  delta = undefined
})

const NOT_NOW = (dialog: { title: string }) => (dialog.title.includes('Set it up now?') ? 'Not now' : undefined)

test('/delta share during a turn asks who should see the session once the turn ends, then shares it', async () => {
  delta = await startDelta({ answers: [NOT_NOW] })
  const { pi } = delta
  await delta.until(() => pi.dialogs.length === 1, 'the setup offer')
  let answer: ((text: string) => void) | undefined
  pi.model = () => new Promise((resolve) => (answer = (text) => resolve({ text })))
  const turn = pi.submit('a long task')
  await delta.until(() => answer, 'the turn to run')
  pi.answers.push((dialog) => (dialog.title.includes('Who should see this session?') ? 'Share with Zed' : undefined))
  await pi.command('delta', 'share')
  expect(pi.noticeTexts()).toContain('Delta will share this session once the current pi turn ends.')
  // Nothing is shared, or asked, while the turn runs.
  expect(pi.dialogs).toHaveLength(1)
  expect(delta.thread()).toBeUndefined()
  answer!('Finished.')
  await turn
  // The conversation so far, the turn that ran during the request included, is exported.
  const thread = await delta.until(
    () => JSON.stringify(delta!.thread()?.records ?? []).includes('Finished.') && delta!.thread(),
    'the session and its conversation to be shared',
  )
  expect(thread.url).toBeTruthy()
  expect(thread.visibility).toBe('organization')
  expect(pi.errors).toEqual([])
})

test('a shell command run before a share is exported once, not recorded again with the next turn', async () => {
  delta = await startDelta({ answers: [NOT_NOW] })
  const { pi } = delta
  await delta.until(() => pi.dialogs.length === 1, 'the setup offer')
  await pi.prompt('one')
  await pi.shell('echo unique-shell')
  pi.answers.push((dialog) => (dialog.title.includes('Who should see this session?') ? 'Share with Zed' : undefined))
  await pi.command('delta', 'share')
  // A prompt waits for the share's result, which comes once the link is published and the watch started.
  await delta.until(() => pi.noticeTexts().some((text) => text.startsWith('Delta: Shared')), 'the share to finish')
  await pi.prompt('two')
  const thread = await delta.until(
    () => JSON.stringify(delta!.thread()?.records ?? []).includes('Echo: two') && delta!.thread(),
    'the next turn',
  )
  const shells = thread.records.filter((record: any) => JSON.stringify(record.update).includes('unique-shell'))
  expect(shells).toHaveLength(1)
})

// Upstream's engine tests of /delta share (hooks/register.test.ts, "sharing"), on the kit: a share's
// first export, its failures before publication, and what a retry finds.

test('first share binds and publishes the checkout, and repeating it does not reimport', async () => {
  delta = await startDelta({ policy: MANUAL })
  const { pi } = delta
  await pi.prompt('first')
  await pi.prompt('second')
  // A session nobody shared records nothing.
  expect(setupCommands(delta)).toEqual([])
  expect(ran(delta)).not.toContain('thread append')
  expect(delta.thread()).toBeUndefined()

  const url = await share(delta)
  const thread = delta.thread()
  expect(url).toBe(thread.url)
  // The band reports the live conversation.
  expect(pi.statuses.get('delta')).toMatch(/^● /)
  const [checkout] = checkouts(delta)
  expect(checkouts(delta)).toEqual([
    { reference: checkout!.reference, directory: delta.world.checkout, state: 'mounted' },
  ])
  const shared = records(delta)
  expect(await binding(delta)).toMatchObject({
    thread: thread.thread_id,
    checkout: delta.world.checkout,
    checkoutReference: checkout!.reference,
    url,
    snapshot: true,
    next: shared.length + 1,
    pending: [],
  })
  expect(shared.map((record) => record.sequence)).toEqual(shared.map((_, index) => index + 1))
  expect(shared[0]).toMatchObject({ update: { sessionUpdate: 'user_message', content: [{ text: 'first' }] } })
  const exported = shared.filter((record) => record.update.messageId?.startsWith('snapshot:'))
  expect(exported.map((record) => record.update.content[0].text)).toEqual([
    'first',
    'Echo: first',
    'second',
    'Echo: second',
  ])
  expect(shared.every((record) => record.turnSequence === undefined)).toBe(true)
  expect(shared.every((record) => record.update._meta?.delta === undefined)).toBe(true)
  // Every append names the producer; its identity stays the source and session.
  const appends = delta.commands().filter((args) => args[1] === 'append')
  expect(new Set(appends.map((args) => args[args.indexOf('--producer-name') + 1]))).toEqual(new Set(['Pi']))
  expect(new Set(appends.map((args) => args[args.indexOf('--external-id') + 1]))).toEqual(new Set([pi.session.id]))

  // A repeat share reopens nothing and disturbs nothing: the band still reports the same conversation.
  expect(await share(delta)).toBe(url)
  expect(pi.statuses.get('delta')).toMatch(/^● /)
  expect(records(delta)).toEqual(shared)
  expect(exports(delta)).toBe(1)
  expect(checkouts(delta)).toEqual([
    { reference: checkout!.reference, directory: delta.world.checkout, state: 'mounted' },
  ])
  expect(delta.world.delta().worktrees).toHaveLength(1)
})

test('share and join refuse a session without an interactive surface before contacting Delta', async () => {
  delta = await startDelta({ policy: MANUAL, mode: 'print' })
  await delta.pi.prompt('initial')
  for (const args of ['share', 'share ada@example.com', 'join some-link']) {
    const before = delta.stderr.length
    await delta.pi.command('delta', args)
    // Print mode has no client to show a note to; pi reports it on stderr.
    expect(delta.stderr.slice(before).join('')).toContain(
      "needs pi's interactive terminal or an RPC client that shows dialogs",
    )
  }
  await delta.advance(0)
  await delta.quiet()
  expect(delta.commands()).toEqual([])
  expect(exports(delta)).toBe(0)
  expect(await binding(delta)).toBeUndefined()
})

test('a checkout Delta manages for another thread is named in the share failure, which a retry can still finish', async () => {
  delta = await startDelta({ policy: MANUAL })
  await delta.pi.prompt('initial')
  const message = `${delta.world.checkout} is a checkout Delta manages for worktree w#t=1`
  const inUse = { error: { code: 'failed', reason: 'worktree_directory_in_use', message, retryable: false } }
  delta.world.answer('worktree attach', { stdout: `${JSON.stringify(inUse)}\n`, exitCode: 2 })
  const failure = await share(delta)
  expect(failure).toContain('manages for another thread')
  expect(failure).toContain('/delta-join')
  unlisted(delta)
  expect(await share(delta)).toBe(delta.thread().url)
  expect(exports(delta)).toBe(1)
  // The retry attached the local worktree identity the first attempt created.
  expect(delta.world.delta().worktrees).toHaveLength(1)
})

test('a staging record write failure contacts no Delta command and leaves no partial import', async () => {
  delta = await startDelta({ policy: MANUAL })
  await delta.pi.prompt('initial')
  // Startup's background work, such as checking for a Delta update, is done before the baseline.
  await delta.quiet()
  const commands = delta.commands().length
  const repaired = delta.disk.fail('write', '/outbox/', { times: 1000 })
  expect(await share(delta)).toContain('failed')
  // Checking the CLI's contract and the sign-in, and naming the team in the share's question, are all that ran.
  expect(
    ran(delta, commands).filter((command) => !['thread contract', 'auth status', 'org list'].includes(command)),
  ).toEqual([])
  expect(await binding(delta)).toBeUndefined()
  expect(delta.thread()).toBeUndefined()
  expect(delta.world.delta().worktrees).toEqual([])
  repaired()
  expect(await share(delta)).toBe(delta.thread().url)
  expect(records(delta)[0]).toMatchObject({ sequence: 1, update: { content: [{ text: 'initial' }] } })
  expect((await binding(delta)).pending).toEqual([])
})

test('a share that fails before the watcher restarts leaves prompts accepted', async () => {
  delta = await startDelta({ policy: MANUAL })
  await delta.pi.prompt('one')
  const url = await share(delta)
  const watches = () => ran(delta!).filter((command) => command === 'thread watch').length
  const watching = watches()
  delta.programs.set('git', (argv) =>
    argv.includes('--show-toplevel')
      ? {
          stdout: '',
          stderr: 'fatal: not a git repository',
          exitCode: 128,
          isStdoutTruncated: false,
          isStderrTruncated: false,
        }
      : undefined,
  )
  expect(await share(delta)).toContain('Git checkout')
  // The watch that was live still is, and nothing paused the session's prompts.
  expect(watches()).toBe(watching)
  delta.world.remote(delta.thread().thread_id, {
    type: 'item',
    item: {
      id: 'remote-1',
      kind: 'user_message',
      after_id: null,
      turn_id: null,
      author: { user_id: 'u-ada', name: 'Ada' },
      created_at: 1,
      open: false,
      content: { text: 'still watched' },
    },
  })
  await delta.until(
    () => JSON.stringify(delta!.pi.contextMessages()).includes('still watched'),
    "the teammate's message, through the watch",
  )
  expect(await delta.pi.prompt('still connected')).toBe('settled')
  delta.programs.delete('git')
  expect(await share(delta)).toBe(url)
  await delta.until(
    () => JSON.stringify(records(delta!)).includes('Echo: still connected'),
    'the prompt to be delivered',
  )
})

test('invalid attachment receipt {"reference":" "} keeps the binding and outbox', async () => {
  const patch = { reference: ' ' }
  delta = await startDelta({ policy: MANUAL })
  const { pi } = delta
  await pi.prompt('one')
  delta.world.answer('worktree attach', { patch })
  expect(await share(delta)).toContain('Invalid worktree membership receipt')
  const saved = await binding(delta)
  expect(saved.thread).toBe(delta.thread().thread_id)
  expect(saved.checkout).toBeUndefined()
  const sequences = await staged(delta)
  expect(sequences).toEqual(sequences.map((_, index) => index + 1))
  expect(delta.thread().url).toBeNull()
  expect(ran(delta)).not.toContain('thread share')
  expect(records(delta)).toEqual([])
  const messages = pi.messages().length
  expect(await pi.prompt('unsafe receipt')).toBe('handled')
  expect(pi.messages()).toHaveLength(messages)
  expect(await share(delta)).toBe(delta.thread().url)
  expect(checkouts(delta)).toMatchObject([{ directory: delta.world.checkout, state: 'mounted' }])
  expect(await binding(delta)).toMatchObject({ checkout: delta.world.checkout, pending: [] })
  expect(exports(delta)).toBe(1)
  expect(records(delta).map((record) => record.sequence)).toEqual(sequences)
})

test('invalid publication receipt {"thread_id":"other-thread"} preserves setup and staged records', async () => {
  const patch = { thread_id: 'other-thread' }
  delta = await startDelta({ policy: MANUAL })
  await delta.pi.prompt('one')
  delta.world.answer('thread share', { patch })
  expect(await share(delta)).toContain('Invalid publication receipt')
  const saved = await binding(delta)
  const sequences = await staged(delta)
  expect(saved).toMatchObject({
    thread: delta.thread().thread_id,
    checkout: delta.world.checkout,
    snapshot: true,
    next: sequences.length + 1,
  })
  expect(saved.url).toBeUndefined()
  expect(sequences).toEqual(sequences.map((_, index) => index + 1))
  // Delta published the thread; only its receipt was wrong.
  expect(delta.thread().url).toBeTruthy()
  const mounted = checkouts(delta)
  expect(records(delta)).toEqual([])
  const url = await share(delta)
  expect(url).toBe(delta.thread().url)
  expect(checkouts(delta)).toEqual(mounted)
  expect(await binding(delta)).toMatchObject({ thread: delta.thread().thread_id, url, pending: [] })
  expect(records(delta)[0]).toMatchObject({ sequence: 1, update: { content: [{ text: 'one' }] } })
  expect(records(delta).map((record) => record.sequence)).toEqual(sequences)
  expect(exports(delta)).toBe(1)
})
