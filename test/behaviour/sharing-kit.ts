/**
 * What the share behaviour tests (sharing.test.ts, lifecycle.test.ts) share: a checkout that records only
 * what `/delta share` shares, running a share to its outcome as upstream's `fake.share($)` does, restarting
 * pi on the same session, and reading what was staged, exported and set up.
 */
import { existsSync } from 'node:fs'
import { type Kit, startDelta } from '../kit/index.ts'
import type { Dialog } from '../kit/pi.ts'
import { world, type World } from '../world.ts'

/** A checkout set to record only what `/delta share` shares, so no setup offer opens. */
export const MANUAL = { mode: 'manual' }

/**
 * The person's answer to `/delta share`'s question: share with the team, or, once the thread is
 * published to it, keep its sharing.
 */
export function shareAnswer(dialog: Dialog): string | undefined {
  if (!dialog.title.includes('Who should see this session?')) return undefined
  return (
    dialog.options?.find((option) => option.startsWith('Share with')) ??
    dialog.options?.find((option) => option.startsWith('Keep current sharing'))
  )
}

/** A success note names the link the share published, which this captures. */
const SHARED = /^Delta: .+ · (https:\S+)$/

/**
 * Run `/delta share` and wait for its outcome: the link it published, or what it said instead, such as
 * its failure or a refusal before it started.
 */
export async function share(kit: Kit, args = 'share'): Promise<string> {
  const { pi } = kit
  const before = pi.notices.length
  pi.answers.push(shareAnswer)
  const said = () => pi.notices.slice(before).map((notice) => notice.text)
  try {
    await pi.command('delta', args)
    // What the command answered at once is a refusal before the share started.
    const refusal = said().find((text) => !SHARED.test(text) && !text.startsWith('Delta will share'))
    if (refusal) return refusal
    const outcome = await kit.until(
      () =>
        said().find(
          (text) =>
            SHARED.test(text) || text.startsWith('Delta sharing failed') || text.startsWith("Delta didn't share"),
        ),
      'the share to finish',
    )
    return SHARED.exec(outcome)?.[1] ?? outcome
  } finally {
    // A share that ended before its question leaves the answer for the next one.
    const left = pi.answers.indexOf(shareAnswer)
    if (left >= 0) pi.answers.splice(left, 1)
  }
}

/** A world whose checkout records only what is shared; tests start kits in it and remove it once done. */
export function manualWorld(): World {
  return world({ policy: MANUAL })
}

/** End `kit`'s pi as quitting does, and resume its session in a new pi process on the same machine. */
export async function restart(kit: Kit): Promise<Kit> {
  await kit.stop()
  return startDelta({ world: kit.world, session: kit.pi.session })
}

/** The session's saved binding, as the store holds it. */
export async function binding(kit: Kit): Promise<any> {
  return kit.store.get(`session:${kit.pi.session.id}`)
}

/** The sequences the session's binding has staged and not yet seen acknowledged, each with its files on disk. */
export async function staged(kit: Kit): Promise<number[]> {
  const pending: { sequence: number; files: string[] }[] = (await binding(kit))?.pending ?? []
  for (const entry of pending) for (const file of entry.files) if (!existsSync(file)) throw new Error(`${file} is gone`)
  return pending.map((entry) => entry.sequence)
}

/** The records the session's thread holds. */
export function records(kit: Kit): any[] {
  return kit.thread()?.records ?? []
}

/** How many times the session's conversation was exported: each export stages its first record anew. */
export function exports(kit: Kit): number {
  const first = `/outbox/${kit.pi.session.id}/1-0.json`
  return kit.disk.touched('write').filter((path) => path.endsWith(first)).length
}

/** The setup commands, which a share runs and nothing else may: creation, attachment and publication. */
export function setupCommands(kit: Kit, since = 0): string[] {
  return kit
    .commands()
    .slice(since)
    .map((args) => args.slice(0, 2).join(' '))
    .filter((command) => ['thread create', 'worktree attach', 'thread share'].includes(command))
}

/** The Delta commands the extension ran, by subcommand. */
export function ran(kit: Kit, since = 0): string[] {
  return kit
    .commands()
    .slice(since)
    .map((args) => args.slice(0, 2).join(' '))
}

/** The fake Delta's directories for the thread's worktrees, with whether each is mounted. */
export function checkouts(kit: Kit): { reference: string; directory: string; state: string }[] {
  const thread = kit.thread()
  return kit.world
    .delta()
    .worktrees.filter((tree) => thread?.worktrees.includes(tree.reference))
    .flatMap((tree) =>
      tree.directories.map((entry: any) => ({
        reference: tree.reference,
        directory: entry.directory,
        state: entry.state,
      })),
    )
}

/** A user message committed to the session outside any turn, as a transcript changed behind pi's back reads. */
export function addMessage(kit: Kit, text: string) {
  kit.pi.session.entries.push({
    type: 'message',
    id: Math.random().toString(16).slice(2, 10),
    parentId: kit.pi.session.entries.at(-1)?.id ?? null,
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() },
  })
}
