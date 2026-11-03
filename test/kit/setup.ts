// Set up for every behaviour test: the extension's files go through the kit's disk (./disk.ts), so a
// test can make a write fail or hold, and each test starts with no faults.
import { beforeEach, vi } from 'vitest'
import { disk, faultyFiles } from './disk.ts'

vi.mock('../../src/core/files.ts', async (importOriginal) => faultyFiles(await importOriginal()))

beforeEach(() => disk.reset())
