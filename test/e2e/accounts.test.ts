import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Pi, until, world, type World } from "./harness.ts";

let current: { pi?: Pi; world?: World } = {};
afterEach(async () => {
  await current.pi?.stop();
  current.world?.cleanup();
  current = {};
});

function onlyThread(w: World) {
  const threads = Object.values(w.delta().threads) as any[];
  return threads.length === 1 ? threads[0] : undefined;
}

test("the setup offer runs setup, which saves the repository's choice and keeps it out of Git", async () => {
  const w = world();
  const titles: string[] = [];
  const pi = Pi.start(w, {
    answers: [
      (request) => (titles.push(request.title), "Set up now"),
      (request) => {
        titles.push(request.title);
        expect(request.options).toEqual([
          "Zed — Current team",
          "Skip this step (keep sessions to myself)",
          "Type something…",
        ]);
        return "Zed — Current team";
      },
      (request) => (titles.push(request.title), request.options[0]),
      (request) => (titles.push(request.title), "Not now"),
    ],
  });
  current = { pi, world: w };
  const settings = join(w.checkout, ".delta", "settings.json");
  // The settings file appears before Git's exclude update and the final dialog; wait for the whole wizard.
  await until(() => pi.notices().some((text) => text.includes("Saved Private sync with Zed")), "setup's outcome");
  expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ threads: { mode: "private", organization: "org-1" } });
  expect(readFileSync(join(w.checkout, ".git", "info", "exclude"), "utf8")).toContain("/.delta/settings.json\n");
  expect(titles[0]).toContain("Set it up now?");
  expect(titles[1]).toContain("Which team should sessions from this repository sync to?");
  expect(titles[2]).toContain("Which sessions should Delta sync?");
  expect(titles[3]).toContain("Sync this session privately too?");
  // The setting applies to new sessions; this one is reminded it doesn't sync.
  await until(() => pi.status()?.includes("Not syncing"), "the band's reminder");
}, 60_000);

test("automatic recording signs in through the browser when Delta is signed out, then syncs", async () => {
  const w = world({ policy: { mode: "organization", organization: "org-1" } });
  const pi = Pi.start(w, {
    env: { FAKE_DELTA_SIGNED_OUT: "1" },
    answers: [
      (request) => {
        expect(request.title).toContain("Sign in with your browser?");
        return "Sign in";
      },
    ],
  });
  current = { pi, world: w };
  await until(() => onlyThread(w)?.worktrees.length, "the thread to be created after sign-in");
  expect(w.calls().some((call) => call.argv.join(" ") === "--json auth login --no-wait")).toBe(true);
  expect(w.calls().some((call) => call.argv.join(" ") === "--json auth wait login-1")).toBe(true);
  expect(pi.notices().some((text) => text.includes("https://delta.dev/login/login-1"))).toBe(true);
  await pi.prompt("signed in now");
  await until(
    () => onlyThread(w).records.some((record: any) => JSON.stringify(record.update).includes("Echo: signed in now")),
    "the turn",
  );
}, 60_000);

test("offline changes Delta refuses wait for Fork & Restore, then the queued records drain", async () => {
  const w = world({ policy: { mode: "organization", organization: "org-1" } });
  const pi = Pi.start(w);
  current = { pi, world: w };
  await until(() => w.calls().some((call) => call.argv.includes("watch")), "the thread watch to start");
  writeFileSync(join(w.state, "refuse-appends"), "");
  await pi.prompt("refused at first");
  await until(() => pi.status()?.includes("/delta resolve"), "the band to offer the choice");
  expect(onlyThread(w).records).toEqual([]);
  pi.answers.push((request) => {
    expect(request.options).toEqual([
      "Fork & Restore — Keep the changes in a new thread",
      "Discard — Drop the rejected changes",
      "Cancel",
    ]);
    return request.options[0];
  });
  await pi.command("/delta resolve");
  await until(
    () =>
      onlyThread(w)?.records.some((record: any) => JSON.stringify(record.update).includes("Echo: refused at first")),
    "the queued records to drain",
  );
  expect(w.delta()).toMatchObject({ forked: [onlyThread(w).thread_id] });
  const order = w
    .calls()
    .flatMap((call) => (call.argv.includes("fork") || call.argv.includes("discard") ? [call.argv[2]] : []));
  expect(order).toEqual(["fork", "discard"]);
  await until(() => pi.notices().some((text) => text.includes('new thread "thread_fork"')), "the fork's name");
}, 60_000);

test("a teammate's comment reaches the model in the shape Delta's agents read", async () => {
  const w = world({ policy: { mode: "organization", organization: "org-1" } });
  const pi = Pi.start(w);
  current = { pi, world: w };
  await until(() => w.calls().some((call) => call.argv.includes("watch")), "the thread watch to start");
  w.remote(onlyThread(w).thread_id, {
    type: "comment",
    comment: {
      id: "comment-1",
      chain: "comment-1",
      after_id: null,
      delivered_with: "item-1",
      routed_to: null,
      author: { user_id: "u-ada", name: "Ada" },
      co_authors: [],
      agent: false,
      created_at: 1,
      text: "Why this approach?",
      target: {
        kind: "file",
        worktree: null,
        path: "src/parser.rs",
        view: "head",
        regions: [{ first_line: 3, last_line: 3, status: "added", text: "let x = 1;" }],
        selected: null,
      },
    },
  });
  const message = await until(
    async () => (await pi.messages()).find((entry: any) => entry.customType === "delta"),
    "the comment",
  );
  expect(message.content).toContain("[Delta] Ada, comment (comment comment-1):");
  expect(message.content).toContain("<file>src/parser.rs</file>");
  expect(message.content).toContain('<comment from="Ada">Why this approach?</comment>');
  expect(message.details).toMatchObject({ kind: "comment", author: "Ada", action: "commented on src/parser.rs:3" });
}, 60_000);

test("team commands pass Delta's own answers through", async () => {
  const w = world();
  const pi = Pi.start(w, { answers: [undefined] });
  current = { pi, world: w };
  await pi.command("/delta-org list");
  await until(() => pi.notices().some((text) => text === "* org-1  Zed"), "the team list");
  await pi.command("/delta org switch org-2");
  await until(() => pi.notices().some((text) => text === "Switched to org-2"), "the switch");
  await pi.command("/delta-org invite");
  await until(
    () => pi.notices().some((text) => text.startsWith("Usage: /delta-org invite <email>")),
    "the invite usage",
  );
  await pi.command("/delta nonsense");
  await until(() => pi.notices().some((text) => text.startsWith("Usage: /delta share")), "the usage");
}, 60_000);
