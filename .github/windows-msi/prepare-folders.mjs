#!/usr/bin/env node
// #87 PR 2b, CI only: restore the two Windows folders the MSIs are built from,
// and prove each is byte-identical to the tree its build verified.
//
// --base is the native-win32-x64-folder-inputs artifact of the reused
// windows-native-folder workflow (archive round trip, PE/ABI gates, launch): the
// MSI under test. --upgrade is the same commit rebuilt by windows-msi.yml with only
// the version bumped, for the upgrade step; build-windows-thin-app.mjs runs the
// same verifier on it. The rebuild, for the same-version step, is the base folder
// restored again with one file removed and one added, so the installed tree shows
// whose files are in place: a leftover of the first build is the removed file.
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { extractTreeArchive } from '../../scripts/archive-tree.mjs'
import { measureTree } from './tree.mjs'

const APP = 'Agent Inbox'
// Chromium's notices file, which nothing at install or uninstall reads.
const REBUILD = { removed: 'LICENSES.chromium.html', added: 'same-version-rebuild.txt' }

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function restore({ label, artifact, destination, expectedVersion, restoredReport }) {
  const report = readJson(join(artifact, 'thin', 'win32-x64', `${APP}.thin-report.json`))
  const root = extractTreeArchive({
    archive: join(artifact, 'win32-x64-folder.tar.gz'),
    destination: join(destination, label),
    expectedRoot: APP,
  })
  const tree = measureTree(root)
  const failures = []
  if (tree.digest !== report.appTreeDigest) failures.push('restored tree differs from the verified appTreeDigest')
  if (restoredReport && readJson(restoredReport).appTreeDigest !== report.appTreeDigest) {
    failures.push('the folder workflow restored a different tree')
  }
  const appPackage = readJson(join(root, 'resources', 'app', 'package.json'))
  if (report.packageVersion !== expectedVersion || appPackage.version !== expectedVersion) {
    failures.push(`expected version ${expectedVersion}, report ${report.packageVersion}, app ${appPackage.version}`)
  }
  if (report.key !== 'win32-x64' || report.arch !== 'x64') failures.push('not a win32-x64 folder')
  if (report.nativeAddonSelftests !== 'passed' || report.electronSqliteCheck !== 'passed') {
    failures.push('native gates did not pass')
  }
  if (report.setupAvailable !== false) failures.push('Setup must stay unavailable on Windows')
  if (report.sourceDirty !== false || !/^[0-9a-f]{40}$/.test(report.sourceCommit ?? '')) {
    failures.push('folder was not built from a clean, named commit')
  }
  if (failures.length) throw new Error(`${label} folder: ${failures.join('; ')}`)
  return {
    root,
    version: report.packageVersion,
    sourceCommit: report.sourceCommit,
    appTreeDigest: report.appTreeDigest,
    runtimeManifestDigest: report.runtimeManifestDigest,
    electronVersion: report.electronVersion,
    nodeVersion: report.nodeVersion,
    files: tree.files,
    bytes: tree.bytes,
    deepestRelative: tree.deepestRelative,
    deepestRelativeLength: tree.deepestRelativeLength,
    peFiles: report.compatibility.map((entry) => entry.path),
  }
}

function rebuildOf(base, { artifact, destination }) {
  const root = extractTreeArchive({
    archive: join(artifact, 'win32-x64-folder.tar.gz'),
    destination: join(destination, 'rebuild'),
    expectedRoot: APP,
  })
  rmSync(join(root, REBUILD.removed))
  writeFileSync(join(root, REBUILD.added), `A rebuild of ${base.version} (${base.sourceCommit}) for the same-version upgrade check.\n`)
  const tree = measureTree(root)
  if (tree.digest === base.appTreeDigest) throw new Error('the rebuild folder must differ from the base folder')
  return {
    root,
    version: base.version,
    sourceCommit: base.sourceCommit,
    appTreeDigest: tree.digest,
    from: 'base',
    removed: REBUILD.removed,
    added: REBUILD.added,
    files: tree.files,
    bytes: tree.bytes,
  }
}

const { values } = parseArgs({
  options: {
    base: { type: 'string' },
    upgrade: { type: 'string' },
    destination: { type: 'string' },
    'base-version': { type: 'string' },
    'upgrade-version': { type: 'string' },
    out: { type: 'string' },
  },
})
for (const name of ['base', 'upgrade', 'destination', 'base-version', 'upgrade-version', 'out']) {
  if (!values[name]) throw new Error(`--${name} is required`)
}
const base = restore({
  label: 'base',
  artifact: resolve(values.base),
  destination: resolve(values.destination),
  expectedVersion: values['base-version'],
  restoredReport: join(resolve(values.base), 'reports', 'win32-x64-restored-folder.json'),
})
const upgrade = restore({
  label: 'upgrade',
  artifact: resolve(values.upgrade),
  destination: resolve(values.destination),
  expectedVersion: values['upgrade-version'],
})
if (base.appTreeDigest === upgrade.appTreeDigest) throw new Error('the upgrade folder must differ from the base folder')
const rebuild = rebuildOf(base, { artifact: resolve(values.base), destination: resolve(values.destination) })
writeFileSync(resolve(values.out), `${JSON.stringify({ schema: 1, base, upgrade, rebuild }, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({ ok: true, base: base.version, upgrade: upgrade.version, rebuild: rebuild.version })}\n`)
