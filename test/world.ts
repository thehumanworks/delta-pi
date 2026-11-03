/**
 * A throwaway world for a test: a Git checkout with a remote, a pi agent directory, and the fake Delta
 * CLI's state (test/fake-delta), shared by the end-to-end tests and the in-process kit.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dirname, '..')
/** The fake `delta` program, and the browser openers that record a link instead of opening it. */
export const FAKE_BIN = join(import.meta.dirname, 'e2e', 'bin')
/** The pi the tests run: the one `package.json` pins. CI swaps in another by installing it over this one. */
export const PI_BIN = join(REPO, 'node_modules', '.bin')

export type Event = Record<string, any>

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
    /** The fake CLI's state: threads, producers and worktrees, loosely typed for inspection. */
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
    /** Run the fake CLI as another producer would, such as a teammate, and read its JSON answer. */
    cli(...args: string[]): any {
      return JSON.parse(
        execFileSync(join(FAKE_BIN, 'delta'), ['--json', ...args], {
          env: { ...process.env, FAKE_DELTA_STATE: state },
        }).toString(),
      )
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
    /**
     * Make `times` runs of `command`, such as `worktree list`, fail with Delta's error `code`, transient
     * unless `retryable` is false, after letting `after` runs through.
     */
    fail(command: string, { times = 1, after = 0, code = 'process_failed', retryable = true } = {}) {
      writeFileSync(
        join(state, `fail-${command.replaceAll(' ', '-')}`),
        JSON.stringify({ after, times, code, retryable }),
      )
    },
    /** Let `command` run normally again after `fail`. */
    stopFailing(command: string) {
      rmSync(join(state, `fail-${command.replaceAll(' ', '-')}`), { force: true })
    },
    /** Make `thread watch` report `text` for `thread` as it is, such as a malformed or partial line. */
    remoteRaw(thread: string, text: string) {
      const path = join(state, `events-${thread}.jsonl`)
      writeFileSync(path, (existsSync(path) ? readFileSync(path, 'utf8') : '') + text)
    },
    /** End the running `thread watch` of `thread` with `code` once it has reported what came before. */
    endWatch(thread: string, code = 1) {
      const path = join(state, `events-${thread}.jsonl`)
      writeFileSync(path, (existsSync(path) ? readFileSync(path, 'utf8') : '') + `{"fake_watch_exit":${code}}\n`)
    },
    /**
     * Make `times` runs of `command`, after letting `after` through, answer `stdout` and `stderr` with
     * `exitCode` (1 unless given) instead of their own answer: a crash, an old CLI's usage text, a
     * malformed reply. With `run`, the command does its work first and only its answer is lost.
     */
    answer(
      command: string,
      answer: { stdout?: string; stderr?: string; exitCode?: number; run?: boolean },
      { times = 1, after = 0 } = {},
    ) {
      writeFileSync(join(state, `answer-${command.replaceAll(' ', '-')}`), JSON.stringify({ ...answer, times, after }))
    },
    /** Make `thread contract` answer the range of recording contracts another CLI version speaks. */
    contract(min: number, max: number) {
      writeFileSync(join(state, 'contract.json'), JSON.stringify({ min, max }))
    },
    /**
     * Hold the runs of `command` after the first `after` until the returned function releases them. An
     * `answer` set before the release answers a held run instead, as a sign-in that ends another way does.
     */
    hold(command: string, { after = 0 } = {}): () => void {
      const path = join(state, `hold-${command.replaceAll(' ', '-')}`)
      writeFileSync(path, JSON.stringify({ after }))
      return () => rmSync(path, { force: true })
    },
    /** Make `org list` report these organizations; `org create` adds to them. */
    organizations(organizations: { id: string; name: string; current: boolean; personal?: boolean }[]) {
      writeFileSync(join(state, 'organizations.json'), JSON.stringify(organizations))
    },
    /** Make `thread invite` refuse these addresses, each with Delta's message for why. */
    inviteFailures(failures: Record<string, string>) {
      writeFileSync(join(state, 'invite-failures.json'), JSON.stringify(failures))
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

/**
 * What a first turn answering in text, then a turn running one command, record. The end-to-end test asserts
 * it of the real pi and the behaviour test of the kit's fake pi, so the fake cannot drift from pi unseen.
 */
export const RECORDED_TURNS = [
  'state_update',
  'user_message',
  'agent_message',
  'state_update',
  'session_info_update',
  'state_update',
  'user_message',
  'agent_message',
  'tool_call_update',
  'tool_call_update',
  'agent_message',
  'state_update',
]
