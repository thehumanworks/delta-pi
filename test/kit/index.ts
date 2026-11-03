/**
 * The in-process kit: the whole extension, loaded by a fake pi (./pi.ts), on a clock the test moves
 * (./clock.ts), against the fake Delta CLI (test/fake-delta) in a throwaway checkout (test/world.ts).
 * A test drives prompts, commands and session switches, then reads the fake CLI's state, what the
 * person saw, and the commands the extension ran.
 *
 *   const delta = await startDelta({ policy: { mode: 'private', organization: 'org-1' } })
 *   await delta.pi.prompt('hello')
 *   expect(delta.thread()?.records).toHaveLength(4)
 */
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import type { Platform } from '../../src/core/host.ts'
import { FAKE_BIN, until, world, type World } from '../world.ts'
import { flush, MockClock } from './clock.ts'
import { type Answer, FakePi, type FakeSession } from './pi.ts'
import { type Environment, kitProcesses } from './processes.ts'

export { until } from '../world.ts'
export { echoModel, type FakeSession, type Model, type Reply } from './pi.ts'

export type Kit = Awaited<ReturnType<typeof startDelta>>

/** Start pi with the extension in a new world, and wait for its session to start. */
export async function startDelta(
  options: {
    policy?: Record<string, unknown>
    mode?: 'rpc' | 'print'
    answers?: Answer[]
    env?: Environment
    /** A world to start in, such as another kit's, for a second pi on the same machine. */
    world?: World
    /** Where pi starts; the world's checkout unless given. */
    cwd?: string
    /** A session to resume, as a new pi process does after another one ended, cleanly or not. */
    session?: FakeSession
    /** Leave the session unstarted, to set the kit up first. */
    start?: boolean
  } = {},
) {
  const w = options.world ?? world({ ...(options.policy ? { policy: options.policy } : {}) })
  // pi writes the session files a join prepares under its agent directory.
  vi.stubEnv('PI_CODING_AGENT_DIR', w.agentDir)
  const clock = new MockClock()
  const env: Environment = {
    ...process.env,
    PATH: `${FAKE_BIN}:${process.env.PATH}`,
    FAKE_DELTA_STATE: w.state,
    PI_OFFLINE: '1',
    DELTA_PI_PARENT: undefined,
    ...options.env,
  }
  const processes = kitProcesses(() => env)
  const stderr: string[] = []
  const copied: string[] = []
  const platform: Platform = {
    dataDir: join(w.agentDir, 'delta'),
    clock,
    process: processes,
    env: {
      windows: () => false,
      get: (name) => env[name],
      set: (name, value) => {
        if (value === undefined) delete env[name]
        else env[name] = value
      },
    },
    stderr: (text) => stderr.push(text),
    copy: async (text) => {
      copied.push(text)
      return true
    },
  }
  const pi = new FakePi(platform, options.cwd ?? w.checkout, options.mode, options.session)
  pi.answers.push(...(options.answers ?? []))
  const kit = {
    world: w,
    pi,
    clock,
    env,
    stderr,
    copied,
    /** The delta commands the extension ran, as argument lists without the program. */
    commands: () => processes.ran.map((call) => call.argv.slice(1).filter((arg) => arg !== '--json')),
    /** The fake CLI's one top-level thread, once it exists. */
    thread: () => Object.values(w.delta().threads).find((thread) => !thread.parent),
    /** Wait until `read` holds, while the extension's work runs. */
    until: <T>(read: () => T | undefined | false | Promise<T | undefined | false>, what: string, timeoutMs?: number) =>
      until(read, what, timeoutMs),
    /** Move the clock forward, running what falls due. */
    advance: (milliseconds: number) => clock.advance(milliseconds),
    /** Let work already under way run. */
    settle: flush,
    /**
     * Wait for `work` while time passes, a second at a time up to `limitMs`, as it would while pi waits
     * on a bounded budget such as shutdown's.
     */
    async whileTimePasses<T>(work: Promise<T>, limitMs = 120_000): Promise<T> {
      let done = false
      const watched = work.finally(() => (done = true))
      for (let passed = 0; !done && passed < limitMs; passed += 1_000) await clock.advance(1_000)
      return watched
    },
    /**
     * What every behaviour test ends with: no handler threw, no scheduled work failed, and every Delta
     * command carried pi's label for Delta's telemetry.
     */
    expectClean() {
      expect(pi.errors.map(String)).toEqual([])
      expect(clock.failures.map(String)).toEqual([])
      const unlabelled = processes.ran.filter((call) => call.env.DELTA_CLI_INTEGRATION !== 'pi')
      expect(unlabelled.map((call) => call.argv.slice(1).join(' '))).toEqual([])
    },
    /** End the session, as quitting pi does, and remove the world unless another kit shares it. */
    async stop() {
      if (!stopped) await kit.whileTimePasses(pi.shutdown('quit'))
      stopped = true
      await processes.stopAll()
      if (!options.world) w.cleanup()
    },
    /** End this pi as a crash would: its commands end with its process, and it says nothing. */
    async crash() {
      stopped = true
      await processes.stopAll()
    },
  }
  let stopped = false
  if (options.start !== false) await pi.start()
  return kit
}
