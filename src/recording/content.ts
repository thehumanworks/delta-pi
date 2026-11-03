/**
 * Translating pi's messages into the ACP updates Delta records: prompts, replies, thinking, tool
 * calls and their results, edits as diffs, and shell commands the person ran. Only conversation is
 * recorded; pi's model-only framing (compaction and branch summaries, other extensions' context
 * messages, and the remote activity this extension adds) stays out.
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isJsonObject, type JsonObject, jsonText } from '../core/json.ts'

type RecordValue = Record<string, unknown>
export type Update = RecordValue & { sessionUpdate: string }

/** A pi message as Delta records it: its role, and its content as blocks. */
export type RecordedMessage =
  | { role: 'user'; content: RecordValue[] }
  | { role: 'assistant'; content: RecordValue[] }
  | {
      role: 'toolResult'
      toolCallId: string
      toolName: string
      content: RecordValue[]
      details: unknown
      isError: boolean
    }

/** The custom message type this extension adds remote thread activity to the model's context under. */
export const REMOTE_MESSAGE = 'delta'

/**
 * The part of a pi message Delta records, or undefined for a message that is not conversation. A
 * shell command the person ran with `!` is recorded as their own message; one run with `!!`, which
 * pi keeps out of the model's context, stays out of the thread too.
 */
export function recordedMessage(message: AgentMessage): RecordedMessage | undefined {
  const value = message as { role?: unknown } & RecordValue
  if (value.role === 'user') return { role: 'user', content: contentBlocks(value.content) }
  if (value.role === 'assistant') return { role: 'assistant', content: contentBlocks(value.content) }
  if (value.role === 'toolResult' && typeof value.toolCallId === 'string')
    return {
      role: 'toolResult',
      toolCallId: value.toolCallId,
      toolName: typeof value.toolName === 'string' ? value.toolName : 'tool',
      content: contentBlocks(value.content),
      details: value.details,
      isError: value.isError === true,
    }
  if (value.role === 'bashExecution' && value.excludeFromContext !== true && typeof value.command === 'string') {
    const exit = typeof value.exitCode === 'number' ? value.exitCode : undefined
    const text = shellMarkdown(value.command, typeof value.output === 'string' ? value.output : '', {
      exitCode: exit,
      cancelled: value.cancelled === true,
    })
    return { role: 'user', content: [{ type: 'text', text }] }
  }
}

function contentBlocks(content: unknown): RecordValue[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  return content.map((block) => (isJsonObject(block) ? { ...block } : { type: 'text', text: jsonText(block) }))
}

/** A fence long enough that `body` cannot close it. */
function fence(body: string, minimum: number) {
  let length = minimum
  for (const run of body.matchAll(/`+/g)) length = Math.max(length, run[0].length + 1)
  return '`'.repeat(length)
}

/** A shell command the person ran, with its output, readable as markdown. */
export function shellMarkdown(
  command: string,
  output: string,
  outcome: { exitCode?: number; cancelled?: boolean } = {},
) {
  const fenced = (body: string) => {
    const delimiter = fence(body, 3)
    return `${delimiter}\n${body}${body.endsWith('\n') ? '' : '\n'}${delimiter}`
  }
  let ran: string
  if (/[\r\n]/.test(command)) ran = `Ran\n\n${fenced(command)}`
  else {
    const delimiter = fence(command, 1)
    const padding = command.startsWith('`') || command.endsWith('`') ? ' ' : ''
    ran = `Ran ${delimiter}${padding}${command}${padding}${delimiter}`
  }
  const parts = [ran]
  if (output.trim()) parts.push(fenced(output))
  if (outcome.cancelled) parts.push('(cancelled)')
  else if (outcome.exitCode !== undefined && outcome.exitCode !== 0) parts.push(`(exit code ${outcome.exitCode})`)
  return parts.join('\n\n')
}

function object(value: unknown): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined
}

function base64(value: unknown): value is string {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  if (value.endsWith('==')) return (alphabet.indexOf(value.charAt(value.length - 3)) & 15) === 0
  if (value.endsWith('=')) return (alphabet.indexOf(value.charAt(value.length - 2)) & 3) === 0
  return true
}

/** Content blocks as ACP content: text and images as they are, anything else visible as JSON text. */
function blocks(value: unknown): RecordValue[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  if (!Array.isArray(value)) return value == null ? [] : blocks([value])
  return value.map((item) => {
    const block = object(item)
    if (!block) return { type: 'text', text: jsonText(item) }
    if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text }
    if (block.type === 'image' && base64(block.data) && typeof block.mimeType === 'string')
      return { type: 'image', data: block.data, mimeType: block.mimeType }
    // Unknown content remains visible and recoverable rather than silently disappearing.
    return { type: 'text', text: jsonText(block) }
  })
}

/** `path` relative to the directory `root`, or undefined when it lies outside it. */
function relativePath(path: string, root?: string): string | undefined {
  const base = root?.replace(/\/+$/, '')
  return base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : undefined
}

/**
 * A tool's path argument made absolute against the directory pi resolved it in, the way pi's own tools
 * resolve it (`resolveToCwd`, which pi does not export): Unicode spaces read as spaces, a leading `@`
 * is dropped, `~` is the home directory, and a `file://` URL is its path.
 */
export function absolutePath(path: string, cwd: string): string {
  let normalized = path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
  if (normalized.startsWith('@')) normalized = normalized.slice(1)
  if (normalized === '~') return homedir()
  if (normalized.startsWith('~/')) normalized = join(homedir(), normalized.slice(2))
  else if (/^file:\/\//.test(normalized)) normalized = fileURLToPath(normalized)
  return isAbsolute(normalized) ? normalized : resolve(cwd, normalized)
}

/** What a write tool call found before it ran: whether the file existed, and its text when it was small. */
export type PriorFile = { existed: boolean; text?: string }

/** The context translation needs: where paths are shown from, which calls stay out, and edit inputs. */
export type Translation = {
  /** Paths inside it are shown relative to it. */
  root?: string
  /** The directory pi resolves relative tool paths in. */
  cwd?: string
  /** Calls left out of Delta's transcript, so their results are left out too. */
  omitted?: ReadonlySet<string>
  /** The arguments of each tool call, by its id, for a result that needs them. */
  inputs?: ReadonlyMap<string, unknown>
  /** The file each write call replaced, by its id. */
  priorFiles?: ReadonlyMap<string, PriorFile>
  /** Builds a unified patch between two texts, as pi's own edit tool does. */
  patch?: (path: string, before: string, after: string) => string
}

/** A patch's hunks, without the file headers its producer wrote. */
function hunks(patch: string): string | undefined {
  const start = patch.search(/^@@ /m)
  return start < 0 ? undefined : patch.slice(start).replace(/\n?$/, '\n')
}

function gitPatch(shown: string, operation: 'add' | 'modify', body: string): string {
  return `diff --git a/${shown} b/${shown}\n${operation === 'add' ? 'new file mode 100644\n' : ''}--- ${operation === 'add' ? '/dev/null' : `a/${shown}`}\n+++ b/${shown}\n${body}`
}

/** An edit or write tool's change as an ACP diff, with a git patch when its hunks are known. */
function editDiff(
  name: string,
  input: unknown,
  details: unknown,
  toolCallId: string,
  translation: Translation,
): RecordValue[] {
  if (name !== 'edit' && name !== 'write') return []
  const raw = object(input)?.path
  if (typeof raw !== 'string' || !raw || /[\r\n]/.test(raw)) return []
  const path = absolutePath(raw, translation.cwd ?? '/')
  // ACP names changed files by absolute path; the patch headers stay relative to the checkout.
  const shown = relativePath(path, translation.root) ?? path.slice(1)
  if (name === 'edit') {
    const change = { operation: 'modify', path }
    const patch = object(details)?.patch
    const body = typeof patch === 'string' ? hunks(patch) : undefined
    return [
      body
        ? { type: 'diff', changes: [change], patch: { format: 'git_patch', text: gitPatch(shown, 'modify', body) } }
        : { type: 'diff', changes: [change] },
    ]
  }
  const prior = translation.priorFiles?.get(toolCallId)
  const operation = prior && !prior.existed ? 'add' : 'modify'
  const change = { operation, path }
  const content = object(input)?.content
  const before = operation === 'add' ? '' : prior?.text
  if (typeof content !== 'string' || before === undefined || !translation.patch)
    return [{ type: 'diff', changes: [change] }]
  const body = hunks(translation.patch(shown, before, content))
  return [
    body
      ? { type: 'diff', changes: [change], patch: { format: 'git_patch', text: gitPatch(shown, operation, body) } }
      : { type: 'diff', changes: [change] },
  ]
}

/**
 * The ACP title and kind of a pi tool call, so a recorded call reads in Delta as Delta's own agents'
 * calls do. Paths inside `root` are shown relative to it.
 */
export function toolInfo(name: string, input: unknown, root?: string, cwd?: string): { title: string; kind: string } {
  const value = object(input) ?? {}
  const field = (key: string) => (typeof value[key] === 'string' && value[key] ? value[key] : undefined)
  const path = (key: string) => {
    const given = field(key)
    if (!given) return
    const full = cwd ? absolutePath(given, cwd) : given
    return relativePath(full, root) ?? given
  }
  const info = (title: string, kind: string) => ({ title: title.replace(/\s+/g, ' ').trim(), kind })
  switch (name) {
    case 'bash':
      return info(field('command') ?? 'Terminal', 'execute')
    case 'read': {
      const offset = typeof value.offset === 'number' && value.offset ? value.offset : undefined
      const limit = typeof value.limit === 'number' && value.limit > 0 ? value.limit : undefined
      const lines = limit ? ` (${offset ?? 1} - ${(offset ?? 1) + limit - 1})` : offset ? ` (from line ${offset})` : ''
      return info(`Read ${path('path') ?? 'File'}${lines}`, 'read')
    }
    case 'write':
    case 'edit': {
      const file = path('path')
      const verb = name === 'write' ? 'Write' : 'Edit'
      return info(file ? `${verb} ${file}` : verb, 'edit')
    }
    case 'find':
      return info(
        ['Find', ...[path('path'), field('pattern')].flatMap((part) => (part ? [`\`${part}\``] : []))].join(' '),
        'search',
      )
    case 'grep': {
      const parts = ['grep']
      if (value.ignoreCase) parts.push('-i')
      if (value.literal) parts.push('-F')
      if (value.context !== undefined) parts.push(`-C ${jsonText(value.context)}`)
      if (value.limit !== undefined) parts.push(`| head -${jsonText(value.limit)}`)
      if (field('glob')) parts.push(`--include="${field('glob')}"`)
      if (field('pattern')) parts.push(`"${field('pattern')}"`)
      if (path('path')) parts.push(path('path')!)
      return info(parts.join(' '), 'search')
    }
    case 'ls':
      return info(`List ${path('path') ?? '.'}`, 'search')
    default:
      return info(name || 'Unknown Tool', 'other')
  }
}

/**
 * Convert one recorded message into ACP updates, retaining opaque provider thinking metadata.
 * `id` names the message, so each part's `messageId` is stable for a record that is sent again.
 */
export function messageUpdates(message: RecordedMessage, id: string, translation: Translation = {}): Update[] {
  const { root, cwd, omitted } = translation
  if (message.role === 'toolResult') {
    if (omitted?.has(message.toolCallId)) return []
    const diff = message.isError
      ? []
      : editDiff(
          message.toolName,
          translation.inputs?.get(message.toolCallId),
          message.details,
          message.toolCallId,
          translation,
        )
    return [
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: message.toolCallId,
        status: message.isError ? 'failed' : 'completed',
        // An edit's diff replaces its raw result, which repeats the change.
        rawOutput: diff.length
          ? null
          : { content: message.content, ...(message.details !== undefined ? { details: message.details } : {}) },
        content: [...blocks(message.content).map((item) => ({ type: 'content', content: item })), ...diff],
      },
    ]
  }
  const updates: Update[] = []
  let content: RecordValue[] = []
  let firstIndex = 0
  const flush = () => {
    if (!content.length) return
    updates.push({
      sessionUpdate: message.role === 'user' ? 'user_message' : 'agent_message',
      messageId: `${id}:message:${firstIndex}`,
      content,
    })
    content = []
  }
  for (const [index, block] of message.content.entries()) {
    if (block.type === 'text' && typeof block.text === 'string' && !block.text.trim()) continue
    if (block.type === 'thinking' && typeof block.thinking === 'string' && !block.thinking.trim() && !block.redacted)
      continue
    if (block.type === 'thinking') {
      flush()
      updates.push({
        sessionUpdate: 'agent_thought',
        messageId: `${id}:thought:${index}`,
        content: blocks(block.redacted ? '[redacted thinking]' : block.thinking),
        _meta: { pi: { block } },
      })
    } else if (block.type === 'toolCall' && typeof block.id === 'string') {
      if (omitted?.has(block.id)) continue
      flush()
      const name = jsonText(block.name ?? 'tool')
      updates.push({
        sessionUpdate: 'tool_call_update',
        toolCallId: block.id,
        name,
        ...toolInfo(name, block.arguments, root, cwd),
        // The result's own message closes the call.
        status: 'in_progress',
        rawInput: block.arguments ?? {},
      })
    } else {
      if (!content.length) firstIndex = index
      content.push(...blocks([block]))
    }
  }
  flush()
  return updates
}

/** The tool calls an assistant message makes, by id, with their arguments. */
export function toolCallsOf(message: RecordedMessage): [string, unknown][] {
  if (message.role !== 'assistant') return []
  return message.content.flatMap((block) =>
    block.type === 'toolCall' && typeof block.id === 'string' ? [[block.id, block.arguments] as [string, unknown]] : [],
  )
}
