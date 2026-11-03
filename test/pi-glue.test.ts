import { describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileStore } from '../src/core/store.ts'
import { cleanTitle, promptTitle } from '../src/recording/title.ts'
import { parentLink, sentBy } from '../src/subagents/subagents.ts'
import { compareVersions, sourceAt } from '../src/updates/updates.ts'

describe('store', () => {
  test("keeps each key's value whole, lists the keys, and forgets deleted ones", async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-delta-store-'))
    try {
      const store = fileStore(directory)
      expect(await store.keys()).toEqual([])
      await store.set('session:a', { next: 1 })
      await store.set('setup-offered:/repo/.git', true)
      // Keys that read alike as file names stay apart.
      await store.set('session:a/', { next: 2 })
      expect(await store.get('session:a')).toEqual({ next: 1 })
      expect(await store.get('session:a/')).toEqual({ next: 2 })
      expect((await store.keys()).sort()).toEqual(['session:a', 'session:a/', 'setup-offered:/repo/.git'])
      await store.delete('session:a')
      await store.set('setup-offered:/repo/.git', undefined)
      expect(await store.get('session:a')).toBeUndefined()
      expect(await store.keys()).toEqual(['session:a/'])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('titles', () => {
  test('a title is one bounded line', () => {
    expect(cleanTitle('  Fix\n the\tparser  ')).toBe('Fix the parser')
    expect(cleanTitle('   ')).toBeUndefined()
    expect(cleanTitle('x'.repeat(300))).toHaveLength(200)
    expect(promptTitle('\n\nPlease look at the parser\nand the tests')).toBe('Please look at the parser')
    expect(promptTitle('y'.repeat(100))!.endsWith('…')).toBe(true)
  })
})

describe('subagents', () => {
  test('only a well-formed link names a parent', () => {
    const link = { thread: 't', reference: 't', sender: 's', directories: ['/repo'] }
    expect(parentLink(JSON.stringify(link))).toEqual(link)
    for (const value of [
      undefined,
      '',
      'not json',
      JSON.stringify({ ...link, sender: '' }),
      JSON.stringify({ ...link, directories: [1] }),
    ])
      expect(parentLink(value)).toBeUndefined()
  })

  test("a subagent's prompt is attributed to the session that sent it", () => {
    expect(
      sentBy({ sessionUpdate: 'user_message', _meta: { delta: { activity_kind: 'user_message' } } }, 'parent'),
    ).toEqual({
      sessionUpdate: 'user_message',
      _meta: { delta: { activity_kind: 'user_message', sender: { external_id: 'parent' } } },
    })
    expect(sentBy({ sessionUpdate: 'agent_message' }, 'parent')).toEqual({ sessionUpdate: 'agent_message' })
  })
})

describe('extension updates', () => {
  test('the npm source pi installed the extension from is found by its path', () => {
    const listing = [
      'User packages:',
      '  npm:pi-claude-bridge',
      '    /home/ada/.pi/agent/npm/node_modules/pi-claude-bridge',
      '  npm:@nothumanwork/pi-delta@0.1.0',
      '    /home/ada/.pi/agent/npm/node_modules/@nothumanwork/pi-delta',
      '  ./local/pi-delta',
      '    /home/ada/src/pi-delta',
    ].join('\n')
    expect(sourceAt(listing, '/home/ada/.pi/agent/npm/node_modules/@nothumanwork/pi-delta')).toEqual({
      source: 'npm:@nothumanwork/pi-delta@0.1.0',
      name: '@nothumanwork/pi-delta',
      scope: 'user',
    })
    // A local copy is left alone.
    expect(sourceAt(listing, '/home/ada/src/pi-delta')).toBeUndefined()
  })

  test('versions compare numerically, and anything else does not compare', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1)
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBeUndefined()
  })
})
