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
  /**
   * Ask the program to stop with SIGTERM while its output is still read, so a program that reports
   * as it shuts down, as pi's JSON mode does, can finish; SIGKILL follows {@link TERMINATE_GRACE_MS}
   * later. The reader keeps calling `next` until the stream ends with the program's exit.
   */
  terminate(): void
  readonly pid: number | undefined
}
/** `stdin`, when given, is written to the program's input, which is then closed. */
export type SpawnInit = { argv: string[]; env?: Record<string, string>; cwd?: string; stdin?: string }

/** Output past this is cut and reported as truncated, as Claude Code's `process.run` does. */
const CAPTURE_LIMIT = 4 * 1024 * 1024
/** How long a program has to exit after SIGTERM before it is killed. */
export const KILL_GRACE_MS = 2_000
/** How long stopping a program waits for it to exit before leaving it to finish on its own. */
const STOP_WAIT_MS = 6_000
/**
 * How long a program asked to stop with `terminate` has before it is killed: longer than a pi
 * subagent's own end (`SUBAGENT_SHUTDOWN_MS` in src/subagents/subagents.ts), which flushes its records.
 */
export const TERMINATE_GRACE_MS = 20_000

function environment(env: Record<string, string> | undefined): NodeJS.ProcessEnv {
  return env ? { ...process.env, ...env } : process.env
}

/**
 * Run `argv` to completion, collecting at most {@link CAPTURE_LIMIT} of each output. With `timeoutMs`,
 * the program is sent SIGTERM at its deadline and SIGKILL {@link KILL_GRACE_MS} later, and the run
 * rejects by then even if a descendant still holds its output open. Descendants are not stopped.
 */
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
    let settled = false
    const timers: NodeJS.Timeout[] = []
    const settle = (finish: () => void) => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      finish()
    }
    const timeout = () => new Error(`${command} timed out after ${init.timeoutMs} ms`)
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
    if (init.timeoutMs !== undefined)
      timers.push(
        setTimeout(() => {
          timedOut = true
          child.kill('SIGTERM')
          timers.push(
            setTimeout(() => {
              child.kill('SIGKILL')
              // Output a descendant still holds open would otherwise keep the run waiting for `close`.
              child.stdout.destroy()
              child.stderr.destroy()
              settle(() => reject(timeout()))
            }, KILL_GRACE_MS),
          )
        }, init.timeoutMs),
      )
    child.on('error', (error) => settle(() => reject(error)))
    child.on('close', (code) =>
      settle(() =>
        timedOut
          ? reject(timeout())
          : resolve({ stdout, stderr, exitCode: code, isStdoutTruncated, isStderrTruncated }),
      ),
    )
    child.stdin.on('error', () => {
      /* a program that exits without reading its input closes the pipe; its exit says what happened */
    })
    child.stdin.end(init.stdin ?? '')
  })
}

/**
 * Start `argv` and stream its output; the caller reads it with `next` and stops it with `return`.
 * `return` ends the stream at once, waking a pending `next`, then sends SIGTERM, SIGKILL after
 * {@link KILL_GRACE_MS}, and resolves with how the program exited, or after {@link STOP_WAIT_MS}.
 */
export function spawn(init: SpawnInit): ProcessStream {
  const [command, ...args] = init.argv
  if (!command) throw new Error('No command to run')
  const options = { cwd: init.cwd, env: environment(init.env), windowsHide: true }
  // Only a program given input gets a pipe for it; the others read nothing, as from /dev/null.
  const child =
    init.stdin === undefined
      ? spawnChild(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawnChild(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] })
  if (child.stdin) {
    child.stdin.on('error', () => {
      /* a program that exits without reading its input closes the pipe; its exit says what happened */
    })
    child.stdin.end(init.stdin)
  }
  const queue: Output[] = []
  let exit: Exit | undefined
  let failure: Error | undefined
  /** The reader stopped the stream: no more output is kept, and every read ends it. */
  let closed = false
  let waiting: (() => void) | undefined
  let kill: NodeJS.Timeout | undefined
  const wake = () => {
    const resume = waiting
    waiting = undefined
    resume?.()
  }
  const exited = new Promise<Exit>((resolve) => {
    child.on('close', (code, signal) => {
      if (kill) clearTimeout(kill)
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
  const keep = (piece: Output) => {
    if (closed) return
    queue.push(piece)
    wake()
  }
  child.stdout.on('data', (text: string) => keep({ stream: 'stdout', text }))
  child.stderr.on('data', (text: string) => keep({ stream: 'stderr', text }))
  const stopped: Exit = { code: null, signal: 'SIGTERM' }
  const stream: ProcessStream = {
    pid: child.pid,
    async next(): Promise<IteratorResult<Output, Exit>> {
      for (;;) {
        if (closed) return { done: true, value: exit ?? stopped }
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
    terminate() {
      if (exit || closed || kill) return
      child.kill('SIGTERM')
      kill = setTimeout(() => child.kill('SIGKILL'), TERMINATE_GRACE_MS)
      kill.unref()
    },
    async return(): Promise<IteratorResult<Output, Exit>> {
      if (!closed) {
        closed = true
        queue.length = 0
        // The output is no longer read; a descendant holding the pipes open must not keep pi alive.
        child.stdout.destroy()
        child.stderr.destroy()
        wake()
        if (!exit) {
          if (kill) clearTimeout(kill)
          child.kill('SIGTERM')
          kill = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
          kill.unref()
        }
      }
      const result =
        exit ??
        (await Promise.race([
          exited,
          new Promise<Exit>((resolve) => setTimeout(() => resolve(stopped), STOP_WAIT_MS).unref()),
        ]))
      return { done: true, value: result }
    },
  }
  return stream
}
