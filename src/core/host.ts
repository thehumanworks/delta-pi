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
    home(): string | undefined
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
    /** How many prompts and replies the current branch holds: none means a new session. */
    turns(): number
    name(): string | undefined
    idle(): boolean
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
