# Delta for pi

[Delta](https://delta.dev) gives every agent thread a URL. With this extension, your
[pi](https://pi.dev) sessions are recorded to Delta along with the Git checkout they work in.
Anyone on your team can then open the thread and join it, from their own pi session, from
[delta.dev](https://delta.dev), or from the Delta app.

It is a port of Zed Industries' [Delta plugin for Claude Code](https://github.com/zed-industries/delta-claude)
(upstream commit `ac769c6`, plugin 0.1.32), following Delta's guide to
[building a coding agent plugin](https://delta.dev/docs/cli/build-a-plugin). Everything goes through the
`delta` CLI's recording contract (version 8, Delta 0.22.0 or newer).

## Installation

You need pi 1.4.0 or newer (older versions show a warning but are not blocked) and Git.

```sh
pi install npm:@nothumanwork/pi-delta
```

Alternatively, install directly from GitHub or a local checkout:

```sh
pi install git:github.com/thehumanworks/delta-pi
pi install /path/to/delta-pi
pi -e /path/to/delta-pi/index.ts       # for one run only
```

The extension uses the `delta` CLI. If it isn't installed on macOS or Linux, the extension installs it
the first time you set up syncing, share, or join, using Delta's official installer, and offers to
open your browser to sign in. On Windows it asks before running the official installer. Background
discovery never installs anything.

At startup an interactive session checks the installed Delta for updates in the background (ten-second
budget) and tells you when one is available. `/delta-update` installs it.

The extension also checks npm hourly for a newer release of itself, when pi installed it from npm and
`PI_OFFLINE` is unset. The band then offers `/delta-plugin-update`, which runs `pi update <source>` and
reloads. `/delta-plugin-update check` only checks; `/delta-plugin-update notifications off` (or `on`)
turns the notices off.

## Usage

### Setup

Run `/delta-setup` in a repository to choose its team and which sessions sync:

- **Private sync**: every new session syncs, and only you can see it until you share it.
- **Team sharing**: every new session syncs and is shared with your team.
- **Manual**: a session syncs only when you run `/delta-share`.

Setup can create a team and invite teammates by email. It saves your choice to
`.delta/settings.json` (the same file Delta's other integrations read) and keeps that file out of Git
through `.git/info/exclude`, since the choice is yours. The extension offers setup once per repository,
the first time an interactive session starts in it.

A new session in a repository that syncs automatically starts recording before its first prompt. If
Delta needs you to sign in, the session asks before opening your browser, and keeps recording locally
meanwhile; it uploads everything once sign-in finishes. Sessions without a person to answer (print and
JSON modes) never open a browser.

### Sharing

`/delta-share` asks who should see the session: your team, just you, or people you name by email
address. `/delta-share ada@example.com` invites them directly. The conversation so far, its whole
branch, compaction or not, is exported to the thread first; from then on each turn is recorded live.

`/delta link` prints the current thread’s URL in the transcript, clickable in terminals that support
links. It works over SSH without a clipboard and does not change who can see the thread: a private
thread stays private. If this session has no link yet, it tells you rather than sharing it automatically.

### Joining

`/delta-join <link>` mounts the thread's worktrees and switches pi to a new session in the thread's
folder, so pi's tools work on the shared files. The thread's conversation so far reaches the model's
context; the session you joined from stays as it was, and `/resume` takes you back to it. Resuming the
joined session later mounts its worktrees again.

### While a session is shared

- A band above the editor shows whether the session syncs, the thread's link and audience, who is
  here, and what a teammate's agent is doing. In RPC mode the band is the `delta` status entry.
- Teammates' messages, tool calls, events and comments reach the model's context between your turns,
  never inside one, drawn under their author. Their agents' thinking is shown to you only.
- When someone takes the thread over in Delta, pi stops its turn. Tool effects already performed are
  not rolled back.
- A session that records into its own thread keeps recording while Delta is unreachable and uploads
  once it is back. If Delta then refuses those changes because someone else changed the thread,
  `/delta resolve` offers **Fork & Restore** (keep them in a new thread) or **Discard**.

### Subagents

Pi runs subagents as separate pi sessions, usually separate `pi` processes started by an extension.
A recorded session passes its thread to everything it starts through the `DELTA_PI_PARENT`
environment variable. A pi session that starts empty with that variable set, while the session that
started it is still live, records into a child thread under the parent's, named for its first prompt
(or `DELTA_PI_SUBAGENT_NAME`), with its prompts shown as sent by the parent. A child working inside
the parent's checkout shares its worktrees; one working in a checkout of its own, such as a Git
worktree, attaches that checkout to its thread while it runs. A link left in an environment that
outlives its session, as a long-running worker's does, records nothing once that session has ended.

### Commands

Each command also works as `/delta <command>`, such as `/delta share`. `/delta` on its own opens a
menu of these actions.

| Command | Description |
| --- | --- |
| `/delta-share [<email>…]` | Sync the current session and its checkout, and choose who sees it |
| `/delta-join <link>` | Join a shared thread in a new session in the thread's folder |
| `/delta-setup` | Choose this repository's team and which sessions sync |
| `/delta-update` | Update the installed Delta app and CLI |
| `/delta-plugin-update [check \| notifications on\|off]` | Update this extension and reload, check its version, or control update notices |
| `/delta-org list` | List your Delta teams |
| `/delta-org current` | Show the selected team |
| `/delta-org switch <ID>` | Select a different team |
| `/delta-org invite <email>…` | Invite people to the selected team |
| `/delta-org manage` | Open the selected team's members page on the dashboard |
| `/delta link` | Print the current thread's link without changing sharing permissions |
| `/delta copy` | Copy the thread's link |
| `/delta resolve` | Choose Fork & Restore or Discard for offline changes Delta refused |

Sharing, joining and setup need pi's interactive terminal or an RPC client that shows dialogs.

## Privacy

Delta stores what a recorded session contains: your conversation, including tool inputs and outputs
and the model's thinking, plus the files in your checkout (staged, unstaged, and untracked files that
aren't ignored). Nothing is uploaded until you share or join a session, or the repository's setting
syncs it automatically.

A shared or joined session shows you as connected through pi. Every Delta command the extension runs
carries `DELTA_CLI_INTEGRATION=pi` (and, for a share or join, `DELTA_CLI_COMMAND_FORM`), which the
Delta CLI uses for its telemetry of which integration ran each command.

The extension keeps its own state in `~/.pi/agent/delta/` (or under `PI_CODING_AGENT_DIR`): `store/`
holds each session's binding to its thread, `outbox/` the records not yet confirmed by Delta, and
`debug.log` what it did. Files there are readable only by you.

## How it differs from the Claude Code plugin

The recording, delivery, retry, watch, share, setup and sign-in logic is the plugin's, ported with
its tests. What Claude Code's host provides differently is adapted:

| Claude Code plugin | This extension |
| --- | --- |
| `turn.start` / `turn.complete` hooks | A Delta turn runs from pi's `agent_start` to `agent_settled` |
| `session.append` rows and `tool.call` results | pi's `message_end` messages; tool details (edit patches) come with the result |
| `prompt.submit` drop | pi's `input` event; a refused prompt goes back into the editor |
| Remote rows drawn as the plugin's own command output | Custom messages with a renderer, held until pi settles |
| The band's buttons (copy link, share, Fork & Restore, Discard) | `/delta copy`, `/delta share`, `/delta resolve` |
| `/clear` then `/cd` into the thread folder on join | A new pi session whose working directory is the thread folder |
| Title Claude chose for the session | pi's session name, else the first prompt's first line |
| Claude's `Agent` subagents | pi processes started by a recorded session (see Subagents) |
| Marketplace self-update | npm check and `pi update <source>` |

Not ported, for want of a pi equivalent: Claude Code Desktop's hand-off of a join to a new Desktop
session, following a conversation Claude moves to a background session (`/background`), running a
Delta thread as a Claude subagent through `SendMessage`, and recording subagents that finished before
a session was shared. A joined session whose thread's worktrees
change is told their new paths but is not moved to the thread folder; `/delta-join` again opens a
session there.

## Development

### With Nix (Linux x86-64 and ARM64)

The only prerequisite is Nix with flakes enabled. From the checkout root:

```sh
nix develop
npm run check   # tsc --noEmit
npm test        # bun test: unit tests and end-to-end tests
pi -e ./index.ts
```

If flakes are not enabled in your Nix configuration, use
`nix --extra-experimental-features 'nix-command flakes' develop` instead; no system configuration
change is needed. The first entry needs network access to fetch Nix packages and npm dependencies.

The shell supplies Node.js 22/npm, Bun, Git/SSH, Bash, command-line utilities, ripgrep, fd, Prettier 3,
`nixfmt`, CA certificates, and the real Delta CLI/backend through
[`deltanix`](https://github.com/thehumanworks/deltanix) (not the similarly named Git diff pager).
It runs `npm ci --include=dev` if the local pi or TypeScript executable is missing, and puts
`node_modules/.bin` first on `PATH`, so `pi` is the version pinned in `package-lock.json`, even when
the tests run it in another directory. Nothing is installed globally, and no services or login flows
start when you enter the shell. If dependencies change after entry, run `npm ci --include=dev` again.
A failed automatic dependency install stops shell startup rather than using a global pi by accident.

`flake.lock` pins the Nix inputs; `package-lock.json` pins pi and the other npm dependencies. To update
the Nix tools, run `nix flake update`; to update only Delta, run `nix flake update deltanix` and re-enter
the shell. Delta's in-app updater is disabled for this Nix-managed installation. Delta is proprietary;
the `deltanix` package permits that package without requiring a global `allowUnfree` setting.

Tests use the fake Delta CLI and faux model below: no Delta account, model credentials, browser or
keyring is needed. Live use needs your own pi provider credentials and Delta sign-in. Delta also needs
an available, unlocked Secret Service keyring in your desktop session; the shell does not configure
one. Native macOS shells are not provided because `deltanix` currently packages Linux only.

For a non-interactive check or formatting:

```sh
nix develop --command bash -c 'npm run check && npm test'
nix develop --command prettier --write index.ts 'src/**/*.ts' 'test/**/*.ts'
nix fmt
nix flake check --all-systems --no-build
```

### Without Nix

Install Node.js 22.19.0 or newer, Bun and Git, then:

```sh
npm ci
npm run check
npm test
npx pi -e ./index.ts
```

`npm test` adds the local pi executable to `PATH`; no global pi installation is needed.

The unit tests in `test/` are mostly the Claude Code plugin's own, ported; `test/fixtures/cli` holds the
Delta CLI's output examples that the plugin keeps in step with the native CLI.

The end-to-end tests in `test/e2e` run the real `pi --mode rpc` with this extension and a faux model
(`faux-model.ts`) in a throwaway checkout and agent directory, against a fake `delta` CLI
(`bin/delta`) that answers in the fixtures' shapes and keeps its state in a folder the test reads. Set
`PI_E2E_DEBUG=1` to see pi's stderr. To try the extension by hand the same way:

```sh
PATH=$PWD/test/e2e/bin:$PATH FAKE_DELTA_STATE=/tmp/fake-delta PI_CODING_AGENT_DIR=/tmp/pi-agent \
  pi -e ./index.ts -e ./test/e2e/faux-model.ts --provider faux --model faux-1
```

## Publishing to npm

The package is published as `@nothumanwork/pi-delta`. You need npm publish access to the
`@nothumanwork` scope, Node.js 22.19.0 or newer, and Bun (to run the tests). Pi loads the
TypeScript sources directly; no build step is needed.

From a clean checkout:

```sh
npm ci
npm pack --dry-run                   # inspect the release contents
npm login
npm whoami                          # confirm the publishing account
npm publish                         # public access is configured in package.json
```

`npm publish` runs the type check and the full test suite through `prepublishOnly` and stops
if either fails. Tests use a fake Delta CLI, never a real Delta account. npm may ask for
second-factor authentication. The package includes only `index.ts`, `src/`, `README.md`,
`LICENSE`, and npm\'s required `package.json`; tests and local credentials are not shipped.

For subsequent releases, commit your changes, run `npm version patch` (or `minor` / `major`),
then `npm publish` and `git push --follow-tags`. Published versions cannot be overwritten.
After publishing, users install with `pi install npm:@nothumanwork/pi-delta` and update with
`pi update npm:@nothumanwork/pi-delta`.

## License

Copyright (C) 2026 Zed Industries, for the Delta plugin for Claude Code this extension is ported from.

Licensed under the GNU Affero General Public License, version 3 only (`AGPL-3.0-only`), as the plugin
is. See [LICENSE](LICENSE).
