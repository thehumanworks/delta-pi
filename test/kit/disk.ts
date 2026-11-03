/**
 * The disk as the extension's own files reach it (src/core/files.ts), with faults a test asks for: a
 * write that fails, as a full or failing disk does, or one held until the test releases it. The
 * behaviour tests' setup (./setup.ts) puts these functions in place of the real ones, so every store,
 * outbox and settings file the extension touches goes through them.
 *
 *   const release = delta.disk.hold('write', /outbox/)
 *   delta.disk.fail('write', (path) => path.includes('store'), { times: 1 })
 */
import type * as Files from '../../src/core/files.ts'

/** What the extension does to a file: each of files.ts's operations is one of these. */
export type DiskOperation = 'read' | 'write' | 'remove' | 'list'
/**
 * Which paths a fault applies to: those containing a text, matching a pattern, or a test's choice,
 * which for a write also sees the text being written.
 */
export type PathMatch = string | RegExp | ((path: string, text?: string) => boolean)

type Fault = {
  operation: DiskOperation
  match: PathMatch
  /** Runs to let through before the fault applies. */
  after: number
  /** Runs left that fail; held runs are not counted. */
  times: number
  error?: Error
  /** Resolves when a held run may go on. */
  held?: Promise<void>
}

// Shared through globalThis: pi loads a fresh copy of the extension, and so of this module, per session.
const registry = Symbol.for('pi-delta.test.disk')
type Registry = { faults: Fault[]; touched: { operation: DiskOperation; path: string }[] }
function state(): Registry {
  const global = globalThis as unknown as Record<symbol, Registry | undefined>
  return (global[registry] ??= { faults: [], touched: [] })
}

const matches = (match: PathMatch, path: string, text?: string) =>
  typeof match === 'string' ? path.includes(match) : match instanceof RegExp ? match.test(path) : match(path, text)

/** Apply the faults the test set for this run of `operation` on `path`. */
async function check(operation: DiskOperation, path: string, text?: string) {
  const { faults, touched } = state()
  touched.push({ operation, path })
  for (const fault of [...faults]) {
    if (fault.operation !== operation || !matches(fault.match, path, text)) continue
    if (fault.after > 0) {
      fault.after--
      continue
    }
    if (fault.held) {
      await fault.held
      continue
    }
    if (--fault.times <= 0) faults.splice(faults.indexOf(fault), 1)
    throw (
      fault.error ??
      Object.assign(new Error(`ENOSPC: no space left on device, ${operation} '${path}'`), { code: 'ENOSPC' })
    )
  }
}

/** The kit's handle on the disk: set faults, and see what the extension touched. */
export const disk = {
  /** Make the next `times` runs of `operation` on matching paths, after `after` of them, fail. */
  fail(
    operation: DiskOperation,
    match: PathMatch,
    { times = 1, after = 0, error }: { times?: number; after?: number; error?: Error } = {},
  ) {
    const fault: Fault = { operation, match, after, times, ...(error ? { error } : {}) }
    state().faults.push(fault)
    return () => void state().faults.splice(state().faults.indexOf(fault), 1)
  },
  /** Hold runs of `operation` on matching paths, after `after` of them, until the returned function. */
  hold(operation: DiskOperation, match: PathMatch, { after = 0 } = {}): () => void {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const fault: Fault = { operation, match, after, times: Infinity, held }
    state().faults.push(fault)
    return () => {
      const { faults } = state()
      if (faults.includes(fault)) faults.splice(faults.indexOf(fault), 1)
      release()
    }
  },
  /** The paths the extension touched with `operation`, in order. */
  touched(operation?: DiskOperation): string[] {
    return state()
      .touched.filter((entry) => !operation || entry.operation === operation)
      .map((entry) => entry.path)
  },
  /** Forget every fault and what was touched, as each test starts. */
  reset() {
    const current = state()
    current.faults.length = 0
    current.touched.length = 0
  },
}

/** files.ts's functions, `real`, each checking the test's faults first. */
export function faultyFiles(real: typeof Files): typeof Files {
  return {
    exists: async (path) => (await check('read', path), real.exists(path)),
    readText: async (path) => (await check('read', path), real.readText(path)),
    readIfExists: async (path) => (await check('read', path), real.readIfExists(path)),
    writePrivate: async (path, text) => (await check('write', path, text), real.writePrivate(path, text)),
    writeExclusive: async (path, text) => (await check('write', path, text), real.writeExclusive(path, text)),
    writeShared: async (path, text) => (await check('write', path, text), real.writeShared(path, text)),
    list: async (path) => (await check('list', path), real.list(path)),
    size: async (path) => (await check('read', path), real.size(path)),
    remove: async (path) => (await check('remove', path), real.remove(path)),
  }
}
