/**
 * Starting a session's recording: activating its binding, finishing a join that switched into this
 * session, the setup offer, automatic recording from the repository's policy, and pruning.
 */
import { join } from 'node:path'
import type { Host } from '../core/host.ts'
import {
  activation,
  type AutoUpload,
  type Binding,
  boundDirectory,
  isPaused,
  key,
  ledgerKey,
  load,
  pauseCheckout,
  report,
  requests,
  resumeCheckout,
  save,
  serial,
  sessions,
  type SessionState,
  stateFor,
  stillActive,
  storedBinding,
} from '../core/session-state.ts'
import { errorText } from '../core/text.ts'
import { AccessRequiredError, requireAuthentication } from '../cli/auth.ts'
import { CONTRACT_TIMEOUT_MS, requireContract, resolveCli, threadCreate } from '../cli/delta-cli.ts'
import {
  classifyCommandFailure,
  ContractRefusalError,
  DeltaCommandError,
  permanentFailureAdvice,
} from '../cli/thread-commands.ts'
import { clearProgress, finishProgress, setProgress, type SyncReminder } from '../band/band.ts'
import {
  collectAcknowledgedOutbox,
  drain,
  endDeliveryFailures,
  recordFromStart,
  recordsOffline,
  recoverExecution,
  scheduleOutboxCleanup,
} from '../recording/delivery.ts'
import { attachWorktree, beginRestoreCheckout, checkoutNeedsMount, mountCheckout } from '../sharing/checkout.ts'
import { beginRestore, completeJoinTransition, startParticipation } from '../sharing/join.ts'
import { checkoutRoot, joinedBindingAt } from '../sharing/share.ts'
import {
  awaitParent,
  beginChild,
  childLink,
  exportParent,
  exportSession,
  recordedParent,
} from '../subagents/subagents.ts'
import { followUpload, startConversation, stopConversation } from '../watch/watch.ts'
import { authenticationHost, interaction, notifyOnce, setupEnv } from './interaction.ts'
import { listOrganizations, organizationName } from './organizations.ts'
import { policyPath, type ProjectPolicy, readProjectPolicy, recordsAutomatically } from './project-policy.ts'
import { offerOnboarding, type OnboardingStore, releaseOnboarding } from './setup.ts'

/** The extension's folder, shared by every pi process on the machine. */
export let pluginData = ''
/** Where recorded conversations stage their records, under the extension's folder. */
export let outbox = ''

export function useDataDirectory(directory: string) {
  pluginData = directory
  outbox = join(directory, 'outbox')
}

/** Automatic activation has not finished: the binding exposes its thread only once every step succeeded. */
export function activationIncomplete(runtime: SessionState): boolean {
  return !!runtime.binding?.autoUpload && !runtime.binding.thread
}

/**
 * A prompt or a resume is an automatic session's repair path: re-run whatever activation steps are
 * missing, using the upload the session already recorded. Every step is idempotent, so this is safe.
 */
export function retryAutomaticActivation(host: Host, session: string, runtime: SessionState) {
  const binding = runtime.binding
  // The activation reports its own failures in the band, and the next prompt retries it.
  if (binding?.autoUpload && !binding.thread && binding.checkout)
    void activateAutomatically(host, session, binding.checkout, binding.autoUpload).catch(() => {})
}

export async function activate(host: Host, session: string, isCurrent = () => true) {
  const epoch = ++activation.epoch
  const ownsActivation = () => epoch === activation.epoch && isCurrent()
  activation.activating = session
  try {
    if (activation.session !== session) await stopConversation()
    if (!ownsActivation()) return
    activation.session = session
    let binding = await serial(() => load(host, session))
    if (!ownsActivation()) return
    // A session that resumes is live again: drop the end marker so bounded cleanup never removes it.
    if (binding.endedAt !== undefined) {
      const live = { ...binding }
      delete live.endedAt
      await serial(() => save(host, live))
      binding = live
    }
    const runtime = stateFor(session)
    runtime.binding = binding
    runtime.captureFailure ??= binding.captureFailure
    // A session a join switched into finishes joining before its first prompt, which waits for it.
    const transition = binding.joinTransition
    if (transition) {
      runtime.joining ??= completeJoinTransition(host, session, transition, ownsActivation).finally(() => {
        runtime.joining = undefined
      })
      return
    }
    endDeliveryFailures(runtime)
    scheduleOutboxCleanup(host, binding)
    // Bounded store retention: entries for sessions that ended long ago are pruned only when they
    // hold nothing a later session would need. It never blocks activation.
    void pruneStore(host).catch(() => {})
    // An automatic session whose activation never finished, for example because Delta was unreachable
    // when it started, resumes that activation rather than waiting for a thread it does not have yet.
    if (activationIncomplete(runtime)) {
      retryAutomaticActivation(host, session, runtime)
      return
    }
    if (binding.child) {
      // A subagent records offline into its own thread, created once its first prompt is staged.
      try {
        await requireContract(host, session)
      } catch (error) {
        if (ownsActivation()) report(host, error)
        return
      }
      // The subagents this one starts hang under it, even before its thread exists.
      if (ownsActivation()) exportParent(host, binding)
      // A subagent that ended with its turn open, as when its process was stopped, closes that turn;
      // delivering it mounts the subagent's own checkout again.
      if (ownsActivation()) await recoverExecution(host, session)
      if (ownsActivation() && binding.pending.length)
        void drain(host, session).catch((error: unknown) => report(host, error))
      return
    }
    // A shared session's own checkout stays synchronized only while a mount process runs for it.
    const needsCheckoutMount = checkoutNeedsMount(session, binding)
    if (binding.snapshot && boundDirectory(binding)) {
      pauseCheckout(runtime, 'watcher')
      try {
        await requireContract(host, session)
      } catch (error) {
        if (!ownsActivation()) return
        const text = `Delta participation is blocked: ${errorText(error)}`
        // Only an explicit /delta share or /delta join after updating Delta lifts this pause.
        pauseCheckout(runtime, 'delivery', text)
        runtime.joinFailure = text
        setProgress(host, text, 'error')
        host.ui.note(text, 'error')
        return
      }
      // A joined session whose mounts this runtime has not confirmed is resuming.
      if (binding.joined && !runtime.mounted) {
        beginRestore(host, session)
        return
      }
    }
    if (needsCheckoutMount) {
      beginRestoreCheckout(host, session)
      return
    }
    if (binding.snapshot && boundDirectory(binding)) {
      if (recordsOffline(session, binding)) {
        // Offline recording does not wait for the watcher: start it in the background and let a
        // prompt or the outbox proceed meanwhile.
        resumeCheckout(runtime, 'watcher')
        void startConversation(host, session).catch((error: unknown) => {
          if (ownsActivation()) report(host, error)
        })
      } else {
        try {
          await startParticipation(host, session, binding, ownsActivation)
        } catch (error) {
          if (ownsActivation()) report(host, error)
        }
      }
      // An automatic session follows Delta's background upload on its own timer, so the link appears
      // even when the watcher never becomes ready.
      if (ownsActivation() && binding.autoUpload) followUpload(host, session)
      if (ownsActivation() && !isPaused(runtime)) await recoverExecution(host, session)
    }
    if (ownsActivation() && !runtime.captureFailure && binding.thread && binding.pending.length)
      void drain(host, session).catch((error: unknown) => report(host, error))
    if (ownsActivation() && binding.thread && binding.snapshot) exportParent(host, binding)
  } finally {
    if (epoch === activation.epoch) activation.activating = ''
  }
}

/** Resume the recovery steps activation skipped while it waited for a mount. */
export async function finishRestoredActivation(host: Host, session: string, binding: Binding, owns: () => boolean) {
  const runtime = stateFor(session)
  if (binding.autoUpload) followUpload(host, session)
  if (!isPaused(runtime)) await recoverExecution(host, session)
  if (!owns()) return
  if (!runtime.captureFailure && binding.pending.length)
    void drain(host, session).catch((error: unknown) => report(host, error))
  if (binding.thread && binding.snapshot) exportParent(host, binding)
}

/**
 * A new session's capture boundary: prompts and turns wait on this until the policy and contract
 * decision is made. Before the decision the session holds no snapshot, so activity let through early
 * would go unrecorded; the promise resolves for every outcome, including a refusal, and the contract
 * check that bounds it is itself bounded by `CONTRACT_TIMEOUT_MS`.
 */
type CaptureDecision = { promise: Promise<void>; resolve: () => void }
const captureDecisions = new Map<string, CaptureDecision>()

/** Open the capture boundary for a session that is about to decide whether it records automatically. */
export function beginCaptureDecision(session: string) {
  if (captureDecisions.has(session)) return
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  captureDecisions.set(session, { promise, resolve })
}

/** Resolve the boundary once made, whatever the outcome; a second call is harmless. */
export function decideCapture(session: string) {
  captureDecisions.get(session)?.resolve()
  captureDecisions.delete(session)
}

/** Hold new-session activity until its capture boundary exists, or nothing when there is none. */
export async function captureDecided(session: string): Promise<void> {
  await captureDecisions.get(session)?.promise
}

/**
 * How the session started, for what it may do: only a new session, with no conversation yet, is
 * recorded automatically; one with history is offered setup and keeps whatever policy it had.
 */
let started: { session: string; fresh: boolean } | undefined

/** Whether the session began empty in this runtime: started, cleared with `/new`, or reloaded before its first prompt. */
export function newSessionFor(session: string): boolean {
  return started?.session === session && started.fresh
}

/**
 * Begin the session pi started this runtime for. A subagent of a recorded session records into a
 * thread under its parent's; anything else activates its binding, then offers or begins recording
 * off the startup path.
 */
export async function beginSession(host: Host, session: string) {
  const fresh = host.session.turns() === 0
  started = { session, fresh }
  const link = fresh ? await childLink(host, session).catch(() => undefined) : undefined
  if (link === 'stale') {
    // A link left in an environment that outlived its session, as a long-running worker's does,
    // records nothing: not as a subagent of an ended session, nor as a session of its own.
    host.ui.debug('This session was started by a Delta session that has ended, so Delta does not record it.')
    return
  }
  if (link?.parent) {
    try {
      await beginChild(host, session, { link: link.link, parent: link.parent })
      await activate(host, session)
    } catch (error) {
      report(host, error)
    }
    return
  }
  // A session started by one that does not record yet goes its own way meanwhile, and becomes that
  // one's subagent once it records (`recordUnderParent`).
  if (link) awaitParent(link.link)
  exportSession(host, session)
  const stored = await serial(() => load(host, session)).catch(() => undefined)
  // A join that switched into this session decides what it records.
  if (fresh && !stored?.joinTransition && !stored?.joined && !stored?.child) beginCaptureDecision(session)
  try {
    await activate(host, session)
  } catch (error) {
    report(host, error)
  }
  // The offer and activation never delay a prompt.
  host.clock.after(0, () => {
    if (activation.session !== session) return decideCapture(session)
    void startSession(host, session, !fresh).catch((error: unknown) => {
      decideCapture(session)
      report(host, error)
    })
  })
}

/**
 * Between its turns, a session that another started before that one recorded checks whether it records
 * now, and if so becomes its subagent: its thread is created under that one's, and what it said so far
 * is recorded, the run going on now, which began with the committed message at `runStart`, in a turn
 * of its own.
 */
export function recordUnderParent(host: Host, session: string, runStart: number): Promise<void> {
  return recordFromStart(host, session, runStart, async () => {
    const found = await recordedParent(host, stateFor(session).binding)
    if (!found || activation.session !== session) return false
    host.ui.debug('The session that started this one records now, so this one records as its subagent.')
    await beginChild(host, session, found)
    await activate(host, session)
    return !!stateFor(session).binding?.child
  })
}

/** A session that ended releases its open setup offer and its capture boundary. */
export async function forgetSessionStart(host: Host, session: string) {
  if (started?.session === session) started = undefined
  // A setup offer still open when its session ends was never decided, so the next session offers it again.
  const offer = openOnboarding.get(session)
  openOnboarding.delete(session)
  if (offer) {
    try {
      await releaseOnboarding(onboardingStore(host), offer)
    } catch {
      /* the offer then simply stays consumed */
    }
  }
  decideCapture(session)
}

/**
 * Read a checkout's policy at a session's start: show a policy problem once, auto-activate a new
 * session when the policy records automatically, and offer setup when nothing configures the repo.
 * A session with history (`resumed`) is offered setup like a new one but never auto-activated, since
 * part of it already happened unrecorded. Everything here runs off the startup path.
 */
export async function startSession(host: Host, session: string, resumed = false) {
  const env = setupEnv(host)
  const newSession = !resumed && newSessionFor(session)
  let root: string
  let policy: ProjectPolicy
  try {
    try {
      root = await checkoutRoot(host)
    } catch {
      // Outside a checkout there is nothing to record or offer.
      return
    }
    const path = policyPath(root)
    try {
      policy = readProjectPolicy(await env.readFile(path)).policy
    } catch (error) {
      notifyOnce(
        host,
        `Delta settings at ${path} couldn't be read (${errorText(error)}). Until it's fixed, only sessions you share with /delta-share sync.`,
      )
      return
    }
    if (policy.problem)
      notifyOnce(
        host,
        `Delta settings at ${path} couldn't be used (${policy.problem}). Until it's fixed, only sessions you share with /delta-share sync. Run /delta-setup to replace it.`,
      )
    const binding = stateFor(session).binding
    if (binding?.snapshot || binding?.joined || binding?.joinTransition) {
      // A session already recorded, or joining, keeps what it has.
    } else if (newSession && recordsAutomatically(policy) && (await joinedBindingAt(host, root)))
      notifyOnce(
        host,
        `${root} is a worktree of a Delta thread a pi session joined, so this session isn't recorded automatically. Run /delta-join with that thread's link to record in it.`,
      )
    else if (newSession && recordsAutomatically(policy))
      await activateAutomatically(host, session, root, {
        mode: policy.mode === 'private' ? 'private' : 'organization',
        organization: policy.organization!,
      })
  } finally {
    // Nothing below records, so the session's activity never waits on the setup offer's dialog.
    decideCapture(session)
  }
  // Headless sessions get no reminder and are never offered setup; only an interactive surface shows them.
  if (!host.session.interactive()) return
  stateFor(session).reminder = syncReminder(policy)
  host.ui.invalidate()
  try {
    await offerOnboarding(
      env,
      interaction(host),
      onboardingStore(host),
      {
        root,
        configured: policy.configured,
        newToPlugin: true,
        joined: !!stateFor(session).binding?.joined,
        joining: !!requests.join,
      },
      (key) => {
        openOnboarding.set(session, key)
      },
    )
  } finally {
    openOnboarding.delete(session)
  }
  // A setup the offer opened may have saved a setting; the band follows it.
  await refreshReminder(host, session)
}

/** Re-read the checkout's setting after a setup, so the band's reminder follows what was saved. */
export async function refreshReminder(host: Host, session: string) {
  try {
    const root = await checkoutRoot(host)
    stateFor(session).reminder = syncReminder(readProjectPolicy(await setupEnv(host).readFile(policyPath(root))).policy)
  } catch {
    /* outside a checkout or unreadable: the band keeps what it had */
  }
  host.ui.invalidate()
}

/** The onboarding marker the session's still-open setup offer holds, cleared if the session ends first. */
const openOnboarding = new Map<string, string>()

function onboardingStore(host: Host): OnboardingStore {
  return {
    get: (key) => host.store.get(key),
    set: (key, value) => host.store.set(key, value),
  }
}

/**
 * The band's reminder for a session while Delta does not sync it: a checkout with any setting points
 * to /delta-share, and one never set up to /delta-setup. A syncing session's band says `Syncing`
 * instead, so an automatic checkout's sessions show this only when they are not syncing, as a session
 * started before the setting was saved, or one Delta could not start.
 */
function syncReminder(policy: ProjectPolicy): SyncReminder {
  // Someone who chose a setting is not nudged toward setup every session.
  return policy.configured ? 'manual' : 'not set up'
}

/** Auto-activations already running in this runtime, so a repeated start cannot create twice. */
const autoActivating = new Map<string, Promise<void>>()

/**
 * Wait, at most `budgetMs`, for an automatic activation still running for `session`: a session that
 * ends right after its prompt, as a print-mode run does, then delivers what it recorded.
 */
export async function settleActivation(host: Host, session: string, budgetMs: number) {
  const running = autoActivating.get(session)
  if (!running) return
  const cancelled = new AbortController()
  await Promise.race([
    running.catch(() => {}),
    host.clock.sleep(budgetMs, { signal: cancelled.signal }).catch(() => {}),
  ])
  cancelled.abort()
}

/**
 * Create the thread a repository's policy asks for, request its upload intent, attach the checkout,
 * and start recording. Nothing drains or verifies the checkout until create, upload, and attach have
 * all succeeded: only then is the binding's thread and checkout made visible, so a row or prompt that
 * arrives mid-activation sees a session that is still simply local. Creation is idempotent by
 * external id, so an interrupted activation is safely re-run — from the next prompt, or a resume.
 *
 * The session's capture boundary is released once the contract gate and snapshot are settled, before
 * any network step, so a prompt or turn that arrives during create or attach is recorded rather than
 * dropped. Every await re-checks ownership: a session that ended, or that switched away while a step
 * was pending, leaves no half-initialized binding behind.
 */
function activateAutomatically(host: Host, session: string, root: string, upload: AutoUpload): Promise<void> {
  const running = autoActivating.get(session)
  if (running) return running
  const ownsActivation = stillActive(session)
  const task = (async () => {
    const runtime = stateFor(session)
    if (activation.session !== session || requests.join) return
    const existing = await serial(() => load(host, session))
    if (!ownsActivation()) return
    // A session that already holds a thread, or a binding that is not ours, is never re-created.
    if (
      existing.thread ||
      (existing.snapshot && !existing.autoUpload) ||
      existing.joined ||
      existing.joinTransition ||
      existing.child
    )
      return
    // A fresh session checks the account against the policy alongside the contract, so a repository
    // this account cannot record to is reported before anything is staged.
    const misconfiguration = existing.snapshot ? undefined : policyMisconfiguration(host, upload.organization)
    try {
      // Refuse an incompatible CLI before persisting anything, so it leaves the session manual rather
      // than holding a half-initialized automatic binding.
      await requireContract(host, session)
      if (!ownsActivation()) return
      const refusal = await misconfiguration
      if (!ownsActivation()) return
      const interactive = host.session.interactive()
      if (refusal && !(refusal === SIGNED_OUT_REFUSAL && interactive)) {
        await stopAutomaticRecording(host, session, root, refusal)
        return
      }
      // The session is new, so its snapshot is already taken: no history is exported, and live capture
      // starts with the first row. The intent is durable before any network, so a session whose server
      // is briefly unavailable retries from the next prompt. No thread or checkout is published yet,
      // so nothing drains against a checkout that is not attached or a thread that is not uploaded.
      if (!existing.snapshot) {
        const staged: Binding = { session, snapshot: true, next: 1, pending: [], checkout: root, autoUpload: upload }
        await serial(() => save(host, staged))
        runtime.binding = staged
      }
      if (!ownsActivation()) return
      // The snapshot exists now, so new-session activity may pass; the network steps stay asynchronous.
      decideCapture(session)
      if (interactive) {
        // Authentication may wait on the browser for minutes. Capture locally first, so the person
        // can keep working and this same session uploads everything once sign-in finishes.
        const check = async () => {
          if (!ownsActivation()) throw new Error('Delta automatic sign-in stopped')
        }
        try {
          await requireAuthentication(
            authenticationHost(host),
            await resolveCli(host),
            check,
            async (text) => {
              await check()
              setProgress(host, 'Waiting for Delta sign-in…', 'active')
              host.ui.note(text)
            },
            '/delta-share',
          )
        } catch (error) {
          if (!ownsActivation()) return
          // A cancelled or failed login needs an explicit retry, never another browser on each prompt.
          await stopAutomaticRecording(host, session, root, {
            band: 'Not syncing: Delta sign-in incomplete · /delta-share',
            // An access requirement already says nothing was synced and how to retry.
            transcript:
              error instanceof AccessRequiredError
                ? error.message
                : `${errorText(error)} This session isn't syncing. Run /delta-share to retry.`,
          })
          return
        }
        if (!ownsActivation()) return
        if (refusal === SIGNED_OUT_REFUSAL) {
          // Only the signed-in account can answer which organizations it belongs to.
          const afterSignIn = await policyMisconfiguration(host, upload.organization)
          if (!ownsActivation()) return
          if (afterSignIn) {
            await stopAutomaticRecording(host, session, root, afterSignIn)
            return
          }
        }
      }
      setProgress(host, 'Connecting this session to Delta…', 'active')
      const created = await threadCreate(host, {
        externalId: session,
        organization: { id: upload.organization, visibility: upload.mode },
      })
      if (!ownsActivation()) return
      const reference = await attachWorktree(
        host,
        root,
        created.thread_id,
        existing.checkoutReference,
        undefined,
        session,
      )
      if (!ownsActivation()) return
      await serial(async () =>
        save(host, { ...(await load(host, session)), checkoutReference: reference, pendingWorktree: undefined }),
      )
      await mountCheckout(host, { session, checkout: root, checkoutReference: reference }, async () => {
        if (!ownsActivation()) throw new Error('The session ended while its checkout was being mounted')
      })
      if (!ownsActivation()) return
      // Every step succeeded: now the thread and checkout become visible to drain and verification.
      await serial(async () =>
        save(host, {
          ...(await load(host, session)),
          thread: created.thread_id,
          checkout: root,
          checkoutReference: reference,
        }),
      )
      if (!ownsActivation()) return
      runtime.binding = await serial(() => load(host, session))
      void startConversation(host, session).catch((error: unknown) => {
        if (ownsActivation()) report(host, error)
      })
      void drain(host, session).catch((error: unknown) => {
        if (ownsActivation()) report(host, error)
      })
      exportParent(host, runtime.binding)
      // The band now follows Delta's background upload until Delta confirms it, whether or not the
      // watcher becomes ready: a status read is what reports the thread's link.
      clearProgress(host)
      followUpload(host, session)
    } catch (error) {
      if (!ownsActivation()) return
      // Retrying cannot change a permanent answer, so the session stops recording instead of queuing
      // records that would never be sent.
      if (classifyCommandFailure(error) === 'permanent') {
        await stopAutomaticRecording(host, session, root, activationRefusal(error, upload.organization))
        return
      }
      // Only a staged session gets this far: everything before staging fails permanently.
      const text = `Delta couldn't start syncing this session: ${errorText(error)}. Nothing is lost; Delta retries on your next prompt.`
      setProgress(host, text, 'error')
      notifyOnce(host, text)
    } finally {
      decideCapture(session)
    }
  })()
  autoActivating.set(session, task)
  // Not `finally`: its promise would carry the task's rejection, which the caller handles, unobserved.
  const forget = () => {
    if (autoActivating.get(session) === task) autoActivating.delete(session)
  }
  void task.then(forget, forget)
  return task
}

/** What the band and the transcript say when a repository's policy cannot record this session. */
type ActivationRefusal = { band: string; transcript: string }

const SIGNED_OUT_REFUSAL: ActivationRefusal = {
  band: 'Not syncing: sign in with `delta auth login`',
  transcript:
    "This repository syncs pi sessions to DeltaDB, but Delta is signed out, so this session isn't syncing. Sign in with `delta auth login`; new sessions then sync automatically.",
}

function notMemberRefusal(organization: string): ActivationRefusal {
  const name = organizationName(organization)
  return {
    band: "Not syncing: your Delta account isn't in this repo's team · /delta-share",
    transcript: `This repository syncs sessions to ${name ? `${name} (${organization})` : organization}, which your Delta account isn't a member of, so this session isn't syncing. Use /delta-share to share it with your own team, ask to be added to ${name ?? 'that team'}, or run /delta-setup if the settings name the wrong team.`,
  }
}

/**
 * Check the signed-in account against the organization a policy records to. Only a definite answer
 * refuses: an empty or unreadable list (Delta not running, memberships not loaded yet) lets
 * activation proceed, and `thread create` checks membership again.
 */
async function policyMisconfiguration(host: Host, organization: string): Promise<ActivationRefusal | undefined> {
  try {
    // Bounded like the contract check it runs beside, since new-session activity waits on both.
    const organizations = await listOrganizations(host, CONTRACT_TIMEOUT_MS)
    if (organizations.length && !organizations.some((known) => known.id === organization))
      return notMemberRefusal(organization)
  } catch (error) {
    if (error instanceof DeltaCommandError && error.code === 'authentication_required') return SIGNED_OUT_REFUSAL
  }
}

/** Describe a permanent activation failure, recognizing the account problems a person can fix. */
function activationRefusal(error: unknown, organization: string): ActivationRefusal {
  if (error instanceof DeltaCommandError && error.reason === 'organization_not_member')
    return notMemberRefusal(organization)
  if (error instanceof DeltaCommandError && error.code === 'authentication_required') return SIGNED_OUT_REFUSAL
  if (error instanceof ContractRefusalError)
    return { band: `Not syncing: ${error.message}`, transcript: `This session isn't syncing: ${error.message}.` }
  const advice =
    error instanceof DeltaCommandError
      ? permanentFailureAdvice(error.code, true, error.reason)
      : 'Fix the cause, then start a new session'
  return {
    band: `Not syncing: ${advice}`,
    transcript: `Delta couldn't start syncing this session: ${errorText(error)}. This session isn't syncing. ${advice}.`,
  }
}

/**
 * End automatic recording for a session the policy cannot record: drop any staged binding and its
 * outbox, so the session is simply manual again and nothing retries or grows, then report why. A
 * later /delta share exports the whole conversation from the session, so nothing is lost.
 *
 * The band shows the refusal for the whole session. The transcript explains it once per repository
 * and refusal, remembered in the store, so every new session in a misconfigured repository stays quiet.
 */
async function stopAutomaticRecording(host: Host, session: string, root: string, refusal: ActivationRefusal) {
  await serial(async () => {
    const binding = await load(host, session)
    if (!binding.autoUpload || binding.thread) return
    await host.store.delete(key(session))
    const runtime = stateFor(session)
    runtime.binding = await load(host, session)
    runtime.cleanedThrough = undefined
    // Inside `serial`, so a share that starts next cannot stage a record this removal deletes. The
    // outbox is only disk, so a failed removal leaves orphans, never a wrong binding.
    try {
      await collectAcknowledgedOutbox({ session, root: outbox, next: binding.next, pending: [] })
    } catch (error) {
      host.ui.debug(`Delta outbox removal after stopping automatic recording failed: ${String(error)}`)
    }
  })
  finishProgress(host, refusal.band, 'error')
  const marker = `auto-refused:${(await setupEnv(host).gitCommonDir()) ?? root}`
  try {
    if ((await host.store.get(marker)) === refusal.transcript) return
    await host.store.set(marker, refusal.transcript)
  } catch {
    /* an unreadable marker only repeats the explanation */
  }
  host.ui.note(refusal.transcript, 'warning')
}

/** How long after a session really ends its store entries may be removed; resuming into them dies past it. */
const STORE_HORIZON_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Remove the store entries (`session:` binding and `appended:` ledger) of sessions that really ended
 * before the horizon and hold nothing a later session would need. A binding without an end marker may
 * be live in another pi process, so it is never removed, and neither is any session in use here.
 *
 * The store is shared by every pi process and has no transactions, so each session is read, checked,
 * and deleted in turn: a resume elsewhere can only be lost in that one read-to-delete window.
 */
async function pruneStore(host: Host) {
  const keys = await host.store.keys()
  const now = host.clock.now()
  const ids = new Set(keys.flatMap((storeKey) => /^(?:session|appended):(.+)$/.exec(storeKey)?.[1] ?? []))
  for (const id of ids) {
    if (sessions.has(id)) continue
    const binding = await storedBinding(host, key(id))
    if (
      typeof binding?.endedAt !== 'number' ||
      binding.endedAt > now - STORE_HORIZON_MS ||
      binding.pending?.length ||
      binding.captureFailure ||
      binding.joinTransition
    )
      continue
    await host.store.delete(key(id))
    await host.store.delete(ledgerKey(id))
  }
}
