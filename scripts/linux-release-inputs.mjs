#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
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
export const LINUX_COMPILER_PROBE_TIMEOUT_MS = 30_000

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
      'compiler',
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
  requireExactKeys(value.compiler, ['family', 'version', 'cc', 'cxx'], 'compiler')
  if (value.compiler.family !== 'clang') {
    throw new ReleaseInputError(`compiler.family must be clang, got ${value.compiler.family}`)
  }
  requireString(value.compiler.version, 'compiler.version', /^\d+\.\d+\.\d+$/)
  const compilerMajor = value.compiler.version.split('.')[0]
  requireString(value.compiler.cc, 'compiler.cc', /^clang-\d+$/)
  requireString(value.compiler.cxx, 'compiler.cxx', /^clang\+\+-\d+$/)
  if (value.compiler.cc !== `clang-${compilerMajor}`) {
    throw new ReleaseInputError(`compiler.cc must match compiler.version major ${compilerMajor}`)
  }
  if (value.compiler.cxx !== `clang++-${compilerMajor}`) {
    throw new ReleaseInputError(`compiler.cxx must match compiler.version major ${compilerMajor}`)
  }
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

function runCompiler(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: LINUX_COMPILER_PROBE_TIMEOUT_MS,
  })
}

export function resolveLinuxCompilerEnvironment(inputs, arch, run = runCompiler) {
  if (!['arm64', 'x64'].includes(arch)) {
    throw new ReleaseInputError(`unsupported Linux compiler architecture: ${arch}`)
  }
  for (const command of [inputs.compiler.cc, inputs.compiler.cxx]) {
    let output
    try {
      output = String(run(command, ['--version'])).trim()
    } catch (err) {
      throw new ReleaseInputError(`could not run pinned compiler ${command}: ${err.message}`)
    }
    const actualVersion = /\bclang version (\d+\.\d+\.\d+)\b/.exec(output)?.[1]
    if (actualVersion !== inputs.compiler.version) {
      throw new ReleaseInputError(
        `${command} compiler version mismatch: expected ${inputs.compiler.version}, got ${actualVersion ?? 'unknown'}`,
      )
    }
  }

  let target
  try {
    target = String(run(inputs.compiler.cxx, ['-dumpmachine'])).trim()
  } catch (err) {
    throw new ReleaseInputError(
      `could not read pinned compiler target from ${inputs.compiler.cxx}: ${err.message}`,
    )
  }
  const targetArch = target.startsWith('aarch64-')
    ? 'arm64'
    : target.startsWith('x86_64-')
      ? 'x64'
      : 'unknown'
  if (targetArch !== arch || !target.includes('linux')) {
    throw new ReleaseInputError(
      `${inputs.compiler.cxx} compiler target mismatch: expected linux/${arch}, got ${target}`,
    )
  }
  return {
    CC: inputs.compiler.cc,
    CXX: inputs.compiler.cxx,
  }
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      inputs: { type: 'string' },
      'node-version': { type: 'boolean' },
      'compiler-arch': { type: 'string' },
    },
  })
  const inputs = loadLinuxReleaseInputs(values.inputs && resolve(values.inputs))
  if (values['node-version']) {
    process.stdout.write(`${inputs.node.version.slice(1)}\n`)
    return
  }
  const compiler = values['compiler-arch']
    ? resolveLinuxCompilerEnvironment(inputs, values['compiler-arch'])
    : undefined
  validateInstalledLinuxReleaseTools(inputs)
  process.stdout.write(`${JSON.stringify({
    ok: true,
    nodeVersion: inputs.node.version,
    nodeModulesAbi: inputs.node.modulesAbi,
    electronModulesAbi: inputs.electron.modulesAbi,
    runtimeKeys: LINUX_RUNTIME_KEYS,
    ...(compiler && { compiler }),
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
