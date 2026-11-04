# Delta for pi

A pi extension that records pi sessions to Delta threads through the `delta` CLI. It is a port of
Zed Industries' Delta plugin for Claude Code (`github.com/zed-industries/delta-claude`); the pinned
upstream commit lives in `UPSTREAM` (currently `ac769c6`). Most of `src/` keeps that plugin's structure,
names and comments, so a change upstream can be found and followed here.

The extension must not drift from the plugin: add, remove or change behaviour only when `delta-claude`
has, or when pi cannot express it and `docs/upstream/` records why. `docs/upstream/` maps every upstream
module to its local module and status; read the feature file there before changing behaviour, and
follow `.agents/skills/delta-claude-parity/SKILL.md`. `scripts/upstream-diff.sh` says whether upstream
has moved past the pin; `test/upstream.test.ts` keeps the pin, the documents and the inventory in step.

- `index.ts` binds pi's events, commands and UI to a `Host` (`src/core/host.ts`); nothing else imports pi's
  runtime context.
- Pi re-evaluates extension modules for every session runtime (jiti `moduleCache: false`), so module state
  is per session. Only what must outlive a session switch lives on `globalThis`: mount processes
  (`src/cli/delta-cli.ts`) and a join's verified contract (`src/sharing/join.ts`).
- Delta's recording contract: `delta --json thread contract`; the extension speaks version 8.

When `nix` is available, run every project command (npm, npx, node, pi, tsc, the tests) inside the
flake's development shell, from the checkout root: `nix develop -c <command>`. The shell pins Node,
installs the locked dev dependencies and puts `node_modules/.bin` on `PATH`. Without `nix`, run the
commands directly.

Before finishing a change, run:

```sh
nix develop -c npm run check
nix develop -c npm test
nix develop -c npx --yes prettier@3 --write index.ts "src/**/*.ts" "test/**/*.ts"
```

End-to-end tests (`test/e2e`) drive the real `pi --mode rpc` against the fake CLI in `test/e2e/bin/delta`;
when the extension starts running a new CLI command, teach the fake that command in the shape of
`test/fixtures/cli`. Never point a test at a real Delta account. Don't edit the fixtures by hand: they are
the upstream plugin's copies of native CLI output.
