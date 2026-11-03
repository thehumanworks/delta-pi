import { describe, expect, test } from 'vitest'
import { readCommandStream } from '../src/cli/command-reader.ts'
import { DeltaCommandError } from '../src/cli/thread-commands.ts'

describe('command reader', () => {
  test('a status timeout closes its child without waiting for output', async () => {
    let expire!: () => void
    let finish!: (value: any) => void
    const pending = new Promise<any>((resolve) => {
      finish = resolve
    })
    let closed = false
    const result = readCommandStream(
      {
        next: () => pending,
        return: async (value: { code: number | null; signal: string | null }) => {
          closed = true
          finish({ done: true, value })
          return { done: true, value }
        },
      },
      'thread status',
      new AbortController().signal,
      (milliseconds) => {
        expect(milliseconds).toBe(120_000)
        return new Promise<void>((resolve) => {
          expire = resolve
        })
      },
    )
    expect(closed).toBe(false)
    expire()
    try {
      await result
      throw new Error('Expected timeout')
    } catch (error) {
      expect(error).toBeInstanceOf(DeltaCommandError)
      expect((error as DeltaCommandError).code).toBe('timeout')
    }
    expect(closed).toBe(true)
  })
})
