/**
 * Starting a `pi` process for a Delta thread the way this pi was started, and reading what it reports
 * in pi's JSON mode. This has no counterpart in the Claude Code plugin, whose subagents run inside
 * Claude itself; it is kept to what running a thread needs.
 */
import { isAbsolute, resolve } from 'node:path'
import { isJsonObject } from '../core/json.ts'

/** How this pi was started: the program, its arguments, and where relative paths in them resolve from. */
export type Launch = { command: readonly string[]; args: readonly string[]; cwd: string }

/** Options a subagent keeps from its parent's command line, so it runs with the same restrictions. */
const KEPT_FLAGS = new Set([
  '-ne',
  '--no-extensions',
  '-nt',
  '--no-tools',
  '-nbt',
  '--no-builtin-tools',
  '-ns',
  '--no-skills',
  '-np',
  '--no-prompt-templates',
  '-nc',
  '--no-context-files',
  '-na',
  '--no-approve',
  '--no-mcp',
  '--offline',
])
/** Options with a value a subagent keeps; the paths among them are made absolute, as it runs elsewhere. */
const KEPT_VALUES = new Set(['-t', '--tools', '-xt', '--exclude-tools', '--system-prompt', '--append-system-prompt'])
const KEPT_PATHS = new Set(['-e', '--extension', '--skill', '--prompt-template', '--session-dir'])
/** Values that name a file when one exists there, and are text otherwise. */
const TEXT_OR_PATH = new Set(['--system-prompt', '--append-system-prompt'])

/**
 * The parent's options a subagent is started with: its extensions, tool and resource restrictions,
 * system prompt and session folder. The model, the session and the prompt are the caller's.
 */
export async function keptArguments(launch: Launch, exists: (path: string) => Promise<boolean>): Promise<string[]> {
  const kept: string[] = []
  for (let index = 0; index < launch.args.length; index++) {
    const arg = launch.args[index]!
    if (arg === '--') break
    if (KEPT_FLAGS.has(arg)) kept.push(arg)
    else if (KEPT_VALUES.has(arg) || KEPT_PATHS.has(arg)) {
      const value = launch.args[++index]
      if (value === undefined) break
      const path = resolve(launch.cwd, value)
      const isPath =
        KEPT_PATHS.has(arg) && !value.includes(':') ? true : TEXT_OR_PATH.has(arg) ? await exists(path) : false
      kept.push(arg, isPath && !isAbsolute(value) ? path : value)
    }
  }
  return kept
}

/** Whether the parent's command line leaves `tool` to the model: its tool options don't exclude it. */
export function allowsTool(args: readonly string[], tool: string): boolean {
  const matches = (pattern: string) =>
    new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(tool)
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--') break
    if (arg === '-nt' || arg === '--no-tools') return false
    const value = args[index + 1]
    if ((arg === '-xt' || arg === '--exclude-tools') && value?.split(',').some((entry) => matches(entry.trim())))
      return false
    if ((arg === '-t' || arg === '--tools') && value !== undefined) {
      const entries = value.split(',').map((entry) => entry.trim())
      // A list of only `+name`/`-name` entries changes the default selection; any other is an allowlist.
      if (entries.every((entry) => /^[+-]/.test(entry))) {
        if (entries.includes(`-${tool}`)) return false
      } else if (!entries.some(matches)) return false
    }
  }
  return true
}

/** pi's rule for the IDs `--session-id` accepts (`assertValidSessionId`). */
export function isSessionId(id: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)
}

/** Usage pi reports for an assistant message, summed over a subagent's run. */
export type Usage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
}

/** What a subagent's JSON output said: whether its run started, its last reply, and how it ended. */
export type ChildReport = {
  started: boolean
  reply?: string
  stopReason?: string
  errorMessage?: string
  usage: Usage
  turns: number
  /** The latest thing it did, for the parent's progress line. */
  progress?: string
}

export function emptyReport(): ChildReport {
  return {
    started: false,
    turns: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
}

/** pi's JSON mode output split into records on LF only, as its docs require (U+2028 is not a break). */
export function jsonRecords(): (text: string) => unknown[] {
  let buffer = ''
  return (text) => {
    buffer += text
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    return lines.flatMap((line) => {
      if (!line.trim()) return []
      try {
        return [JSON.parse(line.replace(/\r$/, '')) as unknown]
      } catch {
        return []
      }
    })
  }
}

/** Take one JSON-mode record into `report`; returns the record's type. */
export function readRecord(report: ChildReport, record: unknown): string | undefined {
  if (!isJsonObject(record) || typeof record.type !== 'string') return
  if (record.type === 'agent_start') report.started = true
  else if (record.type === 'tool_execution_start' && typeof record.toolName === 'string')
    report.progress = `running ${record.toolName}`
  else if (record.type === 'message_end' && isJsonObject(record.message) && record.message.role === 'assistant') {
    const message = record.message
    report.turns++
    const text = Array.isArray(message.content)
      ? message.content
          .flatMap((block) =>
            isJsonObject(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : [],
          )
          .join('\n')
          .trim()
      : ''
    if (text) report.reply = report.progress = text
    if (typeof message.stopReason === 'string') report.stopReason = message.stopReason
    if (typeof message.errorMessage === 'string') report.errorMessage = message.errorMessage
    if (isJsonObject(message.usage)) addUsage(report.usage, message.usage)
  }
  return record.type
}

function addUsage(total: Usage, usage: Record<string, unknown>) {
  const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  total.input += number(usage.input)
  total.output += number(usage.output)
  total.cacheRead += number(usage.cacheRead)
  total.cacheWrite += number(usage.cacheWrite)
  total.totalTokens += number(usage.totalTokens)
  const cost = isJsonObject(usage.cost) ? usage.cost : {}
  total.cost.input += number(cost.input)
  total.cost.output += number(cost.output)
  total.cost.cacheRead += number(cost.cacheRead)
  total.cost.cacheWrite += number(cost.cacheWrite)
  total.cost.total += number(cost.total)
}
