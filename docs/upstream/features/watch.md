# Watching the thread: teammates' rows and presence

Built from `delta-claude` at `ac769c6`. Upstream modules: `hooks/watch/watch.ts`, `conversation.ts`,
`presence.ts`, `rows.tsx`, `row-delivery.ts`.

## What upstream does

- `watch.ts` runs `delta thread watch` for the recorded or joined thread: a connection with phases
  (`stopped`, `connecting`, `live`, `retrying`) changed only by named transitions, other participants'
  turns and presence, the thread's upload progress, and the status fields the band shows. It reconnects
  with a visible timer and never shows a connection that never came up as live.
- `conversation.ts` renders each watched item for the person and for Claude: user, agent and
  cross-agent messages, tool calls with their output and patches (each large section cut to 8000
  characters), events and comments, drawn under their author. Remote agents' thinking is shown to the
  person and announced once on completion, never given to Claude.
- `presence.ts` counts an arrival after a connection holds for 3 seconds and a departure after a peer is
  gone long enough, so flapping connections do not announce.
- `rows.tsx` and `row-delivery.ts`: rows arriving while Claude's own turn runs are held and drawn one at a
  time between turns, as the plugin's own `/delta show <id>` command output, so they become stored rows
  Claude reads on resume; a successful person-visible draw is remembered even if its model row must
  retry. When someone takes the thread over in Delta, Claude's turn is aborted; tool effects already
  performed are not rolled back.

## What upstream does not do

- It never gives Claude a remote agent's thinking.
- It never draws a remote row inside a running turn.

## Here

| Upstream | Local | Status |
| --- | --- | --- |
| `hooks/watch/watch.ts` | `src/watch/watch.ts` | ported |
| `hooks/watch/conversation.ts` | `src/watch/conversation.ts` | ported |
| `hooks/watch/presence.ts` | `src/watch/presence.ts` | ported |
| `hooks/watch/rows.tsx` | `src/watch/rows.ts`, `src/band/renderers.ts` | adapted |
| `hooks/watch/row-delivery.ts` | `src/watch/rows.ts` | adapted |

- Remote rows reach the model as pi custom messages (`REMOTE_MESSAGE`, drawn by `renderRemote` in
  `src/band/renderers.ts`), added between turns and never inside one, held while pi is not idle. A
  teammate's thinking is a note for the person only (`renderNote`). There is no `show` command, draw
  queue or stored-row rewrite: pi stores the custom message itself, so `DrawQueue`, `DrawnRows`,
  `shownItemId` and `shownCommandRewrite` have no counterparts.
- Takeover stops pi's turn through `context.abort()`.

## Divergences

None recorded.
