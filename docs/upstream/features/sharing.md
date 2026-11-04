# Sharing: `/delta share`, the audience and the checkout

Built from `delta-claude` at `ac769c6`. Upstream modules: `hooks/sharing/share.ts`, `share-audience.ts`,
`checkout.ts`, `hooks/recording/snapshot.ts`.

## What upstream does

- `/delta share` creates or attaches the session's thread, exports the conversation so far, publishes it
  to the chosen audience, and from then on each turn is recorded live. It needs an interactive surface
  (terminal or Desktop tab) and an idle turn; "Wait for the current Claude turn to finish before
  sharing." otherwise. The band offers **Share after this turn** while a turn runs.
- `share-audience.ts` asks who should see the session: the team (the repository's or current
  organization), just you, or people named by email. Addresses typed after the command answer the
  question up front: `/delta share ada@example.com` invites them directly.
- `snapshot.ts` exports the conversation Claude still sees (`$.session.messages({ as: 'api' })`),
  dropping whole framing blocks it can identify.
- `checkout.ts` identifies the session's local worktree, attaches it to the thread, and keeps a
  `worktree mount` running while the session runs, restored when the session resumes. The mount is
  connection-owned: when the session ends, even abruptly, Delta stops syncing the checkout.
- A share that needs sign-in asks before opening the browser and keeps recording locally meanwhile; a
  share or join started while sign-in waits offers to stop waiting instead.
- Telemetry: the share carries `DELTA_CLI_COMMAND_FORM` saying whether it came from `/delta-share` or
  `/delta share`.

## What upstream does not do

- It does not share headless sessions (print mode, SDK, cloud runners).
- It does not change an already shared thread's audience from the band; `/delta share` again does.

## Here

| Upstream | Local | Status |
| --- | --- | --- |
| `hooks/sharing/share.ts` | `src/sharing/share.ts` | ported |
| `hooks/sharing/share-audience.ts` | `src/sharing/share-audience.ts` | ported |
| `hooks/sharing/checkout.ts` | `src/sharing/checkout.ts` | ported |
| `hooks/recording/snapshot.ts` | `src/recording/snapshot.ts` | adapted |

- The snapshot exports every message on pi's current branch (`sessionManager.getBranch()`), compaction or
  not, newest 4096 at most, so the thread starts with the whole conversation rather than what the model
  still sees.
- "Interactive" is pi's `hasUI`: the TUI or an RPC client that shows dialogs. The idle check is
  `context.isIdle()`.
- A session recorded as a subagent under its parent's thread refuses to share: "This session is a
  subagent recorded under its parent's Delta thread." (no upstream equivalent, since Claude's subagents
  have no command line).

## Divergences

None recorded.
