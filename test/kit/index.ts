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
import { fileStore } from '../../src/core/store.ts'
import { disk } from './disk.ts'
import { type Environment, type FakeProgram, type FakeStream, kitProcesses } from './processes.ts'

export { until } from '../world.ts'
export { echoModel, FakeSession, type Model, type Reply } from './pi.ts'
export type { FakeProgram, FakeStream } from './processes.ts'

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
    /** Whether the machine is Windows, as `Platform.env.windows` tells the extension. */
    windows?: boolean
    /** The arguments pi was started with, as a subagent it starts keeps some of them. */
    args?: string[]
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
  const programs = new Map<string, FakeProgram>()
  const streams = new Map<string, FakeStream>()
  const processes = kitProcesses(() => env, programs, streams)
  const stderr: string[] = []
  const copied: string[] = []
  const platform: Platform = {
    dataDir: join(w.agentDir, 'delta'),
    clock,
    process: processes,
    // A subagent this pi starts is the fake `pi` a test stands in for (`kit.spawned`).
    launch: { command: ['pi'], args: options.args ?? [], cwd: options.cwd ?? w.checkout },
    env: {
      windows: () => options.windows ?? false,
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
    /** The extension's files on disk, where a test makes a read or write fail or hold (./disk.ts). */
    disk,
    /** The extension's store, as every pi process on the machine shares it, to read or seed. */
    store: fileStore(join(platform.dataDir, 'store')),
    /**
     * Programs other than `delta` a test stands in for, by name: `kit.programs.set('pi', (argv) => …)`.
     * Every other program runs for real.
     */
    programs,
    /** Long-running programs other than `delta` a test stands in for, by name, such as a subagent's `pi`. */
    streams,
    /** The other programs the extension ran, as full argument lists. */
    others: () => processes.others.map((call) => call.argv),
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
     * Wait for `work` while time passes, a second at a time, as it would while pi waits on a bounded
     * budget such as shutdown's. Between steps the real I/O under way gets a moment, so a loaded machine
     * cannot outrun the work; a real deadline of `timeoutMs` stops a wait that never ends.
     */
    async whileTimePasses<T>(work: Promise<T>, timeoutMs = 20_000): Promise<T> {
      let done = false
      const watched = work.finally(() => (done = true))
      const deadline = Date.now() + timeoutMs
      while (!done) {
        if (Date.now() > deadline) throw new Error('The work did not finish while time passed')
        await clock.advance(1_000)
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
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
