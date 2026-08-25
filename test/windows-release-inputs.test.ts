import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WINDOWS_RELEASE_INPUTS,
  WINDOWS_RELEASE_TOOL_PACKAGES,
  WINDOWS_RUNTIME_KEYS,
  loadWindowsReleaseInputs,
  validateInstalledWindowsReleaseTools,
  validateWindowsReleaseInputs,
} from '../scripts/windows-release-inputs.mjs'

describe('Windows release inputs', () => {
  it('pins the exact native win32-x64 Node, Electron, ABI, and support contract', () => {
    const inputs = loadWindowsReleaseInputs()
    expect(WINDOWS_RUNTIME_KEYS).toEqual(['win32-x64'])
    expect(Object.keys(inputs.node.distributions)).toEqual(WINDOWS_RUNTIME_KEYS)
    expect(inputs).toMatchObject({
      schema: 1,
      product: 'Agent Inbox',
      bundleId: 'io.github.shariqh.agent-inbox',
      minimumWindowsVersion: '10.0.17763',
      node: {
        version: 'v24.19.0',
        modulesAbi: '137',
        distributions: {
          'win32-x64': {
            platform: 'win32',
            arch: 'x64',
            archive: 'node-v24.19.0-win-x64.zip',
            root: 'node-v24.19.0-win-x64',
            url: 'https://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip',
            sha256: '57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73',
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
    expect(WINDOWS_RELEASE_TOOL_PACKAGES).toEqual({
      version: 'electron',
      packagerVersion: '@electron/packager',
      rebuildVersion: '@electron/rebuild',
    })
    expect(readFileSync(DEFAULT_WINDOWS_RELEASE_INPUTS, 'utf8')).not.toContain('latest')
    expect(validateInstalledWindowsReleaseTools(inputs, resolve(process.cwd()))).toBe(inputs)
  })

  it('rejects a missing top-level key', () => {
    const missing = structuredClone(loadWindowsReleaseInputs())
    delete (missing as Partial<typeof missing>).minimumWindowsVersion
    expect(() => validateWindowsReleaseInputs(missing)).toThrow(/keys must be exactly/)
  })

  it('rejects an extra top-level key', () => {
    const extra = structuredClone(loadWindowsReleaseInputs()) as Record<string, unknown>
    extra.minimumMacosVersion = '13.5'
    expect(() => validateWindowsReleaseInputs(extra)).toThrow(/keys must be exactly/)
  })

  it('rejects a partial or substituted node.distributions map', () => {
    const missingTarget = structuredClone(loadWindowsReleaseInputs())
    delete (missingTarget.node.distributions as Partial<typeof missingTarget.node.distributions>)['win32-x64']
    expect(() => validateWindowsReleaseInputs(missingTarget)).toThrow(/exactly.*win32-x64/)

    const extraTarget = structuredClone(loadWindowsReleaseInputs()) as {
      node: { distributions: Record<string, unknown> }
    }
    extraTarget.node.distributions['win32-arm64'] = extraTarget.node.distributions['win32-x64']
    expect(() => validateWindowsReleaseInputs(extraTarget)).toThrow(/exactly.*win32-x64/)

    const wrongPlatform = structuredClone(loadWindowsReleaseInputs()) as {
      node: { distributions: Record<string, { platform: string }> }
    }
    wrongPlatform.node.distributions['win32-x64']!.platform = 'linux'
    expect(() => validateWindowsReleaseInputs(wrongPlatform)).toThrow(/platform\/arch does not match/)

    const wrongArch = structuredClone(loadWindowsReleaseInputs()) as {
      node: { distributions: Record<string, { arch: string }> }
    }
    wrongArch.node.distributions['win32-x64']!.arch = 'arm64'
    expect(() => validateWindowsReleaseInputs(wrongArch)).toThrow(/platform\/arch does not match/)
  })

  it('rejects a wrong archive, root, or unofficial Node URL', () => {
    const wrongArchive = structuredClone(loadWindowsReleaseInputs())
    wrongArchive.node.distributions['win32-x64'].archive = 'node-v24.19.0-win-x64.tar.xz'
    expect(() => validateWindowsReleaseInputs(wrongArchive)).toThrow(/archive must be/)

    const wrongRoot = structuredClone(loadWindowsReleaseInputs())
    wrongRoot.node.distributions['win32-x64'].root = 'node-v24.19.0-win32-x64'
    expect(() => validateWindowsReleaseInputs(wrongRoot)).toThrow(/root must be/)

    const unofficial = structuredClone(loadWindowsReleaseInputs())
    unofficial.node.distributions['win32-x64'].url = 'https://example.invalid/node-v24.19.0-win-x64.zip'
    expect(() => validateWindowsReleaseInputs(unofficial)).toThrow(/official Node distribution URL/)

    const latestUrl = structuredClone(loadWindowsReleaseInputs())
    latestUrl.node.distributions['win32-x64'].url = 'https://nodejs.org/dist/latest/node-v24.19.0-win-x64.zip'
    expect(() => validateWindowsReleaseInputs(latestUrl)).toThrow(/official Node distribution URL/)

    const badDigest = structuredClone(loadWindowsReleaseInputs())
    badDigest.node.distributions['win32-x64'].sha256 = 'not-a-hash'
    expect(() => validateWindowsReleaseInputs(badDigest)).toThrow(/sha256 is invalid/)
  })

  it('rejects a malformed Node version or ABI format', () => {
    const nonNumericAbi = structuredClone(loadWindowsReleaseInputs())
    nonNumericAbi.node.modulesAbi = 'abc'
    expect(() => validateWindowsReleaseInputs(nonNumericAbi)).toThrow(/node\.modulesAbi is invalid/)

    const malformedVersion = structuredClone(loadWindowsReleaseInputs())
    malformedVersion.node.version = '24.19.0'
    expect(() => validateWindowsReleaseInputs(malformedVersion)).toThrow(/node\.version is invalid/)
  })

  it('rejects a numerically-valid Node ABI that does not match the pinned Node 24/ABI 137 release', () => {
    // '999' passes the /^\d+$/ format check but is not the pinned ABI — this is the exact gap a
    // format-only check misses, since the digit pattern alone accepts any numeric ABI.
    const numericWrongAbi = structuredClone(loadWindowsReleaseInputs())
    numericWrongAbi.node.modulesAbi = '999'
    expect(() => validateWindowsReleaseInputs(numericWrongAbi))
      .toThrow(/node\.version\/node\.modulesAbi must be v24\.19\.0\/137/)
  })

  it('rejects an internally-consistent Node release substitution that is not the pinned v24.19.0/ABI 137', () => {
    // A real, differently-versioned Node distribution with matching archive/root/url passes every
    // structural check (format, platform/arch, official URL derivation) — only an explicit pin
    // catches a substitution to a different-but-otherwise-valid official release.
    const substituted = structuredClone(loadWindowsReleaseInputs())
    substituted.node.version = 'v24.18.0'
    substituted.node.distributions['win32-x64'].archive = 'node-v24.18.0-win-x64.zip'
    substituted.node.distributions['win32-x64'].root = 'node-v24.18.0-win-x64'
    substituted.node.distributions['win32-x64'].url =
      'https://nodejs.org/dist/v24.18.0/node-v24.18.0-win-x64.zip'
    expect(() => validateWindowsReleaseInputs(substituted))
      .toThrow(/node\.version\/node\.modulesAbi must be v24\.19\.0\/137/)
  })

  it('rejects a malformed or missing minimumWindowsVersion', () => {
    const missing = structuredClone(loadWindowsReleaseInputs()) as Partial<{ minimumWindowsVersion: string }>
    delete missing.minimumWindowsVersion
    expect(() => validateWindowsReleaseInputs(missing)).toThrow(/keys must be exactly/)

    const tooShort = structuredClone(loadWindowsReleaseInputs())
    tooShort.minimumWindowsVersion = '10'
    expect(() => validateWindowsReleaseInputs(tooShort)).toThrow(/minimumWindowsVersion/)

    const notNumeric = structuredClone(loadWindowsReleaseInputs())
    notNumeric.minimumWindowsVersion = 'Windows 10'
    expect(() => validateWindowsReleaseInputs(notNumeric)).toThrow(/minimumWindowsVersion/)
  })

  it('rejects an invalid schema, product, or bundleId', () => {
    const badSchema = structuredClone(loadWindowsReleaseInputs()) as { schema: number }
    badSchema.schema = 2
    expect(() => validateWindowsReleaseInputs(badSchema)).toThrow(/unsupported release input schema/)

    const badBundleId = structuredClone(loadWindowsReleaseInputs())
    badBundleId.bundleId = 'not a bundle id!'
    expect(() => validateWindowsReleaseInputs(badBundleId)).toThrow(/bundleId/)
  })

  it('rejects installed release-tool drift from the authoritative manifest', () => {
    const inputs = structuredClone(loadWindowsReleaseInputs())
    inputs.electron.packagerVersion = '19.0.0'
    expect(() => validateInstalledWindowsReleaseTools(inputs, resolve(process.cwd())))
      .toThrow(/@electron\/packager version mismatch/)
  })

  it('rejects a wrong electron.modulesAbi or an extra/missing electron tool key', () => {
    const wrongAbi = structuredClone(loadWindowsReleaseInputs())
    wrongAbi.electron.modulesAbi = 'not-a-number'
    expect(() => validateWindowsReleaseInputs(wrongAbi)).toThrow(/electron\.modulesAbi is invalid/)

    const missingTool = structuredClone(loadWindowsReleaseInputs()) as {
      electron: Partial<{ rebuildVersion: string }>
    }
    delete missingTool.electron.rebuildVersion
    expect(() => validateWindowsReleaseInputs(missingTool)).toThrow(/keys must be exactly/)

    const extraTool = structuredClone(loadWindowsReleaseInputs()) as {
      electron: Record<string, string>
    }
    extraTool.electron.universalVersion = '3.0.6'
    expect(() => validateWindowsReleaseInputs(extraTool)).toThrow(/keys must be exactly/)
  })

  it('rejects a numerically-valid Electron ABI that does not match the pinned 43.1.1/ABI 148 release', () => {
    // '999' passes the /^\d+$/ format check but is not the pinned ABI — same gap as the Node case.
    const numericWrongAbi = structuredClone(loadWindowsReleaseInputs())
    numericWrongAbi.electron.modulesAbi = '999'
    expect(() => validateWindowsReleaseInputs(numericWrongAbi))
      .toThrow(/electron\.version\/electron\.modulesAbi must be 43\.1\.1\/148/)
  })

  it('rejects a format-valid Electron version that is not the pinned 43.1.1/ABI 148 release', () => {
    const wrongVersion = structuredClone(loadWindowsReleaseInputs())
    wrongVersion.electron.version = '44.0.0'
    expect(() => validateWindowsReleaseInputs(wrongVersion))
      .toThrow(/electron\.version\/electron\.modulesAbi must be 43\.1\.1\/148/)
  })

  it('keeps the existing macOS and Linux manifest schemas and target sets unchanged', () => {
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

    const linux = JSON.parse(readFileSync(resolve('release/linux-inputs.json'), 'utf8'))
    expect(Object.keys(linux.node.distributions)).toEqual(['linux-arm64', 'linux-x64'])
  })

  it('routes native win32 staging through the strict Windows loader, never the macOS/Linux ones', () => {
    const stageSource = readFileSync(resolve('scripts', 'stage-native-runtime.mjs'), 'utf8')
    expect(stageSource).toContain("import { loadWindowsReleaseInputs } from './windows-release-inputs.mjs'")
    expect(stageSource).toMatch(/target\.platform === 'win32'[^\n]*loadWindowsReleaseInputs/)

    // Native-host enforcement must still gate every platform, including win32, before any
    // archive/repo I/O runs — it must appear ahead of the release-input load in stageNativeRuntime.
    const stageBody = stageSource.slice(stageSource.indexOf('export async function stageNativeRuntime'))
    const assertIndex = stageBody.indexOf('assertNativeRuntimeKey(key)')
    const loadIndex = stageBody.indexOf('releaseInputsFor(target, inputsPath)')
    expect(assertIndex).toBeGreaterThan(-1)
    expect(loadIndex).toBeGreaterThan(assertIndex)
  })
})
