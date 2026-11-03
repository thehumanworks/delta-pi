/**
 * Running programs for the extension: `run` collects a short command's output, as Claude Code's
 * `$.process.run` does, and `spawn` streams a long-running one, such as a mount or a watch, until it
 * exits or is stopped.
 */
import { spawn as spawnChild } from 'node:child_process'

export type RunInit = { cwd?: string; stdin?: string; timeoutMs?: number; env?: Record<string, string> }
export type RunResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  isStdoutTruncated: boolean
  isStderrTruncated: boolean
}
export type Exit = { code: number | null; signal: string | null }
export type Output = { stream: 'stdout' | 'stderr'; text: string }
/**
 * A running program's output, piece by piece, ending with how it exited. `return` stops it with
 * SIGTERM and resolves once it has exited, or after a bounded wait.
 */
export type ProcessStream = AsyncIterator<Output, Exit> & {
  return(value?: Exit): Promise<IteratorResult<Output, Exit>>
  readonly pid: number | undefined
}
export type SpawnInit = { argv: string[]; env?: Record<string, string>; cwd?: string }

/** Output past this is cut and reported as truncated, as Claude Code's `process.run` does. */
const CAPTURE_LIMIT = 4 * 1024 * 1024
/** How long stopping a program waits for it to exit before leaving it to finish on its own. */
const STOP_WAIT_MS = 6_000

function environment(env: Record<string, string> | undefined): NodeJS.ProcessEnv {
  return env ? { ...process.env, ...env } : process.env
}

/** Run `argv` to completion, collecting at most {@link CAPTURE_LIMIT} of each output. */
export function run(argv: string[], init: RunInit = {}): Promise<RunResult> {
  const [command, ...args] = argv
  if (!command) return Promise.reject(new Error('No command to run'))
  return new Promise((resolve, reject) => {
    const child = spawnChild(command, args, {
      cwd: init.cwd,
      env: environment(init.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let isStdoutTruncated = false
    let isStderrTruncated = false
    let timedOut = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (text: string) => {
      if (stdout.length + text.length > CAPTURE_LIMIT) {
        stdout += text.slice(0, Math.max(0, CAPTURE_LIMIT - stdout.length))
        isStdoutTruncated = true
      } else stdout += text
    })
    child.stderr.on('data', (text: string) => {
      if (stderr.length + text.length > CAPTURE_LIMIT) {
        stderr += text.slice(0, Math.max(0, CAPTURE_LIMIT - stderr.length))
        isStderrTruncated = true
      } else stderr += text
    })
    const timer =
      init.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true
            child.kill('SIGTERM')
          }, init.timeoutMs)
        : undefined
    child.on('error', (error) => {
      if (timer) clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (timedOut) return reject(new Error(`${command} timed out after ${init.timeoutMs} ms`))
      resolve({ stdout, stderr, exitCode: code, isStdoutTruncated, isStderrTruncated })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(init.stdin ?? '')
  })
}

/** Start `argv` and stream its output; the caller reads it with `next` and stops it with `return`. */
export function spawn(init: SpawnInit): ProcessStream {
  const [command, ...args] = init.argv
  if (!command) throw new Error('No command to run')
  const child = spawnChild(command, args, {
    cwd: init.cwd,
    env: environment(init.env),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const queue: Output[] = []
  let exit: Exit | undefined
  let failure: unknown
  let waiting: (() => void) | undefined
  const wake = () => {
    const resume = waiting
    waiting = undefined
    resume?.()
  }
  const exited = new Promise<Exit>((resolve) => {
    child.on('close', (code, signal) => {
      exit = { code, signal }
      resolve(exit)
      wake()
    })
  })
  child.on('error', (error) => {
    failure = error
    exit ??= { code: null, signal: null }
    wake()
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (text: string) => {
    queue.push({ stream: 'stdout', text })
    wake()
  })
  child.stderr.on('data', (text: string) => {
    queue.push({ stream: 'stderr', text })
    wake()
  })
  let stopped = false
  const stream: ProcessStream = {
    pid: child.pid,
    async next(): Promise<IteratorResult<Output, Exit>> {
      for (;;) {
        const piece = queue.shift()
        if (piece) return { done: false, value: piece }
        if (failure !== undefined) {
          const error = failure
          failure = undefined
          throw error
        }
        if (exit) return { done: true, value: exit }
        await new Promise<void>((resolve) => {
          waiting = resolve
        })
      }
    },
    async return(): Promise<IteratorResult<Output, Exit>> {
      if (!exit && !stopped) {
        stopped = true
        child.kill('SIGTERM')
      }
      const result =
        exit ??
        (await Promise.race([
          exited,
          new Promise<Exit>((resolve) =>
            setTimeout(() => resolve({ code: null, signal: 'SIGTERM' }), STOP_WAIT_MS).unref(),
          ),
        ]))
      queue.length = 0
      return { done: true, value: result }
    },
  }
  return stream
}
