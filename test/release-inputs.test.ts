import { readFileSync, writeFileSync } from 'node:fs'
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
import { scratchDir } from './scratch.js'

describe('macOS release inputs', () => {
  it('pins the exact Node and Electron release contract in one validated manifest', () => {
    const inputs = loadReleaseInputs()
    expect(inputs.node.version).toBe('v24.22.1')
    expect(inputs.node.modulesAbi).toBe('137')
    expect(inputs.minimumMacosVersion).toBe('13.5')
    expect(RUNTIME_KEYS).toBe(MACOS_RUNTIME_KEYS)
    expect(RUNTIME_KEYS).toEqual(['darwin-arm64', 'darwin-x64'])
    expect(Object.keys(inputs.node.distributions)).toEqual(RUNTIME_KEYS)
    expect(inputs.node.distributions['darwin-arm64'].sha256)
      .toBe('654ba79de6155647e22321932b45f2a1ccb705976cc337c9b8e278beb085a628')
    expect(inputs.node.distributions['darwin-x64'].sha256)
      .toBe('65e450f90a6eaacd5000f611861c4ce65fadc87f813795dc4ed0c0e5f2fca2d4')
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
