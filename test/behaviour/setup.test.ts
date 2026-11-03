// /delta setup, the setup offer, and what /delta share asks and refuses, ported from the upstream
// plugin's engine tests (hooks/setup/auto.test.ts: "setup command and policy problems" and "setup
// dialogs and notices") onto the kit. Upstream's headless surface is pi's print and JSON modes.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { ONBOARDING_DECLINED, ONBOARDING_QUESTION, TYPE_SOMETHING } from '../../src/setup/setup.ts'
import {
  answering,
  band,
  notes,
  offeredSetup,
  policyFile,
  ran,
  savedPolicy,
  SETUP_OFFER,
  SHARE_WITH_TEAM,
  signIns,
} from '../kit/accounts.ts'
import { FakeSession, type Kit, startDelta } from '../kit/index.ts'
import type { Dialog } from '../kit/pi.ts'

let delta: Kit | undefined
afterEach(async () => {
  delta?.expectClean()
  await delta?.stop()
  delta = undefined
})

const SIGNED_OUT = { FAKE_DELTA_SIGNED_OUT: '1' }
const option = (prefix: string) => (dialog: Dialog) => dialog.options?.find((label) => label.startsWith(prefix))
const records = (kit: Kit): any[] => kit.thread()?.records ?? []
const binding = (kit: Kit) => kit.store.get(`session:${kit.pi.session.id}`)

/** Run `/delta <args>` and let the share it starts on the clock run. */
async function command(kit: Kit, args: string) {
  await kit.pi.command('delta', args)
  await kit.advance(0)
}

/** A session pi resumes with a conversation already in it, as one an extension is installed into is. */
function withHistory(kit: Kit) {
  const session = new FakeSession('running-session', kit.world.checkout, join(kit.world.agentDir, 'running.jsonl'))
  session.entries.push({
    type: 'message',
    id: 'aaaaaaaa',
    parentId: null,
    timestamp: '',
    message: { role: 'user', content: [{ type: 'text', text: 'before' }], timestamp: 0 },
  })
  return session
}

/** Load the extension into a running session with history, as installing it and reloading pi does. */
async function installIntoRunningSession(policy?: Record<string, unknown>) {
  const base = await startDelta({ ...(policy ? { policy } : {}), start: false })
  const kit = await startDelta({ world: base.world, session: withHistory(base), start: false })
  return { kit, base }
}

describe('setup command and policy problems', () => {
  test('a headless session refuses /delta setup and never offers onboarding', async () => {
    for (const mode of ['print', 'json'] as const) {
      delta = await startDelta({ mode })
      await delta.advance(0)
      await delta.settle()
      expect(delta.commands().some((args) => args[0] === 'org')).toBe(false)
      await delta.pi.command('delta', 'setup')
      expect(delta.stderr.join('')).toContain(
        "/delta-setup needs pi's interactive terminal or an RPC client that shows dialogs. Print and JSON modes cannot answer its questions.",
      )
      expect(delta.pi.dialogs).toEqual([])
      expect(savedPolicy(delta)).toBeUndefined()
      expect(delta.commands().some((args) => args[0] === 'auth')).toBe(false)
      delta.expectClean()
      await delta.stop()
      delta = undefined
    }
  })

  test('a malformed policy is reported once and leaves the checkout recording manually', async () => {
    delta = await startDelta({ start: false })
    const broken = '{ not json'
    mkdirSync(join(delta.world.checkout, '.delta'), { recursive: true })
    writeFileSync(policyFile(delta), broken)
    delta.pi.respond = answering({ [SETUP_OFFER]: 'Not now' })
    await delta.pi.start()
    await delta.until(() => notes(delta!).some((text) => text.includes("couldn't be used")), 'the policy problem')
    await delta.pi.prompt('hello')
    await delta.pi.prompt('again')
    expect(notes(delta).filter((text) => text.includes("couldn't be used"))).toHaveLength(1)
    expect(readFileSync(policyFile(delta), 'utf8')).toBe(broken)
    expect(delta.thread()).toBeUndefined()
    expect(ran(delta, 'thread create')).toBe(false)
  })
})

describe('setup dialogs and notices', () => {
  test('/delta setup offers to create an organization when the account has none, and syncs to it', async () => {
    delta = await startDelta({ start: false })
    delta.world.organizations([])
    delta.pi.respond = answering({
      'Create a team to more easily share': (dialog) => (dialog.method === 'input' ? 'Acme' : TYPE_SOMETHING),
      'Who should join': 'Invite later',
      'Which sessions should Delta sync?': option('Private sync'),
    })
    await offeredSetup(delta)
    await delta.pi.start()
    await delta.pi.command('delta', 'setup')
    expect(delta.runs().filter((run) => run.argv.includes('create'))).toEqual([
      expect.objectContaining({ argv: [expect.any(String), '--json', 'org', 'create', '--', 'Acme'] }),
    ])
    expect(savedPolicy(delta)).toEqual({ threads: { mode: 'private', organization: 'org-new' } })
  })

  test('/delta share in a repository without a Git remote says so before asking or uploading anything', async () => {
    delta = await startDelta({ start: false })
    execFileSync('git', ['remote', 'remove', 'origin'], { cwd: delta.world.checkout })
    delta.pi.respond = answering({ [SETUP_OFFER]: 'Not now', 'Who should see': SHARE_WITH_TEAM })
    await delta.pi.start()
    await command(delta, 'share')
    await delta.until(
      () =>
        notes(delta!).includes(
          "Delta didn't share this session: This repository has no Git remote, and Delta needs one to sync it. Add a remote and push to it, then run /delta-share again.",
        ),
      'the refusal',
    )
    expect(delta.pi.dialogs.filter((dialog) => dialog.title.startsWith('Delta share'))).toEqual([])
    expect(delta.others().some((argv) => argv[0] === 'sh' && argv[2]?.includes('install.sh'))).toBe(false)
    expect(delta.thread()).toBeUndefined()
  })

  test('syncing this session from /delta setup after Private sync uploads it privately, never to the team', async () => {
    delta = await startDelta({ start: false })
    delta.pi.respond = answering({
      Team: option('Zed'),
      'Which sessions should Delta sync?': option('Private sync'),
      'Sync this session privately too?': 'Sync it',
    })
    await offeredSetup(delta)
    await delta.pi.start()
    await delta.pi.command('delta', 'setup')
    expect(notes(delta).at(-1)).toContain('Syncing this session now.')
    await delta.advance(0)
    const thread = await delta.until(
      () => delta!.running().some((args) => args[1] === 'watch') && delta!.thread(),
      'the session to sync',
    )
    expect(thread).toMatchObject({ organization: 'org-1', visibility: 'private' })
    expect(ran(delta, 'thread share')).toBe(false)
  })

  test('/delta share in a Manual repository shares to its saved team, not the selected organization', async () => {
    delta = await startDelta({ policy: { mode: 'manual', organization: 'org-2' }, start: false })
    delta.world.organizations([
      { id: 'org-1', name: 'Zed', current: true },
      { id: 'org-2', name: 'Acme', current: false },
    ])
    delta.pi.respond = answering({ 'Who should see': SHARE_WITH_TEAM })
    await delta.pi.start()
    await command(delta, 'share')
    await delta.until(() => notes(delta!).some((text) => text.startsWith('Delta: Shared')), 'the share')
    expect(delta.commands().find((args) => args.includes('create'))).toEqual(
      expect.arrayContaining(['--organization', 'org-2', '--visibility', 'private']),
    )
    expect(ran(delta, 'thread share')).toBe(true)
    await delta.until(() => band(delta!).includes('Shared with Acme'), 'the band to name the team')
  })

  test('/delta share with addresses invites them without publishing', async () => {
    delta = await startDelta({ start: false })
    delta.world.inviteFailures({ 'bo@example.com': 'already a member' })
    delta.pi.respond = answering({ [SETUP_OFFER]: 'Not now' })
    await delta.pi.start()
    await command(delta, 'share ada@example.com, bo@example.com')
    const link = 'https://delta.dev/join/share_thread_1'
    await delta.until(
      () =>
        notes(delta!).includes(
          `Invited ada@example.com to this session. Couldn't invite bo@example.com (already a member). Link: ${link}`,
        ),
      'the invitations',
    )
    expect(delta.thread()?.invited).toEqual(['ada@example.com', 'bo@example.com'])
    expect(ran(delta, 'thread share')).toBe(false)
    expect(await binding(delta)).toMatchObject({ url: link })
    // Keeping the audience of a thread whose audience Delta never reported, as after an interrupted
    // invitation, reconnects it without publishing it to the team.
    await delta.store.set(`session:${delta.pi.session.id}`, {
      ...((await binding(delta)) as object),
      visibility: undefined,
    })
    delta.pi.respond = answering({ 'Who should see': 'Keep current sharing' })
    await command(delta, 'share')
    await delta.until(() => notes(delta!).some((text) => text.startsWith('Delta: Reconnected')), 'the reconnection')
    expect(ran(delta, 'thread share')).toBe(false)
  })

  test('dismissing the share question shares nothing', async () => {
    delta = await startDelta({ start: false })
    delta.pi.respond = answering({ [SETUP_OFFER]: 'Not now' })
    await delta.pi.start()
    await delta.pi.prompt('hello')
    await command(delta, 'share')
    await delta.until(() => delta!.pi.dialogs.some((dialog) => dialog.title.startsWith('Delta share')), 'the question')
    // The band drops the share's progress rather than reporting a failure.
    await delta.until(() => !band(delta!).includes('Preparing to share'), 'the share to end')
    expect(delta.thread()).toBeUndefined()
    expect(records(delta)).toEqual([])
    expect(notes(delta).join('\n')).not.toContain('Delta sharing failed')
  })

  test('accepting the startup offer signs in before setup and updates the band once it saves', async () => {
    delta = await startDelta({ env: SIGNED_OUT, start: false })
    delta.pi.respond = answering({
      [SETUP_OFFER]: 'Set up now',
      'sign in': 'Sign in',
      Team: option('Zed'),
      'Which sessions should Delta sync?': option('Manual'),
    })
    await delta.pi.start()
    await delta.until(() => savedPolicy(delta!), 'the setup to save')
    expect(signIns(delta)).toEqual([
      ['auth', 'status'],
      ['auth', 'login', '--no-wait'],
      ['auth', 'wait', 'login-1'],
    ])
    expect(savedPolicy(delta)).toEqual({ threads: { mode: 'manual', organization: 'org-1' } })
    await delta.until(
      () => band(delta!).includes('Not syncing') && band(delta!).includes('/delta-share'),
      'the band to remind of /delta-share',
    )
  })

  test('a plugin installed into a running session offers setup there, and declining names /delta-setup', async () => {
    const { kit, base } = await installIntoRunningSession()
    delta = kit
    kit.pi.respond = answering({ [SETUP_OFFER]: 'Not now' })
    await kit.pi.start('reload')
    await kit.until(() => notes(kit).includes(ONBOARDING_DECLINED), 'the declined offer')
    expect(kit.pi.dialogs.map((dialog) => dialog.title)).toEqual([`Delta setup: ${ONBOARDING_QUESTION}`])
    kit.expectClean()
    await kit.stop()
    delta = undefined
    await base.stop()
  })

  test('a plugin installed into a running session never starts recording it automatically', async () => {
    const { kit, base } = await installIntoRunningSession({ mode: 'private', organization: 'org-1' })
    delta = kit
    await kit.pi.start('reload')
    await kit.advance(0)
    await kit.settle()
    await kit.pi.prompt('after')
    expect(ran(kit, 'thread create')).toBe(false)
    expect(kit.pi.dialogs).toEqual([])
    kit.expectClean()
    await kit.stop()
    delta = undefined
    await base.stop()
  })
})
