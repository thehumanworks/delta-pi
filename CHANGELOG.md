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
- `/delta-org list` and other command answers print in print and JSON modes (`pi -p`, `pi --mode json`),
  on stderr.
- A Delta command stopped while a program it started still holds its output no longer keeps pi running.
- A shell command run before you share is exported once, not recorded again with the next turn.
- A join interrupted by starting another session leaves nothing mounted or prepared.
- A turn's finish reflects the reply pi kept, after other extensions changed it.
- Two extension updates cannot run at once across a session switch.
- Extension update checks stop with the session, respect pinned and ranged npm sources and pi's filtered
  installs, run in the session's folder, wait while a turn, share or join runs, and keep their hourly
  limit after a failure; RPC clients see the update notice.
- Ending a session while it reads its binding at startup no longer starts a watch or a mount for it.
- A teammate's row drawn in pi follows their later edit or removal, and its quoted context fits the
  terminal's width; a row pi did not add is offered again instead of being counted as added.
- A steer sent while a dropped watch is torn down is refused rather than slipping into the turn.
- The session a join switches into is no longer offered setup while the join finishes, and an RPC
  client's band names a worktree that is not mounted.
- When pi runs outside a joined session's folder, the restore message says so and how to open a session
  there.
- A refused offline session shows the refusal on the band, beside Fork & Restore and Discard.
- A resumed session no longer delivers the same records beside its ended predecessor's late append, which
  could pause sharing with "lost acknowledged client history".
- Records a failing disk could not save are kept for the life of pi's process, and a later share saves
  them.
- Two writes to one file in the same reply record the second's change against the first's.
- A session's title is recorded at its first reply, before its thread exists if need be.
- A subagent's pi exits only once Delta has stopped syncing its own checkout, so whatever started it can
  remove it safely; a permanently refused subagent says so once, and its records stay queued.
- Extension update checks keep to the session's clock, report a missing `pi` program usefully, tell a
  reload pi refused or that failed apart from an activated update, and offer a version already installed
  by another pi as a reload.
- A teammate's row whose item is no longer in the thread shows "A Delta item that is not in this session."
  (or comment), as the Claude Code plugin does.
- A `!` shell command run while sharing refuses prompts is staged at once and delivered by the next share.

### Added

- `delta_thread`: run another thread of the session's Delta conversation here as a subagent, as the
  Claude Code plugin does through `SendMessage`.
- A subagent's own subagents record under its thread, and a subagent still running when its session is
  shared starts recording.
- Release notices are announced once a day, and give way while a turn, share or join runs.
- `/delta share` during a turn shares once the turn ends.
- `/delta-plugin-update later` hides the notice of the announced release for a day.
- `/delta-plugin-update` reloads a newer version that is already installed, without reinstalling it.
