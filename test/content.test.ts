import { describe, expect, test } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { generateUnifiedPatch } from '@earendil-works/pi-coding-agent'
import {
  isOwnContext,
  messageUpdates,
  recordedMessage,
  REMOTE_MESSAGE,
  shellMarkdown,
  toolCallsOf,
  toolInfo,
} from '../src/recording/content.ts'

const message = (value: Record<string, unknown>) => value as unknown as AgentMessage

describe('what is recorded', () => {
  test("prompts, replies, tool results and the person's shell commands are; framing is not", () => {
    expect(recordedMessage(message({ role: 'user', content: 'hi', timestamp: 1 }))).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    })
    expect(
      recordedMessage(
        message({
          role: 'bashExecution',
          command: 'ls',
          output: 'a\nb\n',
          exitCode: 0,
          cancelled: false,
          truncated: false,
          timestamp: 1,
        }),
      ),
    ).toEqual({ role: 'user', content: [{ type: 'text', text: 'Ran `ls`\n\n```\na\nb\n```' }] })
    // `!!` keeps a command out of the model's context, and out of the thread too.
    expect(
      recordedMessage(
        message({ role: 'bashExecution', command: 'ls', output: '', exitCode: 0, excludeFromContext: true }),
      ),
    ).toBeUndefined()
    for (const role of ['custom', 'compactionSummary', 'branchSummary', 'system'])
      expect(recordedMessage(message({ role, content: 'framing', summary: 's' }))).toBeUndefined()
    expect(isOwnContext(message({ role: 'custom', customType: REMOTE_MESSAGE, content: 'x' }))).toBe(true)
    expect(isOwnContext(message({ role: 'custom', customType: 'other', content: 'x' }))).toBe(false)
  })

  test("a shell command's failure or cancellation is said after its output", () => {
    expect(shellMarkdown('make', 'boom', { exitCode: 2 })).toBe('Ran `make`\n\n```\nboom\n```\n\n(exit code 2)')
    expect(shellMarkdown('sleep 9', '', { cancelled: true })).toBe('Ran `sleep 9`\n\n(cancelled)')
    expect(shellMarkdown('echo `x`', '')).toBe('Ran `` echo `x` ``')
    expect(shellMarkdown('a\nb', '')).toBe('Ran\n\n```\na\nb\n```')
  })
})

describe('translation', () => {
  test('a reply keeps its parts in order: messages, thoughts with their opaque metadata, and calls', () => {
    const reply = recordedMessage(
      message({
        role: 'assistant',
        content: [
          { type: 'text', text: 'Looking.' },
          { type: 'thinking', thinking: 'plan', thinkingSignature: 'sig' },
          { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'src/a.ts', offset: 10, limit: 5 } },
          { type: 'thinking', thinking: '', redacted: true, thinkingSignature: 'enc' },
          { type: 'text', text: '  ' },
          { type: 'text', text: 'Done.' },
        ],
      }),
    )!
    expect(messageUpdates(reply, 'm', { root: '/repo', cwd: '/repo' })).toEqual([
      { sessionUpdate: 'agent_message', messageId: 'm:message:0', content: [{ type: 'text', text: 'Looking.' }] },
      {
        sessionUpdate: 'agent_thought',
        messageId: 'm:thought:1',
        content: [{ type: 'text', text: 'plan' }],
        _meta: { pi: { block: { type: 'thinking', thinking: 'plan', thinkingSignature: 'sig' } } },
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        name: 'read',
        title: 'Read src/a.ts (10 - 14)',
        kind: 'read',
        status: 'in_progress',
        rawInput: { path: 'src/a.ts', offset: 10, limit: 5 },
      },
      {
        sessionUpdate: 'agent_thought',
        messageId: 'm:thought:3',
        content: [{ type: 'text', text: '[redacted thinking]' }],
        _meta: { pi: { block: { type: 'thinking', thinking: '', redacted: true, thinkingSignature: 'enc' } } },
      },
      { sessionUpdate: 'agent_message', messageId: 'm:message:5', content: [{ type: 'text', text: 'Done.' }] },
    ])
    expect(toolCallsOf(reply)).toEqual([['call-1', { path: 'src/a.ts', offset: 10, limit: 5 }]])
  })

  test("pi's tools are titled and kinded as Delta shows its own agents' calls", () => {
    const info = (name: string, input: unknown) => toolInfo(name, input, '/repo', '/repo')
    expect(info('bash', { command: 'cargo test \\\n  -p x' })).toEqual({
      title: 'cargo test \\ -p x',
      kind: 'execute',
    })
    expect(info('read', { path: '/elsewhere/b.rs' })).toEqual({ title: 'Read /elsewhere/b.rs', kind: 'read' })
    expect(info('edit', { path: '/repo/src/main.rs' })).toEqual({ title: 'Edit src/main.rs', kind: 'edit' })
    expect(info('write', { path: 'notes.txt' })).toEqual({ title: 'Write notes.txt', kind: 'edit' })
    expect(info('grep', { pattern: 'fn main', path: 'src', ignoreCase: true, glob: '*.rs' })).toEqual({
      title: 'grep -i --include="*.rs" "fn main" src',
      kind: 'search',
    })
    expect(info('find', { pattern: '*.ts', path: '/repo/src' })).toEqual({
      title: 'Find `src` `*.ts`',
      kind: 'search',
    })
    expect(info('ls', {})).toEqual({ title: 'List .', kind: 'search' })
    expect(info('mcp__linear__get_issue', {})).toEqual({ title: 'mcp__linear__get_issue', kind: 'other' })
  })

  test('a tool result completes or fails its call, keeping its output', () => {
    const result = recordedMessage(
      message({
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'ok' }],
        details: { truncated: false },
        isError: false,
      }),
    )!
    expect(messageUpdates(result, 'r')).toEqual([
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'completed',
        rawOutput: { content: [{ type: 'text', text: 'ok' }], details: { truncated: false } },
        content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
      },
    ])
    const failed = recordedMessage(
      message({ role: 'toolResult', toolCallId: 'c', toolName: 'bash', content: [], isError: true }),
    )!
    expect(messageUpdates(failed, 'r')[0]).toMatchObject({ status: 'failed' })
    expect(messageUpdates(failed, 'r', { omitted: new Set(['c']) })).toEqual([])
  })

  test('an edit is recorded as a diff of its patch, paths relative to the checkout', () => {
    const patch = generateUnifiedPatch('src/main.rs', 'a\nb\n', 'a\nc\n')
    const result = recordedMessage(
      message({
        role: 'toolResult',
        toolCallId: 'e',
        toolName: 'edit',
        content: [{ type: 'text', text: 'Edited' }],
        details: { diff: '…', patch },
        isError: false,
      }),
    )!
    const [update] = messageUpdates(result, 'r', {
      root: '/repo',
      cwd: '/repo',
      inputs: new Map([['e', { path: 'src/main.rs' }]]),
    })
    expect(update!.rawOutput).toBeNull()
    const diff = (update!.content as any[]).find((item) => item.type === 'diff')
    expect(diff.changes).toEqual([{ operation: 'modify', path: '/repo/src/main.rs' }])
    expect(diff.patch.format).toBe('git_patch')
    expect(
      diff.patch.text.startsWith('diff --git a/src/main.rs b/src/main.rs\n--- a/src/main.rs\n+++ b/src/main.rs\n@@ '),
    ).toBe(true)
    expect(diff.patch.text).toContain('-b\n+c\n')
  })

  test('a write is a new file or a replacement, with a patch against what it replaced', () => {
    const result = (id: string) =>
      recordedMessage(message({ role: 'toolResult', toolCallId: id, toolName: 'write', content: [], isError: false }))!
    const translation = {
      root: '/repo',
      cwd: '/repo/sub',
      inputs: new Map([
        ['new', { path: 'x.txt', content: 'one\n' }],
        ['old', { path: '/repo/y.txt', content: 'two\n' }],
        ['big', { path: '/repo/z.txt', content: 'three\n' }],
      ]),
      priorFiles: new Map([
        ['new', { existed: false }],
        ['old', { existed: true, text: 'zero\n' }],
        ['big', { existed: true }],
      ]),
      patch: generateUnifiedPatch,
    }
    const diff = (id: string) =>
      (messageUpdates(result(id), 'r', translation)[0]!.content as any[]).find((item) => item.type === 'diff')
    expect(diff('new').changes).toEqual([{ operation: 'add', path: '/repo/sub/x.txt' }])
    expect(diff('new').patch.text).toContain('new file mode 100644\n--- /dev/null\n+++ b/sub/x.txt\n')
    expect(diff('old').patch.text).toContain('-zero\n+two\n')
    // A file too large to keep beforehand is named, without a patch.
    expect(diff('big')).toEqual({ type: 'diff', changes: [{ operation: 'modify', path: '/repo/z.txt' }] })
  })
})
