# Style guide

Conventions for this repository's TypeScript, adapted from the upstream plugin's
(`.agents/skills/style-guide/SKILL.md` in `zed-industries/delta-claude`) so the two read alike. Where a rule
is checked mechanically, it says by what; the rest is for review. Where these rules and the code around
you say nothing, choose the simplest thing that works: a little repetition beats an abstraction with one
caller.

## Seams

- Only `index.ts` sees pi's runtime. Features take `host: Host` (`src/core/host.ts`) and reach pi and the
  machine only through it, or through the narrower hosts built from it (`SetupEnv`, `Interaction`,
  `AuthenticationHost`, `UpdateHost`) so tests can substitute them. Add no others. *ESLint:
  `no-restricted-imports`, `no-restricted-properties`, `no-restricted-globals`.*
- Time comes from `host.clock`, programs run through `host.process`, the environment is `host.env`, and
  files go through `src/core/files.ts` or `host.store`. *ESLint.*
- A Delta command runs through a `src/cli` function, which labels it as pi's for Delta's telemetry and
  checks its answer. *ast-grep `delta-commands-in-cli`; every behaviour test's `expectClean()`.*
- Import statically, and import types with `type`. *ESLint `no-restricted-syntax`; TypeScript
  `verbatimModuleSyntax`.*

## State

- Module state is per session runtime (pi re-evaluates modules for each). Only the mount registry, the
  join contracts and the installer claim live on `globalThis`. *ast-grep `global-state-in-registries`.*
- A module variable lives in the module that changes it. If another module needs to change it, move it
  there, or call a function that does a whole step.
- `SessionState`, `requests` and `activation` in `session-state.ts` are shared per-session records:
  features write their fields, and `session-state.ts` clears them.
- After an `await` that can yield to another event, check the work is still current
  (`stillActive(session)`, `feed.revision`). Long-running work takes a `check` that stops it once it is
  not, as mounts do.
- Model a lifecycle with phases as a discriminated union changed only by named transitions
  (`feed.connection` in `watch.ts`); independent flags stay flags.

## Types

- `type` aliases for object shapes.
- Parse untrusted input as `unknown` and narrow it with the `src/core/json.ts` guards. `any` appears only
  in tests and fakes. *ESLint `no-unsafe-*` and `no-explicit-any` outside `test/`.*
- `as` for `as const`, or with a comment saying why the type holds.
- Narrow locally rather than with a `!` whose reason is far away.
- A `switch` over a union is exhaustive. *ESLint `switch-exhaustiveness-check`.*

## Errors

- Name error classes `…Error`, and add one only when a caller checks it with `instanceof`.
- Throw in feature code, and turn errors into a note or a refusal at the event. Handlers that record or
  observe fail open, so recording never blocks someone's work; prompt admission fails closed.
- No promise is left floating, and a catch callback takes `unknown`. *ESLint `no-floating-promises`,
  `no-misused-promises`, `use-unknown-in-catch-callback-variable`.*
- An error rewrapped in a catch keeps its cause. *ESLint `preserve-caught-error`.*
- A discarded `.finally()` raises its promise's rejection unobserved; use `.then(done, done)`. *ast-grep
  `no-discarded-finally`.*
- An empty `catch` says why it is empty. *ESLint `no-empty`.* A `.catch(() => {})` that drops a side
  effect's failure says why that is safe; stopping a process or waiting for something to finish need not.
- Show a person `errorText(error)`; `String(error)` suits the debug log only. *ast-grep
  `error-text-for-people`.*
- User-facing text is product copy: change it only on purpose, and keep each string on one line so it
  can be found by searching for it.

## Names and comments

- `host` is the `Host`, `session` a pi session ID, `thread` a Delta thread ID.
- A module starts with a comment saying what it holds, so `head -6 src/*/*.ts` maps the code.
- A comment moves with its code and stays true there. Check a claim about pi against its types or
  source (`node_modules/@earendil-works/pi-coding-agent/dist`) before writing it.

## Tests

- Unit-test a pure module directly, in `test/<module>.test.ts`.
- Test behaviour with the kit (`test/kit`) in `test/behaviour/<feature>.test.ts`: drive prompts, commands
  and session switches, move the clock with `advance`, wait for one condition with `until`, and end with
  `expectClean()`. Make the fake CLI fail or hold a command with `world().fail` and `world().hold`.
- An end-to-end test (`test/e2e`) is for what only the real pi can show: event order, RPC dialogs, print
  mode, session files. Each starts real pi processes, so keep them few.
- A fix comes with a test that fails without it.
- When a test covers an upstream test, record it in `parity/upstream-tests.json`.

## Formatting

Prettier formats everything: no semicolons, single quotes, two-space indentation, trailing commas,
120 columns. *`npm run format`; CI runs `format:check`.*
