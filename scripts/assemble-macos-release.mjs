#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { sign } from '@electron/osx-sign'
import { createReleaseDmg } from './macos-dmg.mjs'
import { assertEnglishOnlyElectronLocales } from './prune-electron-locales.mjs'
import {
  buildManifest,
  readManifestFile,
  verifyPayload,
  writeManifestFile,
} from './runtime-payload.mjs'
import {
  loadReleaseInputs,
  RUNTIME_KEYS,
  sha256File,
  validateInstalledReleaseTools,
} from './release-inputs.mjs'
import { resolveSourceProvenance } from './source-provenance.mjs'
import { assertRuntimeSourceCommit } from './runtime-provenance.mjs'
import { treeIdentity } from './tree-identity.mjs'
import { assertSafeTreeModes } from './tree-modes.mjs'
import { probeRuntimeMcp } from './runtime-mcp-probe.mjs'

const APP_NAME = 'Agent Inbox'
// lipo's name for each Node runtime architecture.
const LIPO_ARCH = Object.freeze({ arm64: 'arm64', x64: 'x86_64' })

export class MacReleaseError extends Error {
  constructor(message) {
    super(message)
    this.name = 'MacReleaseError'
  }
}

function walkFiles(root) {
  const files = []
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) stack.push(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  return files.sort()
}

// A Mach-O's first four bytes, read big-endian: a thin 32- or 64-bit header in either byte
// order, or a fat or fat64 header, which is always big-endian.
const THIN_MACHO_MAGICS = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe])
const FAT_MAGIC = 0xcafebabe
const FAT_MAGIC_64 = 0xcafebabf

// Read in-process, not with `file`, which reports a fat64 binary as data and can fail or time
// out, leaving the file unchecked. A file this cannot read fails the build (#383).
function isMachO(path) {
  const header = Buffer.alloc(8)
  let fd
  let length
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    length = readSync(fd, header, 0, header.length, 0)
  } catch (err) {
    throw new MacReleaseError(`could not read ${path} to look for a Mach-O header: ${err.message}`)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  if (length < 4) return false
  const magic = header.readUInt32BE(0)
  if (THIN_MACHO_MAGICS.has(magic) || magic === FAT_MAGIC_64) return true
  // A Java class file starts with the fat magic too, then its version (major 45 or later)
  // where a fat header holds its architecture count.
  return magic === FAT_MAGIC && (length < 8 || header.readUInt32BE(4) < 45)
}

function lipoArchs(path) {
  return execFileSync('/usr/bin/lipo', ['-archs', path], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  }).trim().split(/\s+/).sort()
}

function hashTree(root) {
  return Object.fromEntries(walkFiles(root).map((path) => [relative(root, path), sha256File(path)]))
}

function assertTreeHashes(root, expected) {
  const actual = hashTree(root)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new MacReleaseError(`runtime bytes changed after outer signing: ${root}`)
  }
}

export function validateSigningOptions({ mode, identity, keychain }) {
  if (mode !== 'adhoc' && mode !== 'developer-id') {
    throw new MacReleaseError('--mode must be adhoc or developer-id')
  }
  if (mode === 'developer-id') {
    if (typeof identity !== 'string' || !/^Developer ID Application: .+ \([A-Z0-9]{10}\)$/.test(identity)) {
      throw new MacReleaseError('developer-id mode requires an exact Developer ID Application identity')
    }
    if (typeof keychain !== 'string' || !keychain || !existsSync(keychain)) {
      throw new MacReleaseError('developer-id mode requires an existing --keychain path')
    }
  } else if (identity || keychain) {
    throw new MacReleaseError('adhoc mode does not accept Developer ID identity or keychain inputs')
  }
  return { mode, identity: mode === 'developer-id' ? identity : '-', keychain: mode === 'developer-id' ? keychain : undefined }
}

export function releaseDisposition(mode) {
  if (mode === 'adhoc') {
    return {
      notaryEligible: false,
      validationEvidenceOnly: true,
      layer3Required: [
        'rebuild the verified thin app and report from the release tag',
        'import Developer ID credentials into an ephemeral keychain',
        'run package:macos --mode developer-id from that verified thin input',
        'verify the Developer ID output and require notaryEligible=true',
        'ZIP and submit the Developer ID app to notary',
        'wait for app notarization acceptance',
        'staple and validate the app',
        'rebuild the final DMG from the stapled app',
        'notarize, staple, and validate the final DMG',
        'write final checksums and publish',
      ],
    }
  }
  if (mode === 'developer-id') {
    return {
      notaryEligible: true,
      validationEvidenceOnly: false,
      layer3Required: [
        'ZIP and submit the verified Developer ID app to notary',
        'wait for app notarization acceptance',
        'staple and validate the app',
        'rebuild the final DMG from the stapled app',
        'notarize, staple, and validate the final DMG',
        'write final checksums and publish',
      ],
    }
  }
  throw new MacReleaseError(`unsupported release disposition mode: ${mode}`)
}

function codesignRuntimeFile({ path, signing, entitlements }) {
  const args = ['--force', '--sign', signing.identity]
  if (signing.keychain) args.push('--keychain', signing.keychain)
  if (signing.mode === 'developer-id') args.push('--options', 'runtime', '--timestamp')
  else args.push('--timestamp=none')
  args.push('--entitlements', entitlements, path)
  execFileSync('/usr/bin/codesign', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  })
}

// The only Mach-O files a portable runtime carries once staging pruned
// better-sqlite3's compile leftovers (#291). Anything else, such as the
// test_extension.node every release used to sign, is refused before a single
// byte is signed.
export const RUNTIME_MACHO_FILES = Object.freeze([
  'bin/node',
  'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
])

export function signPortableRuntime({ runtimeRoot, signing, entitlementsRoot }) {
  const nodePath = join(runtimeRoot, 'bin', 'node')
  const machOs = walkFiles(runtimeRoot).filter((path) => basename(path) !== 'runtime-manifest.json' && isMachO(path))
  const found = machOs.map((path) => relative(runtimeRoot, path).split(sep).join('/')).sort()
  if (JSON.stringify(found) !== JSON.stringify([...RUNTIME_MACHO_FILES].sort())) {
    throw new MacReleaseError(
      `runtime Mach-O files must be exactly ${RUNTIME_MACHO_FILES.join(', ')}; found ${found.join(', ') || 'none'}`,
    )
  }
  machOs.sort((a, b) => b.split(sep).length - a.split(sep).length)
  for (const path of machOs) {
    codesignRuntimeFile({
      path,
      signing,
      entitlements: path === nodePath
        ? join(entitlementsRoot, 'runtime-node.plist')
        : join(entitlementsRoot, 'runtime-library.plist'),
    })
  }
  return machOs
}

export function regenerateRuntimeManifest(runtimeRoot) {
  const previous = readManifestFile(runtimeRoot)
  rmSync(join(runtimeRoot, 'runtime-manifest.json'))
  const manifest = buildManifest({
    root: runtimeRoot,
    product: previous.product,
    packageVersion: previous.packageVersion,
    sourceCommit: previous.sourceCommit,
    platform: previous.platform,
    arch: previous.arch,
    nodeVersion: previous.nodeVersion,
    nodeModulesAbi: previous.nodeModulesAbi,
    entrypoints: previous.entrypoints,
  })
  writeManifestFile(runtimeRoot, manifest)
  verifyPayload({
    root: runtimeRoot,
    expect: {
      product: previous.product,
      packageVersion: previous.packageVersion,
      platform: previous.platform,
      arch: previous.arch,
      nodeVersion: previous.nodeVersion,
      nodeModulesAbi: previous.nodeModulesAbi,
    },
  })
  return manifest
}

function writeSetupInfo({ repoRoot, appResources, packageVersion }) {
  execFileSync(process.execPath, [
    join(repoRoot, 'scripts', 'write-setup-info.mjs'),
    '--release', join(appResources, 'setup-info.json'),
    '--version', packageVersion,
    '--source-root', repoRoot,
    '--payload-root', appResources,
    '--runtime-key', 'darwin-arm64',
    '--payload', 'darwin-arm64=runtime/darwin-arm64',
  ], {
    cwd: repoRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  })
}

function markBuildProperties(app, mode, minimumMacosVersion) {
  const plist = join(app, 'Contents', 'Info.plist')
  for (const [key, type, value] of [
    ['AgentInboxBuildMode', 'string', mode],
    ['LSMinimumSystemVersion', 'string', minimumMacosVersion],
    ['NSUserNotificationAlertStyle', 'string', 'alert'],
  ]) {
    try {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist], { stdio: 'ignore' })
    } catch {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} ${type} ${value}`, plist], { stdio: 'ignore' })
    }
  }
}

async function signElectronEnvelope({ app, appResources, signing, entitlementsRoot, electronVersion }) {
  const runtimeRoot = join(appResources, 'runtime') + sep
  await sign({
    app,
    platform: 'darwin',
    type: 'distribution',
    identity: signing.identity,
    keychain: signing.keychain,
    identityValidation: signing.mode === 'developer-id',
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    strictVerify: true,
    version: electronVersion,
    ignore: (path) => path.startsWith(runtimeRoot),
    optionsForFile: () => ({
      entitlements: join(entitlementsRoot, 'electron.plist'),
      hardenedRuntime: signing.mode === 'developer-id',
      timestamp: signing.mode === 'developer-id' ? undefined : 'none',
    }),
  })
}

// Every Electron Mach-O must hold exactly the expected CPU types (macosArchitectures, which
// the final gates measure again), and every runtime Mach-O exactly its own runtime's.
export function verifyMachOArchitectures(app, appResources, inputs) {
  const runtimeRoot = join(appResources, 'runtime') + sep
  const expected = [...inputs.macosArchitectures].sort()
  const electron = []
  const runtime = []
  for (const path of walkFiles(app).filter(isMachO)) {
    const arches = lipoArchs(path)
    if (path.startsWith(runtimeRoot)) {
      const key = path.slice(runtimeRoot.length).split(sep)[0]
      const own = LIPO_ARCH[inputs.node.distributions[key]?.arch]
      if (!own || JSON.stringify(arches) !== JSON.stringify([own])) {
        throw new MacReleaseError(`runtime Mach-O has wrong architecture (${arches.join(',')}): ${path}`)
      }
      runtime.push({ path: relative(app, path), architectures: arches })
    } else {
      if (JSON.stringify(arches) !== JSON.stringify(expected)) {
        throw new MacReleaseError(`Electron Mach-O has CPU types ${arches.join(',')}, not the expected ${expected.join(',')}: ${path}`)
      }
      electron.push({ path: relative(app, path), architectures: arches })
    }
  }
  if (!electron.some((entry) => entry.path === join('Contents', 'MacOS', APP_NAME))) {
    throw new MacReleaseError('app executable was not inspected')
  }
  if (!electron.some((entry) => entry.path.endsWith('better_sqlite3.node'))) {
    throw new MacReleaseError('app better_sqlite3.node was not inspected')
  }
  return { app: electron, runtime }
}

function verifySetupInfo(appResources, packageVersion) {
  const info = JSON.parse(readFileSync(join(appResources, 'setup-info.json'), 'utf8'))
  if (info.version !== packageVersion || info.schema !== 2) throw new MacReleaseError('setup-info release identity mismatch')
  for (const key of RUNTIME_KEYS) {
    const manifest = join(appResources, info.runtimePayloads?.[key]?.path ?? '', 'runtime-manifest.json')
    const digest = info.runtimePayloads?.[key]?.digest
    if (digest !== `sha256:${sha256File(manifest)}`) {
      throw new MacReleaseError(`setup-info digest is stale for ${key}`)
    }
  }
  return info
}

function runNativeRuntimeSelftest(appResources) {
  const key = `${process.platform}-${process.arch}`
  if (!RUNTIME_KEYS.includes(key)) return { key, status: 'not-supported-on-runner' }
  const runtime = join(appResources, 'runtime', key)
  const scratch = mkdtempSync(join(dirname(appResources), '.runtime-selftest-'))
  try {
    execFileSync(join(runtime, 'bin', 'node'), [join(runtime, 'dist', 'hook-cli.js'), 'selftest'], {
      cwd: runtime,
      env: { ...process.env, AGENT_INBOX_DB: join(scratch, 'inbox.db') },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    })
    try {
      probeRuntimeMcp(join(runtime, 'bin', 'node'), runtime)
    } catch (err) {
      throw new MacReleaseError(`native runtime ${key}: ${err.message}`)
    }
    return { key, status: 'passed' }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

// The one thin app the macOS release is made from: the native arm64 build (#296).
export function verifyThinReport({
  arm64App,
  arm64Report,
  packageVersion,
  inputs,
  provenance,
  mode,
}) {
  if (mode === 'developer-id' && provenance.sourceDirty) {
    throw new MacReleaseError('developer-id mode requires clean source provenance')
  }
  const report = JSON.parse(readFileSync(arm64Report, 'utf8'))
  if (
    report.schema !== 1 ||
    report.product !== APP_NAME ||
    report.arch !== 'arm64' ||
    report.packageVersion !== packageVersion ||
    report.electronVersion !== inputs.electron.version ||
    report.nodeVersion !== inputs.node.version ||
    report.nodeModulesAbi !== inputs.node.modulesAbi ||
    report.sourceCommit !== provenance.sourceCommit ||
    report.sourceDirty !== provenance.sourceDirty ||
    report.runtimeSourceCommit !== provenance.sourceCommit ||
    report.nativeRuntimeSelftest !== 'passed' ||
    report.electronSqliteCheck !== 'passed' ||
    JSON.stringify(report.runtimeKeys) !== JSON.stringify(RUNTIME_KEYS) ||
    JSON.stringify(report.nativeAddonArchitectures?.slice().sort()) !== JSON.stringify(['arm64'])
  ) {
    throw new MacReleaseError('thin arm64 verification report is invalid')
  }
  const app = resolve(arm64App)
  if (report.appTreeDigest !== treeIdentity(app)) {
    throw new MacReleaseError('thin arm64 app does not match its verification report')
  }
  const setup = JSON.parse(readFileSync(join(app, 'Contents', 'Resources', 'app', 'setup-info.json'), 'utf8'))
  const expectedRuntimeDigests = Object.fromEntries(
    RUNTIME_KEYS.map((key) => [key, setup.runtimePayloads?.[key]?.digest]),
  )
  if (JSON.stringify(report.runtimeManifestDigests) !== JSON.stringify(expectedRuntimeDigests)) {
    throw new MacReleaseError('thin arm64 runtime manifest digests do not match its app')
  }
  return report
}

function publishDirectory(stage, output, force) {
  if (!existsSync(output)) {
    renameSync(stage, output)
    return
  }
  if (!force) throw new MacReleaseError(`output already exists: ${output} (pass --force to replace it)`)
  const backup = `${output}.old-${process.pid}`
  renameSync(output, backup)
  try {
    renameSync(stage, output)
  } catch (err) {
    renameSync(backup, output)
    throw err
  }
  rmSync(backup, { recursive: true, force: true })
}

function writeChecksums(stage, names) {
  const checksums = Object.fromEntries(names.map((name) => [name, sha256File(join(stage, name))]))
  writeFileSync(join(stage, 'SHA256SUMS.json'), `${JSON.stringify(checksums, null, 2)}\n`)
  writeFileSync(
    join(stage, 'SHA256SUMS'),
    `${Object.entries(checksums).map(([name, digest]) => `${digest}  ${name}`).join('\n')}\n`,
  )
  return checksums
}

export function assertPublishedEntries(directory, expectedNames) {
  const actual = readdirSync(directory).sort()
  const expected = [...expectedNames].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new MacReleaseError(
      `release output entries differ from allowlist: expected ${expected.join(', ')}, found ${actual.join(', ')}`,
    )
  }
  if (actual.some((name) => name.endsWith('.app'))) {
    throw new MacReleaseError('release output must not publish a raw app bundle')
  }
  return actual
}

export async function assembleMacRelease({
  arm64App,
  arm64Report,
  output,
  repoRoot,
  inputsPath,
  mode,
  identity,
  keychain,
  force = false,
}) {
  if (process.platform !== 'darwin') throw new MacReleaseError('macOS release assembly requires macOS')
  const signing = validateSigningOptions({ mode, identity, keychain })
  const inputs = loadReleaseInputs(inputsPath)
  validateInstalledReleaseTools(inputs, repoRoot)
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const provenance = resolveSourceProvenance(repoRoot)
  const thinReport = verifyThinReport({
    arm64App,
    arm64Report,
    packageVersion: pkg.version,
    inputs,
    provenance,
    mode,
  })
  const outputResolved = resolve(output)
  mkdirSync(dirname(outputResolved), { recursive: true })
  const work = mkdtempSync(join(dirname(outputResolved), '.mac-release-'))
  const stage = join(work, 'publish')
  mkdirSync(stage)

  try {
    const app = join(stage, `${APP_NAME}.app`)
    // A copy, so the verified thin app keeps the tree its report binds.
    execFileSync('/usr/bin/ditto', [resolve(arm64App), app], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10 * 60_000,
    })
    // Signing below seals Electron Framework's resources as they are now (#292).
    assertEnglishOnlyElectronLocales(app, 'darwin', 'macOS app')
    const appResources = join(app, 'Contents', 'Resources', 'app')
    const entitlementsRoot = join(repoRoot, 'release', 'entitlements')
    markBuildProperties(app, mode, inputs.minimumMacosVersion)

    const manifests = {}
    const signedRuntimeMachOs = {}
    for (const key of RUNTIME_KEYS) {
      const runtimeRoot = join(appResources, 'runtime', key)
      const distribution = inputs.node.distributions[key]
      const runtimeManifest = verifyPayload({
        root: runtimeRoot,
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
      assertRuntimeSourceCommit(runtimeManifest, provenance.sourceCommit, `embedded ${key}`)
      signedRuntimeMachOs[key] = signPortableRuntime({ runtimeRoot, signing, entitlementsRoot })
        .map((path) => relative(runtimeRoot, path))
      manifests[key] = regenerateRuntimeManifest(runtimeRoot)
    }

    writeSetupInfo({ repoRoot, appResources, packageVersion: pkg.version })
    const setupInfo = verifySetupInfo(appResources, pkg.version)
    const runtimeSnapshots = Object.fromEntries(
      RUNTIME_KEYS.map((key) => [key, hashTree(join(appResources, 'runtime', key))]),
    )

    await signElectronEnvelope({
      app,
      appResources,
      signing,
      entitlementsRoot,
      electronVersion: inputs.electron.version,
    })
    for (const key of RUNTIME_KEYS) {
      assertTreeHashes(join(appResources, 'runtime', key), runtimeSnapshots[key])
    }
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', app], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    })
    // The signed tree, _CodeSignature folders and helper apps included (#378).
    assertSafeTreeModes(app, { label: 'signed macOS app' })

    const architectures = verifyMachOArchitectures(app, appResources, inputs)
    const nativeSelftest = runNativeRuntimeSelftest(appResources)
    const appTreeDigest = treeIdentity(app)
    const { sourceCommit, sourceDirty } = provenance
    const base = `Agent-Inbox-${pkg.version}-macos-${mode}`
    const archiveName = `${base}.tar.gz`
    const dmgName = `${base}-provisional.dmg`
    const reportName = `${base}-verification.json`
    const metadataName = `${base}-metadata.json`

    execFileSync('/usr/bin/tar', ['-czf', join(stage, archiveName), '-C', stage, `${APP_NAME}.app`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10 * 60_000,
    })
    await createReleaseDmg({
      app,
      title: `${APP_NAME} ${pkg.version}`,
      icon: join(repoRoot, 'electron', 'icon.icns'),
      output: join(stage, dmgName),
    })
    rmSync(app, { recursive: true, force: true })

    const report = {
      schema: 1,
      product: APP_NAME,
      packageVersion: pkg.version,
      sourceCommit,
      sourceDirty,
      sourceProvenance: sourceDirty ? 'dirty-working-tree' : 'clean-commit',
      buildMode: mode,
      provisional: true,
      notarized: false,
      ...releaseDisposition(mode),
      signing: mode === 'developer-id' ? 'developer-id' : 'ad-hoc',
      runtimeInputManifest: 'macos-inputs.json',
      runtimeSourceCommit: sourceCommit,
      runtimeManifestDigests: Object.fromEntries(
        RUNTIME_KEYS.map((key) => [key, setupInfo.runtimePayloads[key].digest]),
      ),
      runtimePayloadDigests: Object.fromEntries(
        RUNTIME_KEYS.map((key) => [key, manifests[key].payloadDigest]),
      ),
      signedRuntimeMachOs,
      architectures,
      nativeSelftest,
      appTreeDigest,
      thinReports: {
        arm64: {
          appTreeDigest: thinReport.appTreeDigest,
          nativeRuntimeSelftest: thinReport.nativeRuntimeSelftest,
        },
      },
      runtimeHashesUnchangedAfterOuterSign: true,
      gatekeeperTrusted: false,
    }
    writeFileSync(join(stage, reportName), `${JSON.stringify(report, null, 2)}\n`)
    cpSync(inputsPath ?? join(repoRoot, 'release', 'macos-inputs.json'), join(stage, 'macos-inputs.json'))
    const metadata = {
      schema: 1,
      product: APP_NAME,
      packageVersion: pkg.version,
      sourceCommit,
      sourceDirty,
      sourceProvenance: sourceDirty ? 'dirty-working-tree' : 'clean-commit',
      sourceDateEpoch: process.env.SOURCE_DATE_EPOCH ?? null,
      buildMode: mode,
      provisional: true,
      notarized: false,
      ...releaseDisposition(mode),
      artifacts: { appArchive: archiveName, dmg: dmgName, verificationReport: reportName },
    }
    writeFileSync(join(stage, metadataName), `${JSON.stringify(metadata, null, 2)}\n`)
    const checksummedNames = [archiveName, dmgName, reportName, metadataName, 'macos-inputs.json']
    const checksums = writeChecksums(stage, checksummedNames)
    assertPublishedEntries(stage, [...checksummedNames, 'SHA256SUMS', 'SHA256SUMS.json'])

    const finalStage = join(work, 'final')
    renameSync(stage, finalStage)
    publishDirectory(finalStage, outputResolved, force)
    return { output: outputResolved, archiveName, dmgName, reportName, metadataName, checksums }
  } catch (err) {
    throw err
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'arm64-app': { type: 'string' },
      'arm64-report': { type: 'string' },
      output: { type: 'string' },
      mode: { type: 'string', default: 'adhoc' },
      identity: { type: 'string' },
      keychain: { type: 'string' },
      'repo-root': { type: 'string', default: resolve(import.meta.dirname, '..') },
      inputs: { type: 'string' },
      force: { type: 'boolean' },
    },
  })
  for (const field of ['arm64-app', 'arm64-report', 'output']) {
    if (!values[field]) throw new MacReleaseError(`--${field} is required`)
  }
  const result = await assembleMacRelease({
    arm64App: resolve(values['arm64-app']),
    arm64Report: resolve(values['arm64-report']),
    output: resolve(values.output),
    repoRoot: resolve(values['repo-root']),
    inputsPath: values.inputs && resolve(values.inputs),
    mode: values.mode,
    identity: values.identity,
    keychain: values.keychain && resolve(values.keychain),
    force: Boolean(values.force),
  })
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`assemble-macos-release: ${err.message}\n`)
    process.exitCode = 1
  })
}
