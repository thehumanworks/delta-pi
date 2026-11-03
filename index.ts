/**
 * Delta for pi: records pi sessions to Delta threads, shares them, and joins teammates' threads,
 * through the `delta` CLI. A port of Zed Industries' Delta plugin for Claude Code.
 *
 * Copyright (C) 2026 Zed Industries. Licensed under the GNU Affero General Public License, version 3
 * only (AGPL-3.0-only); see LICENSE.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
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
import type { TUI } from '@earendil-works/pi-tui'
import { systemClock } from './src/core/clock.ts'
import { piVersionWarning } from './src/core/compatibility.ts'
import { type AskRequest, type Host, InteractionUnavailableError, type NoteTone } from './src/core/host.ts'
import { run, spawn } from './src/core/process.ts'
import {
  activation,
  cancelRequestsOf,
  endActivationOf,
  markEnded,
  resetRuntime,
  sessions,
  stateFor,
} from './src/core/session-state.ts'
import { writeExclusive } from './src/core/files.ts'
import { fileStore } from './src/core/store.ts'
import { errorText } from './src/core/text.ts'
import { forgetContract } from './src/cli/delta-cli.ts'
import { BandWidget, bandText, clearProgress } from './src/band/band.ts'
import { type Note, renderNote, renderRemote } from './src/band/renderers.ts'
import { isOwnContext, REMOTE_MESSAGE } from './src/recording/content.ts'
import {
  completeTurn,
  deliverWithin,
  recordMessage,
  rememberPriorFile,
  startTurn,
  usePatchBuilder,
} from './src/recording/delivery.ts'
import { admitPrompt } from './src/recording/prompt.ts'
import { recordTitle } from './src/recording/title.ts'
import { beginSession, forgetSessionStart, settleActivation, useDataDirectory } from './src/setup/activation.ts'
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
import { stopChildTurn, withdrawParent } from './src/subagents/subagents.ts'
import { startPluginUpdates, stopPluginUpdates } from './src/updates/updates.ts'
import type { RemoteDisplay } from './src/watch/rows.ts'
import { stopWatching } from './src/watch/watch.ts'

const ROOT = dirname(fileURLToPath(import.meta.url))
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { name: string; version: string }
/** The custom entry type of the notes Delta leaves for the person. */
const NOTE_ENTRY = 'delta-note'
/** The debug log moves aside to `debug.log.1` past this size. */
const DEBUG_LOG_LIMIT = 2 * 1024 * 1024

export default function delta(pi: ExtensionAPI) {
  const dataDir = join(getAgentDir(), 'delta')
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
  const note = (text: string, tone: NoteTone = 'info') => {
    debug(`note: ${text}`)
    if (!context) return
    pi.appendEntry<Note>(NOTE_ENTRY, { text, tone })
    // A client without pi's terminal draws no entries, so it hears each note as a notification.
    if (context.hasUI && context.mode !== 'tui') context.ui.notify(text, tone)
  }
  const host: Host = {
    pi,
    dataDir,
    plugin: { name: MANIFEST.name, version: MANIFEST.version, root: ROOT },
    clock: systemClock,
    process: { run, spawn },
    store: fileStore(join(dataDir, 'store')),
    env: {
      windows: () => process.platform === 'win32',
      home: () => process.env.HOME ?? process.env.USERPROFILE,
    },
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
      copy: async (text) => {
        try {
          await copyToClipboard(text)
          return true
        } catch {
          return false
        }
      },
      open: async (url) => {
        const attempts =
          process.platform === 'win32'
            ? [['rundll32', 'url.dll,FileProtocolHandler', url]]
            : process.platform === 'darwin'
              ? [['open', url]]
              : [['xdg-open', url]]
        for (const argv of attempts) {
          const opened = await run(argv, { timeoutMs: 5_000 }).catch(() => ({ exitCode: 1 }))
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
    await beginSession(host, session)
  })

  pi.on('session_info_changed', async (_event, ctx) => {
    context = ctx
    await recordTitle(host, ctx.sessionManager.getSessionId())
  })

  /** Say why a prompt was not submitted, and give the person their text back to send again. */
  const refuse = (ctx: ExtensionContext, text: string, reason: string, tone: NoteTone) => {
    note(reason, tone)
    if (ctx.mode === 'tui' && !ctx.ui.getEditorText().trim()) ctx.ui.setEditorText(text)
  }
  pi.on('input', async (event, ctx) => {
    context = ctx
    try {
      const refusal = await admitPrompt(host, event.text, event.streamingBehavior !== undefined)
      if (refusal === undefined) return { action: 'continue' }
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

  pi.on('agent_start', async (_event, ctx) => {
    context = ctx
    await startTurn(host)
  })

  /** Why the turn's last reply ended, for its finish record. */
  let lastStop: string | undefined
  pi.on('message_end', async (event, ctx) => {
    context = ctx
    const message = event.message as AgentMessage & { role: string; stopReason?: string }
    if (isOwnContext(message)) return
    if (message.role === 'assistant') lastStop = message.stopReason
    try {
      await recordMessage(host, message, crypto.randomUUID())
    } catch (error) {
      debug(`Recording a message failed: ${errorText(error)}`)
    }
  })

  pi.on('tool_call', async (event, ctx) => {
    context = ctx
    if (event.toolName === 'write') await rememberPriorFile(host, event.toolCallId, event.input)
  })

  pi.on('agent_settled', async (event, ctx) => {
    context = ctx
    const stop = event.aborted ? 'cancelled' : lastStop === 'error' ? 'error' : 'end_turn'
    lastStop = undefined
    await completeTurn(host, stop)
    await recordTitle(host, ctx.sessionManager.getSessionId())
  })

  pi.on('session_shutdown', async (event, ctx) => {
    context = ctx
    const session = ctx.sessionManager.getSessionId()
    stopPluginUpdates()
    stopChildTurn()
    // Records still queued get a bounded chance to reach Delta before pi switches or exits, once an
    // automatic activation still connecting the session has finished; the outbox keeps whatever is
    // left for the session's next activation.
    if (activation.session === session) {
      await settleActivation(host, session, 10_000)
      await deliverWithin(host, session, 5_000).catch(() => {})
    }
    await forgetSessionStart(host, session)
    cancelRequestsOf(session)
    withdrawParent()
    const runtime = stateFor(session)
    endActivationOf(session)
    resetRuntime(runtime)
    await stopWatching(session)
    forgetContract(session)
    clearProgress(host)
    if (event.reason !== 'reload') await markEnded(host, session)
    await releaseOnEnd(host, session, event.reason)
    sessions.delete(session)
    tui = undefined
    context = undefined
  })
}
