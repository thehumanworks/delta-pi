/**
 * A key-value store shared by every pi process on the machine, one private JSON file per key, as
 * Claude Code's `$.store` is for its plugins. It has no transactions: each value is written whole,
 * and the last write of a key wins.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { exists, list, readIfExists, remove, writePrivate } from "./files.ts";
import { isJsonObject } from "./json.ts";

export type Store = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
};

/** A key's file name: readable for a person looking in the folder, unique by its digest. */
function fileName(key: string): string {
  const readable = key.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return `${readable}-${digest}.json`;
}

export function fileStore(directory: string): Store {
  const path = (key: string) => join(directory, fileName(key));
  const read = async (file: string): Promise<{ key: string; value: unknown } | undefined> => {
    const text = await readIfExists(file);
    if (text === undefined) return;
    try {
      const parsed: unknown = JSON.parse(text);
      if (isJsonObject(parsed) && typeof parsed.key === "string") return { key: parsed.key, value: parsed.value };
    } catch {
      /* a damaged file holds no value */
    }
  };
  return {
    async get(key) {
      const entry = await read(path(key));
      return entry?.key === key ? entry.value : undefined;
    },
    async set(key, value) {
      if (value === undefined) return this.delete(key);
      await writePrivate(path(key), JSON.stringify({ key, value }));
    },
    async delete(key) {
      await remove(path(key));
    },
    async keys() {
      if (!(await exists(directory))) return [];
      const keys: string[] = [];
      for (const entry of await list(directory)) {
        if (entry.kind !== "file" || !entry.name.endsWith(".json")) continue;
        const stored = await read(join(directory, entry.name));
        if (stored) keys.push(stored.key);
      }
      return keys;
    },
  };
}
