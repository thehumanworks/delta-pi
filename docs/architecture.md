# Architecture

How the extension is put together: where pi ends and Delta's logic begins, how a session's conversation
reaches a Delta thread, and how a teammate's activity reaches pi. `head -6 src/*/*.ts` lists what each
module holds.

## Two seams

Everything the extension takes from outside comes through two types in `src/core/host.ts`:

- **`Host`**: what Delta's features reach in pi: the session (its ID, directory, committed messages,
  whether a person can answer), the running turn, the UI (questions, notes, the band), and the store.
- **`Platform`**: what it takes from the machine: the data directory, the clock, the process runner,
  the environment and the clipboard.

`index.ts` is the only module that sees pi's runtime: `createDelta(pi, platform)` binds pi's events,
commands and UI to a `Host`, and its default export passes `nodePlatform()`. Every other module takes a
`Host` (or one of the narrower hosts built from it, such as `UpdateHost` or `AuthenticationHost`) and
nothing else from outside. Lint keeps it so: only the modules that own a seam import `node:child_process`,
`node:fs` or pi's runtime, or read `process.env`, `Date.now` or Node's timers.

```
pi ──events, commands──▶ index.ts ──Host──▶ src/{recording,watch,sharing,setup,subagents,band,updates}
                                                    │
machine ◀──Platform (clock, processes, env)─────────┤
                                                    ▼
                                    src/cli ──delta --json …──▶ Delta CLI ──▶ DeltaDB
```

`src/cli` is the only place a Delta command line is built (ast-grep checks it): each operation is one
function, named after its subcommand, that labels the command as pi's for Delta's telemetry, runs it and
returns its answer already checked.

## State and lifetimes

pi evaluates the extension's modules afresh for every session runtime, so module state belongs to one
session. Across sessions and processes:

- The **store** (`host.store`, a private JSON file per key under `~/.pi/agent/delta/store`) holds each
  session's **binding**: its thread, its checkout, its turn executions, and the records not yet
  acknowledged.
- The **outbox** (`~/.pi/agent/delta/outbox/<session>/`) holds those records, written whole before they
  are sent.
- `globalThis` holds only what must outlive a session switch in the same process: the mount processes
  (`src/cli/delta-cli.ts`), a join's verified contract (`src/sharing/join.ts`), the claim of a running
  installer (`src/core/installation.ts`) and each session's delivery under way, which a resumed
  session's waits for (`src/core/session-state.ts`). ast-grep checks it.

Within a runtime, `src/core/session-state.ts` holds the per-session record each feature writes
(`SessionState`), the join and share in flight (`requests`), and `activation`: the session being
recorded and an epoch that every activation and end bumps. Work that awaits checks it is still current
afterwards (`stillActive(session)`), and long-running work takes a `check` that stops it once it is not;
a mount checks before it starts and again once it is ready.

## Recording a session

1. **Activation** (`src/setup/activation.ts`) decides at `session_start` whether the session records:
   it resumes a binding, finishes a join that switched into this session, records a subagent under its
   parent, or applies the repository's policy (`.delta/settings.json`) to a new session. Prompts wait for
   that decision (`captureDecided`), so nothing at the start is lost.
2. **Turns** (`src/recording/delivery.ts`): `agent_start` stages a turn's start, `agent_settled` its
   finish, with how it ended.
3. **Messages**: at each event after pi commits a message, `recordCommitted` reads the messages pi
   committed since it last looked and translates each into ACP updates (`src/recording/content.ts`):
   prompts, replies, thinking, tool calls, their results, edits as diffs, and the person's shell
   commands. Reading what pi committed, rather than the `message_end` payload, records what the session
   keeps after every extension has had its say, a redaction included.
4. **Delivery**: each update is staged in the outbox under the next sequence and delivered in order by
   `drain`, in bounded `thread append` batches. Failures are classified (`delivery-policy.ts`): a
   transient one retries with backoff on the clock, a permanent one pauses sharing and says what to do.
   A session recording into its own thread appends with local acknowledgement while Delta is
   unreachable; Delta's uploader publishes it later.

## Following a thread

`src/watch/watch.ts` keeps one `delta thread watch` running for the recorded or joined thread and
reconnects it. Its events update a `RemoteView` (`src/watch/conversation.ts`), which turns teammates'
items and comments into rows for the model and remembers what the model has read (the ledger), so a
reconnect adds only what is new or changed. `src/watch/rows.ts` adds the rows to pi's context as custom
messages, held while pi's own turn runs so they arrive between turns, and `src/band/` draws who is here
and what they are doing.

## Sharing, joining and subagents

- `/delta share` (`src/sharing/share.ts`) creates or attaches the session's thread, exports the
  conversation so far, attaches and mounts the checkout, and publishes to the chosen audience.
- `/delta join` (`src/sharing/join.ts`) mounts a thread's worktrees for a new pi session in the thread's
  folder and switches pi to it; that session finishes the join (`completeJoinTransition`).
- A recorded session exports its thread through `DELTA_PI_PARENT`; a pi process it starts records into
  a child thread (`src/subagents/subagents.ts`), sharing the parent's worktrees or attaching its own
  checkout.

## Tests

| Layer | Where | What it runs |
| --- | --- | --- |
| Unit | `test/*.test.ts` | Pure modules and single features against small fakes; many are upstream's, ported |
| Behaviour | `test/behaviour/` | The whole extension in process (`test/kit`): a fake pi raising pi's events, a clock the test moves, the fake CLI |
| End to end | `test/e2e/` | The real `pi --mode rpc`, with a faux model, against the fake CLI as a program |
| Package | `npm run test:package` | The packed release installed into a throwaway pi |

There is one fake Delta CLI, `test/fake-delta/cli.ts`, answering in the shapes of the CLI's own output
(`test/fixtures/cli`); the kit calls it in process and the end-to-end tests run it as `delta`. Tests can
make a command fail, hold, or answer something else, such as a lost reply after the work was done
(`world().fail`, `world().hold`, `world().answer`), and end or garble a watch (`world().endWatch`,
`world().remoteRaw`). In the kit, the extension's files go through `test/kit/disk.ts`, so a test can fail
or hold a store or outbox write (`kit.disk`), and `kit.programs` stands in for other programs, such as
`pi update`. `RECORDED_TURNS` is asserted of both the real
pi and the fake one, so the fake cannot drift unseen. [PARITY.md](../PARITY.md) maps upstream's tests to
these.

## Porting to another harness

What is specific to pi, and what a port to another coding agent would replace:

- `index.ts`: binding the harness's events, commands and UI to a `Host`. The events this needs are: a
  session starting and ending, a prompt being submitted (to refuse one), a run starting and settling,
  messages being committed, a tool about to write a file, and a way to add a message to the model's
  context between turns.
- `src/recording/content.ts`: translating the harness's messages and tools into ACP updates.
- `src/band/band.ts` and `src/band/renderers.ts`: drawing with the harness's UI components.
- `src/sharing/join.ts`'s switch into the thread's folder, and `src/subagents/`, which follow how the
  harness runs sessions and subagents.
- `src/updates/`: how the harness installs and updates extensions.
- `test/kit/pi.ts`: the fake harness the behaviour tests run on.

The rest (`src/cli`, delivery and the outbox, the watch and its rows, setup and the repository policy,
sharing's flow, the band's layout in `src/band/status.ts`) speaks only to the `Host` and the Delta CLI, and
carries over as it is.
