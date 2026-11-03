# Delta for pi

A pi extension that records pi sessions to Delta threads through the `delta` CLI. It is a port of
Zed Industries' Delta plugin for Claude Code (`github.com/zed-industries/delta-claude`, commit `ac769c6`);
most of `src/` keeps that plugin's structure, names and comments, so a change upstream can be found and
followed here. [PARITY.md](PARITY.md) says what follows upstream, what differs and what is missing;
[docs/architecture.md](docs/architecture.md) maps the code; [docs/style-guide.md](docs/style-guide.md) is
the conventions, and which of them lint, ast-grep and the tests check.

- `index.ts` binds pi's events, commands and UI to a `Host`, and the machine to a `Platform`
  (`src/core/host.ts`); nothing else reaches pi or the machine directly.
- Pi re-evaluates extension modules for every session runtime (jiti `moduleCache: false`), so module state
  is per session. Only what must outlive a session switch lives on `globalThis`: mount processes
  (`src/cli/delta-cli.ts`) and a join's verified contract (`src/sharing/join.ts`).
- Delta's recording contract: `delta --json thread contract`; the extension speaks version 8.

Before finishing a change, run `npm run format`, then `npm run verify`: the format check, type check,
ESLint, the ast-grep rules and their tests, and every test. On NixOS without nix-ld the pinned ast-grep
cannot run; run `nix shell nixpkgs#ast-grep -c npm run verify` and the scripts use that one. Before a
release, also run `npm run test:package`.

Tests:

- A fix comes with a test that fails without it. Test behaviour in `test/behaviour` with the in-process kit
  (`test/kit`), and only what needs the real pi in `test/e2e`.
- There is one fake Delta CLI, `test/fake-delta/cli.ts`, which the kit calls and `test/e2e/bin/delta`
  wraps. When the extension starts running a new CLI command, teach the fake that command in the shape of
  `test/fixtures/cli`. Never point a test at a real Delta account. Don't edit the fixtures by hand: they
  are the upstream plugin's copies of native CLI output.
- When a test covers one of upstream's, record it in `parity/upstream-tests.json`; `test/parity.test.ts`
  checks the record. `PARITY.md` says how to follow a new upstream commit.
