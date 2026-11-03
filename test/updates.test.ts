import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Host } from '../src/core/host.ts'
import type { RunInit, RunResult } from '../src/core/process.ts'
import * as files from '../src/core/files.ts'
import { claimInstallation, installation } from '../src/core/installation.ts'
import { activation, requests, sessions, stateFor } from '../src/core/session-state.ts'
import {
  pluginUpdateCommand,
  pluginUpdateNotice,
  sourceAt,
  startPluginUpdates,
  stopPluginUpdates,
} from '../src/updates/updates.ts'

const HOUR = 3_600_000
const CHECK = 'plugin-update:check'
const NAME = '@nothumanwork/pi-delta'
const ROOT = '/installed/delta'
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
  const packages = { source: `npm:${NAME}`, version: '1.0.0', nextVersion: '1.1.0' }
  vi.spyOn(files, 'readText').mockImplementation(async () => JSON.stringify({ name: NAME, version: packages.version }))
  const run = vi.fn(async (argv: string[], _init?: RunInit) => {
    if (argv[1] === 'list') return ok(`User packages:\n  ${packages.source}\n    ${ROOT}`)
    if (argv[1] === 'update') {
      packages.version = packages.nextVersion
      return ok()
    }
    if (argv[1] === 'view') return ok(JSON.stringify(['1.0.0', '1.0.3']))
    throw new Error(`Unexpected command: ${argv.join(' ')}`)
  })
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
  return { host, values, timers, clock, run, packages }
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
  vi.restoreAllMocks()
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

test.each(['delta', NAME])('filtered npm listing annotations are not part of the source: %s', async (name) => {
  const source = `npm:${name}@next`
  expect(sourceAt(`Project packages:\n  ${source} (filtered)\n    ${ROOT}`, ROOT)).toEqual({ source, name })
  const { host, packages, run } = fake()
  packages.source += ' (filtered)'
  const reload = vi.fn()
  expect(await pluginUpdateCommand(host, '', { reload })).toEqual({})
  expect(run).toHaveBeenCalledWith(['pi', 'update', `npm:${NAME}`], expect.anything())
  expect(reload).toHaveBeenCalledOnce()
})

test.each(['1.0.0', 'v1.0.0', '1.0.0-beta.1', '1.0.0+build'])('exact npm pin %s is left unchanged', async (pin) => {
  const { host, packages, run } = fake()
  packages.source += `@${pin}`
  const reload = vi.fn()
  expect((await pluginUpdateCommand(host, '', { reload })).text).toContain('pinned')
  expect(fetch).not.toHaveBeenCalled()
  expect(run.mock.calls.map(([argv]) => argv[1])).toEqual(['list'])
  expect(reload).not.toHaveBeenCalled()
})

test.each(['~1.0.0', '>=1.0.0 <1.1.0', 'next'])(
  'discovery follows npm constraint %s, not unconditional latest',
  async (spec) => {
    const { host, packages, run } = fake()
    packages.source += `@${spec}`
    packages.nextVersion = '1.0.3'
    const reload = vi.fn()
    await pluginUpdateCommand(host, '', { reload })
    expect(run).toHaveBeenCalledWith(['npm', 'view', `${NAME}@${spec}`, 'version', '--json'], {
      cwd: '/session/project',
      timeoutMs: 10_000,
    })
    expect(fetch).not.toHaveBeenCalled()
    expect(host.ui.note).toHaveBeenCalledWith('Updating the Delta extension to 1.0.3…')
    expect(reload).toHaveBeenCalledOnce()
  },
)

test('a successful pi exit without a newer installed version is not an update or a reload', async () => {
  const { host, packages } = fake()
  packages.nextVersion = '1.0.0'
  const reload = vi.fn()
  const { text } = await pluginUpdateCommand(host, '', { reload })
  expect(text).toContain("didn't install a newer")
  expect(reload).not.toHaveBeenCalled()
  expect(host.ui.note).not.toHaveBeenCalledWith(expect.stringContaining('Updated'))
})

test('update verification reports the actual installed version, not the advertised version', async () => {
  const { host, packages, run } = fake()
  packages.nextVersion = '1.2.0'
  await pluginUpdateCommand(host, '', { reload: vi.fn() })
  expect(host.ui.note).toHaveBeenCalledWith('Updated the Delta extension to 1.2.0; reloading.')
  expect(files.readText).toHaveBeenCalledWith(`${ROOT}/package.json`)
  expect(run.mock.calls.filter(([argv]) => argv[1] === 'list')).toHaveLength(2)
})

test('all pi subprocesses use the originating session cwd', async () => {
  const { host, run } = fake()
  await pluginUpdateCommand(host, '', { reload: vi.fn() })
  expect(run.mock.calls.map(([argv]) => argv)).toEqual([
    ['pi', 'list'],
    ['pi', 'update', `npm:${NAME}`],
    ['pi', 'list'],
  ])
  for (const [, init] of run.mock.calls) expect(init?.cwd).toBe('/session/project')
})

test.each(['idle', 'turn', 'prompt', 'share', 'join'] as const)(
  'installation refuses a busy %s before discovery',
  async (busy) => {
    const { host, run } = fake()
    if (busy === 'idle') host.session.idle = () => false
    if (busy === 'turn') stateFor('session').currentTurnId = 'turn'
    if (busy === 'prompt') stateFor('session').promptEntering = true
    if (busy === 'share') requests.share = { session: 'session' } as typeof requests.share
    if (busy === 'join') requests.join = { session: 'session' } as typeof requests.join
    const reload = vi.fn()
    expect((await pluginUpdateCommand(host, '', { reload })).text).toContain('Wait for')
    expect(run).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  },
)

test.each(['session', 'cwd', 'shutdown', 'turn'] as const)(
  'a %s transition during installation suppresses reload',
  async (change) => {
    const { host, run } = fake()
    const update = deferred<RunResult>()
    const original = run.getMockImplementation()!
    run.mockImplementation(async (argv, init) => {
      const result = await original(argv, init)
      return argv[1] === 'update' ? update.promise : result
    })
    const reload = vi.fn()
    const command = pluginUpdateCommand(host, '', { reload })
    await flush()
    expect(run.mock.calls.some(([argv]) => argv[1] === 'update')).toBe(true)
    if (change === 'session') host.session.id = () => 'another-session'
    if (change === 'cwd') host.session.cwd = () => '/different/project'
    if (change === 'shutdown') stopPluginUpdates()
    if (change === 'turn') host.session.idle = () => false
    update.resolve(ok())
    expect((await command).text).toContain('Run /reload')
    expect(reload).not.toHaveBeenCalled()
    for (const [, init] of run.mock.calls) expect(init?.cwd).toBe('/session/project')
    expect(installation).toBeUndefined()
  },
)

test('an already installed newer version reloads without network access or another update', async () => {
  const { host, packages, run } = fake()
  packages.version = '1.1.0'
  vi.mocked(fetch).mockRejectedValue(new Error('offline'))
  const reload = vi.fn()
  expect(await pluginUpdateCommand(host, '', { reload })).toEqual({})
  expect(reload).toHaveBeenCalledOnce()
  expect(fetch).not.toHaveBeenCalled()
  expect(run.mock.calls.map(([argv]) => argv)).toEqual([['pi', 'list']])
})

test('the app/plugin installation lock covers discovery, installation and pending reload', async () => {
  const { host, run } = fake()
  const release = claimInstallation('app')!
  try {
    expect((await pluginUpdateCommand(host, '', { reload: vi.fn() })).text).toContain('still running')
    expect(run).not.toHaveBeenCalled()
  } finally {
    release()
  }
  const reloading = deferred<void>()
  const command = pluginUpdateCommand(host, '', { reload: () => reloading.promise })
  await flush()
  expect(claimInstallation('app')).toBeUndefined()
  expect((await pluginUpdateCommand(host, '', { reload: vi.fn() })).text).toContain('already in progress')
  reloading.resolve()
  await command
  expect(run.mock.calls.filter(([argv]) => argv[1] === 'update')).toHaveLength(1)
  expect(installation).toBeUndefined()
})

test.each([
  'not JSON',
  null,
  { name: 'another-package', version: '1.1.0' },
  { name: NAME, version: '1.1.0-beta.1' },
  { name: NAME, version: '01.1.0' },
])('invalid registry manifests never become releases: %j', async (manifest) => {
  const { host, values } = fake()
  vi.mocked(fetch).mockResolvedValue(new Response(typeof manifest === 'string' ? manifest : JSON.stringify(manifest)))
  const reload = vi.fn()
  expect((await pluginUpdateCommand(host, '', { reload })).text).toContain("couldn't check")
  expect(values.get(CHECK)).not.toHaveProperty('latest')
  expect(reload).not.toHaveBeenCalled()
})

test.each(['source', 'manifest', 'exit', 'throw', 'reload'] as const)(
  'a failed %s verification never claims activation and releases ownership',
  async (failure) => {
    const { host, run, packages } = fake()
    const original = run.getMockImplementation()!
    run.mockImplementation(async (argv, init) => {
      const result = await original(argv, init)
      if (argv[1] === 'update') {
        if (failure === 'source') packages.source += '@next'
        if (failure === 'manifest')
          vi.mocked(files.readText).mockResolvedValue(JSON.stringify({ name: 'foreign', version: '1.1.0' }))
        if (failure === 'exit') return { ...result, exitCode: 1, stderr: 'install refused' }
        if (failure === 'throw') throw new Error('pi update failed')
      }
      return result
    })
    const reload = vi.fn(async () => {
      throw new Error('reload failed')
    })
    const { text } = await pluginUpdateCommand(host, '', { reload })
    expect(text).toMatch(/couldn't|could not/)
    if (failure !== 'reload') expect(reload).not.toHaveBeenCalled()
    else expect(text).toContain('reload failed')
    expect(installation).toBeUndefined()
  },
)

test('a session replacement during registry discovery prevents installation', async () => {
  const { host, run } = fake()
  const response = deferred<Response>()
  vi.mocked(fetch).mockReturnValue(response.promise)
  const reload = vi.fn()
  const command = pluginUpdateCommand(host, '', { reload })
  await flush()
  activation.epoch++
  response.resolve(Response.json({ name: NAME, version: '1.1.0' }))
  expect((await command).text).toContain('Wait for')
  expect(run.mock.calls.map(([argv]) => argv[1])).toEqual(['list'])
  expect(reload).not.toHaveBeenCalled()
})

test('a changed project does not reuse another project’s cached source or release', async () => {
  const { host, timers, run } = fake()
  startPluginUpdates(host)
  await timers.at(-1)!.run()
  stopPluginUpdates()
  host.session.cwd = () => '/another/project'
  startPluginUpdates(host)
  await timers.at(-1)!.run()
  expect(run).toHaveBeenLastCalledWith(['pi', 'list'], { cwd: '/another/project', timeoutMs: 10_000 })
  expect(fetch).toHaveBeenCalledTimes(2)
})
