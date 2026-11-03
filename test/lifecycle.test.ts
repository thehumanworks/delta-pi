// What a thread's status and mounts allow a join to do, and when a prompt waits for a share or join:
// ported from the upstream plugin's hooks/sharing/lifecycle.test.ts.
import { expect, test } from 'vitest'
import type { MountedThread, ThreadMount, ThreadState } from '../src/cli/thread-commands.ts'
import { joinPreflight, promptGate, worktreeChanges } from '../src/sharing/lifecycle.ts'
import { cliFixture } from './cli-fixtures.ts'

test('join preflight refuses empty worktrees and unauthenticated access before clearing', () => {
  const status = cliFixture('status') as ThreadState
  expect(joinPreflight(status)).toBe('empty')
  expect(joinPreflight({ ...status, access: { state: 'local_only', is_owner: null } })).toBe('access')
})

test('pending share and join operations hold prompts until the operation ends', () => {
  expect(promptGate({ joining: true })).toBe('joining')
  expect(promptGate({ sharing: true })).toBe('sharing')
  expect(promptGate({})).toBeUndefined()
})

test('worktree changes name additions and removals, moving out of a checkout only once', () => {
  const delta: ThreadMount = { reference: 'delta', name: 'delta', directory: '/checkout/delta', state: 'mounted' }
  const zed: ThreadMount = { reference: 'zed', name: 'zed', directory: '/checkout/zed', state: 'mounted' }
  const web: ThreadMount = { reference: 'web', name: 'web', directory: '/checkout/web', state: 'mounted' }
  for (const [previous, directory, next, added, removed, moves] of [
    [[delta], '/checkout/delta', [delta, zed], ['zed'], [], true],
    [[delta, zed], '/folder', [delta, zed, web], ['web'], [], false],
    [[delta, zed, web], '/folder', [delta, web], [], ['zed'], false],
    [[delta, web], '/folder', [delta], [], ['web'], false],
  ] as const) {
    const result = worktreeChanges(previous, directory, {
      ...cliFixture('mount'),
      directory: '/folder',
      worktrees: [...next],
    } as MountedThread)
    expect(result.added.map((tree) => tree.name)).toEqual([...added])
    expect(result.removed.map((tree) => tree.name)).toEqual([...removed])
    expect(result.moves).toBe(moves)
  }
  const mount = { ...delta, directory: String.raw`C:\checkout\delta` }
  expect(
    worktreeChanges([mount], 'C:/checkout/delta', {
      ...cliFixture('mount'),
      directory: mount.directory,
      worktrees: [mount],
    } as MountedThread),
  ).toEqual({ added: [], removed: [], moves: false })
  expect(
    worktreeChanges([mount], 'C:/checkout/delta', {
      ...cliFixture('mount'),
      directory: 'C:/folder',
      worktrees: [mount],
    } as MountedThread),
  ).toEqual({ added: [], removed: [], moves: true })
})
