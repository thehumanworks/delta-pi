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
} from '../../src/core/process.ts'
import { fakeDelta, type FakeIo } from '../fake-delta/cli.ts'

export type Environment = Record<string, string | undefined>

/** One command the extension ran, as the fake CLI saw it. */
export type Ran = { argv: string[]; env: Environment }

/**
 * A program a test stands in for, by its name (`pi`, `npm`, `git`, `where.exe`): it answers each run, or,
 * returning undefined, lets the real program run. A spawned program's answer is streamed, stderr first;
 * a fake can instead return the stream itself, to report as it goes, hold, or see itself stopped.
 */
export type FakeProgram = (
  argv: string[],
  init: RunInit & { env: Record<string, string> },
) => RunResult | ProcessStream | undefined | Promise<RunResult | ProcessStream | undefined>

/** A program's name, from a POSIX or Windows path: `delta` for `C:\Delta\bin\delta.exe`. */
const programName = (path: string | undefined) =>
  path
    ?.split(/[\\/]/)
    .pop()
    ?.replace(/\.exe$/i, '')
const isStream = (value: RunResult | ProcessStream): value is ProcessStream => 'next' in value

export function kitProcesses(
  environment: () => Environment,
  programs: Map<string, FakeProgram> = new Map(),
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
  const isDelta = (argv: string[]) => programName(argv[0]) === 'delta'
  const fakeFor = (argv: string[]) => {
    const name = argv[0] === undefined ? undefined : basename(argv[0])
    return (name ? programs.get(name) : undefined) ?? programs.get(programName(argv[0]) ?? '')
  }
  return {
    ran,
    others,
    /** How many one-shot commands are still running. */
    busy: () => busy,
    async run(argv, init = {}) {
      const env = merged(init.env)
      if (!isDelta(argv)) {
        others.push({ argv, env })
        const answer = await fakeFor(argv)?.(argv, { ...init, env })
        if (!answer) return run(argv, { ...init, env })
        return isStream(answer) ? collect(answer) : answer
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
        const fake = fakeFor(init.argv)
        if (!fake) return spawn({ ...init, env })
        others.push({ argv: init.argv, env })
        return answered(Promise.resolve(fake(init.argv, { ...init, env })), () => spawn({ ...init, env }))
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

/** A fake program's answer as the stream `spawn` returns: its own stream, its output, or the real program's. */
function answered(answer: Promise<RunResult | ProcessStream | undefined>, real: () => ProcessStream): ProcessStream {
  const stream = answer.then((value) => {
    if (!value) return real()
    if (isStream(value)) return value
    const pieces: Output[] = [
      ...(value.stderr ? [{ stream: 'stderr' as const, text: value.stderr }] : []),
      ...(value.stdout ? [{ stream: 'stdout' as const, text: value.stdout }] : []),
    ]
    const exit: Exit = { code: value.exitCode, signal: null }
    return {
      pid: undefined,
      next: async () => {
        const piece = pieces.shift()
        return piece ? { done: false, value: piece } : { done: true, value: exit }
      },
      return: async () => ({ done: true, value: exit }),
    } satisfies ProcessStream
  })
  return {
    pid: undefined,
    next: async () => (await stream).next(),
    return: async (value) => (await stream).return(value),
  }
}

/** A fake program's stream run to its end, as `run` answers it. */
async function collect(stream: ProcessStream): Promise<RunResult> {
  let stdout = ''
  let stderr = ''
  for (;;) {
    const piece = await stream.next()
    if (piece.done)
      return { stdout, stderr, exitCode: piece.value.code, isStdoutTruncated: false, isStderrTruncated: false }
    if (piece.value.stream === 'stdout') stdout += piece.value.text
    else stderr += piece.value.text
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
  }
}
