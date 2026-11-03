/**
 * The programs a kit's extension runs: `delta` is the fake CLI (test/fake-delta), answered in this
 * process, and anything else (the shell that finds `delta`, Git) runs for real, with the kit's
 * environment.
 */
import { basename } from 'node:path'
import type { Host } from '../../src/core/host.ts'
import {
  type Exit,
  type Output,
  type ProcessStream,
  run,
  type RunInit,
  type RunResult,
  spawn,
  type SpawnInit,
} from '../../src/core/process.ts'
import { fakeDelta, type FakeIo } from '../fake-delta/cli.ts'

export type Environment = Record<string, string | undefined>

/** One command the extension ran, as the fake CLI saw it. */
export type Ran = { argv: string[]; env: Environment }

/**
 * A program a test stands in for, by its name (`pi`, `npm`, `git`): it answers each run, or, returning
 * undefined, lets the real program run.
 */
export type FakeProgram = (
  argv: string[],
  init: RunInit & { env: Record<string, string> },
) => RunResult | undefined | Promise<RunResult | undefined>

/**
 * A long-running program a test stands in for, by its name (`pi`): it answers each start with a
 * stream, or, returning undefined, lets the real program start.
 */
export type FakeStream = (init: SpawnInit & { env: Record<string, string> }) => ProcessStream | undefined

export function kitProcesses(
  environment: () => Environment,
  programs: Map<string, FakeProgram> = new Map(),
  streams: Map<string, FakeStream> = new Map(),
): Host['process'] & { ran: Ran[]; others: Ran[]; busy(): number; stopAll(): Promise<void> } {
  const ran: Ran[] = []
  /** The other programs the extension ran, real or faked. */
  const others: Ran[] = []
  const live = new Set<ProcessStream>()
  let busy = 0
  const merged = (extra: Record<string, string> | undefined): Record<string, string> =>
    Object.fromEntries(
      Object.entries({ ...environment(), ...extra }).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    )
  const isDelta = (argv: string[]) => argv[0] !== undefined && basename(argv[0]) === 'delta'
  return {
    ran,
    others,
    /** How many one-shot commands are still running. */
    busy: () => busy,
    async run(argv, init = {}) {
      const env = merged(init.env)
      if (!isDelta(argv)) {
        others.push({ argv, env })
        const fake = argv[0] === undefined ? undefined : programs.get(basename(argv[0]))
        return (await fake?.(argv, { ...init, env })) ?? run(argv, { ...init, env })
      }
      ran.push({ argv, env })
      busy++
      try {
        let stdout = ''
        let stderr = ''
        const exitCode = await fakeDelta(argv.slice(1), {
          env,
          stdin: () => init.stdin ?? '',
          write: (stream, text) => {
            if (stream === 'stdout') stdout += text
            else stderr += text
          },
          hold: () => Promise.reject(new Error(`fake delta: ${argv.join(' ')} holds, but was run to completion`)),
        })
        return { stdout, stderr, exitCode, isStdoutTruncated: false, isStderrTruncated: false }
      } finally {
        busy--
      }
    },
    spawn(init) {
      const env = merged(init.env)
      if (!isDelta(init.argv)) {
        others.push({ argv: init.argv, env })
        const fake = init.argv[0] === undefined ? undefined : streams.get(basename(init.argv[0]))
        return fake?.({ ...init, env }) ?? spawn({ ...init, env })
      }
      ran.push({ argv: init.argv, env })
      const stream = deltaStream(init.argv.slice(1), env)
      live.add(stream)
      const stop = stream.return.bind(stream)
      stream.return = async () => {
        live.delete(stream)
        return stop()
      }
      return stream
    },
    /** End every long-running command still running, as the end of their process would. */
    async stopAll() {
      for (const stream of [...live]) await stream.return()
    },
  }
}

/** A long-running fake command as a stream: its output as it comes, until it exits or is stopped. */
function deltaStream(args: string[], env: Record<string, string>): ProcessStream {
  const queue: Output[] = []
  let exit: Exit | undefined
  let waiting: (() => void) | undefined
  let stop: (() => void) | undefined
  const wake = () => {
    const resume = waiting
    waiting = undefined
    resume?.()
  }
  const io: FakeIo = {
    env,
    stdin: () => '',
    write: (stream, text) => {
      if (exit) return
      queue.push({ stream, text })
      wake()
    },
    hold: (onStop, poll, until) =>
      new Promise((resolve) => {
        // Stopped before it was ready, the command ends as a killed program does.
        if (exit) {
          onStop?.()
          return resolve()
        }
        const timer = poll ? setInterval(poll, 50) : undefined
        stop = () => {
          if (timer) clearInterval(timer)
          onStop?.()
          resolve()
        }
        // A command that ends by itself stops polling and ends without being stopped.
        void until?.then(() => {
          if (timer) clearInterval(timer)
          stop = undefined
          resolve()
        })
      }),
  }
  void fakeDelta(args, io).then(
    (code) => {
      exit ??= { code, signal: null }
      wake()
    },
    (error: unknown) => {
      queue.push({ stream: 'stderr', text: String(error) })
      exit ??= { code: 1, signal: null }
      wake()
    },
  )
  return {
    pid: undefined,
    async next() {
      for (;;) {
        const piece = queue.shift()
        if (piece) return { done: false, value: piece }
        if (exit) return { done: true, value: exit }
        await new Promise<void>((resolve) => (waiting = resolve))
      }
    },
    async return() {
      if (!exit) {
        exit = { code: null, signal: 'SIGTERM' }
        queue.length = 0
        stop?.()
        wake()
      }
      return { done: true, value: exit }
    },
    // A fake command keeps nothing to report as it stops, so it stops as at once.
    terminate() {
      if (exit) return
      exit = { code: null, signal: 'SIGTERM' }
      stop?.()
      wake()
    },
  }
}
