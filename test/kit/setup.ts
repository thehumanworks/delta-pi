// Set up for every behaviour test: the extension's files go through the kit's disk (./disk.ts), so a
// test can make a write fail or hold, and each test starts with no faults.
import { afterAll, afterEach, beforeEach, vi } from 'vitest'
import { disk, faultyFiles } from './disk.ts'
import { endKits } from './index.ts'
import { removeWorlds } from '../world.ts'

vi.mock('../../src/core/files.ts', async (importOriginal) => faultyFiles(await importOriginal()))

beforeEach(() => disk.reset())

// After the test's own cleanup, which a failure may have cut short: no kit's commands outlive it, and no
// world is left in the temporary folder.
afterEach(() => endKits())
// Work the last test left running, such as a note written to the debug log, has had a moment to end.
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 500))
  removeWorlds()
})
