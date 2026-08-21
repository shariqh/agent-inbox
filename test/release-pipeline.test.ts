import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeUniversalApp } from '@electron/universal'
import { copyElectronNotices } from '../scripts/build-thin-app.mjs'
import {
  extractTreeArchive,
  createTreeArchive,
  validateArchiveEntries as validateTreeArchiveEntries,
} from '../scripts/archive-tree.mjs'
import {
  MacReleaseError,
  UNIVERSAL_RUNTIME_GLOB,
  assertPublishedEntries,
  releaseDisposition,
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
  })

  it('binds CI provenance to checkout HEAD and records local dirty state', () => {
    const repo = mkdtempSync(join(tmpdir(), 'release-provenance-'))
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
    const temp = mkdtempSync(join(tmpdir(), 'release-license-'))
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
    const temp = mkdtempSync(join(tmpdir(), 'electron-notices-'))
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
    const temp = mkdtempSync(join(tmpdir(), 'release-archive-'))
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
    const temp = mkdtempSync(join(tmpdir(), 'release-extract-'))
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

  it('removes architecture-only rebuild caches before universal merging', () => {
    const source = readFileSync(join(root, 'scripts', 'build-thin-app.mjs'), 'utf8')
    expect(source).toContain("rmSync(join(moduleRoot, 'bin')")
    expect(source).toContain("finalAddon = join(buildRoot, 'Release', 'better_sqlite3.node')")
    expect(source.indexOf('pruneNativeAddonBuildArtifacts(stageRoot)'))
      .toBeLessThan(source.indexOf('const packagerOut'))
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
    const temp = mkdtempSync(join(tmpdir(), 'universal-fixture-'))
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
      electron: '43.1.1',
      'electron-installer-dmg': '5.0.1',
    })
  })

  it('keeps the MCP handshake version aligned with the package release version', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const mcp = readFileSync(join(root, 'src', 'mcp.ts'), 'utf8')
    expect(pkg.version).toBe('1.0.1')
    expect(mcp).toContain(`new McpServer({ name: 'agent-inbox', version: '${pkg.version}' })`)
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
    const temp = mkdtempSync(join(tmpdir(), 'thin-provenance-'))
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
    const thinApp = readFileSync(join(root, 'scripts', 'build-thin-app.mjs'), 'utf8')
    expect(packageApp).toContain('"$ROOT/electron"')
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
    const output = mkdtempSync(join(tmpdir(), 'release-output-'))
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
