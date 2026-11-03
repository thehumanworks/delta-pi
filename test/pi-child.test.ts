import { describe, expect, test } from 'vitest'
import { allowsTool, isSessionId, jsonRecords, keptArguments } from '../src/subagents/pi-child.ts'

describe('starting a pi for a Delta thread', () => {
  test("a thread's pi keeps its parent's extensions and restrictions, with their paths made absolute", async () => {
    const launch = {
      command: ['pi'],
      cwd: '/work',
      args: [
        ...['-e', './faux.ts', '-e', 'npm:@scope/ext', '--provider', 'faux', '--model', 'faux-1'],
        ...[
          '--tools',
          'read,bash',
          '--no-skills',
          '--append-system-prompt',
          'rules.md',
          '--append-system-prompt',
          'Be brief',
        ],
        ...['--session-dir', 'sessions', '--approve', '--', '-e', 'not an option'],
      ],
    }
    const exists = async (path: string) => path === '/work/rules.md'
    expect(await keptArguments(launch, exists)).toEqual([
      ...['-e', '/work/faux.ts', '-e', 'npm:@scope/ext', '--tools', 'read,bash', '--no-skills'],
      ...[
        '--append-system-prompt',
        '/work/rules.md',
        '--append-system-prompt',
        'Be brief',
        '--session-dir',
        '/work/sessions',
      ],
    ])
  })

  test("the thread tool is offered only where pi's tool options leave it on", () => {
    expect(allowsTool([], 'delta_thread')).toBe(true)
    expect(allowsTool(['--tools', 'read,bash'], 'delta_thread')).toBe(false)
    expect(allowsTool(['--tools', 'read,delta_*'], 'delta_thread')).toBe(true)
    expect(allowsTool(['--tools', '+codemode,-write'], 'delta_thread')).toBe(true)
    expect(allowsTool(['--tools', '-delta_thread'], 'delta_thread')).toBe(false)
    expect(allowsTool(['--exclude-tools', 'delta*'], 'delta_thread')).toBe(false)
    expect(allowsTool(['--no-tools'], 'delta_thread')).toBe(false)
  })

  test("pi's session IDs follow pi's own rule", () => {
    expect(isSessionId('0195-abc_d.e')).toBe(true)
    expect(isSessionId('-abc')).toBe(false)
    expect(isSessionId('a b')).toBe(false)
  })

  test("pi's JSON output is split on line feeds only, across pieces", () => {
    const read = jsonRecords()
    expect(read('{"type":"agent_start"}\n{"type":"message_end","text":"a b"')).toEqual([{ type: 'agent_start' }])
    expect(read('}\r\nnot json\n')).toEqual([{ type: 'message_end', text: 'a b' }])
  })
})
