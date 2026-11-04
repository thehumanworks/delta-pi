# The band above the prompt

Built from `delta-claude` at `ac769c6`. Upstream modules: `hooks/band/band.tsx`, `status.ts`,
`plugin-update.tsx`.

## What upstream does

- `ui.render` of `AbovePrompt` draws one band: whether the session syncs ("Syncing", "Waiting to sync…",
  "Syncing to DeltaDB…"), the thread's link and audience ("Synced with <team>", "Shared with <team>",
  "Unlisted"), who is here (first names, coloured per person, arriving and leaving), what a teammate's
  agent is doing ("Ada's agent …" with the tool row), a running share, join or Delta update with a
  spinner and progress bar, the plugin-update notice, sync reminders, and a reconnect timer while the
  watch retries.
- Buttons: copy link (with a "Copied" confirmation timer), **Share with <team>** / **Share after this
  turn** / **Sharing after this turn**, and when offline changes were refused **Fork & Restore** and
  **Discard**. The link is a terminal hyperlink (unlabelled in terminals, labelled in Desktop).
- `plugin-update.tsx` is a row inside the band with **Update**, **Later** (24 hours) and **Mute**; it
  never takes focus or starts a model turn.
- `status.ts` computes everything without a `Host`: the turn to report, the people and children listed,
  the rows, widths and segments. The bar's shade follows Claude's theme (`config.set` for `theme`).

## What upstream does not do

- It draws nothing in headless sessions.

## Here

| Upstream | Local | Status |
| --- | --- | --- |
| `hooks/band/band.tsx` | `src/band/band.ts` | adapted |
| `hooks/band/status.ts` | `src/band/status.ts` | ported |
| `hooks/band/plugin-update.tsx` | `src/band/status.ts`, `src/updates/updates.ts` | adapted |

- The band is a pi widget (`ui.setWidget("delta", …)`) rendered by `BandWidget` from `renderBand`, with
  the same words. In RPC mode, where there is no terminal, the band's text is the `delta` status entry
  (`ui.setStatus`), updated when it changes.
- Pi's widget takes no clicks, so the buttons are commands: `/delta copy`, `/delta share`,
  `/delta resolve`, and the plugin-update notice says to run `/delta-plugin-update`. `/delta link` prints
  the URL in the transcript for terminals where the band's link is not clickable (see
  [commands](commands.md)).
- `status.ts` adds `fitToolRow` for pi's narrower widget widths and has no `pluginUpdateRow`: the
  notice's text comes from `pluginUpdateNotice` in `src/updates/updates.ts`. Otherwise upstream's.
- There is no theme hook; pi hands the theme to the widget on each render.

## Divergences

None recorded beyond the button-to-command adaptation above.
