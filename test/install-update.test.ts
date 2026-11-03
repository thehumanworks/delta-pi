// Ported from the Claude Code plugin's hooks/cli/install-update.test.ts.
import { expect, test } from 'vitest'
import { parseInstallUpdate, parseProgressEvent } from '../src/cli/install-update.ts'

test('progress events are read by schema; other lines and unknown events are not progress', () => {
  expect(
    parseProgressEvent('{"schema_version":1,"type":"progress","phase":"downloading","version":"1.1","percent":45}'),
  ).toEqual({ type: 'progress', phase: 'downloading', version: '1.1', percent: 45 })
  expect(parseProgressEvent('{"schema_version":1,"type":"progress","phase":"checking"}')).toEqual({
    type: 'progress',
    phase: 'checking',
  })
  expect(
    parseProgressEvent(
      '{"schema_version":1,"type":"action_required","action":"approve_installer","message":"Approve it."}',
    ),
  ).toEqual({ type: 'action_required', action: 'approve_installer', message: 'Approve it.' })
  for (const line of [
    'delta: Delta is running agent work.',
    '{not json',
    '{"schema_version":2,"type":"progress","phase":"checking"}',
    '{"schema_version":1,"type":"progress","phase":"verifying"}',
    '{"schema_version":1,"type":"progress","phase":"downloading","percent":101}',
    '{"schema_version":1,"type":"progress","phase":"downloading","version":""}',
    '{"schema_version":1,"type":"action_required","action":"approve_installer"}',
  ])
    expect(parseProgressEvent(line)).toBeUndefined()
})

test('update replies require the negotiated schema and typed version fields', () => {
  const result = {
    schema_version: 1,
    status: 'update_available',
    current_version: '1.0',
    latest_version: '1.1',
    channel: 'stable',
    message: 'Available',
    can_install: true,
  }
  expect(parseInstallUpdate(JSON.stringify(result))).toMatchObject({
    status: 'update_available',
    currentVersion: '1.0',
    latestVersion: '1.1',
    canInstall: true,
  })
  for (const changed of [
    { schema_version: 2 },
    { status: 'new_status' },
    { latest_version: null },
    { channel: 'unknown' },
    { can_install: undefined },
    { can_install: 'false' },
  ])
    expect(() => parseInstallUpdate(JSON.stringify({ ...result, ...changed }))).toThrow()
})

test('a ready installer requires a target version, installation capability and its command', () => {
  const result = {
    schema_version: 1,
    status: 'install_ready',
    current_version: '1.0',
    latest_version: '1.1',
    channel: 'stable',
    message: 'Ready',
    can_install: true,
    install_argv: ['C:\\Updates\\helper.exe', '--internal-windows-update-install'],
  }
  expect(parseInstallUpdate(JSON.stringify(result))).toEqual({
    status: 'install_ready',
    currentVersion: '1.0',
    latestVersion: '1.1',
    message: 'Ready',
    canInstall: true,
    installArgv: ['C:\\Updates\\helper.exe', '--internal-windows-update-install'],
  })
  for (const changed of [
    { latest_version: null },
    { can_install: false },
    { install_argv: undefined },
    { install_argv: [] },
    { install_argv: ['helper.exe', ''] },
  ])
    expect(() => parseInstallUpdate(JSON.stringify({ ...result, ...changed }))).toThrow()
  expect(() => parseInstallUpdate(JSON.stringify({ ...result, status: 'updated', restart_required: 'yes' }))).toThrow()
})

test('an error envelope is the CLI error, and anything but an object is an unexpected reply', () => {
  expect(() =>
    parseInstallUpdate(JSON.stringify({ error: { code: 'not_authenticated', message: 'Sign in first' } })),
  ).toThrow('Sign in first')
  for (const reply of ['null', '[]', '"updated"', '1'])
    expect(() => parseInstallUpdate(reply)).toThrow('Unexpected Delta update response')
})
