/**
 * The watched thread's items and comments in pi's context: rows held while pi's own turn runs, then
 * added between turns as custom messages the model reads and the person sees drawn under their author.
 */
import type { Host } from "../core/host.ts";
import { ledgerKey, stateFor } from "../core/session-state.ts";
import type { WatchComment, WatchItem } from "../cli/thread-commands.ts";
import { REMOTE_MESSAGE } from "../recording/content.ts";
import { personKey, toolCallParts } from "../band/status.ts";
import {
  addRows,
  commentAction,
  commentAuthor,
  commentMarkdown,
  commentQuote,
  isDrawnItem,
  isEventItem,
  itemAuthor,
  itemMarkdown,
  keyedComment,
  type PendingRow,
  type QuotedLine,
} from "./conversation.ts";
import { feed, watchedSession } from "./watch.ts";

/**
 * What a remote row draws for the person, saved with the row so it draws the same after a restart or
 * resume. Only what is drawn is kept; the model reads the row's own text.
 */
export type RemoteDisplay =
  | { kind: "message"; author: string; person: string; agent: boolean; markdown: string }
  | { kind: "tool"; author: string; person: string; name: string; detail?: string; status?: string }
  | { kind: "event"; markdown: string }
  | {
      kind: "comment";
      author: string;
      person: string;
      action: string;
      reply: boolean;
      routed: boolean;
      quote: QuotedLine[];
      markdown: string;
    }
  | { kind: "context" };

/** The pass adding the watched thread's completed items to pi's context, while one runs. */
export let settling: Promise<void> | undefined;
/** The last notice a failed pass showed, so the same failure is shown once. */
let settleNotice: string | undefined;

/** Rows wait while pi's own turn runs or a local prompt is entering, so they never land inside a turn. */
export function rowsHeld(session: string, host?: Host) {
  const runtime = stateFor(session);
  return !!runtime.currentTurnId || !!runtime.promptEntering || (host !== undefined && !host.session.idle());
}

/** A hidden row for the model's context, held back while a turn runs so it never lands inside one. */
export async function deliverNote(host: Host, session: string, text: string) {
  const runtime = stateFor(session);
  runtime.notes.push(text);
  if (!rowsHeld(session, host)) flushNotes(host, session);
}

/** Add the notes held for a session to the model's context, in order. */
function flushNotes(host: Host, session: string) {
  const runtime = stateFor(session);
  for (const text of runtime.notes.splice(0)) {
    host.ui.debug(`Adding a row to pi's context: ${text.split("\n", 1)[0]}`);
    host.pi.sendMessage<RemoteDisplay>(
      { customType: REMOTE_MESSAGE, content: text, display: false, details: { kind: "context" } },
      { triggerTurn: false },
    );
  }
}

/**
 * Abandon the rows a stopped conversation was still adding. They were not added, so the next
 * snapshot offers them again. Returns the pass still running, whose save must finish before a new
 * watch loads or writes the ledger.
 */
export function stopRows(): Promise<void> | undefined {
  const running = settling;
  settling = undefined;
  settleNotice = undefined;
  return running;
}

/** What an item draws for the person, from the view the watch keeps. */
function itemDisplay(item: WatchItem, thread: string): RemoteDisplay | undefined {
  if (!isDrawnItem(item)) return;
  if (isEventItem(item)) return { kind: "event", markdown: itemMarkdown(item, thread) };
  const person = personKey(item.author ?? { user_id: null, name: itemAuthor(item) });
  if (item.kind === "tool_call") {
    const { name, detail, status } = toolCallParts(item);
    return {
      kind: "tool",
      author: itemAuthor(item),
      person,
      name,
      ...(detail ? { detail } : {}),
      ...(status ? { status } : {}),
    };
  }
  return {
    kind: "message",
    author: itemAuthor(item),
    person,
    agent: item.kind !== "user_message",
    markdown: itemMarkdown(item, thread),
  };
}

/** What a comment draws for the person: its author and action, the passage it is about, and its text. */
function commentDisplay(comment: WatchComment): RemoteDisplay | undefined {
  const view = feed.view;
  if (!view) return;
  const parent = view.commentParent(comment);
  const target = view.commentTarget(comment);
  return {
    kind: "comment",
    author: commentAuthor(comment),
    person: personKey(comment.author),
    action: commentAction(comment, parent, target),
    reply: comment.chain !== comment.id,
    routed: !!comment.routed_to,
    quote: commentQuote(comment, parent, target, view.items, 100),
    markdown: commentMarkdown(comment, view.thread),
  };
}

/**
 * Add one model-visible row, drawn for the person when it is an item's first appearance. Pi keeps the
 * row as a custom message: the model reads its text, and its details say what the person sees.
 */
function appendRow(host: Host, row: PendingRow): { deny?: string } {
  const view = feed.view;
  let display: RemoteDisplay | undefined;
  if (row.commandItem !== undefined && view) {
    const commentId = keyedComment(row.commandItem);
    const comment = commentId === undefined ? undefined : view.comments.get(commentId);
    const item = view.items.get(row.commandItem);
    display = comment ? commentDisplay(comment) : item ? itemDisplay(item, view.thread) : undefined;
  }
  host.pi.sendMessage<RemoteDisplay>(
    {
      customType: REMOTE_MESSAGE,
      content: row.text,
      display: display !== undefined,
      details: display ?? { kind: "context" },
    },
    { triggerTurn: false },
  );
  return {};
}

/**
 * Add completed remote items to pi's context as model-visible rows, without starting a turn, and
 * correct rows for items that later changed or disappeared. Held rows resume when the prompt is
 * dropped or its turn completes.
 */
export function settleRemote(host: Host, session: string): Promise<void> | undefined {
  if (settling || watchedSession() !== session) return settling;
  const revision = feed.revision;
  const owns = () => feed.revision === revision && watchedSession() === session;
  let task: Promise<void> | undefined = undefined;
  task = (async () => {
    // Start after `task` is assigned, so a run with nothing to do still clears `settling`.
    await undefined;
    try {
      if (!rowsHeld(session, host)) flushNotes(host, session);
      const view = feed.view;
      if (view)
        await addRows(view, {
          append: async (row) => appendRow(host, row),
          save: (ledger) => host.store.set(ledgerKey(session), ledger),
          held: () => rowsHeld(session, host),
          current: owns,
          announce: (text) => host.ui.note(text),
          debug: (text) => host.ui.debug(text),
          fail: (reason) => settleFailure(host, reason),
        });
    } finally {
      if (settling === task) settling = undefined;
    }
    if (owns() && feed.view && !feed.view.settled && !rowsHeld(session, host)) await settleRemote(host, session);
  })();
  settling = task;
  return task;
}

function settleFailure(host: Host, reason: string) {
  const notice = `Couldn't add Delta activity to pi's context: ${reason}. It is offered again when the watcher reconnects.`;
  if (settleNotice === notice) return;
  settleNotice = notice;
  host.ui.note(notice, "warning");
}
