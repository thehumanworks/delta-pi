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
| ported | 138 |
| covered | 51 |
| missing | 228 |
| unsupported | 26 |
| not-applicable | 66 |
<!-- parity-summary:end -->

Most missing tests are upstream's engine tests (`register.test.ts`, `setup/auto.test.ts`,
`sharing/join.test.ts`, `cli/auth.test.ts`), which run the whole plugin in Claude Code's test kit. Their
counterpart here is the in-process kit in `test/kit`, which runs the whole extension against a fake pi on
a clock the test moves; porting them onto it is the main remaining work. `test/behaviour` holds the
first ones, written for the defects below.

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
| Title Claude chose for the session | pi's session name, else the first prompt's first line | `test/e2e/recording.test.ts` |
| Claude's `Agent` subagents | pi processes a recorded session starts, linked through `DELTA_PI_PARENT` | `test/behaviour/subagents.test.ts`, `test/e2e/collaboration.test.ts` |
| Marketplace self-update | npm check and `pi update <source>` | `test/updates.test.ts` |
| Paths as Claude's tools resolve them | Paths as pi's tools resolve them (`@`, `~`, `file://`) | `test/content.test.ts` |
| Notices in Claude Code's transcript | Notes in pi's transcript; notifications in RPC; stderr in print mode | `test/e2e/accounts.test.ts` |

## Not provided

Each is a capability, not a host difference; the record marks their tests **unsupported**.

- Claude Code Desktop's hand-off of a join to a new Desktop session.
- Following a conversation Claude moves to a background session (`/background`).
- Running a Delta thread as a subagent through `SendMessage`.
- Recording subagents that started before the session was recorded.
- Nesting: a subagent's own subagents record under the top-level session's thread, not under the
  subagent that started them.

## Known differences

What an audit of the port against upstream found and this port has not changed, with why:

- **A subagent's session ends without waiting for Delta to release its own checkout.** Upstream waits,
  so the code that started the subagent can then remove its worktree safely. Not done yet.
- **Remote rows are drawn as they first arrived.** A teammate's later edit or removal reaches the model
  as a correction, but the row drawn for the person is not redrawn, and quoted comment context is cut
  for a 100-column width. Upstream redraws from the live thread. Not done yet.
- **A remote row pi fails to add is still counted as added.** pi's `sendMessage` reports its failures on
  pi's own error channel, not to the caller; a row lost to a failing session file is not offered again.
- **Two writes to one file in the same turn** can record the second's patch against the file before
  both, since the prior contents are read when each call starts, not in pi's mutation queue.
- **Records a failing disk could not save** are flushed when the session ends; if the disk still fails,
  they are lost with the session's runtime. Upstream keeps them for the life of the process.
- **A joined session is not moved when its thread's worktrees change.** It is told their new paths;
  `/delta-join` again opens a session in the thread's folder. pi keeps one directory per session, where
  Claude Code moves its own.
- **A message Delta cannot translate is logged and skipped.** Recording goes on with the next message
  rather than pausing; the debug log says which. Upstream pauses capture on a failed local write, as this
  port does, but has no translation step that can fail.
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
