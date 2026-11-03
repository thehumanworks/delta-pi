/**
 * The thread's title: the session's pi name when it has one, else the first line of its first
 * prompt, as Delta's own threads are named for what they were asked.
 */
import { isJsonObject, jsonText } from '../core/json.ts'
import type { Host } from '../core/host.ts'
import { load, report, save, serial, stateFor } from '../core/session-state.ts'
import { cutsSurrogatePair } from '../core/text.ts'
import { conversationText } from '../watch/conversation.ts'
import { drain, stageRecord } from './delivery.ts'

/** A thread title keeps at most this much. */
export const TITLE_LIMIT = 200
/** A title taken from a prompt keeps at most this much, as pi's own session list shows one. */
const PROMPT_TITLE_LIMIT = 80

/** One line of at most `limit` characters, or undefined when nothing is left. */
export function cleanTitle(title: string | undefined, limit = TITLE_LIMIT): string | undefined {
  const line = conversationText(title ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!line) return
  if (line.length <= limit) return line
  const end = cutsSurrogatePair(line, limit - 1) ? limit - 2 : limit - 1
  return `${line.slice(0, end)}…`
}

/** The title a prompt gives a session that has no name: its first nonblank line. */
export function promptTitle(text: string): string | undefined {
  const line = text.split('\n').find((part) => part.trim())
  return cleanTitle(line, PROMPT_TITLE_LIMIT)
}

/** The title of a session pi has not named: its first prompt's. */
export function firstPromptTitle(host: Host): string | undefined {
  for (const message of host.session.messages()) {
    const value = message as { role?: string; content?: unknown }
    if (value.role !== 'user') continue
    const text =
      typeof value.content === 'string'
        ? value.content
        : Array.isArray(value.content)
          ? value.content
              .flatMap((block) => (isJsonObject(block) && block.type === 'text' ? [jsonText(block.text)] : []))
              .join('\n')
          : ''
    return promptTitle(text)
  }
}

/**
 * Record the session's title for its thread when it changed since the last one recorded. Only a
 * shared session names its thread; a joined session takes part in someone else's, and a subagent's
 * thread keeps the name it was created with. Nothing here can fail a turn or sharing: a title that
 * cannot be staged is skipped, and the next turn's end tries again.
 */
export async function recordTitle(host: Host, session: string) {
  const binding = stateFor(session).binding
  if (!binding?.snapshot || binding.joined || binding.child) return
  const title = cleanTitle(host.session.name()) ?? (binding.title === undefined ? firstPromptTitle(host) : undefined)
  if (title === undefined || title === binding.title) return
  try {
    const staged = await serial(async () => {
      const current = await load(host, session)
      if (!current.snapshot || current.joined || current.title === title) return false
      await save(host, {
        ...(await stageRecord(host, current, { update: { sessionUpdate: 'session_info_update', title } })),
        title,
      })
      return true
    })
    // Once staged, the title is delivered and reported like every other record.
    if (staged) void drain(host, session).catch((error: unknown) => report(host, error))
  } catch (error) {
    host.ui.debug(`Couldn't record this session's title: ${String(error)}`)
  }
}
