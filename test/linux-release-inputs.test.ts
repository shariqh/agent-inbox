import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LINUX_RELEASE_INPUTS,
  LINUX_RUNTIME_KEYS,
  loadLinuxReleaseInputs,
  validateInstalledLinuxReleaseTools,
  validateLinuxReleaseInputs,
} from '../scripts/linux-release-inputs.mjs'

describe('Linux release inputs', () => {
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
        version: 'v24.19.0',
        modulesAbi: '137',
        distributions: {
          'linux-arm64': {
            platform: 'linux',
            arch: 'arm64',
            archive: 'node-v24.19.0-linux-arm64.tar.xz',
            root: 'node-v24.19.0-linux-arm64',
            url: 'https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-arm64.tar.xz',
            sha256: '01443c1e1a29e531ccad5a46fefa6df490d2189c49f7955904aecdbb0fe86fdc',
          },
          'linux-x64': {
            platform: 'linux',
            arch: 'x64',
            archive: 'node-v24.19.0-linux-x64.tar.xz',
            root: 'node-v24.19.0-linux-x64',
            url: 'https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz',
            sha256: '14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647',
          },
        },
      },
      electron: {
        version: '43.1.1',
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
      'node',
      'electron',
    ])
    expect(Object.keys(macos.node.distributions)).toEqual(['darwin-arm64', 'darwin-x64'])
  })
})
