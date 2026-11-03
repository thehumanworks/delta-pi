#!/usr/bin/env node
// Runs the ast-grep that package.json pins with the given arguments, wherever `npm ci` installed it.
//
// npm installs a generic Linux build, whose loader (/lib64/ld-linux-x86-64.so.2) NixOS does not have
// without nix-ld. The loader that started this Node can run it, so where the two differ the pinned
// binary is run through Node's. Where npm has no build at all (musl Linux), the ast-grep on the PATH is
// used.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'

const args = process.argv.slice(2)
const binary = process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep'
const pinned = join(import.meta.dirname, '..', 'node_modules', '@ast-grep', 'cli', binary)

/** The program interpreter (PT_INTERP) a 64-bit little-endian ELF file names, if it names one. */
function interpreter(file) {
  const elf = readFileSync(file)
  if (elf.length < 64 || elf.readUInt32BE(0) !== 0x7f454c46 || elf[4] !== 2 || elf[5] !== 1) return undefined
  const headers = Number(elf.readBigUInt64LE(0x20))
  const size = elf.readUInt16LE(0x36)
  const count = elf.readUInt16LE(0x38)
  for (let index = 0; index < count; index++) {
    const header = headers + index * size
    if (elf.readUInt32LE(header) !== 3) continue
    const offset = Number(elf.readBigUInt64LE(header + 8))
    const length = Number(elf.readBigUInt64LE(header + 32))
    return elf
      .subarray(offset, offset + length)
      .toString()
      .replace(/\0+$/, '')
  }
  return undefined
}

/** How to start the pinned binary here: directly, or through the loader that started Node. */
function pinnedCommand() {
  if (!existsSync(pinned)) return undefined
  if (process.platform !== 'linux') return [pinned]
  const own = interpreter(pinned)
  const node = interpreter(process.execPath)
  return own && node && own !== node && existsSync(node) ? [node, pinned] : [pinned]
}

const run = ([command, ...prefix], env = process.env) =>
  spawnSync(command, [...prefix, ...args], { stdio: 'inherit', env })

const command = pinnedCommand()
let result = command && run(command)
if (!result || result.error) {
  console.error('The pinned ast-grep cannot run here; using the ast-grep on the PATH.')
  // npm puts its own bin folders, which hold the pinned binary, first on the PATH.
  const path = (process.env.PATH ?? '')
    .split(delimiter)
    .filter((entry) => !entry.endsWith(join('node_modules', '.bin')))
    .join(delimiter)
  result = run(['ast-grep'], { ...process.env, PATH: path })
  if (result.error) {
    console.error('There is no ast-grep on the PATH either: install ast-grep 0.51.1 (https://ast-grep.github.io).')
    process.exit(1)
  }
}
process.exit(result.status ?? 1)
