import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Pi, until, world, type World } from "./harness.ts";

let current: { pi?: Pi; world?: World } = {};
afterEach(async () => {
  await current.pi?.stop();
  current.world?.cleanup();
  current = {};
});

test("/delta link leaves a visible, persisted note without sharing a private thread or prompting the model", async () => {
  const w = world({ policy: { mode: "private", organization: "org-1" } });
  const pi = Pi.start(w);
  current = { pi, world: w };
  const thread = await until(() => {
    const found = Object.values(w.delta().threads)[0];
    return found?.url && pi.status()?.includes(found.url) && found;
  }, "the private thread's link");
  expect(thread.visibility).toBe("private");
  // Pi persists the session only after a conversation starts, not for custom entries alone.
  await pi.prompt("a private conversation");
  const starts = pi.events.filter((event) => event.type === "agent_start").length;
  const messages = await pi.messages();
  const dialogs = pi.dialogs.length;
  expect((await pi.command("/delta link")).success).toBe(true);
  await until(() => pi.notices().includes(thread.url), "the link notification");
  const { sessionFile } = await pi.state();
  const entries = readFileSync(sessionFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(entries).toContainEqual(
    expect.objectContaining({ type: "custom", customType: "delta-note", data: { text: thread.url, tone: "info" } }),
  );
  expect(await pi.messages()).toEqual(messages);
  expect(pi.events.filter((event) => event.type === "agent_start")).toHaveLength(starts);
  expect(pi.dialogs).toHaveLength(dialogs);
  expect(w.delta().threads[thread.thread_id].visibility).toBe("private");
  expect(w.calls().some((call) => call.argv.includes("share") || call.argv.includes("invite"))).toBe(false);
}, 60_000);

test("/delta link and its menu action explain a session with no link without sharing it", async () => {
  const w = world({ policy: { mode: "manual" } });
  const pi = Pi.start(w);
  current = { pi, world: w };
  await pi.command("/delta link");
  await until(() => pi.notices().some((text) => text.includes("no Delta link yet")), "the missing-link note");
  pi.answers.push("More actions — Show the thread link, manage your team or update Delta", "Show thread link");
  await pi.command("/delta");
  await until(() => pi.notices().filter((text) => text.includes("no Delta link yet")).length === 2, "the menu's note");
  expect(w.delta().threads).toEqual({});
  expect(w.calls().some((call) => call.argv.includes("share") || call.argv.includes("invite"))).toBe(false);
  expect(pi.events.some((event) => event.type === "agent_start")).toBe(false);
}, 60_000);
