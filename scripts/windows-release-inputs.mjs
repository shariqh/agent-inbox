#!/usr/bin/env node
import { readFileSync } from 'node:fs'
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
import { WINDOWS_RUNTIME_KEYS } from './runtime-targets.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_WINDOWS_RELEASE_INPUTS = resolve(REPO_ROOT, 'release', 'windows-inputs.json')
export { WINDOWS_RUNTIME_KEYS }
export const WINDOWS_RELEASE_TOOL_PACKAGES = {
  version: 'electron',
  packagerVersion: '@electron/packager',
  rebuildVersion: '@electron/rebuild',
}

// This profile is pinned to one exact Node/Electron release pairing (see AGENTS.md: Node
// v24.19.0 ABI 137, Electron 43.1.1 ABI 148). Format-only checks (VERSION_RE, /^\d+$/) accept
// any internally-consistent official release, so a substituted-but-otherwise-valid manifest
// (e.g. a real Node v24.18.0 distribution with matching archive/root/url) would slip through
// unnoticed. These constants make the pin explicit and reject any other version/ABI pairing.
const PINNED_NODE_VERSION = 'v24.19.0'
const PINNED_NODE_MODULES_ABI = '137'
const PINNED_ELECTRON_VERSION = '43.1.1'
const PINNED_ELECTRON_MODULES_ABI = '148'

function requireExactNodeAbiPin(node) {
  if (node.version !== PINNED_NODE_VERSION || node.modulesAbi !== PINNED_NODE_MODULES_ABI) {
    throw new ReleaseInputError(
      `node.version/node.modulesAbi must be ${PINNED_NODE_VERSION}/${PINNED_NODE_MODULES_ABI} ` +
      `(Node 24 ABI 137), got ${node.version}/${node.modulesAbi}`,
    )
  }
}

function requireExactElectronAbiPin(electron) {
  if (electron.version !== PINNED_ELECTRON_VERSION || electron.modulesAbi !== PINNED_ELECTRON_MODULES_ABI) {
    throw new ReleaseInputError(
      `electron.version/electron.modulesAbi must be ${PINNED_ELECTRON_VERSION}/${PINNED_ELECTRON_MODULES_ABI} ` +
      `(Electron 43 ABI 148), got ${electron.version}/${electron.modulesAbi}`,
    )
  }
}

export function validateWindowsReleaseInputs(value) {
  requireExactKeys(
    value,
    ['schema', 'product', 'bundleId', 'minimumWindowsVersion', 'node', 'electron'],
    'Windows release inputs',
  )
  if (value.schema !== 1) throw new ReleaseInputError(`unsupported release input schema: ${value.schema}`)
  requireString(value.product, 'product')
  requireString(value.bundleId, 'bundleId', /^[A-Za-z0-9.-]+$/)
  requireString(value.minimumWindowsVersion, 'minimumWindowsVersion', /^\d+\.\d+\.\d+$/)
  validateNodeReleaseInputs(value.node, WINDOWS_RUNTIME_KEYS)
  requireExactNodeAbiPin(value.node)
  validateElectronReleaseInputs(
    value.electron,
    ['version', 'modulesAbi', 'packagerVersion', 'rebuildVersion'],
  )
  requireExactElectronAbiPin(value.electron)
  return value
}

export function loadWindowsReleaseInputs(path = DEFAULT_WINDOWS_RELEASE_INPUTS) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new ReleaseInputError(`could not read Windows release inputs at ${path}: ${err.message}`)
  }
  return validateWindowsReleaseInputs(parsed)
}

export function validateInstalledWindowsReleaseTools(inputs, repoRoot = REPO_ROOT) {
  return validateInstalledReleaseToolsFor(inputs, WINDOWS_RELEASE_TOOL_PACKAGES, repoRoot)
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      inputs: { type: 'string' },
      'node-version': { type: 'boolean' },
    },
  })
  const inputs = loadWindowsReleaseInputs(values.inputs && resolve(values.inputs))
  if (values['node-version']) {
    process.stdout.write(`${inputs.node.version.slice(1)}\n`)
    return
  }
  validateInstalledWindowsReleaseTools(inputs)
  process.stdout.write(`${JSON.stringify({
    ok: true,
    nodeVersion: inputs.node.version,
    nodeModulesAbi: inputs.node.modulesAbi,
    electronModulesAbi: inputs.electron.modulesAbi,
    runtimeKeys: WINDOWS_RUNTIME_KEYS,
  })}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`windows-release-inputs: ${err.message}\n`)
    process.exitCode = 1
  }
}
