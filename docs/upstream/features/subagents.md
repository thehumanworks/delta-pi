# Subagents: child threads, thread runs and worktrees

Built from `delta-claude` at `ac769c6`. Upstream modules: `hooks/subagents/subagents.ts`, `children.ts`,
`thread-runs.ts`, `delta-threads.ts`, `git-worktrees.ts`, `org-agents.ts`.

## What upstream does

- Each subagent Claude runs with the `Agent` tool is recorded into a child thread of the session's
  thread, through an outbox of its own, exactly as the session's conversation is: `turn.start`,
  `turn.complete`, `session.append` and `tool.call` events with an `agentId` route to
  `startChildTurn`, `completeChildTurn`, `recordChildRow` and `recordChildToolCall`. `followAgentCall`
  tells a foreground subagent from a background one. Child bindings survive restarts (`children.ts`).
- An isolated subagent gets a Git worktree; `git-worktrees.ts` reads what git says of it, and the plugin
  attaches that checkout to the child thread while it runs, moving Claude's worktree aside under a
  `.claude-worktree` suffix and restoring it after (`restoreClaudeWorktree`,
  `restoreAbandonedWorktrees`). `org-agents.ts` leaves the worktrees of agents the organization provides
  as Claude made them, since the organization guard keeps plugins out of such agents.
- `thread-runs.ts` and `delta-threads.ts` run the Delta conversation's other threads here as Claude
  subagents: a `SendMessage` (`session.send`) that names a thread of the conversation, or a Delta link,
  runs that thread as a subagent, hands it about 25k tokens of the thread's history, and reports Delta's
  agent's turn back to the parent. A session started after `/clear` or a resume is told which threads it
  can message. Subagents a session ran before it was shared are adopted into child threads.
- Children show in the band under the people listed.

## What upstream does not do

- It does not record subagents that finished before the session was shared, beyond adopting their
  transcripts.
- It does not give a subagent the parent's conversation beyond what Claude does.

## Here

| Upstream | Local | Status |
| --- | --- | --- |
| `hooks/subagents/subagents.ts` | `src/subagents/subagents.ts` | adapted |
| `hooks/subagents/children.ts` | `src/subagents/children.ts` | adapted (only the `Entry` type) |
| `hooks/subagents/thread-runs.ts` | none | not ported |
| `hooks/subagents/delta-threads.ts` | none | not ported |
| `hooks/subagents/git-worktrees.ts` | none | not ported |
| `hooks/subagents/org-agents.ts` | none | not ported |

- Pi has no subagents of its own: extensions run them as separate pi sessions, usually separate `pi`
  processes. A recorded session exports its thread to everything it starts through the
  `DELTA_PI_PARENT` environment variable (`exportParent`/`withdrawParent`). A pi session that starts
  empty with that variable set, while the parent is still live, records into a child thread under the
  parent's (`beginChild`, `ensureChildThread`), named for its first prompt or `DELTA_PI_SUBAGENT_NAME`,
  its prompts shown as sent by the parent (`sentBy`). The child's turns are followed through
  `followChildTurn`/`stopChildTurn`. A child inside the parent's checkout shares its worktrees; one in a
  checkout of its own, such as a Git worktree, attaches that checkout to its thread while it runs. A link
  in an environment that outlives its session records nothing once that session has ended.
- Not ported, for want of a pi equivalent: running a Delta thread as a subagent through `SendMessage`
  (`thread-runs.ts`, `delta-threads.ts`), moving and restoring Claude's isolated worktrees
  (`git-worktrees.ts`, and the CLI helpers `threadMergeCommandLine`, `stopWorktreeMount`,
  `checkoutSyncing`), the organization-agent exemption (`org-agents.ts`), and adopting subagents that
  finished before a session was shared.

## Divergences

None recorded.
