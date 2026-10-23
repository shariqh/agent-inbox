#!/usr/bin/env node
// #87 PR 2b: the MSI's checksum file. The artifact folder must hold exactly
// Agent-Inbox-v<version>-windows-x64.msi; SHA256SUMS-windows.txt goes beside it in
// the `sha256sum -c` form the macOS release uses (`<hex>  <name>\n`) and is read
// back before anything uploads it.
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

export const CHECKSUMS = 'SHA256SUMS-windows.txt'

export const msiName = (version) => `Agent-Inbox-v${version}-windows-x64.msi`

function checksumText(dir, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error(`not a release version: ${version}`)
  const name = msiName(version)
  const names = readdirSync(dir).filter((entry) => entry !== CHECKSUMS)
  if (names.length !== 1 || names[0] !== name) {
    throw new Error(`${dir} must hold only ${name}, not ${names.sort().join(', ') || 'nothing'}`)
  }
  if (!lstatSync(join(dir, name)).isFile()) throw new Error(`${name} is not a regular file`)
  return `${createHash('sha256').update(readFileSync(join(dir, name))).digest('hex')}  ${name}\n`
}

export function verifyWindowsChecksums(dir, version) {
  const text = checksumText(dir, version)
  let written
  try {
    written = readFileSync(join(dir, CHECKSUMS), 'utf8')
  } catch {
    throw new Error(`${CHECKSUMS} is missing`)
  }
  if (written !== text) throw new Error(`${CHECKSUMS} is stale or malformed`)
  return text
}

export function writeWindowsChecksums(dir, version) {
  writeFileSync(join(dir, CHECKSUMS), checksumText(dir, version))
  return verifyWindowsChecksums(dir, version)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      dir: { type: 'string' },
      version: { type: 'string' },
      verify: { type: 'boolean', default: false },
    },
  })
  if (!values.dir || !values.version) {
    process.stderr.write('usage: checksums.mjs --dir <artifact dir> --version <x.y.z> [--verify]\n')
    process.exit(2)
  }
  const dir = resolve(values.dir)
  process.stdout.write(values.verify ? verifyWindowsChecksums(dir, values.version) : writeWindowsChecksums(dir, values.version))
}
