import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink, setCapabilities, visibleWidth } from "@earendil-works/pi-tui";
import { renderNote } from "../src/band/renderers.ts";
import type { Host } from "../src/core/host.ts";
import { activation, type Binding, sessions, stateFor } from "../src/core/session-state.ts";
import { COMMANDS, DELTA_USAGE, runDeltaCommand } from "../src/setup/commands.ts";

const SESSION = "link-test";
const URL = "https://delta.dev/join/thread-test";
const capabilities = getCapabilities();
// Link retrieval must not touch the host: no CLI, clipboard, dialogs, activation or store writes.
const host = {} as Host;
const theme = { fg: (_color: string, text: string) => text } as Theme;

beforeEach(() => {
  activation.session = SESSION;
});
afterEach(() => {
  sessions.delete(SESSION);
  activation.session = "";
  setCapabilities(capabilities);
});

function bind(extra: Partial<Binding> = {}) {
  const binding: Binding = { session: SESSION, url: URL, snapshot: true, next: 1, pending: [], ...extra };
  stateFor(SESSION).binding = binding;
  return binding;
}

test("link prints the saved URL without touching private, shared or joined threads", async () => {
  for (const extra of [
    { visibility: "private" as const },
    { visibility: "organization" as const },
    { visibility: "unlisted" as const },
    { joined: true as const },
  ]) {
    const binding = bind(extra);
    const before = structuredClone(binding);
    expect(await runDeltaCommand(host, "link", "delta_subcommand")).toEqual({ text: URL });
    expect(binding).toEqual(before);
  }
});

test("link explains a missing or unsafe URL without creating or sharing a thread", async () => {
  for (const url of [undefined, "", "javascript:alert(1)", "https://user:secret@delta.dev/join/abc"]) {
    bind({ url });
    expect((await runDeltaCommand(host, "link", "delta_subcommand")).text).toBe(
      "This session has no Delta link yet. Share it with /delta-share first.",
    );
  }
  sessions.delete(SESSION);
  expect((await runDeltaCommand(host, "link", "delta_subcommand")).text).toContain("no Delta link yet");
  expect(sessions.has(SESSION)).toBe(false);
});

test("link never uses an inactive session's URL", async () => {
  bind();
  activation.session = "";
  expect((await runDeltaCommand(host, "link", "delta_subcommand")).text).toContain("no Delta link yet");
});

test("link is discoverable in completion and usage; extra arguments do not share anything", async () => {
  expect(COMMANDS[0].actions).toContain("link");
  expect(DELTA_USAGE).toContain("/delta link");
  expect(await runDeltaCommand(host, "link someone@example.com", "delta_subcommand")).toEqual({ text: DELTA_USAGE });
});

test("copy still copies the same URL and falls back to printing it", async () => {
  bind();
  const copy = mock(async () => true);
  const copyingHost = { ui: { copy } } as unknown as Host;
  expect(await runDeltaCommand(copyingHost, "copy", "delta_subcommand")).toEqual({ text: `Copied ${URL}` });
  expect(copy).toHaveBeenCalledWith(URL);
  copy.mockResolvedValue(false);
  expect(await runDeltaCommand(copyingHost, "copy", "delta_subcommand")).toEqual({
    text: `Couldn't copy the link; here it is: ${URL}`,
  });
});

test("a link note renders the full URL, with a hyperlink only when supported", () => {
  for (const hyperlinks of [true, false]) {
    setCapabilities({ ...capabilities, hyperlinks });
    const component = renderNote({ text: URL }, theme)!;
    const rendered = component.render(100).join("\n");
    expect(rendered).toContain(URL);
    expect(rendered.includes("\x1b]8;;")).toBe(hyperlinks);
    if (hyperlinks) expect(rendered).toContain(hyperlink(URL, URL));
    // Wrapping in a narrow SSH terminal must retain the URL and fit the available columns.
    const narrow = component.render(20);
    expect(narrow.every((line) => visibleWidth(line) <= 20)).toBe(true);
    const plain = narrow.map((line) => stripVTControlCharacters(line).trim()).join("");
    expect(plain).toContain(URL);
  }
});

test("ordinary notes keep their text without acquiring hyperlinks", () => {
  setCapabilities({ ...capabilities, hyperlinks: true });
  for (const text of ["No Delta link yet.", "javascript:alert(1)", `Copied ${URL}`]) {
    const rendered = renderNote({ text }, theme)!.render(100).join("\n");
    expect(rendered).toContain(text);
    expect(rendered).not.toContain("\x1b]8;;");
  }
});
