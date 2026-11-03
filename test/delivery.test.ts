import { expect, test } from 'vitest'
import { turnStopReason } from '../src/recording/delivery.ts'

test('a turn ends normally only when its last reply stopped normally; an unnamed finish stays unspecified', () => {
  expect(turnStopReason(false, 'stop')).toBe('end_turn')
  expect(turnStopReason(true, 'stop')).toBe('cancelled')
  expect(turnStopReason(false, 'aborted')).toBe('cancelled')
  expect(turnStopReason(false, 'error')).toBe('error')
  for (const stop of ['length', 'toolUse', 'deferred', 'pending', undefined])
    expect(turnStopReason(false, stop)).toBeUndefined()
})
