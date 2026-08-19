#!/usr/bin/env node
import { createHash } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  constants,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  ReleaseInputError,
  requireExactKeys,
  requireString,
} from './release-inputs.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHA256_RE = /^[0-9a-f]{64}$/
const COMMIT_RE = /^[0-9a-f]{40}$/
export const DEFAULT_LINUX_APPIMAGE_INPUTS = resolve(
  REPO_ROOT,
  'release',
  'linux-appimage-x64.json',
)

function requireBoolean(value, field) {
  if (typeof value !== 'boolean') throw new ReleaseInputError(`${field} is invalid`)
}

function requirePositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ReleaseInputError(`${field} is invalid`)
  }
}

export function validateLinuxAppImageInputs(value) {
  requireExactKeys(
    value,
    [
      'schema',
      'target',
      'artifactArchitecture',
      'linuxInputs',
      'tool',
      'runtime',
      'layout',
      'icon',
      'desktop',
    ],
    'Linux AppImage inputs',
  )
  if (value.schema !== 1) {
    throw new ReleaseInputError(`unsupported Linux AppImage input schema: ${value.schema}`)
  }
  if (value.target !== 'linux-x64') {
    throw new ReleaseInputError(`target must be linux-x64, got ${String(value.target)}`)
  }
  if (value.artifactArchitecture !== 'x86_64') {
    throw new ReleaseInputError(
      `artifactArchitecture must be x86_64, got ${String(value.artifactArchitecture)}`,
    )
  }

  requireExactKeys(value.linuxInputs, ['path', 'sha256'], 'linuxInputs')
  if (value.linuxInputs.path !== 'release/linux-inputs.json') {
    throw new ReleaseInputError('linuxInputs.path must be release/linux-inputs.json')
  }
  requireString(value.linuxInputs.sha256, 'linuxInputs.sha256', SHA256_RE)

  requireExactKeys(
    value.tool,
    ['name', 'version', 'sourceCommit', 'url', 'size', 'sha256'],
    'tool',
  )
  if (value.tool.name !== 'appimagetool') {
    throw new ReleaseInputError('tool.name must be appimagetool')
  }
  requireString(value.tool.version, 'tool.version', /^\d+\.\d+\.\d+$/)
  requireString(value.tool.sourceCommit, 'tool.sourceCommit', COMMIT_RE)
  const expectedToolUrl =
    `https://github.com/AppImage/appimagetool/releases/download/${value.tool.version}/` +
    'appimagetool-x86_64.AppImage'
  if (value.tool.url !== expectedToolUrl) {
    throw new ReleaseInputError(`tool.url must be the exact tagged appimagetool release ${expectedToolUrl}`)
  }
  requirePositiveInteger(value.tool.size, 'tool.size')
  requireString(value.tool.sha256, 'tool.sha256', SHA256_RE)

  requireExactKeys(
    value.runtime,
    ['name', 'version', 'sourceCommit', 'url', 'size', 'sha256'],
    'runtime',
  )
  if (value.runtime.name !== 'type2-runtime') {
    throw new ReleaseInputError('runtime.name must be type2-runtime')
  }
  requireString(value.runtime.version, 'runtime.version', /^\d{8}$/)
  requireString(value.runtime.sourceCommit, 'runtime.sourceCommit', COMMIT_RE)
  const expectedRuntimeUrl =
    `https://github.com/AppImage/type2-runtime/releases/download/${value.runtime.version}/` +
    'runtime-x86_64'
  if (value.runtime.url !== expectedRuntimeUrl) {
    throw new ReleaseInputError(`runtime.url must be the exact tagged type2 runtime ${expectedRuntimeUrl}`)
  }
  requirePositiveInteger(value.runtime.size, 'runtime.size')
  requireString(value.runtime.sha256, 'runtime.sha256', SHA256_RE)

  requireExactKeys(
    value.layout,
    ['appRun', 'applicationPath', 'desktopFile', 'iconFile'],
    'layout',
  )
  const expectedLayout = {
    appRun: 'AppRun',
    applicationPath: 'usr/lib/agent-inbox',
    desktopFile: 'agent-inbox.desktop',
    iconFile: 'agent-inbox.png',
  }
  for (const [field, expected] of Object.entries(expectedLayout)) {
    if (value.layout[field] !== expected) {
      throw new ReleaseInputError(`layout.${field} must be ${expected}`)
    }
  }

  requireExactKeys(value.icon, ['path', 'sha256'], 'icon')
  if (value.icon.path !== 'assets/icon-1024.png') {
    throw new ReleaseInputError('icon.path must be assets/icon-1024.png')
  }
  requireString(value.icon.sha256, 'icon.sha256', SHA256_RE)

  requireExactKeys(
    value.desktop,
    ['type', 'name', 'comment', 'exec', 'icon', 'categories', 'terminal'],
    'desktop',
  )
  const expectedDesktop = {
    type: 'Application',
    name: 'Agent Inbox',
    comment: 'Local, cross-project attention inbox for coding agents',
    exec: 'agent-inbox',
    icon: 'agent-inbox',
  }
  for (const [field, expected] of Object.entries(expectedDesktop)) {
    if (value.desktop[field] !== expected) {
      throw new ReleaseInputError(`desktop.${field} must be ${expected}`)
    }
  }
  if (
    !Array.isArray(value.desktop.categories) ||
    JSON.stringify(value.desktop.categories) !== JSON.stringify(['Utility', 'Development'])
  ) {
    throw new ReleaseInputError('desktop.categories must be exactly Utility, Development')
  }
  requireBoolean(value.desktop.terminal, 'desktop.terminal')
  if (value.desktop.terminal) throw new ReleaseInputError('desktop.terminal must be false')
  return value
}

export function loadLinuxAppImageInputs(path = DEFAULT_LINUX_APPIMAGE_INPUTS) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new ReleaseInputError(`could not read Linux AppImage inputs at ${path}: ${err.message}`)
  }
  return validateLinuxAppImageInputs(parsed)
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function verifyPinnedBytes(path, expected, label) {
  let stat
  try {
    stat = lstatSync(path)
  } catch (err) {
    throw new ReleaseInputError(`pinned ${label} is missing at ${path}: ${err.message}`)
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ReleaseInputError(`pinned ${label} must be a plain regular file: ${path}`)
  }
  if (stat.size !== expected.size) {
    throw new ReleaseInputError(
      `pinned ${label} size mismatch: expected ${expected.size}, found ${stat.size}`,
    )
  }
  const actual = sha256File(path)
  if (actual !== expected.sha256) {
    throw new ReleaseInputError(
      `pinned ${label} SHA-256 mismatch: expected ${expected.sha256}, found ${actual}`,
    )
  }
  return path
}

export function verifyPinnedAppImageTool(path, expected) {
  const tool = verifyPinnedBytes(resolve(path), expected, 'appimagetool')
  try {
    accessSync(tool, constants.X_OK)
  } catch (err) {
    throw new ReleaseInputError(`pinned appimagetool is not executable: ${err.message}`)
  }
  return tool
}

export function verifyPinnedAppImageRuntime(path, expected) {
  return verifyPinnedBytes(resolve(path), expected, 'AppImage type-2 runtime')
}

async function acquirePinnedAppImageFile({
  destination,
  expected,
  label,
  executable,
  fetchImpl = globalThis.fetch,
}) {
  const target = resolve(destination)
  if (existsSync(target)) {
    return executable
      ? verifyPinnedAppImageTool(target, expected)
      : verifyPinnedAppImageRuntime(target, expected)
  }
  if (typeof fetchImpl !== 'function') throw new ReleaseInputError('no fetch implementation is available')
  mkdirSync(dirname(target), { recursive: true })
  const partial = `${target}.partial-${process.pid}`
  rmSync(partial, { force: true })
  try {
    let response
    try {
      response = await fetchImpl(expected.url, { redirect: 'follow' })
    } catch (err) {
      throw new ReleaseInputError(`${label} download failed for ${expected.url}: ${err.message}`)
    }
    if (!response?.ok || !response.body) {
      throw new ReleaseInputError(
        `${label} download failed for ${expected.url}: HTTP ${response?.status ?? 'unknown'}`,
      )
    }
    let finalUrl
    try {
      finalUrl = new URL(response.url || expected.url)
    } catch {
      throw new ReleaseInputError(`${label} download returned an invalid final URL`)
    }
    if (finalUrl.protocol !== 'https:') {
      throw new ReleaseInputError(`${label} download left HTTPS: ${finalUrl.href}`)
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { mode: 0o600 }))
    verifyPinnedBytes(partial, expected, label)
    statSync(partial)
    renameSync(partial, target)
    chmodSync(target, executable ? 0o755 : 0o644)
    return executable
      ? verifyPinnedAppImageTool(target, expected)
      : verifyPinnedAppImageRuntime(target, expected)
  } finally {
    rmSync(partial, { force: true })
  }
}

export async function acquirePinnedAppImageTool(options) {
  return acquirePinnedAppImageFile({
    ...options,
    label: 'appimagetool',
    executable: true,
  })
}

export async function acquirePinnedAppImageRuntime(options) {
  return acquirePinnedAppImageFile({
    ...options,
    label: 'AppImage type-2 runtime',
    executable: false,
  })
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      inputs: { type: 'string' },
    },
  })
  const inputs = loadLinuxAppImageInputs(values.inputs && resolve(values.inputs))
  process.stdout.write(`${JSON.stringify({
    ok: true,
    target: inputs.target,
    artifactArchitecture: inputs.artifactArchitecture,
    toolVersion: inputs.tool.version,
    toolSha256: inputs.tool.sha256,
    runtimeVersion: inputs.runtime.version,
    runtimeSha256: inputs.runtime.sha256,
  })}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`linux-appimage-inputs: ${err.message}\n`)
    process.exitCode = 1
  }
}
