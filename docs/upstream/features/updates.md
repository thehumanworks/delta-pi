# Updates: the Delta installation and the plugin itself

Built from `delta-claude` at `ac769c6`. Upstream modules: `hooks/cli/install-update.ts`,
`hooks/plugin-update/updates.ts`, `catalog.ts`, `hooks/band/plugin-update.tsx`, `hooks/core/installation.ts`.

## What upstream does

- **Delta updates.** At `session.start` an interactive session checks the installed Delta for updates in
  the background with a ten-second budget and says when one is available; it never installs or opens a
  browser from the check, and a failed check stops nothing. `/delta-update` runs `delta update`: a
  running Delta app restarts, sessions reconnect on their own, progress is shown on one animated line in
  the band with the version and a download bar, and the transcript keeps the start and the result. On
  Windows the installer runs after the CLI exits and the command waits up to ten more minutes, reporting
  success, a required restart, or the installer's failure. The CLI's own error and usage text is shown
  when it rejects the command. When Delta is running agent work, the update says to retry later. Older
  CLIs without the update command point to delta.dev.
- **Plugin updates.** At startup and hourly, shared by every session, the plugin reads GitHub's release
  manifest for the marketplace branch it was installed from (`main`, or `develop`); local copies, other
  sources and pinned refs are left alone. A newer version shows the band row **Update** / **Later**
  (24 hours) / **Mute**. `/delta-plugin-update` installs through `claude plugin update` and reloads
  (`/reload-plugins --force`); `check` only checks; `notifications off|on` controls the notices. Checks
  need a standalone `claude` CLI on PATH, and never run headless or when
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set.
- `core/installation.ts` is the process-wide slot so an app update and a plugin update never run together.

## What upstream does not do

- It never installs anything without the person's action.
- `/delta-update` does not update the plugin, and `/delta-plugin-update` does not update Delta.

## Here

| Upstream | Local | Status |
| --- | --- | --- |
| `hooks/cli/install-update.ts` | `src/cli/install-update.ts` | ported |
| `hooks/core/installation.ts` | `src/core/installation.ts` | ported |
| `hooks/plugin-update/updates.ts` | `src/updates/updates.ts` | adapted |
| `hooks/plugin-update/catalog.ts` | `src/updates/updates.ts` | adapted |
| `hooks/band/plugin-update.tsx` | `src/band/status.ts`, `src/updates/updates.ts` | adapted |

- Delta updates are upstream's, with progress in the band widget and `UpdateHost` built from the pi host
  (`installUpdateHost`).
- Extension updates check npm hourly for a newer `@nothumanwork/pi-delta`, only when pi installed the
  extension from npm (`sourceAt`) and `PI_OFFLINE` is unset. The band offers `/delta-plugin-update`, which
  runs `pi update <source>` and reloads pi; `check` and `notifications on|off` behave as upstream's.
  There is no marketplace, branch channel, GitHub manifest, snooze button or `claude` CLI dependency.
- The band notice is text, not buttons; see [band](band.md).

## Divergences

None recorded.
