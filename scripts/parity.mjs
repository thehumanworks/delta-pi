#!/usr/bin/env node
// Compares parity/upstream-tests.json with the tests in a checkout of the upstream plugin, to follow
// upstream: lists upstream tests the record does not cover yet, and recorded ones upstream no longer has.
//
//   git -C ../delta-claude checkout <commit>
//   node scripts/parity.mjs ../delta-claude
//
// Titles are read from the source, so a title built from a loop variable (`${command} …`) matches the
// expanded titles the record lists for it.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const upstream = process.argv[2]
if (!upstream) {
  console.error('Usage: node scripts/parity.mjs <checkout of github.com/zed-industries/delta-claude>')
  process.exit(2)
}
const hooks = join(upstream, 'hooks')
const record = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'parity', 'upstream-tests.json'), 'utf8'))

/** Every test title declared in `file`, as written; a template keeps its `${…}` placeholders whole. */
function titles(file) {
  const text = readFileSync(file, 'utf8')
  const found = []
  for (const match of text.matchAll(/(?:^|[\s;(])(?:test|it|kitTest)\(\s*/gm)) {
    const literal = readLiteral(text, match.index + match[0].length)
    if (literal !== undefined) found.push(literal)
  }
  return found
}

/** The string or template literal starting at `start`, unquoted, or undefined when none starts there. */
function readLiteral(text, start) {
  const quote = text[start]
  if (quote !== "'" && quote !== '"' && quote !== '`') return
  let index = start + 1
  let depth = 0
  for (; index < text.length; index++) {
    const char = text[index]
    if (char === '\\') index++
    else if (quote === '`' && char === '$' && text[index + 1] === '{') {
      depth++
      index++
    } else if (depth && char === '}') depth--
    else if (depth && char === '`') index = skipTemplate(text, index)
    else if (!depth && char === quote) return text.slice(start + 1, index).replace(/\\(['"`])/g, '$1')
  }
}

/** The index of the backtick closing the template that opens at `start`. */
function skipTemplate(text, start) {
  let depth = 0
  for (let index = start + 1; index < text.length; index++) {
    const char = text[index]
    if (char === '\\') index++
    else if (char === '$' && text[index + 1] === '{') {
      depth++
      index++
    } else if (depth && char === '}') depth--
    else if (!depth && char === '`') return index
  }
  return text.length
}

/** A title as a pattern: each placeholder, however nested, matches any text, or none. */
function pattern(title) {
  const parts = []
  let literal = ''
  for (let index = 0; index < title.length; index++) {
    if (title[index] === '$' && title[index + 1] === '{') {
      parts.push(literal)
      literal = ''
      let depth = 1
      for (index += 2; index < title.length && depth; index++) {
        if (title[index] === '{') depth++
        else if (title[index] === '}') depth--
      }
      index--
    } else literal += title[index]
  }
  parts.push(literal)
  return new RegExp(`^${parts.map((part) => part.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&')).join('.*')}$`)
}

const testFiles = readdirSync(hooks, { recursive: true, encoding: 'utf8' })
  .filter((name) => /\.test\.tsx?$/.test(name))
  .map((name) => join(hooks, name))
const recorded = new Map()
for (const entry of record.tests) {
  const segments = entry.upstream.split(' > ')
  const file = segments[0]
  const title = segments.at(-1)
  recorded.set(file, [...(recorded.get(file) ?? []), title])
}

const uncovered = []
const matched = new Set()
for (const file of testFiles) {
  const name = relative(hooks, file)
  const known = recorded.get(name) ?? []
  for (const title of titles(file)) {
    const matches = known.filter((candidate) => pattern(title).test(candidate))
    if (!matches.length) uncovered.push(`${name} > ${title}`)
    for (const candidate of matches) matched.add(`${name} > ${candidate}`)
  }
}
const stale = record.tests
  .map((entry) => entry.upstream)
  .filter((key) => {
    const segments = key.split(' > ')
    return !matched.has(`${segments[0]} > ${segments.at(-1)}`)
  })

console.log(`Upstream at ${upstream}: ${testFiles.length} test files. The record follows ${record.upstream.commit}.`)
if (uncovered.length) console.log(`\nUpstream tests the record does not cover yet:\n  ${uncovered.join('\n  ')}`)
if (stale.length) console.log(`\nRecorded tests upstream no longer has:\n  ${stale.join('\n  ')}`)
if (!uncovered.length && !stale.length) console.log('The record covers every upstream test, and only those.')
process.exit(uncovered.length || stale.length ? 1 : 0)
