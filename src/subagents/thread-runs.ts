/**
 * Running the Delta conversation's other threads here as pi subagents: a `delta_thread` call that names
 * a thread runs it in a `pi` process of its own, recorded on that thread, and returns its reply.
 */
import type { Timer } from '../core/clock.ts'
import { exists } from '../core/files.ts'
import type { Host } from '../core/host.ts'
import { isJsonObject } from '../core/json.ts'
import {
  type Binding,
  boundDirectory,
  key,
  load,
  save,
  serial,
  stateFor,
  stillActive,
  storedBinding,
} from '../core/session-state.ts'
import { errorText } from '../core/text.ts'
import { KILL_GRACE_MS, type ProcessStream, TERMINATE_GRACE_MS } from '../core/process.ts'
import { threadStatus, threadWatch, verifiedContract, watchEvents } from '../cli/delta-cli.ts'
import { CHILD_CONTRACT_VERSION, type WatchChild, type WatchItem } from '../cli/thread-commands.ts'
import { mountThread, requireMounted, unmountThread } from '../sharing/join.ts'
import { conversationText } from '../watch/conversation.ts'
import { deliverNote } from '../watch/rows.ts'
import { feed, watchedSession } from '../watch/watch.ts'
import {
  adoptionPrompt,
  deltaTurnReport,
  finishedReport,
  HISTORY_BUDGET,
  historyText,
  isOwnItem,
  itemsSince,
  looksLikeThreadLink,
  namedThread,
  resumePrompt,
  THREAD_TOOL,
  type ThreadTarget,
  threadsNote,
} from './delta-threads.ts'
import {
  allowsTool,
  type ChildReport,
  emptyReport,
  isSessionId,
  jsonRecords,
  keptArguments,
  readRecord,
} from './pi-child.ts'

/*
 * Delta threads as pi's own subagents. A `delta_thread` call that names a thread of this session's Delta
 * conversation, or a Delta link, runs that thread here: a thread pi ran before resumes its pi session,
 * told what happened in Delta since it last ran, and any other thread gets a pi session of its own that
 * starts from the thread's history and works in the thread's worktrees. Its turns are recorded on that
 * thread as any recorded subagent's are, and the call waits for its reply.
 */

/** How long reading a thread's snapshot may take. */
const THREAD_READ_TIMEOUT_MS = 15_000
/** How long a read waits past going live for the worktrees, which a watch reports after its items. */
const THREAD_WORKTREES_GRACE_MS = 3_000
/** How long a thread's pi process has to start its recorded run. */
const CHILD_START_TIMEOUT_MS = 30_000
/** How many threads one session runs at once. */
const MAX_CONCURRENT_RUNS = 4

/** A thread this session ran, kept by the session that ran it. */
export type ThreadRun = {
  session: string
  thread: string
  reference: string
  name: string
  /** The pi session that runs the thread, and the producer its turns are recorded as. */
  child: string
  /** Where it works: this session's checkout, or the thread's mount. */
  cwd: string
  sharesParentCheckout: boolean
  /** The owner Delta mounted the thread's worktrees under, released when the session ends. */
  mountOwner?: string
  /** The actor Delta records the child's output as, which tells its own items from everyone else's. */
  actorId?: string
  /** The last item of the thread the parent was told about. */
  reportedItem?: string
  /** Delta took the thread over from pi, so the parent waits on Delta's turn and is told its reply. */
  awaited?: 'delta'
}

/** What a thread's run hands its pi process for its next run: the thread's history to add, if any. */
export type ThreadHandoff = { note?: string }

const runKey = (session: string, thread: string) => `thread-run:${session}:${thread}`
/** What a thread's pi told the person while it ran, which the session that runs it reads afterwards. */
const notesKey = (child: string) => `thread-notes:${child}`
/** The hand-off a thread's pi process takes when its run starts; `takeHandoff` deletes it. */
export const handoffKey = (child: string) => `thread-prompt:${child}`

/**
 * A `delta_thread` call in this runtime, from the moment it claims a run, before anything is awaited,
 * until its pi exits: `thread` once it is known, its pi once started, and whether the session ended.
 */
type Claim = { thread?: string; stream?: ProcessStream; ended: boolean; exited: Promise<void>; finish: () => void }
const claims = new Set<Claim>()
/** This runtime's session is ending, so no thread run starts any more. */
let ending = false
/** How long a session's end waits for the threads it runs to exit: their pi's own end, then its kill. */
const RUNS_END_MS = TERMINATE_GRACE_MS + 2 * KILL_GRACE_MS
/** The threads the person agreed pi may run, in this runtime. */
const agreed = new Set<string>()

/** What a `delta_thread` call answers. */
export type ThreadReply = {
  text: string
  isError?: true
  /** pi should not ask its model again after this call, as when the session is ending. */
  terminate?: true
  usage?: ChildReport['usage']
  details?: { thread: string; name: string; child: string; turns: number }
}

const refused = (text: string): ThreadReply => ({ text, isError: true })
/** What a call answers once its session ended: it failed, and pi runs nothing more for it. */
const ended = (name: string): ThreadReply => ({
  text: `The session ended, so pi stopped running the Delta thread "${name}".`,
  isError: true,
  terminate: true,
})

/**
 * Whether this session can run its conversation's threads now: it records a thread of its own whose CLI
 * records subagents, it is not itself one, a person can be asked, and pi's options leave the tool on.
 */
export function canRunThreads(host: Host, session: string): boolean {
  const runtime = stateFor(session)
  const binding = runtime.binding
  return (
    !!binding?.thread &&
    binding.snapshot &&
    !binding.child &&
    !runtime.captureFailure &&
    !runtime.pauses.has('delivery') &&
    !runtime.refusedOffline &&
    (verifiedContract(session) ?? 0) >= CHILD_CONTRACT_VERSION &&
    host.session.interactive() &&
    allowsTool(host.launch.args, THREAD_TOOL)
  )
}

/**
 * A thread's snapshot read once: its items, which come before the watch goes live, and its worktrees,
 * which come after; a CLI that reports no worktrees is waited on only briefly.
 */
type ThreadRead = { thread_id: string; items: WatchItem[]; worktrees: string[]; running?: { name: string | null } }

async function readThread(host: Host, reference: string): Promise<ThreadRead> {
  // Without a `proceed` check, a watch always starts.
  const stream = (await threadWatch(host, reference))!
  let expired = false
  const stop = () => void stream.return({ code: null, signal: 'SIGTERM' }).catch(() => {})
  const timer = host.clock.after(THREAD_READ_TIMEOUT_MS, () => {
    expired = true
    stop()
  })
  const items = new Map<string, WatchItem>()
  let thread: string | undefined
  let worktrees: string[] | undefined
  let runningBy: ThreadRead['running']
  let live = false
  let grace: Timer | undefined
  const result = (): ThreadRead => ({
    thread_id: thread!,
    items: [...items.values()],
    worktrees: worktrees ?? [],
    ...(runningBy ? { running: runningBy } : {}),
  })
  try {
    for await (const event of watchEvents(stream)) {
      if (event.type === 'ready') thread = event.thread_id
      else if (event.type === 'item') items.set(event.item.id, event.item)
      else if (event.type === 'item.append') {
        const item = items.get(event.id)
        if (item)
          items.set(event.id, {
            ...item,
            content: {
              ...item.content,
              text: `${typeof item.content.text === 'string' ? item.content.text : ''}${event.text}`,
            },
          })
      } else if (event.type === 'remove') items.delete(event.id)
      else if (event.type === 'worktrees') worktrees = event.worktrees.map((tree) => tree.reference)
      else if (event.type === 'turn')
        runningBy = event.state === 'running' ? { name: event.user?.name ?? null } : undefined
      else if (event.type === 'live') {
        if (!thread) throw new Error('Thread activity arrived before readiness')
        live = true
        grace = host.clock.after(THREAD_WORKTREES_GRACE_MS, stop)
      }
      if (live && worktrees) return result()
    }
    if (live && !expired) return result()
    throw new Error(
      expired ? `reading the Delta thread ${reference} timed out` : `Delta could not read the thread ${reference}`,
    )
  } finally {
    timer.cancel()
    grace?.cancel()
    stop()
  }
}

async function loadRun(host: Host, session: string, thread: string): Promise<ThreadRun | undefined> {
  const stored = await host.store.get(runKey(session, thread))
  // Only this extension writes the key, as a ThreadRun.
  return isJsonObject(stored) && stored.thread === thread ? (stored as ThreadRun) : undefined
}

async function saveRun(host: Host, run: ThreadRun) {
  await host.store.set(runKey(run.session, run.thread), run)
}

/**
 * The actor Delta records a child's output as on this device, which tells its own items from
 * everyone else's. Read once, after the child first recorded, and kept with its run.
 */
async function childActor(host: Host, run: ThreadRun): Promise<string | undefined> {
  if (run.actorId) return run.actorId
  const actorId = (await threadStatus(host, run.reference, run.child)).producer?.actor_id ?? undefined
  if (actorId) await saveRun(host, { ...((await loadRun(host, run.session, run.thread)) ?? run), actorId })
  return actorId
}

const TAKE_OVER = 'Take it over'
const RUN_HERE = 'Run it here'

/**
 * Running a thread someone else is running takes it over, which only the person may decide: they are
 * asked, and a session that cannot ask leaves the thread alone. Returns why the run is refused, or
 * undefined to go ahead.
 */
async function takeoverRefusal(host: Host, name: string, by: { name: string | null }): Promise<string | undefined> {
  const who = conversationText(by.name ?? '').trim() || 'someone'
  const refusal =
    `The Delta thread "${name}" is running in Delta (${who}), so pi left it alone. ` +
    'Try again once it is idle, or ask the person to let pi take it over.'
  if (!host.session.interactive()) return refusal
  try {
    const answer = await host.ui.ask(
      `pi wants to take over "${name}", which ${who} is running in Delta. Take it over?`,
      {
        options: [TAKE_OVER, 'Leave it running'],
      },
    )
    return answer === TAKE_OVER ? undefined : refusal
  } catch {
    // No answer, or no one to ask, leaves the thread with whoever is running it.
    return refusal
  }
}

/** A thread runs here only once the person agreed to it, which they are asked before its first run. */
async function consentRefusal(host: Host, name: string, thread: string): Promise<string | undefined> {
  if (agreed.has(thread)) return
  const refusal = `The person chose not to run the Delta thread "${name}" here.`
  try {
    const answer = await host.ui.ask(
      `pi wants to run the Delta thread "${name}" here as a subagent, in its worktrees, recorded on that thread. Run it?`,
      { options: [RUN_HERE, 'Not now'] },
    )
    if (answer !== RUN_HERE) return refusal
  } catch {
    return refusal
  }
  agreed.add(thread)
}

/**
 * Run the thread `to` names with `message` and answer its reply. A thread pi ran before resumes its pi
 * session, told what happened in Delta since; any other thread gets a pi session that starts from its
 * history and works where its worktrees are, in this session's checkout when it shares them, else in a
 * mount of its own.
 */
export async function messageThread(
  host: Host,
  to: string,
  message: string,
  call: {
    signal?: AbortSignal
    progress: (text: string) => void
    model: { provider: string; id: string } | undefined
    thinking: string | undefined
  },
): Promise<ThreadReply> {
  const session = host.session.id()
  if (!canRunThreads(host, session))
    return refused('Delta threads can be run only from an interactive pi session that Delta records.')
  if (!call.model) return refused('pi has no model selected to run the Delta thread with.')
  if (message.trimStart().startsWith('/'))
    return refused('A message to a Delta thread cannot start with "/", which pi would run as a command.')
  if (ending) return ended(to)
  if (claims.size >= MAX_CONCURRENT_RUNS)
    return refused(`pi already runs ${claims.size} Delta threads; wait for one to answer.`)
  // The run is claimed before anything is awaited, so calls made together count against the limit, and
  // the session's end finds every one.
  let finish!: () => void
  const claim: Claim = { ended: false, exited: new Promise((resolve) => (finish = resolve)), finish }
  claims.add(claim)
  try {
    return await claimedRun(host, session, to, message, call, claim)
  } finally {
    claims.delete(claim)
    claim.finish()
  }
}

async function claimedRun(
  host: Host,
  session: string,
  to: string,
  message: string,
  call: Parameters<typeof messageThread>[3],
  claim: Claim,
): Promise<ThreadReply> {
  const current = stillActive(session)
  const over = () => claim.ended || !current()
  const binding = stateFor(session).binding!
  let target: ThreadTarget | undefined
  const listed = watchedSession() === session ? namedThread(to, feed.children) : undefined
  if (listed) target = { reference: listed.reference, name: listed.name, thread_id: listed.thread_id }
  else if (looksLikeThreadLink(to)) target = { reference: to.trim(), name: to.trim() }
  else {
    const names = feed.children.map((thread) => `"${thread.name}"`).join(', ')
    return refused(
      `No thread of this Delta conversation is named "${to}".${names ? ` The threads pi can run are ${names}.` : ''}`,
    )
  }
  const read = await readThread(host, target.reference)
  const thread = read.thread_id
  if (thread === binding.thread) return refused("That is this session's own Delta thread.")
  // Checked and claimed with nothing awaited between, so two calls to one thread start one pi.
  if ([...claims].some((other) => other !== claim && other.thread === thread))
    return refused(`pi is already running the Delta thread "${target.name}"; its reply comes back to that call.`)
  claim.thread = thread
  if (over()) return ended(target.name)
  let run = await loadRun(host, session, thread)
  const name =
    run?.name ??
    (target.name === target.reference
      ? (await threadStatus(host, target.reference, session).catch(() => undefined))?.title?.trim() || 'Delta thread'
      : target.name)
  const refusal =
    (!run && (await consentRefusal(host, name, thread))) ||
    (read.running && (await takeoverRefusal(host, name, read.running)))
  if (refusal) return refused(refusal)
  if (over()) return ended(name)

  // A run whose pi session is still there resumes it; otherwise the thread starts afresh from its history.
  const childBinding = run && (await storedBinding(host, key(run.child)))
  const file = childBinding?.thread === thread ? childBinding.child?.file : undefined
  const resume = run && file && (await exists(file)) ? file : undefined
  let note: string
  let created = false
  // A mount made here is released again when the call goes no further.
  let mounted: { reference: string; owner: string } | undefined
  const unmount = async () => {
    if (mounted) await unmountThread(host, mounted.reference, mounted.owner)
  }
  if (run && resume) {
    if (run.mountOwner) {
      await mountFor(host, session, run.reference, thread, run.mountOwner)
      mounted = { reference: run.reference, owner: run.mountOwner }
    }
    const since = itemsSince(read.items, await childActor(host, run).catch(() => undefined))
    note = resumePrompt(name, historyText(since, run.reference, HISTORY_BUDGET), message)
  } else {
    if (!read.worktrees.length) return refused(`The Delta thread "${name}" has no worktree for pi to work in.`)
    const shares = read.worktrees.every((tree) => (feed.worktrees ?? []).includes(tree))
    const mountOwner = shares ? undefined : `${session}-${thread.slice(-12)}`
    const child = run ? `${session}-${crypto.randomUUID().slice(0, 8)}` : `${session}-${thread.slice(-12)}`
    if (!isSessionId(child)) return refused(`pi cannot name a session ${child} for the Delta thread "${name}".`)
    let cwd = boundDirectory(binding)
    if (mountOwner) {
      cwd = await mountFor(host, session, target.reference, thread, mountOwner)
      mounted = { reference: target.reference, owner: mountOwner }
    }
    if (!cwd) return refused('This session has no checkout for the thread to work in.')
    run = {
      session,
      thread,
      reference: target.reference,
      name,
      child,
      cwd,
      sharesParentCheckout: shares,
      ...(mountOwner ? { mountOwner } : {}),
    }
    await seedChild(host, run, binding)
    created = true
    note = adoptionPrompt(
      name,
      historyText(
        read.items.filter((item) => !item.open),
        target.reference,
        HISTORY_BUDGET,
      ),
      message,
    )
  }
  if (over()) {
    await unmount()
    return ended(name)
  }
  const last = read.items.at(-1)
  await saveRun(host, { ...run, ...(last ? { reportedItem: last.id } : {}) })
  await serial(async () => {
    const parent = await load(host, session)
    if (!parent.threadRuns?.includes(thread))
      await save(host, { ...parent, threadRuns: [...(parent.threadRuns ?? []), thread] })
  })
  // The note is the thread's history ending with the message, which pi adds after the prompt; a run
  // with nothing new is the message alone.
  await host.store.set(handoffKey(run.child), { ...(note !== message ? { note } : {}) } satisfies ThreadHandoff)
  const takenBefore = childBinding?.child?.takenOver
  await host.store.delete(notesKey(run.child))
  const outcome = await runChild(host, claim, run, message, resume, call)
  const told = await host.store.get(notesKey(run.child))
  await host.store.delete(notesKey(run.child))
  const reported = Array.isArray(told) ? told.filter((text) => typeof text === 'string').join('\n') : ''
  if (over()) {
    if (!outcome.report.started) await host.store.delete(handoffKey(run.child))
    return ended(name)
  }
  if (outcome.aborted) throw new Error(`The run of the Delta thread "${name}" was stopped.`)
  const report = outcome.report
  // What the thread's pi reported, such as Delta pausing its recording, goes with its answer.
  const said = reported ? `\n\nThe thread's pi reported:\n${reported}` : ''
  if (!report.started) {
    await host.store.delete(handoffKey(run.child))
    if (created) await forgetRun(host, run)
    if (outcome.unrecorded) return refused(`pi started no subagent to run the Delta thread "${name}".`)
    return refused(`pi could not run the Delta thread "${name}": ${outcome.error || `exit ${outcome.code}`}`)
  }
  const after = await storedBinding(host, key(run.child))
  if (after?.child?.takenOver !== undefined && after.child.takenOver !== takenBefore) {
    await saveRun(host, { ...((await loadRun(host, session, thread)) ?? run), awaited: 'delta' })
    return {
      text: `[Delta] Someone took over the thread "${name}" in Delta, so pi stopped its run here. Delta's agent continues it in that thread; its reply is added here when Delta's turn ends. Send "${name}" a message with ${THREAD_TOOL} to run it here again.${said}`,
      usage: report.usage,
    }
  }
  const details = { thread, name, child: run.child, turns: report.turns }
  if (report.stopReason === 'error')
    return {
      text: `The Delta thread "${name}" failed: ${report.errorMessage ?? 'its model reported an error'}${said}`,
      isError: true,
      usage: report.usage,
      details,
    }
  return { text: `${finishedReport(name, report.reply)}${said}`, usage: report.usage, details }
}

async function mountFor(host: Host, session: string, reference: string, thread: string, owner: string) {
  const mounted = await mountThread(host, { session, thread, locator: reference, owner })
  requireMounted(mounted, thread)
  return mounted.directory
}

/**
 * Write the binding a thread's pi process records with: the thread exists already, so it creates none
 * and attaches no checkout, and its prompts are attributed to this session.
 */
async function seedChild(host: Host, run: ThreadRun, parent: Binding) {
  const child: Binding = {
    session: run.child,
    snapshot: true,
    next: 1,
    pending: [],
    thread: run.thread,
    child: {
      parent: parent.locator ?? parent.thread!,
      sender: run.session,
      reference: run.reference,
      name: run.name,
      named: true,
      sharesParentCheckout: run.sharesParentCheckout,
      root: run.cwd,
      adopted: true,
    },
  }
  await host.store.set(key(run.child), child)
}

/** Forget a run that never started: its record, and the binding seeded for it when nothing was recorded. */
async function forgetRun(host: Host, run: ThreadRun) {
  await host.store.delete(runKey(run.session, run.thread))
  const child = await storedBinding(host, key(run.child))
  if (child && child.next === 1 && !child.pending.length) await host.store.delete(key(run.child))
  if (run.mountOwner) await unmountThread(host, run.reference, run.mountOwner)
}

type ChildOutcome = {
  report: ChildReport
  aborted: boolean
  /** The run started without this extension recording it, or did not start in time. */
  unrecorded: boolean
  code: number | null
  error: string
}

/**
 * Run the thread's pi process to the end of its run, as this pi was started, with the message on its
 * input so it neither shows in the process list nor is read as an option or a file. Its run counts as
 * started once pi reports it and the extension there took its hand-off.
 */
async function runChild(
  host: Host,
  claim: Claim,
  run: ThreadRun,
  message: string,
  resume: string | undefined,
  call: Parameters<typeof messageThread>[3],
): Promise<ChildOutcome> {
  const argv = [
    ...host.launch.command,
    '--mode',
    'json',
    '-p',
    ...(resume ? ['--session', resume] : ['--session-id', run.child]),
    '--model',
    `${call.model!.provider}/${call.model!.id}`,
    ...(call.thinking ? ['--thinking', call.thinking] : []),
    '-e',
    host.plugin.root,
    ...(await keptArguments(host.launch, exists)),
  ]
  const report = emptyReport()
  if (claim.ended) return { report, aborted: false, unrecorded: false, code: null, error: '' }
  const stream = host.process.spawn({ argv, cwd: run.cwd, stdin: message })
  claim.stream = stream
  let unrecorded = false
  let aborted = false
  let error = ''
  const stop = () => stream.terminate()
  const startTimer = host.clock.after(CHILD_START_TIMEOUT_MS, () => {
    if (report.started) return
    unrecorded = true
    stop()
  })
  const onAbort = () => {
    aborted = true
    stop()
  }
  if (call.signal?.aborted) onAbort()
  call.signal?.addEventListener('abort', onAbort, { once: true })
  const records = jsonRecords()
  let code: number | null = null
  try {
    for (;;) {
      const piece = await stream.next()
      if (piece.done) {
        code = piece.value.code
        break
      }
      if (piece.value.stream === 'stderr') {
        error = `${error}${piece.value.text}`.slice(-2_000)
        continue
      }
      for (const record of records(piece.value.text)) {
        const wasStarted = report.started
        readRecord(report, record)
        if (report.started && !wasStarted) {
          // The extension in the child takes its hand-off before the run starts; one still there was never
          // taken, so nothing records the run, and it is stopped before it works in the thread's worktrees.
          if ((await host.store.get(handoffKey(run.child))) !== undefined) {
            report.started = false
            unrecorded = true
            stop()
          }
        }
        if (report.progress) call.progress(report.progress)
      }
    }
  } catch (failure) {
    error = errorText(failure)
  } finally {
    startTimer.cancel()
    call.signal?.removeEventListener('abort', onAbort)
  }
  return { report, aborted, unrecorded, code, error: error.trim().split('\n').at(-1) ?? '' }
}

/**
 * Stop the threads this session runs and wait for their pi processes to exit, which flush what they
 * recorded, then release the mounts the session made for them. Answers whether any was running.
 */
export async function endThreadRuns(host: Host, session: string, binding: Binding | undefined): Promise<boolean> {
  ending = true
  const stopping = [...claims]
  for (const claim of stopping) {
    claim.ended = true
    claim.stream?.terminate()
  }
  // A call still preparing its run sees the end and starts none, and a pi that will not exit is killed.
  const expiry = new AbortController()
  await Promise.race([
    Promise.all(stopping.map((claim) => claim.exited)),
    host.clock.sleep(RUNS_END_MS, { signal: expiry.signal }).catch(() => {}),
  ])
  expiry.abort()
  for (const thread of binding?.threadRuns ?? []) {
    const run = await loadRun(host, session, thread).catch(() => undefined)
    if (run?.mountOwner) await unmountThread(host, run.reference, run.mountOwner)
  }
  return stopping.length > 0
}

/**
 * Take the hand-off a thread's run left for this pi session, once: the note to add to the run's
 * context, if any. Undefined when this session was not started to run a thread.
 */
export async function takeHandoff(host: Host, session: string): Promise<ThreadHandoff | undefined> {
  const stored = await host.store.get(handoffKey(session))
  if (stored === undefined) return
  await host.store.delete(handoffKey(session))
  return isJsonObject(stored) && typeof stored.note === 'string' ? { note: stored.note } : {}
}

/** Per session, the last status each thread of its watched conversation reported, to see a turn of it end. */
const threadStatuses = new Map<string, Map<string, string>>()
/** Per session, the names of the threads its parent was last told it can message. */
const notedThreads = new Map<string, string>()

/** An ended session forgets its threads' statuses and which of them it was told about. */
export function forgetThreadNotes(session: string) {
  threadStatuses.delete(session)
  notedThreads.delete(session)
}

/**
 * Follow the conversation's threads: tell the session which it can message when that changes, and
 * when a turn Delta's agent ran in a thread this session runs ends, what it said.
 */
export function observeThreads(host: Host, session: string) {
  if (!canRunThreads(host, session)) return
  let statuses = threadStatuses.get(session)
  if (!statuses) threadStatuses.set(session, (statuses = new Map<string, string>()))
  for (const thread of feed.children) {
    const before = statuses.get(thread.thread_id)
    statuses.set(thread.thread_id, thread.status)
    if (before === 'running' && thread.status !== 'running' && thread.status !== 'queued' && thread.reference)
      void reportDeltaTurn(host, session, thread).catch((error: unknown) =>
        host.ui.debug(`Delta could not report a turn of ${thread.thread_id}: ${String(error)}`),
      )
  }
  const listed = feed.children
    .filter((thread) => thread.reference)
    .map((thread) => ({ name: thread.name, status: thread.status }))
  const names = JSON.stringify(listed.map((thread) => thread.name).sort())
  if (names !== notedThreads.get(session) && listed.length) {
    notedThreads.set(session, names)
    const note = threadsNote(listed)
    if (note) void deliverNote(host, session, note)
  }
}

/**
 * A thread this session runs finished a turn that was not pi's: tell the session what Delta said,
 * starting a turn when it waits on that thread, else as context for its next one.
 */
async function reportDeltaTurn(host: Host, session: string, thread: WatchChild) {
  const run = await loadRun(host, session, thread.thread_id)
  if (!run || [...claims].some((claim) => claim.thread === run.thread)) return
  const read = await readThread(host, run.reference)
  const actor = await childActor(host, run).catch(() => undefined)
  // A turn of pi's own ending is no news to the session.
  const lastTurn = [...read.items].reverse().find((item) => item.turn_id !== null)
  if (!lastTurn || isOwnItem(lastTurn, actor)) return
  let since = itemsSince(read.items, actor)
  const current = (await loadRun(host, session, run.thread)) ?? run
  const reported = since.findIndex((item) => item.id === current.reportedItem)
  if (reported >= 0) since = since.slice(reported + 1)
  const text = deltaTurnReport(run.name, since, run.reference)
  const awaited = current.awaited === 'delta'
  const { awaited: _, ...rest } = current
  const last = read.items.at(-1)
  await saveRun(host, { ...rest, ...(last ? { reportedItem: last.id } : {}) })
  if (!text) return
  if (awaited) reportReply(host, session, text)
  else await deliverNote(host, session, text)
}

/** Start a turn of the session's own with a reply it waits on, as a prompt from the extension. */
function reportReply(host: Host, session: string, text: string) {
  try {
    host.pi.sendUserMessage(text, host.session.idle() ? undefined : { deliverAs: 'followUp' })
  } catch (error) {
    // A pi that takes no extension prompt now still gets the reply into the model's context.
    host.ui.debug(`Couldn't hand pi a Delta thread's reply: ${String(error)}`)
    void deliverNote(host, session, text)
  }
}

/** Notes a thread's pi keeps for the session that runs it, one write at a time. */
let keeping: Promise<void> = Promise.resolve()

/**
 * Keep a note this pi showed while it runs a thread for another session, such as Delta pausing its
 * recording, so that session's answer carries it: nobody sees this pi's own output.
 */
export function noteForParent(host: Host, session: string, text: string) {
  if (!stateFor(session).binding?.child?.adopted) return
  keeping = keeping
    .then(async () => {
      const kept = await host.store.get(notesKey(session))
      const notes: unknown[] = Array.isArray(kept) ? kept : []
      await host.store.set(notesKey(session), [...notes, text].slice(-20))
    })
    .catch((error: unknown) => host.ui.debug(`A note for the session running this thread was lost: ${String(error)}`))
}
