# CLI layer: finding and running `delta`

Built from `delta-claude` at `ac769c6`. Upstream modules: `hooks/cli/cli.ts`, `delta-cli.ts`,
`thread-commands.ts`, `command-outcomes.ts`, `command-reader.ts`, `windows-install.ts`;
fixtures in `hooks/testing/fixtures/cli`.

## What upstream does

- `cli.ts` discovers the `delta` executable (PATH, known install locations, the Windows registry) without
  starting Delta or downloading anything, including during resume. Installation on first use goes through
  Delta's official installer; on Windows through the Burn bundle script in `windows-install.ts`, with a
  lock file so two installs never run together. Background discovery never installs.
- `delta-cli.ts` has one function per CLI operation, named after its subcommand: `threadContract`,
  `orgCommand`/`orgList`/`orgCreate`/`orgInvite`, `authStatus`, `threadCreate`, `threadStatus`,
  `threadShare`, `threadInvite`, `threadMount`, `stopSessionMounts`, `stopThreadMounts`, `threadFork`,
  `threadDiscard`, `threadAppend`, `threadWatch`/`watchEvents`, `threadMergeCommandLine`, `worktreeList`,
  `worktreeCreate`, `worktreeAttach`, `worktreeMount`, `hasWorktreeMount`, `stopWorktreeMount`,
  `checkoutSyncing`. Each builds its arguments, runs `delta --json …`, and checks the answer.
- Every command carries `DELTA_CLI_INTEGRATION=claude_code`; a share or join also carries
  `DELTA_CLI_COMMAND_FORM` (`dedicated_command` or `delta_subcommand`) for Delta's telemetry.
- The recording contract: `delta --json thread contract` reports the versions the CLI speaks; the plugin
  speaks exactly version 8 (`PLUGIN_CONTRACT_MIN` = `PLUGIN_CONTRACT_MAX` = 8) and children version 7
  (`CHILD_CONTRACT_VERSION`). An older CLI is refused with "This Delta is too old for this plugin".
- `thread-commands.ts` parses and validates every JSON answer and `thread watch` frame, classifies
  failures as retryable or permanent from `error-codes.json`, and names the producer `claude-code`.
- `command-outcomes.ts` never assumes success from the exit code alone and refuses truncated output.
  `command-reader.ts` collects a streamed response, closing the child on timeout or cancellation.
- Only sign-in (`auth.ts`) and updates (`install-update.ts`) build a Delta command line anywhere else.

## What upstream does not do

- It does not hand-write CLI JSON: fixtures are copied from Delta's own repository by
  `scripts/sync-cli-fixtures`, and tests compare against them.
- It does not negotiate a contract above 8 or below 8.

## Here

| Upstream | Local | Status |
| --- | --- | --- |
| `hooks/cli/cli.ts` | `src/cli/cli.ts` | ported |
| `hooks/cli/delta-cli.ts` | `src/cli/delta-cli.ts` | ported |
| `hooks/cli/thread-commands.ts` | `src/cli/thread-commands.ts` | ported |
| `hooks/cli/command-outcomes.ts` | `src/cli/command-outcomes.ts` | ported |
| `hooks/cli/command-reader.ts` | `src/cli/command-reader.ts` | ported |
| `hooks/cli/windows-install.ts` | `src/cli/windows-install.ts` | ported |
| `hooks/testing/fixtures/cli/*` | `test/fixtures/cli/*` | ported (byte-identical copies) |

- The producer source is `pi` and the integration label `DELTA_CLI_INTEGRATION=pi`; `test/cli-fixtures.ts`
  rewrites `"source":"claude-code"` to the local source when it loads the fixtures.
- Contract constants are named `EXTENSION_CONTRACT_MIN`/`MAX` (both 8); `CHILD_CONTRACT_VERSION` is 7.
- `threadMergeCommandLine`, `stopWorktreeMount` and `checkoutSyncing` are absent locally: their only
  callers are the subagent worktree features that are not ported (see [subagents](subagents.md)).
- The Windows install lock is the same file upstream takes, so the plugin and this extension never
  install Delta at once.
- The fake CLI for the e2e tests is `test/e2e/bin/delta`; it answers in the fixtures' shapes. A new CLI
  command the extension starts running must be taught there.

## Divergences

None recorded.
