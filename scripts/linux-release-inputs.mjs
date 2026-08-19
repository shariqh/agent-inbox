#!/usr/bin/env node
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  ReleaseInputError,
  requireExactKeys,
  requireString,
  validateElectronReleaseInputs,
  validateInstalledReleaseToolsFor,
  validateNodeReleaseInputs,
} from './release-inputs.mjs'
import { LINUX_RUNTIME_KEYS } from './runtime-targets.mjs'
import { readFileSync } from 'node:fs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_LINUX_RELEASE_INPUTS = resolve(REPO_ROOT, 'release', 'linux-inputs.json')
export { LINUX_RUNTIME_KEYS }
export const LINUX_RELEASE_TOOL_PACKAGES = {
  version: 'electron',
  packagerVersion: '@electron/packager',
  rebuildVersion: '@electron/rebuild',
}

export function validateLinuxReleaseInputs(value) {
  requireExactKeys(
    value,
    [
      'schema',
      'product',
      'bundleId',
      'minimumKernelVersion',
      'minimumGlibcVersion',
      'minimumLibstdcxxVersion',
      'maximumGlibcxxVersion',
      'distributionFloor',
      'node',
      'electron',
    ],
    'Linux release inputs',
  )
  if (value.schema !== 1) throw new ReleaseInputError(`unsupported release input schema: ${value.schema}`)
  requireString(value.product, 'product')
  requireString(value.bundleId, 'bundleId', /^[A-Za-z0-9.-]+$/)
  requireString(value.minimumKernelVersion, 'minimumKernelVersion', /^\d+\.\d+$/)
  requireString(value.minimumGlibcVersion, 'minimumGlibcVersion', /^\d+\.\d+$/)
  requireString(value.minimumLibstdcxxVersion, 'minimumLibstdcxxVersion', /^\d+\.\d+\.\d+$/)
  requireString(value.maximumGlibcxxVersion, 'maximumGlibcxxVersion', /^\d+\.\d+\.\d+$/)
  requireExactKeys(value.distributionFloor, ['ubuntu', 'debian', 'rhel'], 'distributionFloor')
  requireString(value.distributionFloor.ubuntu, 'distributionFloor.ubuntu', /^\d+\.\d+$/)
  requireString(value.distributionFloor.debian, 'distributionFloor.debian', /^\d+$/)
  requireString(value.distributionFloor.rhel, 'distributionFloor.rhel', /^\d+$/)
  validateNodeReleaseInputs(value.node, LINUX_RUNTIME_KEYS)
  validateElectronReleaseInputs(
    value.electron,
    ['version', 'modulesAbi', 'packagerVersion', 'rebuildVersion'],
  )
  return value
}

export function loadLinuxReleaseInputs(path = DEFAULT_LINUX_RELEASE_INPUTS) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new ReleaseInputError(`could not read Linux release inputs at ${path}: ${err.message}`)
  }
  return validateLinuxReleaseInputs(parsed)
}

export function validateInstalledLinuxReleaseTools(inputs, repoRoot = REPO_ROOT) {
  return validateInstalledReleaseToolsFor(inputs, LINUX_RELEASE_TOOL_PACKAGES, repoRoot)
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      inputs: { type: 'string' },
      'node-version': { type: 'boolean' },
    },
  })
  const inputs = loadLinuxReleaseInputs(values.inputs && resolve(values.inputs))
  if (values['node-version']) {
    process.stdout.write(`${inputs.node.version.slice(1)}\n`)
    return
  }
  validateInstalledLinuxReleaseTools(inputs)
  process.stdout.write(`${JSON.stringify({
    ok: true,
    nodeVersion: inputs.node.version,
    nodeModulesAbi: inputs.node.modulesAbi,
    electronModulesAbi: inputs.electron.modulesAbi,
    runtimeKeys: LINUX_RUNTIME_KEYS,
  })}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`linux-release-inputs: ${err.message}\n`)
    process.exitCode = 1
  }
}
