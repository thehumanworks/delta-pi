#!/usr/bin/env node
// Runs ast-grep with the given arguments: the version package.json pins, or, where that binary cannot
// run (NixOS without nix-ld), the ast-grep on the PATH, as `nix shell nixpkgs#ast-grep` provides.
import { spawnSync } from 'node:child_process'
import { delimiter, join } from 'node:path'

const args = process.argv.slice(2)
const pinned = join(import.meta.dirname, '..', 'node_modules', '@ast-grep', 'cli', 'ast-grep')
const run = (command, env = process.env) => spawnSync(command, args, { stdio: 'inherit', env })
let result = run(pinned)
// 127 is the NixOS stub loader refusing a generic Linux binary; ENOENT, no binary for this platform.
if (result.error || result.status === 127) {
  console.error('The pinned ast-grep cannot run here; using the ast-grep on the PATH.')
  // npm puts its own bin folders, holding the binary that just failed, first on the PATH.
  const path = (process.env.PATH ?? '')
    .split(delimiter)
    .filter((entry) => !entry.endsWith(join('node_modules', '.bin')))
    .join(delimiter)
  result = run('ast-grep', { ...process.env, PATH: path })
  if (result.error) {
    console.error('No ast-grep on the PATH either. Install it, for example with `nix shell nixpkgs#ast-grep`.')
    process.exit(1)
  }
}
process.exit(result.status ?? 1)
