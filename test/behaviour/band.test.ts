// The band above pi's editor: a running share, another participant's turn and what their agent is doing,
// the thread's children, and its animation. Ported from the upstream plugin's engine tests
// (hooks/register.test.ts, "the status band") onto the kit, which draws the band as pi's terminal does.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import type { WatchItem } from '../../src/cli/thread-commands.ts'
import { styled } from '../../src/band/band.ts'
import { personColor, personKey } from '../../src/band/status.ts'
import { FAKE_THEME, type Kit, startDelta, themeColor } from '../kit/index.ts'

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
const THREAD = 'thread_1'
const ADA = { user_id: 'user-ada', name: 'Ada' }
const LIVE = '●'

/** A session in pi's terminal, before it shares anything. */
async function session() {
  const kit = await startDelta({ answers: [NOT_NOW], mode: 'tui' })
  kits.push(kit)
  await kit.until(() => kit.pi.dialogs.length === 1, 'the setup offer')
  return kit
}

/** Share `kit`'s session with `/delta share`, and wait for its watch to be live. */
async function share(kit: Kit, before?: () => void) {
  before?.()
  kit.pi.answers.push(SHARE)
  await kit.pi.command('delta', 'share')
  await kit.until(() => kit.pi.noticeTexts().some((text) => text.startsWith('Delta: Shared')), 'the share to finish')
  await kit.until(() => band(kit).includes(LIVE), 'the watch to be live')
  return kit
}

/** A session in pi's terminal, shared, once its watch is live. */
async function shared(before?: (kit: Kit) => void) {
  const kit = await session()
  await kit.pi.prompt('one')
  return share(kit, () => before?.(kit))
}

/** The band as pi's terminal draws it, as text. */
const band = (kit: Kit, width = 120) => kit.pi.widget('delta', width).join('\n')
const raw = (kit: Kit, width = 120) => kit.pi.widget('delta', width, true).join('\n')

/** Report `events` on the thread's watch, and wait until the extension has taken each in. */
async function deliver(kit: Kit, ...events: Record<string, unknown>[]) {
  const before = kit.pi.renders
  kit.world.remote(THREAD, ...events)
  // Each of these events redraws the band once it is applied.
  await kit.until(() => kit.pi.renders >= before + events.length, 'the events to arrive')
  await kit.settle()
}

function item(text: string, fields: Partial<WatchItem> = {}): WatchItem {
  return {
    id: 'item',
    kind: 'user_message',
    after_id: null,
    turn_id: null,
    author: ADA,
    created_at: 1_759_700_000_000,
    open: false,
    content: { text },
    ...fields,
  }
}
const turn = (state: 'running' | 'idle', user: Record<string, unknown> | null = null, id: string | null = null) => ({
  type: 'turn',
  state,
  turn_id: state === 'running' ? id : null,
  user,
})
const turns = (kit: Kit) => kit.pi.messages().filter((message) => message.role === 'user').length

test('child updates preserve siblings and reconnect replaces the inventory while the parent is idle', async () => {
  const kit = await shared((kit) =>
    kit.world.remote(THREAD, {
      type: 'children',
      children: [
        { thread_id: 'child-one', reference: 'thread#s=child-one', kind: 'subagent', name: 'Scout', status: 'queued' },
        { thread_id: 'sibling', reference: 'thread#s=sibling', kind: 'subthread', name: 'Sibling', status: 'inactive' },
      ],
    }),
  )
  const started = turns(kit)
  await kit.until(() => band(kit).includes('queued'), 'the queued child')
  const scout = { thread_id: 'child-one', reference: 'thread#s=child-one', kind: 'subagent', name: 'Scout' }
  await deliver(kit, { type: 'child', child: { ...scout, status: 'running' } })
  expect(band(kit)).toContain('running')
  expect(band(kit)).not.toContain('inactive')
  expect(band(kit)).not.toContain('queued')
  await deliver(kit, {
    type: 'child',
    child: {
      thread_id: 'new-child',
      reference: 'thread#s=new-child',
      kind: 'future_kind',
      name: 'New',
      status: 'running',
    },
  })
  expect(band(kit)).toContain('+1 running')
  await deliver(kit, { type: 'child.remove', thread_id: 'child-one' })
  expect(band(kit)).not.toContain('Scout')
  expect(band(kit)).toContain('New')
  kit.world.endWatch(THREAD)
  await kit.until(() => band(kit).includes('unknown'), 'the inventory to be stale')
  // The next watch's snapshot reports no children yet, as when their discovery is slow.
  writeFileSync(join(kit.world.state, `events-${THREAD}.jsonl`), '')
  const watches = kit.commands().filter((args) => args[1] === 'watch').length
  await kit.advance(1000)
  await kit.until(() => kit.commands().filter((args) => args[1] === 'watch').length > watches, 'the reconnect')
  // Readiness clears the previous connection's inventory even when discovery is delayed.
  await kit.until(() => !band(kit).includes('New'), 'the old inventory to be cleared')
  expect(band(kit)).not.toContain('Review')
  await deliver(kit, {
    type: 'children',
    children: [
      { thread_id: 'child-two', reference: 'thread#s=child-two', kind: 'subthread', name: 'Review', status: 'failed' },
    ],
  })
  expect(band(kit)).toContain('failed')
  await deliver(kit, { type: 'child.remove', thread_id: 'child-two' })
  expect(band(kit)).not.toContain('Review')
  expect(turns(kit)).toBe(started)
})

test('animates only while a turn runs, and stops with the turn and with the watcher', async () => {
  const kit = await shared()
  expect(band(kit)).not.toContain('⠋')
  await deliver(kit, turn('running', { user_id: 'user-bob', name: 'Bob' }, 'spin'))
  expect(band(kit)).toContain('⠋')
  await kit.advance(120)
  expect(band(kit)).toContain('⠙')
  // While a turn runs, the animation's redraw is the only timer work.
  let renders = kit.pi.renders
  await kit.advance(120)
  expect(kit.pi.renders - renders).toBe(1)

  await deliver(kit, turn('idle'))
  expect(band(kit)).toContain(LIVE)
  renders = kit.pi.renders
  await kit.advance(1200)
  expect(kit.pi.renders).toBe(renders)

  // Teardown cancels the running turn's timer as well: after it, no timer runs.
  await deliver(kit, turn('running', { user_id: 'user-bob', name: 'Bob' }, 'spin-again'))
  await kit.whileTimePasses(kit.pi.shutdown('quit'))
  const fired = kit.clock.fired
  await kit.advance(1200)
  expect(kit.clock.fired).toBe(fired)

  // A finished share leaves a separate notice timer; teardown cancels that too.
  const again = await startDelta({ mode: 'tui', world: kit.world })
  kits.push(again)
  // The repository offered its setup once already, so this session is not asked again.
  await again.pi.prompt('two')
  await share(again)
  expect(band(again)).toContain('✔')
  await again.whileTimePasses(again.pi.shutdown('quit'))
  const after = again.clock.fired
  await again.advance(30_000)
  expect(again.clock.fired).toBe(after)
})

test('/delta share returns at once and reports in the band before exporting', async () => {
  const kit = await session()
  for (const prompt of ['a', 'b', 'c']) await kit.pi.prompt(prompt)
  const release = kit.world.hold('thread append')
  const notes = kit.pi.noticeTexts().length
  kit.pi.answers.push(SHARE)
  await kit.pi.command('delta', 'share')
  // Progress is the band's alone: a started share adds no transcript row.
  expect(kit.pi.noticeTexts()).toHaveLength(notes)
  // The band reports the running share before anything is exported.
  expect(band(kit)).toContain('Preparing to share')
  expect(kit.thread()?.records ?? []).toEqual([])
  await kit.advance(0)
  // The share goes on in the band's later steps, and nothing reaches Delta until its export is sent.
  await kit.until(() => kit.commands().some((args) => args[1] === 'append'), 'the export to be sent')
  expect(band(kit)).not.toContain('Preparing to share')
  expect(band(kit)).toMatch(/[2-5]\/5/)
  expect(kit.thread()?.records ?? []).toEqual([])
  release()
  await kit.until(() => kit.pi.noticeTexts().some((text) => text.startsWith('Delta: Shared')), 'the share to finish')
  const exported = JSON.stringify(kit.thread()!.records)
  for (const prompt of ['"a"', '"b"', '"c"']) expect(exported).toContain(prompt)
})

test('a prompt cannot race a share, and the band reports its progress and success', async () => {
  const kit = await session()
  const release = kit.world.hold('thread create')
  kit.pi.answers.push(SHARE)
  await kit.pi.command('delta', 'share')
  expect(band(kit)).toContain('Preparing to share')
  // A prompt cannot start a turn while the share is in flight.
  const started = turns(kit)
  expect(await kit.pi.prompt('race the share')).toBe('handled')
  expect(turns(kit)).toBe(started)
  await kit.until(() => kit.commands().some((args) => args.join(' ').startsWith('thread create')), 'the share to run')
  expect(raw(kit)).toContain(themeColor('warning'))
  release()
  await kit.until(() => band(kit).includes('✔'), 'the share to succeed')
  // Once the share is done, a prompt is accepted again.
  expect(await kit.pi.prompt('after the share')).toBe('settled')
})

test("another participant's turn names its owner, counts up, and goes quiet only with nothing open", async () => {
  const kit = await shared()
  await deliver(kit, turn('running', ADA, 'remote-turn'))
  expect(band(kit)).toContain("Ada's agent")
  await kit.advance(12_000)
  expect(band(kit)).toContain('(12s)')
  // An item still open, such as a long command, keeps the turn working however long it is silent.
  await deliver(kit, { type: 'item', item: item('npm test', { id: 'long', open: true }) })
  await kit.advance(31_000)
  expect(band(kit)).not.toContain('quiet')
  // Its completion is activity too; 30s after it, with nothing open, the turn is quiet.
  await deliver(kit, { type: 'item', item: item('npm test', { id: 'long' }) })
  await kit.advance(29_000)
  expect(band(kit)).not.toContain('quiet')
  await kit.advance(2_000)
  expect(band(kit)).toContain(' quiet 31s')
  await deliver(kit, turn('idle'))
  expect(band(kit)).not.toContain("Ada's agent")
}, 60_000)

test("another participant's turn takes its owner's name once Delta resolves who requested it", async () => {
  const kit = await shared()
  // Delta reports the turn before it knows the requester's user, then again once it does.
  const adaColor = (text: string) => styled({ text, color: personColor(personKey(ADA)), bold: true }, FAKE_THEME)
  await deliver(kit, turn('running', { user_id: null, name: null, actor_id: 'actor-ada' }, 'remote-turn'))
  expect(band(kit)).toContain('An agent')
  expect(raw(kit)).not.toContain(adaColor('An agent'))
  // A user resolved before their name still colors the agent as theirs.
  await deliver(kit, turn('running', { user_id: ADA.user_id, name: null, actor_id: 'actor-ada' }, 'remote-turn'))
  expect(band(kit)).toContain('An agent')
  expect(raw(kit)).toContain(adaColor('An agent'))
  await deliver(kit, turn('running', { ...ADA, actor_id: 'actor-ada' }, 'remote-turn'))
  expect(band(kit)).toContain("Ada's agent")
  expect(raw(kit)).toContain(adaColor("Ada's agent"))
})

test("another participant's agent shows what it is doing once a call or thought has been open half a second", async () => {
  const kit = await shared()
  await deliver(kit, turn('running', ADA, 'remote-turn'))
  const tool = (id: string, title: string, open: boolean) =>
    item('', {
      id,
      kind: 'tool_call',
      turn_id: 'remote-turn',
      open,
      content: { toolCallId: id, title, status: open ? 'in_progress' : 'completed' },
    })
  await deliver(kit, { type: 'item', item: tool('quick', 'Read src/a.rs', true) })
  await kit.advance(200)
  await deliver(
    kit,
    { type: 'item', item: tool('quick', 'Read src/a.rs', false) },
    { type: 'item', item: tool('test', 'cargo test -p thread', true) },
  )
  await kit.advance(300)
  // A quick call never shows, and a slow one waits out the same half second, so bursts do not flicker.
  expect(band(kit)).not.toContain('Read src/a.rs')
  expect(band(kit)).not.toContain('cargo test')
  await kit.advance(12_000)
  expect(band(kit)).toContain('cargo test -p thread')
  expect(band(kit)).toContain('(12s)')
  const thought = (open: boolean) =>
    item('', { id: 'thought', kind: 'agent_thought', turn_id: 'remote-turn', open, content: { text: 'Hmm' } })
  await deliver(kit, { type: 'item', item: thought(true) })
  await kit.advance(600)
  expect(band(kit)).toContain('thinking')
  await deliver(
    kit,
    { type: 'item', item: thought(false) },
    { type: 'item', item: tool('test', 'cargo test -p thread', false) },
  )
  expect(band(kit)).not.toContain('thinking')
  expect(band(kit)).not.toContain('cargo test')
  await deliver(kit, turn('idle'))
}, 60_000)
