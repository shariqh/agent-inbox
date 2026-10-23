#!/usr/bin/env node
// Development `npm run package:app` staging (#139).
//
// The development app is staged from the same inputs as the release thin app:
// build-thin-app.mjs's copyRequiredTree() copies dist/, public/, electron/,
// release/, the reporting snippet, the license notice and the checked-in
// package.json + package-lock.json pair. `npm ci --omit=dev` then installs the
// lockfile's production graph instead of resolving package.json ranges afresh,
// and verifyStagedLockGraph() proves the installed graph is that lockfile's.
// `prune` removes what nothing loads at runtime, as the release builders do
// (#291); it removes files inside packages, never a package, so the graph
// check that follows stays exact. `locales` keeps only the English Electron
// locale in the packaged bundle, as the release builders do (#292).
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { copyRequiredTree } from './build-thin-app.mjs'
import { pruneElectronLocales } from './prune-electron-locales.mjs'
import { pruneNodeModules } from './prune-node-modules.mjs'

// The development app's Electron identity: app.name, and therefore its
// userData directory and menu label, comes from this field.
export const DEVELOPMENT_PRODUCT_NAME = 'Agent Inbox'
export const ELECTRON_MAIN = 'electron/main.cjs'
const INSTALLED_LOCK = 'node_modules/.package-lock.json'

export class PackageAppStageError extends Error {
  constructor(message, problems = []) {
    super(problems.length ? `${message}\n${problems.map((problem) => `  ${problem}`).join('\n')}` : message)
    this.name = 'PackageAppStageError'
    this.problems = problems
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new PackageAppStageError(`cannot read ${path}: ${err.message}`)
  }
}

function lockPackages(lock, path) {
  if (!lock || typeof lock !== 'object' || !(lock.lockfileVersion >= 2)
    || !lock.packages || typeof lock.packages !== 'object') {
    throw new PackageAppStageError(`${path} is not a lockfileVersion 2+ npm lockfile with a "packages" map`)
  }
  return lock.packages
}

/**
 * Stage the development app into an empty directory. The staged package.json is
 * the checked-in manifest, so it stays coherent with the copied lockfile and
 * keeps its explicit ESM mode and Electron entry point; only the development
 * product name is added.
 */
export function stageDevelopmentApp(repoRoot, stageRoot) {
  mkdirSync(stageRoot, { recursive: true })
  if (readdirSync(stageRoot).length !== 0) {
    throw new PackageAppStageError(`stage directory must be empty: ${stageRoot}`)
  }
  copyRequiredTree(repoRoot, stageRoot)

  const manifestPath = join(stageRoot, 'package.json')
  const lockPath = join(stageRoot, 'package-lock.json')
  const pkg = readJson(manifestPath)
  const lock = readJson(lockPath)
  lockPackages(lock, lockPath)
  if (pkg.type !== 'module') {
    throw new PackageAppStageError(`package.json must declare "type": "module" for the staged ESM dist/; found ${JSON.stringify(pkg.type)}`)
  }
  if (pkg.main !== ELECTRON_MAIN) {
    throw new PackageAppStageError(`package.json "main" must be the Electron entry point ${ELECTRON_MAIN}; found ${JSON.stringify(pkg.main)}`)
  }
  if (!existsSync(join(stageRoot, ELECTRON_MAIN))) {
    throw new PackageAppStageError(`staged app is missing its Electron entry point ${ELECTRON_MAIN}`)
  }
  if (lock.name !== pkg.name || lock.version !== pkg.version) {
    throw new PackageAppStageError(
      `package.json (${pkg.name}@${pkg.version}) and package-lock.json (${lock.name}@${lock.version}) describe different packages`,
    )
  }
  const { name, productName: _checkedInProductName, ...rest } = pkg
  writeFileSync(manifestPath, `${JSON.stringify({ name, productName: DEVELOPMENT_PRODUCT_NAME, ...rest }, null, 2)}\n`)
}

// Every package directory under appRoot/node_modules, keyed like lockfile
// entries ("node_modules/a/node_modules/@s/b"), mapped to its on-disk version
// or, for an entry that cannot be read as a package, to { problem }.
function installedPackages(appRoot) {
  const found = new Map()
  const visitPackage = (dir, key, entry) => {
    if (entry.isSymbolicLink()) {
      found.set(key, { problem: 'is a symlink; staged packages must be real directories' })
      return
    }
    if (!entry.isDirectory()) return
    let version
    try {
      version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version
    } catch {
      version = undefined
    }
    found.set(key, typeof version === 'string' ? version : { problem: 'has no readable package.json version' })
    visitModules(join(dir, 'node_modules'), `${key}/node_modules`)
  }
  const visitModules = (dir, prefix) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      if (entry.name.startsWith('@') && entry.isDirectory()) {
        for (const scoped of readdirSync(join(dir, entry.name), { withFileTypes: true })) {
          if (scoped.name.startsWith('.')) continue
          visitPackage(join(dir, entry.name, scoped.name), `${prefix}/${entry.name}/${scoped.name}`, scoped)
        }
      } else {
        visitPackage(join(dir, entry.name), `${prefix}/${entry.name}`, entry)
      }
    }
  }
  visitModules(join(appRoot, 'node_modules'), 'node_modules')
  return found
}

const isOptional = (entry) => entry.optional === true || entry.devOptional === true

/**
 * Prove that an installed app tree holds exactly the source lockfile's
 * production graph, as `npm ci --omit=dev` installs it: every package on disk
 * has the lockfile's version, npm's record of it (node_modules/.package-lock.json)
 * carries the lockfile's integrity, no dev-only or unlocked package is present,
 * and every non-optional production package is installed. Optional packages may
 * be absent (npm skips those built for other platforms).
 */
export function verifyStagedLockGraph({ lockPath, appRoot }) {
  const source = lockPackages(readJson(lockPath), lockPath)
  let omittedDev = 0
  for (const [key, entry] of Object.entries(source)) {
    if (key === '') continue
    if (!key.startsWith('node_modules/') || entry.link) {
      throw new PackageAppStageError(`${lockPath}: ${key} is a linked or workspace package, which this check does not support`)
    }
    if (entry.dev) {
      omittedDev++
    } else if (!entry.integrity && !entry.inBundle) {
      throw new PackageAppStageError(`${lockPath}: ${key} has no integrity, so its installed copy cannot be verified`)
    }
  }
  const installedLockPath = join(appRoot, ...INSTALLED_LOCK.split('/'))
  if (!existsSync(installedLockPath)) {
    throw new PackageAppStageError(`${installedLockPath} is missing; npm did not record this install`)
  }
  const recorded = lockPackages(readJson(installedLockPath), installedLockPath)
  const disk = installedPackages(appRoot)

  const problems = []
  const optionalAbsent = []
  let packages = 0
  const keys = new Set([...disk.keys(), ...Object.keys(recorded), ...Object.keys(source)])
  keys.delete('')
  for (const key of [...keys].sort()) {
    const want = source[key]
    const version = disk.get(key)
    const record = recorded[key]
    const issues = []
    if (typeof version === 'object') {
      issues.push(version.problem)
    } else if (version === undefined) {
      if (record) {
        issues.push(`recorded in ${INSTALLED_LOCK} but not installed`)
      } else if (want && !want.dev) {
        if (isOptional(want)) optionalAbsent.push(key)
        else issues.push(`missing; the lockfile has ${want.version}`)
      }
    } else if (!want) {
      issues.push(`${version} is installed but the lockfile has no such package`)
    } else if (want.dev) {
      issues.push(`dev-only package ${version} is installed`)
    } else {
      packages++
      if (version !== want.version) issues.push(`installed ${version}; the lockfile has ${want.version}`)
      if (!record) {
        issues.push(`not recorded in ${INSTALLED_LOCK}, so its integrity is unknown`)
      } else {
        if (record.version !== version) issues.push(`${INSTALLED_LOCK} records ${record.version}`)
        if (record.integrity !== want.integrity) issues.push('integrity differs from the lockfile')
      }
    }
    if (issues.length) problems.push(`${key}: ${issues.join('; ')}`)
  }
  if (problems.length) {
    throw new PackageAppStageError(
      `${appRoot} does not hold the production graph of ${lockPath} (${problems.length} ${problems.length === 1 ? 'difference' : 'differences'}):`,
      problems,
    )
  }
  return { packages, omittedDev, optionalAbsent }
}

// Without node_modules npm ci installed nothing, and a prune that removed
// nothing would look like success.
function pruneStagedApp(appRoot) {
  const modules = join(appRoot, 'node_modules')
  if (!existsSync(modules)) throw new PackageAppStageError(`${modules} is missing; nothing was installed to prune`)
  const { removedFiles, removedBytes } = pruneNodeModules(appRoot)
  return `package-app: pruned ${removedFiles} files (${(removedBytes / 1e6).toFixed(1)} MB) nothing loads from ${modules}`
}

// The development package is a macOS bundle. The prune refuses one without
// the English locale and removes every other.
function pruneAppLocales(app) {
  const { removedLocales, removedBytes } = pruneElectronLocales(app, 'darwin')
  return `package-app: kept only the English Electron locale in ${app}; `
    + `removed ${removedLocales} locales (${(removedBytes / 1e6).toFixed(1)} MB)`
}

function describeGraph(label, graph) {
  const optional = graph.optionalAbsent.length
    ? `; ${graph.optionalAbsent.length} optional packages not installed on this platform`
    : ''
  return `package-app: ${label} dependency graph matches package-lock.json: ${graph.packages} production packages `
    + `(version + integrity); ${graph.omittedDev} dev-only lock entries omitted${optional}`
}

function main(argv) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { label: { type: 'string', default: 'staged' } },
  })
  const [command, first, second, ...extra] = positionals
  if (command === 'stage' && first && second && extra.length === 0) {
    stageDevelopmentApp(resolve(first), resolve(second))
  } else if (command === 'verify' && first && second && extra.length === 0) {
    const graph = verifyStagedLockGraph({ lockPath: resolve(first), appRoot: resolve(second) })
    process.stdout.write(`${describeGraph(values.label, graph)}\n`)
  } else if (command === 'prune' && first && !second) {
    process.stdout.write(`${pruneStagedApp(resolve(first))}\n`)
  } else if (command === 'locales' && first && !second) {
    process.stdout.write(`${pruneAppLocales(resolve(first))}\n`)
  } else {
    process.stderr.write(
      'usage: package-app-stage.mjs stage <repo-root> <stage-dir>\n'
        + '       package-app-stage.mjs prune <app-dir>\n'
        + '       package-app-stage.mjs locales <app-bundle>\n'
        + '       package-app-stage.mjs verify <package-lock.json> <app-dir> [--label <name>]\n',
    )
    process.exitCode = 2
  }
}

// Node resolves symlinks for import.meta.url but not for argv[1], so compare
// real paths: run through a symlinked checkout, a plain comparison would turn
// every command into a silent exit 0.
function invokedAsCommand() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedAsCommand()) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`package-app: ${err.message}\n`)
    process.exitCode = 1
  }
}
