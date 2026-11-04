# Recording: turns, rows, delivery and titles

Built from `delta-claude` at `ac769c6`. Upstream modules: `hooks/recording/content.ts`, `bash.ts`,
`tool-records.ts`, `delivery.ts`, `delivery-policy.ts`, `outbox.ts`, `prompt.ts`, `title.ts`.

## What upstream does

- A recorded session's conversation is translated into Delta's ACP updates: prompts, replies, thinking,
  tool calls and their results, edits as diffs, and Claude's bash-mode rows (`bash.ts` turns
  `<bash-input>`/`<bash-stdout>`/`<bash-stderr>` into fenced Markdown). Only authored rows and tool results
  are captured, never the engine's model-only framing (attachments, hook context, compaction summaries,
  the Skill tool's body, the organization's notes), and never the plugin's own rows.
- `tool-records.ts` pairs a `tool.call` hook's structured result with the `tool-result` row Claude stores,
  which arrive in either order; unpaired halves are forgotten one turn later.
- A turn runs from `turn.start` to `turn.complete`; the finish record carries how the turn ended
  (`end_turn`, `cancelled`, `error`). Records are staged in a per-session outbox (JSONL, split under
  Delta's 16 MiB limit without cutting surrogate pairs) and delivered in order with `thread append`,
  retried per `delivery-policy.ts`, with checkout verification before each turn and pauses when
  verification fails. A session keeps recording while Delta is unreachable and uploads when it is back.
- When Delta refuses offline changes because someone else changed the thread, the state is
  `refusedOffline`, and the band offers **Fork & Restore** (fork into a kept thread, then discard) or
  **Discard**.
- `prompt.submit` admits a prompt only when the turn it starts can be recorded: it drops the prompt
  while a join or share is in flight, after a join failure, while worktrees restore or Claude is moved
  to the thread folder, while delivery is paused, while the watcher is not ready, and when another
  participant owns the turn. Each drop has a fixed sentence.
- The thread title is Claude's title for the session, read from the transcript file during the first
  turn as soon as Claude replies, or a `/rename` since; at most 200 characters. A title that arrives
  before the thread exists waits with the other records.

## What upstream does not do

- It does not record subagents' rows into the parent thread (they have child threads; see
  [subagents](subagents.md)).
- It does not roll back tool effects when a turn is stopped by a takeover.

## Here

| Upstream | Local | Status |
| --- | --- | --- |
| `hooks/recording/content.ts` | `src/recording/content.ts` | adapted |
| `hooks/recording/bash.ts` | `src/recording/content.ts` | adapted (pi's `bashExecution` messages) |
| `hooks/recording/tool-records.ts` | `src/recording/delivery.ts` | adapted |
| `hooks/recording/delivery.ts` | `src/recording/delivery.ts` | adapted |
| `hooks/recording/delivery-policy.ts` | `src/recording/delivery-policy.ts` | ported |
| `hooks/recording/outbox.ts` | `src/recording/outbox.ts` | ported |
| `hooks/recording/prompt.ts` | `src/recording/prompt.ts` | adapted |
| `hooks/recording/title.ts` | `src/recording/title.ts` | adapted |

- A Delta turn runs from pi's `agent_start` to `agent_settled`; the stop reason comes from the last
  assistant message's `stopReason` and the settled event's `aborted` flag.
- Pi's `message_end` delivers a message with its tool result and details in one event, so there is no
  pairing table. The one thing read before the result is a `write` tool's prior file content
  (`rememberPriorFile` on `tool_call`), so the edit records as a patch (`usePatchBuilder` with pi's
  `generateUnifiedPatch`).
- Framing kept out of the record: pi's compaction and branch summaries, other extensions' context
  messages (`isOwnContext`), and the remote rows this extension adds.
- Prompt admission runs on pi's `input` event. A refused prompt's text is put back into the editor with
  the reason as a note. The sentences are upstream's with "pi" for "Claude"; there is no drop for
  "moving Claude to the thread folder" because a join opens a new session instead.
- The title is pi's session name when set (`session_info_changed`), else the first line of the first
  prompt, sent after each turn and when the name changes. There is no transcript-file reader.
- `/delta resolve` runs the Fork & Restore or Discard choice the band's buttons run upstream; see
  [band](band.md).

## Divergences

None recorded.
