# Changelog

## Unreleased

### Fixed

- A secret an extension redacts from a message no longer reaches Delta: Delta records each message as pi
  commits it, after every extension has had its say, rather than as pi first hands it out.
- The shell commands you run with `!` are recorded in the thread.
- A write to a path pi's tools resolve specially, such as `@src/a.ts` or `~/notes.txt`, is recorded as the
  change it made to that file.
- A turn cut short at the model's output limit is no longer recorded as a finished answer.
- A teammate's message can no longer reach the model in the middle of a turn that started while it was
  being prepared.
- A Delta command that stops answering no longer holds pi forever: commands time out as they should.
- A subagent in a Git worktree inside its parent's checkout attaches its own worktree; a subagent's checkout
  that failed to attach or mount is retried; a subagent resumed after a crash closes the turn it left
  open; and one that ends while its thread is being created leaves no mount running.
- A session started by one that has ended no longer records, as documented, even where the repository
  syncs automatically.
- A subagent named `Subagent` by the extension that started it keeps that name.
- A join whose switch pi refuses or fails leaves nothing mounted or prepared, and says why; a join that
  could not finish in its new session finishes there when you run `/delta-join` again.
- A prompt you send while pi is starting a turn is taken into that turn instead of refused.
- `/delta-org list` and other command answers print in print mode (`pi -p`), on stderr.
- Extension update checks stop with the session, respect pinned and ranged npm sources and pi's filtered
  installs, run in the session's folder, wait while a turn, share or join runs, and keep their hourly
  limit after a failure; RPC clients see the update notice.

### Added

- `/delta share` during a turn shares once the turn ends.
- `/delta-plugin-update later` hides the notice of the announced release for a day.
- `/delta-plugin-update` reloads a newer version that is already installed, without reinstalling it.
