/**
 * A stand-in for the `pi` program a session starts to run a Delta thread (`pi --mode json -p …`): it
 * starts another kit in the same world, the child pi with the extension, prompts it with its input,
 * and prints what pi's JSON mode prints, the session header, the run's events and each committed
 * message, until the run settles and pi shuts down. Asked to stop, it shuts the child down as pi's
 * SIGTERM handling does: `session_shutdown` first, then the run is aborted.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Exit, Output, ProcessStream } from '../../src/core/process.ts'
import { type Kit, type Model, FakeSession, startDelta, until } from './index.ts'

export type PiProgram = {
  /** The child kits started, in order; the test stops them. */
  children: Kit[]
  /** The arguments each start had, and its input. */
  starts: { argv: string[]; stdin: string | undefined; cwd: string | undefined }[]
  /** The model the next child answers with. */
  model?: Model
  /** How the next start goes instead of running: it prints nothing, or fails as pi does without a model. */
  next?: 'silent' | { stderr: string; code: number }
  /** Wait for the child kit started for the `index`th start. */
  child(index: number): Promise<Kit>
}

/** Stand in for `pi` in `parent`'s kit with in-process child kits. */
export function piProgram(parent: Kit): PiProgram {
  const sessions = new Map<string, FakeSession>()
  const started: ((kit: Kit) => void)[] = []
  const ready: Promise<Kit>[] = []
  const program: PiProgram = {
    children: [],
    starts: [],
    child: async (index) => until(() => ready[index], `pi start ${index}`),
  }
  parent.programs.set('pi', (argv, init) => {
    const index = program.starts.length
    program.starts.push({ argv, stdin: init.stdin, cwd: init.cwd })
    ready.push(new Promise((resolve) => (started[index] = resolve)))
    const queue: Output[] = []
    let exit: Exit | undefined
    let waiting: (() => void) | undefined
    const wake = () => {
      const resume = waiting
      waiting = undefined
      resume?.()
    }
    const print = (record: unknown) => {
      if (exit) return
      queue.push({ stream: 'stdout', text: `${JSON.stringify(record)}\n` })
      wake()
    }
    const end = (code: number | null, signal: string | null = null) => {
      exit ??= { code, signal }
      wake()
    }
    const behaviour = program.next
    program.next = undefined
    let kit: Kit | undefined
    let stopping: Promise<void> | undefined
    const stop = () => {
      stopping ??= (async () => {
        if (!kit) return end(null, 'SIGTERM')
        await kit.stop()
        kit.pi.abort()
        end(143)
      })()
    }
    void (async () => {
      if (behaviour === 'silent') return
      if (behaviour) {
        queue.push({ stream: 'stderr', text: behaviour.stderr })
        return end(behaviour.code)
      }
      const option = (name: string) => {
        const at = argv.indexOf(name)
        return at < 0 ? undefined : argv[at + 1]
      }
      const file = option('--session')
      const id = option('--session-id')
      const cwd = init.cwd ?? parent.world.checkout
      let session = file ? sessions.get(file) : undefined
      if (!session) {
        const path = file ?? join(parent.world.agentDir, 'sessions', `${id}.jsonl`)
        session = new FakeSession(id ?? `pi-${index}`, cwd, path)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, `${JSON.stringify({ type: 'session', id: session.id, cwd })}\n`)
        sessions.set(path, session)
      }
      print({ type: 'session', version: 3, id: session.id, cwd })
      kit = await startDelta({ world: parent.world, cwd, env: init.env, session, start: false })
      program.children.push(kit)
      if (program.model) kit.pi.model = program.model
      kit.pi.observers.push((type, event) => {
        if (['agent_start', 'agent_settled', 'tool_execution_start', 'message_end'].includes(type))
          print({ type, ...event })
      })
      await kit.pi.start()
      started[index]!(kit)
      if (stopping) return
      await kit.pi.prompt(init.stdin ?? '')
      if (stopping) return
      await kit.stop()
      end(0)
    })().catch((error: unknown) => {
      queue.push({ stream: 'stderr', text: String(error) })
      end(1)
    })
    const stream: ProcessStream = {
      pid: undefined,
      async next() {
        for (;;) {
          const piece = queue.shift()
          if (piece) return { done: false, value: piece }
          if (exit) return { done: true, value: exit }
          await new Promise<void>((resolve) => (waiting = resolve))
        }
      },
      async return() {
        stop()
        await stopping
        end(null, 'SIGTERM')
        return { done: true, value: exit! }
      },
      terminate: stop,
    }
    return stream
  })
  return program
}
