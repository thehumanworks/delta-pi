// What the recording tests share: a session that records, what reached its thread, and records seeded
// into its outbox as an earlier pi process would have left them.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { digest } from '../../src/core/session-state.ts'
import { type Kit, startDelta } from '../kit/index.ts'

export const PRIVATE = { mode: 'private', organization: 'org-1' }

/** A session in a repository that syncs privately, once it watches its thread. */
export async function recording(options: Parameters<typeof startDelta>[0] = {}) {
  const kit = await startDelta({ policy: PRIVATE, ...options })
  await kit.until(() => kit.commands().some((args) => args.includes('watch')), 'the thread watch to start')
  return kit
}

/** Every record the fake Delta accepted from this session's producer, in order. */
export const records = (kit: Kit): any[] => kit.thread()?.records ?? []
export const delivered = (kit: Kit, text: string) => JSON.stringify(records(kit)).includes(text)
/** The sequences of the turns whose start, or finish, reached the thread. */
export const starts = (kit: Kit): number[] =>
  records(kit).flatMap((record) => (record.update.state === 'running' ? [record.sequence] : []))
export const finishes = (kit: Kit): number[] =>
  records(kit).flatMap((record) => (record.update.state === 'idle' ? [record.turnSequence] : []))
export const appends = (kit: Kit) =>
  kit.commands().filter((args) => args[0] === 'thread' && args[1] === 'append').length
export const watches = (kit: Kit) => kit.commands().filter((args) => args[0] === 'thread' && args[1] === 'watch').length

/** The session's binding in the store. */
export const binding = async (kit: Kit): Promise<any> => kit.store.get(`session:${kit.pi.session.id}`)

/** The records staged in the session's outbox, as written. */
export async function staged(kit: Kit): Promise<any[]> {
  const { readFileSync } = await import('node:fs')
  return ((await binding(kit))?.pending ?? []).map((entry: { files: string[] }) =>
    JSON.parse(entry.files.map((file) => readFileSync(file, 'utf8')).join('')),
  )
}

/**
 * Stage `lines` in the session's outbox after what it already holds, as a pi process that ended before
 * delivering them would have, and save the binding with `fields` (such as an open `execution`).
 */
export async function seedPending(kit: Kit, lines: (object | string)[], fields: Record<string, unknown> = {}) {
  const session = kit.pi.session.id
  const saved = (await binding(kit)) ?? { session, snapshot: true, next: 1, pending: [] }
  const folder = join(kit.world.agentDir, 'delta', 'outbox', session)
  mkdirSync(folder, { recursive: true })
  const pending = [...saved.pending]
  let next = saved.next
  for (const value of lines) {
    const line = typeof value === 'string' ? value : `${JSON.stringify(value)}\n`
    const file = join(folder, `${next}-0.json`)
    writeFileSync(file, line, { mode: 0o600 })
    pending.push({ sequence: next, files: [file], digest: await digest(line) })
    next++
  }
  await kit.store.set(`session:${session}`, { ...saved, next, pending, ...fields })
}

/** End the session as quitting pi does, and start it again in a new runtime, as resuming it does. */
export async function restart(kit: Kit) {
  await kit.whileTimePasses(kit.pi.shutdown('quit'))
  await kit.pi.start('resume')
}
