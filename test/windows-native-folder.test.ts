import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTreeArchive } from '../scripts/archive-tree.mjs'
import { buildWindowsThinApp, publishNewFolder } from '../scripts/build-windows-thin-app.mjs'
import { nativeRuntimeAdapterFor } from '../scripts/native-runtime-adapter.mjs'
import { downloadArchive } from '../scripts/release-inputs.mjs'
import { buildManifest, writeManifestFile } from '../scripts/runtime-payload.mjs'
import { provisionWindowsNodeHeaders } from '../scripts/stage-native-runtime.mjs'
import { verifyWindowsSetupMetadata } from '../scripts/verify-windows-thin-app.mjs'
import { removeScratchDirs, scratchDir } from './scratch.js'

const root = resolve(process.cwd())

function icoEntries(path: string): Array<{ width: number; height: number; size: number; offset: number }> {
  const bytes = readFileSync(path)
  expect(bytes.readUInt16LE(0)).toBe(0)
  expect(bytes.readUInt16LE(2)).toBe(1)
  const count = bytes.readUInt16LE(4)
  const entries = []
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16
    entries.push({
      width: bytes[offset] === 0 ? 256 : bytes[offset]!,
      height: bytes[offset + 1] === 0 ? 256 : bytes[offset + 1]!,
      size: bytes.readUInt32LE(offset + 8),
      offset: bytes.readUInt32LE(offset + 12),
    })
  }
  return entries
}

describe('native Windows x64 folder foundation', () => {
  it.runIf(process.platform !== 'win32' || process.arch !== 'x64')(
    'refuses non-native builds before reading runtime or repository paths',
    async () => {
      const unreachable = join(root, 'build', 'must-not-be-read')
      await expect(buildWindowsThinApp({
        runtime: join(unreachable, 'runtime'),
        output: join(unreachable, 'output'),
        repoRoot: join(unreachable, 'repo'),
      })).rejects.toThrow(/must be built natively on win32\/x64/)
    },
  )

  it('keeps the Windows folder builder installer-free and Setup disabled', () => {
    const build = readFileSync(join(root, 'scripts', 'build-windows-thin-app.mjs'), 'utf8')
    const verify = readFileSync(join(root, 'scripts', 'verify-windows-thin-app.mjs'), 'utf8')
    const targets = readFileSync(join(root, 'electron', 'runtime-targets.cjs'), 'utf8')
    const runner = readFileSync(join(root, 'electron', 'setup-runner.cjs'), 'utf8')
    const processAdapter = readFileSync(join(root, 'electron', 'setup-process.cjs'), 'utf8')

    expect(build).toContain("platform: 'win32'")
    expect(build).toContain("'--runtime-key', key")
    // The stage installs and compiles only through the hardened step (#315).
    expect(build).toContain('await installAppDependencies({')
    expect(build).not.toMatch(/'ci', '--omit=dev'|await rebuild\(|@electron\/rebuild/)
    expect(build).toContain("icon: join(repoRoot, 'electron', 'icon.ico')")
    expect(build).not.toMatch(/WiX|Squirrel|electron-forge|portable\.zip/i)
    expect(verify).toContain("reason !== 'unsupported-platform'")
    expect(verify).toContain('setupAvailable: false')
    expect(verify).toContain('verifyPackagedUpdateTrust(resources)')
    expect(verify).toContain('runElectronSqliteCheck({')
    expect(verify).toContain("electronSqliteCheck: 'passed'")
    expect(targets).toContain("'win32-x64'")
    expect(targets).toContain('const POSIX_SETUP_RUNTIME_KEYS')
    expect(runner).toContain('const RUNTIME_KEYS = new Set(POSIX_SETUP_RUNTIME_KEYS)')
    expect(processAdapter).toContain("const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux'])")
  })

  it('ships a deterministic Windows icon with required PNG representations', () => {
    const entries = icoEntries(join(root, 'electron', 'icon.ico'))
    expect(entries.map(({ width, height }) => [width, height])).toEqual([
      [16, 16],
      [32, 32],
      [256, 256],
    ])
    const bytes = readFileSync(join(root, 'electron', 'icon.ico'))
    for (const entry of entries) {
      expect(entry.size).toBeGreaterThan(0)
      expect(entry.offset + entry.size).toBeLessThanOrEqual(bytes.length)
      expect([...bytes.subarray(entry.offset, entry.offset + 8)]).toEqual([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ])
    }
  })

  it('keeps the Windows package foundation in package smoke', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    for (const test of [
      'test/windows-release-inputs.test.ts',
      'test/windows-binary-gates.test.ts',
      'test/windows-native-folder.test.ts',
      'test/windows-release-workflow.test.ts',
      'test/windows-roundtrip.test.ts',
    ]) {
      expect(pkg.scripts['package:smoke']).toContain(test)
    }
  })
})

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

// The real Windows adapter on Windows; elsewhere the same list/extract flags on the host's
// tar, which detects gzip by itself exactly as Windows' bsdtar does.
const headersAdapter = process.platform === 'win32'
  ? nativeRuntimeAdapterFor('win32-x64')
  : { archiveExecutable: '/usr/bin/tar', archiveListFlags: ['-tf'], archiveExtractFlags: ['-xf'] }

function headersFixture(archiveRoot = 'node-v24.18.1') {
  const root = scratchDir('windows-node-headers-')
  const include = join(root, 'source', archiveRoot, 'include', 'node')
  mkdirSync(include, { recursive: true })
  for (const name of ['common.gypi', 'config.gypi', 'node_version.h']) {
    writeFileSync(join(include, name), `${name}\n`)
  }
  const archive = createTreeArchive({
    source: join(root, 'source', archiveRoot),
    archive: join(root, 'served', 'node-v24.18.1-headers.tar.gz'),
  })
  const library = join(root, 'served', 'node.lib')
  writeFileSync(library, 'import library\n')
  const workDir = join(root, 'extract')
  const nodeRoot = join(workDir, 'node-v24.18.1-win-x64')
  mkdirSync(nodeRoot, { recursive: true })
  writeFileSync(join(nodeRoot, 'node.exe'), 'node\n')
  const headers = {
    archive: 'node-v24.18.1-headers.tar.gz',
    root: 'node-v24.18.1',
    url: 'https://nodejs.org/dist/v24.18.1/node-v24.18.1-headers.tar.gz',
    sha256: sha256(archive),
    importLibraries: {
      'win32-x64': {
        url: 'https://nodejs.org/dist/v24.18.1/win-x64/node.lib',
        sha256: sha256(library),
      },
    },
  }
  const served = new Map([[headers.url, archive], [headers.importLibraries['win32-x64'].url, library]])
  const requested: string[] = []
  const download = (options: { url: string; destination: string; expectedSha256: string }) => downloadArchive({
    ...options,
    fetchImpl: async (url: string | URL | Request) => {
      requested.push(String(url))
      return new Response(readFileSync(served.get(String(url))!))
    },
  })
  const provision = () => provisionWindowsNodeHeaders({
    headers,
    key: 'win32-x64',
    adapter: headersAdapter,
    nodeRoot,
    workDir,
    cacheRoot: join(root, 'cache'),
    download,
  })
  return { headers, library, nodeRoot, requested, provision }
}

describe('verified Node headers for native Windows staging (#135)', () => {
  afterEach(removeScratchDirs)

  it('adds the pinned headers and import library where node-gyp reads --nodedir', async () => {
    const f = headersFixture()
    await expect(f.provision()).resolves.toEqual({
      headers: {
        archive: f.headers.archive,
        root: f.headers.root,
        url: f.headers.url,
        sha256: f.headers.sha256,
      },
      importLibrary: f.headers.importLibraries['win32-x64'],
    })
    expect(f.requested).toEqual([f.headers.url, f.headers.importLibraries['win32-x64'].url])
    expect(readFileSync(join(f.nodeRoot, 'include', 'node', 'common.gypi'), 'utf8')).toBe('common.gypi\n')
    expect(readFileSync(join(f.nodeRoot, 'Release', 'node.lib'))).toEqual(readFileSync(f.library))
  })

  it('refuses a substituted headers tarball before changing the distribution', async () => {
    const f = headersFixture()
    f.headers.sha256 = '0'.repeat(64)
    await expect(f.provision()).rejects.toThrow(/SHA-256 mismatch/)
    expect(existsSync(join(f.nodeRoot, 'include'))).toBe(false)
    expect(existsSync(join(f.nodeRoot, 'Release'))).toBe(false)
  })

  it('refuses headers from another release root before extracting them', async () => {
    const f = headersFixture('node-v24.19.0')
    await expect(f.provision()).rejects.toThrow(/outside node-v24\.18\.1/)
    expect(existsSync(join(f.nodeRoot, 'include'))).toBe(false)
    expect(f.requested).toEqual([f.headers.url])
  })

  it('never mixes headers into a distribution that already carries include/', async () => {
    const f = headersFixture()
    mkdirSync(join(f.nodeRoot, 'include'))
    await expect(f.provision()).rejects.toThrow(/already contains include/)
    expect(f.requested).toEqual([])
  })
})

// What a release folder's resources/app holds for Setup: the metadata and the
// runtime it names, with every file Setup's payload verification requires.
function setupMetadataFixture() {
  const resources = scratchDir('windows-setup-metadata-')
  const runtime = join(resources, 'runtime', 'win32-x64')
  for (const file of [
    'node.exe',
    'dist/mcp-server.js',
    'dist/hook-cli.js',
    'dist/watch-cli.js',
    'scripts/install-agents.sh',
    'scripts/runtime-payload.mjs',
    'scripts/runtime-config.mjs',
    'scripts/setup-filesystem.cjs',
    'scripts/setup-lock.sh',
    'scripts/run-isolated.mjs',
  ]) {
    mkdirSync(join(runtime, file, '..'), { recursive: true })
    writeFileSync(join(runtime, file), `${file}\n`)
  }
  writeManifestFile(runtime, buildManifest({
    root: runtime,
    product: 'agent-inbox-runtime',
    packageVersion: '1.5.0',
    sourceCommit: 'a'.repeat(40),
    platform: 'win32',
    arch: 'x64',
    nodeVersion: 'v24.18.1',
    nodeModulesAbi: '137',
    entrypoints: ['dist/mcp-server.js', 'dist/hook-cli.js', 'dist/watch-cli.js'],
  }))
  const digest = `sha256:${sha256(join(runtime, 'runtime-manifest.json'))}`
  const info = {
    schema: 2,
    version: '1.5.0',
    runtimePayloads: { 'win32-x64': { path: 'runtime/win32-x64', digest } },
  }
  const write = (change: (payload: { path: string; digest: string }) => void = () => {}) => {
    const edited = structuredClone(info)
    change(edited.runtimePayloads['win32-x64'])
    writeFileSync(join(resources, 'setup-info.json'), `${JSON.stringify(edited, null, 2)}\n`)
  }
  write()
  return { resources, runtime, digest, write }
}

describe('Windows setup metadata against the embedded runtime', () => {
  afterEach(removeScratchDirs)

  it('accepts metadata that names the embedded runtime and its manifest digest', () => {
    const f = setupMetadataFixture()
    expect(verifyWindowsSetupMetadata({ resources: f.resources })).toMatchObject({
      setupKeys: ['win32-x64'],
      runtimeManifestDigest: f.digest,
    })
  })

  it('rejects any other payload path', () => {
    const f = setupMetadataFixture()
    for (const path of ['runtime/x', 'runtime/win32-x64/', './runtime/win32-x64']) {
      f.write((payload) => { payload.path = path })
      expect(() => verifyWindowsSetupMetadata({ resources: f.resources }), path)
        .toThrow(/must place win32-x64 at runtime\/win32-x64/)
    }
  })

  it('rejects a digest that is not the embedded runtime manifest\'s', () => {
    const f = setupMetadataFixture()
    f.write((payload) => { payload.digest = `sha256:${'0'.repeat(64)}` })
    expect(() => verifyWindowsSetupMetadata({ resources: f.resources }))
      .toThrow(/does not match the embedded win32-x64 runtime: .*digest/)
    f.write((payload) => { payload.digest = payload.digest.toUpperCase().replace('SHA256:', 'sha256:') })
    expect(() => verifyWindowsSetupMetadata({ resources: f.resources })).toThrow(/digest must be exactly sha256:/)
  })

  it('rejects an embedded runtime that no longer matches its manifest', () => {
    const f = setupMetadataFixture()
    writeFileSync(join(f.runtime, 'dist', 'hook-cli.js'), 'tampered\n')
    expect(() => verifyWindowsSetupMetadata({ resources: f.resources }))
      .toThrow(/does not match the embedded win32-x64 runtime: .*mismatch/)
  })
})

// #333: the folder checks run its Electron and runtime node.exe just before it
// is renamed into place, and Windows refuses that rename while anything in it
// is still open.
describe('publishing the packaged Windows folder', () => {
  afterEach(removeScratchDirs)

  function packaged(): { source: string; destination: string } {
    const work = scratchDir('windows-thin-publish-')
    const source = join(work, 'packager', 'Agent Inbox-win32-x64')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'Agent Inbox.exe'), 'electron\n')
    return { source, destination: join(work, 'thin', 'win32-x64', 'Agent Inbox') }
  }

  function refusing(refusals: number, onRefusal: () => void = () => {}) {
    const renames: string[] = []
    return {
      renames,
      rename(from: string, to: string) {
        renames.push(from)
        if (renames.length > 100) throw new Error('rename retried without end')
        if (renames.length <= refusals) {
          onRefusal()
          throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}'`), { code: 'EPERM' })
        }
        renameSync(from, to)
      },
    }
  }

  it('publishes on Windows once the rename stops being refused', () => {
    const { source, destination } = packaged()
    const { rename, renames } = refusing(2)
    const waits: number[] = []

    publishNewFolder(source, destination, { platform: 'win32', rename, sleep: (ms) => { waits.push(ms) } })

    expect(readFileSync(join(destination, 'Agent Inbox.exe'), 'utf8')).toBe('electron\n')
    expect(existsSync(source)).toBe(false)
    expect(renames).toHaveLength(3)
    expect(waits).toHaveLength(2)
  })

  it.each(['linux', 'darwin'] as const)('fails at once on %s', (platform) => {
    const { source, destination } = packaged()
    const { rename, renames } = refusing(1)

    expect(() => publishNewFolder(source, destination, { platform, rename, sleep() {} })).toThrow(/EPERM/)
    expect(renames).toHaveLength(1)
    expect(existsSync(join(source, 'Agent Inbox.exe'))).toBe(true)
  })

  it('refuses an output that appeared between attempts instead of retrying into it', () => {
    const { source, destination } = packaged()
    const { rename, renames } = refusing(1, () => {
      mkdirSync(destination)
      writeFileSync(join(destination, 'other.txt'), 'someone else\n')
    })

    expect(() => publishNewFolder(source, destination, { platform: 'win32', rename, sleep() {} }))
      .toThrow(/output already exists/)
    expect(renames).toHaveLength(1)
    expect(readdirSync(destination)).toEqual(['other.txt'])
    expect(existsSync(join(source, 'Agent Inbox.exe'))).toBe(true)
  })
})
