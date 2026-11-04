import { expect, test } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { recordedMessage } from '../src/recording/content.ts'
import { snapshotMessages } from '../src/recording/snapshot.ts'

const message = (value: Record<string, unknown>) => value as unknown as AgentMessage

test('snapshot formats separate and combined bash rows without changing assistant text', () => {
  // pi keeps a shell command the person ran and its output as one message.
  const shell = message({
    role: 'bashExecution',
    command: 'ls',
    output: 'Applications\n',
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp: 1,
  })
  const silent = message({ role: 'bashExecution', command: 'ls', output: '', exitCode: 0, excludeFromContext: true })
  const literal = [{ type: 'text', text: '<bash-input>ls</bash-input>' }]
  const prompt = message({ role: 'user', content: literal, timestamp: 2 })
  const reply = message({ role: 'assistant', content: literal, stopReason: 'stop', timestamp: 3 })
  const branch = [shell, silent, prompt, reply]
  const before = structuredClone(branch)
  expect(snapshotMessages(branch)).toEqual([
    { role: 'user', content: [{ type: 'text', text: 'Ran `ls`\n\n```\nApplications\n```' }] },
    { role: 'user', content: literal },
    { role: 'assistant', content: literal },
  ])
  expect(branch).toEqual(before)
})

test('snapshot export keeps the last 4096 messages in order without changing them', () => {
  const messages = Array.from({ length: 4100 }, (_, index) =>
    message({ role: 'user', content: [{ type: 'text', text: `message-${index}` }], timestamp: index }),
  )
  // Framing between them is not conversation, so it takes none of the export's room.
  const branch = messages.flatMap((entry, index) =>
    index % 1000 === 999 ? [entry, message({ role: 'custom', customType: 'other', content: 'framing' })] : [entry],
  )
  const before = structuredClone(branch)
  const exported = snapshotMessages(branch)
  expect(exported).toHaveLength(4096)
  expect(exported[0]).toEqual(recordedMessage(messages[4]!))
  expect(exported.at(-1)).toEqual(recordedMessage(messages.at(-1)!))
  expect(exported).toEqual(messages.slice(4).map((entry) => recordedMessage(entry)))
  expect(branch).toEqual(before)
})
