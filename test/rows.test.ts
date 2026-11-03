import { afterEach, expect, test } from 'vitest'
import type { Host } from '../src/core/host.ts'
import { RemoteView } from '../src/watch/conversation.ts'
import { settleRemote } from '../src/watch/rows.ts'
import { feed } from '../src/watch/watch.ts'

afterEach(() => {
  feed.connection = { phase: 'stopped' }
  feed.view = undefined
})

test('a row taken just before a run starts waits for it to end, then reaches the model once', async () => {
  let idle = true
  const sent: { whileIdle: boolean; text: unknown }[] = []
  const host = {
    session: { idle: () => idle },
    ui: { debug() {}, note() {} },
    store: { async set() {} },
    pi: { sendMessage: (message: { content: unknown }) => sent.push({ whileIdle: idle, text: message.content }) },
  } as unknown as Host
  feed.connection = { phase: 'failed', session: 's' }
  const view = new RemoteView('t', { thread: 't', items: {} })
  feed.view = view
  view.endSnapshot()
  view.upsert({
    id: 'a',
    kind: 'user_message',
    after_id: null,
    turn_id: null,
    author: null,
    created_at: 1,
    open: false,
    content: { text: 'Remote' },
  })
  // pi starts a run while the row is being prepared.
  const settling = settleRemote(host, 's')
  await Promise.resolve()
  idle = false
  await settling
  expect(sent).toEqual([])
  expect(view.settled).toBe(false)
  // Once the run has ended, the row it held back is added, once.
  idle = true
  await settleRemote(host, 's')
  expect(sent).toHaveLength(1)
  expect(sent[0]!.whileIdle).toBe(true)
  expect(String(sent[0]!.text)).toContain('Remote')
  expect(view.settled).toBe(true)
})

test('a row taken from a snapshot the watch replaced is not added from the new one', async () => {
  const view = new RemoteView('t', { thread: 't', items: {} })
  view.upsert({
    id: 'a',
    kind: 'user_message',
    after_id: null,
    turn_id: null,
    author: null,
    created_at: 1,
    open: false,
    content: { text: 'Withdrawn' },
  })
  view.endSnapshot()
  const row = await view.nextRow()
  view.defer(row!)
  // The watch reconnects, and the new snapshot no longer has the item.
  view.reset()
  view.endSnapshot()
  expect(await view.nextRow()).toBeUndefined()
  expect(view.settled).toBe(true)
})
