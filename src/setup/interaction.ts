/**
 * What the setup wizard, sign-in and onboarding need from the session: pi's question dialogs, the
 * browser, and the host bindings they run against.
 */
import { readIfExists, writeShared } from '../core/files.ts'
import { type Host, InteractionUnavailableError } from '../core/host.ts'
import { activation, stateFor, stillActive } from '../core/session-state.ts'
import { errorText } from '../core/text.ts'
import { type AuthenticationHost, type BrowserWait, requireAuthentication } from '../cli/auth.ts'
import { authStatus, INTEGRATION_ENV, orgInvite, resolveCli, threadContract } from '../cli/delta-cli.ts'
import { clearProgress, type Progress, reportedProgress, setProgress } from '../band/band.ts'
import { beginShare, checkoutRoot, gitRemotes, sessionSyncs } from '../sharing/share.ts'
import { createOrganization, listOrganizations } from './organizations.ts'
import { type AskOptions, type Interaction, InteractionDismissedError, type SetupEnv } from './setup.ts'

/** The sign-in waiting on the person's browser, which running a Delta command again offers to stop. */
let browserWait: { on: BrowserWait; stop: AbortController } | undefined

/** Sign-in's view of the session. */
export function authenticationHost(host: Host): AuthenticationHost {
  const stop = new AbortController()
  let progress: Progress | undefined
  return {
    windows: host.env.windows(),
    sleep: (milliseconds, signal) => host.clock.sleep(milliseconds, { signal }),
    spawn: (argv) => host.process.spawn({ argv, env: { ...INTEGRATION_ENV } }),
    ask: (question, options) => interaction(host).ask(question, { options, header: 'Delta' }),
    open: (url) => host.ui.open(url),
    waiting: (waitingFor) => {
      if (waitingFor) {
        browserWait = { on: waitingFor, stop }
        setProgress(
          host,
          waitingFor === 'terms' ? "Waiting for Delta's beta terms…" : 'Waiting for Delta sign-in…',
          'active',
        )
        progress = reportedProgress()
        return
      }
      if (browserWait?.stop === stop) browserWait = undefined
      // What follows sets its own progress; a band still showing the wait would outlive it.
      if (progress && reportedProgress() === progress) clearProgress(host)
    },
    stop: stop.signal,
  }
}

/**
 * Offer to stop a sign-in waiting on the browser, answering whether one was waiting. Whatever waited
 * reports the outcome itself, so the command that asked adds nothing of its own.
 */
export async function offerToStopWaiting(host: Host): Promise<boolean> {
  const wait = browserWait
  if (!wait) return false
  const stop = 'Stop waiting'
  const answer = await interaction(host)
    .ask(
      wait.on === 'terms'
        ? 'Delta is waiting for you to accept its beta terms in your browser. Stop waiting?'
        : 'Delta is waiting for you to finish signing in with your browser. Stop waiting?',
      { options: [stop, 'Keep waiting'], header: 'Delta' },
    )
    .catch(() => undefined)
  if (answer === stop) wait.stop.abort()
  return true
}

/** The host bindings the setup wizard and onboarding run against. */
export function setupEnv(host: Host): SetupEnv {
  const session = activation.session
  const active = stillActive(session)
  const check = async () => {
    if (!active() || host.session.id() !== session)
      throw new Error('The pi session changed during setup; the obsolete setup was stopped')
  }
  return {
    checkoutRoot: async () => {
      await check()
      return checkoutRoot(host)
    },
    // Linked worktrees share the common directory, so they share one onboarding marker. Git before
    // 2.31 has no `--path-format`, so the directory is resolved against the checkout root instead.
    gitCommonDir: async () => {
      try {
        const root = await checkoutRoot(host)
        const result = await host.process.run(['git', 'rev-parse', '--git-common-dir'], { cwd: root })
        if (result.exitCode !== 0 || result.isStdoutTruncated) return undefined
        const lines = result.stdout.trim().split('\n')
        if (lines.length !== 1 || !lines[0]) return undefined
        return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(lines[0]) ? lines[0] : `${root}/${lines[0]}`
      } catch {
        return undefined
      }
    },
    remotes: async () => gitRemotes(host, await checkoutRoot(host)),
    openLink: (url) => host.ui.open(url),
    contract: async () => {
      let progress: Progress | undefined
      try {
        await check()
        await resolveCli(host, (text) => {
          setProgress(host, text, 'active')
          progress = reportedProgress()
        })
        await check()
        const contract = await threadContract(host)
        await check()
        return contract
      } finally {
        if (progress && reportedProgress() === progress) clearProgress(host)
      }
    },
    authenticate: async (notice) => {
      await requireAuthentication(authenticationHost(host), await resolveCli(host), check, notice, '/delta-setup')
      await check()
    },
    organizations: () => listOrganizations(host),
    login: async () => (await authStatus(host)).login,
    createOrganization: (name) => createOrganization(host, name),
    inviteMembers: (organization, emails) => orgInvite(host, organization, emails),
    readFile: (path) => readIfExists(path),
    writeFile: (path, text) => writeShared(path, text),
    // A joined thread is someone else's shared thread; an organization or unlisted one is already
    // visible beyond this account.
    sessionAudience: async () => {
      const binding = stateFor(host.session.id()).binding
      if (binding?.joined || (binding?.visibility && binding.visibility !== 'private')) return 'shared'
      return sessionSyncs(binding) ? 'private' : 'none'
    },
    shareSession: async (audience) => beginShare(host, { session: host.session.id(), audience: { kind: audience } }),
  }
}

/** `Array.isArray` does not narrow a readonly array out of a union, so `AskOptions` needs its own guard. */
function isOptionList(options: AskOptions): options is readonly string[] {
  return Array.isArray(options)
}

/** The interactive surface the wizard speaks through: pi's dialogs, where the session has them. */
export function interaction(host: Host): Interaction {
  return {
    async ask(question, options) {
      const request = isOptionList(options) ? { options } : options
      let answer: string | undefined
      try {
        answer = await host.ui.ask(question, request)
      } catch (error) {
        if (error instanceof InteractionUnavailableError) throw error
        throw new InteractionDismissedError(errorText(error))
      }
      if (answer === undefined || answer === '') throw new InteractionDismissedError('dismissed')
      return answer
    },
    log: async (text, to) => {
      if (to === 'debug') host.ui.debug(text)
      else host.ui.note(text)
    },
  }
}

/** Show a note in the transcript at most once per runtime. */
const noticesShown = new Set<string>()
export function notifyOnce(host: Host, text: string) {
  if (noticesShown.has(text)) return
  noticesShown.add(text)
  host.ui.note(text, 'warning')
}
