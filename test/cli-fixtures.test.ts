// Ported from the Claude Code plugin's hooks/testing/cli-fixtures.test.ts: the extension's parsers read
// the Delta CLI's own published output, and decide each published error code as the CLI does.
import { expect, test } from 'vitest'
import {
  classifyCommandFailure,
  commandErrorFromEnvelope,
  DeltaCommandError,
  parseAppendReceipt,
  parseThreadMount,
  parseThreadStatus,
  parseWatchEvent,
} from '../src/cli/thread-commands.ts'
import { cliErrorCodes, cliFixture, cliFixtureData, cliWatchFrames } from './cli-fixtures.ts'

test('documented status, mount, append receipts, and watch frames parse at the CLI boundary', () => {
  for (const name of ['thread-status.local_only', 'thread-status.granted', 'thread-status.worktrees_unavailable'])
    expect(parseThreadStatus(JSON.stringify(cliFixtureData[name])).worktrees.status).toBe(
      cliFixtureData[name].worktrees.status,
    )
  const status = cliFixture('status')
  expect(parseThreadStatus(JSON.stringify(status)).thread_id).toBe(status.thread_id)
  const mount = cliFixture('mount')
  expect(parseThreadMount(JSON.stringify(mount), mount.owner).worktrees).toHaveLength(1)
  for (const name of ['recorded', 'fenced', 'duplicate'] as const) {
    const receipt = cliFixture(name)
    expect(parseAppendReceipt(JSON.stringify(receipt), receipt.thread_id, receipt.sequence).disposition).toBe(name)
  }
  for (const frame of cliWatchFrames) expect(parseWatchEvent(JSON.stringify(frame))?.type).toBe(frame.type ?? 'error')
  const error = parseWatchEvent(JSON.stringify(cliFixture('error')))
  expect(error?.type).toBe('error')
  if (error?.type === 'error') expect(error.error.code).toBe('watch_reset')
  const patched = cliFixture('status', { thread_id: 'other' })
  expect(patched.thread_id).toBe('other')
  expect(cliFixture('status').thread_id).not.toBe('other')
})

test('every published code is decided by its envelope, and pinned retryability agrees', () => {
  for (const [code, hints] of Object.entries<{ retryable?: boolean; retry_after_ms?: number }>(cliErrorCodes)) {
    const parsed = commandErrorFromEnvelope({ code, message: 'example', ...hints })
    expect(parsed?.code).toBe(code)
    expect(parsed?.hints.retryable).toBe(hints.retryable)
    if (hints.retry_after_ms !== undefined) expect(parsed?.hints.retryAfterMs).toBe(hints.retry_after_ms)
    // Where every cause agrees, the pinned class says how the CLI will classify this code.
    if (hints.retryable !== undefined)
      expect(classifyCommandFailure(parsed!)).toBe(hints.retryable ? 'transient' : 'permanent')
    // Codes whose retryability varies (`{}`) still follow whatever the envelope carries.
    for (const retryable of [true, false])
      expect(classifyCommandFailure(new DeltaCommandError(code, 'example', { retryable }))).toBe(
        retryable ? 'transient' : 'permanent',
      )
  }
})
