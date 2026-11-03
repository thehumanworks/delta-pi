/**
 * The programs a kit's extension runs: `delta` is the fake CLI (test/fake-delta), answered in this
 * process, and anything else (the shell that finds `delta`, Git) runs for real, with the kit's
 * environment.
 */
import { basename } from 'node:path'
import type { Host } from '../../src/core/host.ts'
import { type Exit, type Output, type ProcessStream, run, spawn } from '../../src/core/process.ts'
import { fakeDelta, type FakeIo } from '../fake-delta/cli.ts'

export type Environment = Record<string, string | undefined>

/** One command the extension ran, as the fake CLI saw it. */
export type Ran = { argv: string[]; env: Environment }

export function kitProcesses(environment: () => Environment): Host['process'] & { ran: Ran[]; busy(): number } {
  const ran: Ran[] = []
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
    /** How many one-shot commands are still running. */
    busy: () => busy,
    async run(argv, init = {}) {
      const env = merged(init.env)
      if (!isDelta(argv)) return run(argv, { ...init, env })
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
      if (!isDelta(init.argv)) return spawn({ ...init, env })
      ran.push({ argv: init.argv, env })
      return deltaStream(init.argv.slice(1), env)
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
    hold: (onStop, poll) =>
      new Promise((resolve) => {
        const timer = poll ? setInterval(poll, 50) : undefined
        stop = () => {
          if (timer) clearInterval(timer)
          onStop?.()
          resolve()
        }
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
