#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { packager } from '@electron/packager'
import { installAppDependencies } from './app-dependencies.mjs'
import { copyAgentInboxLicense } from './license.mjs'
import { runElectronSqliteCheck } from './electron-sqlite-check.mjs'
import { assertEnglishOnlyElectronLocales, pruneElectronLocales } from './prune-electron-locales.mjs'
import { assertPrunedNodeModules, pruneNodeModules } from './prune-node-modules.mjs'
import { copyTreePreservingMode, verifyPayload } from './runtime-payload.mjs'
import { assertRuntimeSourceCommit } from './runtime-provenance.mjs'
import { loadElectronChecksums, loadReleaseInputs, RUNTIME_KEYS, validateInstalledReleaseTools } from './release-inputs.mjs'
import { resolveSourceProvenance } from './source-provenance.mjs'
import { treeIdentity } from './tree-identity.mjs'
import { assertSafeTreeModes } from './tree-modes.mjs'

export const APP_NAME = 'Agent Inbox'

export class ThinAppBuildError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ThinAppBuildError'
  }
}

export function npmCliForCurrentNode() {
  const candidate = resolve(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!existsSync(candidate)) throw new ThinAppBuildError(`could not find npm for ${process.execPath}`)
  return candidate
}

export function copyRequiredTree(repoRoot, stageRoot) {
  for (const name of ['dist', 'public', 'electron', 'release']) {
    const source = join(repoRoot, name)
    if (!existsSync(source)) throw new ThinAppBuildError(`missing required package input: ${source}`)
    cpSync(source, join(stageRoot, name), { recursive: true, verbatimSymlinks: true })
  }
  mkdirSync(join(stageRoot, 'docs'), { recursive: true })
  cpSync(join(repoRoot, 'docs', 'reporting-snippet.md'), join(stageRoot, 'docs', 'reporting-snippet.md'))
  cpSync(join(repoRoot, 'package.json'), join(stageRoot, 'package.json'))
  cpSync(join(repoRoot, 'package-lock.json'), join(stageRoot, 'package-lock.json'))
  copyAgentInboxLicense(repoRoot, join(stageRoot, 'LICENSE.agent-inbox'))
}

export function publishAtomically(source, destination, force) {
  mkdirSync(dirname(destination), { recursive: true })
  if (!existsSync(destination)) {
    renameSync(source, destination)
    return
  }
  if (!force) throw new ThinAppBuildError(`output already exists: ${destination} (pass --force to replace it)`)
  const backup = `${destination}.old-${process.pid}`
  renameSync(destination, backup)
  try {
    renameSync(source, destination)
  } catch (err) {
    renameSync(backup, destination)
    throw err
  }
  rmSync(backup, { recursive: true, force: true })
}

function lipoArchs(path) {
  return execFileSync('/usr/bin/lipo', ['-archs', path], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  }).trim().split(/\s+/)
}

export function findNativeAddon(root) {
  const path = join(root, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
  if (!existsSync(path)) throw new ThinAppBuildError(`packaged app is missing better_sqlite3.node at ${path}`)
  return path
}

export function copyElectronNotices(packagerOutput, app) {
  const resources = join(app, 'Contents', 'Resources')
  mkdirSync(resources, { recursive: true })
  for (const [sourceName, destinationName] of [
    ['LICENSE', 'LICENSE.electron'],
    ['LICENSES.chromium.html', 'LICENSES.chromium.html'],
  ]) {
    const source = join(packagerOutput, sourceName)
    if (!existsSync(source) || !statSync(source).isFile() || statSync(source).size === 0) {
      throw new ThinAppBuildError(`Electron packager output is missing nonempty ${sourceName}`)
    }
    cpSync(source, join(resources, destinationName))
  }
}

export function runRuntimeSelftest(runtimeRoot) {
  const scratch = mkdtempSync(join(tmpdir(), 'thin-runtime-selftest-'))
  try {
    execFileSync(join(runtimeRoot, 'bin', 'node'), [join(runtimeRoot, 'dist', 'hook-cli.js'), 'selftest'], {
      cwd: runtimeRoot,
      env: { ...process.env, AGENT_INBOX_DB: join(scratch, 'inbox.db') },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

}

export function pruneAppNodeModules(stageRoot) {
  const addon = join(stageRoot, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
  if (!existsSync(addon)) throw new ThinAppBuildError(`Electron rebuild did not produce ${addon}`)
  // Keeps only what better-sqlite3 loads, so the rebuild's architecture-only
  // caches are gone before packaging, and drops typings, source maps and
  // non-license markdown from every package (#291).
  return pruneNodeModules(stageRoot)
}

// The macOS app is built for Apple silicon only (#296): one native arm64 app carrying the
// darwin-arm64 runtime. The release gates measure what it ships against macosArchitectures.
export async function buildThinApp({
  runtimeArm64,
  output,
  repoRoot,
  inputsPath,
  force = false,
}) {
  const arch = 'arm64'
  if (process.platform !== 'darwin' || process.arch !== arch) {
    throw new ThinAppBuildError(`thin ${arch} app must be built natively on darwin/${arch}; this process is ${process.platform}/${process.arch}`)
  }
  const inputs = loadReleaseInputs(inputsPath)
  validateInstalledReleaseTools(inputs, repoRoot)
  const electronChecksums = loadElectronChecksums({
    version: inputs.electron.version,
    platform: 'darwin',
    arch,
    repoRoot,
  })
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const provenance = resolveSourceProvenance(repoRoot)
  if (pkg.version !== JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8')).version) {
    throw new ThinAppBuildError('package.json and package-lock.json versions differ')
  }
  const distribution = inputs.node.distributions['darwin-arm64']
  const manifest = verifyPayload({
    root: runtimeArm64,
    expect: {
      product: 'agent-inbox-runtime',
      packageVersion: pkg.version,
      platform: distribution.platform,
      arch: distribution.arch,
      nodeVersion: inputs.node.version,
      nodeModulesAbi: inputs.node.modulesAbi,
      sourceCommit: provenance.sourceCommit,
    },
  })
  assertRuntimeSourceCommit(manifest, provenance.sourceCommit, 'darwin-arm64')

  execFileSync(process.execPath, [npmCliForCurrentNode(), 'run', 'generate:icons', '--', '--check'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  })
  execFileSync(process.execPath, [npmCliForCurrentNode(), 'run', 'build'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  })

  const outputParent = dirname(resolve(output))
  mkdirSync(outputParent, { recursive: true })
  const work = mkdtempSync(join(outputParent, '.thin-app-'))
  try {
    const stageRoot = join(work, 'stage')
    mkdirSync(stageRoot, { recursive: true })
    copyRequiredTree(repoRoot, stageRoot)
    mkdirSync(join(stageRoot, 'runtime'), { recursive: true })
    copyTreePreservingMode(runtimeArm64, join(stageRoot, 'runtime', 'darwin-arm64'))

    await installAppDependencies({
      stageRoot,
      npmCli: npmCliForCurrentNode(),
      electronVersion: inputs.electron.version,
      arch,
    })
    pruneAppNodeModules(stageRoot)
    execFileSync(process.execPath, [
      join(repoRoot, 'scripts', 'write-setup-info.mjs'),
      '--release', join(stageRoot, 'setup-info.json'),
      '--version', pkg.version,
      '--source-root', repoRoot,
      '--payload-root', stageRoot,
      '--runtime-key', 'darwin-arm64',
      '--payload', 'darwin-arm64=runtime/darwin-arm64',
    ], {
      cwd: repoRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    })

    const packagerOut = join(work, 'packager')
    const paths = await packager({
      dir: stageRoot,
      name: APP_NAME,
      productName: APP_NAME,
      platform: 'darwin',
      arch,
      // the release's Electron, and only the zip reviewed with it (#363)
      electronVersion: inputs.electron.version,
      download: { checksums: electronChecksums },
      out: packagerOut,
      overwrite: true,
      asar: false,
      junk: false,
      prune: false,
      icon: join(repoRoot, 'electron', 'icon.icns'),
      appBundleId: inputs.bundleId,
      appVersion: pkg.version,
      osxSign: false,
      extendInfo: {
        NSUserNotificationAlertStyle: 'alert',
        CFBundleIconFile: 'icon.icns',
      },
    })
    if (paths.length !== 1) throw new ThinAppBuildError(`packager returned ${paths.length} output paths`)
    const app = join(paths[0], `${APP_NAME}.app`)
    copyElectronNotices(paths[0], app)
    // Before anything signs the framework's resources (#292).
    pruneElectronLocales(app, 'darwin')
    const resources = join(app, 'Contents', 'Resources', 'app')
    assertEnglishOnlyElectronLocales(app, 'darwin', `packaged darwin-${arch} app`)
    assertPrunedNodeModules(resources, `packaged darwin-${arch} app`)
    for (const key of RUNTIME_KEYS) {
      assertPrunedNodeModules(join(resources, 'runtime', key), `packaged ${key} runtime`)
    }
    assertSafeTreeModes(app, { label: `packaged darwin-${arch} app` })
    const nativeAddon = findNativeAddon(resources)
    const expectedLipoArch = 'arm64'
    const nativeAddonArchitectures = lipoArchs(nativeAddon)
    if (!nativeAddonArchitectures.includes(expectedLipoArch)) {
      throw new ThinAppBuildError(
        `better_sqlite3.node is not ${expectedLipoArch}; found ${nativeAddonArchitectures.join(', ')}`,
      )
    }
    runElectronSqliteCheck({
      executable: join(app, 'Contents', 'MacOS', APP_NAME),
      storePath: join(resources, 'dist', 'store.js'),
      expected: {
        platform: 'darwin',
        arch,
        electron: inputs.electron.version,
      },
      label: `packaged Electron (darwin-${arch})`,
    })
    for (const key of RUNTIME_KEYS) {
      const distribution = inputs.node.distributions[key]
      const copiedManifest = verifyPayload({
        root: join(resources, 'runtime', key),
        expect: {
          packageVersion: pkg.version,
          nodeVersion: inputs.node.version,
          nodeModulesAbi: inputs.node.modulesAbi,
          platform: distribution.platform,
          arch: distribution.arch,
          sourceCommit: provenance.sourceCommit,
        },
      })
      assertRuntimeSourceCommit(copiedManifest, provenance.sourceCommit, `packaged ${key}`)
    }
    const selectedRuntime = join(resources, 'runtime', `darwin-${arch}`)
    runRuntimeSelftest(selectedRuntime)

    const destination = resolve(output)
    publishAtomically(app, destination, force)
    const setupInfo = JSON.parse(readFileSync(join(destination, 'Contents', 'Resources', 'app', 'setup-info.json'), 'utf8'))
    const report = {
      schema: 1,
      product: APP_NAME,
      packageVersion: pkg.version,
      ...provenance,
      arch,
      electronVersion: inputs.electron.version,
      nodeVersion: inputs.node.version,
      nodeModulesAbi: inputs.node.modulesAbi,
      runtimeKeys: RUNTIME_KEYS,
      runtimeSourceCommit: provenance.sourceCommit,
      runtimeManifestDigests: Object.fromEntries(
        RUNTIME_KEYS.map((key) => [key, setupInfo.runtimePayloads[key].digest]),
      ),
      appTreeDigest: treeIdentity(destination),
      nativeRuntimeSelftest: 'passed',
      electronSqliteCheck: 'passed',
      nativeAddonArchitectures,
    }
    writeFileSync(`${destination}.thin-report.json`, `${JSON.stringify(report, null, 2)}\n`)
    return { app: destination, report }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'runtime-arm64': { type: 'string' },
      output: { type: 'string' },
      'repo-root': { type: 'string', default: resolve(import.meta.dirname, '..') },
      inputs: { type: 'string' },
      force: { type: 'boolean' },
    },
  })
  for (const field of ['runtime-arm64', 'output']) {
    if (!values[field]) throw new ThinAppBuildError(`--${field} is required`)
  }
  const result = await buildThinApp({
    runtimeArm64: resolve(values['runtime-arm64']),
    output: resolve(values.output),
    repoRoot: resolve(values['repo-root']),
    inputsPath: values.inputs && resolve(values.inputs),
    force: Boolean(values.force),
  })
  process.stdout.write(`${JSON.stringify({ ok: true, app: result.app, arch: result.report.arch })}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`build-thin-app: ${err.message}\n`)
    process.exitCode = 1
  })
}
