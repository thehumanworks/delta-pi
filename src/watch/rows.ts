/**
 * The watched thread's items and comments in pi's context: rows held while pi's own turn runs, then
 * added between turns as custom messages the model reads and the person sees drawn under their author.
 */
import type { Host } from '../core/host.ts'
import { ledgerKey, stateFor } from '../core/session-state.ts'
import type { WatchComment, WatchItem } from '../cli/thread-commands.ts'
import { REMOTE_MESSAGE } from '../recording/content.ts'
import { personKey, toolCallParts } from '../band/status.ts'
import {
  addRows,
  commentAction,
  commentAuthor,
  commentKey,
  commentMarkdown,
  commentQuote,
  isDrawnItem,
  isEventItem,
  itemAuthor,
  itemMarkdown,
  keyedComment,
  type PendingRow,
  type QuotedLine,
  type RemoteView,
} from './conversation.ts'
import { feed, watchedSession } from './watch.ts'

/**
 * What a remote row draws for the person, saved with the row so it draws the same after a restart or
 * resume. Only what is drawn is kept; the model reads the row's own text. `id` is the item's, or the
 * comment's key, and `thread` the thread it is in: while the watch holds that thread, the row draws
 * the item as it is now (`liveDisplay`), so a teammate's edit or removal redraws it.
 */
export type RemoteDisplay = (
  | { kind: 'message'; author: string; person: string; agent: boolean; markdown: string }
  | { kind: 'tool'; author: string; person: string; name: string; detail?: string; status?: string }
  | { kind: 'event'; markdown: string }
  | {
      kind: 'comment'
      author: string
      person: string
      action: string
      reply: boolean
      routed: boolean
      /** The quoted context, each passage with up to QUOTE_ROOM of its line around it; drawing fits it to the row. */
      quote: QuotedLine[]
      markdown: string
    }
  | { kind: 'context' }
) & { id?: string; thread?: string }

/** How much of a quoted passage's line a saved row keeps, more than any terminal row shows. */
const QUOTE_ROOM = 1_000

/** The pass adding the watched thread's completed items to pi's context, while one runs. */
export let settling: Promise<void> | undefined
/** The last notice a failed pass showed, so the same failure is shown once. */
let settleNotice: string | undefined

/** Rows wait while pi's own turn runs or a local prompt is entering, so they never land inside a turn. */
export function rowsHeld(session: string, host?: Host) {
  const runtime = stateFor(session)
  return !!runtime.currentTurnId || !!runtime.promptEntering || (host !== undefined && !host.session.idle())
}

/** A hidden row for the model's context, held back while a turn runs so it never lands inside one. */
export async function deliverNote(host: Host, session: string, text: string) {
  const runtime = stateFor(session)
  runtime.notes.push(text)
  if (!rowsHeld(session, host)) flushNotes(host, session)
}

/** Add the notes held for a session to the model's context, in order. */
function flushNotes(host: Host, session: string) {
  const runtime = stateFor(session)
  for (const text of runtime.notes.splice(0)) {
    host.ui.debug(`Adding a row to pi's context: ${text.split('\n', 1)[0]}`)
    host.pi.sendMessage<RemoteDisplay>(
      { customType: REMOTE_MESSAGE, content: text, display: false, details: { kind: 'context' } },
      { triggerTurn: false },
    )
  }
}

/**
 * Abandon the rows a stopped conversation was still adding. They were not added, so the next
 * snapshot offers them again. Returns the pass still running, whose save must finish before a new
 * watch loads or writes the ledger.
 */
export function stopRows(): Promise<void> | undefined {
  const running = settling
  settling = undefined
  settleNotice = undefined
  return running
}

/** What an item draws for the person, from the view the watch keeps. */
function itemDisplay(item: WatchItem, thread: string): RemoteDisplay | undefined {
  if (!isDrawnItem(item)) return
  const row = { id: item.id, thread }
  if (isEventItem(item)) return { kind: 'event', markdown: itemMarkdown(item, thread), ...row }
  const person = personKey(item.author ?? { user_id: null, name: itemAuthor(item) })
  if (item.kind === 'tool_call') {
    const { name, detail, status } = toolCallParts(item)
    return {
      kind: 'tool',
      author: itemAuthor(item),
      person,
      name,
      ...(detail ? { detail } : {}),
      ...(status ? { status } : {}),
      ...row,
    }
  }
  return {
    kind: 'message',
    author: itemAuthor(item),
    person,
    agent: item.kind !== 'user_message',
    markdown: itemMarkdown(item, thread),
    ...row,
  }
}

/** What a comment draws for the person: its author and action, the passage it is about, and its text. */
function commentDisplay(view: RemoteView, comment: WatchComment): RemoteDisplay {
  const parent = view.commentParent(comment)
  const target = view.commentTarget(comment)
  return {
    kind: 'comment',
    author: commentAuthor(comment),
    person: personKey(comment.author),
    action: commentAction(comment, parent, target),
    reply: comment.chain !== comment.id,
    routed: !!comment.routed_to,
    quote: commentQuote(comment, parent, target, view.items, QUOTE_ROOM),
    markdown: commentMarkdown(comment, view.thread),
    id: commentKey(comment.id),
    thread: view.thread,
  }
}

/**
 * What a drawn row shows now. While the watch holds the row's thread, that is the item or comment as
 * it is now, nothing (`gone`) once it was removed, emptied, or is missing from a complete snapshot,
 * and what was saved while its snapshot is still arriving. Otherwise, as after a restart before the
 * watch is back, it is what was saved. `sources` are the objects the answer was made from, so a
 * renderer redraws only when one of them is replaced.
 */
export function liveDisplay(saved: RemoteDisplay): { display: RemoteDisplay | 'gone'; sources: unknown[] } {
  const view = feed.view
  if (!view || saved.id === undefined || saved.thread !== view.thread) return { display: saved, sources: [saved] }
  if (view.wasRemoved(saved.id)) return { display: 'gone', sources: [view, 'removed'] }
  const commentId = keyedComment(saved.id)
  if (commentId !== undefined) {
    const comment = view.comments.get(commentId)
    if (!comment) return view.snapshotDone ? { display: 'gone', sources: [view] } : { display: saved, sources: [saved] }
    const target = view.commentTarget(comment)
    const quoted = target?.kind === 'transcript' && target.item_id !== null ? view.items.get(target.item_id) : undefined
    return {
      display: commentDisplay(view, comment),
      sources: [comment, view.commentParent(comment), view.comments.get(comment.chain), quoted],
    }
  }
  const item = view.items.get(saved.id)
  if (!item) return view.snapshotDone ? { display: 'gone', sources: [view] } : { display: saved, sources: [saved] }
  return { display: itemDisplay(item, view.thread) ?? 'gone', sources: [item] }
}

/**
 * Add one model-visible row, drawn for the person when it is an item's first appearance. Pi keeps the
 * row as a custom message: the model reads its text, and its details say what the person sees.
 */
function appendRow(host: Host, row: PendingRow): { deny?: string } {
  const view = feed.view
  let display: RemoteDisplay | undefined
  if (row.commandItem !== undefined && view) {
    const commentId = keyedComment(row.commandItem)
    const comment = commentId === undefined ? undefined : view.comments.get(commentId)
    const item = view.items.get(row.commandItem)
    display = comment ? commentDisplay(view, comment) : item ? itemDisplay(item, view.thread) : undefined
  }
  host.pi.sendMessage<RemoteDisplay>(
    {
      customType: REMOTE_MESSAGE,
      content: row.text,
      display: display !== undefined,
      details: display ?? { kind: 'context' },
    },
    { triggerTurn: false },
  )
  return {}
}

/**
 * Add completed remote items to pi's context as model-visible rows, without starting a turn, and
 * correct rows for items that later changed or disappeared. Held rows resume when the prompt is
 * dropped or its turn completes.
 */
export function settleRemote(host: Host, session: string): Promise<void> | undefined {
  if (settling || watchedSession() !== session) return settling
  const revision = feed.revision
  const owns = () => feed.revision === revision && watchedSession() === session
  let task: Promise<void> | undefined = undefined
  task = (async () => {
    // Start after `task` is assigned, so a run with nothing to do still clears `settling`.
    await Promise.resolve()
    try {
      if (!rowsHeld(session, host)) flushNotes(host, session)
      const view = feed.view
      if (view)
        await addRows(view, {
          append: async (row) => appendRow(host, row),
          save: (ledger) => host.store.set(ledgerKey(session), ledger),
          held: () => rowsHeld(session, host),
          current: owns,
          announce: (text) => host.ui.note(text),
          debug: (text) => host.ui.debug(text),
          fail: (reason) => settleFailure(host, reason),
        })
    } finally {
      if (settling === task) settling = undefined
    }
    if (owns() && feed.view && !feed.view.settled && !rowsHeld(session, host)) await settleRemote(host, session)
  })()
  settling = task
  return task
}

function settleFailure(host: Host, reason: string) {
  const notice = `Couldn't add Delta activity to pi's context: ${reason}. It is offered again when the watcher reconnects.`
  if (settleNotice === notice) return
  settleNotice = notice
  host.ui.note(notice, 'warning')
}
