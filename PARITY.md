# Parity with the Delta plugin for Claude Code

This extension is a port of Zed Industries' [Delta plugin for Claude Code](https://github.com/zed-industries/delta-claude).
This file says what that means precisely: which upstream behaviour it follows, how that is checked, where
pi's host makes it behave differently, and what is not done yet.

| | |
| --- | --- |
| Upstream | `zed-industries/delta-claude` at `ac769c6` (plugin 0.1.32), its `main` |
| Recording contract | version 8 (`delta --json thread contract`), Delta 0.22.0 or newer |
| pi | 1.4.0, the version `package.json` pins; CI also runs the tests against the latest pi |
| Node | 22.19.0 or newer |

## How parity is checked

Upstream specifies its behaviour in 509 test cases (counting each parameter of a parameterised test).
[`parity/upstream-tests.json`](parity/upstream-tests.json) records, for each one, how this port covers it:

- **ported**: the same test, adapted only where pi's names differ, in `ours`.
- **covered**: a test of ours that checks the same behaviour another way, usually because pi's host
  shapes it differently, in `ours`.
- **missing**: applies to pi, and no test checks it yet. The behaviour may well work; nothing proves it.
- **unsupported**: a capability this port does not provide (see [Not provided](#not-provided)).
- **not-applicable**: a Claude Code feature pi has no equivalent of, such as Claude Code Desktop's tabs or
  its transcript files.

Each entry gives its reason. Three checks keep the record honest:

- `test/parity.test.ts` (in `npm test`) fails if a test the record names does not exist here, or a gap
  gives no reason.
- `node scripts/parity.mjs <upstream checkout>` compares the record with upstream's tests: at `ac769c6`
  it matches exactly. Run it when following upstream (below).
- The end-to-end tests run the real pi; `RECORDED_TURNS` in `test/world.ts` is asserted of both the real
  pi and the in-process kit's fake pi, so the fake cannot drift from pi unseen.

<!-- parity-summary:start -->
| Status | Upstream tests |
| --- | --- |
| ported | 331 |
| covered | 72 |
| missing | 36 |
| unsupported | 1 |
| not-applicable | 69 |
<!-- parity-summary:end -->

Every upstream test that applies to pi is ported or covered: the whole-plugin tests (`register.test.ts`,
`setup/auto.test.ts`, `sharing/join.test.ts`, `cli/auth.test.ts`, `subagents/children.test.ts`) run on the
in-process kit in `test/kit` (`test/behaviour`), which runs the whole extension against a fake pi on a
clock the test moves, and the pure modules' tests are unit tests in `test/`. The one **unsupported** test
and every **not-applicable** one give their reason in the record; [Not provided](#not-provided) and
[Known differences](#known-differences) below summarise them.

## Where pi's host differs

The recording, delivery, retry, watch, share, setup and sign-in logic is the plugin's. What Claude Code's
host provides differently is adapted:

| Claude Code plugin | This extension | Tested by |
| --- | --- | --- |
| `turn.start` / `turn.complete` hooks | A Delta turn runs from pi's `agent_start` to `agent_settled`; a turn ends `end_turn` only when its last reply stopped normally | `test/e2e/recording.test.ts`, `test/delivery.test.ts` |
| `session.append` rows | The messages pi committed to the session, read at the next event, so what is recorded is what the session keeps after every extension's `message_end`; the shell commands the person runs are among them | `test/e2e/recording.test.ts` |
| `prompt.submit` drop | pi's `input` event; a refused prompt goes back into the editor | `test/behaviour/recording.test.ts` |
| Remote rows drawn as the plugin's own command output | Custom messages with a renderer, held until pi settles | `test/rows.test.ts`, `test/e2e/recording.test.ts` |
| The band's buttons (copy link, share, Fork & Restore, Discard, Later) | `/delta copy`, `/delta share` (queued until a running turn ends), `/delta resolve`, `/delta-plugin-update later` | `test/link.test.ts`, `test/behaviour/sharing.test.ts`, `test/updates.test.ts` |
| `/clear` then `/cd` into the thread folder on join | A new pi session whose working directory is the thread folder; a join that cannot finish there retries in place | `test/behaviour/join.test.ts`, `test/e2e/collaboration.test.ts` |
| Title Claude chose for the session | pi's session name, else the first prompt's first line, recorded at a turn's first reply | `test/e2e/recording.test.ts`, `test/behaviour/turns.test.ts` |
| Claude's `Agent` subagents | pi processes a session starts, linked through `DELTA_PI_PARENT`; a subagent's own subagents nest under it | `test/behaviour/subagents.test.ts`, `test/e2e/collaboration.test.ts` |
| `SendMessage` to a Delta thread, run as a Claude subagent | The `delta_thread` tool, which runs the thread in a child `pi --mode json` and returns its reply | `test/behaviour/threads.test.ts`, `test/delta-threads.test.ts`, `test/e2e/collaboration.test.ts` |
| Claude Code's permission modes before a thread runs | The person is asked once per thread; the tool is offered only in interactive recorded sessions, never beyond the parent's own `--tools` | `test/behaviour/threads.test.ts` |
| Marketplace self-update | npm check and `pi update <source>` | `test/updates.test.ts` |
| Paths as Claude's tools resolve them | Paths as pi's tools resolve them (`@`, `~`, `file://`) | `test/content.test.ts` |
| Notices in Claude Code's transcript | Notes in pi's transcript; notifications in RPC; stderr in print and JSON modes | `test/e2e/accounts.test.ts`, `test/behaviour/organization.test.ts` |

## Not provided

- **Recording subagents that ended before their session was shared.** A session shared while a subagent
  runs records it from then on, its earlier runs included; one that already ended is not recorded. pi keeps
  no list of the processes a session started, and a subagent run with `--no-session`, as pi's own subagent
  example runs them, leaves no transcript once it exits. Upstream reads Claude Code's agent inventory and
  transcripts. (`subagents/children.test.ts > sharing records the subagents that already ran…`,
  **unsupported**.)

What upstream does in Claude Code features pi has no counterpart of is **not-applicable**, each with its
reason in the record: Claude Code Desktop's hand-off of a join to a new Desktop session (pi can only
replace the session in its own process), following a conversation Claude moves to a background session
(pi has no `/background` or agents overview), Claude's isolation worktrees, forks, teammates and managed
agents, its transcript files and title scanning, its plan approvals, its command-output rows, and the
`CLAUDE_CODE_REMOTE` host flag.

## Known differences

Where this port behaves differently from upstream on purpose or because pi makes it so, with why:

- **A joined session is not moved when its thread's worktrees change.** It is told their new paths;
  `/delta-join` again opens a session in the thread's folder. A pi session's working directory is fixed
  when its runtime is created, read-only to extensions, and only a command (never a watch event) can switch
  sessions.
- **Delta threads as subagents** (`delta_thread`): the tool waits for the thread's reply and returns it,
  where upstream returns at once and the reply arrives as a new prompt; a message to a thread whose run is
  still going is refused, where upstream feeds it to the running subagent; the thread's history reaches
  the child after its message, not before (pi's `before_agent_start` adds context after the prompt); a
  message starting with `/` is refused, since pi would run it as a command; subagents other extensions
  start are not resumed by a message; and an `--api-key` given on the parent's command line is not passed
  on, since it would show in the process list.
- **A remote row whose session file write fails** stays in this process's context and is counted as added;
  it is offered again only when the session resumes. pi's `sendMessage` reports a failed write on pi's own
  error channel, not to the caller; a row pi did not add at all is offered again.
- **A drawn remote row after a restart** shows its saved display until the watch is back, and nothing once
  a complete snapshot lacks it, where upstream shows a placeholder.
- **Two shares cannot start in the same Windows session from different folders**: pi fixes a session's
  folder when it starts, so upstream's tests of a share whose folder changes during installation do not
  apply.
- **The once-per-repository setup offer** is claimed by a read and a write, so two sessions starting at
  the same moment may both offer it. Inherited from upstream.

## Following upstream

1. Check out upstream at the new commit and run `node scripts/parity.mjs <checkout>`. It lists the new
   and removed upstream tests.
2. Diff the changed modules. Upstream is formatted by hand and this port by Prettier, so normalise both
   first: `npx prettier --config .prettierrc.json --stdin-filepath x.ts < <upstream module>`.
3. Port the change and its tests, add the new tests to the record, and update the header above.

At the time of writing, upstream's `develop` is one commit ahead of `main`: turn and thread summaries
generated with Claude Haiku, under recording contract 9. It is not released, needs a summarising model
pi would have to supply, and is not ported.
