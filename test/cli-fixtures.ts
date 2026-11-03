/**
 * The Delta CLI's own output examples, copied from Delta's Claude Code plugin, which keeps them in
 * step with the native CLI (see fixtures/cli/README.md). They name the Claude Code producer; this
 * extension records as `pi`, so the copies read here name it instead.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SOURCE } from "../src/cli/thread-commands.ts";

const directory = join(import.meta.dirname, "fixtures", "cli");
const data: Record<string, any> = {};
for (const file of readdirSync(directory)) {
  const text = readFileSync(join(directory, file), "utf8").replaceAll('"source":"claude-code"', `"source":"${SOURCE}"`);
  if (file.endsWith(".jsonl"))
    data[file.slice(0, -".jsonl".length)] = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  else if (file.endsWith(".json")) data[file.slice(0, -".json".length)] = JSON.parse(text);
}

const names = {
  status: "thread-status.granted",
  recorded: "thread-append.recorded",
  fenced: "thread-append.fenced",
  duplicate: "thread-append.duplicate",
  create: "thread-create",
  share: "thread-share",
  attach: "worktree-attach",
  checkoutMount: "worktree-mount",
  mount: "thread-mount",
  contract: "thread-contract",
  invite: "thread-invite",
  childCreate: "thread-create.child",
  detach: "worktree-detach",
};

export const cliWatchFrames = data["thread-watch.frames"] as Record<string, any>[];
const frames = {
  ready: "ready",
  item: "item",
  itemAppend: "item.append",
  remove: "remove",
  live: "live",
  turn: "turn",
  producerTurn: "producer.turn",
  presence: "presence",
  worktrees: "worktrees",
  error: "error",
  comment: "comment",
  commentRemove: "comment.remove",
};

/** Each test receives an independent response; patches never mutate the JSON example. */
export function cliFixture(
  name: keyof typeof names | keyof typeof frames,
  patch: Record<string, unknown> = {},
): Record<string, any> {
  const fixture =
    name in names
      ? data[names[name as keyof typeof names]]
      : cliWatchFrames.find(
          (frame) => (frame.type ?? (frame.error ? "error" : undefined)) === frames[name as keyof typeof frames],
        );
  if (!fixture) throw new Error(`Missing CLI fixture ${name}`);
  return { ...structuredClone(fixture), ...patch };
}

export const cliFixtureData = data;
export const cliErrorCodes = data["error-codes"]!;
