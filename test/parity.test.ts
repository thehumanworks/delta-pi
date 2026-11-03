// Keeps parity/upstream-tests.json, the record of how this port covers each of the upstream plugin's
// tests, true to this repository: every test it names must exist, and every gap must say why.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

type Status = 'ported' | 'covered' | 'missing' | 'unsupported' | 'not-applicable'
/** `ours` names the tests here that cover the upstream one, as `file > describe > title`. */
type Entry = { upstream: string; status: Status; ours?: string[]; note: string }

const repo = join(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(repo, 'parity', 'upstream-tests.json'), 'utf8')) as {
  upstream: { commit: string; contract: number }
  tests: Entry[]
}

/** Whether `file` declares a test titled `title`, whitespace aside. */
function declares(file: string, title: string): boolean {
  const text = readFileSync(join(repo, file), 'utf8').replace(/\s+/g, ' ')
  const wanted = title.replace(/\s+/g, ' ')
  return [`'${wanted}'`, `"${wanted}"`, `\`${wanted}\``].some((literal) =>
    text.includes(literal.replaceAll("\\'", "'")),
  )
}

test('the record names the upstream commit and contract the port follows', () => {
  expect(manifest.upstream).toMatchObject({ commit: 'ac769c6', contract: 8 })
})

test('every upstream test appears once, with a known status and a reason', () => {
  const statuses: Status[] = ['ported', 'covered', 'missing', 'unsupported', 'not-applicable']
  expect(new Set(manifest.tests.map((entry) => entry.upstream)).size).toBe(manifest.tests.length)
  for (const entry of manifest.tests) {
    expect(statuses, entry.upstream).toContain(entry.status)
    expect(entry.note.trim(), entry.upstream).not.toBe('')
  }
})

test('every test the record says covers an upstream test exists here', () => {
  const broken = manifest.tests.flatMap((entry) => {
    if (entry.status !== 'ported' && entry.status !== 'covered')
      return entry.ours ? [`${entry.upstream}: names a test`] : []
    if (!entry.ours?.length) return [`${entry.upstream}: names no test`]
    return entry.ours.flatMap((reference) => {
      const [file, ...path] = reference.split(' > ')
      const title = path.at(-1)
      if (!file || !title || !existsSync(join(repo, file))) return [`${entry.upstream}: no file ${file}`]
      return declares(file, title) ? [] : [`${entry.upstream}: no test "${title}" in ${file}`]
    })
  })
  expect(broken).toEqual([])
})
