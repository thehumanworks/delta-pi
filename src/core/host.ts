/**
 * What Delta's features reach in pi, bound once per extension runtime by `index.ts`. Every other
 * module reaches pi through a `Host`, so its tests can stand in for pi.
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { Clock } from './clock.ts'
import type { ProcessStream, RunInit, RunResult, SpawnInit } from './process.ts'
import type { Store } from './store.ts'

/** One answer a question offers, with a short hint shown beside it. */
export type AskRequest = {
  options: readonly string[]
  header?: string
  descriptions?: Readonly<Record<string, string>>
  /** Offer a last option that lets the person type an answer instead. */
  typed?: boolean
}

/** How a person-visible note reads: plain, a warning, or a failure. */
export type NoteTone = 'info' | 'warning' | 'error'

export type Host = {
  pi: ExtensionAPI
  /** Where the extension keeps its store, outbox, hand-over records and debug log. */
  dataDir: string
  plugin: { name: string; version: string; root: string }
  clock: Clock
  process: {
    run(argv: string[], init?: RunInit): Promise<RunResult>
    spawn(init: SpawnInit): ProcessStream
  }
  store: Store
  env: {
    windows(): boolean
    /** An environment variable of this pi process, which the programs it starts inherit. */
    get(name: string): string | undefined
    /** Set or, with undefined, remove an environment variable for the programs pi starts from now on. */
    set(name: string, value: string | undefined): void
  }
  session: {
    id(): string
    cwd(): string
    file(): string | undefined
    /** Whether a person can answer questions: pi's terminal, or an RPC client that forwards dialogs. */
    interactive(): boolean
    /** Whether pi draws its terminal UI, where the band shows. */
    terminal(): boolean
    /** The current branch's conversation, as pi sends it to the model, for a share's snapshot. */
    messages(): AgentMessage[]
    /**
     * Every message pi has committed to the session, on any branch, in the order pi appended them, with
     * its entry's ID. Pi commits a message once every extension's `message_end` has run, so it is final.
     */
    committed(): { id: string; message: AgentMessage }[]
    /**
     * Whether pi's session holds, as its latest entry, the custom message the extension just sent with
     * `details`. pi adds a message sent while it is idle at once, keeping its details as given; when it
     * fails to, it says so only on its own error channel.
     */
    holds(details: unknown): boolean
    /** The custom messages of `customType` pi's session holds, on any branch, in order. */
    customMessages(customType: string): { content: unknown; details: unknown }[]
    /** How many prompts and replies the current branch holds: none means a new session. */
    turns(): number
    name(): string | undefined
    idle(): boolean
    /**
     * Write a session file for `id` whose working directory is `directory`, in pi's own session folder
     * for that directory, so switching to it starts pi there; resolves with its path.
     */
    create(id: string, directory: string, parent: string | undefined): Promise<string>
  }
  turn: {
    /** Stop the running agent turn, if any. */
    abort(): void
  }
  ui: {
    /**
     * Ask one question; resolves with the chosen label or typed text, or undefined when dismissed.
     * Rejects with `InteractionUnavailableError` where nobody can be asked.
     */
    ask(question: string, request: AskRequest): Promise<string | undefined>
    /** A note in the transcript for the person, never sent to the model. */
    note(text: string, tone?: NoteTone): void
    /** A transient notice. */
    notify(text: string, tone?: NoteTone): void
    /** The footer's Delta status text, or undefined to clear it. */
    status(text: string | undefined): void
    /** A line in the extension's debug log. */
    debug(text: string): void
    /** Redraw the band. */
    invalidate(): void
    /** Put text on the clipboard; resolves whether it got there. */
    copy(text: string): Promise<boolean>
    /** Open a web page in the person's browser; resolves whether it opened. */
    open(url: string): Promise<boolean>
  }
}

/** Nobody can answer a question in this session: print and JSON modes have no dialogs. */
export class InteractionUnavailableError extends Error {}

/**
 * What the extension takes from the machine pi runs on: `index.ts` binds Node's, and tests their own,
 * so a test runs the whole extension against a fake clock, Delta CLI and environment.
 */
export type Platform = {
  /** Where the extension keeps its store, outbox and debug log. */
  dataDir: string
  clock: Clock
  process: Host['process']
  env: Host['env']
  /** Write to the terminal's error stream, which print mode shows. */
  stderr(text: string): void
  /** Put text on the clipboard; resolves whether it got there. */
  copy(text: string): Promise<boolean>
}
