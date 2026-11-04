// Signing in to Delta for automatic recording, /delta share and /delta setup, ported from the upstream
// plugin's engine tests (hooks/cli/auth.test.ts) onto the kit. Upstream's terminal and Desktop surfaces
// are pi's terminal and an RPC client; its headless surface is print mode.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { TYPE_SOMETHING } from '../../src/setup/setup.ts'
import {
  answering,
  band,
  debugLog,
  deltaAt,
  notes,
  offeredSetup,
  opened,
  policyFile,
  ran,
  savedPolicy,
  SELECTED,
  SETUP_OFFER,
  SHARE_WITH_TEAM,
  signIns,
  waitingOnBrowser,
} from '../kit/accounts.ts'
import { type Kit, startDelta } from '../kit/index.ts'
import type { Mode } from '../kit/pi.ts'

let delta: Kit | undefined
afterEach(async () => {
  delta?.expectClean()
  await delta?.stop()
  delta = undefined
})

const PRIVATE = { mode: 'private', organization: 'org-1' }
/** The fake Delta answers as a signed-out account until the browser sign-in finishes. */
const SIGNED_OUT = { FAKE_DELTA_SIGNED_OUT: '1' }
const SIGN_IN = ['auth', 'status']
const LOGIN = ['auth', 'login', '--no-wait']
const WAIT = ['auth', 'wait', 'login-1']
const TERMS_DENIAL = {
  status: 'access_denied',
  reason: 'terms_not_accepted',
  message: 'Accept the terms.',
  url: 'https://zed.dev/delta/terms',
}
const reply = (value: unknown) => ({ stdout: `${JSON.stringify(value)}\n`, exitCode: 1 })

const records = (kit: Kit): any[] => kit.thread()?.records ?? []
const prompts = (kit: Kit) =>
  records(kit)
    .filter((record) => record.update.sessionUpdate === 'user_message')
    .map((record) => record.update.content[0].text)
const binding = (kit: Kit) => kit.store.get(`session:${kit.pi.session.id}`)
const outboxOf = (kit: Kit) => join(kit.world.agentDir, 'delta', 'outbox', kit.pi.session.id)
const staged = (kit: Kit) => existsSync(outboxOf(kit)) && readdirSync(outboxOf(kit)).length > 0
const cancelsOrLogsOut = (kit: Kit) => signIns(kit).some((args) => ['cancel', 'logout'].includes(args[1]!))

/** Start a new session under the repository's Private sync policy, signed out, with sign-in's wait held. */
async function startSignedOut(mode: Mode = 'rpc', answers: Parameters<typeof answering>[0] = {}) {
  const kit = await startDelta({ mode, policy: PRIVATE, env: SIGNED_OUT, start: false })
  deltaAt(kit)
  kit.pi.respond = answering({ 'sign in': 'Sign in', ...answers })
  const release = kit.world.hold('auth wait')
  await kit.pi.start()
  await kit.until(() => waitingOnBrowser(kit), 'the browser sign-in')
  return { kit, release }
}

/** Run `/delta share` and let it start on the clock. */
async function share(kit: Kit) {
  await kit.pi.command('delta', 'share')
  await kit.advance(0)
}

async function signsInWithoutBlocking(mode: Mode) {
  const { kit, release } = await startSignedOut(mode)
  delta = kit
  expect(signIns(kit)).toEqual([SIGN_IN, LOGIN, WAIT])
  expect(kit.runs().every((run) => run.argv[0] === SELECTED)).toBe(true)
  expect(notes(kit).join('\n')).toContain('https://delta.dev/login/login-1')
  expect(band(kit)).toContain('Waiting for Delta sign-in')
  expect(kit.thread()).toBeUndefined()

  // Neither the prompt nor its turn waits on the browser, and nothing uploads them yet.
  expect(await kit.pi.prompt('while signing in')).toBe('settled')
  const queued = (await binding(kit)) as any
  expect(queued).toMatchObject({ snapshot: true, autoUpload: PRIVATE })
  expect(queued.pending.length).toBeGreaterThan(0)
  expect(kit.thread()).toBeUndefined()
  // Prompts during sign-in start no other attempt.
  expect(signIns(kit)).toHaveLength(3)

  release()
  const thread = await kit.until(
    () => prompts(kit).includes('while signing in') && kit.thread(),
    'the same session to upload',
  )
  expect(thread).toMatchObject({ organization: 'org-1', visibility: 'private' })
  const states = records(kit).filter((record) => record.update.sessionUpdate === 'state_update')
  expect(states.map((record) => record.update.state)).toEqual(['running', 'idle'])
  // The session started empty, so nothing was exported: only what happened in it.
  expect(prompts(kit)).toEqual(['while signing in'])
  expect(ran(kit, 'thread share')).toBe(false)
}

test('automatic sync in terminal signs in without blocking work, then uploads the same session', () =>
  signsInWithoutBlocking('tui'))

test('automatic sync in desktop signs in without blocking work, then uploads the same session', () =>
  signsInWithoutBlocking('rpc'))

test('headless automatic sync stays noninteractive when signed out', async () => {
  delta = await startDelta({ mode: 'print', policy: PRIVATE, env: SIGNED_OUT })
  await delta.until(() => delta!.stderr.join('').includes('delta auth login'), 'the advice to sign in')
  expect(delta.commands().filter((args) => args[0] === 'auth')).toEqual([])
  expect(delta.thread()).toBeUndefined()
  expect(await binding(delta)).toBeUndefined()
  expect(delta.pi.dialogs).toEqual([])
})

test('automatic sync rechecks organization membership after browser sign-in', async () => {
  const { kit, release } = await startSignedOut()
  delta = kit
  kit.world.organizations([{ id: 'another-org', name: 'Another team', current: true }])
  release()
  await kit.until(() => notes(kit).some((text) => text.includes("isn't a member of")), 'the membership refusal')
  expect(kit.thread()).toBeUndefined()
  expect(await binding(kit)).toBeUndefined()
})

async function signInEnds(status: 'cancelled' | 'expired' | 'access_denied') {
  const { kit, release } = await startSignedOut('rpc', { 'Who should see': SHARE_WITH_TEAM })
  delta = kit
  await kit.pi.prompt('before login failed')
  expect(staged(kit)).toBe(true)
  kit.world.answer('auth wait', reply({ status }))
  release()
  await kit.until(
    () => notes(kit).some((text) => text.endsWith("This session isn't syncing. Run /delta-share to retry.")),
    'the session to stop syncing',
  )
  expect(kit.thread()).toBeUndefined()
  expect(await binding(kit)).toBeUndefined()
  expect(staged(kit)).toBe(false)
  const calls = signIns(kit).length
  expect(await kit.pi.prompt('after sign-in stopped')).toBe('settled')
  await kit.settle()
  expect(signIns(kit)).toHaveLength(calls)
  expect(cancelsOrLogsOut(kit)).toBe(false)

  // Explicit recovery exports the conversation from pi, not the removed automatic outbox.
  await share(kit)
  const shared = await kit.until(
    () => notes(kit).find((text) => text.startsWith('Delta: Shared')),
    'the recovering share',
  )
  expect(shared).toContain('https://delta.dev/join/share_thread_1')
  expect(prompts(kit)).toEqual(['before login failed', 'after sign-in stopped'])
}

test('automatic sign-in ending with cancelled stops recording and does not reopen the browser on prompts', () =>
  signInEnds('cancelled'))

test('automatic sign-in ending with expired stops recording and does not reopen the browser on prompts', () =>
  signInEnds('expired'))

test('automatic sign-in ending with access_denied stops recording and does not reopen the browser on prompts', () =>
  signInEnds('access_denied'))

test('ending an automatically syncing session closes its login waiter without cancelling the shared attempt', async () => {
  const { kit, release } = await startSignedOut()
  delta = kit
  await kit.whileTimePasses(kit.pi.shutdown('quit'))
  await kit.advance(250)
  await kit.until(() => !waitingOnBrowser(kit), 'the waiter to close')
  expect(kit.thread()).toBeUndefined()
  expect(signIns(kit)).toEqual([SIGN_IN, LOGIN, WAIT])
  release()
})

test('share signs in an existing installation before exporting, then continues on the selected CLI', async () => {
  delta = await startDelta({ env: SIGNED_OUT, start: false })
  const { pi } = delta
  deltaAt(delta)
  pi.respond = answering({ [SETUP_OFFER]: 'Not now', 'sign in': 'Sign in', 'Who should see': SHARE_WITH_TEAM })
  await pi.start()
  await pi.prompt('hello')
  expect(signIns(delta)).toEqual([])
  const release = delta.world.hold('auth wait')
  await share(delta)
  await delta.until(() => waitingOnBrowser(delta!), 'the browser sign-in')
  expect(signIns(delta)).toEqual([SIGN_IN, LOGIN, WAIT])
  expect(delta.runs().every((run) => run.argv[0] === SELECTED)).toBe(true)
  expect(notes(delta).join('\n')).toContain('https://delta.dev/login/login-1')
  expect(delta.thread()).toBeUndefined()
  release()
  const shared = await delta.until(
    () => notes(delta!).find((text) => text.startsWith('Delta: Shared')),
    'the share to finish',
  )
  expect(shared).toContain('https://delta.dev/join/share_thread_1')
  expect(prompts(delta)).toEqual(['hello'])
  // Resuming the session signs in no more.
  const calls = signIns(delta).length
  await delta.whileTimePasses(pi.switchTo(pi.session.file))
  await delta.until(() => delta!.running().some((args) => args[1] === 'watch'), 'the resumed watch')
  expect(signIns(delta)).toHaveLength(calls)
})

test('failed and unknown authentication outcomes stop share without creating a thread', async () => {
  delta = await startDelta({ env: SIGNED_OUT, start: false })
  const { pi, world } = delta
  deltaAt(delta)
  pi.respond = answering({ [SETUP_OFFER]: 'Not now', 'sign in': 'Sign in', 'Who should see': SHARE_WITH_TEAM })
  await pi.start()
  for (const status of ['cancelled', 'expired', 'access_denied', 'wrong_account', 'future_state', 'pending']) {
    if (status === 'cancelled' || status === 'expired') world.answer('auth wait', reply({ status }))
    else if (status === 'pending') world.answer('auth login', { ...reply({ status, login_id: 'broken' }), exitCode: 0 })
    else
      world.answer(
        'auth status',
        reply({ status, message: 'Access requires approval', url: 'https://example.com/access' }),
      )
    const before = notes(delta).length
    await share(delta)
    const result = await delta.until(
      () =>
        notes(delta!)
          .slice(before)
          .find((text) => text.includes('Delta sharing failed')),
      `the share to stop at ${status}`,
    )
    if (status === 'access_denied') {
      expect(result).toContain('https://example.com/access')
      expect(result).toContain(
        `Resolve access, then run in your shell: '${SELECTED}' auth login. After signing in again, retry /delta-share or /delta-join <link>.`,
      )
    }
    expect(delta.thread()).toBeUndefined()
    expect(records(delta)).toEqual([])
  }
  expect(cancelsOrLogsOut(delta)).toBe(false)
})

test('declining sign-in for automatic sync leaves the session unsynced without opening a browser', async () => {
  delta = await startDelta({ policy: PRIVATE, env: SIGNED_OUT, start: false })
  delta.pi.respond = answering({ 'sign in': 'Not now' })
  await delta.pi.start()
  await delta.until(
    () => notes(delta!).includes("Delta isn't signed in. Run /delta-share again to sign in."),
    'the declined sign-in',
  )
  expect(signIns(delta)).toEqual([SIGN_IN])
  expect(band(delta)).toContain('Not syncing')
  expect(opened(delta)).toEqual([])
  expect(delta.thread()).toBeUndefined()
})

/** Start a signed-in session whose account has not accepted Delta's beta terms `times` more times. */
async function startWithTermsDenied(times: number, answers: Parameters<typeof answering>[0]) {
  const kit = await startDelta({ start: false })
  kit.pi.respond = answering({ [SETUP_OFFER]: 'Not now', 'Who should see': SHARE_WITH_TEAM, ...answers })
  await kit.pi.start()
  // The share's question reads the account once before sign-in asks.
  kit.world.answer('auth status', reply(TERMS_DENIAL), { after: 1, times })
  return kit
}

test('running /delta-share again while the beta terms are awaited offers to stop waiting', async () => {
  delta = await startWithTermsDenied(1, { 'Stop waiting?': 'Stop waiting', 'beta terms': 'Open the beta terms' })
  const kit = delta
  await share(kit)
  await kit.until(() => band(kit).includes("Waiting for Delta's beta terms"), 'the wait for the terms')
  expect(opened(kit)).toEqual(['https://zed.dev/delta/terms'])
  const before = notes(kit).length
  await kit.pi.command('delta', 'share')
  expect(kit.pi.dialogs.at(-1)?.title).toBe(
    'Delta: Delta is waiting for you to accept its beta terms in your browser. Stop waiting?',
  )
  // The stopped share reports itself; the command adds nothing of its own.
  await kit.until(() => notes(kit).length > before, 'the stopped wait')
  await kit.settle()
  expect(notes(kit).slice(before)).toEqual([
    "Stopped waiting for Delta's beta terms. Run /delta-share or /delta-join <link> again to accept them.",
  ])
  // Nothing polls once stopped, and a new share can start.
  const polls = signIns(kit).length
  await kit.advance(10_000)
  await kit.settle()
  expect(signIns(kit)).toHaveLength(polls)
  expect(kit.thread()).toBeUndefined()
  await share(kit)
  await kit.until(() => kit.thread(), 'the next share')
})

test('keeping the wait leaves the share waiting for the beta terms, without a second share', async () => {
  delta = await startWithTermsDenied(2, { 'Stop waiting?': 'Keep waiting', 'beta terms': 'Open the beta terms' })
  const kit = delta
  await share(kit)
  await kit.until(() => band(kit).includes("Waiting for Delta's beta terms"), 'the wait for the terms')
  await kit.pi.command('delta', 'share')
  expect(kit.pi.dialogs.at(-1)?.title).toBe(
    'Delta: Delta is waiting for you to accept its beta terms in your browser. Stop waiting?',
  )
  // Delta reports the sign-in once the terms are accepted on the web; the first share carries on.
  await kit.until(async () => (await kit.advance(2_000), kit.thread()), 'the share to continue')
  expect(signIns(kit)).toEqual([SIGN_IN, SIGN_IN, SIGN_IN])
  expect(notes(kit).join('\n')).not.toContain('Stopped waiting')
  expect(notes(kit).join('\n')).not.toContain('already in progress')
})

test('stopping automatic sync while sign-in waits closes the waiter and leaves the session unsynced', async () => {
  const { kit, release } = await startSignedOut('rpc', { 'Stop waiting?': 'Stop waiting' })
  delta = kit
  expect(band(kit)).toContain('Waiting for Delta sign-in')
  await kit.pi.command('delta', 'share')
  expect(kit.pi.dialogs.at(-1)?.title).toBe(
    'Delta: Delta is waiting for you to finish signing in with your browser. Stop waiting?',
  )
  await kit.until(() => !waitingOnBrowser(kit), 'the waiter to close')
  expect(cancelsOrLogsOut(kit)).toBe(false)
  await kit.until(
    () => notes(kit).includes('Stopped waiting for Delta sign-in. Run /delta-share again to sign in.'),
    'the stopped sign-in',
  )
  expect(band(kit)).toContain('Not syncing')
  expect(kit.thread()).toBeUndefined()
  release()
})

test('declined beta terms leave a one-line explanation with the terms link, without a failure or a new sign-in', async () => {
  delta = await startWithTermsDenied(1, { 'beta terms': 'Not now' })
  const kit = delta
  await share(kit)
  await kit.until(
    () =>
      notes(kit).includes(
        "Delta's beta terms aren't accepted. Accept them at https://zed.dev/delta/terms, then run /delta-share or /delta-join <link> again.",
      ),
    'the declined terms',
  )
  expect(opened(kit)).toEqual([])
  expect(notes(kit).join('\n')).not.toContain('Delta sharing failed')
  expect(notes(kit).every((text) => !text.includes('\n'))).toBe(true)
  expect(signIns(kit)).toEqual([SIGN_IN])
  expect(kit.thread()).toBeUndefined()
})

test('changing sessions closes the login waiter without cancelling a shared login or continuing share', async () => {
  delta = await startDelta({ env: SIGNED_OUT, start: false })
  const { pi } = delta
  pi.respond = answering({ [SETUP_OFFER]: 'Not now', 'sign in': 'Sign in', 'Who should see': SHARE_WITH_TEAM })
  const release = delta.world.hold('auth wait')
  await pi.start()
  await share(delta)
  await delta.until(() => waitingOnBrowser(delta!), 'the browser sign-in')
  await delta.whileTimePasses(pi.newSessionIn())
  await delta.advance(250)
  await delta.until(() => !waitingOnBrowser(delta!), 'the waiter to close')
  expect(delta.thread()).toBeUndefined()
  expect(signIns(delta)).toEqual([SIGN_IN, LOGIN, WAIT])
  release()
})

/** Answer setup as upstream's tests do: name a new team Acme, invite later, and choose Private sync. */
const SETUP_ANSWERS = {
  'Create a team to more easily share': (dialog: { method: string }) =>
    dialog.method === 'input' ? 'Acme' : TYPE_SOMETHING,
  'sign in': 'Sign in',
  'Who should join': 'Invite later',
  'Which sessions should Delta sync?': (dialog: { options?: string[] }) =>
    dialog.options?.find((option) => option.startsWith('Private sync')),
  'Sync this session privately too?': 'Not now',
}

test('setup installs Delta and finishes browser sign-in before creating a team and saving the policy', async () => {
  delta = await startDelta({ env: SIGNED_OUT, start: false })
  const { pi, world } = delta
  deltaAt(delta, { missing: true })
  world.organizations([])
  pi.respond = answering(SETUP_ANSWERS)
  // A repository already offered setup, so the offer stays out of the way.
  await offeredSetup(delta)
  const release = world.hold('auth wait')
  await pi.start()
  await delta.settle()
  expect(signIns(delta)).toEqual([])
  const setup = pi.command('delta', 'setup')
  await delta.until(() => notes(delta!).some((text) => text.includes('Finish signing in')), 'the browser sign-in')
  expect(signIns(delta)).toEqual([SIGN_IN, LOGIN, WAIT])
  expect(delta.runs().every((run) => run.argv[0] === SELECTED)).toBe(true)
  expect(delta.commands().some((args) => args[0] === 'org')).toBe(false)
  // Sign-in is the only question so far: setup asks nothing of its own before it finishes.
  expect(pi.dialogs.map((dialog) => dialog.title)).toEqual([
    'Delta: Delta needs you to sign in before it can sync. Sign in with your browser?',
  ])
  expect(existsSync(policyFile(delta))).toBe(false)
  release()
  await setup
  expect(savedPolicy(delta)).toEqual({ threads: { mode: 'private', organization: 'org-new' } })
  expect(delta.thread()).toBeUndefined()
  // The saved policy records the next session to the new team, privately.
  await delta.whileTimePasses(pi.newSessionIn())
  const thread = await delta.until(() => delta!.thread(), 'the next session to sync')
  expect(thread).toMatchObject({ organization: 'org-new', visibility: 'private' })
  expect(ran(delta, 'thread share')).toBe(false)
})

test('setup stops before organization operations when sign-in is cancelled or access is required', async () => {
  delta = await startDelta({ env: SIGNED_OUT, start: false })
  const { pi, world } = delta
  pi.respond = answering({ 'sign in': 'Sign in', 'beta terms': 'Not now' })
  await offeredSetup(delta)
  await pi.start()
  for (const status of ['cancelled', 'terms_not_accepted']) {
    if (status === 'cancelled') world.answer('auth wait', reply({ status }))
    else
      world.answer(
        'auth status',
        reply({ status: 'access_denied', reason: status, url: 'https://zed.dev/delta/terms' }),
      )
    await pi.command('delta', 'setup')
    const text = notes(delta).at(-1)
    expect(text).toContain('/delta-setup')
    if (status === 'terms_not_accepted') {
      expect(text).toContain('https://zed.dev/delta/terms')
      expect(text).not.toContain('could not sign in')
    } else expect(text).toContain(status)
    expect(delta.commands().some((args) => args[0] === 'org')).toBe(false)
    expect(existsSync(policyFile(delta))).toBe(false)
  }
})

test('ending the session stops setup sign-in without cancelling the app-owned login', async () => {
  delta = await startDelta({ env: SIGNED_OUT, start: false })
  const { pi } = delta
  pi.respond = answering({ 'sign in': 'Sign in' })
  await offeredSetup(delta)
  const release = delta.world.hold('auth wait')
  await pi.start()
  const setup = pi.command('delta', 'setup')
  await delta.until(() => notes(delta!).some((text) => text.includes('Finish signing in')), 'the browser sign-in')
  await delta.whileTimePasses(pi.shutdown('quit'))
  await delta.advance(250)
  await setup
  // The session ended, so its answer only reaches the debug log.
  expect(debugLog(delta)).toContain('could not sign in')
  expect(waitingOnBrowser(delta)).toBe(false)
  expect(signIns(delta)).toEqual([SIGN_IN, LOGIN, WAIT])
  expect(delta.commands().some((args) => args[0] === 'org')).toBe(false)
  expect(existsSync(policyFile(delta))).toBe(false)
  release()
})

test('a session replaced during setup installation cannot start login or write the old checkout policy', async () => {
  delta = await startDelta({ start: false })
  const { pi } = delta
  const cli = deltaAt(delta, { missing: true, hold: true })
  await offeredSetup(delta)
  await pi.start()
  const setup = pi.command('delta', 'setup')
  await delta.until(() => cli.installs === 1, 'the installation to start')
  await delta.whileTimePasses(pi.newSessionIn())
  cli.release()
  await setup
  // The replaced session's answer only reaches the debug log.
  expect(debugLog(delta)).toContain('obsolete setup was stopped')
  expect(signIns(delta)).toEqual([])
  expect(delta.commands().some((args) => args[0] === 'org')).toBe(false)
  expect(existsSync(policyFile(delta))).toBe(false)
})
