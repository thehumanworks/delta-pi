import type { MountedThread, ThreadMount, ThreadState } from "../cli/thread-commands.ts";
import { samePath } from "../core/paths.ts";

/** Refuse inaccessible or empty threads before anything changes. */
export function joinPreflight(status: ThreadState): "access" | "empty" | undefined {
  if (status.access.state !== "granted") return "access";
  if (status.worktrees.status === "available" && !status.worktrees.items.length) return "empty";
}

/** Compute changed worktrees and whether the thread's folder is no longer the directory pi works in. */
export function worktreeChanges(
  previous: readonly ThreadMount[],
  directory: string | undefined,
  mounted: MountedThread,
) {
  return {
    added: mounted.worktrees.filter((tree) => !previous.some((mount) => mount.reference === tree.reference)),
    removed: previous.filter((mount) => !mounted.worktrees.some((tree) => tree.reference === mount.reference)),
    moves:
      directory !== undefined &&
      previous.some((mount) => samePath(mount.directory, directory)) &&
      !samePath(mounted.directory, directory),
  };
}

/** Hold prompts during an incomplete join or a restoration. */
export function promptGate(state: {
  joining?: boolean;
  sharing?: boolean;
  transition?: boolean;
  snapshot?: boolean;
  restoring?: boolean;
}): "joining" | "sharing" | "transition" | "restoring" | undefined {
  if (state.joining) return "joining";
  if (state.sharing) return "sharing";
  if (state.transition) return "transition";
  if (!state.snapshot) return;
  if (state.restoring) return "restoring";
}

/** Steering belongs only to the exact live local execution. */
export function ownsSteering(
  execution: { turnId?: string; lost?: true; endSequence?: number } | undefined,
  turnId: string | undefined,
): boolean {
  return (
    !!execution && turnId !== undefined && execution.turnId === turnId && !execution.lost && !execution.endSequence
  );
}
