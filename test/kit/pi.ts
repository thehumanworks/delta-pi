/**
 * A stand-in for pi that runs the extension in this process: it loads a fresh copy of the extension for
 * each session, as pi does, and raises pi's events in pi's order for prompts, tool calls, shell commands,
 * commands and session switches. A scripted model answers.
 *
 * Only what the extension uses is modelled. The order of events follows pi's agent session
 * (node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js); the end-to-end tests run the
 * real pi to keep this honest.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify, stripVTControlCharacters } from 'node:util'
import { vi } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { type ExtensionAPI, initTheme, type Theme } from '@earendil-works/pi-coding-agent'
import type { Component } from '@earendil-works/pi-tui'
import type { Platform } from '../../src/core/host.ts'

/** What the model answers: its thinking, text, tool calls, and how its reply ended. */
export type Reply = {
  thinking?: string
  text?: string
  /** Calls of pi's `bash` and `write`, or of a tool an extension registered. */
  calls?: { name: string; arguments: Record<string, unknown> }[]
  stopReason?: 'stop' | 'length' | 'error'
}
/** The model answers the conversation so far; `signal` is aborted when the run is. */
export type Model = (messages: AgentMessage[], signal?: AbortSignal) => Reply | Promise<Reply>

/** The end-to-end tests' faux model: `run <command>` runs it, `write <path> <text>` writes, anything else is echoed. */
export const echoModel: Model = (messages) => {
  const last = messages.at(-1) as { role: string; content: unknown } | undefined
  if (last?.role === 'toolResult') return { text: 'Done.' }
  const text = textOf(last?.content).trim()
  const run = /^run (.+)$/s.exec(text)
  if (run) return { text: 'Running.', calls: [{ name: 'bash', arguments: { command: run[1] } }] }
  const write = /^write (\S+) (.+)$/s.exec(text)
  if (write) return { calls: [{ name: 'write', arguments: { path: write[1], content: `${write[2]}\n` } }] }
  return { text: `Echo: ${text}` }
}

/**
 * How pi runs: its terminal (`tui`) or an RPC client, both of which show dialogs, or print mode, as
 * text (`print`) or JSON events (`json`), where nobody can answer one.
 */
export type Mode = 'tui' | 'rpc' | 'print' | 'json'

/** A dialog the extension opened. */
export type Dialog = { method: 'select' | 'input'; title: string; options?: string[] }
/**
 * How a dialog is answered: a value, a function of the dialog, or undefined to dismiss it. A function
 * may answer later, with a promise, to hold the dialog open while the test goes on.
 */
export type Answer = string | undefined | ((dialog: Dialog) => string | undefined | Promise<string | undefined>)

type Entry = { type: string; id: string; parentId: string | null; timestamp: string; [field: string]: unknown }
type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown
type Command = { handler: (args: string, ctx: unknown) => Promise<void> }
type ToolResult = {
  content: { type: string; text?: string }[]
  isError?: boolean
  details?: unknown
  terminate?: boolean
}
/** A tool an extension registered, as pi calls it. */
type Tool = {
  name: string
  defaultActive?: boolean
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (partial: ToolResult) => void,
    ctx: unknown,
  ): Promise<ToolResult>
}
/** What pi's TUI gives a widget's factory and a renderer: a redraw, and the invalidation that rebuilds rows. */
type FakeTui = { requestRender(): void; invalidate(): void }
type WidgetFactory = (tui: FakeTui, theme: Theme) => Component
type MessageRenderer = (
  message: { customType: string; content: unknown; display: boolean; details: unknown },
  options: { expanded: boolean; outputPad: number },
  theme: Theme,
) => Component | undefined

/** The 256-color code `FAKE_THEME` draws each of pi's theme colors in: distinct, so a test can tell them apart. */
const THEME_COLORS: Record<string, number> = { error: 1, success: 2, warning: 3, accent: 4, muted: 8, dim: 7 }
/** The escape that starts text `FAKE_THEME` draws in pi's theme color `color`. */
export function themeColor(color: string): string {
  return `\x1b[38;5;${THEME_COLORS[color] ?? 15}m`
}
/**
 * A theme drawing pi's colors and attributes as real escapes, so the extension's layout measures and
 * truncates its text as it does in pi's terminal, and a test can still tell the colors apart.
 */
export const FAKE_THEME = {
  fg: (color: string, text: string) => `${themeColor(color)}${text}\x1b[39m`,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
  underline: (text: string) => `\x1b[4m${text}\x1b[24m`,
  inverse: (text: string) => `\x1b[7m${text}\x1b[27m`,
  strikethrough: (text: string) => `\x1b[9m${text}\x1b[29m`,
} as unknown as Theme

/** A pi session: its ID, file, working directory and the entries pi committed. */
export class FakeSession {
  readonly entries: Entry[] = []
  name: string | undefined
  constructor(
    readonly id: string,
    readonly cwd: string,
    readonly file: string,
  ) {}
}

/** What pi says when an extension uses a runtime it replaced (pi's ExtensionRunner.invalidate). */
const STALE = 'This extension ctx is stale after session replacement or reload.'

/** One loaded copy of the extension, as pi loads one per session. */
class Runtime {
  readonly handlers = new Map<string, Handler[]>()
  readonly commands = new Map<string, Command>()
  readonly tools = new Map<string, Tool>()
  /** pi invalidates a runtime once its session_shutdown has run: its API and contexts then throw. */
  stale = false
  assertActive() {
    if (this.stale) throw new Error(STALE)
  }
}

export class FakePi {
  /** Notes and notices the extension showed, in order. */
  readonly notices: { text: string; tone: string }[] = []
  /**
   * How many times the extension asked pi's terminal to redraw, and to invalidate, which rebuilds every
   * drawn row through its renderer. Only pi's terminal (`tui` mode) gives the extension its TUI.
   */
  renders = 0
  invalidations = 0
  private readonly tui: FakeTui = {
    requestRender: () => this.renders++,
    invalidate: () => {
      this.invalidations++
      this.built.clear()
    },
  }
  /** The components pi built from the widgets the extension set in its terminal, by key. */
  private readonly widgets = new Map<string, Component>()
  /** The renderers the extension registered for its custom messages, and the rows pi built with them, by entry. */
  private readonly messageRenderers = new Map<string, MessageRenderer>()
  private readonly built = new Map<string, Component | undefined>()
  readonly statuses = new Map<string, string | undefined>()
  readonly dialogs: Dialog[] = []
  readonly answers: Answer[] = []
  /** How a dialog no queued answer is left for is answered, as a person who always answers alike would. */
  respond: Answer = undefined
  /** What the extension's handlers threw, which pi reports and carries on from. */
  readonly errors: unknown[] = []
  /** Text in the editor, where a refused prompt goes back. */
  editor = ''
  /** How many times the extension stopped a running turn. */
  aborts = 0
  /**
   * How many of the next custom messages pi fails to add, as when its session cannot take them: pi
   * reports such a failure on its own error channel, never to the extension.
   */
  failMessages = 0
  /**
   * How pi runs a reply's tool calls: `parallel`, pi's default, prepares every call (its
   * `tool_execution_start` and `tool_call`) before running any, and adds their results once all have
   * run; `sequential` prepares, runs and adds each call in turn.
   */
  toolExecution: 'parallel' | 'sequential' = 'parallel'
  /** Other extensions' handlers, which pi runs after this extension's, by event. */
  readonly others = new Map<string, Handler[]>()
  model: Model = echoModel
  /** The tools declared to the model, as `getActiveTools` reports them. */
  activeTools: string[] = ['read', 'bash', 'edit', 'write']
  /** What the extension's tools returned and reported while they ran, by tool name. */
  readonly toolResults: { name: string; result: ToolResult; updates: ToolResult[] }[] = []
  /** Prompts the extension sent with `sendUserMessage`. */
  readonly sentPrompts: string[] = []
  /** Observers of pi's events, as pi's JSON mode prints them; `message_end` follows each commit. */
  readonly observers: ((type: string, event: Record<string, unknown>) => void)[] = []
  private controller = new AbortController()
  /** Tool results that asked pi to end the run after their batch. */
  private readonly terminating = new WeakSet<AgentMessage>()
  private followUps: string[] = []
  session: FakeSession
  private runtime: Runtime | undefined
  private streaming = false
  private aborted = false
  private steering: string[] = []
  /** Context messages the extension sent while a turn ran, which pi adds when the turn ends. */
  private pendingCustom: Omit<Entry, 'id' | 'parentId' | 'timestamp'>[] = []
  private pendingShell: AgentMessage[] = []
  private run: Promise<void> | undefined
  private readonly sessions = new Map<string, FakeSession>()

  /** A pi in `cwd`, in a new session or, as a new pi process resuming it, in `session`. */
  constructor(
    readonly platform: Platform,
    cwd: string,
    readonly mode: Mode = 'rpc',
    session?: FakeSession,
  ) {
    this.session = session ?? this.newSession(cwd)
    this.sessions.set(this.session.file, this.session)
  }

  /** Whether pi is between runs. */
  get idle(): boolean {
    return !this.streaming
  }

  /** Load the extension for the current session and start it, as pi does at startup. */
  async start(reason: 'startup' | 'reload' | 'resume' | 'new' | 'fork' = 'startup') {
    // pi evaluates the extension's modules afresh for every session runtime.
    vi.resetModules()
    const { createDelta } = await import('../../index.ts')
    const runtime = new Runtime()
    this.runtime = runtime
    createDelta(this.api(runtime), this.platform)
    await this.emit('session_start', { reason })
  }

  /** Submit a prompt as the person would, and wait for the run it starts, if any, to settle. */
  async prompt(text: string, source: 'rpc' | 'extension' = 'rpc'): Promise<'handled' | 'steered' | 'settled'> {
    const result = await this.emit('input', {
      text,
      source,
      ...(this.streaming ? { streamingBehavior: 'steer' } : {}),
    })
    if (isObject(result) && result.action === 'handled') return 'handled'
    if (this.streaming) {
      this.steering.push(text)
      return 'steered'
    }
    await this.entering?.()
    this.run = this.agentRun(user(text))
    await this.run
    return 'settled'
  }

  /** Stop the running agent turn, as pi's `abort` does. */
  abort() {
    this.aborted = true
    this.controller.abort()
  }

  /** Start a prompt without waiting for its run; `settled` waits for it. */
  submit(text: string): Promise<'handled' | 'steered' | 'settled'> {
    return this.prompt(text)
  }

  /** Wait for the run in progress, if any, to settle. */
  async settled() {
    await this.run
  }

  /** Run a shell command as the person would with `!`; pi commits it, without a message_end, once idle. */
  async shell(command: string) {
    await this.emit('user_bash', { command, excludeFromContext: false, cwd: this.session.cwd })
    const { stdout, code } = await sh(command, this.session.cwd, this.environment())
    const message = {
      role: 'bashExecution',
      command,
      output: stdout,
      exitCode: code,
      cancelled: false,
      truncated: false,
      timestamp: Date.now(),
    } as unknown as AgentMessage
    if (this.streaming) this.pendingShell.push(message)
    else this.append({ type: 'message', message })
  }

  /** Run `/name args` as the person would, and wait for it. */
  async command(name: string, args = '') {
    const command = this.runtime?.commands.get(name)
    if (!command) throw new Error(`no command /${name}`)
    try {
      await command.handler(args, this.commandContext())
    } catch (error) {
      this.errors.push(error)
    }
  }

  /** End the session as pi does when it quits or replaces the session, then invalidate its runtime. */
  async shutdown(reason: 'quit' | 'reload' | 'new' | 'resume' | 'fork' = 'quit', target?: string) {
    await this.emit('session_shutdown', { reason, ...(target ? { targetSessionFile: target } : {}) })
    if (this.runtime) this.runtime.stale = true
    this.runtime = undefined
  }

  /**
   * How the next switch a command asks for goes: pi's own refusal before it starts, a failure before it
   * shuts the session down, a switch that opens the session in another directory (`{ cwd }`, as pi's
   * terminal does when the session's own directory is missing and the person continues where pi is), or,
   * unset, a switch.
   */
  nextSwitch: 'cancel' | Error | { cwd: string } | undefined

  /**
   * How the next reload a command asks for goes: held until a promise settles, refused as pi's terminal
   * refuses one while it compacts (a warning, and no reload), a failure, or, unset, a reload.
   */
  nextReload: Promise<void> | 'refuse' | Error | undefined
  /** How many reloads commands asked for and pi carried out. */
  reloads = 0

  /** Switch to the session saved in `file`, as `/resume` or a command's `switchSession` does. */
  async switchTo(file: string, reason: 'resume' | 'new' | 'fork' = 'resume') {
    const outcome = this.nextSwitch
    this.nextSwitch = undefined
    if (outcome === 'cancel') return { cancelled: true }
    if (outcome instanceof Error) throw outcome
    await this.shutdown(reason, file)
    const session = this.sessions.get(file) ?? this.sessionFromFile(file)
    this.session = outcome ? new FakeSession(session.id, outcome.cwd, file) : session
    await this.start(reason)
    return { cancelled: false }
  }

  /** Name the session, as `/name` does, and tell the extension. */
  async rename(name: string) {
    this.session.name = name
    await this.emit('session_info_changed', { name })
  }

  /** Start a new empty session in `cwd`, as `/new` does. */
  async newSessionIn(cwd = this.session.cwd) {
    const session = this.newSession(cwd)
    await this.shutdown('new', session.file)
    this.session = session
    await this.start('new')
  }

  /**
   * The texts of the notes and notices shown. In pi's terminal, a note is an entry the extension left in
   * the transcript, which it draws itself; those are read here too.
   */
  noticeTexts(): string[] {
    const notes =
      this.mode === 'tui'
        ? this.session.entries.flatMap((entry) =>
            entry.type === 'custom' && isObject(entry.data) && typeof entry.data.text === 'string'
              ? [entry.data.text]
              : [],
          )
        : []
    return [...this.notices.map((notice) => notice.text), ...notes]
  }

  /**
   * What the widget `key` draws `width` columns wide in pi's terminal, its escapes removed unless `raw`.
   * Like pi, the widget's component is built when the extension sets it, and rendered on every draw.
   */
  widget(key: string, width = 120, raw = false): string[] {
    const lines = this.widgets.get(key)?.render(width) ?? []
    return raw ? lines : lines.map((line) => stripVTControlCharacters(line))
  }

  /**
   * The custom messages pi shows the person, each as its renderer draws it `width` columns wide, escapes
   * removed unless `raw`; undefined where the renderer drew nothing of its own, so pi draws the content.
   * Like pi, a row is built once and drawn again on every render, until the extension invalidates the TUI.
   */
  drawnRows(width = 100, raw = false): { content: unknown; details: unknown; lines: string[] | undefined }[] {
    // pi's terminal loads its theme, which markdown draws in, before it draws anything.
    initTheme('dark')
    return this.session.entries.flatMap((entry) => {
      if (entry.type !== 'custom_message' || !entry.display) return []
      const renderer = this.messageRenderers.get(String(entry.customType))
      if (!this.built.has(entry.id)) {
        const message = {
          customType: String(entry.customType),
          content: entry.content,
          display: true,
          details: entry.details,
        }
        this.built.set(entry.id, renderer?.(message, { expanded: false, outputPad: 1 }, FAKE_THEME))
      }
      const lines = this.built.get(entry.id)?.render(width)
      return [
        {
          content: entry.content,
          details: entry.details,
          lines: raw ? lines : lines?.map((line) => stripVTControlCharacters(line)),
        },
      ]
    })
  }

  /** The messages pi committed to the session, in order. */
  messages(): AgentMessage[] {
    return this.session.entries.flatMap((entry) => (entry.type === 'message' ? [entry.message as AgentMessage] : []))
  }

  /** The context messages the extension added, as pi committed them. */
  contextMessages(): { content: unknown; display: boolean; details: unknown }[] {
    return this.session.entries.flatMap((entry) =>
      entry.type === 'custom_message'
        ? [{ content: entry.content, display: entry.display as boolean, details: entry.details }]
        : [],
    )
  }

  private environment(): Record<string, string> {
    return Object.fromEntries(
      Object.entries(process.env)
        .map(([name]) => [name, this.platform.env.get(name)] as const)
        .filter((entry): entry is [string, string] => entry[1] !== undefined),
    )
  }

  private newSession(cwd: string): FakeSession {
    const id = randomUUID()
    const session = new FakeSession(id, cwd, `${this.platform.dataDir}/../sessions/${id}.jsonl`)
    this.sessions.set(session.file, session)
    return session
  }

  /** A session another runtime prepared with its header only, as a join does. */
  private sessionFromFile(file: string): FakeSession {
    const header = JSON.parse(readFileSync(file, 'utf8').split('\n')[0] ?? '{}') as { id: string; cwd: string }
    const session = new FakeSession(header.id, header.cwd, file)
    this.sessions.set(file, session)
    return session
  }

  private append(entry: Omit<Entry, 'id' | 'parentId' | 'timestamp'>) {
    const entries = this.session.entries
    entries.push({
      ...entry,
      id: randomUUID().slice(0, 8),
      parentId: entries.at(-1)?.id ?? null,
      timestamp: new Date().toISOString(),
    } as Entry)
  }

  /**
   * Awaited once the input handlers admitted a prompt and before pi starts its run, where pi checks the
   * model's credentials: pi is still idle, and its run not yet under way.
   */
  entering: (() => Promise<void>) | undefined

  /**
   * Awaited as a run starts, before agent_start, where pi runs other extensions' before_agent_start: a
   * prompt sent meanwhile is queued into the run.
   */
  starting: (() => Promise<void>) | undefined

  private async agentRun(first: AgentMessage) {
    this.streaming = true
    this.aborted = false
    this.controller = new AbortController()
    await this.starting?.()
    // pi prepares the run, then adds what before_agent_start handlers return after its prompt.
    const prepared = await this.emit('before_agent_start', {
      messageType: 'user',
      prompt: textOf((first as { content?: unknown }).content),
      systemPrompt: '',
    })
    const added = isObject(prepared) && isObject(prepared.message) ? prepared.message : undefined
    await this.emit('agent_start', {})
    let next = [first]
    for (let turn = 0; ; turn++) {
      await this.emit('turn_start', { turnIndex: turn })
      for (const message of next) await this.message(message)
      if (turn === 0 && added)
        this.append({
          type: 'custom_message',
          customType: added.customType,
          content: added.content,
          display: added.display,
          details: added.details,
        })
      await this.emit('context', { messages: this.messages() })
      const reply: Reply = this.aborted
        ? { stopReason: 'stop' }
        : await this.model(this.messages(), this.controller.signal)
      const assistant = this.assistant(reply)
      await this.message(assistant)
      const results = reply.calls && !this.aborted ? await this.runTools(toolCalls(assistant)) : []
      await this.emit('turn_end', { turnIndex: turn, message: assistant, toolResults: results })
      // pi adds context messages sent during the turn once the turn has ended.
      for (const entry of this.pendingCustom.splice(0)) this.append(entry)
      next = this.steering.splice(0).map(user)
      if (this.aborted || (!results.length && !next.length)) break
      // pi skips its follow-up request when every tool of the batch asked to stop the run.
      if (results.length && results.every((result) => this.terminating.has(result))) break
    }
    await this.emit('agent_end', { messages: [] })
    this.streaming = false
    for (const message of this.pendingShell.splice(0)) this.append({ type: 'message', message })
    await this.emit('agent_settled', { aborted: this.aborted })
    // A follow-up the extension queued while the run went on starts the next run.
    const followUp = this.followUps.shift()
    if (followUp !== undefined) this.run = this.prompt(followUp, 'extension').then(() => {})
  }

  /** Run a reply's tool calls as pi's agent loop does (`toolExecution`), and add their results. */
  private async runTools(calls: ToolCallBlock[]): Promise<AgentMessage[]> {
    const prepare = async (call: ToolCallBlock) => {
      await this.emit('tool_execution_start', { toolCallId: call.id, toolName: call.name, args: call.arguments })
      const outcome = await this.emit('tool_call', { toolCallId: call.id, toolName: call.name, input: call.arguments })
      return isObject(outcome) && outcome.block === true
    }
    const finish = async (call: ToolCallBlock, blocked: boolean) => {
      const result = blocked ? toolResult(call, 'Blocked by an extension', true) : await this.execute(call)
      await this.emit('tool_execution_end', { toolCallId: call.id, toolName: call.name, result, isError: false })
      return result
    }
    const results: AgentMessage[] = []
    if (this.toolExecution === 'sequential') {
      for (const call of calls) {
        const result = await finish(call, await prepare(call))
        await this.message(result)
        results.push(result)
      }
      return results
    }
    const blocked: boolean[] = []
    for (const call of calls) blocked.push(await prepare(call))
    // pi starts every prepared call at once; its file mutation queue runs writes to one file in order.
    results.push(...(await Promise.all(calls.map((call, index) => finish(call, blocked[index]!)))))
    for (const result of results) await this.message(result)
    return results
  }

  /** A message's start and end; pi commits what the end handlers leave. */
  private async message(message: AgentMessage) {
    await this.emit('message_start', { message })
    let current = message
    for (const handler of this.runtime?.handlers.get('message_end') ?? []) {
      try {
        const result = await handler({ type: 'message_end', message: current }, this.context())
        if (isObject(result) && isObject(result.message)) current = result.message as unknown as AgentMessage
      } catch (error) {
        this.errors.push(error)
      }
    }
    this.append({ type: 'message', message: current })
    for (const observe of this.observers) observe('message_end', { message: current })
  }

  private assistant(reply: Reply): AgentMessage {
    const content = [
      ...(reply.thinking ? [{ type: 'thinking', thinking: reply.thinking, thinkingSignature: 'signature' }] : []),
      ...(reply.text ? [{ type: 'text', text: reply.text }] : []),
      ...(reply.calls ?? []).map((call) => ({
        type: 'toolCall',
        id: `call_${randomUUID().slice(0, 8)}`,
        name: call.name,
        arguments: call.arguments,
      })),
    ]
    return {
      role: 'assistant',
      content,
      api: 'faux',
      provider: 'faux',
      model: 'faux-1',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
      stopReason: this.aborted ? 'aborted' : (reply.stopReason ?? (reply.calls?.length ? 'toolUse' : 'stop')),
      timestamp: Date.now(),
    } as unknown as AgentMessage
  }

  private async execute(call: ToolCallBlock): Promise<AgentMessage> {
    const tool = this.runtime?.tools.get(call.name)
    if (tool) {
      const updates: ToolResult[] = []
      let result: ToolResult
      try {
        result = await tool.execute(
          call.id,
          call.arguments,
          this.controller.signal,
          (partial) => updates.push(partial),
          this.context(),
        )
      } catch (error) {
        result = {
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        }
      }
      this.toolResults.push({ name: call.name, result, updates })
      const text = result.content
        .flatMap((block) => (block.type === 'text' && block.text ? [block.text] : []))
        .join('\n')
      const message = toolResult(call, text, !!result.isError)
      if (result.terminate) this.terminating.add(message)
      return message
    }
    if (call.name === 'bash') {
      const { stdout, code } = await sh(String(call.arguments.command), this.session.cwd, this.environment())
      return toolResult(call, stdout, code !== 0)
    }
    const path = resolve(this.session.cwd, String(call.arguments.path).replace(/^@/, ''))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, String(call.arguments.content))
    return toolResult(call, `Wrote ${path}`, false)
  }

  private async emit(type: string, event: Record<string, unknown>): Promise<unknown> {
    for (const observe of this.observers) observe(type, event)
    let result: unknown
    for (const handler of [...(this.runtime?.handlers.get(type) ?? []), ...(this.others.get(type) ?? [])]) {
      try {
        const answer = await handler({ type, ...event }, this.context())
        if (answer !== undefined) result = answer
      } catch (error) {
        this.errors.push(error)
      }
    }
    return result
  }

  /** The context pi hands `runtime`'s handlers; like pi's, it throws once that runtime is replaced. */
  private context(runtime = this.runtime) {
    const session = this.session
    const active = () => {
      if (!runtime || runtime.stale) throw new Error(STALE)
    }
    const mode = () => this.mode
    const streaming = () => this.streaming
    const ui = {
      select: async (title: string, options: string[]) => this.ask({ method: 'select', title, options }),
      input: async (title: string) => this.ask({ method: 'input', title }),
      notify: (text: string, tone = 'info') => this.notices.push({ text, tone }),
      setStatus: (key: string, text: string | undefined) => this.statuses.set(key, text),
      setWidget: (key: string, content: unknown) => {
        if (typeof content === 'function') this.widgets.set(key, (content as WidgetFactory)(this.tui, FAKE_THEME))
        else this.widgets.delete(key)
      },
      getEditorText: () => this.editor,
      setEditorText: (text: string) => (this.editor = text),
    }
    const abort = () => {
      this.aborts++
      this.abort()
    }
    const controller = () => this.controller
    return {
      model: { provider: 'faux', id: 'faux-1' },
      thinkingLevel: 'off',
      get signal() {
        return streaming() ? controller().signal : undefined
      },
      get cwd() {
        active()
        return session.cwd
      },
      get hasUI() {
        active()
        return mode() === 'rpc' || mode() === 'tui'
      },
      get mode() {
        active()
        return mode()
      },
      get ui() {
        active()
        return ui
      },
      get sessionManager() {
        active()
        return {
          getSessionId: () => session.id,
          getSessionFile: () => session.file,
          getEntries: () => [...session.entries],
          getLeafEntry: () => session.entries.at(-1),
          getBranch: () => [...session.entries],
          getHeader: () => ({ type: 'session', id: session.id, cwd: session.cwd, timestamp: '' }),
          getCwd: () => session.cwd,
          getSessionName: () => session.name,
        }
      },
      isIdle: () => {
        active()
        return !streaming()
      },
      abort: () => {
        active()
        abort()
      },
    }
  }

  private commandContext() {
    const runtime = this.runtime
    const context = this.context(runtime)
    return Object.defineProperties(context, {
      switchSession: {
        value: (file: string) => {
          runtime?.assertActive()
          return this.switchTo(file)
        },
      },
      reload: {
        value: async () => {
          runtime?.assertActive()
          const outcome = this.nextReload
          this.nextReload = undefined
          if (outcome instanceof Promise) await outcome
          else if (outcome === 'refuse') return
          else if (outcome) throw outcome
          await this.shutdown('reload')
          await this.start('startup')
          this.reloads++
        },
      },
    })
  }

  private async ask(dialog: Dialog): Promise<string | undefined> {
    this.dialogs.push(dialog)
    const answer = this.answers.length ? this.answers.shift() : this.respond
    return typeof answer === 'function' ? answer(dialog) : answer
  }

  /** The API pi hands the extension; like pi's, it throws once the runtime is replaced. */
  private api(runtime: Runtime): ExtensionAPI {
    const api = {
      on: (event: string, handler: Handler) => {
        runtime.assertActive()
        runtime.handlers.set(event, [...(runtime.handlers.get(event) ?? []), handler])
      },
      registerCommand: (name: string, command: Command) => {
        runtime.assertActive()
        runtime.commands.set(name, command)
      },
      registerMessageRenderer: (customType: string, renderer: MessageRenderer) => {
        runtime.assertActive()
        this.messageRenderers.set(customType, renderer)
        this.built.clear()
      },
      registerEntryRenderer: () => runtime.assertActive(),
      appendEntry: (customType: string, data: unknown) => {
        runtime.assertActive()
        this.append({ type: 'custom', customType, data })
      },
      sendMessage: (message: { customType: string; content: unknown; display: boolean; details?: unknown }) => {
        runtime.assertActive()
        const entry = {
          type: 'custom_message',
          customType: message.customType,
          content: message.content,
          display: message.display,
          details: message.details,
        }
        if (this.failMessages > 0) this.failMessages--
        else if (this.streaming) this.pendingCustom.push(entry)
        else this.append(entry)
      },
      getSessionName: () => {
        runtime.assertActive()
        return this.session.name
      },
      registerTool: (tool: Tool) => {
        runtime.assertActive()
        runtime.tools.set(tool.name, tool)
        if (tool.defaultActive !== false && !this.activeTools.includes(tool.name)) this.activeTools.push(tool.name)
      },
      getActiveTools: () => {
        runtime.assertActive()
        return [...this.activeTools]
      },
      setActiveTools: (names: string[]) => {
        runtime.assertActive()
        this.activeTools = [...names]
      },
      sendUserMessage: (text: string, options?: { deliverAs?: 'steer' | 'followUp' }) => {
        runtime.assertActive()
        this.sentPrompts.push(text)
        if (!this.streaming) this.run = this.prompt(text, 'extension').then(() => {})
        else if (options?.deliverAs === 'followUp') this.followUps.push(text)
        else this.steering.push(text)
      },
    }
    return api as unknown as ExtensionAPI
  }
}

type ToolCallBlock = { id: string; name: string; arguments: Record<string, unknown> }

function toolCalls(message: AgentMessage): ToolCallBlock[] {
  const content = (message as { content: { type: string }[] }).content
  return content.filter((block) => block.type === 'toolCall') as unknown as ToolCallBlock[]
}

function user(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }
}

function toolResult(call: ToolCallBlock, text: string, isError: boolean): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text }],
    isError,
    timestamp: Date.now(),
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((block: unknown) =>
      isObject(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : [],
    )
    .join('\n')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function sh(command: string, cwd: string, env: Record<string, string>) {
  try {
    const { stdout } = await promisify(execFile)('sh', ['-c', command], { cwd, env })
    return { stdout, code: 0 }
  } catch (error) {
    const failure = error as { stdout?: string; code?: number }
    return { stdout: failure.stdout ?? '', code: typeof failure.code === 'number' ? failure.code : 1 }
  }
}
