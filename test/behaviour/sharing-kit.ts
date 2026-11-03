/**
 * What the share behaviour tests (sharing.test.ts, lifecycle.test.ts) share: a checkout that records only
 * what `/delta share` shares, running a share to its outcome as upstream's `fake.share($)` does, a Delta
 * CLI that is missing until a share installs it, and reading what was staged, exported and set up.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { RunResult } from '../../src/core/process.ts'
import type { Kit } from '../kit/index.ts'
import type { Dialog } from '../kit/pi.ts'
import { FAKE_BIN, world, type World } from '../world.ts'

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

/** How many times a session's conversation was exported: each export stages its first record anew. */
export function exports(kit: Kit, session = kit.pi.session.id): number {
  const first = `/outbox/${session}/1-0.json`
  return kit.disk.touched('write').filter((path) => path.endsWith(first)).length
}

/** A Delta error envelope, as a command whose work was done and whose answer was lost prints it. */
export function lost(message: string, code = 'app_unavailable', retryable = true): string {
  return `${JSON.stringify({ error: { code, reason: code, message, retryable } })}\n`
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

/**
 * Make the Delta CLI missing until a share or join installs it, by standing in for the shell that runs
 * Delta's discovery and installer scripts (src/cli/cli.ts). `setups` lists the discoveries and
 * installations a share or join ran, without the startup update check's own discovery; `install`, when
 * set, holds the installer until it resolves.
 */
export function missingCli(kit: Kit) {
  const cli = {
    missing: true,
    setups: [] as ('discover' | 'install')[],
    install: undefined as Promise<void> | undefined,
  }
  const answer = (stdout: string, exitCode: number): RunResult => ({
    stdout,
    stderr: '',
    exitCode,
    isStdoutTruncated: false,
    isStderrTruncated: false,
  })
  const found = () => answer(`${join(FAKE_BIN, 'delta')}\n`, 0)
  kit.programs.set('sh', async (argv, init) => {
    const script = argv[2] ?? ''
    if (!script.includes('command -v delta')) return undefined
    const install = script.includes('--non-interactive')
    // The update check discovers on a private, short budget, and never installs.
    if (!install && init.timeoutMs === 5_000) return cli.missing ? answer('', 3) : found()
    cli.setups.push(install ? 'install' : 'discover')
    if (!install) return cli.missing ? answer('', 3) : found()
    await cli.install
    cli.missing = false
    return found()
  })
  return cli
}

/**
 * Make `worktree list` name no worktree, as Delta lists only the checkouts it syncs: a retry can then
 * find the local worktree identity an earlier attempt created only where it saved it.
 */
export function unlisted(kit: Kit) {
  kit.world.answer('worktree list', { patch: { worktrees: [] } }, { times: 1000 })
}
