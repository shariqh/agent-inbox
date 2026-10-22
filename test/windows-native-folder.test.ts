import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTreeArchive } from '../scripts/archive-tree.mjs'
import { buildWindowsThinApp } from '../scripts/build-windows-thin-app.mjs'
import { nativeRuntimeAdapterFor } from '../scripts/native-runtime-adapter.mjs'
import { downloadArchive } from '../scripts/release-inputs.mjs'
import { provisionWindowsNodeHeaders } from '../scripts/stage-native-runtime.mjs'
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

