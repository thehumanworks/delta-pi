// A teammate's activity in pi: the rows the model reads, what the person sees drawn, and that nothing
// arriving from the thread runs or is recorded back. Ported from the upstream plugin's engine tests
// (hooks/register.test.ts, "remote activity") onto the kit.
import { afterEach, expect, test } from 'vitest'
import type { WatchComment, WatchItem } from '../../src/cli/thread-commands.ts'
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
/** The thread the share creates: the fake Delta numbers threads from one. */
const THREAD = 'thread_1'
const ADA = { user_id: 'user-ada', name: 'Ada' }
const CLAUDE = { user_id: null, name: 'Claude' }

let items = 0
/** A completed remote item by Ada; override any field. */
function item(text: string, fields: Partial<WatchItem> = {}): WatchItem {
  return {
    id: `item-${++items}`,
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
/** A delivered comment by Ada on a passage of the transcript; override any field. */
function comment(text: string, fields: Partial<WatchComment> & { id: string }): WatchComment {
  return {
    chain: fields.id,
    after_id: null,
    delivered_with: 'item-delivering',
    routed_to: null,
    author: ADA,
    co_authors: [],
    agent: false,
    created_at: 1_759_700_000_000,
    text,
    target: { kind: 'transcript', item_id: null, quote: 'the parser' },
    ...fields,
  }
}

/** A session shared with `/delta share`, once its watch is live; the watch's snapshot is what `before` wrote. */
async function shared(before?: (kit: Kit) => void) {
  const kit = await startDelta({ answers: [NOT_NOW] })
  kits.push(kit)
  before?.(kit)
  await kit.until(() => kit.pi.dialogs.length === 1, 'the setup offer')
  await kit.pi.prompt('one')
  kit.pi.answers.push(SHARE)
  await kit.pi.command('delta', 'share')
  await kit.until(() => kit.pi.noticeTexts().some((text) => text.startsWith('Delta: Shared')), 'the share to finish')
  await kit.until(() => kit.pi.statuses.get('delta')?.startsWith('●'), 'the watch to be live')
  return kit
}

/** What the model read from the thread: each row's first line. */
const rows = (kit: Kit) => kit.pi.contextMessages().map((message) => String(message.content).split('\n', 1)[0]!)
/** Wait until the model has read `count` rows from the thread, and nothing more arrives meanwhile. */
async function offered(kit: Kit, count: number) {
  await kit.until(() => rows(kit).length >= count, `${count} rows`)
  await kit.settle()
  return rows(kit)
}
const expectOffered = (kit: Kit, ids: string[]) => {
  expect(rows(kit)).toHaveLength(ids.length)
  ids.forEach((id, index) => expect(rows(kit)[index]).toContain(`(item ${id})`))
}
/** The row drawn for item `id`, or comment `comment:id`, as pi draws it `width` columns wide. */
function drawn(kit: Kit, id: string, width = 100, raw = false) {
  const named = id.startsWith('comment:') ? `(comment ${id.slice('comment:'.length)})` : `(item ${id})`
  const row = kit.pi
    .drawnRows(width, raw)
    .find((entry) => String(entry.content).split('\n', 1)[0]!.endsWith(`${named}:`))
  return row?.lines
}
/** How many prompts started a turn: incoming activity never does. */
const turns = (kit: Kit) => kit.pi.messages().filter((message) => message.role === 'user').length
const records = (kit: Kit): any[] => kit.thread()?.records ?? []

test('land activity draws from snapshots and live updates without starting a turn or echoing to Delta', async () => {
  const createdText =
    'Land changes: \n<subthread-event kind="land" event="created" note="Informational, not a task.">\n</subthread-event>'
  const kit = await shared((kit) =>
    kit.world.remote(THREAD, {
      type: 'item',
      item: item(createdText, {
        id: 'land-start',
        kind: 'subthread_event',
        content: { text: createdText, thread_id: 'land-child', event: 'created' },
      }),
    }),
  )
  const started = turns(kit)
  await offered(kit, 1)
  expectOffered(kit, ['land-start'])
  const start = drawn(kit, 'land-start')!.join('\n')
  expect(start).toContain('Land changes')
  expect(start).not.toContain('<subthread-event')
  expect(JSON.stringify(kit.pi.contextMessages())).toContain('Informational, not a task.')

  const landed = 'Landed: Land Changes\nmain 2d867ce6c CI passed'
  kit.world.remote(THREAD, {
    type: 'item',
    item: item(landed, {
      id: 'land-end',
      kind: 'subthread_event',
      content: { text: landed, thread_id: 'land-child', event: 'landed' },
    }),
  })
  await offered(kit, 2)
  expectOffered(kit, ['land-start', 'land-end'])
  const end = drawn(kit, 'land-end')!.join('\n')
  for (const text of ['Landed: Land Changes', 'main 2d867ce6c CI passed']) expect(end).toContain(text)
  expect(turns(kit)).toBe(started)
  expect(JSON.stringify(records(kit))).not.toContain('land-child')

  const watches = kit.commands().filter((args) => args[1] === 'watch').length
  kit.world.endWatch(THREAD)
  await kit.until(() => kit.pi.noticeTexts().some((text) => text.startsWith('Connection interrupted')), 'the drop')
  await kit.advance(1000)
  await kit.until(() => kit.commands().filter((args) => args[1] === 'watch').length > watches, 'the reconnect')
  await kit.until(() => kit.pi.statuses.get('delta')?.startsWith('●'), 'the watch to be live again')
  await kit.settle()
  expectOffered(kit, ['land-start', 'land-end'])
})

test('a snapshot draws completed messages without waiting for children or starting a turn', async () => {
  // The fake Delta reports no children at all, which is a child inventory that never arrives.
  const kit = await shared((kit) =>
    kit.world.remote(
      THREAD,
      ...[
        item('Earlier question', { id: 'a' }),
        item('Earlier answer', { id: 'b', kind: 'agent_message', author: CLAUDE }),
        item('Still typing', { id: 'c', kind: 'agent_message', author: CLAUDE, open: true }),
        item('mystery', { id: 'd', kind: 'unknown' }),
      ].map((entry) => ({ type: 'item', item: entry })),
    ),
  )
  const started = turns(kit)
  await offered(kit, 2)
  expectOffered(kit, ['a', 'b'])
  // A message reaches the person and the model through its drawn row, not as a notice.
  expect(kit.pi.noticeTexts().some((text) => text.startsWith('Ada:') || text.startsWith('Claude:'))).toBe(false)
  expect(drawn(kit, 'a')!.join('\n')).toContain('Earlier question')
  expect(drawn(kit, 'b')!.join('\n')).toContain('Earlier answer')
  expect(turns(kit)).toBe(started)
  // The rows reach pi's context, never Delta again.
  expect(JSON.stringify(records(kit))).not.toContain('Earlier question')
  expect(await kit.pi.prompt('continue')).toBe('settled')
  expect(rows(kit)).toHaveLength(2)
})

test("a snapshot's comments follow their messages, and a restart repeats none of them", async () => {
  const kit = await shared((kit) =>
    kit.world.remote(
      THREAD,
      { type: 'item', item: item('Please look at these.', { id: 'm' }) },
      { type: 'comment', comment: comment('Why this?', { id: 'c', delivered_with: 'm' }) },
    ),
  )
  await offered(kit, 2)
  expect(rows(kit)).toHaveLength(2)
  expect(rows(kit)[0]).toContain('(item m)')
  expect(rows(kit)[1]).toContain('(comment c)')
  // Reconnecting sends the same snapshot again, which adds nothing.
  const watches = kit.commands().filter((args) => args[1] === 'watch').length
  kit.world.endWatch(THREAD)
  await kit.until(() => kit.pi.noticeTexts().some((text) => text.startsWith('Connection interrupted')), 'the drop')
  await kit.advance(1000)
  await kit.until(() => kit.commands().filter((args) => args[1] === 'watch').length > watches, 'the reconnect')
  await kit.until(() => kit.pi.statuses.get('delta')?.startsWith('●'), 'the watch to be live again')
  await kit.settle()
  expect(rows(kit)).toHaveLength(2)
  // Nor does a new pi process resuming the session.
  await kit.whileTimePasses(kit.pi.shutdown('quit'))
  const again = await startDelta({ world: kit.world, session: kit.pi.session })
  kits.push(again)
  await again.until(() => again.commands().some((args) => args[1] === 'watch'), 'the resumed watch')
  await again.until(() => again.pi.statuses.get('delta')?.startsWith('●'), 'the resumed watch to be live')
  await again.settle()
  expect(rows(again)).toHaveLength(2)
})

test("an agent's reply draws once, as the reply under the line it answers, and its emptied message adds nothing", async () => {
  const kit = await shared()
  const agent = { user_id: null, name: 'openai-subscribed/gpt-6-luna' }
  kit.world.remote(
    THREAD,
    { type: 'item', item: item('hello dude', { id: 'q' }) },
    { type: 'item', item: item('Hey! What can I help you with?', { id: 'a', kind: 'agent_message', author: agent }) },
    { type: 'item', item: item('', { id: 'm' }) },
    {
      type: 'comment',
      comment: comment('who is you?', {
        id: 'c',
        delivered_with: 'm',
        target: { kind: 'transcript', item_id: 'a', quote: 'you' },
      }),
    },
    // Delta leaves the reply's block out of the agent's message, which can leave it empty.
    { type: 'item', item: item('', { id: 'b', kind: 'agent_message', author: agent }) },
    {
      type: 'comment',
      comment: comment('I meant you.', {
        id: 'r',
        chain: 'c',
        after_id: 'c',
        delivered_with: 'm',
        target: null,
        agent: true,
        author: agent,
      }),
    },
  )
  await offered(kit, 4)
  expect(rows(kit)).toEqual([
    '[Delta] Ada, user message (item q):',
    '[Delta] openai-subscribed/gpt-6-luna, agent message (item a):',
    '[Delta] Ada, comment (comment c):',
    '[Delta] openai-subscribed/gpt-6-luna, reply to a comment (comment r):',
  ])
  const root = drawn(kit, 'comment:c', 60, true)!
  const plain = drawn(kit, 'comment:c', 60)!.join('\n')
  for (const part of ['Ada', ' commented on', 'Hey! What can I help ', 'you', ' with?', 'who is you?'])
    expect(plain).toContain(part)
  expect(root.join('\n')).toContain(FAKE_THEME.underline('you'))
  const reply = drawn(kit, 'comment:r', 60)!.join('\n')
  for (const part of ['↳ ', 'openai-subscribed/gpt-6-luna', ' replied to Ada', 'who is you?', 'I meant you.'])
    expect(reply).toContain(part)
  // The message that only held the reply is not drawn, and adds no row of its own.
  expect(drawn(kit, 'b')).toBeUndefined()
  expect(JSON.stringify(kit.pi.contextMessages())).not.toContain('(item b)')
})

test("the command output row draws its author and the item's own markdown", async () => {
  const kit = await shared()
  kit.world.remote(THREAD, { type: 'item', item: item('# Title\n\n**bold** and `code`', { id: 'm' }) })
  await offered(kit, 1)
  const message = drawn(kit, 'm')!.join('\n')
  expect(message).toContain('Ada')
  expect(drawn(kit, 'm', 100, true)!.join('\n')).toContain(
    FAKE_THEME.bold(styled({ text: 'Ada', color: personColor(personKey(ADA)) }, FAKE_THEME)),
  )
  expect(message).toContain('(person)')
  // The body is the item's own markdown, not the row the model reads.
  expect(message).toContain('Title')
  expect(message).toContain('bold and code')
  expect(message).not.toContain('**bold**')
  expect(message).not.toContain('[Delta]')
  // Another agent's message is labelled apart from a person's, its author in the color the band gives them.
  kit.world.remote(THREAD, { type: 'item', item: item('Reply', { id: 'r', kind: 'agent_message', author: CLAUDE }) })
  await offered(kit, 2)
  expect(drawn(kit, 'r')!.join('\n')).toContain('Claude (agent)')
  expect(drawn(kit, 'r', 100, true)!.join('\n')).toContain(
    styled({ text: 'Claude', color: personColor(personKey(CLAUDE)), bold: true }, FAKE_THEME),
  )
  const notices = kit.pi.notices.length
  kit.world.remote(THREAD, {
    type: 'item',
    item: item('', {
      id: 't',
      kind: 'tool_call',
      author: { user_id: null, name: 'Delta agent' },
      content: { name: 'Bash', status: 'failed', rawInput: { command: 'head -40 README.md\n  && ls' } },
    }),
  })
  await offered(kit, 3)
  // Nothing about it reaches the transcript as a notice.
  expect(
    kit.pi
      .noticeTexts()
      .slice(notices)
      .filter((text) => text.includes('Bash')),
  ).toEqual([])
  const tool = drawn(kit, 't')!
  // The whole call is one line, cut at the end if it must be, so no part wraps on its own.
  expect(tool).toHaveLength(1)
  expect(tool[0]).toContain('Delta agent')
  expect(tool[0]).toContain('Bash')
  // The key input is flattened onto the line, and a failure is red.
  expect(tool[0]).toContain('head -40 README.md && ls')
  expect(tool[0]).toContain('(failed)')
  expect(drawn(kit, 't', 100, true)![0]).toContain(`${themeColor('error')} (failed)`)
  // Rows drawn for removed messages and tools draw nothing.
  for (const id of ['m', 't']) {
    kit.world.remote(THREAD, { type: 'remove', id })
    await kit.until(() => drawn(kit, id)?.length === 0, `the row for ${id} to be cleared`)
  }
  expect(drawn(kit, 'r')!.join('\n')).toContain('Reply')
})

test('a drawn row redraws a teammate’s edit, and its quote fits the terminal’s width', async () => {
  const kit = await shared()
  const line = `${'Lead-in words before it. '.repeat(6)}Look at the parser here. ${'And words after it. '.repeat(6)}`
  kit.world.remote(
    THREAD,
    { type: 'item', item: item(line, { id: 'q' }) },
    {
      type: 'comment',
      comment: comment('Why?', { id: 'c', target: { kind: 'transcript', item_id: 'q', quote: 'the parser' } }),
    },
  )
  await offered(kit, 2)
  // The quoted context fills the row it is drawn in, however wide.
  for (const width of [60, 160]) {
    const quote = drawn(kit, 'comment:c', width)!.find((text) => text.includes('│'))!
    expect(quote).toContain('the parser')
    expect(quote.trimEnd().length).toBeGreaterThan(width - 6)
    expect(quote.length).toBeLessThanOrEqual(width)
  }
  kit.world.remote(THREAD, { type: 'item', item: item('Edited: the parser is fine.', { id: 'q' }) })
  await kit.until(() => drawn(kit, 'q')!.join('\n').includes('Edited: the parser is fine.'), 'the edit to be drawn')
  // The model reads the edit as a correction; the drawn row simply shows the item as it is now.
  await offered(kit, 3)
  expect(rows(kit)[2]).toContain('changed an earlier user message (item q)')
  kit.world.remote(THREAD, { type: 'comment.remove', id: 'c' })
  await kit.until(() => drawn(kit, 'comment:c')?.length === 0, 'the withdrawn comment to be cleared')
})

test('incoming activity never executes or starts a turn, and the band shows only status', async () => {
  const kit = await shared()
  await kit.until(() => records(kit).length && kit.thread(), 'the conversation to be shared')
  const before = records(kit).length
  const started = turns(kit)
  const line = JSON.stringify({ type: 'item', item: item('complete response', { kind: 'agent_message' }) }) + '\n'
  kit.world.remoteRaw(THREAD, line.slice(0, 20))
  kit.world.remoteRaw(THREAD, line.slice(20))
  await offered(kit, 1)
  kit.world.endWatch(THREAD, 2)
  await kit.until(
    () => kit.pi.noticeTexts().some((text) => text.startsWith('Connection interrupted')),
    'the interruption to be noted',
  )
  expect(kit.pi.statuses.get('delta')).not.toContain('complete response')
  expect(turns(kit)).toBe(started)
  expect(records(kit)).toHaveLength(before)
})

test("a remote agent's thinking is announced when it completes, but never reaches Claude", async () => {
  const kit = await shared()
  const thought = item('Weighing', { id: 'thought', kind: 'agent_thought', author: CLAUDE, open: true })
  kit.world.remote(
    THREAD,
    { type: 'item', item: thought },
    { type: 'item.append', id: 'thought', text: ' two approaches\nso far' },
  )
  const completed = { ...thought, open: false, content: { text: 'Weighing two approaches\nso far' } }
  kit.world.remote(THREAD, { type: 'item', item: completed })
  // A later re-send of the completed thought is not announced again.
  kit.world.remote(THREAD, { type: 'item', item: { ...completed, after_id: 'moved' } })
  const announced = () => kit.pi.noticeTexts().filter((text) => text.startsWith('Claude (thinking)'))
  await kit.until(() => announced().length, 'the thought to be announced')
  await new Promise((resolve) => setTimeout(resolve, 200))
  await kit.settle()
  // The person sees the whole thought, labelled, and never the model.
  expect(announced()).toEqual(['Claude (thinking)\nWeighing two approaches so far'])
  expect(rows(kit)).toEqual([])
})

test('supersession aborts the owned turn and remote rows wait until it ends', async () => {
  const kit = await shared()
  let answer!: (text: string) => void
  kit.pi.model = () => new Promise((resolve) => (answer = (text) => resolve({ text })))
  const turn = kit.pi.submit('local turn')
  const running = await kit.until(
    () => records(kit).findLast((record) => record.update.state === 'running'),
    'the turn to start',
  )
  const started = turns(kit)
  // Another sequence's supersession is not this turn's.
  kit.world.remote(THREAD, { type: 'producer.turn', sequence: running.sequence + 100, status: 'superseded' })
  await new Promise((resolve) => setTimeout(resolve, 200))
  await kit.settle()
  expect(kit.pi.aborts).toBe(0)
  kit.world.remote(
    THREAD,
    { type: 'turn', state: 'running', turn_id: 'ada-turn', user: ADA },
    { type: 'producer.turn', sequence: running.sequence, status: 'superseded' },
  )
  await kit.until(() => kit.pi.statuses.get('delta')?.includes('Ada'), "Ada's turn to show")
  kit.world.remote(THREAD, { type: 'item', item: item('Taking over: stop that', { id: 'takeover' }) })
  await kit.until(() => kit.pi.aborts, 'the turn to be stopped')
  await new Promise((resolve) => setTimeout(resolve, 200))
  await kit.settle()
  expect(kit.pi.aborts).toBe(1)
  // A row added now would land inside the stopped turn.
  expect(rows(kit)).toEqual([])
  answer('late')
  await turn
  await offered(kit, 1)
  expectOffered(kit, ['takeover'])
  expect(turns(kit)).toBe(started)
})
