#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { isDeepStrictEqual } from 'node:util'
import { verifyPayload } from './runtime-payload.mjs'
import { treeIdentity } from './tree-identity.mjs'

const KEY = 'win32-x64'
const PRODUCT = 'agent-inbox-runtime'

export class WindowsRoundTripVerificationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'WindowsRoundTripVerificationError'
  }
}

function readObject(path, label) {
  let value
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new WindowsRoundTripVerificationError(`${label} is not readable JSON: ${err.message}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WindowsRoundTripVerificationError(`${label} must be a JSON object`)
  }
  return value
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function assertNoBuilderPaths(value, label) {
  if (!value || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value)) {
    if (['repoRoot', 'nodeBin', 'sourceRoot'].includes(key)) {
      throw new WindowsRoundTripVerificationError(`${label} contains builder-local ${key}`)
    }
    assertNoBuilderPaths(nested, label)
  }
}

function verifyAppSide({
  root,
  reportPath,
  packageVersion,
  runtimeManifestDigest,
  label,
}) {
  const report = readObject(reportPath, `${label} application report`)
  const actualTreeDigest = treeIdentity(root)
  if (report.appTreeDigest !== actualTreeDigest) {
    throw new WindowsRoundTripVerificationError(
      `${label} application report tree digest does not match its on-disk tree`,
    )
  }
  if (report.runtimeManifestDigest !== runtimeManifestDigest ||
      report.key !== KEY ||
      report.nativeAddonSelftests !== 'passed' ||
      report.setupAvailable !== false) {
    throw new WindowsRoundTripVerificationError(`${label} application report identity mismatch`)
  }
  const setupInfo = readObject(
    join(root, 'resources', 'app', 'setup-info.json'),
    `${label} setup-info`,
  )
  assertNoBuilderPaths(setupInfo, `${label} setup-info`)
  if (setupInfo.schema !== 2 || setupInfo.version !== packageVersion ||
      !isDeepStrictEqual(Object.keys(setupInfo.runtimePayloads ?? {}), [KEY]) ||
      setupInfo.runtimePayloads[KEY]?.digest !== runtimeManifestDigest) {
    throw new WindowsRoundTripVerificationError(`${label} setup-info identity mismatch`)
  }
  return { report, actualTreeDigest }
}

export function verifyWindowsRoundTrip({
  originalApp,
  restoredApp,
  originalRuntime,
  restoredRuntime,
  originalAppReport,
  restoredAppReport,
  originalRuntimeReport,
  restoredRuntimeReport,
  sourceCommit,
  packageVersion,
  nodeVersion,
  nodeModulesAbi,
}) {
  const expectedRuntime = {
    product: PRODUCT,
    packageVersion,
    sourceCommit,
    platform: 'win32',
    arch: 'x64',
    nodeVersion,
    nodeModulesAbi,
  }
  const originalManifest = verifyPayload({ root: originalRuntime, expect: expectedRuntime })
  const restoredManifest = verifyPayload({ root: restoredRuntime, expect: expectedRuntime })
  if (!isDeepStrictEqual(originalManifest, restoredManifest)) {
    throw new WindowsRoundTripVerificationError('original and restored runtime manifests differ')
  }

  const originalManifestPath = join(originalRuntime, 'runtime-manifest.json')
  const restoredManifestPath = join(restoredRuntime, 'runtime-manifest.json')
  const originalManifestDigest = sha256File(originalManifestPath)
  const restoredManifestDigest = sha256File(restoredManifestPath)
  if (originalManifestDigest !== restoredManifestDigest) {
    throw new WindowsRoundTripVerificationError('original and restored runtime manifest digests differ')
  }
  const runtimeManifestDigest = `sha256:${originalManifestDigest}`
  const originalVerification = readObject(originalRuntimeReport, 'original runtime verification report')
  const restoredVerification = readObject(restoredRuntimeReport, 'restored runtime verification report')
  if (!isDeepStrictEqual(originalVerification, originalManifest) ||
      !isDeepStrictEqual(restoredVerification, restoredManifest) ||
      !isDeepStrictEqual(originalVerification, restoredVerification)) {
    throw new WindowsRoundTripVerificationError('runtime verification report mismatch')
  }

  const original = verifyAppSide({
    root: originalApp,
    reportPath: originalAppReport,
    packageVersion,
    runtimeManifestDigest,
    label: 'original',
  })
  const restored = verifyAppSide({
    root: restoredApp,
    reportPath: restoredAppReport,
    packageVersion,
    runtimeManifestDigest,
    label: 'restored',
  })
  if (original.actualTreeDigest !== restored.actualTreeDigest) {
    throw new WindowsRoundTripVerificationError('application tree digest mismatch after archive round-trip')
  }

  return {
    schema: 1,
    key: KEY,
    packageVersion,
    appTreeDigest: original.actualTreeDigest,
    runtimeManifestDigest,
    runtimeId: originalManifest.runtimeId,
    runtimePayloadDigest: originalManifest.payloadDigest,
    runtimeSourceCommit: originalManifest.sourceCommit,
    nodeVersion: originalManifest.nodeVersion,
    nodeModulesAbi: originalManifest.nodeModulesAbi,
    nativeAddonSelftests: restored.report.nativeAddonSelftests,
    setupAvailable: restored.report.setupAvailable,
  }
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'original-app': { type: 'string' },
      'restored-app': { type: 'string' },
      'original-runtime': { type: 'string' },
      'restored-runtime': { type: 'string' },
      'original-app-report': { type: 'string' },
      'restored-app-report': { type: 'string' },
      'original-runtime-report': { type: 'string' },
      'restored-runtime-report': { type: 'string' },
      'source-commit': { type: 'string' },
      'package-version': { type: 'string' },
      'node-version': { type: 'string' },
      'node-modules-abi': { type: 'string' },
    },
  })
  for (const field of [
    'original-app',
    'restored-app',
    'original-runtime',
    'restored-runtime',
    'original-app-report',
    'restored-app-report',
    'original-runtime-report',
    'restored-runtime-report',
    'source-commit',
    'package-version',
    'node-version',
    'node-modules-abi',
  ]) {
    if (!values[field]) {
      throw new WindowsRoundTripVerificationError(`--${field} is required`)
    }
  }
  const evidence = verifyWindowsRoundTrip({
    originalApp: resolve(values['original-app']),
    restoredApp: resolve(values['restored-app']),
    originalRuntime: resolve(values['original-runtime']),
    restoredRuntime: resolve(values['restored-runtime']),
    originalAppReport: resolve(values['original-app-report']),
    restoredAppReport: resolve(values['restored-app-report']),
    originalRuntimeReport: resolve(values['original-runtime-report']),
    restoredRuntimeReport: resolve(values['restored-runtime-report']),
    sourceCommit: values['source-commit'],
    packageVersion: values['package-version'],
    nodeVersion: values['node-version'],
    nodeModulesAbi: values['node-modules-abi'],
  })
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`verify-windows-roundtrip: ${err.message}\n`)
    process.exitCode = 1
  }
}
