#!/usr/bin/env node
// Checks the release as people get it: packs the package with npm, installs the packed files into a
// throwaway pi with `pi install`, and runs a Delta command through it against the fake Delta CLI. A
// file the package leaves out, or one pi cannot load, fails here though every test passes on the checkout.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = join(import.meta.dirname, '..')
const pi = join(repo, 'node_modules', '.bin', 'pi')
const base = mkdtempSync(join(tmpdir(), 'pi-delta-package-'))
try {
  const [packed] = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--pack-destination', base], { cwd: repo, encoding: 'utf8' }),
  )
  console.log(`Packed ${packed.filename}: ${packed.files.length} files, ${packed.size} bytes.`)
  const unexpected = packed.files.map((file) => file.path).filter((path) => /^(test|scripts|ast-grep)\//.test(path))
  if (unexpected.length) throw new Error(`The package ships development files: ${unexpected.join(', ')}`)
  const extracted = join(base, 'extracted')
  mkdirSync(extracted)
  execFileSync('tar', ['-xzf', join(base, packed.filename), '-C', extracted])

  const agentDir = join(base, 'agent')
  const project = join(base, 'project')
  const state = join(base, 'delta')
  for (const directory of [agentDir, project, state]) mkdirSync(directory)
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ quietStartup: true }))
  execFileSync('git', ['init', '-q'], { cwd: project })
  const env = {
    ...process.env,
    PATH: `${join(repo, 'test', 'e2e', 'bin')}:${process.env.PATH}`,
    PI_CODING_AGENT_DIR: agentDir,
    FAKE_DELTA_STATE: state,
    PI_OFFLINE: '1',
  }
  execFileSync(pi, ['install', join(extracted, 'package')], { cwd: project, env, stdio: 'inherit' })
  const faux = join(repo, 'test', 'e2e', 'faux-model.ts')
  const run = spawnSync(pi, ['-p', '-e', faux, '--provider', 'faux', '--model', 'faux-1', '/delta-org list'], {
    cwd: project,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (run.status !== 0 || !run.stderr.includes('* org-1  Zed'))
    throw new Error(`pi did not run the installed extension's command.\nstdout: ${run.stdout}\nstderr: ${run.stderr}`)
  console.log('pi installed the packed release, loaded it, and ran /delta-org list through it.')

  // A Delta thread's pi is started with `-e <the extension's own folder>`; pi must not load the
  // installed package a second time for it.
  const again = spawnSync(
    pi,
    ['-p', '-e', join(extracted, 'package'), '-e', faux, '--provider', 'faux', '--model', 'faux-1', '/delta-org list'],
    { cwd: project, env, encoding: 'utf8', timeout: 60_000 },
  )
  const listed = again.stderr.split('* org-1  Zed').length - 1
  if (again.status !== 0 || listed !== 1 || /conflict|already registered|Extension error/i.test(again.stderr))
    throw new Error(`pi loaded the installed extension again for -e.\nstdout: ${again.stdout}\nstderr: ${again.stderr}`)
  console.log('pi loaded the installed release once when it was also named with -e.')
} finally {
  rmSync(base, { recursive: true, force: true })
}
