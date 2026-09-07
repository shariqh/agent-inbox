import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RELEASE_INPUTS,
  MACOS_RUNTIME_KEYS,
  ReleaseInputError,
  RUNTIME_KEYS,
  downloadArchive,
  loadReleaseInputs,
  validateReleaseInputs,
  validateInstalledReleaseTools,
  verifyArchiveDigest,
} from '../scripts/release-inputs.mjs'

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
      version: '43.1.1',
      packagerVersion: '20.3.0',
      rebuildVersion: '4.2.0',
      universalVersion: '3.0.6',
      osxSignVersion: '2.6.0',
      dmgVersion: '5.0.1',
    })
    expect(readFileSync(DEFAULT_RELEASE_INPUTS, 'utf8')).not.toContain('latest')
    expect(validateInstalledReleaseTools(inputs, resolve(process.cwd()))).toBe(inputs)
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
    const archive = join(mkdtempSync(join(tmpdir(), 'release-input-')), 'node.tar.xz')
    writeFileSync(archive, 'not the official archive')
    expect(() => verifyArchiveDigest(archive, '0'.repeat(64))).toThrow(/SHA-256 mismatch/)
  })

  it('removes partial output when a network download fails', async () => {
    const destination = join(mkdtempSync(join(tmpdir(), 'release-download-')), 'node.tar.xz')
    await expect(downloadArchive({
      url: 'https://nodejs.invalid/node.tar.xz',
      destination,
      expectedSha256: '0'.repeat(64),
      fetchImpl: async () => { throw new Error('offline') },
    })).rejects.toThrow(ReleaseInputError)
    expect(() => readFileSync(destination)).toThrow()
  })
})
