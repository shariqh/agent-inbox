#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { APP_NAME, findNativeAddon } from './build-thin-app.mjs'
import { assertRuntimeSourceCommit } from './runtime-provenance.mjs'
import { verifyPayload } from './runtime-payload.mjs'
import { treeIdentity } from './tree-identity.mjs'
import {
  assertPeTreeCompatibility,
  assertProcessIdentity,
} from './windows-binary-gates.mjs'
import { loadWindowsReleaseInputs } from './windows-release-inputs.mjs'

const require = createRequire(import.meta.url)
const { selectRuntimePayload } = require('../electron/setup-runner.cjs')

export class WindowsThinVerificationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'WindowsThinVerificationError'
  }
}

export const WINDOWS_PROCESS_PROBE = [
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
  const env = { ...process.env }
  if (electron) {
    env.ELECTRON_RUN_AS_NODE = '1'
    env.AGENT_INBOX_ELECTRON_PROBE = '1'
  } else {
    delete env.ELECTRON_RUN_AS_NODE
    delete env.AGENT_INBOX_ELECTRON_PROBE
  }
  try {
    const stdout = execFileSync(executable, ['-e', WINDOWS_PROCESS_PROBE], {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    })
    return JSON.parse(stdout)
  } catch (err) {
    throw new WindowsThinVerificationError(
      `failed native process/addon probe for ${executable}: ${err.message}`,
    )
  }
}

function assertElectronNotices(app) {
  for (const name of ['LICENSE', 'LICENSES.chromium.html']) {
    const path = join(app, name)
    if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
      throw new WindowsThinVerificationError(`packaged Windows app is missing nonempty ${name}`)
    }
  }
}

function assertNoBuilderPaths(value) {
  if (!value || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value)) {
    if (['repoRoot', 'nodeBin', 'sourceRoot'].includes(key)) {
      throw new WindowsThinVerificationError(`release setup-info must not contain builder-local ${key}`)
    }
    assertNoBuilderPaths(nested)
  }
}

function relativeAppPath(appRoot, path) {
  return relative(appRoot, path).split(sep).join('/')
}

function assertKnownPeEvidence(appRoot, compatibility, knownFiles) {
  const gated = new Set(compatibility.map((entry) => entry.path.toLowerCase()))
  for (const [label, path] of Object.entries(knownFiles)) {
    const relativePath = relativeAppPath(appRoot, path)
    if (!gated.has(relativePath.toLowerCase())) {
      throw new WindowsThinVerificationError(
        `${label} is not a gated plain PE inside the packaged app: ${relativePath}`,
      )
    }
  }
}

export function verifyWindowsThinApp({
  app,
  inputsPath,
  sourceCommit,
}) {
  const inputs = loadWindowsReleaseInputs(inputsPath)
  const key = 'win32-x64'
  const appRoot = resolve(app)
  const executable = join(appRoot, `${APP_NAME}.exe`)
  const resources = join(appRoot, 'resources', 'app')
  const runtimeRoot = join(resources, 'runtime', key)
  const electronAddon = findNativeAddon(resources)
  const runtimeNode = join(runtimeRoot, 'node.exe')
  const runtimeAddon = findNativeAddon(runtimeRoot)
  assertElectronNotices(appRoot)

  const setupInfo = JSON.parse(readFileSync(join(resources, 'setup-info.json'), 'utf8'))
  if (setupInfo.schema !== 2) {
    throw new WindowsThinVerificationError(`release setup-info schema must be 2, found ${String(setupInfo.schema)}`)
  }
  const setupKeys = Object.keys(setupInfo.runtimePayloads ?? {})
  if (setupKeys.length !== 1 || setupKeys[0] !== key) {
    throw new WindowsThinVerificationError(`release setup-info runtime keys must be exactly ${key}`)
  }
  assertNoBuilderPaths(setupInfo)
  const selection = selectRuntimePayload({
    appRoot: resources,
    platform: 'win32',
    arch: 'x64',
    info: setupInfo,
  })
  if (selection.ok || selection.key !== key || selection.reason !== 'unsupported-platform') {
    throw new WindowsThinVerificationError(
      `Windows Setup must remain unavailable for ${key}: ${selection.reason ?? 'unexpected selection'}`,
    )
  }

  const distribution = inputs.node.distributions[key]
  const runtimeManifest = verifyPayload({
    root: runtimeRoot,
    expect: {
      product: 'agent-inbox-runtime',
      packageVersion: setupInfo.version,
      platform: 'win32',
      arch: 'x64',
      nodeVersion: inputs.node.version,
      nodeModulesAbi: inputs.node.modulesAbi,
      ...(sourceCommit ? { sourceCommit } : {}),
    },
  })
  if (sourceCommit) assertRuntimeSourceCommit(runtimeManifest, sourceCommit, key)

  const compatibility = assertPeTreeCompatibility({ root: appRoot, arch: 'x64' })
  assertKnownPeEvidence(appRoot, compatibility, {
    'Electron executable': executable,
    'Electron-ABI addon': electronAddon,
    'runtime Node': runtimeNode,
    'Node-ABI addon': runtimeAddon,
  })
  const electronProbe = assertProcessIdentity({
    actual: processProbe(executable, resources, true),
    expected: {
      platform: 'win32',
      arch: 'x64',
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
    arch: 'x64',
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
    setupAvailable: false,
  }
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      app: { type: 'string' },
      inputs: { type: 'string' },
      'source-commit': { type: 'string' },
    },
  })
  if (!values.app) {
    throw new WindowsThinVerificationError(
      'usage: verify-windows-thin-app.mjs --app <folder> [--inputs <path>] [--source-commit <sha>]',
    )
  }
  const report = verifyWindowsThinApp({
    app: resolve(values.app),
    inputsPath: values.inputs && resolve(values.inputs),
    sourceCommit: values['source-commit'],
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`verify-windows-thin-app: ${err.message}\n`)
    process.exitCode = 1
  }
}
