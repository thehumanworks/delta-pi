/**
 * The extension's own files: recorded conversations and their state stay readable only by the person
 * who records them, and each write lands whole or not at all.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type FsEntry = { name: string; kind: 'file' | 'dir' | 'other'; isLink: boolean }

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8')
}

/** The text of a file, or undefined when there is none. */
export async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Write `text` whole: to a private temporary file beside `path`, then renamed over it. */
export async function writePrivate(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, text, { mode: 0o600 })
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

/** Create `path` with `text`, failing if it already exists. */
export async function writeExclusive(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, { flag: 'wx' })
}

/** Write a file someone else owns, such as a repository's settings, keeping the default permissions. */
export async function writeShared(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

export async function list(path: string): Promise<FsEntry[]> {
  const entries = await readdir(path, { withFileTypes: true })
  return entries.map((entry) => ({
    name: entry.name,
    kind: entry.isFile() ? 'file' : entry.isDirectory() ? 'dir' : 'other',
    isLink: entry.isSymbolicLink(),
  }))
}

export async function size(path: string): Promise<number> {
  return (await stat(path)).size
}

export async function remove(path: string): Promise<void> {
  await rm(path, { force: true })
}
