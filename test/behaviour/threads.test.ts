import { afterEach, describe, expect, test } from 'vitest'
import { type Kit, type Model, startDelta } from '../kit/index.ts'
import { piProgram, type PiProgram } from '../kit/pi-program.ts'
import { actorOf } from '../fake-delta/cli.ts'

const kits: Kit[] = []
const programs: PiProgram[] = []
afterEach(async () => {
  const children = programs.flatMap((program) => program.children)
  for (const kit of [...kits, ...children]) kit.expectClean()
  // Children first: they share their parent's world, which the parent's stop removes.
  for (const kit of children.reverse()) await kit.stop()
  for (const kit of kits.reverse()) await kit.stop()
  kits.length = 0
  programs.length = 0
})

type Options = Parameters<typeof startDelta>[0]

/** A recorded session in a repository that syncs automatically, once its thread and checkout exist. */
async function parent(options: Options = {}) {
  const kit = await startDelta({ policy: { mode: 'organization', organization: 'org-1' }, ...options })
  kits.push(kit)
  await kit.until(() => kit.env.DELTA_PI_PARENT && kit.thread()?.worktrees.length, 'the session to record')
  const program = piProgram(kit)
  programs.push(program)
  return { kit, program, root: kit.thread()!.thread_id as string }
}

/** A thread of the conversation someone else started, sharing its worktrees, with one item in it. */
function teammateThread(kit: Kit, root: string, name = 'Release notes') {
  const created = kit.world.cli(
    'thread',
    'create',
    '--source',
    'other',
    '--external-id',
    `teammate-${name}`,
    '--parent',
    root,
    '--name',
    name,
    '--shared-worktrees',
  )
  const thread = { thread_id: created.thread_id as string, reference: created.reference as string, name }
  kit.world.remote(thread.thread_id, item('ask', 'user_message', 'We should ship release notes', 'Nathan'))
  return thread
}

/** Tell the session's watch a thread of its conversation has `status`. */
function listed(
  kit: Kit,
  root: string,
  thread: { thread_id: string; reference: string; name: string },
  status: string,
) {
  kit.world.remote(root, { type: 'child', child: { ...thread, kind: 'subthread', status } })
}

function item(id: string, kind: string, text: string, author?: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'item',
    item: {
      id,
      kind,
      after_id: null,
      turn_id: kind === 'agent_message' ? `turn-${id}` : null,
      author: author ? { user_id: null, name: author } : null,
      created_at: null,
      open: false,
      content: { text },
      ...extra,
    },
  }
}

/** A model that messages `thread` with `message` once, then says it is done. */
function messages(thread: string, message: string): Model {
  return (history) => {
    const last = history.at(-1) as { role: string } | undefined
    if (last?.role === 'toolResult') return { text: 'Done.' }
    return { calls: [{ name: 'delta_thread', arguments: { thread, message } }] }
  }
}

/** The text of the last `delta_thread` result. */
function reply(kit: Kit) {
  return kit.pi.toolResults.at(-1)?.result.content[0]?.text
}

/** The records a producer appended to a thread. */
function recordsOf(kit: Kit, thread: string, producer?: string) {
  const records = kit.world.delta().threads[thread]?.records ?? []
  return records.filter((record: any) => producer === undefined || record.producer === producer)
}

/** A record as its kind and its text, or the state it reports. */
function shape(record: any) {
  const content = record.update.content
  return [record.update.sessionUpdate, (Array.isArray(content) ? content[0] : content)?.text ?? record.update.state]
}

function notes(kit: Kit) {
  return kit.pi.contextMessages().flatMap((entry) => (typeof entry.content === 'string' ? [entry.content] : []))
}

const RUN_HERE = 'Run it here'

describe('Delta threads as subagents', () => {
  test('a message to a thread of the conversation runs it here, recorded on that thread, and the parent hears its reply', async () => {
    const { kit, program, root } = await parent({ answers: [RUN_HERE] })
    const notes_ = teammateThread(kit, root)
    listed(kit, root, notes_, 'inactive')
    await kit.until(() => notes(kit).some((note) => note.includes('"Release notes" (inactive)')), 'the threads note')
    const creates = kit.commands().filter((args) => args[0] === 'thread' && args[1] === 'create').length
    program.model = () => ({ text: 'Wrote RELEASE.md' })
    kit.pi.model = messages('Release notes', 'Write RELEASE.md')
    await kit.pi.prompt('delegate')

    expect(reply(kit)).toBe('The Delta thread "Release notes" finished its turn. Its reply:\n\nWrote RELEASE.md')
    const child = await program.child(0)
    // Its turn is recorded on the existing thread, prompted with the message alone; no thread was created.
    const records = recordsOf(kit, notes_.thread_id, child.pi.session.id)
    expect(records.map(shape)).toEqual([
      ['state_update', 'running'],
      ['user_message', 'Write RELEASE.md'],
      ['agent_message', 'Wrote RELEASE.md'],
      ['state_update', 'idle'],
    ])
    expect(records[1].update._meta.delta.sender).toEqual({ external_id: kit.pi.session.id })
    expect(kit.commands().filter((args) => args[0] === 'thread' && args[1] === 'create')).toHaveLength(creates)
    // The run was handed the thread's history, after its prompt, and the message never on its command line.
    expect(notes(child).join('\n')).toContain('We should ship release notes')
    expect(program.starts[0]!.argv).not.toContain('Write RELEASE.md')
    expect(program.starts[0]!.stdin).toBe('Write RELEASE.md')
  })

  test('each session is told which threads it can message, even when an earlier session in the process was told the same', async () => {
    const { kit, root } = await parent()
    const notes_ = teammateThread(kit, root)
    listed(kit, root, notes_, 'inactive')
    const told = () => notes(kit).filter((note) => note.includes('"Release notes"')).length
    await kit.until(() => told() === 1, 'the threads note')
    const first = kit.pi.session.file
    // Another session in this pi process, then the first again: its runtime tells it again.
    await kit.pi.newSessionIn()
    await kit.pi.switchTo(first)
    await kit.until(() => told() === 2, 'the threads note again')
  })

  test('a message to a thread is not delivered when no subagent starts for it', async () => {
    const { kit, program, root } = await parent({ answers: [RUN_HERE] })
    const notes_ = teammateThread(kit, root)
    listed(kit, root, notes_, 'inactive')
    await kit.until(() => notes(kit).length, 'the threads note')
    // The pi started for the thread never reports a run.
    program.next = 'silent'
    kit.pi.model = messages('Release notes', 'Write RELEASE.md')
    const sending = kit.pi.prompt('delegate')
    await kit.until(() => program.starts.length, 'pi to be started')
    await kit.advance(30_000)
    await sending
    expect(reply(kit)).toBe('pi started no subagent to run the Delta thread "Release notes".')
    expect(await kit.store.get(`thread-run:${kit.pi.session.id}:${notes_.thread_id}`)).toBeUndefined()
    expect(recordsOf(kit, notes_.thread_id)).toEqual([])
  })

  test('a thread whose pi cannot start says why', async () => {
    const { kit, program, root } = await parent({ answers: [RUN_HERE] })
    const notes_ = teammateThread(kit, root)
    listed(kit, root, notes_, 'inactive')
    await kit.until(() => notes(kit).length, 'the threads note')
    program.next = { stderr: 'No API key found for faux.\n', code: 1 }
    kit.pi.model = messages('Release notes', 'Write RELEASE.md')
    await kit.pi.prompt('delegate')
    expect(reply(kit)).toBe('pi could not run the Delta thread "Release notes": No API key found for faux.')
  })

  test('Claude takes over a thread someone else is running only when the person agrees', async () => {
    // A session no one can answer is not offered threads to run.
    const unattended = await parent({ mode: 'print' })
    await unattended.kit.pi.prompt('hello')
    expect(unattended.kit.pi.activeTools).not.toContain('delta_thread')

    const { kit, program, root } = await parent()
    const notes_ = teammateThread(kit, root)
    kit.world.remote(notes_.thread_id, {
      type: 'turn',
      state: 'running',
      turn_id: 'their-turn',
      user: { user_id: 'user-other', name: 'Antonio' },
    })
    listed(kit, root, notes_, 'running')
    await kit.until(() => notes(kit).length, 'the threads note')
    kit.pi.model = messages('Release notes', 'Write RELEASE.md')

    // Asked, the person may leave it running.
    kit.pi.answers.push(RUN_HERE, 'Leave it running')
    await kit.pi.prompt('delegate')
    expect(reply(kit)).toContain('running in Delta (Antonio)')
    expect(kit.pi.dialogs.at(-1)?.title).toBe(
      'pi wants to take over "Release notes", which Antonio is running in Delta. Take it over?',
    )
    expect(program.starts).toEqual([])

    // Or let pi take it over.
    kit.pi.answers.push('Take it over')
    await kit.pi.prompt('delegate again')
    expect(reply(kit)).toContain('finished its turn')
  })

  test('a subagent resumed by a message hears what happened in Delta since it last ran, and its message is recorded', async () => {
    const { kit, program, root } = await parent({ answers: [RUN_HERE] })
    const notes_ = teammateThread(kit, root)
    listed(kit, root, notes_, 'inactive')
    await kit.until(() => notes(kit).length, 'the threads note')
    program.model = () => ({ text: 'Parser looks fine' })
    kit.pi.model = messages('Release notes', 'Inspect the parser')
    await kit.pi.prompt('delegate')
    const first = await program.child(0)
    const producer = first.pi.session.id
    kit.world.remote(
      notes_.thread_id,
      item('own', 'agent_message', 'Parser looks fine', 'pi', {
        author: { user_id: null, name: 'pi', actor_id: actorOf(producer) },
      }),
      item('ask-2', 'user_message', 'Also check the lexer', 'Nathan'),
      item('delta', 'agent_message', 'The lexer is fine too', 'Delta agent'),
    )

    program.model = () => ({ text: 'Both are fine' })
    kit.pi.model = messages('Release notes', 'Summarize both')
    await kit.pi.prompt('again')
    // The same pi session resumes, told what it missed after its prompt.
    expect(program.starts[1]!.argv).toContain('--session')
    const second = await program.child(1)
    expect(second.pi.session.id).toBe(producer)
    const told = notes(second).at(-1)!
    for (const part of ['Also check the lexer', 'The lexer is fine too', 'Summarize both']) expect(told).toContain(part)
    expect(told).not.toContain('Parser looks fine')
    const prompts = recordsOf(kit, notes_.thread_id, producer).filter(
      (record: any) => record.update.sessionUpdate === 'user_message',
    )
    expect(prompts.map((record: any) => [shape(record)[1], record.turnSequence])).toEqual([
      ['Inspect the parser', 1],
      ['Summarize both', 5],
    ])

    // Delta reports the resumed turn's end too; it was pi's own, so the parent hears nothing of it.
    kit.world.remote(
      notes_.thread_id,
      item('own-2', 'agent_message', 'Both are fine', 'pi', {
        author: { user_id: null, name: 'pi', actor_id: actorOf(producer) },
      }),
    )
    listed(kit, root, notes_, 'running')
    listed(kit, root, notes_, 'inactive')
    await kit.until(
      () =>
        kit.commands().filter((args) => args[0] === 'thread' && args[1] === 'status' && args.includes(producer)).length,
      'the turn to be read',
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(notes(kit).filter((note) => note.includes('ran a turn in the thread'))).toEqual([])
  })

  test("a takeover in Delta stops a running subagent at once, and the parent hears Delta's reply, then later Delta turns as context", async () => {
    const { kit, program, root } = await parent({ answers: [RUN_HERE] })
    const notes_ = teammateThread(kit, root)
    listed(kit, root, notes_, 'inactive')
    await kit.until(() => notes(kit).length, 'the threads note')
    // The thread's run is inside a long call, so only its watch can see a takeover.
    program.model = (_history, signal) => new Promise((resolve) => signal!.addEventListener('abort', () => resolve({})))
    kit.pi.model = messages('Release notes', 'Inspect the parser')
    const sending = kit.pi.prompt('delegate')
    const child = await program.child(0)
    const producer = child.pi.session.id
    const running = await kit.until(
      () => recordsOf(kit, notes_.thread_id, producer).find((record: any) => record.update.state === 'running'),
      "the thread's running turn",
    )
    await kit.until(
      () => child.commands().some((args) => args[1] === 'watch' && args.includes(producer)),
      "the run's turn to be followed",
    )
    // Everything the run recorded before the takeover has reached Delta: its start and its prompt.
    const recorded = (
      await kit.until(() => {
        const before = recordsOf(kit, notes_.thread_id, producer)
        return before.some((record: any) => record.update.sessionUpdate === 'user_message') && before
      }, "the run's prompt")
    ).length
    kit.world.remote(notes_.thread_id, { type: 'producer.turn', sequence: running.sequence, status: 'superseded' })
    await sending
    expect(reply(kit)).toBe(
      `[Delta] Someone took over the thread "Release notes" in Delta, so pi stopped its run here. Delta's agent continues it in that thread; its reply is added here when Delta's turn ends. Send "Release notes" a message with delta_thread to run it here again.`,
    )
    // pi records only the end of the turn Delta took over, which Delta fences.
    expect(recordsOf(kit, notes_.thread_id, producer).slice(recorded).map(shape)).toEqual([['state_update', 'idle']])

    // The parent waited on that turn, so its reply starts a turn of the parent's own.
    kit.pi.model = () => ({ text: 'Noted.' })
    listed(kit, root, notes_, 'running')
    kit.world.remote(notes_.thread_id, item('reply', 'agent_message', 'The parser is fine', 'Delta agent'))
    listed(kit, root, notes_, 'inactive')
    await kit.until(() => kit.pi.sentPrompts.length, "Delta's reply")
    expect(kit.pi.sentPrompts.at(-1)).toContain('Delta agent ran a turn in the thread "Release notes" in Delta')
    expect(kit.pi.sentPrompts.at(-1)).toContain('The parser is fine')
    await kit.until(() => kit.pi.idle, 'the parent turn to end')
    await kit.pi.settled()

    // Nobody waits on the next one: it is context, reported from where the last report ended.
    listed(kit, root, notes_, 'running')
    kit.world.remote(
      notes_.thread_id,
      item('ask-3', 'user_message', 'Check the lexer too', 'Nathan'),
      item('reply-2', 'agent_message', 'The lexer is fine', 'Delta agent'),
    )
    listed(kit, root, notes_, 'inactive')
    await kit.until(() => notes(kit).some((note) => note.includes('The lexer is fine')), 'the next report')
    const report = notes(kit).at(-1)!
    expect(report).not.toContain('The parser is fine')
    expect(kit.pi.sentPrompts).toHaveLength(1)
  })

  test('stopping the turn that runs a thread stops its pi, which records its turn as cancelled', async () => {
    const { kit, program, root } = await parent({ answers: [RUN_HERE] })
    const notes_ = teammateThread(kit, root)
    listed(kit, root, notes_, 'inactive')
    await kit.until(() => notes(kit).length, 'the threads note')
    program.model = (_history, signal) => new Promise((resolve) => signal!.addEventListener('abort', () => resolve({})))
    kit.pi.model = messages('Release notes', 'Inspect the parser')
    const sending = kit.pi.prompt('delegate')
    const child = await program.child(0)
    await kit.until(
      () =>
        recordsOf(kit, notes_.thread_id, child.pi.session.id).some((record: any) => record.update.state === 'running'),
      "the thread's running turn",
    )
    kit.pi.abort()
    await sending
    expect(kit.pi.toolResults.at(-1)?.result.isError).toBe(true)
    const last = recordsOf(kit, notes_.thread_id, child.pi.session.id).at(-1)
    expect(last.update).toMatchObject({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'cancelled' })
  })

  test('a subagent is not offered threads to run', async () => {
    const { kit } = await parent()
    const sub = await startDelta({ world: kit.world, env: { DELTA_PI_PARENT: kit.env.DELTA_PI_PARENT! } })
    kits.push(sub)
    await sub.pi.prompt('inspect the parser')
    expect(sub.pi.activeTools).not.toContain('delta_thread')
    const outcome = await new Promise<string>((resolve) => {
      sub.pi.model = (history) =>
        (history.at(-1) as { role: string }).role === 'toolResult'
          ? { text: 'Done.' }
          : { calls: [{ name: 'delta_thread', arguments: { thread: 'Release notes', message: 'go' } }] }
      void sub.pi.prompt('try').then(() => resolve(reply(sub) ?? ''))
    })
    expect(outcome).toBe('Delta threads can be run only from an interactive pi session that Delta records.')
  })
})
