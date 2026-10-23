// Remove what nothing in a shipped node_modules tree loads at runtime (#291).
//
// Every copy a release ships, the app's and each Setup runtime's, carried
// better-sqlite3's compile leftovers and C sources (about 25 MB in a runtime,
// 10 MB in the app), plus TypeScript declarations, source maps and markdown.
// The thin-app builders, runtime staging and the development package prune
// each copy before anything is tested, manifested or signed, and the
// verifiers refuse a shipped tree that still carries any of it.
//
// - better-sqlite3 keeps what it loads: package.json (`bindings` finds the
//   package root by it), lib/ (its entry point and every module that requires)
//   and build/Release/better_sqlite3.node, which `bindings` then loads. If its
//   entry points leave lib/ or the addon is missing, nothing is pruned.
// - Every package loses *.d.ts, *.d.mts, *.d.cts, source maps (*.js.map,
//   *.d.ts.map, ...) and markdown.
// - A license, notice, copying, copyright, authors, contributors or patents
//   file is never removed, wherever it sits, nor is anything in a folder named
//   like one, and a package without a license file of its own keeps the
//   markdown at its root, where its license may be.
//
// Node core only. Links are never followed or removed, and nothing outside
// node_modules is touched.
import { existsSync, lstatSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs'
import { dirname, join, posix, relative, sep } from 'node:path'

export class PruneNodeModulesError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PruneNodeModulesError'
  }
}

const LICENSE_NAME = /licen[cs]e|notice|copying|copyright|^(?:authors|contributors|patents)(?:$|[-_. ])/i
const TYPINGS = /\.d\.[cm]?ts$/i
const SOURCE_MAP = /\.(?:[cm]?[jt]sx?|css)\.map$/i
const MARKDOWN = /\.(?:md|markdown)$/i

const BETTER_SQLITE3 = 'better-sqlite3'
const ADDON = 'build/Release/better_sqlite3.node'

export function isLicenseFile(name) {
  return LICENSE_NAME.test(name)
}

const posixPath = (root, path) => relative(root, path).split(sep).join('/')

function isPlainFile(path) {
  try {
    return lstatSync(path).isFile()
  } catch {
    return false
  }
}

function exportTargets(value, condition) {
  if (typeof value === 'string') return condition === 'types' ? [] : [value]
  if (Array.isArray(value)) return value.flatMap((entry) => exportTargets(entry))
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) => exportTargets(entry, key))
  }
  return []
}

function betterSqlite3Problem(dir) {
  let pkg
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return 'has no readable package.json'
  }
  const main = posix.normalize(typeof pkg.main === 'string' ? pkg.main : 'index.js')
  for (const target of [main, ...exportTargets(pkg.exports)].map((path) => posix.normalize(path))) {
    if (target !== 'package.json' && !target.startsWith('lib/')) return `loads ${target}, outside lib/`
  }
  const entry = [main, `${main}.js`, `${main}/index.js`].find((path) => isPlainFile(join(dir, ...path.split('/'))))
  if (!entry) return `entry point ${main} is missing`
  if (!isPlainFile(join(dir, ...ADDON.split('/')))) return `has no compiled ${ADDON}`
  return null
}

function assertBetterSqlite3Loads(root, dir) {
  const problem = betterSqlite3Problem(dir)
  if (problem) {
    throw new PruneNodeModulesError(
      `${posixPath(root, dir)} ${problem}; review what #291 prunes from it before shipping it`,
    )
  }
}

function prunable(name, relPath, pkg) {
  // LICENSES/MIT.md and the like count too
  if (relPath.split('/').some(isLicenseFile)) return false
  if (pkg.betterSqlite3 && relPath !== 'package.json' && relPath !== ADDON && !relPath.startsWith('lib/')) return true
  if (TYPINGS.test(name) || SOURCE_MAP.test(name)) return true
  return MARKDOWN.test(name) && (pkg.hasLicense || relPath.includes('/'))
}

// Every file the rules remove, without removing anything. better-sqlite3 is
// checked first, so a refused tree is left exactly as it was.
function planPrune(root) {
  const remove = []
  const betterSqlite3 = []
  const visitDir = (dir, rel, pkg) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') visitModules(path)
        else visitDir(path, relPath, pkg)
      } else if (entry.isFile() && prunable(entry.name, relPath, pkg)) {
        remove.push({ path, packageDir: pkg.dir, size: lstatSync(path).size })
      }
    }
  }
  const visitPackage = (dir, name) => {
    const isBetterSqlite3 = name === BETTER_SQLITE3
    if (isBetterSqlite3) {
      assertBetterSqlite3Loads(root, dir)
      betterSqlite3.push(dir)
    }
    const hasLicense = readdirSync(dir, { withFileTypes: true })
      .some((entry) => entry.isFile() && isLicenseFile(entry.name))
    visitDir(dir, '', { dir, betterSqlite3: isBetterSqlite3, hasLicense })
  }
  // .bin, .package-lock.json and anything else that is not a package stay
  const visitModules = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || !entry.isDirectory()) continue
      const path = join(dir, entry.name)
      if (!entry.name.startsWith('@')) {
        visitPackage(path, entry.name)
        continue
      }
      for (const scoped of readdirSync(path, { withFileTypes: true })) {
        if (!scoped.name.startsWith('.') && scoped.isDirectory()) {
          visitPackage(join(path, scoped.name), `${entry.name}/${scoped.name}`)
        }
      }
    }
  }
  const modules = join(root, 'node_modules')
  if (existsSync(modules) && lstatSync(modules).isDirectory()) visitModules(modules)
  remove.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { remove, betterSqlite3 }
}

// Only directories this prune emptied go; one that was already empty stays.
function removeEmptiedDirectories(removed) {
  const dirs = new Set()
  for (const { path, packageDir } of removed) {
    for (let dir = dirname(path); dir !== packageDir && dir.startsWith(packageDir); dir = dirname(dir)) dirs.add(dir)
  }
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    if (readdirSync(dir).length === 0) rmdirSync(dir)
  }
}

/**
 * Prune `root/node_modules` in place. Returns how many files went and their
 * size in bytes.
 */
export function pruneNodeModules(root) {
  const { remove, betterSqlite3 } = planPrune(root)
  let removedBytes = 0
  for (const file of remove) {
    unlinkSync(file.path)
    removedBytes += file.size
  }
  removeEmptiedDirectories(remove)
  for (const dir of betterSqlite3) assertBetterSqlite3Loads(root, dir)
  return { removedFiles: remove.length, removedBytes }
}

/**
 * Refuse a shipped tree whose node_modules still carries anything
 * pruneNodeModules() removes, or whose better-sqlite3 no longer loads.
 */
export function assertPrunedNodeModules(root, label) {
  const { remove } = planPrune(root)
  if (remove.length === 0) return
  const shown = remove.slice(0, 20).map((file) => posixPath(root, file.path))
  throw new PruneNodeModulesError(
    `${label} ships ${remove.length} node_modules files nothing loads (#291): ${shown.join(', ')}`
      + (remove.length > shown.length ? `, and ${remove.length - shown.length} more` : ''),
  )
}
