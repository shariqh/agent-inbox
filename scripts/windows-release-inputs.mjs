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
import { WINDOWS_RUNTIME_KEYS, targetFor } from './runtime-targets.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_WINDOWS_RELEASE_INPUTS = resolve(REPO_ROOT, 'release', 'windows-inputs.json')
export { WINDOWS_RUNTIME_KEYS }
export const WINDOWS_RELEASE_TOOL_PACKAGES = {
  version: 'electron',
  packagerVersion: '@electron/packager',
  rebuildVersion: '@electron/rebuild',
}

// This profile is pinned to one exact Node/Electron release pairing: Node v24.18.1 ABI 137
// (the #135 compatibility hold every portable runtime shares; see docs/macos-release.md) and
// Electron 43.8.0 ABI 148, the same versions the macOS and Linux profiles pin. Format-only
// checks (VERSION_RE, /^\d+$/) accept any internally-consistent official release, so a
// substituted-but-otherwise-valid manifest (e.g. a real Node v24.19.0 distribution with
// matching archive/root/url) would slip through unnoticed. These constants make the pin
// explicit and reject any other version/ABI pairing.
const PINNED_NODE_VERSION = 'v24.18.1'
const PINNED_NODE_MODULES_ABI = '137'
const PINNED_ELECTRON_VERSION = '43.8.0'
const PINNED_ELECTRON_MODULES_ABI = '148'
const SHA256_RE = /^[0-9a-f]{64}$/

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

// The official Windows ZIP carries neither the C/C++ headers nor node.lib that node-gyp
// needs, and stage-runtime.mjs builds the Node-ABI better-sqlite3 against
// npm_config_nodedir = the staged distribution (#135). So the same Node release's headers
// tarball and import library are pinned here, by official URL and SHA-256, and native
// staging adds them to the extracted distribution before anything is compiled.
function validateWindowsNodeHeaders(headers, version) {
  requireExactKeys(headers, ['archive', 'root', 'url', 'sha256', 'importLibraries'], 'nodeHeaders')
  const archive = `node-${version}-headers.tar.gz`
  if (headers.archive !== archive) throw new ReleaseInputError(`nodeHeaders.archive must be ${archive}`)
  if (headers.root !== `node-${version}`) {
    throw new ReleaseInputError(`nodeHeaders.root must be node-${version}`)
  }
  if (headers.url !== `https://nodejs.org/dist/${version}/${archive}`) {
    throw new ReleaseInputError('nodeHeaders.url must be the official Node headers URL')
  }
  requireString(headers.sha256, 'nodeHeaders.sha256', SHA256_RE)
  requireExactKeys(headers.importLibraries, WINDOWS_RUNTIME_KEYS, 'nodeHeaders.importLibraries')
  for (const key of WINDOWS_RUNTIME_KEYS) {
    const library = headers.importLibraries[key]
    requireExactKeys(library, ['url', 'sha256'], `nodeHeaders.importLibraries.${key}`)
    const target = targetFor(key)
    if (library.url !== `https://nodejs.org/dist/${version}/${target.nodeDistPlatform}-${target.arch}/node.lib`) {
      throw new ReleaseInputError(`nodeHeaders.importLibraries.${key}.url must be the official node.lib URL`)
    }
    requireString(library.sha256, `nodeHeaders.importLibraries.${key}.sha256`, SHA256_RE)
  }
  return headers
}

export function validateWindowsReleaseInputs(value) {
  requireExactKeys(
    value,
    ['schema', 'product', 'bundleId', 'minimumWindowsVersion', 'node', 'nodeHeaders', 'electron'],
    'Windows release inputs',
  )
  if (value.schema !== 1) throw new ReleaseInputError(`unsupported release input schema: ${value.schema}`)
  requireString(value.product, 'product')
  requireString(value.bundleId, 'bundleId', /^[A-Za-z0-9.-]+$/)
  requireString(value.minimumWindowsVersion, 'minimumWindowsVersion', /^\d+\.\d+\.\d+$/)
  validateNodeReleaseInputs(value.node, WINDOWS_RUNTIME_KEYS)
  requireExactNodeAbiPin(value.node)
  validateWindowsNodeHeaders(value.nodeHeaders, value.node.version)
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
