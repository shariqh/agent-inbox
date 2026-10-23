#!/usr/bin/env node
// #87 installer spike (CI only): measure an installed or restored Windows app tree.
//
// The digest uses scripts/tree-identity.mjs's record format, so an installed tree
// can be compared with the appTreeDigest its folder build verified. --exclude
// drops top-level entries an installer adds beside the app (Squirrel's
// squirrel.exe); with no exclusions the result must equal treeIdentity() itself.
// --compare lists what differs from a verified folder: added, changed, missing.
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { treeIdentity } from '../../scripts/tree-identity.mjs'

const PE = /\.(exe|dll|node)$/i

function walk(root, excluded, directory = root, out = []) {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name)
    const key = relative(root, path).split(sep).join('/')
    if (directory === root && excluded.has(name.toLowerCase())) continue
    const stat = lstatSync(path)
    if (stat.isDirectory()) {
      walk(root, excluded, path, out)
    } else if (stat.isSymbolicLink()) {
      out.push({ record: ['symlink', key, readlinkSync(path)], key, bytes: 0 })
    } else if (stat.isFile()) {
      out.push({
        record: ['file', key, stat.mode & 0o777, createHash('sha256').update(readFileSync(path)).digest('hex')],
        key,
        bytes: stat.size,
      })
    }
  }
  return out
}

function compareEntries(entries, reference) {
  const expected = new Map(reference.map((entry) => [entry.key.toLowerCase(), entry.record]))
  const seen = new Set()
  const added = []
  const changed = []
  for (const entry of entries) {
    const key = entry.key.toLowerCase()
    seen.add(key)
    const other = expected.get(key)
    if (!other) added.push(entry.key)
    else if (JSON.stringify(other) !== JSON.stringify(entry.record)) changed.push(entry.key)
  }
  const missing = reference.filter((entry) => !seen.has(entry.key.toLowerCase())).map((entry) => entry.key)
  const sample = (list) => ({ count: list.length, first: list.slice(0, 20) })
  return {
    matches: added.length === 0 && changed.length === 0 && missing.length === 0,
    added: sample(added),
    changed: sample(changed),
    missing: sample(missing),
  }
}

export function measureTree(root, exclude = [], compare) {
  const absolute = resolve(root)
  const excluded = new Set(exclude.map((name) => name.toLowerCase()))
  const entries = walk(absolute, excluded)
  const digest = `sha256:${createHash('sha256').update(JSON.stringify(entries.map((entry) => entry.record))).digest('hex')}`
  if (excluded.size === 0 && digest !== treeIdentity(absolute)) {
    throw new Error('tree measurement disagrees with scripts/tree-identity.mjs')
  }
  const deepest = entries.reduce((best, entry) => (entry.key.length > best.length ? entry.key : best), '')
  return {
    digest,
    files: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    deepestRelative: deepest.split('/').join('\\'),
    deepestRelativeLength: deepest.length,
    peFiles: entries.filter((entry) => PE.test(entry.key)).map((entry) => entry.key),
    ...(compare ? { compare: compareEntries(entries, walk(resolve(compare), new Set())) } : {}),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      root: { type: 'string' },
      exclude: { type: 'string', multiple: true, default: [] },
      compare: { type: 'string' },
    },
  })
  if (!values.root) {
    process.stderr.write('usage: tree.mjs --root <dir> [--exclude <top-level name>]... [--compare <verified dir>]\n')
    process.exit(2)
  }
  process.stdout.write(`${JSON.stringify(measureTree(values.root, values.exclude, values.compare))}\n`)
}
