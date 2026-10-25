import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { crc32 } from 'node:zlib'
import { packager } from '@electron/packager'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_RELEASE_INPUTS,
  MACOS_RUNTIME_KEYS,
  ReleaseInputError,
  RUNTIME_KEYS,
  downloadArchive,
  loadElectronChecksums,
  loadReleaseInputs,
  validateReleaseInputs,
  validateInstalledReleaseTools,
  verifyArchiveDigest,
} from '../scripts/release-inputs.mjs'
import { loadLinuxReleaseInputs } from '../scripts/linux-release-inputs.mjs'
import { loadWindowsReleaseInputs } from '../scripts/windows-release-inputs.mjs'
import { RUNTIME_TARGETS } from '../scripts/runtime-targets.mjs'
import { removeScratchDirs, scratchDir } from './scratch.js'

afterEach(() => removeScratchDirs())

describe('macOS release inputs', () => {
  it('pins the exact Node and Electron release contract in one validated manifest', () => {
    const inputs = loadReleaseInputs()
    expect(inputs.node.version).toBe('v24.18.1')
    expect(inputs.node.modulesAbi).toBe('137')
    expect(inputs.minimumMacosVersion).toBe('13.5')
    expect(RUNTIME_KEYS).toBe(MACOS_RUNTIME_KEYS)
    expect(RUNTIME_KEYS).toEqual(['darwin-arm64', 'darwin-x64'])
    expect(Object.keys(inputs.node.distributions)).toEqual(RUNTIME_KEYS)
    expect(inputs.node.distributions['darwin-arm64'].sha256)
      .toBe('1d60b703fe5d7e7072489be8187f430f1a095a658c31e5e1e281331a5873fac3')
    expect(inputs.node.distributions['darwin-x64'].sha256)
      .toBe('f892c7895720f40d3750bde24f3554242d36f23602b5167b5b73ec4d13938aef')
    expect(inputs.electron).toEqual({
      version: '43.8.3',
      packagerVersion: '20.3.0',
      rebuildVersion: '4.2.0',
      universalVersion: '3.0.6',
      osxSignVersion: '2.6.0',
      dmgVersion: '5.0.1',
    })
    expect(readFileSync(DEFAULT_RELEASE_INPUTS, 'utf8')).not.toContain('latest')
    expect(validateInstalledReleaseTools(inputs, resolve(process.cwd()))).toBe(inputs)
  })

  it('commits the expected macOS CPU types, the only input that sets the release kind (#341)', () => {
    expect(loadReleaseInputs().macosArchitectures).toEqual(['arm64', 'x86_64'])
    const arm64 = structuredClone(loadReleaseInputs())
    arm64.macosArchitectures = ['arm64']
    expect(validateReleaseInputs(arm64).macosArchitectures).toEqual(['arm64'])
    for (const architectures of [['x86_64'], ['x86_64', 'arm64'], ['arm64', 'arm64'], [], 'arm64', null]) {
      const invalid: Record<string, unknown> = structuredClone(loadReleaseInputs())
      invalid.macosArchitectures = architectures
      expect(() => validateReleaseInputs(invalid), JSON.stringify(architectures)).toThrow(/macosArchitectures/)
    }
    const missing: Record<string, unknown> = structuredClone(loadReleaseInputs())
    delete missing.macosArchitectures
    expect(() => validateReleaseInputs(missing)).toThrow(/keys must be exactly: .*macosArchitectures/)
  })

  it('rejects release-tool drift from the authoritative manifest', () => {
    const inputs = structuredClone(loadReleaseInputs())
    inputs.electron.universalVersion = '3.0.5'
    expect(() => validateInstalledReleaseTools(inputs, resolve(process.cwd())))
      .toThrow(/@electron\/universal version mismatch/)
  })

  it('rejects partial architecture maps and unofficial URLs', () => {
    const inputs = JSON.parse(JSON.stringify(loadReleaseInputs()))
    delete inputs.node.distributions['darwin-x64']
    expect(() => validateReleaseInputs(inputs)).toThrow(/exactly.*darwin-arm64, darwin-x64/)

    const other = structuredClone(loadReleaseInputs())
    other.node.distributions['darwin-arm64'].url = 'https://example.com/node.tar.xz'
    expect(() => validateReleaseInputs(other)).toThrow(/official Node distribution URL/)
  })

  it('fails closed on a pinned archive hash mismatch', () => {
    const archive = join(scratchDir('release-input-'), 'node.tar.xz')
    writeFileSync(archive, 'not the official archive')
    expect(() => verifyArchiveDigest(archive, '0'.repeat(64))).toThrow(/SHA-256 mismatch/)
  })

  it('removes partial output when a network download fails', async () => {
    const destination = join(scratchDir('release-download-'), 'node.tar.xz')
    await expect(downloadArchive({
      url: 'https://nodejs.invalid/node.tar.xz',
      destination,
      expectedSha256: '0'.repeat(64),
      fetchImpl: async () => { throw new Error('offline') },
    })).rejects.toThrow(ReleaseInputError)
    expect(() => readFileSync(destination)).toThrow()
  })
})

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

// A stored (uncompressed) zip: enough of an Electron release zip for the
// packager to unpack it and rename its `electron` executable.
function storedZip(files: Record<string, string>): Buffer {
  const entries: Buffer[] = []
  const directory: Buffer[] = []
  let offset = 0
  for (const [path, text] of Object.entries(files)) {
    const name = Buffer.from(path)
    const data = Buffer.from(text)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x031e, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((0o100755 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    entries.push(local, name, data)
    directory.push(central, name)
    offset += local.length + name.length + data.length
  }
  const count = Object.keys(files).length
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(count, 8)
  end.writeUInt16LE(count, 10)
  end.writeUInt32LE(directory.reduce((size, part) => size + part.length, 0), 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...entries, ...directory, end])
}

function installedElectron(files: Record<string, string>): string {
  const repoRoot = scratchDir('electron-package-')
  const electron = join(repoRoot, 'node_modules', 'electron')
  mkdirSync(electron, { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(electron, name), text)
  return repoRoot
}

describe('Electron zip checksums (#363)', () => {
  const repoRoot = resolve(process.cwd())
  const electronVersionFor = {
    darwin: () => loadReleaseInputs().electron.version,
    linux: () => loadLinuxReleaseInputs().electron.version,
    win32: () => loadWindowsReleaseInputs().electron.version,
  }

  it('reads the lockfile-pinned checksums.json of exactly the release Electron, with a hash for every packaged zip', () => {
    const file = JSON.parse(readFileSync(join(repoRoot, 'node_modules', 'electron', 'checksums.json'), 'utf8'))
    const targets = Object.values(RUNTIME_TARGETS)
    expect(targets.map((target) => target.key).sort())
      .toEqual(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'])
    for (const { key, platform, arch } of targets) {
      const version = electronVersionFor[platform]()
      const checksums = loadElectronChecksums({ version, platform, arch, repoRoot })
      expect(checksums, key).toEqual(file)
      expect(checksums[`electron-v${version}-${platform}-${arch}.zip`], key).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('refuses an electron package that is missing or not exactly the release version', () => {
    const checksums = JSON.stringify({ 'electron-v43.8.3-linux-x64.zip': 'a'.repeat(64) })
    const load = (root: string) => () =>
      loadElectronChecksums({ version: '43.8.3', platform: 'linux', arch: 'x64', repoRoot: root })
    for (const pkg of [{ name: 'electron', version: '43.8.2' }, { name: 'electron-nightly', version: '43.8.3' }]) {
      const root = installedElectron({ 'package.json': JSON.stringify(pkg), 'checksums.json': checksums })
      expect(load(root), pkg.name).toThrow(ReleaseInputError)
      expect(load(root), pkg.name).toThrow(`node_modules/electron is ${pkg.name}@${pkg.version}, not electron@43.8.3`)
    }
    const missing = installedElectron({ 'checksums.json': checksums })
    expect(load(missing)).toThrow(ReleaseInputError)
    expect(load(missing)).toThrow(/could not read node_modules\/electron\/package\.json/)
  })

  it('refuses a missing or malformed checksums.json, or one without the packaged zip', () => {
    const zip = 'electron-v43.8.3-linux-x64.zip'
    const digest = 'a'.repeat(64)
    const cases: Array<[string | undefined, RegExp]> = [
      [undefined, /could not read node_modules\/electron\/checksums\.json/],
      [`{"${zip}": `, /could not read node_modules\/electron\/checksums\.json/],
      ['null', /must map file names to SHA-256 digests/],
      [JSON.stringify([digest]), /must map file names to SHA-256 digests/],
      ['{}', /must map file names to SHA-256 digests/],
      [JSON.stringify({ [zip]: digest.toUpperCase() }), /malformed entry/],
      [JSON.stringify({ [zip]: digest.slice(1) }), /malformed entry/],
      [JSON.stringify({ [zip]: 1 }), /malformed entry/],
      [JSON.stringify({ [zip]: digest, [`x\n${digest} *${zip}`]: digest }), /malformed entry/],
      [JSON.stringify({ 'electron-v43.8.3-linux-arm64.zip': digest }), /has no SHA-256 for electron-v43\.8\.3-linux-x64\.zip/],
    ]
    for (const [checksums, error] of cases) {
      const files: Record<string, string> = { 'package.json': JSON.stringify({ name: 'electron', version: '43.8.3' }) }
      if (checksums !== undefined) files['checksums.json'] = checksums
      const root = installedElectron(files)
      const load = () => loadElectronChecksums({ version: '43.8.3', platform: 'linux', arch: 'x64', repoRoot: root })
      expect(load, String(checksums)).toThrow(ReleaseInputError)
      expect(load, String(checksums)).toThrow(error)
    }
  })

  it('has the packager check its Electron zip against that map instead of the release SHASUMS256.txt, and refuse a mismatch', async () => {
    const work = scratchDir('electron-zip-')
    const version = electronVersionFor.linux()
    const zipName = `electron-v${version}-linux-x64.zip`
    const zip = storedZip({ electron: '#!/bin/sh\n', LICENSE: 'not Electron\n' })
    // A replaced release: its zip is not the reviewed one, and its SHASUMS256.txt was replaced to match.
    const requested: string[] = []
    const downloader = {
      async download(url: string, target: string) {
        requested.push(url)
        writeFileSync(target, url.endsWith('/SHASUMS256.txt') ? `${sha256(zip)} *${zipName}\n` : zip)
      },
    }
    const app = join(work, 'app')
    mkdirSync(app)
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', main: 'index.js' }))
    writeFileSync(join(app, 'index.js'), '\n')
    // The thin-app builders' call, with the fake download and everything else kept in the scratch folder.
    const pack = (run: string, checksums?: Record<string, string>) => {
      requested.length = 0
      const scratch = join(work, run)
      mkdirSync(scratch)
      return packager({
        dir: app,
        name: 'Fixture',
        platform: 'linux',
        arch: 'x64',
        electronVersion: version,
        out: join(scratch, 'out'),
        tmpdir: scratch,
        overwrite: true,
        asar: false,
        junk: false,
        prune: false,
        quiet: true,
        download: { ...(checksums && { checksums }), downloader, cacheRoot: join(scratch, 'cache'), tempDirectory: scratch },
      })
    }
    const zipOnly = [expect.stringMatching(new RegExp(`/${zipName.replaceAll('.', '\\.')}$`))]

    const pinned = loadElectronChecksums({ version, platform: 'linux', arch: 'x64', repoRoot })
    await expect(pack('pinned', pinned))
      .rejects.toThrow(`Generated checksum for "${zipName}" did not match expected checksum.`)
    expect(requested).toEqual(zipOnly)

    const digest = sha256(zip)
    const [packaged] = await pack('matching', { ...pinned, [zipName]: digest })
    expect(readdirSync(packaged!)).toContain('Fixture')
    expect(requested).toEqual(zipOnly)

    const corrupted = `${digest.slice(0, -1)}${digest.endsWith('0') ? '1' : '0'}`
    await expect(pack('corrupted', { ...pinned, [zipName]: corrupted }))
      .rejects.toThrow(`Generated checksum for "${zipName}" did not match expected checksum.`)
    expect(requested).toEqual(zipOnly)
    expect(existsSync(join(work, 'corrupted', 'out'))).toBe(false)

    // Before #363 nothing passed a map: the release's own SHASUMS256.txt vouched for the replaced zip.
    await expect(pack('unpinned')).resolves.toHaveLength(1)
    expect(requested.map((url) => url.slice(url.lastIndexOf('/') + 1))).toEqual([zipName, 'SHASUMS256.txt'])
  })
})
