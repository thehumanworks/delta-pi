# Setup: the wizard, the repository policy, activation and sign-in

Built from `delta-claude` at `ac769c6`. Upstream modules: `hooks/setup/setup.ts`, `project-policy.ts`,
`organizations.ts`, `interaction.ts`, `activation.ts`, `hooks/cli/auth.ts`.

## What upstream does

- `/delta setup` chooses the repository's team and which sessions sync: **Private sync** (every new
  session syncs, visible only to you), **Team sharing** (every new session syncs and is shared with the
  team), or **Manual** (a session syncs only on `/delta share`). It can create a team and invite
  teammates by email, offers to replace unreadable settings, and after Private sync offers to sync the
  current session too. It stops up front, with how to fix it, when the repository has no usable Git
  remote.
- The choice is written to `.delta/settings.json` at the checkout root (the file Delta's other
  integrations read) and kept out of Git through `.git/info/exclude`. `project-policy.ts` is pure:
  locate, parse, validate, serialize.
- The onboarding offer runs once per repository: right after install, or the first time a session starts
  in a repository that is not set up. "Not now" is remembered.
- `activation.ts` starts a session's recording: loads or creates its binding, records automatically when
  the policy says so (before the first prompt), repairs an incomplete automatic activation on the next
  prompt or resume, prunes old store entries, follows the transcript for titles, and adopts a
  *continuation*: when Claude moves a conversation to a new session (`/background`, a compaction into a
  new session), the new session adopts the old one's thread from a record near the end of the transcript.
  `noticeStart` works out how a session started (`/clear`, `/resume`) when the organization guard keeps
  `classic.SessionStart` away.
- `auth.ts`: when Delta needs sign-in or acceptance of its beta terms, an interactive session asks
  before opening the browser, keeps working and recording locally, and syncs once sign-in finishes.
  Headless sessions never open a browser. A share, join or setup during the wait offers to stop waiting.
- `organizations.ts` reads the person's teams once per process and names the one a thread is shared
  with in the band.
- `interaction.ts` wraps Claude's `AskUserQuestion` dialog, with a hint beside each option, and the
  browser opener.

## What upstream does not do

- It never commits `.delta/settings.json`.
- It never installs Delta or opens a browser from background discovery or from a headless session.

## Here

| Upstream | Local | Status |
| --- | --- | --- |
| `hooks/setup/setup.ts` | `src/setup/setup.ts` | ported |
| `hooks/setup/project-policy.ts` | `src/setup/project-policy.ts` | ported |
| `hooks/setup/organizations.ts` | `src/setup/organizations.ts` | ported |
| `hooks/setup/interaction.ts` | `src/setup/interaction.ts` | adapted |
| `hooks/setup/activation.ts` | `src/setup/activation.ts` | adapted |
| `hooks/cli/auth.ts` | `src/cli/auth.ts` | ported |

- The dialog is pi's `ui.select`, with each option's hint appended to its label, and `ui.input` when the
  question takes typed text (`TYPE_SOMETHING`).
- The setup offer runs the first time an interactive session starts in a repository (`beginSession` on
  `session_start`); there is no "right after install" moment in pi.
- Activation is per extension runtime and pi gives it the session id directly, so `noticeStart`,
  `noticeSession`, `followTranscript`, `followTitle`, `rememberTranscript`, `continuationCandidate`,
  `adoptContinuation` and `handedOff` have no counterparts: pi does not move conversations to new sessions
  and has no transcript files. In their place `beginSession`, `settleActivation` (a bounded wait for an
  automatic activation at shutdown) and `completeJoinTransition` (see [joining](joining.md)).
- Sessions without a person to answer (print and JSON modes) never open a browser, as upstream's headless
  sessions do not.

## Divergences

None recorded.
