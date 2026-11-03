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
import { promisify } from 'node:util'
import { vi } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { Platform } from '../../src/core/host.ts'

/** What the model answers: text, tool calls, and how its reply ended. */
export type Reply = {
  text?: string
  calls?: { name: 'bash' | 'write'; arguments: Record<string, unknown> }[]
  stopReason?: 'stop' | 'length' | 'error'
}
export type Model = (messages: AgentMessage[]) => Reply | Promise<Reply>

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
/** How a dialog is answered: a value, a function of the dialog, or undefined to dismiss it. */
export type Answer = string | undefined | ((dialog: Dialog) => string | undefined)

type Entry = { type: string; id: string; parentId: string | null; timestamp: string; [field: string]: unknown }
type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown
type Command = { handler: (args: string, ctx: unknown) => Promise<void> }

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
  /** pi invalidates a runtime once its session_shutdown has run: its API and contexts then throw. */
  stale = false
  assertActive() {
    if (this.stale) throw new Error(STALE)
  }
}

export class FakePi {
  /** Notes and notices the extension showed, in order. */
  readonly notices: { text: string; tone: string }[] = []
  readonly statuses = new Map<string, string | undefined>()
  readonly dialogs: Dialog[] = []
  readonly answers: Answer[] = []
  /** How a dialog no queued answer is left for is answered, as a person who always answers alike would. */
  respond: Answer = undefined
  /** What the extension's handlers threw, which pi reports and carries on from. */
  readonly errors: unknown[] = []
  /** Text in the editor, where a refused prompt goes back. */
  editor = ''
  model: Model = echoModel
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
  async prompt(text: string): Promise<'handled' | 'steered' | 'settled'> {
    const result = await this.emit('input', {
      text,
      source: 'rpc',
      ...(this.streaming ? { streamingBehavior: 'steer' } : {}),
    })
    if (isObject(result) && result.action === 'handled') return 'handled'
    if (this.streaming) {
      this.steering.push(text)
      return 'steered'
    }
    this.run = this.agentRun(user(text))
    await this.run
    return 'settled'
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
   * shuts the session down, or, unset, a switch.
   */
  nextSwitch: 'cancel' | Error | undefined

  /** Switch to the session saved in `file`, as `/resume` or a command's `switchSession` does. */
  async switchTo(file: string, reason: 'resume' | 'new' | 'fork' = 'resume') {
    const outcome = this.nextSwitch
    this.nextSwitch = undefined
    if (outcome === 'cancel') return { cancelled: true }
    if (outcome) throw outcome
    await this.shutdown(reason, file)
    this.session = this.sessions.get(file) ?? this.sessionFromFile(file)
    await this.start(reason)
    return { cancelled: false }
  }

  /** Start a new empty session in `cwd`, as `/new` does. */
  async newSessionIn(cwd = this.session.cwd) {
    const session = this.newSession(cwd)
    await this.shutdown('new', session.file)
    this.session = session
    await this.start('new')
  }

  /** The texts of the notes and notices shown. */
  noticeTexts(): string[] {
    return this.notices.map((notice) => notice.text)
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
   * Awaited as a run starts, before agent_start, where pi runs other extensions' before_agent_start: a
   * prompt sent meanwhile is queued into the run.
   */
  starting: (() => Promise<void>) | undefined

  private async agentRun(first: AgentMessage) {
    this.streaming = true
    this.aborted = false
    await this.starting?.()
    await this.emit('agent_start', {})
    let next = [first]
    for (let turn = 0; ; turn++) {
      await this.emit('turn_start', { turnIndex: turn })
      for (const message of next) await this.message(message)
      await this.emit('context', { messages: this.messages() })
      const reply: Reply = this.aborted ? { stopReason: 'stop' } : await this.model(this.messages())
      const assistant = this.assistant(reply)
      await this.message(assistant)
      const results: AgentMessage[] = []
      for (const call of reply.calls && !this.aborted ? toolCalls(assistant) : []) {
        const outcome = await this.emit('tool_call', {
          toolCallId: call.id,
          toolName: call.name,
          input: call.arguments,
        })
        await this.emit('tool_execution_start', { toolCallId: call.id, toolName: call.name, args: call.arguments })
        const result =
          isObject(outcome) && outcome.block === true
            ? toolResult(call, 'Blocked by an extension', true)
            : await this.execute(call)
        await this.emit('tool_execution_end', { toolCallId: call.id, toolName: call.name, result, isError: false })
        await this.message(result)
        results.push(result)
      }
      await this.emit('turn_end', { turnIndex: turn, message: assistant, toolResults: results })
      // pi adds context messages sent during the turn once the turn has ended.
      for (const entry of this.pendingCustom.splice(0)) this.append(entry)
      next = this.steering.splice(0).map(user)
      if (this.aborted || (!results.length && !next.length)) break
    }
    await this.emit('agent_end', { messages: [] })
    this.streaming = false
    for (const message of this.pendingShell.splice(0)) this.append({ type: 'message', message })
    await this.emit('agent_settled', { aborted: this.aborted })
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
  }

  private assistant(reply: Reply): AgentMessage {
    const content = [
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
    let result: unknown
    for (const handler of this.runtime?.handlers.get(type) ?? []) {
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
      setWidget: () => {},
      getEditorText: () => this.editor,
      setEditorText: (text: string) => (this.editor = text),
    }
    const abort = () => (this.aborted = true)
    return {
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
          await this.shutdown('reload')
          await this.start('startup')
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
      registerMessageRenderer: () => runtime.assertActive(),
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
        if (this.streaming) this.pendingCustom.push(entry)
        else this.append(entry)
      },
      getSessionName: () => {
        runtime.assertActive()
        return this.session.name
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
