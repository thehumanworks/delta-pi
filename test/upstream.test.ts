/**
 * The upstream pin and inventory stay consistent: UPSTREAM is the one place the delta-claude commit
 * lives, every document that names it agrees with it, and docs/upstream names every module of this
 * extension, so a module added without a parity decision fails here.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

function pin(): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of read("UPSTREAM").split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    expect(separator, `UPSTREAM line without '=': ${line}`).toBeGreaterThan(0);
    entries[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return entries;
}

function filesUnder(directory: string, extension: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(ROOT, directory))) {
    const path = join(directory, entry);
    if (statSync(join(ROOT, path)).isDirectory()) found.push(...filesUnder(path, extension));
    else if (entry.endsWith(extension)) found.push(path);
  }
  return found.sort();
}

const inventory = () => filesUnder("docs/upstream", ".md").map((path) => ({ path, text: read(path) }));

describe("the upstream pin", () => {
  test("names a repository, branch, full commit and plugin version", () => {
    const entries = pin();
    expect(entries.repository).toMatch(/^https:\/\/github\.com\/zed-industries\/delta-claude$/);
    expect(entries.branch).toBe("main");
    expect(entries.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(entries.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("is the commit every document names", () => {
    const { commit, version } = pin();
    const short = commit!.slice(0, 7);
    const naming = ["AGENTS.md", "README.md", "docs/upstream/README.md", ".agents/skills/delta-claude-parity/SKILL.md"];
    for (const path of naming) {
      const text = read(path);
      expect(text, `${path} does not name the pinned commit ${short}`).toContain(short);
      // A document that names another 40-digit or 7-digit hash in a `commit` sentence has drifted.
      for (const match of text.matchAll(/\b([0-9a-f]{40})\b/g))
        expect(match[1], `${path} names commit ${match[1]}, not the pinned ${commit}`).toBe(commit!);
    }
    expect(read("README.md"), "README.md does not name the pinned plugin version").toContain(`plugin ${version}`);
    expect(read("docs/upstream/README.md")).toContain(version!);
  });
});

describe("the upstream inventory", () => {
  test("names only local modules that exist", () => {
    for (const { path, text } of inventory())
      for (const match of text.matchAll(/`((?:src\/[\w./-]+\.ts)|index\.ts|test\/[\w./-]+)`/g)) {
        const named = match[1]!;
        expect(() => statSync(join(ROOT, named)), `${path} names ${named}, which does not exist`).not.toThrow();
      }
  });

  test("names every module of this extension", () => {
    const text = inventory()
      .map((file) => file.text)
      .join("\n");
    const modules = [...filesUnder("src", ".ts").map((path) => relative(ROOT, join(ROOT, path))), "index.ts"];
    const unnamed = modules.filter((module) => !text.includes(`\`${module}\``));
    expect(unnamed, "modules docs/upstream does not place against delta-claude").toEqual([]);
  });

  test("gives every upstream module a status", () => {
    const map = read("docs/upstream/README.md");
    const rows = map.split("\n").filter((line) => /^\| `hooks\//.test(line));
    expect(rows.length).toBeGreaterThan(40);
    for (const row of rows)
      expect(row, `module map row without a status: ${row}`).toMatch(/\| (ported|adapted|not ported|replaced) /);
  });
});
