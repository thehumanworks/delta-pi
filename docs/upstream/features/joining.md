# Joining: `/delta join`, mounts and hand-offs

Built from `delta-claude` at `ac769c6`. Upstream modules: `hooks/sharing/join.ts`, `handoff.ts`,
`lifecycle.ts`.

## What upstream does

- `/delta join <link-or-thread-id>` checks the thread (`joinPreflight` refuses one without access or with
  no worktrees), mounts its worktrees with `thread mount`, then moves Claude into the thread's folder
  between turns with `/clear` followed by `/cd`. Prompts are dropped while the move is pending. Until the
  transition completes, a prompt is refused with "The Delta join directory transition is incomplete. Run
  /delta-join … to retry".
- A joined session's conversation so far reaches Claude's context; teammates' rows follow live (see
  [watch](watch.md)). Resuming a joined session later mounts its worktrees again (`beginRestore`), and
  the band says when they are restored. When the thread's worktrees change, `refreshMounts` and
  `scheduleMove` move Claude to the new folder.
- `lifecycle.ts`: clearing and resuming switch sessions and keep the mounts; only exiting
  (`prompt_input_exit`, `logout`, `other`) releases them.
- Claude Code Desktop cannot `/cd`, so `handoff.ts` hands the join to a new Desktop session: the tab
  mounts the thread, writes a hand-off record every Claude process can read (five-minute expiry), and
  opens Desktop's new-session screen on the thread's folder with "Join this Delta thread." filled in.
  Sending it starts a session that claims the record in `session.start` and joins in place.
- `/delta-join` typed without a link opens the menu's join step instead of failing.

## What upstream does not do

- It does not join from a headless session.
- It does not join while a turn is running or a prompt is being entered.

## Here

| Upstream | Local | Status |
| --- | --- | --- |
| `hooks/sharing/join.ts` | `src/sharing/join.ts` | adapted |
| `hooks/sharing/handoff.ts` | none | not ported |
| `hooks/sharing/lifecycle.ts` | `src/sharing/lifecycle.ts` | adapted |

- Pi works in one directory per session, so a join starts a new pi session in the thread's folder: it
  mounts the thread for that session, writes the session file there, and switches pi into it with
  `switchSession`. The new session finishes joining before its first prompt (`completeJoinTransition`);
  the session that joined stays as it was, and `/resume` takes you back. There is no `/clear` + `/cd`
  move, so `scheduleMove` has no counterpart: a joined session whose thread's worktrees change is told
  their new paths but is not moved; `/delta-join` again opens a session there.
- `handoff.ts` is not ported: there is no Desktop to hand off to.
- `lifecycle.ts` keeps `joinPreflight` and the changed-worktree computation; mounts are released on
  pi's `session_shutdown` reasons rather than Claude's exit reasons.
- `/delta-join` needs a command context (`replace`) to switch sessions; from anywhere else it answers
  "Run /delta-join from pi's command line to join a thread."

## Divergences

None recorded.
