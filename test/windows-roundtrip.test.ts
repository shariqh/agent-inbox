import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildManifest,
  copyTreePreservingMode,
  writeManifestFile,
} from '../scripts/runtime-payload.mjs'
import { treeIdentity } from '../scripts/tree-identity.mjs'
import { verifyWindowsRoundTrip } from '../scripts/verify-windows-roundtrip.mjs'

const SOURCE_COMMIT = 'a'.repeat(40)
const PACKAGE_VERSION = '1.2.3'
const NODE_VERSION = 'v24.19.0'
const NODE_MODULES_ABI = '137'

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function fixture(): {
  originalApp: string
  restoredApp: string
  originalRuntime: string
  restoredRuntime: string
  originalAppReport: string
  restoredAppReport: string
  originalRuntimeReport: string
  restoredRuntimeReport: string
  options: Parameters<typeof verifyWindowsRoundTrip>[0]
} {
  const root = mkdtempSync(join(tmpdir(), 'windows-roundtrip-'))
  const originalApp = join(root, 'original-app')
  const restoredApp = join(root, 'restored-app')
  const originalRuntime = join(root, 'original-runtime')
  const restoredRuntime = join(root, 'restored-runtime')
  mkdirSync(originalApp)
  mkdirSync(originalRuntime)
  writeFileSync(join(originalApp, 'Agent Inbox.exe'), 'launcher\n')
  writeFileSync(join(originalApp, 'LICENSES.chromium.html'), 'non-launch evidence\n')
  writeFileSync(join(originalRuntime, 'entry.js'), 'process.exit(0)\n')
  writeFileSync(join(originalRuntime, 'NOTICE.txt'), 'runtime non-launch evidence\n')
  const manifest = buildManifest({
    root: originalRuntime,
    product: 'agent-inbox-runtime',
    packageVersion: PACKAGE_VERSION,
    sourceCommit: SOURCE_COMMIT,
    platform: 'win32',
    arch: 'x64',
    nodeVersion: NODE_VERSION,
    nodeModulesAbi: NODE_MODULES_ABI,
    entrypoints: ['entry.js'],
  })
  writeManifestFile(originalRuntime, manifest)
  const runtimeManifestDigest = `sha256:${sha256(join(originalRuntime, 'runtime-manifest.json'))}`
  mkdirSync(join(originalApp, 'resources', 'app'), { recursive: true })
  writeFileSync(join(originalApp, 'resources', 'app', 'setup-info.json'), `${JSON.stringify({
    schema: 2,
    version: PACKAGE_VERSION,
    runtimePayloads: {
      'win32-x64': {
        path: 'runtime/win32-x64',
        digest: runtimeManifestDigest,
      },
    },
  }, null, 2)}\n`)
  copyTreePreservingMode(originalApp, restoredApp)
  copyTreePreservingMode(originalRuntime, restoredRuntime)

  const originalAppReport = join(root, 'original-app.json')
  const restoredAppReport = join(root, 'restored-app.json')
  const originalRuntimeReport = join(root, 'original-runtime.json')
  const restoredRuntimeReport = join(root, 'restored-runtime.json')
  const appReport = {
    appTreeDigest: treeIdentity(originalApp),
    runtimeManifestDigest,
    key: 'win32-x64',
    nativeAddonSelftests: 'passed',
    setupAvailable: false,
  }
  writeFileSync(originalAppReport, `${JSON.stringify(appReport, null, 2)}\n`)
  writeFileSync(restoredAppReport, `${JSON.stringify({
    ...appReport,
    appTreeDigest: treeIdentity(restoredApp),
  }, null, 2)}\n`)
  writeFileSync(originalRuntimeReport, `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(restoredRuntimeReport, `${JSON.stringify(manifest, null, 2)}\n`)

  const options = {
    originalApp,
    restoredApp,
    originalRuntime,
    restoredRuntime,
    originalAppReport,
    restoredAppReport,
    originalRuntimeReport,
    restoredRuntimeReport,
    sourceCommit: SOURCE_COMMIT,
    packageVersion: PACKAGE_VERSION,
    nodeVersion: NODE_VERSION,
    nodeModulesAbi: NODE_MODULES_ABI,
  }
  return {
    originalApp,
    restoredApp,
    originalRuntime,
    restoredRuntime,
    originalAppReport,
    restoredAppReport,
    originalRuntimeReport,
    restoredRuntimeReport,
    options,
  }
}

describe('Windows archive round-trip evidence', () => {
  it('requires exact original/restored app and runtime identities', () => {
    const f = fixture()
    expect(verifyWindowsRoundTrip(f.options)).toMatchObject({
      appTreeDigest: treeIdentity(f.originalApp),
      runtimeId: JSON.parse(readFileSync(f.originalRuntimeReport, 'utf8')).runtimeId,
      runtimeSourceCommit: SOURCE_COMMIT,
      nativeAddonSelftests: 'passed',
      setupAvailable: false,
    })
  })

  it('rejects a missing non-launch application file', () => {
    const f = fixture()
    rmSync(join(f.restoredApp, 'LICENSES.chromium.html'))
    expect(() => verifyWindowsRoundTrip(f.options)).toThrow(/application .*tree digest/i)
  })

  it('rejects a tampered non-launch runtime file even when reports are unchanged', () => {
    const f = fixture()
    writeFileSync(join(f.restoredRuntime, 'NOTICE.txt'), 'tampered\n')
    expect(() => verifyWindowsRoundTrip(f.options)).toThrow(/size mismatch|checksum mismatch|payload/i)
  })

  it('rejects a substituted restored runtime manifest or verification report', () => {
    const f = fixture()
    const report = JSON.parse(readFileSync(f.restoredRuntimeReport, 'utf8'))
    report.sourceCommit = 'b'.repeat(40)
    writeFileSync(f.restoredRuntimeReport, `${JSON.stringify(report, null, 2)}\n`)
    expect(() => verifyWindowsRoundTrip(f.options)).toThrow(/runtime verification report mismatch/i)
  })
})
