/**
 * Drives a real `pi --mode rpc` with this extension and the faux model loaded, against the fake
 * Delta CLI, in a throwaway Git checkout and agent directory. Dialogs the extension opens are
 * answered from a script.
 */
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dirname, '..', '..')
export const FAKE_BIN = join(import.meta.dirname, 'bin')
export const EXTENSION = join(REPO, 'index.ts')
export const FAUX_MODEL = join(import.meta.dirname, 'faux-model.ts')
/**
 * The pi the tests run: the one `package.json` pins, never whichever `pi` is on the PATH. CI swaps in
 * another version by installing it over the pinned one.
 */
const PI_BIN = join(REPO, 'node_modules', '.bin')
export const PI = join(PI_BIN, 'pi')
if (!existsSync(PI)) throw new Error(`${PI} is missing; run npm ci`)

export type Event = Record<string, any>
/** How a dialog is answered: a value, a function of the request, or undefined to dismiss it. */
export type Answer = string | undefined | ((request: Event) => string | undefined)

/** A temporary world: a checkout with a remote, a pi agent directory, and the fake CLI's state. */
export function world(options: { policy?: Record<string, unknown> } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'pi-delta-e2e-'))
  const checkout = join(base, 'repo')
  const agentDir = join(base, 'agent')
  const state = join(base, 'delta')
  mkdirSync(checkout, { recursive: true })
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(state, { recursive: true })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: checkout, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('remote', 'add', 'origin', 'https://example.com/repo.git')
  writeFileSync(join(checkout, 'README.md'), '# Repo\n')
  git('add', '.')
  git('commit', '-qm', 'initial')
  if (options.policy) {
    mkdirSync(join(checkout, '.delta'), { recursive: true })
    writeFileSync(join(checkout, '.delta', 'settings.json'), JSON.stringify({ threads: options.policy }))
  }
  // The faux model is the default, so prompts never reach a real provider.
  writeFileSync(
    join(agentDir, 'settings.json'),
    JSON.stringify({ defaultProvider: 'faux', defaultModel: 'faux-1', quietStartup: true }),
  )
  return {
    base,
    checkout,
    agentDir,
    state,
    /** The fake CLI's state: threads, producers and worktrees. */
    delta(): { threads: Record<string, any>; producers: Record<string, any>; worktrees: any[] } {
      const path = join(state, 'state.json')
      return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { threads: {}, producers: {}, worktrees: [] }
    },
    /** Every CLI call the extension made. */
    calls(): { argv: string[]; env: Record<string, string> }[] {
      const path = join(state, 'calls.jsonl')
      return existsSync(path)
        ? readFileSync(path, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : []
    },
    /** Make `thread watch` report `events` for `thread`, as if a teammate acted. */
    remote(thread: string, ...events: Event[]) {
      const path = join(state, `events-${thread}.jsonl`)
      const previous = existsSync(path) ? readFileSync(path, 'utf8') : ''
      writeFileSync(path, previous + events.map((event) => JSON.stringify(event) + '\n').join(''))
    },
    /**
     * The environment pi runs in: the fake Delta CLI and the pinned pi first on the PATH, so a pi
     * that a test's agent starts is the pinned one too, with this world's agent directory and state.
     */
    env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
      return {
        ...process.env,
        PATH: `${FAKE_BIN}:${PI_BIN}:${process.env.PATH}`,
        PI_CODING_AGENT_DIR: agentDir,
        FAKE_DELTA_STATE: state,
        PI_OFFLINE: '1',
        DELTA_PI_PARENT: '',
        ...extra,
      }
    },
    cleanup() {
      rmSync(base, { recursive: true, force: true })
    },
  }
}
export type World = ReturnType<typeof world>

export async function until<T>(
  read: () => T | undefined | false | Promise<T | undefined | false>,
  what: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** A pi process in RPC mode. */
export class Pi {
  readonly events: Event[] = []
  readonly answers: Answer[] = []
  readonly dialogs: Event[] = []
  private buffer = ''
  private ids = 0
  private waiting = new Map<string, (response: Event) => void>()

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (text: string) => {
      this.buffer += text
      let end: number
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end)
        this.buffer = this.buffer.slice(end + 1)
        if (!line.trim()) continue
        let event: Event
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        this.events.push(event)
        if (event.type === 'response' && typeof event.id === 'string') this.waiting.get(event.id)?.(event)
        if (event.type === 'extension_ui_request' && ['select', 'input', 'confirm', 'editor'].includes(event.method))
          this.answer(event)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text: string) => {
      if (process.env.PI_E2E_DEBUG) process.stderr.write(text)
    })
  }

  static start(world: World, options: { env?: Record<string, string>; args?: string[]; answers?: Answer[] } = {}) {
    const child = spawn(
      PI,
      [
        '--mode',
        'rpc',
        '-e',
        EXTENSION,
        '-e',
        FAUX_MODEL,
        '--provider',
        'faux',
        '--model',
        'faux-1',
        ...(options.args ?? []),
      ],
      {
        cwd: world.checkout,
        env: world.env(options.env),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    const pi = new Pi(child)
    pi.answers.push(...(options.answers ?? []))
    return pi
  }

  private answer(request: Event) {
    this.dialogs.push(request)
    const next = this.answers.length ? this.answers.shift() : undefined
    const value = typeof next === 'function' ? next(request) : next
    if (request.method === 'confirm')
      this.write({ type: 'extension_ui_response', id: request.id, confirmed: value === 'yes' })
    else if (value === undefined) this.write({ type: 'extension_ui_response', id: request.id, cancelled: true })
    else this.write({ type: 'extension_ui_response', id: request.id, value })
  }

  private write(value: unknown) {
    this.child.stdin.write(JSON.stringify(value) + '\n')
  }

  send(command: Event): Promise<Event> {
    const id = `cmd-${++this.ids}`
    return new Promise((resolve) => {
      this.waiting.set(id, resolve)
      this.write({ ...command, id })
    })
  }

  /** Send a prompt and wait until pi settles after it. */
  async prompt(message: string, timeoutMs = 30_000) {
    const settled = this.events.filter((event) => event.type === 'agent_settled').length
    const response = await this.send({ type: 'prompt', message })
    if (!response.success) throw new Error(`prompt refused: ${JSON.stringify(response)}`)
    await until(
      () => this.events.filter((event) => event.type === 'agent_settled').length > settled,
      `pi to settle after "${message}" (notices: ${JSON.stringify(this.notices().slice(-3))})`,
      timeoutMs,
    ).catch((error) => {
      throw new Error(`${error.message}; latest notices: ${JSON.stringify(this.notices().slice(-3))}`)
    })
  }

  /** Run a slash command and wait for its response. */
  async command(text: string) {
    return this.send({ type: 'prompt', message: text })
  }

  /** The texts of the notes and notices Delta showed. */
  notices(): string[] {
    return this.events.flatMap((event) =>
      event.type === 'extension_ui_request' && event.method === 'notify' ? [String(event.message)] : [],
    )
  }

  /** The latest text of a status key. */
  status(key = 'delta'): string | undefined {
    for (let index = this.events.length - 1; index >= 0; index--) {
      const event = this.events[index]!
      if (event.type === 'extension_ui_request' && event.method === 'setStatus' && event.statusKey === key)
        return event.statusText
    }
  }

  async messages(): Promise<Event[]> {
    return (await this.send({ type: 'get_messages' })).data.messages
  }

  async state(): Promise<Event> {
    return (await this.send({ type: 'get_state' })).data
  }

  async stop() {
    if (this.child.exitCode !== null) return
    const exited = new Promise((resolve) => this.child.once('exit', resolve))
    // Closing its input shuts pi down in order; a second signal would make it exit at once.
    this.child.stdin.end()
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 20_000)
    await exited
    clearTimeout(timer)
  }
}
