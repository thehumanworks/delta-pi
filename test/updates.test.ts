import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Host } from '../src/core/host.ts'
import type { RunInit, RunResult } from '../src/core/process.ts'
import { activation, requests, sessions } from '../src/core/session-state.ts'
import {
  pluginUpdateCommand,
  pluginUpdateNotice,
  startPluginUpdates,
  stopPluginUpdates,
} from '../src/updates/updates.ts'

const HOUR = 3_600_000
const CHECK = 'plugin-update:check'
const NAME = '@nothumanwork/pi-delta'
const ROOT = '/installed/delta'
const listing = `User packages:\n  npm:${NAME}\n    ${ROOT}`
const ok = (stdout = ''): RunResult => ({
  stdout,
  stderr: '',
  exitCode: 0,
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

function fake() {
  const values = new Map<string, unknown>()
  const timers: { delay: number; cancelled: boolean; run(): unknown }[] = []
  const clock = {
    time: 0,
    now: () => clock.time,
    after(delay: number, run: () => unknown) {
      const timer = { delay, run, cancelled: false }
      timers.push(timer)
      return {
        cancel: () => {
          timer.cancelled = true
        },
      }
    },
  }
  const run = vi.fn(async (_argv: string[], _init?: RunInit) => ok(listing))
  const host = {
    plugin: { name: NAME, version: '1.0.0', root: ROOT },
    clock,
    store: {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: unknown) => {
        values.set(key, value)
      },
      delete: async (key: string) => {
        values.delete(key)
      },
    },
    process: { run },
    session: {
      id: () => 'session',
      cwd: () => '/session/project',
      interactive: () => true,
      idle: () => true,
    },
    ui: { invalidate: vi.fn(), debug: vi.fn(), note: vi.fn() },
  } as unknown as Host
  return { host, values, timers, clock, run }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function flush() {
  for (let index = 0; index < 30; index++) await Promise.resolve()
}

beforeEach(() => {
  vi.stubEnv('PI_OFFLINE', '')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ name: NAME, version: '1.1.0' })),
  )
})
afterEach(() => {
  stopPluginUpdates()
  sessions.clear()
  requests.share = undefined
  requests.join = undefined
  requests.shareAfterTurn = undefined
  activation.epoch++
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

test.each(['stop', 'opt out'] as const)('an in-flight check cannot publish or reschedule after %s', async (action) => {
  const { host, timers } = fake()
  const response = deferred<Response>()
  vi.mocked(fetch).mockReturnValue(response.promise)
  startPluginUpdates(host)
  const checking = timers[0]!.run()
  await flush()
  expect(fetch).toHaveBeenCalledOnce()
  if (action === 'stop') stopPluginUpdates()
  else await pluginUpdateCommand(host, 'notifications off')
  response.resolve(Response.json({ name: NAME, version: '1.1.0' }))
  await checking
  expect(pluginUpdateNotice()).toBeUndefined()
  expect(timers.filter((timer) => !timer.cancelled)).toHaveLength(0)
})

test('failed discovery is throttled across starts, and a known release survives a failed refresh', async () => {
  const { host, timers, values, clock } = fake()
  vi.mocked(fetch).mockResolvedValue(new Response('', { status: 503 }))
  startPluginUpdates(host)
  await timers.at(-1)!.run()
  expect(values.get(CHECK)).toMatchObject({ checkedAt: 0 })
  stopPluginUpdates()
  startPluginUpdates(host)
  await timers.at(-1)!.run()
  expect(fetch).toHaveBeenCalledOnce()
  clock.time = HOUR
  vi.mocked(fetch).mockResolvedValue(Response.json({ name: NAME, version: '1.1.0' }))
  await timers.at(-1)!.run()
  expect(pluginUpdateNotice()).toContain('1.1.0')
  clock.time += HOUR
  vi.mocked(fetch).mockResolvedValue(new Response('', { status: 503 }))
  await timers.at(-1)!.run()
  expect(pluginUpdateNotice()).toContain('1.1.0')
  stopPluginUpdates()
  startPluginUpdates(host)
  await timers.at(-1)!.run()
  expect(pluginUpdateNotice()).toContain('1.1.0')
  expect(fetch).toHaveBeenCalledTimes(3)
})

test('future and malformed cache timestamps never suppress a fresh check', async () => {
  for (const checkedAt of [HOUR * 24, '0', NaN, Infinity]) {
    const { host, timers, values, clock } = fake()
    startPluginUpdates(host)
    await timers.at(-1)!.run()
    stopPluginUpdates()
    const saved = values.get(CHECK) as object
    values.set(CHECK, { ...saved, checkedAt })
    clock.time = 0
    vi.mocked(fetch).mockClear()
    startPluginUpdates(host)
    await timers.at(-1)!.run()
    expect(fetch).toHaveBeenCalledOnce()
    stopPluginUpdates()
  }
})

test('manual checks respect opt-out, and enabling notices immediately reuses the cache', async () => {
  const { host, timers, values } = fake()
  await pluginUpdateCommand(host, 'notifications off')
  startPluginUpdates(host)
  for (const timer of [...timers]) await timer.run()
  expect(fetch).not.toHaveBeenCalled()
  expect((await pluginUpdateCommand(host, 'check')).text).toContain('1.1.0 is available')
  expect(values.get('plugin-update:notifications')).toBe(false)
  expect(pluginUpdateNotice()).toBeUndefined()
  await pluginUpdateCommand(host, 'notifications on')
  expect(timers.at(-1)!.delay).toBe(0)
  await timers.at(-1)!.run()
  expect(pluginUpdateNotice()).toContain('1.1.0')
  expect(fetch).toHaveBeenCalledOnce()
})

test('headless and offline sessions never schedule background discovery', () => {
  for (const offline of ['0', '1', 'yes']) {
    const { host, timers, run } = fake()
    vi.stubEnv('PI_OFFLINE', offline)
    startPluginUpdates(host)
    expect(timers).toHaveLength(0)
    expect(run).not.toHaveBeenCalled()
  }
  vi.stubEnv('PI_OFFLINE', '')
  const { host, timers } = fake()
  host.session.interactive = () => false
  startPluginUpdates(host)
  expect(timers).toHaveLength(0)
})

test('a failed pi listing is quiet and throttled before any registry request', async () => {
  const { host, timers, values, run } = fake()
  run.mockRejectedValue(new Error('pi not found'))
  startPluginUpdates(host)
  await timers.at(-1)!.run()
  expect(host.ui.debug).toHaveBeenCalledWith(expect.stringContaining('pi not found'))
  expect(host.ui.note).not.toHaveBeenCalled()
  expect(values.get(CHECK)).toMatchObject({ checkedAt: 0 })
  stopPluginUpdates()
  startPluginUpdates(host)
  await timers.at(-1)!.run()
  expect(run).toHaveBeenCalledOnce()
  expect(fetch).not.toHaveBeenCalled()
})
