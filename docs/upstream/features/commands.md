# Commands: `/delta`, its menu and the dedicated forms

Built from `delta-claude` at `ac769c6`. Upstream modules: `hooks/setup/commands.ts`, `delta-menu.ts`,
command hooks in `hooks/register.tsx`.

## What upstream does

- Commands registered at `session.start`: `/delta`, `/delta-share [<email>…]`, `/delta-join <link>`,
  `/delta-setup`, `/delta-update`, `/delta-plugin-update [check | notifications on|off]`,
  `/delta-org list | current | switch <ID> | invite <email>… | manage`. Each dedicated form is the same
  as `/delta <action>`; the `form` (`dedicated_command` or `delta_subcommand`) is passed to Delta's
  telemetry for shares and joins.
- `/delta` alone opens a menu (`delta-menu.ts`): share this session, join a shared session, set up the
  repository, manage the team, and under **More actions** the updates. `/delta-join` and `/delta-org`
  without an argument open the menu at their step. A surface that cannot ask gets the usage text; dismissing
  the menu adds nothing to the transcript.
- `runDeltaCommand` parses the action, refuses a second share or join while one is in flight, requires an
  idle turn for share and join, activates the session first if needed, and reports progress in the band
  rather than as command output. `/delta org manage` opens the team's members page on the dashboard
  (a headless session gets the link). `/delta org invite` without addresses prints usage with the
  dashboard link.
- The `/delta` command also receives the plugin's own internal `show` runs, which draw remote rows (see
  [watch](watch.md)); a person typing that form gets the usage text.

## What upstream does not do

- It has no `/delta link`, `/delta copy` or `/delta resolve`: those actions are buttons in the band.
- It cannot list a plugin command's subcommands in Claude's command menu, hence the `/delta` menu.

## Here

| Upstream | Local | Status |
| --- | --- | --- |
| `hooks/setup/commands.ts` | `src/setup/commands.ts` | adapted |
| `hooks/setup/delta-menu.ts` | `src/setup/delta-menu.ts` | adapted |
| `command.run` hooks | `index.ts` (`COMMANDS` loop) | adapted |

- The same commands and descriptions, registered with `pi.registerCommand`, with argument completions
  for each action. Three actions are added, replacing the band's buttons, which pi's widget cannot have:
  `/delta link` (print the thread's URL without changing permissions), `/delta copy` (copy the link) and
  `/delta resolve` (Fork & Restore or Discard). They appear in `DELTA_USAGE`, the `/delta` menu and the
  completions. See [band](band.md).
- `/delta-join` passes pi's command context so the join can switch sessions; see [joining](joining.md).
- There is no internal `show` form: remote rows are custom messages, not command output.
- The interactive check is pi's `hasUI`; the headless refusal names pi's print and JSON modes.

## Divergences

- `/delta link` has no upstream action. It is recorded as an adaptation of the band's link, which pi's
  widget shows but cannot make clickable or copyable over SSH. Added in commit 4a33d06.
