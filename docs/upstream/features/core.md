# Core: engine binding, state and helpers

Built from `delta-claude` at `ac769c6`. Upstream modules: `hooks/register.tsx`, `hooks/core/*`.

## What upstream does

- `register.tsx` is the only file that sees Claude Code's engine `$`. It registers every hook with a
  `.catch`, binds a `Host` per hook call through `hostOf($)`, and routes events with an `agentId` to the
  subagent modules. Hooks: `session.start`, `session.attach`, `session.end`, `prompt.submit`,
  `turn.start`, `turn.complete`, `session.append` (doors prompt, command, response, tool-result,
  delivery, and tool-message except the Skill tool), `tool.call`, `session.send`, `config.set` for
  `theme`, `command.run` for each `/delta*` command, and `ui.render` for `AbovePrompt`,
  `AskUserQuestion`, `UserMessage` and `CommandOutput`.
- Every hook but `prompt.submit` fails open: a failure is logged to the debug log and Claude continues as
  if Delta were not installed. `prompt.submit` fails closed with a drop message.
- `core/host.ts` declares the engine calls the features may make, one literal call per member.
- `core/session-state.ts` holds per-session runtime state, the join and share in flight, checkout
  pauses, and loads and saves bindings one at a time through `$.store`.
- `core/compatibility.ts` warns when Claude Code is older than 2.1.303 without blocking.
- `core/transcript.ts` locates Claude Code's transcript file for a session (under `projects/`), used to
  read titles and continuation records when the organization guard keeps `classic.*` hooks away.
- `core/binding.ts`, `core/json.ts`, `core/paths.ts`, `core/text.ts`, `core/installation.ts`: binding
  sequence checks, JSON narrowing, Windows path keys, error text, and the process-wide installer slot.

## What upstream does not do

- It never reaches Node, DOM or npm APIs; everything goes through `$`.
- It keeps no `Host` in a module variable: `$` carries the calling hook's context.

## Here

| Upstream | Local | Status |
| --- | --- | --- |
| `hooks/register.tsx` | `index.ts` | adapted |
| `hooks/core/host.ts` | `src/core/host.ts` | adapted |
| `hooks/core/session-state.ts` | `src/core/session-state.ts` | adapted |
| `hooks/core/compatibility.ts` | `src/core/compatibility.ts` | adapted |
| `hooks/core/transcript.ts` | none | not ported |
| `hooks/core/binding.ts`, `json.ts`, `paths.ts`, `text.ts`, `installation.ts` | same names under `src/core/` | ported |
| `$.clock` | `src/core/clock.ts` | replaced |
| `$.fs` | `src/core/files.ts` | replaced |
| `$.process` | `src/core/process.ts` | replaced |
| `$.store` | `src/core/store.ts` | replaced |

- `index.ts` binds pi's events to one `Host` per extension runtime: `session_start`, `session_info_changed`,
  `input`, `agent_start`, `message_end`, `tool_call`, `agent_settled`, `session_shutdown`, plus
  `registerCommand` for each `/delta*` command and renderers for Delta's own transcript entries. The
  hook table above maps as: `turn.start`/`turn.complete` to `agent_start`/`agent_settled`;
  `session.append` and `tool.call` results to `message_end`; `prompt.submit` to `input`; `session.end` to
  `session_shutdown`; `ui.render` to the band widget and the message and entry renderers. There is no
  `session.attach`, `session.send` or `config.set` equivalent.
- Pi re-evaluates the extension module per session runtime, so module state is per session. Only mount
  processes (`src/cli/delta-cli.ts`) and a join's verified contract (`src/sharing/join.ts`) live on
  `globalThis` to outlive a session switch.
- The fail-open rule is kept: recording failures are written to `debug.log` under the extension's data
  directory; a refused prompt (fail closed) is put back into pi's editor with the reason.
- `compatibility.ts` warns below pi 1.4.0 instead of Claude Code 2.1.303.
- `transcript.ts` is not ported: pi exposes the session through `sessionManager`, so titles and the
  conversation are read from pi, not from a transcript file. Continuations (Claude moving a conversation
  to a new session) do not exist in pi; see [setup](setup.md).

## Divergences

None recorded.
