// The fake Delta CLI (test/fake-delta/cli.ts) answers in the shapes of the native CLI's own output
// (test/fixtures/cli): each command the extension runs, on fresh state, has every field of its fixture
// with the same JSON type, so a test passing on the fake says something about the real CLI.
import { afterEach, expect, test } from 'vitest'
import { SOURCE } from '../src/cli/thread-commands.ts'
import { cliErrorCodes, cliFixtureData, cliWatchFrames } from './cli-fixtures.ts'
import { fakeDelta } from './fake-delta/cli.ts'
import { world, type World } from './world.ts'

const worlds: World[] = []
afterEach(() => {
  for (const w of worlds.splice(0)) w.cleanup()
})
function fresh(): World {
  const w = world()
  worlds.push(w)
  return w
}

/**
 * Run the fake in process, as the kit does, and return its stdout's JSON lines and exit code. A
 * long-running command (mount, watch) returns once it has answered: its hold resolves at once.
 */
async function run(w: World, args: string[], stdin = ''): Promise<{ lines: any[]; code: number }> {
  let stdout = ''
  const code = await fakeDelta(['--json', ...args], {
    env: { ...process.env, FAKE_DELTA_STATE: w.state },
    stdin: () => stdin,
    write: (stream, text) => {
      if (stream === 'stdout') stdout += text
    },
    hold: async () => {},
  })
  return {
    lines: stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
    code,
  }
}
/** The one JSON answer of a command that must succeed. */
async function answer(w: World, args: string[], stdin = ''): Promise<any> {
  const { lines, code } = await run(w, args, stdin)
  expect(code, `delta ${args.join(' ')}`).toBe(0)
  expect(lines).toHaveLength(1)
  return lines[0]
}

type Shape = Record<string, string>
/**
 * Each path of `value` with its JSON type: `string`, `number`, `boolean`, `null`, `object` or `array`.
 * An array's elements are described by its first, at `path[]`, so lists of any length compare.
 */
function shapeOf(value: unknown, path = '$', into: Shape = {}): Shape {
  if (value === null) into[path] = 'null'
  else if (Array.isArray(value)) {
    into[path] = 'array'
    if (value.length) shapeOf(value[0], `${path}[]`, into)
  } else if (typeof value === 'object') {
    into[path] = 'object'
    for (const [key, field] of Object.entries(value)) shapeOf(field, `${path}.${key}`, into)
  } else into[path] = typeof value
  return into
}

/**
 * Check `actual` has `fixture`'s shape. `nullable` names paths the fixture shows null where the fake
 * holds a value, or the reverse, each for a reason given at the call; whatever lies beneath such a
 * path is not compared. `extra` names the paths the fake adds beyond the fixture's.
 */
function expectShape(actual: unknown, fixture: unknown, { nullable = [], extra = [] }: Options = {}) {
  const want = shapeOf(fixture)
  const got = shapeOf(actual)
  // An array's elements compare only where both sides have one.
  const elements = (path: string) =>
    [...path.matchAll(/\[\]/g)].every((match) => {
      const element = path.slice(0, match.index + 2)
      return element in want && element in got
    })
  const kept = (path: string) => !under(path, nullable) && elements(path)
  const expected = Object.fromEntries(Object.entries(want).filter(([path]) => kept(path)))
  const seen = Object.fromEntries(Object.keys(expected).map((path) => [path, got[path] ?? 'missing']))
  expect(seen).toEqual(expected)
  const added = Object.keys(got).filter((path) => !(path in want) && kept(path) && !under(path, extra))
  expect(added, 'fields the fake adds to the fixture').toEqual([])
}
/** Whether `path` is one of `prefixes` or lies beneath one. */
const under = (path: string, prefixes: string[]) =>
  prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[]`))
type Options = { nullable?: string[]; extra?: string[] }

const session = 'session'
const producer = ['--source', SOURCE, '--external-id', session]
/** A thread the extension creates for a pi session, as `createThread` in src/cli/delta-cli.ts asks for it. */
async function createThread(w: World, ...more: string[]): Promise<string> {
  return (await answer(w, ['thread', 'create', ...producer, ...more])).thread_id
}
/** A worktree for the world's checkout, attached to `thread`, as activation does it. */
async function attachWorktree(w: World, thread: string): Promise<string> {
  const { reference } = await answer(w, ['worktree', 'create', w.checkout])
  await answer(w, ['worktree', 'attach', reference, '--thread', thread])
  return reference
}
const append = (thread: string) => ['thread', 'append', thread, ...producer, '--producer-name', 'pi']
const line = (record: Record<string, unknown>) => `${JSON.stringify({ schemaVersion: 1, ...record })}\n`
const message = (sequence: number, turnSequence?: number) =>
  line({
    sequence,
    turnSequence,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
  })

test('thread contract answers in the fixture shape', async () => {
  expectShape(await answer(fresh(), ['thread', 'contract']), cliFixtureData['thread-contract'])
})

test('thread create answers in the fixture shape, for a thread and for a child', async () => {
  const w = fresh()
  const created = await answer(w, ['thread', 'create', ...producer])
  expectShape(created, cliFixtureData['thread-create'])
  const child = await answer(w, [
    'thread',
    'create',
    '--source',
    SOURCE,
    '--external-id',
    'child',
    '--parent',
    created.thread_id,
    '--name',
    'Scout',
  ])
  expectShape(child, cliFixtureData['thread-create.child'])
})

test('thread share and thread invite answer in the fixture shapes', async () => {
  const w = fresh()
  const thread = await createThread(w)
  expectShape(
    await answer(w, ['thread', 'share', thread, '--visibility', 'organization']),
    cliFixtureData['thread-share'],
  )
  // The fixture's second result is a refused address; the fake refuses the addresses a test names.
  w.inviteFailures({ 'bo@example.com': 'already a member' })
  const invited = await answer(w, ['thread', 'invite', thread, '--', 'ada@example.com', 'bo@example.com'])
  expectShape(invited, cliFixtureData['thread-invite'])
  expectShape(invited.results[1], cliFixtureData['thread-invite'].results[1])
})

test('thread status answers in the fixture shape when granted', async () => {
  const w = fresh()
  const thread = await createThread(w)
  await answer(w, ['thread', 'share', thread, '--visibility', 'organization'])
  // A recorded title, so `title` is a string as the fixture's is.
  await answer(
    w,
    append(thread),
    line({ sequence: 1, update: { sessionUpdate: 'session_info_update', title: 'Observed' } }),
  )
  expectShape(await answer(w, ['thread', 'status', thread, ...producer]), cliFixtureData['thread-status.granted'], {
    // The fake gives each producer an actor so a test can write the producer's own items (`actorOf`).
    nullable: ['$.producer.actor_id'],
  })
})

test('thread status answers in the fixture shape when local only', async () => {
  const w = fresh()
  // The fake answers `local_only` only for a thread whose upload Delta has not registered yet: one
  // created with an upload organization, its upload queued. Without `--visibility` (which the extension
  // always sends with an organization) it reports no upload, as the fixture does.
  w.upload({ state: 'queued' })
  const thread = await createThread(w, '--organization', 'org-1')
  expectShape(await answer(w, ['thread', 'status', thread, ...producer]), cliFixtureData['thread-status.local_only'], {
    // Fixture and fake each name a title only once one is recorded; the fake gives each producer an actor.
    nullable: ['$.title', '$.producer.actor_id'],
  })
})

// thread-status.worktrees_unavailable: the fake reports an unreadable inventory only when a test patches
// the status (`world().patchStatus`) with the very shape it would be compared against, so it is not checked.

test('thread append answers each disposition in the fixture shape, alone and as a batch', async () => {
  const w = fresh()
  const thread = await createThread(w)
  expectShape(await answer(w, append(thread), message(1)), cliFixtureData['thread-append.recorded'])
  w.fence(session, 1)
  expectShape(await answer(w, append(thread), message(2, 1)), cliFixtureData['thread-append.fenced'])
  expectShape(await answer(w, append(thread), message(1)), cliFixtureData['thread-append.duplicate'])

  // The fixture batch: recorded, fenced, then a duplicate of the first, on a thread of its own.
  const other = fresh()
  const batchThread = await createThread(other)
  other.fence(session, 1)
  const { lines, code } = await run(other, append(batchThread), message(1) + message(2, 1) + message(1))
  expect(code).toBe(0)
  const batch = cliFixtureData['thread-append.batch'] as unknown[]
  expect(lines).toHaveLength(batch.length)
  lines.forEach((receipt, index) => expectShape(receipt, batch[index]))
})

test('thread mount answers in the fixture shape', async () => {
  const w = fresh()
  const thread = await createThread(w)
  await attachWorktree(w, thread)
  expectShape(await answer(w, ['thread', 'mount', thread, '--owner', session]), cliFixtureData['thread-mount'])
})

test('worktree create, attach, detach, mount and list answer in the fixture shapes', async () => {
  const w = fresh()
  const thread = await createThread(w)
  const created = await answer(w, ['worktree', 'create', w.checkout])
  expectShape(created, cliFixtureData['worktree-create'])
  expectShape(
    await answer(w, ['worktree', 'attach', created.reference, '--thread', thread]),
    cliFixtureData['worktree-attach'],
  )
  expectShape(await answer(w, ['worktree', 'list']), cliFixtureData['worktree-list'], {
    // The fixture's worktree is known only locally, so it has no ID yet; the fake's are all registered.
    nullable: ['$.worktrees[].worktree_id'],
  })
  expectShape(
    await answer(w, ['worktree', 'mount', created.reference, w.checkout, '--existing-checkout']),
    cliFixtureData['worktree-mount'],
  )
  expectShape(
    await answer(w, ['worktree', 'detach', created.reference, '--thread', thread]),
    cliFixtureData['worktree-detach'],
  )
})

// Of thread-watch.frames.jsonl, the fake itself writes `ready`, `live`, `presence` and `worktrees`; every
// other frame (item, item.append, remove, turn, producer.turn, comment, comment.remove, children, child,
// child.remove) is one a test writes for it (`world().remote`), so the fake has no shape of its own to check.
test('thread watch writes its own frames in the fixture shapes', async () => {
  const w = fresh()
  const thread = await createThread(w)
  await attachWorktree(w, thread)
  const frame = (type: string, withProducer?: boolean) =>
    cliWatchFrames.find(
      (candidate) => candidate.type === type && (withProducer === undefined || !!candidate.producer === withProducer),
    )
  const watched = (await run(w, ['thread', 'watch', thread])).lines
  expectShape(watched[0], frame('ready', false))
  for (const type of ['live', 'presence', 'worktrees'])
    expectShape(
      watched.find((candidate) => candidate.type === type),
      frame(type),
    )
  const producing = (await run(w, ['thread', 'watch', thread, ...producer])).lines
  expectShape(producing[0], frame('ready', true), {
    // The fixture's producer is mid-turn; the fake's has never started one.
    nullable: ['$.producer.turn'],
  })
})

test('a failing command answers with an error envelope in the shape Delta publishes', async () => {
  const w = fresh()
  const { lines, code } = await run(w, ['thread', 'status', 'thread_missing', ...producer])
  expect(code).toBe(1)
  expect(lines).toHaveLength(1)
  expectShape(
    lines[0],
    cliWatchFrames.find((frame) => frame.error),
  )
  const { error } = lines[0]
  expect(Object.keys(cliErrorCodes)).toContain(error.code)
  expect(error.retryable).toBe(cliErrorCodes[error.code].retryable)
  // A missing argument fails with a published code too.
  const missing = await run(w, ['worktree', 'create'])
  expect(Object.keys(cliErrorCodes)).toContain(missing.lines[0].error.code)
  expectShape(
    missing.lines[0],
    cliWatchFrames.find((frame) => frame.error),
  )
})
