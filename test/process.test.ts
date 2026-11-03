import { describe, expect, test } from 'vitest'
import { KILL_GRACE_MS, run, spawn } from '../src/core/process.ts'

describe('processes', () => {
  test('a stream yields output as it comes and ends with how the program exited', async () => {
    const stream = spawn({ argv: ['sh', '-c', 'printf one; printf two >&2; exit 3'] })
    const pieces: string[] = []
    let piece = await stream.next()
    while (!piece.done) {
      pieces.push(`${piece.value.stream}:${piece.value.text}`)
      piece = await stream.next()
    }
    expect(pieces.sort()).toEqual(['stderr:two', 'stdout:one'])
    expect(piece.value).toEqual({ code: 3, signal: null })
  })

  test('stopping a program ends it with SIGTERM and waits for it to exit', async () => {
    const stream = spawn({ argv: ['sh', '-c', 'trap "exit 0" TERM; echo ready; while :; do sleep 0.05; done'] })
    expect((await stream.next()).value).toEqual({ stream: 'stdout', text: 'ready\n' })
    const stopped = await stream.return()
    expect(stopped.done).toBe(true)
    expect((await stream.next()).done).toBe(true)
  })

  test('a timed-out program that ignores SIGTERM is killed, and the run rejects by its deadline', async () => {
    const started = Date.now()
    await expect(run(['sh', '-c', 'trap "" TERM; while :; do sleep 0.05; done'], { timeoutMs: 200 })).rejects.toThrow(
      'timed out after 200 ms',
    )
    expect(Date.now() - started).toBeLessThan(200 + KILL_GRACE_MS + 1_000)
  })

  test('a run whose output a lingering descendant holds open still ends at its deadline', async () => {
    const started = Date.now()
    await expect(run(['sh', '-c', 'sleep 5 & echo started'], { timeoutMs: 200 })).rejects.toThrow('timed out')
    expect(Date.now() - started).toBeLessThan(200 + KILL_GRACE_MS + 1_000)
  })

  test('a run that finishes in time resolves once with its output', async () => {
    expect(await run(['sh', '-c', 'printf out; printf err >&2; exit 4'], { timeoutMs: 5_000 })).toEqual({
      stdout: 'out',
      stderr: 'err',
      exitCode: 4,
      isStdoutTruncated: false,
      isStderrTruncated: false,
    })
  })

  test('stopping a stream ends a pending read at once, even when the program ignores SIGTERM', async () => {
    const stream = spawn({ argv: ['sh', '-c', 'trap "" TERM; echo ready; while :; do sleep 0.05; done'] })
    expect((await stream.next()).value).toEqual({ stream: 'stdout', text: 'ready\n' })
    const pending = stream.next()
    const started = Date.now()
    const stopped = stream.return()
    expect((await pending).done).toBe(true)
    expect(Date.now() - started).toBeLessThan(500)
    // The program is killed once its grace has passed, so the stop reports its real exit.
    expect((await stopped).value).toEqual({ code: null, signal: 'SIGKILL' })
    expect(Date.now() - started).toBeLessThan(KILL_GRACE_MS + 1_000)
    expect((await stream.next()).done).toBe(true)
  })
})
