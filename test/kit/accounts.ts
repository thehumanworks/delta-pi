/**
 * What the sign-in, setup and team tests stand in for and read: the Delta CLI the extension finds or
 * installs, the person's answers to its dialogs, and what the person sees and the browser opens.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { RunResult } from '../../src/core/process.ts'
import type { Kit } from './index.ts'
import type { Dialog } from './pi.ts'

/** The CLI the extension selects when the tests stand in for finding it: not on PATH, so only selection names it. */
export const SELECTED = '/selected/delta'

const result = (stdout: string, exitCode = 0): RunResult => ({
  stdout,
  stderr: '',
  exitCode,
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

/**
 * Stand in for finding Delta, and for its installer: the extension finds {@link SELECTED}, or, with
 * `missing`, finds nothing until it installs Delta. `hold` pauses the installer until `release`.
 */
export function deltaAt(kit: Kit, options: { missing?: boolean; hold?: boolean } = {}) {
  let installed = !options.missing
  let release: () => void = () => {}
  const paused = options.hold ? new Promise<void>((resolve) => (release = resolve)) : undefined
  const cli = { installs: 0, release: () => release() }
  kit.programs.set('sh', async (argv) => {
    // The installer's script finds an existing Delta first, so it is told apart by what it downloads.
    if (argv[2]?.includes('install.sh')) {
      cli.installs++
      await paused
      installed = true
      return result(`${SELECTED}\n`)
    }
    // Discovery exits 3 when no Delta is installed.
    return installed ? result(`${SELECTED}\n`) : result('', 3)
  })
  return cli
}

/** Answer each dialog whose title includes a key with that key's answer, in the keys' order, and dismiss any other. */
export function answering(answers: Record<string, string | ((dialog: Dialog) => string | undefined)>) {
  return (dialog: Dialog) => {
    const answer = Object.entries(answers).find(([title]) => dialog.title.includes(title))?.[1]
    return typeof answer === 'function' ? answer(dialog) : answer
  }
}

/** The answer to `/delta share`'s question that shares with the organization, whatever it is called. */
export const SHARE_WITH_TEAM = (dialog: Dialog) => dialog.options?.find((option) => option.startsWith('Share with'))

/** The setup offer's question, which every session in a repository not set up opens first. */
export const SETUP_OFFER = 'Set it up now?'

/** What the person was told: notes in pi's transcript, and notifications an RPC client shows. */
export function notes(kit: Kit): string[] {
  const transcript = kit.pi.session.entries.flatMap((entry) =>
    entry.type === 'custom' && entry.customType === 'delta-note' ? [(entry.data as { text: string }).text] : [],
  )
  return [...transcript, ...kit.pi.noticeTexts().filter((text) => !transcript.includes(text))]
}

/** The `auth` commands sign-in ran, which it reads as they stream, without the program. */
export function signIns(kit: Kit): string[][] {
  return kit
    .runs()
    .filter((run) => run.spawned && run.argv.includes('auth'))
    .map((run) => run.argv.slice(run.argv.indexOf('auth')))
}

/** Whether sign-in is waiting on the browser: its `auth wait` still runs. */
export function waitingOnBrowser(kit: Kit): boolean {
  return kit.running().some((args) => args[0] === 'auth' && args[1] === 'wait')
}

/** The links the extension opened in the browser. */
export function opened(kit: Kit): string[] {
  return kit
    .others()
    .filter((argv) => ['xdg-open', 'open', 'rundll32'].includes(basename(argv[0] ?? '')))
    .map((argv) => argv.at(-1)!)
}

/** Whether the extension ran a delta command starting with `command`, such as `thread create`. */
export function ran(kit: Kit, command: string): boolean {
  return kit.commands().some((args) => args.join(' ').startsWith(command))
}

/** The repository's Delta settings file. */
export function policyFile(kit: Kit): string {
  return join(kit.world.checkout, '.delta', 'settings.json')
}

/**
 * The repository's saved Delta settings, or undefined while none are saved, including while a write is
 * still under way: settings are written in place, so a read meanwhile can find them partly written.
 */
export function savedPolicy(kit: Kit): unknown {
  const path = policyFile(kit)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

/**
 * Mark the repository as already offered setup, as a session after the first one finds it, so the offer
 * stays out of a test's way.
 */
export async function offeredSetup(kit: Kit) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: kit.world.checkout }).toString().trim()
  await kit.store.set(`setup-offered:${root}/.git`, true)
}

/** The extension's debug log, where a note for a session that already ended goes. */
export function debugLog(kit: Kit): string {
  const path = join(kit.world.agentDir, 'delta', 'debug.log')
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/** The band's text: the widget pi's terminal draws, or the status line a client without it shows. */
export function band(kit: Kit): string {
  return kit.pi.mode === 'tui' ? kit.pi.widget('delta').join('\n') : (kit.pi.statuses.get('delta') ?? '')
}
