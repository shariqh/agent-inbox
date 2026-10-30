import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LINUX_COMPILER_PROBE_TIMEOUT_MS,
  DEFAULT_LINUX_RELEASE_INPUTS,
  LINUX_RUNTIME_KEYS,
  loadLinuxReleaseInputs,
  validateInstalledLinuxReleaseTools,
  validateLinuxReleaseInputs,
} from '../scripts/linux-release-inputs.mjs'

describe('Linux release inputs', () => {
  it('keeps native compiler identity probes bounded for hosted arm64 startup latency', () => {
    expect(LINUX_COMPILER_PROBE_TIMEOUT_MS).toBe(30_000)
  })
  it('pins the exact native Linux Node, Electron, ABI, and support contract', () => {
    const inputs = loadLinuxReleaseInputs()
    expect(LINUX_RUNTIME_KEYS).toEqual(['linux-arm64', 'linux-x64'])
    expect(Object.keys(inputs.node.distributions)).toEqual(LINUX_RUNTIME_KEYS)
    expect(inputs).toMatchObject({
      schema: 1,
      product: 'Agent Inbox',
      bundleId: 'io.github.shariqh.agent-inbox',
      minimumKernelVersion: '4.18',
      minimumGlibcVersion: '2.34',
      minimumLibstdcxxVersion: '6.0.29',
      maximumGlibcxxVersion: '3.4.29',
      distributionFloor: {
        ubuntu: '22.04',
        debian: '12',
        rhel: '9',
      },
      compiler: {
        family: 'clang',
        version: '15.0.7',
        cc: 'clang-15',
        cxx: 'clang++-15',
      },
      node: {
        version: 'v24.22.1',
        modulesAbi: '137',
        distributions: {
          'linux-arm64': {
            platform: 'linux',
            arch: 'arm64',
            archive: 'node-v24.22.1-linux-arm64.tar.xz',
            root: 'node-v24.22.1-linux-arm64',
            url: 'https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-arm64.tar.xz',
            sha256: 'dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e',
          },
          'linux-x64': {
            platform: 'linux',
            arch: 'x64',
            archive: 'node-v24.22.1-linux-x64.tar.xz',
            root: 'node-v24.22.1-linux-x64',
            url: 'https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.xz',
            sha256: '6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6',
          },
        },
      },
      electron: {
        version: '43.8.4',
        modulesAbi: '148',
        packagerVersion: '20.3.0',
        rebuildVersion: '4.2.0',
      },
    })
    expect(readFileSync(DEFAULT_LINUX_RELEASE_INPUTS, 'utf8')).not.toContain('latest')
    expect(validateInstalledLinuxReleaseTools(inputs, resolve(process.cwd()))).toBe(inputs)
  })

  it('rejects partial target maps, target substitutions, and unofficial Node URLs', () => {
    const partial = structuredClone(loadLinuxReleaseInputs())
    delete (partial.node.distributions as Partial<typeof partial.node.distributions>)['linux-arm64']
    expect(() => validateLinuxReleaseInputs(partial))
      .toThrow(/exactly.*linux-arm64, linux-x64/)

    const substituted = structuredClone(loadLinuxReleaseInputs())
    substituted.node.distributions['linux-arm64'].arch = 'x64'
    expect(() => validateLinuxReleaseInputs(substituted))
      .toThrow(/platform\/arch does not match/)

    const unofficial = structuredClone(loadLinuxReleaseInputs())
    unofficial.node.distributions['linux-x64'].url = 'https://example.invalid/node.tar.xz'
    expect(() => validateLinuxReleaseInputs(unofficial))
      .toThrow(/official Node distribution URL/)

    const wrongCompiler = structuredClone(loadLinuxReleaseInputs())
    wrongCompiler.compiler.cxx = 'g++'
    expect(() => validateLinuxReleaseInputs(wrongCompiler))
      .toThrow(/compiler\.cxx/)
  })

  it('keeps the existing macOS manifest schema and exact target set unchanged', () => {
    const macos = JSON.parse(readFileSync(resolve('release/macos-inputs.json'), 'utf8'))
    expect(Object.keys(macos)).toEqual([
      'schema',
      'product',
      'bundleId',
      'minimumMacosVersion',
      'macosArchitectures',
      'node',
      'electron',
      // the headers better-sqlite3 is compiled against (#369)
      'electronHeaders',
    ])
    // Apple silicon only since #296.
    expect(Object.keys(macos.node.distributions)).toEqual(['darwin-arm64'])
  })
})
