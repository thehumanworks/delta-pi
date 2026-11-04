/**
 * Delta for pi: records pi sessions to Delta threads, shares them, and joins teammates' threads,
 * through the `delta` CLI. A port of Zed Industries' Delta plugin for Claude Code.
 *
 * Copyright (C) 2026 Zed Industries. Licensed under the GNU Affero General Public License, version 3
 * only (AGPL-3.0-only); see LICENSE.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  generateUnifiedPatch,
  getAgentDir,
  SessionManager,
  VERSION,
} from '@earendil-works/pi-coding-agent'
import { Type } from '@earendil-works/pi-ai'
import type { TUI } from '@earendil-works/pi-tui'
import { systemClock } from './src/core/clock.ts'
import { piVersionWarning } from './src/core/compatibility.ts'
import {
  type AskRequest,
  type Host,
  InteractionUnavailableError,
  type NoteTone,
  type Platform,
} from './src/core/host.ts'
import { run, spawn } from './src/core/process.ts'
import {
  activation,
  cancelRequestsOf,
  endActivationOf,
  forgetRuntime,
  markEnded,
  resetRuntime,
  stateFor,
} from './src/core/session-state.ts'
import { writeExclusive } from './src/core/files.ts'
import { fileStore } from './src/core/store.ts'
import { errorText } from './src/core/text.ts'
import { forgetContract, verifiedContract } from './src/cli/delta-cli.ts'
import { BandWidget, bandText, clearProgress } from './src/band/band.ts'
import { type Note, renderNote, renderRemote } from './src/band/renderers.ts'
import { REMOTE_MESSAGE } from './src/recording/content.ts'
import {
  completeTurn,
  deliverWithin,
  flushUnsaved,
  recordCommitted,
  recordFromNow,
  rememberPriorFile,
  startTurn,
  turnStopReason,
  usePatchBuilder,
} from './src/recording/delivery.ts'
import { admitPrompt } from './src/recording/prompt.ts'
import { recordTitle } from './src/recording/title.ts'
import {
  beginSession,
  forgetSessionStart,
  recordUnderParent,
  settleActivation,
  useDataDirectory,
} from './src/setup/activation.ts'
import {
  COMMANDS,
  DELTA_USAGE,
  deltaMenu,
  installationUpdates,
  installUpdateHost,
  JOIN_USAGE,
  ORG_USAGE,
  runDeltaCommand,
} from './src/setup/commands.ts'
import { TYPE_SOMETHING } from './src/setup/setup.ts'
import { releaseOnEnd } from './src/sharing/join.ts'
import {
  releaseChildCheckout,
  stopChildTurn,
  SUBAGENT_ACTIVATION_MS,
  SUBAGENT_DELIVERY_MS,
  SUBAGENT_SETTLE_MS,
  withdrawParent,
} from './src/subagents/subagents.ts'
import { THREAD_TOOL } from './src/subagents/delta-threads.ts'
import {
  canRunThreads,
  endThreadRuns,
  forgetThreadNotes,
  messageThread,
  noteForParent,
  takeHandoff,
} from './src/subagents/thread-runs.ts'
import { deliverNote } from './src/watch/rows.ts'
import { startPluginUpdates, stopPluginUpdates } from './src/updates/updates.ts'
import type { RemoteDisplay } from './src/watch/rows.ts'
import { stopWatching } from './src/watch/watch.ts'

const ROOT = dirname(fileURLToPath(import.meta.url))
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { name: string; version: string }
/** The custom entry type of the notes Delta leaves for the person. */
const NOTE_ENTRY = 'delta-note'
/** The debug log moves aside to `debug.log.1` past this size. */
const DEBUG_LOG_LIMIT = 2 * 1024 * 1024

/**
 * How this pi was started, so a subagent starts the same way: the script node runs, when there is one
 * (as for npm's `pi`), else the program itself, or `pi` from the PATH.
 */
function piLaunch() {
  const script = process.argv[1]
  const generic = /^(node|bun)(\.exe)?$/i.test(process.execPath.split(/[\\/]/).at(-1) ?? '')
  const command =
    script && !script.startsWith('/$bunfs/') && existsSync(script)
      ? [process.execPath, script]
      : generic
        ? ['pi']
        : [process.execPath]
  return { command, args: process.argv.slice(2), cwd: process.cwd() }
}

/** The machine pi runs on, as the extension uses it. */
export function nodePlatform(): Platform {
  return {
    dataDir: join(getAgentDir(), 'delta'),
    clock: systemClock,
    process: { run, spawn },
    launch: piLaunch(),
    env: {
      windows: () => process.platform === 'win32',
      get: (name) => process.env[name],
      set: (name, value) => {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      },
    },
    stderr: (text) => process.stderr.write(text),
    copy: async (text) => {
      try {
        await copyToClipboard(text)
        return true
      } catch {
        return false
      }
    },
  }
}

export default function delta(pi: ExtensionAPI) {
  createDelta(pi, nodePlatform())
}

/** Bind Delta's features to pi's events, commands and UI, on `platform`. */
export function createDelta(pi: ExtensionAPI, platform: Platform) {
  const { dataDir } = platform
  useDataDirectory(dataDir)
  usePatchBuilder((path, before, after) => generateUnifiedPatch(path, before, after))
  /** The context pi handed this runtime last; undefined before the session starts and after it ends. */
  let context: ExtensionContext | undefined
  let tui: TUI | undefined
  /** The band's text as a client without pi's terminal last saw it. */
  let shownStatus: string | undefined
  const logPath = join(dataDir, 'debug.log')
  const debug = (text: string) => {
    try {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 })
      try {
        if (statSync(logPath).size > DEBUG_LOG_LIMIT) renameSync(logPath, `${logPath}.1`)
      } catch {
        /* no log yet, or another pi process just moved it aside */
      }
      appendFileSync(logPath, `${new Date().toISOString()} ${text}\n`, { mode: 0o600 })
    } catch {
      /* the debug log is best effort */
    }
  }
  /** A note for the person; showing it is best effort, so a failure to show it never fails the work it reports. */
  const note = (text: string, tone: NoteTone = 'info') => {
    debug(`note: ${text}`)
    if (!context) return
    try {
      pi.appendEntry<Note>(NOTE_ENTRY, { text, tone })
    } catch (error) {
      debug(`The note could not be added to the session: ${errorText(error)}`)
    }
    // A client without pi's terminal draws no entries, so it hears each note as a notification. Print
    // and JSON modes have no client at all: their notes go where pi reports everything but the model's
    // answer or its stream of events.
    if (context.hasUI && context.mode !== 'tui') context.ui.notify(text, tone)
    else if (!context.hasUI) platform.stderr(`${text}\n`)
    noteForParent(host, context.sessionManager.getSessionId(), text)
  }
  const host: Host = {
    pi,
    dataDir,
    plugin: { name: MANIFEST.name, version: MANIFEST.version, root: ROOT },
    clock: platform.clock,
    process: platform.process,
    store: fileStore(join(dataDir, 'store')),
    launch: platform.launch,
    env: platform.env,
    session: {
      id: () => context?.sessionManager.getSessionId() ?? '',
      cwd: () => context?.cwd ?? process.cwd(),
      file: () => context?.sessionManager.getSessionFile(),
      interactive: () => !!context?.hasUI,
      terminal: () => context?.mode === 'tui',
      messages: () =>
        (context?.sessionManager.getBranch() ?? []).flatMap((entry) =>
          entry.type === 'message' ? [entry.message] : [],
        ),
      committed: () =>
        (context?.sessionManager.getEntries() ?? []).flatMap((entry) =>
          entry.type === 'message' ? [{ id: entry.id, message: entry.message }] : [],
        ),
      holds: (details) => {
        const entry = context?.sessionManager.getLeafEntry()
        return entry?.type === 'custom_message' && entry.details === details
      },
      customMessages: (customType) =>
        (context?.sessionManager.getEntries() ?? []).flatMap((entry) =>
          entry.type === 'custom_message' && entry.customType === customType
            ? [{ content: entry.content, details: entry.details }]
            : [],
        ),
      turns: () =>
        (context?.sessionManager.getBranch() ?? []).filter(
          (entry) => entry.type === 'message' && (entry.message.role === 'user' || entry.message.role === 'assistant'),
        ).length,
      name: () => pi.getSessionName(),
      idle: () => context?.isIdle() ?? true,
      create: async (id, directory, parent) => {
        const manager = SessionManager.create(directory, undefined, {
          id,
          ...(parent ? { parentSession: parent } : {}),
        })
        const file = manager.getSessionFile()
        const header = manager.getHeader()
        if (!file || !header) throw new Error("pi could not prepare a session in the thread's folder")
        // Only the header is written; pi adds the conversation as it happens.
        await writeExclusive(file, `${JSON.stringify(header)}\n`)
        return file
      },
    },
    turn: { abort: () => context?.abort() },
    ui: {
      ask: async (question, request) => ask(question, request),
      note,
      notify: (text, tone = 'info') => context?.ui.notify(text, tone),
      status: (text) => context?.ui.setStatus('delta-status', text),
      debug,
      invalidate: () => {
        if (tui) return tui.requestRender()
        if (!context?.hasUI) return
        // A client without pi's terminal hears of each change once.
        const text = bandText(host)
        if (text === shownStatus) return
        shownStatus = text
        context.ui.setStatus('delta', text)
      },
      copy: (text) => platform.copy(text),
      open: async (url) => {
        const attempts =
          process.platform === 'win32'
            ? [['rundll32', 'url.dll,FileProtocolHandler', url]]
            : process.platform === 'darwin'
              ? [['open', url]]
              : [['xdg-open', url]]
        for (const argv of attempts) {
          const opened = await platform.process.run(argv, { timeoutMs: 5_000 }).catch(() => ({ exitCode: 1 }))
          if (opened.exitCode === 0) return true
        }
        return false
      },
    },
  }

  /** Ask through pi's dialog: a choice, with a typed answer when the question takes one. */
  async function ask(question: string, request: AskRequest): Promise<string | undefined> {
    const ui = context?.hasUI ? context.ui : undefined
    if (!ui) throw new InteractionUnavailableError('nobody can answer questions in this pi session')
    const labels = new Map<string, string>()
    for (const option of request.options) {
      const hint = request.descriptions?.[option]
      labels.set(hint ? `${option} — ${hint}` : option, option)
    }
    if (request.typed) labels.set(TYPE_SOMETHING, TYPE_SOMETHING)
    const title = request.header ? `${request.header}: ${question}` : question
    const chosen = await ui.select(title, [...labels.keys()])
    if (chosen === undefined) return undefined
    const label = labels.get(chosen) ?? chosen
    if (label !== TYPE_SOMETHING) return label
    const typed = await ui.input(question)
    return typed?.trim() ? typed : undefined
  }

  pi.registerMessageRenderer<RemoteDisplay>(REMOTE_MESSAGE, (message, options, theme) =>
    renderRemote(message.details, theme, options.outputPad),
  )
  pi.registerEntryRenderer<Note>(NOTE_ENTRY, (entry, _options, theme) => renderNote(entry.data, theme))

  // Offered only where it can run, which `before_agent_start` decides before each run.
  pi.registerTool({
    name: THREAD_TOOL,
    label: 'Delta thread',
    description:
      "Run another thread of this session's Delta conversation here as a subagent: send it a message, and it continues that thread in the thread's worktrees, recorded on that thread, then answers. Name the thread by its name as Delta shows it, its thread id, its reference, or a Delta link. Returns the thread's reply.",
    promptSnippet: 'Run another thread of this Delta conversation here as a subagent',
    parameters: Type.Object({
      thread: Type.String({
        description: "The thread's name as Delta shows it, its thread id, its reference, or a Delta link",
      }),
      message: Type.String({ description: 'The message to send the thread' }),
    }),
    defaultActive: false,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      context = ctx
      const reply = await messageThread(host, params.thread, params.message, {
        signal,
        progress: (text) => onUpdate?.({ content: [{ type: 'text', text }], details: undefined }),
        model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
        thinking: ctx.thinkingLevel,
      })
      return {
        content: [{ type: 'text', text: reply.text }],
        details: reply.details,
        ...(reply.usage ? { usage: reply.usage } : {}),
        ...(reply.isError ? { isError: true } : {}),
        ...(reply.terminate ? { terminate: true } : {}),
      }
    },
  })

  /** Run a `/delta` action and show what it answered. */
  const answer = async (action: Promise<{ text?: string }>) => {
    try {
      const { text } = await action
      if (text) note(text)
    } catch (error) {
      note(`Delta command failed: ${errorText(error)}`, 'error')
    }
  }
  const command = (ctx: ExtensionCommandContext) => {
    context = ctx
    return { switchSession: (path: string) => ctx.switchSession(path), reload: () => ctx.reload() }
  }
  const completions = (actions: readonly string[]) => (prefix: string) => {
    const matches = actions.filter((action) => action.startsWith(prefix.trimStart()))
    return matches.length ? matches.map((action) => ({ value: action, label: action })) : null
  }
  for (const entry of COMMANDS) {
    pi.registerCommand(entry.name, {
      description: entry.description,
      ...('actions' in entry ? { getArgumentCompletions: completions(entry.actions) } : {}),
      handler: async (args, ctx) => {
        const control = command(ctx)
        const given = args.trim()
        if (entry.name === 'delta')
          return answer(
            given
              ? runDeltaCommand(host, given, 'delta_subcommand', control)
              : deltaMenu(host, 'menu', DELTA_USAGE, 'delta_subcommand', control),
          )
        if (entry.name === 'delta-join')
          return answer(
            given
              ? runDeltaCommand(host, `join ${given}`, 'dedicated_command', control)
              : deltaMenu(host, 'join', JOIN_USAGE, 'dedicated_command', control),
          )
        if (entry.name === 'delta-org')
          return answer(
            given
              ? runDeltaCommand(host, `org ${given}`, 'dedicated_command', control)
              : deltaMenu(host, 'team', ORG_USAGE, 'dedicated_command', control),
          )
        const action = entry.name.slice('delta-'.length)
        return answer(runDeltaCommand(host, `${action} ${given}`.trim(), 'dedicated_command', control))
      },
    })
  }

  pi.on('session_start', async (_event, ctx) => {
    context = ctx
    const session = ctx.sessionManager.getSessionId()
    const warning = piVersionWarning(VERSION)
    if (warning) note(warning, 'warning')
    if (ctx.mode === 'tui')
      ctx.ui.setWidget('delta', (widgetTui, theme) => {
        tui = widgetTui
        return new BandWidget(host, () => theme)
      })
    // Only a person can act on an update notice; subagents and scripted runs never check.
    if (ctx.hasUI) host.clock.after(0, () => installationUpdates.check(installUpdateHost(host)))
    startPluginUpdates(host)
    recordFromNow(host)
    await beginSession(host, session)
  })

  pi.on('session_info_changed', async (_event, ctx) => {
    context = ctx
    await recordTitle(host, ctx.sessionManager.getSessionId())
  })

  /** Say why a prompt was not submitted, and give the person their text back to send again. */
  const refuse = (ctx: ExtensionContext, text: string, reason: string, tone: NoteTone) => {
    note(reason, tone)
    // pi replaces a session's context when it switches; a refusal that outlived its session puts nothing back.
    if (context !== ctx) return
    if (ctx.mode === 'tui' && !ctx.ui.getEditorText().trim()) ctx.ui.setEditorText(text)
  }
  pi.on('input', async (event, ctx) => {
    context = ctx
    try {
      const refusal = await admitPrompt(host, event.text, event.streamingBehavior !== undefined)
      if (refusal === undefined) return { action: 'continue' }
      // A Delta thread's reply the extension hands pi as a prompt reaches the model as context instead.
      if (event.source === 'extension' && event.text.startsWith('[Delta] ')) {
        debug(`A Delta thread's reply could not start a turn (${refusal}); it is added as context.`)
        await deliverNote(host, ctx.sessionManager.getSessionId(), event.text)
        return { action: 'handled' }
      }
      refuse(ctx, event.text, refusal, 'warning')
    } catch (error) {
      refuse(
        ctx,
        event.text,
        `Delta could not safely prepare this shared turn: ${errorText(error)}. Retry once the watcher is ready.`,
        'error',
      )
    }
    return { action: 'handled' }
  })

  // Delta records what pi committed to the session, read at the next event after pi commits it: each
  // message once every extension's message_end has run, and the shell commands the person ran, which
  // pi commits without a message_end.
  const recordFrom = async (_event: unknown, ctx: ExtensionContext) => {
    context = ctx
    // A reply names an untitled session's thread once it is recorded, without waiting for its turn to
    // end, as the plugin takes the title Claude chose at its first reply.
    if (await recordCommitted(host)) await recordTitle(host, ctx.sessionManager.getSessionId())
  }
  pi.on('message_start', recordFrom)
  pi.on('message_end', recordFrom)
  pi.on('tool_execution_start', recordFrom)
  pi.on('turn_end', recordFrom)
  // Before each model request, which follows the prompt or tool results it answers.
  pi.on('context', recordFrom)

  pi.on('before_agent_start', async (_event, ctx) => {
    context = ctx
    const session = ctx.sessionManager.getSessionId()
    const active = pi.getActiveTools()
    const offered = canRunThreads(host, session)
    if (offered !== active.includes(THREAD_TOOL))
      pi.setActiveTools(offered ? [...active, THREAD_TOOL] : active.filter((name) => name !== THREAD_TOOL))
    // A thread run by another session adds the thread's history its parent left for this run, which
    // pi places after the prompt; taking it also tells the parent this run is recorded.
    // A run Delta would not record, as when its CLI was refused, leaves the hand-off, which the parent
    // sees, and stops it before it works in the thread's worktrees.
    const runtime = stateFor(session)
    if (!runtime.binding?.child?.adopted || verifiedContract(session) === undefined || runtime.captureFailure) return
    const handoff = await takeHandoff(host, session)
    if (!handoff?.note) return
    return {
      message: { customType: REMOTE_MESSAGE, content: handoff.note, display: false, details: { kind: 'context' } },
    }
  })

  /** How many messages the session held when the run in progress started. */
  let runStart = 0
  /** A stopping subagent waits for its aborted run to settle. */
  const settled: (() => void)[] = []
  pi.on('agent_start', async (_event, ctx) => {
    context = ctx
    // Shell commands run between turns belong before the turn that starts now.
    await recordCommitted(host)
    await recordUnderParent(host, ctx.sessionManager.getSessionId(), runStart)
    runStart = host.session.committed().length
    await startTurn(host)
    // The band's update notice gives way while the run goes on.
    host.ui.invalidate()
  })

  // A subagent whose parent is shared while it runs records from its next turn's end.
  pi.on('turn_end', async (_event, ctx) => {
    context = ctx
    await recordUnderParent(host, ctx.sessionManager.getSessionId(), runStart)
  })

  pi.on('tool_call', async (event, ctx) => {
    context = ctx
    // A call another tool made has no result in the transcript, so its record would never be released.
    if ((event.toolName === 'write' || event.toolName === 'edit') && event.parentToolCallId === undefined)
      await rememberPriorFile(host, event.toolCallId, event.input, event.toolName)
  })

  pi.on('agent_settled', async (event, ctx) => {
    context = ctx
    const session = ctx.sessionManager.getSessionId()
    await recordCommitted(host)
    await recordUnderParent(host, session, runStart)
    // Why the run's last reply ended, as pi committed it, after every extension's message_end.
    const reply = host.session
      .committed()
      .slice(runStart)
      .findLast(({ message }) => message.role === 'assistant')?.message
    const stop = turnStopReason(event.aborted, reply?.role === 'assistant' ? reply.stopReason : undefined)
    await completeTurn(host, stop)
    host.ui.invalidate()
    // pi may have switched sessions meanwhile, which makes ctx stale; the title is the session's own.
    if (context === ctx) await recordTitle(host, session)
    for (const resolve of settled.splice(0)) resolve()
  })

  pi.on('session_shutdown', async (event, ctx) => {
    context = ctx
    const session = ctx.sessionManager.getSessionId()
    const child = !!stateFor(session).binding?.child
    // pi tells a stopping subagent of its end before it stops the run, so the run would go on working
    // meanwhile: it is stopped here, and its turn recorded as cancelled once it settles.
    if (child && !ctx.isIdle()) {
      const settling = new Promise<void>((resolve) => settled.push(resolve))
      ctx.abort()
      await Promise.race([settling, host.clock.sleep(SUBAGENT_SETTLE_MS).catch(() => {})])
      if (stateFor(session).currentTurnId !== undefined) await completeTurn(host, 'cancelled')
    }
    await recordCommitted(host)
    stopPluginUpdates()
    stopChildTurn()
    // The threads this session runs stop first, and their mounts go only once they have exited.
    // A call that ran one answers that the session ended, which ends the turn that made it; the turn
    // settles before the session's runtime goes.
    if ((await endThreadRuns(host, session, stateFor(session).binding)) && !ctx.isIdle()) {
      const settling = new Promise<void>((resolve) => settled.push(resolve))
      await Promise.race([settling, host.clock.sleep(SUBAGENT_SETTLE_MS).catch(() => {})])
    }
    forgetThreadNotes(session)
    // Records still queued get a bounded chance to reach Delta before pi switches or exits, once an
    // automatic activation still connecting the session has finished; the outbox keeps whatever is
    // left for the session's next activation.
    if (activation.session === session) {
      await settleActivation(host, session, child ? SUBAGENT_ACTIVATION_MS : 10_000)
      // Records a failed write kept in memory go to the outbox first; this runtime ends with the session.
      await flushUnsaved(host, session).catch((error: unknown) =>
        debug(`Delta records not yet saved were lost with the session: ${errorText(error)}`),
      )
      await deliverWithin(host, session, child ? SUBAGENT_DELIVERY_MS : 5_000).catch(() => {})
    }
    await forgetSessionStart(host, session)
    cancelRequestsOf(session, event.targetSessionFile)
    withdrawParent(host)
    const runtime = stateFor(session)
    const binding = runtime.binding
    endActivationOf(session)
    resetRuntime(runtime)
    await stopWatching(session)
    forgetContract(session)
    clearProgress(host)
    if (event.reason !== 'reload') await markEnded(host, session)
    // A subagent's own checkout is released before its pi exits, so whatever started it may remove it.
    if (event.reason !== 'reload') await releaseChildCheckout(host, binding)
    await releaseOnEnd(host, session, event.reason)
    forgetRuntime(session, runtime)
    tui = undefined
    context = undefined
  })
}
