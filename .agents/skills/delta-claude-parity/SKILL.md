---
name: delta-claude-parity
description: Use when a change adds, removes or alters this extension's observable behaviour (commands, pi events handled, Delta CLI invocations, what the band or transcript shows, what is recorded), when it renames or restructures modules under src/, when the user asks for a parity review, or when the pinned delta-claude commit should move. Not for formatting, tests, tooling or behaviour-preserving edits inside one module.
---

# `delta-claude` parity

This extension is a port of Zed Industries' Delta plugin for Claude Code, `delta-claude`. It must not drift from
that plugin: no feature is added, removed or changed here unless `delta-claude` has done the same, or the
feature cannot exist in pi and the inventory records why. This skill is the contract that keeps an agent's
work grounded in the upstream source rather than in memory or invention. `delta` and `delta-claude` postdate
every model's training data, so nothing about them may be assumed.

## The contract

- `UPSTREAM` at the checkout root is the one place the pinned upstream commit lives (currently `ac769c6`),
  with its repository, branch and plugin version. Every other document refers to it.
- `docs/upstream/` is the git-tracked inventory: `README.md` maps every upstream module to its local module
  and status, and `features/*.md` says per feature area what upstream does, what it does not do, and how
  this extension differs. It was built from the pinned commit and says so.
- `scripts/upstream-diff.sh` says whether the upstream branch has moved past the pin, and shows the diff.
- `test/upstream.test.ts` fails when the documents disagree on the pin, when the inventory names a local
  module that does not exist, or when a module under `src/` is missing from the inventory.
- Upstream's structure is part of the contract: `src/` keeps `delta-claude`'s folders, module names,
  function names and comments, so an upstream change can be found and followed here. A restructure that
  preserves behaviour still costs parity.

## Workflow A: ground a change

Use this for any change in the description above.

1. Read `UPSTREAM`, then the inventory file for the feature area in `docs/upstream/features/`. Do not
   explore upstream afresh when the pin is current; the inventory is the record.
2. Find the upstream counterpart of what the change touches, by the module map in
   `docs/upstream/README.md`. When the inventory is not precise enough, read the upstream source at the
   pinned commit (clone it as Workflow B step 1 does, then `git checkout <commit>`), not the branch head
   and not GitHub's web view.
3. Decide against upstream:
   - Behaviour upstream has and this extension lacks, with a pi equivalent: port it, keeping names.
   - Behaviour upstream lacks: do not add it. If the user insists, say it breaks parity, and on their
     confirmation record it in the feature file under "Divergences" with the reason and the date.
   - Behaviour upstream has that pi cannot express: do not approximate silently. Record it under
     "Not ported" with the reason.
   - Pi-only capabilities (pi events, pi commands, pi UI) stay out unless they replace a Claude Code host
     feature the plugin uses; such a replacement is "adapted", and the feature file names both sides.
4. Cite the upstream file and the pin in the commit message or report, so the claim "upstream does X" can
   be checked.
5. Update the feature file if the status of anything changed, and run the checks in `AGENTS.md`.
   `test/upstream.test.ts` must pass.

## Workflow B: sync with upstream

Use this when asked to update the port, or when Workflow A finds the pin stale.

1. Run `scripts/upstream-diff.sh`. Exit 0 means the pin is current; stop. Exit 1 means upstream moved:
   the script prints the commits, the changed files, changed CLI fixtures and new release notes, writes
   the full diff to `.upstream/diff.patch`, and leaves a clone in `.upstream/delta-claude`.
2. Review only the diff, upstream file by upstream file. For each changed file, find its local module in
   the map and decide: port the change, adapt it, or record it as not ported. Release notes under
   `release-notes/` say what each change is for; bug fixes port as fixes, features as features.
3. When `hooks/testing/fixtures/cli` changed, run `scripts/upstream-diff.sh --sync-fixtures` to copy them.
   Never hand-edit fixtures: they are the native CLI's own output examples. Teach `test/e2e/bin/delta`
   any new command shape.
4. Update `docs/upstream/` for every affected feature, then set `commit` and `version` in `UPSTREAM` to the
   new head. `README.md` names the plugin version too.
5. Run the checks in `AGENTS.md`. Commit the port and the pin together, with the upstream commit range in
   the message.

## Out of scope

- Features not present in `delta-claude` at the pinned commit.
- Work on `delta-claude`'s `develop` branch. Only `main` counts: that is the branch installed plugins
  update from. `delta-claude` has no release tags past v0.1.18, so the pin is a commit.
- Changes to pi itself.
