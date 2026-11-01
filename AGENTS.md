# Delta for pi

A pi extension that records pi sessions to Delta threads through the `delta` CLI. It is a port of
Zed Industries' Delta plugin for Claude Code (`github.com/zed-industries/delta-claude`, commit `ac769c6`);
most of `src/` keeps that plugin's structure, names and comments, so a change upstream can be found and
followed here. `README.md` lists what was adapted and what was not ported.

- `index.ts` binds pi's events, commands and UI to a `Host` (`src/core/host.ts`); nothing else imports pi's
  runtime context.
- Pi re-evaluates extension modules for every session runtime (jiti `moduleCache: false`), so module state
  is per session. Only what must outlive a session switch lives on `globalThis`: mount processes
  (`src/cli/delta-cli.ts`) and a join's verified contract (`src/sharing/join.ts`).
- Delta's recording contract: `delta --json thread contract`; the extension speaks version 8.

Before finishing a change, run:

```sh
npm run check
npm test
npx --yes prettier@3 --write index.ts "src/**/*.ts" "test/**/*.ts"
```

End-to-end tests (`test/e2e`) drive the real `pi --mode rpc` against the fake CLI in `test/e2e/bin/delta`;
when the extension starts running a new CLI command, teach the fake that command in the shape of
`test/fixtures/cli`. Never point a test at a real Delta account. Don't edit the fixtures by hand: they are
the upstream plugin's copies of native CLI output.
