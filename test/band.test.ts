import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { stripVTControlCharacters } from 'node:util'
import type { Theme } from '@earendil-works/pi-coding-agent'
import { getCapabilities, getOsc8LinkAtColumn, setCapabilities, visibleWidth } from '@earendil-works/pi-tui'
import { BandWidget, bandText, clearProgress, setProgress, stopBandTimers, styled } from '../src/band/band.ts'
import type { Host } from '../src/core/host.ts'
import { activation, sessions, stateFor } from '../src/core/session-state.ts'
import * as updates from '../src/updates/updates.ts'
import { feed } from '../src/watch/watch.ts'

const SESSION = 'band-test'
const LINK = `https://delta.dev/join/thread_${'0'.repeat(26)}`
const NOTICE = 'Delta extension 1.1.0 is available · /delta-plugin-update'
const capabilities = getCapabilities()
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  inverse: (text: string) => `\x1b[7m${text}\x1b[27m`,
} as Theme
const host = {
  clock: { now: () => 0, after: () => ({ cancel() {} }) },
  session: { idle: () => true },
  ui: { invalidate: vi.fn() },
} as unknown as Host

beforeEach(() => {
  activation.session = SESSION
  vi.spyOn(updates, 'pluginUpdateNotice').mockReturnValue(NOTICE)
})
afterEach(() => {
  clearProgress(host)
  stopBandTimers()
  sessions.clear()
  activation.session = ''
  feed.connection = { phase: 'stopped' }
  setCapabilities(capabilities)
  vi.restoreAllMocks()
})

test.each(['manual', 'syncing', 'progress', 'failure'] as const)(
  'RPC status retains an update alongside %s',
  (status) => {
    if (status === 'manual') stateFor(SESSION).reminder = 'manual'
    if (status === 'syncing') stateFor(SESSION).binding = { session: SESSION, snapshot: true, next: 1, pending: [] }
    if (status === 'progress') setProgress(host, 'Publishing the thread…', 'active')
    if (status === 'failure') feed.connection = { phase: 'failed', session: SESSION, error: 'watch failed' }
    const expected = {
      manual: 'Not syncing',
      syncing: 'Syncing',
      progress: 'Publishing the thread…',
      failure: 'watch failed',
    }
    expect(bandText(host)).toContain(expected[status])
    expect(bandText(host)).toContain(NOTICE)
  },
)

test('an update by itself stays one plain status, and no status stays absent', () => {
  expect(bandText(host)).toBe(NOTICE)
  vi.mocked(updates.pluginUpdateNotice).mockReturnValue(undefined)
  expect(bandText(host)).toBeUndefined()
})

test('colored segments retain independent dim, bold and inverse attributes', () => {
  const rendered = styled({ text: 'Ada', color: 'cyan', dim: true, bold: true, inverse: true }, theme)
  expect(rendered).toContain('\x1b[36m')
  expect(rendered).toContain('\x1b[2m')
  expect(rendered).toContain('\x1b[1m')
  expect(rendered).toContain('\x1b[7m')
  expect(stripVTControlCharacters(rendered)).toBe('Ada')
})

test.each([true, false])('own-row links remain whole in the widget (hyperlinks: %s)', (hyperlinks) => {
  vi.mocked(updates.pluginUpdateNotice).mockReturnValue(undefined)
  stateFor(SESSION).binding = { session: SESSION, snapshot: true, next: 1, pending: [], url: LINK }
  setCapabilities({ ...capabilities, hyperlinks })
  const widget = new BandWidget(host, () => theme)
  for (const width of [40, 50]) {
    const lines = widget.render(width)
    expect(lines.length).toBeGreaterThan(2)
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true)
    const plain = lines
      .slice(1)
      .map((line) => stripVTControlCharacters(line).trim())
      .join('')
    expect(plain).toBe(LINK)
    for (const line of lines.slice(1)) {
      const column = stripVTControlCharacters(line).search(/\S/)
      expect(getOsc8LinkAtColumn(line, column)).toBe(hyperlinks ? LINK : undefined)
    }
  }
})

test('wrapped link rows fit the same four-row budget the layout reserves', () => {
  vi.mocked(updates.pluginUpdateNotice).mockReturnValue(undefined)
  stateFor(SESSION).binding = { session: SESSION, snapshot: true, next: 1, pending: [], url: LINK }
  const widget = new BandWidget(host, () => theme)
  for (let width = 20; width <= 80; width++) {
    const lines = widget.render(width)
    expect(lines.length).toBeLessThanOrEqual(4)
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true)
    if (lines.length > 1)
      expect(
        lines
          .slice(1)
          .map((line) => stripVTControlCharacters(line).trim())
          .join(''),
      ).toBe(LINK)
  }
})
