# Upstream inventory: `delta-claude`

This extension is a port of Zed Industries' Delta plugin for Claude Code,
[`delta-claude`](https://github.com/zed-industries/delta-claude). This folder is the record of what that
plugin does and how each part of it is placed here, so that work on this extension is grounded in the
upstream source rather than in an agent's memory. The rule it serves: nothing is added, removed or changed
here unless `delta-claude` has done the same, or it cannot exist in pi and a file here says why.

Built from `delta-claude` at commit `ac769c681ba7a95ec7347b591f0858857a1a9e80` (`ac769c6`, plugin 0.1.32,
`main`, 2026-10-30). The pin itself lives in `UPSTREAM` at the checkout root; `test/upstream.test.ts` checks
this file agrees with it. `scripts/upstream-diff.sh` says whether upstream has moved since.

## How to use this folder

- Before changing behaviour, read the feature file for the area in `features/`, find the upstream module in
  the map below, and work from it. The workflow is in `.agents/skills/delta-claude-parity/SKILL.md`.
- When upstream moves, update the files for the affected features and the pin together.
- Every module under `src/` must appear in this folder, in backticks, so a new module forces a parity
  decision; the test enforces it.

## Status words

| Status | Meaning |
| --- | --- |
| ported | The module's logic is upstream's, with its names and tests; differences are pi's types and syntax. |
| adapted | The behaviour is upstream's, reached through what pi provides instead of Claude Code; the feature file names both sides. |
| replaced | A local module stands in for an engine service Claude Code gives plugins (`$.clock`, `$.fs`, `$.process`, `$.store`, `ui.render`). |
| not ported | Upstream has it and this extension does not; the feature file says why. |

## Module map

Upstream paths are under `hooks/` in `delta-claude`; local paths are under this checkout. Each file's header
comment says what it holds (`head -8 src/*/*.ts`).

| Upstream | Local | Status | Feature file |
| --- | --- | --- | --- |
| `hooks/register.tsx` | `index.ts` | adapted | [core](features/core.md) |
| `hooks/band/band.tsx` | `src/band/band.ts` | adapted | [band](features/band.md) |
| `hooks/band/plugin-update.tsx` | `src/band/status.ts`, `src/updates/updates.ts` | adapted | [updates](features/updates.md) |
| `hooks/band/status.ts` | `src/band/status.ts` | ported | [band](features/band.md) |
| `hooks/cli/auth.ts` | `src/cli/auth.ts` | ported | [setup](features/setup.md) |
| `hooks/cli/cli.ts` | `src/cli/cli.ts` | ported | [cli](features/cli.md) |
| `hooks/cli/command-outcomes.ts` | `src/cli/command-outcomes.ts` | ported | [cli](features/cli.md) |
| `hooks/cli/command-reader.ts` | `src/cli/command-reader.ts` | ported | [cli](features/cli.md) |
| `hooks/cli/delta-cli.ts` | `src/cli/delta-cli.ts` | ported | [cli](features/cli.md) |
| `hooks/cli/install-update.ts` | `src/cli/install-update.ts` | ported | [updates](features/updates.md) |
| `hooks/cli/thread-commands.ts` | `src/cli/thread-commands.ts` | ported | [cli](features/cli.md) |
| `hooks/cli/windows-install.ts` | `src/cli/windows-install.ts` | ported | [cli](features/cli.md) |
| `hooks/core/binding.ts` | `src/core/binding.ts` | ported | [core](features/core.md) |
| `hooks/core/compatibility.ts` | `src/core/compatibility.ts` | adapted | [core](features/core.md) |
| `hooks/core/host.ts` | `src/core/host.ts` | adapted | [core](features/core.md) |
| `hooks/core/installation.ts` | `src/core/installation.ts` | ported | [updates](features/updates.md) |
| `hooks/core/json.ts` | `src/core/json.ts` | ported | [core](features/core.md) |
| `hooks/core/paths.ts` | `src/core/paths.ts` | ported | [core](features/core.md) |
| `hooks/core/session-state.ts` | `src/core/session-state.ts` | adapted | [core](features/core.md) |
| `hooks/core/text.ts` | `src/core/text.ts` | ported | [core](features/core.md) |
| `hooks/core/transcript.ts` | none | not ported | [core](features/core.md) |
| `hooks/plugin-update/catalog.ts` | `src/updates/updates.ts` | adapted | [updates](features/updates.md) |
| `hooks/plugin-update/updates.ts` | `src/updates/updates.ts` | adapted | [updates](features/updates.md) |
| `hooks/recording/bash.ts` | `src/recording/content.ts` | adapted | [recording](features/recording.md) |
| `hooks/recording/content.ts` | `src/recording/content.ts` | adapted | [recording](features/recording.md) |
| `hooks/recording/delivery-policy.ts` | `src/recording/delivery-policy.ts` | ported | [recording](features/recording.md) |
| `hooks/recording/delivery.ts` | `src/recording/delivery.ts` | adapted | [recording](features/recording.md) |
| `hooks/recording/outbox.ts` | `src/recording/outbox.ts` | ported | [recording](features/recording.md) |
| `hooks/recording/prompt.ts` | `src/recording/prompt.ts` | adapted | [recording](features/recording.md) |
| `hooks/recording/snapshot.ts` | `src/recording/snapshot.ts` | adapted | [sharing](features/sharing.md) |
| `hooks/recording/title.ts` | `src/recording/title.ts` | adapted | [recording](features/recording.md) |
| `hooks/recording/tool-records.ts` | `src/recording/delivery.ts` | adapted | [recording](features/recording.md) |
| `hooks/setup/activation.ts` | `src/setup/activation.ts` | adapted | [setup](features/setup.md) |
| `hooks/setup/commands.ts` | `src/setup/commands.ts` | adapted | [commands](features/commands.md) |
| `hooks/setup/delta-menu.ts` | `src/setup/delta-menu.ts` | adapted | [commands](features/commands.md) |
| `hooks/setup/interaction.ts` | `src/setup/interaction.ts` | adapted | [setup](features/setup.md) |
| `hooks/setup/organizations.ts` | `src/setup/organizations.ts` | ported | [setup](features/setup.md) |
| `hooks/setup/project-policy.ts` | `src/setup/project-policy.ts` | ported | [setup](features/setup.md) |
| `hooks/setup/setup.ts` | `src/setup/setup.ts` | ported | [setup](features/setup.md) |
| `hooks/sharing/checkout.ts` | `src/sharing/checkout.ts` | ported | [sharing](features/sharing.md) |
| `hooks/sharing/handoff.ts` | none | not ported | [joining](features/joining.md) |
| `hooks/sharing/join.ts` | `src/sharing/join.ts` | adapted | [joining](features/joining.md) |
| `hooks/sharing/lifecycle.ts` | `src/sharing/lifecycle.ts` | adapted | [joining](features/joining.md) |
| `hooks/sharing/share-audience.ts` | `src/sharing/share-audience.ts` | ported | [sharing](features/sharing.md) |
| `hooks/sharing/share.ts` | `src/sharing/share.ts` | ported | [sharing](features/sharing.md) |
| `hooks/subagents/children.ts` | `src/subagents/children.ts` | adapted | [subagents](features/subagents.md) |
| `hooks/subagents/delta-threads.ts` | none | not ported | [subagents](features/subagents.md) |
| `hooks/subagents/git-worktrees.ts` | none | not ported | [subagents](features/subagents.md) |
| `hooks/subagents/org-agents.ts` | none | not ported | [subagents](features/subagents.md) |
| `hooks/subagents/subagents.ts` | `src/subagents/subagents.ts` | adapted | [subagents](features/subagents.md) |
| `hooks/subagents/thread-runs.ts` | none | not ported | [subagents](features/subagents.md) |
| `hooks/watch/conversation.ts` | `src/watch/conversation.ts` | ported | [watch](features/watch.md) |
| `hooks/watch/presence.ts` | `src/watch/presence.ts` | ported | [watch](features/watch.md) |
| `hooks/watch/row-delivery.ts` | `src/watch/rows.ts` | adapted | [watch](features/watch.md) |
| `hooks/watch/rows.tsx` | `src/watch/rows.ts`, `src/band/renderers.ts` | adapted | [watch](features/watch.md) |
| `hooks/watch/watch.ts` | `src/watch/watch.ts` | ported | [watch](features/watch.md) |

Local modules with no upstream counterpart, each standing in for an engine service Claude Code provides:

| Local | Replaces | Feature file |
| --- | --- | --- |
| `src/core/clock.ts` | `$.clock` (timers that never keep the process alive) | [core](features/core.md) |
| `src/core/files.ts` | `$.fs` (private, atomic writes of the extension's own files) | [core](features/core.md) |
| `src/core/process.ts` | `$.process.run` and `$.process.spawn` | [core](features/core.md) |
| `src/core/store.ts` | `$.store` (one private JSON file per key) | [core](features/core.md) |
| `src/band/renderers.ts` | `ui.render` of `CommandOutput`, `UserMessage` and the band's notes | [watch](features/watch.md) |

## Tests

Upstream keeps unit tests beside each module (`hooks/<area>/<module>.test.ts`) and engine tests in
`hooks/register.test.ts` and a few feature files, run by `claude plugin test`. Here the unit tests are in
`test/` under the module's name, and `test/e2e` drives the real `pi --mode rpc` against the fake CLI in
`test/e2e/bin/delta` in place of the engine test kit. Upstream's CLI fixtures (`hooks/testing/fixtures/cli`)
are copied byte for byte to `test/fixtures/cli`; `scripts/upstream-diff.sh --sync-fixtures` refreshes them.

Upstream unit tests without a local file, because the module they test is not ported or is folded into
another: `auth.test.ts`, `install-update.test.ts`, `transcript.test.ts`, `catalog.test.ts`, `bash.test.ts`,
`snapshot.test.ts`, `title.test.ts`, `tool-records.test.ts`, `register.test.ts`, `auto.test.ts`,
`organization.test.ts`, `handoff.test.ts`, `join.test.ts`, `lifecycle.test.ts`, `children.test.ts`,
`delta-threads.test.ts`, `git-worktrees.test.ts`, `org-agents.test.ts`, `row-delivery.test.ts`. The e2e
tests cover the ported behaviour of `auth`, `title`, `join` and `lifecycle`; `auth`, `install-update`,
`snapshot` and `title` are candidates for porting as unit tests.

## Upstream material outside `hooks/`

| Upstream | Here |
| --- | --- |
| `.claude-plugin/plugin.json`, `marketplace.json`, `icon.png` | `package.json` (`pi.extensions`), published to npm as `@nothumanwork/pi-delta`. No marketplace. |
| `README.md` | `README.md`, with a section on what differs from the plugin. |
| `AGENTS.md`, `.agents/skills/style-guide`, `.agents/skills/land` | `AGENTS.md`; Prettier instead of the style guide's hand formatting; no land flow (one branch, `main`). |
| `release-notes/*.md` | None. Upstream's notes describe each change; read them when syncing. |
| `scripts/sync-cli-fixtures` | `scripts/upstream-diff.sh --sync-fixtures` (copies from the upstream clone, not from a Delta checkout). |
| `scripts/check-*.py`, `check-windows-setup.ps1` | Not ported: they drive the installed `claude` binary. `test/e2e` covers the equivalent flows in pi. |
| `.github/workflows/ci.yml` | None. |
