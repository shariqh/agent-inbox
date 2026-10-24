import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { makeUniversalApp } from '@electron/universal'
import { copyElectronNotices } from '../scripts/build-thin-app.mjs'
import {
  extractTreeArchive,
  createTreeArchive,
  validateArchiveEntries as validateTreeArchiveEntries,
} from '../scripts/archive-tree.mjs'
import {
  MacReleaseError,
  RUNTIME_MACHO_FILES,
  UNIVERSAL_RUNTIME_GLOB,
  assertPublishedEntries,
  releaseDisposition,
  signPortableRuntime,
  validateSigningOptions,
  verifyThinReports,
} from '../scripts/assemble-macos-release.mjs'
import {
  assertNativeRuntimeKey,
  stageNativeRuntime,
  validateArchiveEntries,
} from '../scripts/stage-native-runtime.mjs'
import { loadReleaseInputs } from '../scripts/release-inputs.mjs'
import { copyAgentInboxLicense } from '../scripts/license.mjs'
import { treeIdentity } from '../scripts/tree-identity.mjs'
import { assertRuntimeSourceCommit } from '../scripts/runtime-provenance.mjs'
import { resolveSourceProvenance } from '../scripts/source-provenance.mjs'
import { RUNTIME_TARGETS } from '../scripts/runtime-targets.mjs'
import { verifyPackagedUpdateTrust } from '../scripts/package-update-trust.mjs'
import { assertEnglishOnlyElectronLocales, pruneElectronLocales } from '../scripts/prune-electron-locales.mjs'
import { scratchDir } from './scratch.js'

const root = resolve(process.cwd())

function transitiveLocalModules(entry: string): string[] {
  const found = new Set<string>()
  const visit = (path: string) => {
    const repoPath = relative(root, path).split('\\').join('/')
    if (found.has(repoPath)) return
    found.add(repoPath)
    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(/(?:from\s+|require\()\s*['"](\.[^'"]+\.(?:mjs|cjs))['"]/g)) {
      const specifier = match[1]
      if (!specifier) continue
      visit(resolve(dirname(path), specifier))
    }
  }
  visit(resolve(root, entry))
  return [...found].sort()
}

function transitiveCommonJsModules(entry: string): string[] {
  const found = new Set<string>()
  const visit = (path: string) => {
    const repoPath = relative(root, path).split('\\').join('/')
    if (found.has(repoPath)) return
    found.add(repoPath)
    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(/require\(['"](\.[^'"]+\.cjs)['"]\)/g)) {
      const specifier = match[1]
      if (!specifier) continue
      visit(resolve(dirname(path), specifier))
    }
  }
  visit(resolve(root, entry))
  return [...found].sort()
}

describe('native architecture release stages', () => {
  it('refuses cross-architecture runtime staging and partial archive roots', () => {
    expect(() => assertNativeRuntimeKey('darwin-x64', 'darwin', 'arm64')).toThrow(/must be staged natively/)
    expect(() => validateArchiveEntries([
      'node-v24.19.0-darwin-arm64/bin/node',
      'other-root/LICENSE',
    ], 'node-v24.19.0-darwin-arm64')).toThrow(/outside/)
  })

  it('rejects mismatched and unknown targets before reading release or repository paths', async () => {
    const nativeKey = `${process.platform}-${process.arch}`
    const mismatchedKey = Object.keys(RUNTIME_TARGETS).find((key) => key !== nativeKey)
    if (!mismatchedKey) throw new Error('fixture requires a non-native runtime target')
    const unreachable = join(tmpdir(), 'must-not-be-read', String(process.pid))
    const options = {
      output: join(unreachable, 'output'),
      repoRoot: join(unreachable, 'repo'),
      inputsPath: join(unreachable, 'release-inputs.json'),
      archivePath: join(unreachable, 'archive'),
    }

    await expect(stageNativeRuntime({ ...options, key: mismatchedKey }))
      .rejects.toThrow(/must be staged natively/)
    await expect(stageNativeRuntime({ ...options, key: 'unknown-x64' }))
      .rejects.toThrow(/unknown runtime target/)
  })

  it('pins npm lifecycle builds to the runtime target architecture', () => {
    const source = readFileSync(join(root, 'scripts', 'stage-runtime.mjs'), 'utf8')
    expect(source).toContain("npm_config_runtime: 'node'")
    expect(source).toContain("npm_config_target: nodeVersion.replace")
    expect(source).toContain('npm_config_platform: platform')
    expect(source).toContain('npm_config_arch: arch')
    expect(source).toContain("npm_config_build_from_source: 'true'")
    expect(source).toContain('npm_config_nodedir: nodeRoot')
  })

  it('binds CI provenance to checkout HEAD and records local dirty state', () => {
    const repo = scratchDir('release-provenance-')
    execFileSync('git', ['init', '--quiet'], { cwd: repo })
    writeFileSync(join(repo, 'file'), 'clean\n')
    execFileSync('git', ['add', 'file'], { cwd: repo })
    execFileSync('git', [
      '-c', 'user.name=Release Test',
      '-c', 'user.email=release@example.invalid',
      'commit', '--quiet', '-m', 'fixture',
    ], { cwd: repo })
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    expect(resolveSourceProvenance(repo, { GITHUB_SHA: head })).toEqual({
      sourceCommit: head,
      sourceDirty: false,
    })
    expect(resolveSourceProvenance(repo, {
      GITHUB_SHA: 'b'.repeat(40),
      AGENT_INBOX_RELEASE_SOURCE_SHA: head,
    })).toEqual({
      sourceCommit: head,
      sourceDirty: false,
    })
    expect(() => resolveSourceProvenance(repo, { GITHUB_SHA: 'b'.repeat(40) }))
      .toThrow(/does not match checkout HEAD/)
    writeFileSync(join(repo, 'file'), 'dirty\n')
    expect(resolveSourceProvenance(repo, {})).toEqual({
      sourceCommit: head,
      sourceDirty: true,
    })
  })

  it('ships the exact Agent Inbox MIT notice separately in app and runtime payloads', () => {
    const temp = scratchDir('release-license-')
    const expected = readFileSync(join(root, 'LICENSE'), 'utf8')
    const appLicense = join(temp, 'app', 'LICENSE.agent-inbox')
    const runtimeLicense = join(temp, 'runtime', 'LICENSE.agent-inbox')
    mkdirSync(join(temp, 'app'), { recursive: true })
    mkdirSync(join(temp, 'runtime'), { recursive: true })
    copyAgentInboxLicense(root, appLicense)
    copyAgentInboxLicense(root, runtimeLicense)
    expect(readFileSync(appLicense, 'utf8')).toBe(expected)
    expect(readFileSync(runtimeLicense, 'utf8')).toBe(expected)
    expect(readFileSync(join(root, 'scripts', 'build-thin-app.mjs'), 'utf8'))
      .toContain("copyAgentInboxLicense(repoRoot, join(stageRoot, 'LICENSE.agent-inbox'))")
    expect(readFileSync(join(root, 'scripts', 'stage-runtime.mjs'), 'utf8'))
      .toContain("copyAgentInboxLicense(repoRoot, join(stageDir, 'LICENSE.agent-inbox'))")
  })

  it('copies exact nonempty Electron and Chromium notices into app resources', () => {
    const temp = scratchDir('electron-notices-')
    const packagerOutput = join(temp, 'packager')
    const app = join(packagerOutput, 'Agent Inbox.app')
    mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true })
    writeFileSync(join(packagerOutput, 'LICENSE'), 'Electron license\n')
    writeFileSync(join(packagerOutput, 'LICENSES.chromium.html'), '<p>Chromium notices</p>\n')
    copyElectronNotices(packagerOutput, app)
    expect(readFileSync(join(app, 'Contents', 'Resources', 'LICENSE.electron'), 'utf8'))
      .toBe('Electron license\n')
    expect(readFileSync(join(app, 'Contents', 'Resources', 'LICENSES.chromium.html'), 'utf8'))
      .toBe('<p>Chromium notices</p>\n')
    writeFileSync(join(packagerOutput, 'LICENSE'), '')
    expect(() => copyElectronNotices(packagerOutput, app)).toThrow(/missing nonempty LICENSE/)
  })

  it('loads the shipped update verifier and pinned registry from a macOS app folder', () => {
    const appResources = join(
      scratchDir('macos-update-trust-'),
      'Agent Inbox.app',
      'Contents',
      'Resources',
      'app',
    )
    mkdirSync(join(appResources, 'electron'), { recursive: true })
    mkdirSync(join(appResources, 'release'), { recursive: true })
    cpSync(join(root, 'electron/update-manifest.cjs'), join(appResources, 'electron/update-manifest.cjs'))
    cpSync(join(root, 'electron/update-trust.cjs'), join(appResources, 'electron/update-trust.cjs'))
    cpSync(join(root, 'release/update-keys.json'), join(appResources, 'release/update-keys.json'))

    expect(verifyPackagedUpdateTrust(appResources)).toEqual({
      signingKeyId: 'ed25519-99927ba2f6af6482',
      trustedKeyIds: ['ed25519-99927ba2f6af6482', 'ed25519-c8adddea0de080d6'],
    })
  })

  it('rejects stale or missing runtime source commits', () => {
    const expected = 'a'.repeat(40)
    expect(assertRuntimeSourceCommit({ sourceCommit: expected }, expected, 'fixture'))
      .toEqual({ sourceCommit: expected })
    expect(() => assertRuntimeSourceCommit({ sourceCommit: 'b'.repeat(40) }, expected, 'fixture'))
      .toThrow(/runtime source commit mismatch/)
    expect(() => assertRuntimeSourceCommit({ sourceCommit: null }, expected, 'fixture'))
      .toThrow(/no valid source commit/)
  })

  it('preserves executable modes and symlinks across job archives', () => {
    const temp = scratchDir('release-archive-')
    const source = join(temp, 'thin-arm64')
    mkdirSync(join(source, 'Agent Inbox.app', 'Contents', 'Frameworks'), { recursive: true })
    const executable = join(source, 'Agent Inbox.app', 'Contents', 'MacOS')
    mkdirSync(executable)
    const binary = join(executable, 'Agent Inbox')
    writeFileSync(binary, '#!/bin/sh\n')
    chmodSync(binary, 0o755)
    symlinkSync('../MacOS', join(source, 'Agent Inbox.app', 'Contents', 'Frameworks', 'Current'))
    const archive = join(temp, 'thin-arm64.tar.gz')
    createTreeArchive({ source, archive })
    const extracted = join(temp, 'extracted')
    extractTreeArchive({ archive, destination: extracted, expectedRoot: 'thin-arm64' })
    const app = join(extracted, 'thin-arm64', 'Agent Inbox.app', 'Contents')
    expect(statSync(join(app, 'MacOS', 'Agent Inbox')).mode & 0o777).toBe(0o755)
    expect(lstatSync(join(app, 'Frameworks', 'Current')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(app, 'Frameworks', 'Current'))).toBe('../MacOS')
  })

  it('validates the expected root before extraction and rejects escaping symlinks', () => {
    const temp = scratchDir('release-extract-')
    const wrongRoot = join(temp, 'wrong-root')
    mkdirSync(wrongRoot)
    writeFileSync(join(wrongRoot, 'file'), 'payload')
    const wrongArchive = join(temp, 'wrong.tar.gz')
    createTreeArchive({ source: wrongRoot, archive: wrongArchive })
    const destination = join(temp, 'destination')
    expect(() => extractTreeArchive({
      archive: wrongArchive,
      destination,
      expectedRoot: 'expected-root',
    })).toThrow(/outside expected root/)
    expect(existsSync(destination)).toBe(false)

    const unsafeRoot = join(temp, 'expected-root')
    mkdirSync(unsafeRoot)
    symlinkSync('../../outside', join(unsafeRoot, 'escape'))
    const unsafeArchive = join(temp, 'unsafe.tar.gz')
    createTreeArchive({ source: unsafeRoot, archive: unsafeArchive })
    expect(() => extractTreeArchive({
      archive: unsafeArchive,
      destination,
      expectedRoot: 'expected-root',
    })).toThrow(/broken symlink|escapes expected root/)
    expect(existsSync(join(destination, 'expected-root'))).toBe(false)
    expect(() => validateTreeArchiveEntries(['expected-root/../escape'], 'expected-root'))
      .toThrow(/unsafe path/)
    expect(() => validateTreeArchiveEntries(['expected-root/file'], 'expected\\root'))
      .toThrow(/safe path component/)
    for (const entry of [
      'C:/expected-root/file',
      'expected-root\\file',
      'expected-root/./file',
      'expected-root//file',
      'expected-root//',
      'expected-root/\0file',
    ]) {
      expect(() => validateTreeArchiveEntries([entry], 'expected-root'), entry)
        .toThrow(/unsafe path/)
    }
    expect(() => validateTreeArchiveEntries([
      'expected-root/file',
      'expected-root/file',
    ], 'expected-root')).toThrow(/duplicate path/)

    const hardlinkRoot = join(temp, 'hardlink-root')
    mkdirSync(hardlinkRoot)
    writeFileSync(join(hardlinkRoot, 'original'), 'payload')
    linkSync(join(hardlinkRoot, 'original'), join(hardlinkRoot, 'alias'))
    const hardlinkArchive = join(temp, 'hardlink.tar.gz')
    createTreeArchive({ source: hardlinkRoot, archive: hardlinkArchive })
    expect(() => extractTreeArchive({
      archive: hardlinkArchive,
      destination,
      expectedRoot: 'hardlink-root',
    })).toThrow(/hardlinks are not permitted/)
    expect(existsSync(join(destination, 'hardlink-root'))).toBe(false)
  })

  it('prunes the app copy, architecture-only rebuild caches included, before universal merging (#291)', () => {
    const source = readFileSync(join(root, 'scripts', 'build-thin-app.mjs'), 'utf8')
    expect(source).toContain("export function pruneAppNodeModules(stageRoot) {")
    expect(source).toContain('return pruneNodeModules(stageRoot)')
    expect(source.indexOf('pruneAppNodeModules(stageRoot)\n'))
      .toBeLessThan(source.indexOf('const packagerOut'))
    expect(source).not.toContain('pruneNativeAddonBuildArtifacts')
  })

  it('prunes each runtime before its probes, selftests and manifest (#291)', () => {
    const source = readFileSync(join(root, 'scripts', 'stage-runtime.mjs'), 'utf8')
    const deref = source.indexOf('renameSync(dereffed, srcModules)')
    const prune = source.indexOf('pruneNodeModules(stageDir)')
    const probe = source.indexOf("probeStagedNativeDependency(stageDir, nodeBin, 'after node_modules normalization and pruning')")
    const selftest = source.indexOf('\n  runStagedSelftest(stageDir, adapter)\n')
    const manifest = source.indexOf('const manifest = buildManifest({')
    expect(deref).toBeGreaterThan(-1)
    expect(prune).toBeGreaterThan(deref)
    expect(probe).toBeGreaterThan(prune)
    expect(selftest).toBeGreaterThan(probe)
    expect(manifest).toBeGreaterThan(selftest)
  })

  it('refuses an unpruned app or runtime in every thin-app gate (#291)', () => {
    for (const [file, gates] of [
      ['verify-linux-thin-app.mjs', ['assertPrunedNodeModules(resources, ', 'assertPrunedNodeModules(runtimeRoot, ']],
      ['verify-windows-thin-app.mjs', ['assertPrunedNodeModules(resources, ', 'assertPrunedNodeModules(runtimeRoot, ']],
      ['build-thin-app.mjs', ['assertPrunedNodeModules(resources, ', "assertPrunedNodeModules(join(resources, 'runtime', key), "]],
    ] as const) {
      const source = readFileSync(join(root, 'scripts', file), 'utf8')
      for (const gate of gates) expect(source, `${file}: ${gate}`).toContain(gate)
    }
    const thin = readFileSync(join(root, 'scripts', 'build-thin-app.mjs'), 'utf8')
    expect(thin.indexOf('assertPrunedNodeModules(resources, ')).toBeGreaterThan(thin.indexOf('const paths = await packager({'))
    expect(thin.indexOf('assertPrunedNodeModules(resources, ')).toBeLessThan(thin.indexOf('publishAtomically(app, destination, force)'))
  })

  it('prunes the Electron locales once, after packaging and before any check, hash or publication (#292)', () => {
    const thin = readFileSync(join(root, 'scripts', 'build-thin-app.mjs'), 'utf8')
    const prune = thin.indexOf("pruneElectronLocales(app, 'darwin')")
    const gate = thin.indexOf("assertEnglishOnlyElectronLocales(app, 'darwin', ")
    expect(prune).toBeGreaterThan(thin.indexOf('const paths = await packager({'))
    expect(prune).toBeGreaterThan(thin.indexOf('copyElectronNotices(paths[0], app)'))
    expect(gate).toBeGreaterThan(prune)
    expect(gate).toBeLessThan(thin.indexOf('runElectronSqliteCheck({'))
    expect(gate).toBeLessThan(thin.indexOf('publishAtomically(app, destination, force)'))
    expect(gate).toBeLessThan(thin.indexOf('appTreeDigest: treeIdentity(destination)'))
    for (const [file, call, verification] of [
      ['build-linux-thin-app.mjs', "pruneElectronLocales(packaged, 'linux')", 'const verification = verifyLinuxThinApp({'],
      ['build-windows-thin-app.mjs', "pruneElectronLocales(packaged, 'win32')", 'const initial = verifyWindowsThinApp({'],
    ] as const) {
      const source = readFileSync(join(root, 'scripts', file), 'utf8')
      const at = source.indexOf(call)
      expect(at, file).toBeGreaterThan(source.indexOf('const paths = await packager({'))
      // the verification computes the tree digest the reports and packages bind to
      expect(at, file).toBeLessThan(source.indexOf(verification))
    }
    // once per builder: nothing after the packager adds a locale back
    for (const file of ['build-thin-app.mjs', 'build-linux-thin-app.mjs', 'build-windows-thin-app.mjs']) {
      expect(readFileSync(join(root, 'scripts', file), 'utf8').match(/pruneElectronLocales\(/g), file).toHaveLength(1)
    }
  })

  it('refuses another Electron locale, or a missing English one, in every thin-app, universal and final-DMG gate (#292)', () => {
    for (const [file, gate] of [
      ['build-thin-app.mjs', "assertEnglishOnlyElectronLocales(app, 'darwin', "],
      ['verify-linux-thin-app.mjs', "assertEnglishOnlyElectronLocales(appRoot, 'linux', "],
      ['verify-windows-thin-app.mjs', "assertEnglishOnlyElectronLocales(appRoot, 'win32', "],
      ['assemble-macos-release.mjs', "assertEnglishOnlyElectronLocales(app, 'darwin', "],
      ['macos-release-gates.mjs', "assertEnglishOnlyElectronLocales(copiedApp, 'darwin', "],
    ] as const) {
      expect(readFileSync(join(root, 'scripts', file), 'utf8'), file).toContain(gate)
    }
    const gates = readFileSync(join(root, 'scripts', 'macos-release-gates.mjs'), 'utf8')
    const finalGate = gates.indexOf("assertEnglishOnlyElectronLocales(copiedApp, 'darwin', ")
    expect(finalGate).toBeGreaterThan(gates.indexOf('export async function verifyFinalDmg({'))
    expect(finalGate).toBeLessThan(gates.indexOf('await verifyCopiedAppLaunch({'))
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    expect(pkg.scripts['package:smoke']).toContain('test/prune-electron-locales.test.ts')
  })

  it('uses the fixed native Windows archive adapter without changing POSIX tar selection', () => {
    const source = readFileSync(join(root, 'scripts', 'archive-tree.mjs'), 'utf8')
    expect(source).toContain("nativeRuntimeAdapterFor('win32-x64').archiveExecutable")
    expect(source).toContain(": '/usr/bin/tar'")
    expect(source).not.toMatch(/powershell|cmd\.exe|shell:\s*true/i)
  })

  it('runs the Electron-embedded SQLite check in every native thin app before publication (#135)', () => {
    const source = readFileSync(join(root, 'scripts', 'build-thin-app.mjs'), 'utf8')
    const lipo = source.indexOf('lipoArchs(nativeAddon)')
    const check = source.indexOf('runElectronSqliteCheck({')
    const publish = source.indexOf('publishAtomically(app, destination, force)')
    expect(lipo).toBeGreaterThan(-1)
    expect(check).toBeGreaterThan(lipo)
    expect(publish).toBeGreaterThan(check)
    const call = source.slice(check, publish)
    expect(call).toContain("executable: join(app, 'Contents', 'MacOS', APP_NAME)")
    expect(call).toContain("storePath: join(resources, 'dist', 'store.js')")
    expect(call).toContain('electron: inputs.electron.version')
    expect(source.slice(publish)).toContain("electronSqliteCheck: 'passed'")
  })

  it('installs and compiles each thin app stage only through the prebuild-free step (#315)', () => {
    for (const builder of ['build-thin-app.mjs', 'build-linux-thin-app.mjs', 'build-windows-thin-app.mjs']) {
      const source = readFileSync(join(root, 'scripts', builder), 'utf8')
      const install = source.indexOf('await installAppDependencies({')
      expect(install, builder).toBeGreaterThan(-1)
      const prune = source.indexOf('pruneAppNodeModules(stageRoot)', install)
      expect(prune, builder).toBeGreaterThan(install)
      expect(prune, builder).toBeLessThan(source.indexOf('await packager({', install))
      expect(source, builder).not.toMatch(/'ci', '--omit=dev'|await rebuild\(|@electron\/rebuild/)
    }
    const linux = readFileSync(join(root, 'scripts', 'build-linux-thin-app.mjs'), 'utf8')
    expect(linux.indexOf('Object.assign(process.env, compilerEnvironment)'))
      .toBeLessThan(linux.indexOf('await installAppDependencies({'))
  })
})

describe('universal finalization contract', () => {
  it('uses the ecosystem merger while preserving both keyed runtime trees as thin payloads', () => {
    expect(UNIVERSAL_RUNTIME_GLOB).toBe('Contents/Resources/app/runtime/**')
    const source = readFileSync(join(root, 'scripts', 'assemble-macos-release.mjs'), 'utf8')
    expect(source).toContain('makeUniversalApp({')
    expect(source).toContain('x64ArchFiles: UNIVERSAL_RUNTIME_GLOB')
    expect(source).toContain("RUNTIME_KEYS.map")
    expect(source).not.toContain("'--force', '--deep'")
  })

  it.skipIf(process.platform !== 'darwin')('behaviorally preserves keyed thin runtimes while merging app Mach-Os', async () => {
    const temp = scratchDir('universal-fixture-')
    const source = join(temp, 'main.c')
    writeFileSync(source, 'int main(void) { return 0; }\n')
    const binaries = {
      arm64: join(temp, 'arm64'),
      x64: join(temp, 'x64'),
    }
    execFileSync('/usr/bin/xcrun', ['clang', '-arch', 'arm64', source, '-o', binaries.arm64])
    execFileSync('/usr/bin/xcrun', ['clang', '-arch', 'x86_64', source, '-o', binaries.x64])

    const makeApp = (arch: 'arm64' | 'x64') => {
      const app = join(temp, `${arch}.app`)
      const contents = join(app, 'Contents')
      const resources = join(contents, 'Resources', 'app')
      mkdirSync(join(contents, 'MacOS'), { recursive: true })
      mkdirSync(join(resources, 'runtime', 'darwin-arm64', 'bin'), { recursive: true })
      mkdirSync(join(resources, 'runtime', 'darwin-x64', 'bin'), { recursive: true })
      mkdirSync(join(resources, 'node_modules', 'fixture', 'build', 'Release'), { recursive: true })
      cpSync(binaries[arch], join(contents, 'MacOS', 'Fixture'))
      cpSync(binaries.arm64, join(resources, 'runtime', 'darwin-arm64', 'bin', 'node'))
      cpSync(binaries.x64, join(resources, 'runtime', 'darwin-x64', 'bin', 'node'))
      cpSync(binaries[arch], join(resources, 'node_modules', 'fixture', 'build', 'Release', 'fixture.node'))
      writeFileSync(join(resources, 'package.json'), '{"main":"index.js"}\n')
      writeFileSync(join(resources, 'index.js'), 'module.exports = {}\n')
      writeFileSync(join(contents, 'Info.plist'), [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Fixture</string></dict></plist>',
      ].join('\n'))
      return app
    }
    const arm64App = makeApp('arm64')
    const x64App = makeApp('x64')
    const universalApp = join(temp, 'Universal.app')
    await makeUniversalApp({
      arm64AppPath: arm64App,
      x64AppPath: x64App,
      outAppPath: universalApp,
      force: true,
      mergeASARs: false,
      x64ArchFiles: UNIVERSAL_RUNTIME_GLOB,
    })
    const archs = (path: string) => execFileSync('/usr/bin/lipo', ['-archs', path], { encoding: 'utf8' }).trim().split(/\s+/).sort()
    expect(archs(join(universalApp, 'Contents', 'MacOS', 'Fixture'))).toEqual(['arm64', 'x86_64'])
    expect(archs(join(universalApp, 'Contents', 'Resources', 'app', 'node_modules', 'fixture', 'build', 'Release', 'fixture.node')))
      .toEqual(['arm64', 'x86_64'])
    expect(archs(join(universalApp, 'Contents', 'Resources', 'app', 'runtime', 'darwin-arm64', 'bin', 'node')))
      .toEqual(['arm64'])
    expect(archs(join(universalApp, 'Contents', 'Resources', 'app', 'runtime', 'darwin-x64', 'bin', 'node')))
      .toEqual(['x86_64'])
  })

  // Signing seals the framework's resources: it has to see the pruned set (#292).
  it('checks the merged app ships only English before anything is signed (#292)', () => {
    const source = readFileSync(join(root, 'scripts', 'assemble-macos-release.mjs'), 'utf8')
    const gate = source.indexOf("assertEnglishOnlyElectronLocales(app, 'darwin', ")
    expect(gate).toBeGreaterThan(source.indexOf('await makeUniversalApp({'))
    expect(gate).toBeLessThan(source.indexOf('signedRuntimeMachOs[key] = signPortableRuntime({'))
    expect(gate).toBeLessThan(source.indexOf('await signElectronEnvelope({'))
  })

  it.skipIf(process.platform !== 'darwin')('merges thin apps pruned alike, and refuses thin apps whose locales differ (#292)', async () => {
    const temp = scratchDir('universal-locales-')
    const source = join(temp, 'main.c')
    writeFileSync(source, 'int main(void) { return 0; }\n')
    const binaries = { arm64: join(temp, 'arm64'), x64: join(temp, 'x64') }
    execFileSync('/usr/bin/xcrun', ['clang', '-arch', 'arm64', source, '-o', binaries.arm64])
    execFileSync('/usr/bin/xcrun', ['clang', '-arch', 'x86_64', source, '-o', binaries.x64])
    const frameworkResources = join('Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources')
    const makeApp = (name: string, arch: 'arm64' | 'x64', prune: boolean) => {
      const app = join(temp, `${name}.app`)
      mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
      mkdirSync(join(app, 'Contents', 'Resources', 'app'), { recursive: true })
      cpSync(binaries[arch], join(app, 'Contents', 'MacOS', 'Fixture'))
      writeFileSync(join(app, 'Contents', 'Resources', 'app', 'package.json'), '{"main":"index.js"}\n')
      writeFileSync(join(app, 'Contents', 'Resources', 'app', 'index.js'), 'module.exports = {}\n')
      writeFileSync(join(app, 'Contents', 'Info.plist'), [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Fixture</string></dict></plist>',
      ].join('\n'))
      for (const locale of ['en', 'en_GB', 'en_GB_NEUTER', 'fr']) {
        mkdirSync(join(app, 'Contents', 'Resources', `${locale}.lproj`), { recursive: true })
        mkdirSync(join(app, frameworkResources, `${locale}.lproj`), { recursive: true })
        writeFileSync(join(app, frameworkResources, `${locale}.lproj`, 'locale.pak'), `${locale}\n`)
      }
      if (prune) pruneElectronLocales(app, 'darwin')
      return app
    }
    const merge = (arm64AppPath: string, x64AppPath: string, outAppPath: string) => makeUniversalApp({
      arm64AppPath,
      x64AppPath,
      outAppPath,
      force: true,
      mergeASARs: false,
      x64ArchFiles: UNIVERSAL_RUNTIME_GLOB,
    })

    const universal = join(temp, 'Universal.app')
    await merge(makeApp('arm64', 'arm64', true), makeApp('x64', 'x64', true), universal)
    expect(() => assertEnglishOnlyElectronLocales(universal, 'darwin', 'universal app')).not.toThrow()
    expect(readdirSync(join(universal, frameworkResources))).toEqual(['en.lproj', 'en_GB.lproj'])

    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(merge(makeApp('arm64-unpruned', 'arm64', false), makeApp('x64-pruned', 'x64', true), join(temp, 'Mixed.app')))
        .rejects.toThrow(/found a mismatch/)
      expect(reported).toHaveBeenCalledWith({
        uniqueToX64: [],
        uniqueToArm64: [
          join(frameworkResources, 'en_GB_NEUTER.lproj', 'locale.pak'),
          join(frameworkResources, 'fr.lproj', 'locale.pak'),
        ],
      })
    } finally {
      reported.mockRestore()
    }
  })

  it('fails closed when Developer ID inputs are absent or malformed', () => {
    expect(() => validateSigningOptions({ mode: 'developer-id' })).toThrow(MacReleaseError)
    expect(() => validateSigningOptions({
      mode: 'developer-id',
      identity: 'Apple Development: Example',
      keychain: '/does/not/exist',
    })).toThrow(/Developer ID Application/)
    expect(validateSigningOptions({ mode: 'adhoc' })).toMatchObject({ mode: 'adhoc', identity: '-' })
    expect(() => validateSigningOptions({ mode: 'adhoc', identity: 'Developer ID Application: X (ABCDEFGHIJ)' }))
      .toThrow(/does not accept/)
  })

  it('uses hardened runtime and secure timestamps only for Developer ID signing', () => {
    const source = readFileSync(join(root, 'scripts', 'assemble-macos-release.mjs'), 'utf8')
    expect(source).toContain("if (signing.mode === 'developer-id') args.push('--options', 'runtime', '--timestamp')")
    expect(source).toContain("hardenedRuntime: signing.mode === 'developer-id'")
    expect(source).toContain("else args.push('--timestamp=none')")
  })

  it('keeps runtime signing, manifest regeneration, setup rewrite, snapshot, and outer signing in order', () => {
    const source = readFileSync(join(root, 'scripts', 'assemble-macos-release.mjs'), 'utf8')
    const runtimeSign = source.indexOf('signPortableRuntime({')
    const manifest = source.indexOf('regenerateRuntimeManifest(runtimeRoot)')
    const setup = source.indexOf('writeSetupInfo({ repoRoot')
    const snapshot = source.indexOf('const runtimeSnapshots')
    const outer = source.indexOf('await signElectronEnvelope({')
    const unchanged = source.indexOf('assertTreeHashes(', outer)
    expect(runtimeSign).toBeGreaterThan(-1)
    expect(manifest).toBeGreaterThan(runtimeSign)
    expect(setup).toBeGreaterThan(manifest)
    expect(snapshot).toBeGreaterThan(setup)
    expect(outer).toBeGreaterThan(snapshot)
    expect(unchanged).toBeGreaterThan(outer)
  })

  // The runtime signing list is pinned, not whatever Mach-O a build left behind:
  // test_extension.node used to be signed into every release (#291).
  it.skipIf(process.platform !== 'darwin')('signs exactly the runtime\'s Node and addon, refusing any other Mach-O (#291)', () => {
    const temp = scratchDir('runtime-signing-')
    writeFileSync(join(temp, 'main.c'), 'int main(void) { return 0; }\n')
    const binary = join(temp, 'binary')
    execFileSync('/usr/bin/xcrun', ['clang', join(temp, 'main.c'), '-o', binary])
    const runtime = join(temp, 'runtime')
    for (const path of RUNTIME_MACHO_FILES) {
      mkdirSync(dirname(join(runtime, path)), { recursive: true })
      cpSync(binary, join(runtime, path))
    }
    writeFileSync(join(runtime, 'runtime-manifest.json'), '{}\n')
    writeFileSync(join(runtime, 'node_modules', 'better-sqlite3', 'package.json'), '{}\n')
    const signing = validateSigningOptions({ mode: 'adhoc' })
    const entitlementsRoot = join(root, 'release', 'entitlements')
    const leftover = join(runtime, 'node_modules', 'better-sqlite3', 'build', 'Release', 'test_extension.node')
    cpSync(binary, leftover)
    const unsigned = readFileSync(join(runtime, 'bin', 'node'))

    expect(() => signPortableRuntime({ runtimeRoot: runtime, signing, entitlementsRoot })).toThrow(
      'runtime Mach-O files must be exactly bin/node, node_modules/better-sqlite3/build/Release/better_sqlite3.node; '
        + 'found bin/node, node_modules/better-sqlite3/build/Release/better_sqlite3.node, '
        + 'node_modules/better-sqlite3/build/Release/test_extension.node',
    )
    // refused before anything was signed
    expect(readFileSync(join(runtime, 'bin', 'node')).equals(unsigned)).toBe(true)

    rmSync(leftover)
    const signed = signPortableRuntime({ runtimeRoot: runtime, signing, entitlementsRoot })
    expect(signed.map((path) => relative(runtime, path)).sort()).toEqual([...RUNTIME_MACHO_FILES].sort())
    for (const path of signed) execFileSync('/usr/bin/codesign', ['--verify', '--strict', path])
    expect(readFileSync(join(runtime, 'bin', 'node')).equals(unsigned)).toBe(false)
  })

  it('uses minimal reviewed entitlements without sandbox or unsigned executable memory', () => {
    for (const name of ['electron.plist', 'runtime-node.plist', 'runtime-library.plist']) {
      const plist = readFileSync(join(root, 'release', 'entitlements', name), 'utf8')
      expect(plist).not.toContain('app-sandbox')
      expect(plist).not.toContain('allow-unsigned-executable-memory')
      expect(plist).not.toContain('disable-library-validation')
    }
    expect(readFileSync(join(root, 'release', 'entitlements', 'electron.plist'), 'utf8')).toContain('allow-jit')
    expect(readFileSync(join(root, 'release', 'entitlements', 'runtime-node.plist'), 'utf8')).toContain('allow-jit')
  })

  it('pins all ecosystem packaging dependencies exactly', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    expect(pkg.devDependencies).toMatchObject({
      '@electron/osx-sign': '2.6.0',
      '@electron/packager': '20.3.0',
      '@electron/rebuild': '4.2.0',
      '@electron/universal': '3.0.6',
      electron: '43.8.0',
      'electron-installer-dmg': '5.0.1',
    })
  })

  // Issue #197: one constant is the version the MCP server reports in its
  // initialize handshake AND records on its Live presence row, and the viewer
  // compares sessions against it. A release bumps it in src/version.ts.
  it('keeps the MCP handshake version aligned with the package release version', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const version = readFileSync(join(root, 'src', 'version.ts'), 'utf8')
    const mcp = readFileSync(join(root, 'src', 'mcp.ts'), 'utf8')
    expect(pkg.version).toBe('1.6.0')
    expect(version).toContain(`export const AGENT_INBOX_VERSION = '${pkg.version}'`)
    expect(mcp).toContain(`new McpServer({ name: 'agent-inbox', version: AGENT_INBOX_VERSION })`)
    expect(mcp).toContain('server_version: AGENT_INBOX_VERSION')
  })

  it('makes ad-hoc output ineligible for notarization until Developer ID re-finalization', () => {
    const source = readFileSync(join(root, 'scripts', 'assemble-macos-release.mjs'), 'utf8')
    expect(source).toContain("notarized: false")
    expect(source).not.toContain('AgentInboxNotarized')
    expect(source).toContain('LSMinimumSystemVersion')
    expect(source).toContain("gatekeeperTrusted: false")
    expect(source).toContain('-provisional.dmg')
    expect(source).toContain('title: `${APP_NAME} ${pkg.version}`')
    const adhoc = releaseDisposition('adhoc')
    expect(adhoc).toMatchObject({ notaryEligible: false, validationEvidenceOnly: true })
    expect(adhoc.layer3Required[0]).toMatch(/rebuild verified thin apps/)
    expect(adhoc.layer3Required.join(' ')).toMatch(/package:macos --mode developer-id/)
    expect(adhoc.layer3Required.join(' ')).toMatch(/fresh native Intel.*exact Developer ID app/)
    const developerId = releaseDisposition('developer-id')
    expect(developerId).toMatchObject({ notaryEligible: true, validationEvidenceOnly: false })
    expect(developerId.layer3Required[0]).toMatch(/fresh native Intel.*exact Developer ID app/)
    expect(developerId.layer3Required[1]).toMatch(/submit the verified Developer ID app/)
  })

  it('binds thin reports to app bytes and matching clean or dirty source provenance', () => {
    const temp = scratchDir('thin-provenance-')
    const inputs = loadReleaseInputs()
    const provenance = { sourceCommit: 'a'.repeat(40), sourceDirty: true }
    const runtimeManifestDigests = {
      'darwin-arm64': 'sha256:arm64',
      'darwin-x64': 'sha256:x64',
    }
    const fixtures = (['arm64', 'x64'] as const).map((arch) => {
      const app = join(temp, `${arch}.app`)
      const resources = join(app, 'Contents', 'Resources', 'app')
      mkdirSync(resources, { recursive: true })
      writeFileSync(join(resources, 'payload'), arch)
      writeFileSync(join(resources, 'setup-info.json'), JSON.stringify({
        runtimePayloads: Object.fromEntries(
          Object.entries(runtimeManifestDigests).map(([key, digest]) => [key, { digest }]),
        ),
      }))
      const report = join(temp, `${arch}.json`)
      writeFileSync(report, JSON.stringify({
        schema: 1,
        product: 'Agent Inbox',
        packageVersion: '0.1.0',
        ...provenance,
        arch,
        electronVersion: inputs.electron.version,
        nodeVersion: inputs.node.version,
        nodeModulesAbi: inputs.node.modulesAbi,
        runtimeKeys: ['darwin-arm64', 'darwin-x64'],
        runtimeSourceCommit: provenance.sourceCommit,
        runtimeManifestDigests,
        appTreeDigest: treeIdentity(app),
        nativeRuntimeSelftest: 'passed',
        electronSqliteCheck: 'passed',
        nativeAddonArchitectures: [arch === 'arm64' ? 'arm64' : 'x86_64'],
      }))
      return { app, report }
    })
    const armFixture = fixtures[0]
    const x64Fixture = fixtures[1]
    if (!armFixture || !x64Fixture) throw new Error('missing thin fixture')
    const options = {
      arm64App: armFixture.app,
      x64App: x64Fixture.app,
      arm64Report: armFixture.report,
      x64Report: x64Fixture.report,
      packageVersion: '0.1.0',
      inputs,
      provenance,
      mode: 'adhoc' as const,
    }
    expect(verifyThinReports(options)).toHaveProperty('arm64.appTreeDigest')
    const unchecked = JSON.parse(readFileSync(armFixture.report, 'utf8')) as Record<string, unknown>
    delete unchecked.electronSqliteCheck
    const uncheckedReport = join(temp, 'arm64-without-electron-sqlite-check.json')
    writeFileSync(uncheckedReport, JSON.stringify(unchecked))
    expect(() => verifyThinReports({ ...options, arm64Report: uncheckedReport }))
      .toThrow(/thin arm64 verification report is invalid/)
    expect(() => verifyThinReports({
      ...options,
      arm64Report: x64Fixture.report,
      x64Report: armFixture.report,
    })).toThrow(/thin arm64 verification report is invalid/)
    writeFileSync(join(armFixture.app, 'Contents', 'Resources', 'app', 'payload'), 'mutated')
    expect(() => verifyThinReports(options)).toThrow(/does not match its verification report/)
    expect(() => verifyThinReports({
      ...options,
      mode: 'developer-id',
    })).toThrow(/requires clean source provenance/)
  })

  // The provisional app is launched as a French and as a British user: only US
  // and British English ship (#292), so the first must fall back to en-US and
  // the second keep en-GB, in its renderers and in the dates its page formats.
  it('launches the provisional universal app in French and British English and checks each locale (#292)', () => {
    const workflow = readFileSync(join(root, '.github', 'workflows', 'macos-universal.yml'), 'utf8')
    const start = workflow.indexOf('- name: Mount, copy, launch, verify boundary, and remove portable runtime')
    const step = workflow.slice(start, workflow.indexOf('- uses:', start))
    const launch = step.slice(step.indexOf('launch_as() {'), step.indexOf('\n          }\n', step.indexOf('launch_as() {')))
    expect(launch).toContain('-AppleLanguages "($language)" --remote-debugging-port="$((port + 100))"')
    const boundary = launch.lastIndexOf("grep -qi '^x-agent-inbox-local-boundary: loopback-v1'")
    const renderers = launch.indexOf(`pgrep -lf -P "$APP_PID" -- '--type=renderer'`)
    const check = launch.indexOf('test "$locales" = "--lang=$expected"')
    const dates = launch.indexOf('node scripts/launch-locale-probe.mjs --devtools-port "$((port + 100))" --viewer-port "$port" --expect "$expected"')
    expect(renderers).toBeGreaterThan(boundary)
    expect(check).toBeGreaterThan(renderers)
    expect(dates).toBeGreaterThan(check)
    const french = step.indexOf('\n          launch_as fr 14319 en-US\n')
    const british = step.indexOf('\n          launch_as en-GB 14320 en-GB\n')
    expect(french).toBeGreaterThan(step.indexOf('\n          }\n'))
    expect(british).toBeGreaterThan(french)
    expect(step.indexOf('\n          kill "$APP_PID"\n', british)).toBeGreaterThan(british)
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    expect(pkg.scripts['package:smoke']).toContain('test/launch-locale-probe.test.ts')
  })

  it('pins release workflow actions and resolves Node from the central manifest', () => {
    const workflow = readFileSync(join(root, '.github', 'workflows', 'macos-universal.yml'), 'utf8')
    const refs = [...workflow.matchAll(/^\s*-\s+uses:\s+([^@\s]+)@([^\s#]+)(?:\s+#\s+(.+))?$/gm)]
    expect(refs.length).toBeGreaterThan(0)
    for (const [, action, ref, comment] of refs) {
      expect(action).toMatch(/^actions\//)
      expect(ref).toMatch(/^[0-9a-f]{40}$/)
      expect(comment).toMatch(/^v\d+\.\d+\.\d+$/)
    }
    expect(workflow).not.toMatch(/uses:\s+[^@\s]+@v\d+/)
    expect(workflow).not.toMatch(/node-version:\s+['"]?24(?:['"]?\s*$|\s+#)/m)
    expect(workflow).toContain('node scripts/release-inputs.mjs --node-version')
    expect(workflow).toContain('node-version: ${{ steps.release-inputs.outputs.node-version }}')
    expect(readFileSync(join(root, '.github', 'dependabot.yml'), 'utf8')).toContain('package-ecosystem: github-actions')
  })

  it('runs the universal package gate for every transitive native staging module', () => {
    const workflow = readFileSync(join(root, '.github', 'workflows', 'release-aggregate.yml'), 'utf8')
    const pullRequestTrigger = workflow.slice(
      workflow.indexOf('  pull_request:'),
      workflow.indexOf('\npermissions:'),
    )
    const stagingModules = new Set([
      ...transitiveLocalModules('scripts/stage-native-runtime.mjs'),
      ...transitiveLocalModules('scripts/stage-runtime.mjs'),
    ])
    for (const module of stagingModules) {
      expect(pullRequestTrigger, `${module} must trigger the universal package gate`)
        .toContain('      - "scripts/**"')
    }
    expect(stagingModules).toContain('scripts/setup-filesystem.cjs')
    expect(pullRequestTrigger).toContain('      - "scripts/**"')
  })

  it('runs the universal package gate for the complete Electron Setup require chain', () => {
    const workflow = readFileSync(join(root, '.github', 'workflows', 'release-aggregate.yml'), 'utf8')
    const pullRequestTrigger = workflow.slice(
      workflow.indexOf('  pull_request:'),
      workflow.indexOf('\npermissions:'),
    )
    const electronModules = transitiveCommonJsModules('electron/main.cjs')

    expect(electronModules).toContain('electron/setup-runner.cjs')
    expect(electronModules).toContain('electron/setup-core.cjs')
    expect(electronModules).toContain('electron/setup-process.cjs')
    expect(electronModules).toContain('electron/runtime-verify.cjs')
    expect(electronModules.every((module) => module.startsWith('electron/'))).toBe(true)
    expect(pullRequestTrigger).toContain('      - "electron/**"')
    const packageApp = readFileSync(join(root, 'scripts', 'package-app.sh'), 'utf8')
    const packageAppStage = readFileSync(join(root, 'scripts', 'package-app-stage.mjs'), 'utf8')
    const thinApp = readFileSync(join(root, 'scripts', 'build-thin-app.mjs'), 'utf8')
    expect(packageApp).toContain('"$ROOT/scripts/package-app-stage.mjs" stage "$ROOT" "$STAGE"')
    expect(packageAppStage).toContain('copyRequiredTree(repoRoot, stageRoot)')
    expect(thinApp).toContain("['dist', 'public', 'electron', 'release']")
  })

  it('keeps native staging adapter coverage in the package smoke gate', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    expect(pkg.scripts['package:smoke']).toContain('test/native-runtime-adapter.test.ts')
  })

  it('keeps the trusted Setup core in the package smoke gate', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    expect(pkg.scripts['package:smoke']).toContain('test/setup-core.test.ts')
  })

  it('keeps the fixed-purpose Setup process adapter in package smoke', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    expect(pkg.scripts['package:smoke']).toContain('test/setup-process.test.ts')
  })

  it('keeps the Setup filesystem adapter in payload verification and package smoke', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const verifier = readFileSync(join(root, 'electron', 'runtime-verify.cjs'), 'utf8')
    const staging = readFileSync(join(root, 'scripts', 'stage-runtime.mjs'), 'utf8')

    expect(pkg.scripts['package:smoke']).toContain('test/setup-filesystem.test.ts')
    expect(verifier).toContain("'scripts/setup-filesystem.cjs'")
    expect(staging).toContain("'setup-filesystem.cjs'")
  })

  it('retries busy Windows renames when building, never in the shipping installer (#333)', () => {
    const staging = readFileSync(join(root, 'scripts', 'stage-runtime.mjs'), 'utf8')
    const installer = readFileSync(join(root, 'scripts', 'runtime-payload.mjs'), 'utf8')
    const folder = readFileSync(join(root, 'scripts', 'build-windows-thin-app.mjs'), 'utf8')

    expect(staging).toContain('retryBusyRename: true,')
    expect(installer).not.toMatch(/retryBusyRename|renameWithRetry/)
    expect(folder).toContain('publishNewFolder(packaged, destination)')
  })

  it('keeps the rollback step helper the installer needs in payload verification and staging', () => {
    const verifier = readFileSync(join(root, 'electron', 'runtime-verify.cjs'), 'utf8')
    const staging = readFileSync(join(root, 'scripts', 'stage-runtime.mjs'), 'utf8')

    expect(verifier).toContain("'scripts/run-isolated.mjs'")
    expect(staging).toContain("'run-isolated.mjs'")
  })

  it('stages the runtime prune script into every payload, where its Setup target requires it (#294)', () => {
    const runner = readFileSync(join(root, 'electron', 'setup-runner.cjs'), 'utf8')
    const staging = readFileSync(join(root, 'scripts', 'stage-runtime.mjs'), 'utf8')

    expect(staging).toContain("'prune-runtimes.sh'")
    expect(runner).toContain("const PRUNE_REQUIRED_FILES = Object.freeze([...REQUIRED_FILES, 'scripts/prune-runtimes.sh'])")
    expect(runner).toContain("requiredFiles: request.target === 'prune-runtimes' ? PRUNE_REQUIRED_FILES : REQUIRED_FILES")
  })

  it('keeps the shared Setup lease in payload verification, package smoke, and native workflows', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const verifier = readFileSync(join(root, 'electron', 'runtime-verify.cjs'), 'utf8')
    const staging = readFileSync(join(root, 'scripts', 'stage-runtime.mjs'), 'utf8')
    const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')
    const aggregate = readFileSync(join(root, '.github', 'workflows', 'release-aggregate.yml'), 'utf8')
    const universal = readFileSync(join(root, '.github', 'workflows', 'macos-universal.yml'), 'utf8')
    const trigger = aggregate.slice(
      aggregate.indexOf('  pull_request:'),
      aggregate.indexOf('\npermissions:'),
    )

    expect(pkg.scripts['package:smoke']).toContain('test/setup-lock.test.ts')
    expect(verifier).toContain("'scripts/setup-lock.sh'")
    expect(staging).toContain("'setup-lock.sh'")
    expect(ci).toContain('os: [ubuntu-latest, macos-14]')
    expect(ci).toContain('brew install flock')
    expect(ci).toContain('npx vitest run test/setup-lock.test.ts')
    expect(universal).toContain('npx vitest run test/setup-lock.test.ts')
    expect(trigger).toContain('      - "scripts/**"')
    expect(trigger).toContain('      - "test/setup-*.test.ts"')
  })

  // Every workflow but ci.yml builds, signs or verifies a release (#315)
  const releaseWorkflows = (): { file: string, lines: string[] }[] => {
    const workflowsDir = join(root, '.github', 'workflows')
    return readdirSync(workflowsDir)
      .filter((name) => /\.ya?ml$/.test(name) && name !== 'ci.yml')
      .map((file) => ({ file, lines: readFileSync(join(workflowsDir, file), 'utf8').split(/\r?\n/) }))
  }
  const indentOf = (line: string): number => line.match(/^ */)?.[0].length ?? 0
  const isContent = (line: string): boolean => line.trim() !== '' && !line.trim().startsWith('#')

  it('restores no npm cache where a release is built, signed or verified (#315)', () => {
    // prebuild-install unpacks a restored <cache>/_prebuilds without checking a digest.
    // An explicit cache input wins over package-manager-cache: false, however it is
    // quoted, and that input defaults to true: setup-node then caches on its own once
    // package.json names npm as its package manager.
    type Step = { line: number, indent: number, lines: string[] }
    const workflowSteps = (lines: string[]): Step[] => {
      const steps: Step[] = []
      let stepsIndent = -1
      let current: Step | undefined
      for (const [index, line] of lines.entries()) {
        if (stepsIndent >= 0 && isContent(line) && indentOf(line) <= stepsIndent) {
          stepsIndent = -1
          current = undefined
        }
        if (/^\s*steps:\s*$/.test(line)) {
          stepsIndent = indentOf(line)
        } else if (stepsIndent >= 0 && /^\s*- /.test(line) && (!current || indentOf(line) === current.indent)) {
          current = { line: index + 1, indent: indentOf(line), lines: [line] }
          steps.push(current)
        } else if (current && (!isContent(line) || indentOf(line) > current.indent)) {
          current.lines.push(line)
        }
      }
      return steps
    }
    // The entries of a step's block-style with:, so a flow-style one fails the check below
    const inputs = (step: Step): string[] => {
      const at = step.lines.findIndex((line) => line.trim() === 'with:' && indentOf(line) === step.indent + 2)
      if (at < 0) return []
      const end = step.lines.findIndex((line, index) => index > at && isContent(line) && indentOf(line) <= step.indent + 2)
      return step.lines.slice(at + 1, end < 0 ? undefined : end).filter((line) => indentOf(line) === step.indent + 4)
    }
    const SETUP_NODE = /actions\/setup-node@/

    let setupNodes = 0
    for (const { file, lines } of releaseWorkflows()) {
      const checked = new Set<number>()
      for (const step of workflowSteps(lines)) {
        if (!step.lines.some((line) => isContent(line) && SETUP_NODE.test(line))) continue
        setupNodes += 1
        const where = `${file}:${step.line}`
        expect(inputs(step), `${where} must turn off setup-node's package-manager cache`)
          .toContain(`${' '.repeat(step.indent + 4)}package-manager-cache: false`)
        expect(inputs(step).filter((line) => /^\s*["']?cache[\w-]*["']?\s*:/.test(line)), `${where} must set no cache input`)
          .toEqual([])
        step.lines.forEach((_, offset) => checked.add(step.line + offset))
      }
      lines.forEach((line, index) => {
        if (!isContent(line)) return
        if (SETUP_NODE.test(line)) expect(checked.has(index + 1), `${file}:${index + 1} is outside any checked step`).toBe(true)
        expect(line, `${file}:${index + 1} must restore no cache`).not.toMatch(/\buses:\s*["']?actions\/cache\b/)
      })
    }
    expect(setupNodes).toBeGreaterThan(0)
  })

  it('compiles better-sqlite3 in every npm install where a release is built, signed or verified (#315)', () => {
    // Nothing from the checkout's own npm install ships, but scripts and tests load its
    // better-sqlite3 in jobs that build the release or hold the signing and notary
    // secrets. Set once for the whole workflow, the variable reaches every step and every
    // npm spelling (npm --prefix . ci, clean-install, ic, install-test and the rest). No
    // other line may name it, since a job or step env, a $GITHUB_ENV write, an unset or
    // an npm --build-from-source flag could turn it off. ci.yml keeps its prebuilds.
    const SETTING = '  npm_config_build_from_source: "true"'
    for (const { file, lines } of releaseWorkflows()) {
      const at = lines.indexOf('env:')
      const end = at < 0 ? -1 : lines.findIndex((line, index) => index > at && isContent(line) && indentOf(line) === 0)
      const topEnv = at < 0 ? [] : lines.slice(at + 1, end < 0 ? undefined : end)
      expect(topEnv, `${file} must set it in its top-level env`).toContain(SETTING)
      const setting = at + 1 + topEnv.indexOf(SETTING)
      lines.forEach((line, index) => {
        if (!isContent(line) || index === setting) return
        expect(line, `${file}:${index + 1} must not set or unset it again`).not.toMatch(/build[-_]?from[-_]?source/i)
      })
    }
    // An npm that stops passing the variable to install scripts fails the release run itself
    expect(readFileSync(join(root, '.github', 'workflows', 'macos-universal.yml'), 'utf8'))
      .toMatch(/^\s*- run: npx vitest run [^\n]*test\/app-dependencies\.test\.ts/m)
  })

  it('pins every repository workflow action and disables checkout credential persistence', () => {
    const workflowsDir = join(root, '.github', 'workflows')
    const workflowFiles = readdirSync(workflowsDir)
      .filter((file) => /\.ya?ml$/.test(file))
    let actionCount = 0
    let checkoutCount = 0

    expect(workflowFiles.length).toBeGreaterThan(0)
    for (const file of workflowFiles) {
      const lines = readFileSync(join(workflowsDir, file), 'utf8').split(/\r?\n/)
      for (const [index, line] of lines.entries()) {
        if (!/^\s*(?:-\s+)?uses:\s+actions\//.test(line)) continue
        actionCount += 1
        const match = line.match(
          /^(\s*)(-\s+)?uses:\s+(actions\/[^@\s]+)@([0-9a-f]{40})\s+#\s+(v\d+\.\d+\.\d+)\s*$/,
        )
        expect(match, `${file}:${index + 1} must pin the action with a version comment`).not.toBeNull()
        if (!match || match[3] !== 'actions/checkout') continue

        checkoutCount += 1
        expect(match[2], `${file}:${index + 1} checkout must be a workflow step`).toBe('- ')
        const stepIndent = match[1]?.length ?? 0
        const stepLines: string[] = []
        for (const following of lines.slice(index + 1)) {
          if (following.trim() && (following.match(/^\s*/)?.[0].length ?? 0) <= stepIndent) break
          stepLines.push(following)
        }
        expect(
          stepLines.some((following) =>
            following.trim() === 'persist-credentials: false'
            && (following.match(/^\s*/)?.[0].length ?? 0) === stepIndent + 4),
          `${file}:${index + 1} checkout must disable persisted credentials`,
        ).toBe(true)
      }
    }
    expect(actionCount).toBeGreaterThan(0)
    expect(checkoutCount).toBeGreaterThan(0)
  })

  it('publishes only checksummed transfer artifacts and never a raw app bundle', () => {
    const output = scratchDir('release-output-')
    for (const name of [
      'app.tar.gz',
      'provisional.dmg',
      'report.json',
      'metadata.json',
      'macos-inputs.json',
      'SHA256SUMS',
      'SHA256SUMS.json',
    ]) {
      writeFileSync(join(output, name), name)
    }
    const allowed = readdirSync(output)
    expect(assertPublishedEntries(output, allowed)).toEqual([...allowed].sort())
    mkdirSync(join(output, 'Agent Inbox.app'))
    expect(() => assertPublishedEntries(output, allowed)).toThrow(/allowlist|raw app bundle/)
  })
})
