/**
 * A stand-in for the Delta CLI: the subset of `delta --json` this extension runs, answering in the shapes
 * of the CLI's own fixtures (test/fixtures/cli), with its state in a folder, `$FAKE_DELTA_STATE`.
 * Long-running commands (mounts, watches) hold until they are stopped. The end-to-end tests run it as
 * the `delta` program (test/e2e/bin/delta); the in-process kit (test/kit) calls it directly.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** One record a producer appended, as the fake keeps it. */
export type FakeRecord = {
  producer: string | undefined
  acknowledge: string
  name: string | undefined
  schemaVersion: 1
  sequence: number
  turnSequence?: number
  update: { sessionUpdate: string; [key: string]: any }
}
export type FakeThread = {
  thread_id: string
  title: string | null
  url: string | null
  share_id: string | null
  visibility: string | null
  organization: string | null
  /** References of the worktrees attached to the thread. */
  worktrees: string[]
  records: FakeRecord[]
  invited?: string[]
  /** A child thread's parent, name and reference. */
  parent?: string
  name?: string
  reference?: string
}
export type FakeWorktree = {
  reference: string
  worktree_id: string
  /** Where the worktree is checked out, and, for a thread mount's folder, how many mount commands hold it. */
  directories: { directory: string; state: 'waiting' | 'mounted'; holders?: number }[]
}
/** Everything the fake Delta holds, in `$FAKE_DELTA_STATE/state.json`. */
export type FakeState = {
  threads: Record<string, FakeThread>
  /** Each producer's thread and next sequence, by `source:external-id`. */
  producers: Record<string, { thread: string; next: number }>
  worktrees: FakeWorktree[]
  counter: number
  shares: Record<string, unknown>
  forked?: string[]
}

/** How one run of the fake reaches its caller. */
export type FakeIo = {
  env: Record<string, string | undefined>
  stdin(): string
  write(stream: 'stdout' | 'stderr', text: string): void
  /**
   * Hold a long-running command until it is stopped, calling `poll` every 50 ms meanwhile; `onStop`
   * runs when it is stopped. Resolves once it is, or, without `onStop`, once `until` settles, as a
   * command that ends by itself does.
   */
  hold(onStop?: () => void, poll?: () => void, until?: Promise<void>): Promise<void>
}

/**
 * What a test makes a command answer instead of its own answer (`world().answer`): exactly this output
 * and exit code, after the command has run when `run` is set, so its effects happen and its answer is
 * lost, as when Delta did the work and the reply never arrived.
 */
export type FakeAnswer = { stdout?: string; stderr?: string; exitCode?: number; run?: boolean }
type AnswerSwitch = FakeAnswer & { after: number; times: number }

/** The answer a test set for this run of `args`, counting its runs down; undefined to run as usual. */
function takeAnswer(args: string[], io: FakeIo): FakeAnswer | undefined {
  const root = io.env.FAKE_DELTA_STATE
  if (!root) return undefined
  const [group, command] = args.filter((arg) => arg !== '--json')
  const path = join(root, `answer-${`${group} ${command ?? ''}`.trim().replaceAll(' ', '-')}`)
  if (!existsSync(path)) return undefined
  const value = JSON.parse(readFileSync(path, 'utf8')) as AnswerSwitch
  if (value.after > 0) {
    writeFileSync(path, JSON.stringify({ ...value, after: value.after - 1 }))
    return undefined
  }
  if (value.times <= 1) rmSync(path, { force: true })
  else writeFileSync(path, JSON.stringify({ ...value, times: value.times - 1 }))
  return value
}

/**
 * The actor Delta records a producer's output as, which its items' `author.actor_id` names: one per
 * external ID here, so a test can write a producer's own items.
 */
export function actorOf(external: string | undefined): string | null {
  return external ? `actor-${external}` : null
}

/** Ends a run of the fake with an exit code. */
class Exit extends Error {
  code: number
  constructor(code: number) {
    super(`exit ${code}`)
    this.code = code
  }
}

/** Run `args` as `delta` would, through `io`; resolves with the exit code. */
export async function fakeDelta(args: string[], io: FakeIo): Promise<number> {
  const answer = takeAnswer(args, io)
  if (!answer) return runToExit(args, io)
  if (answer.run) await runToExit(args, { ...io, write: () => {}, hold: async () => {} })
  if (answer.stdout) io.write('stdout', answer.stdout)
  if (answer.stderr) io.write('stderr', answer.stderr)
  return answer.exitCode ?? 1
}

async function runToExit(args: string[], io: FakeIo): Promise<number> {
  try {
    await run(args, io)
    return 0
  } catch (error) {
    if (error instanceof Exit) return error.code
    throw error
  }
}

/** The fake's state folder; a run without one fails. */
function stateFolder(io: FakeIo): string {
  const root = io.env.FAKE_DELTA_STATE
  if (!root) {
    io.write('stderr', 'FAKE_DELTA_STATE is not set\n')
    throw new Exit(2)
  }
  return root
}

async function run(args: string[], io: FakeIo): Promise<void> {
  const root = stateFolder(io)
  // The test creates the folder; a call after it cleaned up finds none and changes nothing.
  if (!existsSync(root)) {
    io.write('stderr', 'fake delta: the state folder is gone\n')
    throw new Exit(2)
  }
  const statePath = join(root, 'state.json')
  const lockPath = join(root, 'state.lock')

  function lock() {
    for (let attempt = 0; attempt < 2000; attempt++) {
      try {
        mkdirSync(lockPath)
        return
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
      }
    }
    throw new Error('fake delta: state lock timed out')
  }
  function unlock() {
    try {
      rmdirSync(lockPath)
    } catch {
      /* a test that cleaned up its state took the lock with it */
    }
  }

  function read(): FakeState {
    return existsSync(statePath)
      ? JSON.parse(readFileSync(statePath, 'utf8'))
      : { threads: {}, producers: {}, worktrees: [], counter: 0, shares: {} }
  }
  function write(state: FakeState) {
    const temporary = `${statePath}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(state, null, 2))
    renameSync(temporary, statePath)
  }
  function update<T>(change: (state: FakeState) => T): T {
    lock()
    try {
      const state = read()
      const result = change(state)
      write(state)
      return result
    } finally {
      unlock()
    }
  }
  function log(entry: unknown) {
    appendFileSync(join(root, 'calls.jsonl'), JSON.stringify(entry) + '\n')
  }
  function out(value: unknown) {
    io.write('stdout', JSON.stringify(value) + '\n')
  }
  function fail(code: string, message: string, retryable = false): never {
    out({ error: { code, message, retryable } })
    throw new Exit(1)
  }
  function option(args: string[], name: string): string | undefined {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : undefined
  }
  /** A thread named by id, share link or share id. */
  function resolve(state: FakeState, locator: string | undefined): FakeThread | undefined {
    if (locator === undefined) return undefined
    if (state.threads[locator]) return state.threads[locator]
    const id = locator.replace(/^https:\/\/delta\.dev\/join\//, '')
    return Object.values(state.threads).find(
      (thread) => thread.share_id === id || thread.thread_id === id || thread.reference === locator,
    )
  }
  /** The thread `locator` names; naming none fails as Delta does. */
  function known(state: FakeState, locator: string | undefined): FakeThread {
    return resolve(state, locator) ?? fail('invalid_reference', `no thread ${locator ?? ''}`)
  }
  /** A positional argument the command requires. */
  function required(value: string | undefined, what: string): string {
    return value ?? fail('invalid_arguments', `missing ${what}`)
  }
  function producerKey(source: string | undefined, external: string | undefined) {
    return `${source}:${external}`
  }

  const argv = args.filter((arg) => arg !== '--json')
  const json = args.includes('--json')
  log({
    argv: args,
    env: { integration: io.env.DELTA_CLI_INTEGRATION, form: io.env.DELTA_CLI_COMMAND_FORM },
  })
  const [group, command, ...rest] = argv
  const words = `${group} ${command ?? ''}`.trim()

  const signedOut = io.env.FAKE_DELTA_SIGNED_OUT && !existsSync(join(root, 'signed-in'))
  if (signedOut && !['thread contract', 'auth status', 'auth login', 'auth wait'].includes(words))
    fail('authentication_required', 'Sign in to Delta')
  /** Switches a test flips in the state folder: a file per switch. */
  const flag = (name: string) => existsSync(join(root, name))
  // A test holds runs of a command while `hold-<command>` exists, and makes runs fail while
  // `fail-<command>` counts down, each after letting `after` runs through: see world() in test/world.ts.
  const switchName = words.replaceAll(' ', '-')
  /** Whether this run is past the runs the switch lets through; counts them down meanwhile. */
  type Switch = { after: number; times?: number; code?: string; retryable?: boolean }
  const reached = (path: string): Switch | undefined => {
    if (!existsSync(path)) return
    const value = JSON.parse(readFileSync(path, 'utf8')) as Switch
    if (value.after <= 0) return value
    writeFileSync(path, JSON.stringify({ ...value, after: value.after - 1 }))
    return undefined
  }
  const holding = join(root, `hold-${switchName}`)
  if (reached(holding)) while (existsSync(holding)) await new Promise((resolve) => setTimeout(resolve, 20))
  const failing = join(root, `fail-${switchName}`)
  const failure = reached(failing)
  if (failure) {
    const left = (failure.times ?? 1) - 1
    if (left <= 0) rmSync(failing, { force: true })
    else writeFileSync(failing, JSON.stringify({ ...failure, after: 0, times: left }))
    fail(failure.code ?? 'process_failed', `${words} failed as the test asked`, failure.retryable ?? true)
  }

  switch (words) {
    case 'thread contract': {
      // A test sets the range another CLI version would speak in `contract.json`.
      const range = existsSync(join(root, 'contract.json'))
        ? (JSON.parse(readFileSync(join(root, 'contract.json'), 'utf8')) as { min: number; max: number })
        : { min: 8, max: 8 }
      out({ operation: 'contract', ...range })
      break
    }
    case 'auth status':
      if (signedOut) {
        out({ status: 'signed_out' })
        throw new Exit(1)
      }
      out({ status: 'signed_in', account: { login: 'ada' } })
      break
    case 'auth login':
      out({
        status: 'pending',
        login_id: 'login-1',
        url: 'https://delta.dev/login/login-1',
        expires_at: '2099-01-01T00:00:00Z',
      })
      break
    case 'auth wait':
      writeFileSync(join(root, 'signed-in'), '')
      out({ status: 'signed_in', account: { login: 'ada' } })
      break
    case 'org current':
      io.write('stdout', 'org-1  Zed\n')
      break
    case 'org switch':
      io.write('stdout', `Switched to ${rest.at(-1)}\n`)
      break
    case 'org create':
      out({ operation: 'created', organization: { id: 'org-new', name: rest.at(-1), current: false } })
      break
    case 'org invite':
      if (!json) {
        io.write('stdout', `Invited ${rest.slice(rest.indexOf('--') + 1).join(', ')}\n`)
        break
      }
      out({
        operation: 'invited',
        results: rest.slice(rest.indexOf('--') + 1).map((email) => ({ status: 'invited', email })),
      })
      break
    case 'thread fork':
      update((state) => {
        state.forked = [...(state.forked ?? []), required(rest[0], 'the thread')]
      })
      out({ source_thread_id: rest[0], thread_id: 'thread_fork', name: 'Fork (local changes)' })
      break
    case 'thread discard':
      rmSync(join(root, 'refuse-appends'), { force: true })
      out({ operation: 'discarded', thread_id: rest[0] })
      break
    case 'org list':
      if (!json) {
        io.write('stdout', '* org-1  Zed\n')
        break
      }
      out({
        organizations: [
          { id: 'org-1', name: 'Zed', current: true },
          { id: 'org-personal', name: "ada's Organization", current: false, personal: true },
        ],
      })
      break
    case 'update --check':
    case 'update':
      out({
        schema_version: 1,
        status: 'up_to_date',
        current_version: '0.23.0',
        latest_version: '0.23.0',
        channel: 'stable',
        message: '',
        can_install: false,
      })
      break
    case 'thread create': {
      const source = option(rest, '--source')
      const external = option(rest, '--external-id')
      const parent = option(rest, '--parent')
      const result = update((state) => {
        const key = producerKey(source, external)
        const existing = state.producers[key]
        if (existing)
          return {
            operation: 'created',
            thread_id: existing.thread,
            created: false,
            ...(state.threads[existing.thread]?.reference
              ? { reference: state.threads[existing.thread]?.reference }
              : {}),
          }
        const thread_id = `thread_${++state.counter}`
        const parentThread = parent ? resolve(state, parent) : undefined
        if (parent && !parentThread)
          return { error: { code: 'invalid_reference', message: `no thread ${parent}`, retryable: false } }
        // A thread created with an upload organization gets its link from Delta's background upload.
        const uploads = !!option(rest, '--organization')
        state.threads[thread_id] = {
          thread_id,
          title: null,
          url: uploads ? `https://delta.dev/join/share_${thread_id}` : null,
          share_id: uploads ? `share_${thread_id}` : null,
          visibility: option(rest, '--visibility') ?? null,
          organization: option(rest, '--organization') ?? null,
          worktrees: parentThread && rest.includes('--shared-worktrees') ? [...parentThread.worktrees] : [],
          records: [],
          ...(parentThread
            ? {
                parent: parentThread.thread_id,
                name: option(rest, '--name'),
                reference: `${parentThread.thread_id}#s=${thread_id}`,
              }
            : {}),
        }
        state.producers[key] = { thread: thread_id, next: 1 }
        return {
          operation: 'created',
          thread_id,
          created: true,
          ...(parentThread ? { reference: state.threads[thread_id].reference } : {}),
        }
      })
      if (result.error) {
        out(result)
        throw new Exit(1)
      }
      out(result)
      break
    }
    case 'thread status': {
      const [locator] = rest
      const source = option(rest, '--source')
      const external = option(rest, '--external-id')
      const state = read()
      const thread = known(state, locator)
      if (!thread) fail('invalid_reference', `no thread ${locator}`)
      const producer = state.producers[producerKey(source, external)]
      out({
        operation: 'status',
        thread_id: thread.thread_id,
        title: thread.title,
        url: thread.url,
        visibility: thread.visibility,
        upload: thread.visibility ? { state: 'uploaded', organization_id: thread.organization, error: null } : null,
        access: { state: 'granted', is_owner: true },
        worktrees: {
          status: 'available',
          items: thread.worktrees.map((reference) => ({
            reference,
            checkouts: state.worktrees
              .filter((tree) => tree.reference === reference)
              .flatMap((tree) =>
                tree.directories.map((entry) => ({
                  directory: entry.directory,
                  state: 'attached',
                  active: entry.state === 'mounted',
                })),
              ),
          })),
        },
        producer: {
          source,
          external_id: external,
          actor_id: actorOf(external),
          next_sequence: producer?.thread === thread.thread_id ? producer.next : 1,
          turn: null,
        },
      })
      break
    }
    case 'thread share': {
      const [locator] = rest
      const result = update((state) => {
        const thread = known(state, locator)
        thread.share_id ??= `share_${thread.thread_id}`
        thread.url = `https://delta.dev/join/${thread.share_id}`
        thread.visibility = 'organization'
        return { operation: 'shared', thread_id: thread.thread_id, share_id: thread.share_id, url: thread.url }
      })
      out(result)
      break
    }
    case 'thread invite': {
      const [locator] = rest
      const emails = rest.slice(rest.indexOf('--') + 1)
      const result = update((state) => {
        const thread = known(state, locator)
        thread.share_id ??= `share_${thread.thread_id}`
        thread.url = `https://delta.dev/join/${thread.share_id}`
        thread.visibility ??= 'private'
        thread.invited = [...(thread.invited ?? []), ...emails]
        return {
          operation: 'invited',
          thread_id: thread.thread_id,
          share_id: thread.share_id,
          url: thread.url,
          results: emails.map((email) => ({ status: 'invited', email })),
        }
      })
      out(result)
      break
    }
    case 'thread append': {
      const [locator] = rest
      if (flag('refuse-appends')) fail('reload_required', "The server refused this thread's local changes")
      const source = option(rest, '--source')
      const external = option(rest, '--external-id')
      const input = io.stdin()
      const records = input
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      const receipts = update((state) => {
        const thread = known(state, locator)
        const producer =
          state.producers[producerKey(source, external)] ??
          (state.producers[producerKey(source, external)] = { thread: thread.thread_id, next: 1 })
        return records.map((record) => {
          if (record.sequence < producer.next)
            return {
              operation: 'appended',
              thread_id: thread.thread_id,
              sequence: record.sequence,
              next_sequence: producer.next,
              duplicate: true,
              disposition: 'duplicate',
              turn_sequence: record.turnSequence ?? null,
              version: 'v1',
            }
          if (record.sequence !== producer.next) return { gap: true }
          producer.next++
          thread.records.push({
            producer: external,
            acknowledge: option(rest, '--acknowledge') ?? 'server',
            name: option(rest, '--producer-name'),
            ...record,
          })
          if (record.update?.sessionUpdate === 'session_info_update') thread.title = record.update.title
          return {
            operation: 'appended',
            thread_id: thread.thread_id,
            sequence: record.sequence,
            next_sequence: producer.next,
            duplicate: false,
            disposition: 'recorded',
            turn_sequence: record.turnSequence ?? null,
            version: 'v1',
          }
        })
      })
      for (const receipt of receipts) {
        if (receipt.gap) fail('sequence_gap', 'records out of order')
        out(receipt)
      }
      break
    }
    case 'thread watch': {
      const [locator] = rest
      const source = option(rest, '--source')
      const external = option(rest, '--external-id')
      const state = read()
      const thread = known(state, locator)
      if (!thread) fail('invalid_reference', `no thread ${locator}`)
      const producer = source ? state.producers[producerKey(source, external)] : undefined
      out({
        type: 'ready',
        thread_id: thread.thread_id,
        producer: source
          ? {
              source,
              external_id: external,
              actor_id: actorOf(external),
              next_sequence: producer?.next ?? 1,
              turn: null,
            }
          : null,
      })
      const eventsPath = join(root, `events-${thread.thread_id}.jsonl`)
      let offset = 0
      // A test ends the watch with a control line (`world().endWatch`), as a dropped connection does.
      let exitCode: number | undefined
      let ended: () => void = () => {}
      const ending = new Promise<void>((resolve) => (ended = resolve))
      const flush = () => {
        if (exitCode !== undefined || !existsSync(eventsPath)) return
        const text = readFileSync(eventsPath, 'utf8')
        const fresh = text.slice(offset)
        const end = fresh.lastIndexOf('\n')
        if (end < 0) return
        for (const line of fresh.slice(0, end + 1).split(/(?<=\n)/)) {
          const control = /^\{"fake_watch_exit":(\d+)\}\n$/.exec(line)
          if (!control) {
            io.write('stdout', line)
            offset += line.length
            continue
          }
          // The control line ends this watch only: the next one replays what came before it, not it.
          const current = readFileSync(eventsPath, 'utf8')
          writeFileSync(eventsPath, current.slice(0, offset) + current.slice(offset + line.length))
          exitCode = Number(control[1])
          ended()
          return
        }
      }
      // The snapshot: every event written before the watch started, then `live`.
      flush()
      out({ type: 'live' })
      out({ type: 'presence', users: [] })
      out({ type: 'worktrees', worktrees: thread.worktrees.map((reference) => ({ reference, name: 'repo' })) })
      await io.hold(undefined, flush, ending)
      if (exitCode !== undefined) throw new Exit(exitCode)
      break
    }
    case 'thread mount': {
      const [locator] = rest
      const owner = option(rest, '--owner')
      let thread: FakeThread | undefined
      const directory = update((state) => {
        thread = known(state, locator)
        const folder = join(root, 'mounts', thread.thread_id, required(owner, '--owner'))
        mkdirSync(folder, { recursive: true })
        for (const reference of thread.worktrees) {
          let tree = state.worktrees.find((entry) => entry.reference === reference)
          if (!tree) state.worktrees.push((tree = { reference, worktree_id: reference, directories: [] }))
          const entry = tree.directories.find((candidate) => candidate.directory === folder)
          if (entry) {
            entry.state = 'mounted'
            entry.holders = (entry.holders ?? 0) + 1
          } else tree.directories.push({ directory: folder, state: 'mounted', holders: 1 })
        }
        return folder
      })
      if (!thread) fail('invalid_reference', `no thread ${locator}`)
      out({
        operation: 'mounted',
        thread_id: thread.thread_id,
        owner,
        directory,
        worktrees: thread.worktrees.map((reference) => ({ reference, name: 'repo', directory, state: 'mounted' })),
      })
      // Delta releases an owner's directories once no mount command for them runs; mounting again under
      // the same owner replaces the process and keeps them mounted.
      await io.hold(() =>
        update((state) => {
          for (const tree of state.worktrees)
            for (const entry of tree.directories)
              if (entry.directory === directory && (entry.holders = (entry.holders ?? 1) - 1) <= 0)
                entry.state = 'waiting'
        }),
      )
      break
    }
    case 'worktree list': {
      const state = read()
      out({
        operation: 'listed',
        worktrees: state.worktrees.map((tree) => ({
          worktree_id: tree.worktree_id,
          reference: tree.reference,
          directories: tree.directories,
        })),
      })
      break
    }
    case 'worktree create': {
      const directory = required(rest[0], 'the directory')
      const id = randomUUID()
      update((state) => {
        state.worktrees.push({ reference: id, worktree_id: id, directories: [{ directory, state: 'waiting' }] })
      })
      out({ operation: 'created', worktree_id: id, reference: id })
      break
    }
    case 'worktree attach': {
      const reference = required(rest[0], 'the worktree')
      const locator = option(rest, '--thread')
      const result = update((state) => {
        const thread = known(state, locator)
        if (!thread.worktrees.includes(reference)) thread.worktrees.push(reference)
        return { operation: 'attached', reference, thread_id: thread.thread_id }
      })
      out(result)
      break
    }
    case 'worktree mount': {
      const [reference, directory] = rest
      const mark = (value: 'waiting' | 'mounted') =>
        update((state) => {
          const tree = state.worktrees.find((entry) => entry.reference === reference)
          for (const entry of tree?.directories ?? []) if (entry.directory === directory) entry.state = value
        })
      mark('mounted')
      out({ operation: 'mounted', reference, directory })
      await io.hold(() => mark('waiting'))
      break
    }
    default:
      io.write('stderr', `fake delta: unsupported command ${argv.join(' ')}\n`)
      throw new Exit(2)
  }
}
