#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { APP_NAME, findNativeAddon } from './build-thin-app.mjs'
import {
  assertElfTreeCompatibility,
  assertProcessIdentity,
} from './linux-binary-gates.mjs'
import { loadLinuxReleaseInputs } from './linux-release-inputs.mjs'
import { assertRuntimeSourceCommit } from './runtime-provenance.mjs'
import { verifyPayload } from './runtime-payload.mjs'
import { treeIdentity } from './tree-identity.mjs'

const require = createRequire(import.meta.url)
const { selectRuntimePayload } = require('../electron/setup-runner.cjs')

export class LinuxThinVerificationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LinuxThinVerificationError'
  }
}

export const PROCESS_PROBE = [
  "const {createRequire}=require('node:module')",
  "const {join}=require('node:path')",
  "const load=createRequire(join(process.cwd(),'package.json'))",
  "const Database=load('better-sqlite3')",
  "new Database(':memory:').close()",
  "const electron=process.env.AGENT_INBOX_ELECTRON_PROBE==='1'",
  'process.stdout.write(JSON.stringify({',
  'platform:process.platform,',
  'arch:process.arch,',
  'version:electron?process.versions.electron:process.version,',
  'modulesAbi:process.versions.modules',
  '}))',
].join('\n')

function processProbe(executable, cwd, electron = false) {
  try {
    const stdout = execFileSync(executable, ['-e', PROCESS_PROBE], {
      cwd,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: electron ? '1' : undefined,
        AGENT_INBOX_ELECTRON_PROBE: electron ? '1' : undefined,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    })
    return JSON.parse(stdout)
  } catch (err) {
    throw new LinuxThinVerificationError(`failed native process/addon probe for ${executable}: ${err.message}`)
  }
}

function assertElectronNotices(app) {
  for (const name of ['LICENSE', 'LICENSES.chromium.html']) {
    const path = join(app, name)
    if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
      throw new LinuxThinVerificationError(`packaged Linux app is missing nonempty ${name}`)
    }
  }
}

function assertNoBuilderPaths(value) {
  if (!value || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value)) {
    if (['repoRoot', 'nodeBin', 'sourceRoot'].includes(key)) {
      throw new LinuxThinVerificationError(`release setup-info must not contain builder-local ${key}`)
    }
    assertNoBuilderPaths(nested)
  }
}

function relativeAppPath(appRoot, path) {
  return relative(appRoot, path).split(sep).join('/')
}

function assertKnownElfEvidence(appRoot, compatibility, knownFiles) {
  const gated = new Set(compatibility.map((entry) => entry.path))
  for (const [label, path] of Object.entries(knownFiles)) {
    const relativePath = relativeAppPath(appRoot, path)
    if (!gated.has(relativePath)) {
      throw new LinuxThinVerificationError(
        `${label} is not a gated plain ELF inside the packaged app: ${relativePath}`,
      )
    }
  }
}

export function verifyLinuxThinApp({
  app,
  arch,
  inputsPath,
  sourceCommit,
}) {
  const inputs = loadLinuxReleaseInputs(inputsPath)
  if (!['arm64', 'x64'].includes(arch)) {
    throw new LinuxThinVerificationError(`unsupported Linux architecture: ${arch}`)
  }
  const key = `linux-${arch}`
  const appRoot = resolve(app)
  const executable = join(appRoot, APP_NAME)
  const resources = join(appRoot, 'resources', 'app')
  const runtimeRoot = join(resources, 'runtime', key)
  const electronAddon = findNativeAddon(resources)
  const runtimeNode = join(runtimeRoot, 'bin', 'node')
  const runtimeAddon = findNativeAddon(runtimeRoot)
  assertElectronNotices(appRoot)

  const setupInfo = JSON.parse(readFileSync(join(resources, 'setup-info.json'), 'utf8'))
  if (setupInfo.schema !== 2) {
    throw new LinuxThinVerificationError(`release setup-info schema must be 2, found ${String(setupInfo.schema)}`)
  }
  const setupKeys = Object.keys(setupInfo.runtimePayloads ?? {})
  if (setupKeys.length !== 1 || setupKeys[0] !== key) {
    throw new LinuxThinVerificationError(`release setup-info runtime keys must be exactly ${key}`)
  }
  assertNoBuilderPaths(setupInfo)
  const selection = selectRuntimePayload({
    appRoot: resources,
    platform: 'linux',
    arch,
    info: setupInfo,
  })
  if (!selection.ok || selection.key !== key || selection.path !== resolve(runtimeRoot)) {
    throw new LinuxThinVerificationError(
      `exact-host Setup selection failed for ${key}: ${selection.reason ?? 'wrong payload'}`,
    )
  }

  const distribution = inputs.node.distributions[key]
  const runtimeManifest = verifyPayload({
    root: runtimeRoot,
    expect: {
      product: 'agent-inbox-runtime',
      packageVersion: setupInfo.version,
      platform: 'linux',
      arch,
      nodeVersion: inputs.node.version,
      nodeModulesAbi: inputs.node.modulesAbi,
      ...(sourceCommit ? { sourceCommit } : {}),
    },
  })
  if (sourceCommit) assertRuntimeSourceCommit(runtimeManifest, sourceCommit, key)

  const compatibility = assertElfTreeCompatibility({
    root: appRoot,
    arch,
    maximumGlibcVersion: inputs.minimumGlibcVersion,
    maximumLibstdcxxVersion: inputs.maximumGlibcxxVersion,
  })
  assertKnownElfEvidence(appRoot, compatibility, {
    'Electron executable': executable,
    'Electron-ABI addon': electronAddon,
    'runtime Node': runtimeNode,
    'Node-ABI addon': runtimeAddon,
  })
  const electronProbe = assertProcessIdentity({
    actual: processProbe(executable, resources, true),
    expected: {
      platform: 'linux',
      arch,
      version: inputs.electron.version,
      modulesAbi: inputs.electron.modulesAbi,
    },
    label: 'packaged Electron',
  })
  const runtimeProbe = assertProcessIdentity({
    actual: processProbe(runtimeNode, runtimeRoot),
    expected: {
      platform: distribution.platform,
      arch: distribution.arch,
      version: inputs.node.version,
      modulesAbi: inputs.node.modulesAbi,
    },
    label: 'runtime Node',
  })

  return {
    schema: 1,
    product: inputs.product,
    packageVersion: setupInfo.version,
    key,
    arch,
    electronVersion: electronProbe.version,
    electronModulesAbi: electronProbe.modulesAbi,
    nodeVersion: runtimeProbe.version,
    nodeModulesAbi: runtimeProbe.modulesAbi,
    runtimeManifestDigest: setupInfo.runtimePayloads[key].digest,
    setupInfoSchema: setupInfo.schema,
    setupRuntimeKeys: setupKeys,
    compatibility,
    appTreeDigest: treeIdentity(appRoot),
    nativeAddonSelftests: 'passed',
    exactHostSetupSelection: 'passed',
  }
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      app: { type: 'string' },
      arch: { type: 'string' },
      inputs: { type: 'string' },
      'source-commit': { type: 'string' },
    },
  })
  if (!values.app || !values.arch) {
    throw new LinuxThinVerificationError(
      'usage: verify-linux-thin-app.mjs --app <folder> --arch <arm64|x64> [--inputs <path>] [--source-commit <sha>]',
    )
  }
  const report = verifyLinuxThinApp({
    app: resolve(values.app),
    arch: values.arch,
    inputsPath: values.inputs && resolve(values.inputs),
    sourceCommit: values['source-commit'],
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`verify-linux-thin-app: ${err.message}\n`)
    process.exitCode = 1
  }
}
