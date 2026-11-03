import { expect, test, vi } from 'vitest'

test("an installer's claim holds across session runtimes, which load their own copy of the module", async () => {
  vi.resetModules()
  const before = await import('../src/core/installation.ts')
  const release = before.claimInstallation('plugin')
  expect(release).toBeDefined()
  // pi evaluates the extension's modules afresh for the next session; the installer is still running.
  vi.resetModules()
  const after = await import('../src/core/installation.ts')
  expect(after).not.toBe(before)
  expect(after.installation()).toEqual({ kind: 'plugin' })
  expect(after.claimInstallation('app')).toBeUndefined()
  release!()
  expect(after.installation()).toBeUndefined()
  after.claimInstallation('app')?.()
})
