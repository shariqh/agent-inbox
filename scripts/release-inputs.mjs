import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { parseArgs } from 'node:util'
import {
  MACOS_RUNTIME_KEYS,
  nodeDistributionIdentity,
  targetFor,
} from './runtime-targets.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_RELEASE_INPUTS = resolve(REPO_ROOT, 'release', 'macos-inputs.json')
export { MACOS_RUNTIME_KEYS }
export const RUNTIME_KEYS = MACOS_RUNTIME_KEYS
export const RELEASE_TOOL_PACKAGES = {
  version: 'electron',
  packagerVersion: '@electron/packager',
  rebuildVersion: '@electron/rebuild',
  universalVersion: '@electron/universal',
  osxSignVersion: '@electron/osx-sign',
  dmgVersion: 'electron-installer-dmg',
}
const SHA256_RE = /^[0-9a-f]{64}$/
const VERSION_RE = /^v\d+\.\d+\.\d+$/
const SEMVER_RE = /^\d+\.\d+\.\d+$/

export class ReleaseInputError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ReleaseInputError'
  }
}

export function requireExactKeys(value, expected, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReleaseInputError(`${field} must be an object`)
  }
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new ReleaseInputError(`${field} keys must be exactly: ${wanted.join(', ')}`)
  }
}

export function requireString(value, field, pattern) {
  if (typeof value !== 'string' || !value || (pattern && !pattern.test(value))) {
    throw new ReleaseInputError(`${field} is invalid`)
  }
}

export function validateNodeReleaseInputs(node, runtimeKeys) {
  requireExactKeys(node, ['version', 'modulesAbi', 'distributions'], 'node')
  requireString(node.version, 'node.version', VERSION_RE)
  requireString(node.modulesAbi, 'node.modulesAbi', /^\d+$/)
  requireExactKeys(node.distributions, runtimeKeys, 'node.distributions')

  for (const key of runtimeKeys) {
    const distribution = node.distributions[key]
    requireExactKeys(distribution, ['platform', 'arch', 'archive', 'root', 'url', 'sha256'], `node.distributions.${key}`)
    const target = targetFor(key)
    const expected = nodeDistributionIdentity(node.version, key)
    requireString(distribution.platform, `${key}.platform`)
    requireString(distribution.arch, `${key}.arch`)
    if (distribution.platform !== target.platform || distribution.arch !== target.arch) {
      throw new ReleaseInputError(`${key} platform/arch does not match its runtime key`)
    }
    if (distribution.archive !== expected.archive) {
      throw new ReleaseInputError(`${key}.archive must be ${expected.archive}`)
    }
    if (distribution.root !== expected.root) {
      throw new ReleaseInputError(`${key}.root must be ${expected.root}`)
    }
    if (distribution.url !== expected.url) {
      throw new ReleaseInputError(`${key}.url must be the official Node distribution URL`)
    }
    requireString(distribution.sha256, `${key}.sha256`, SHA256_RE)
  }
  return node
}

export function validateElectronReleaseInputs(electron, fields) {
  requireExactKeys(electron, fields, 'electron')
  for (const [field, version] of Object.entries(electron)) {
    if (field === 'modulesAbi') {
      requireString(version, `electron.${field}`, /^\d+$/)
      continue
    }
    requireString(version, `electron.${field}`, SEMVER_RE)
  }
  return electron
}

export function validateReleaseInputs(value) {
  requireExactKeys(
    value,
    ['schema', 'product', 'bundleId', 'minimumMacosVersion', 'node', 'electron'],
    'release inputs',
  )
  if (value.schema !== 1) throw new ReleaseInputError(`unsupported release input schema: ${value.schema}`)
  requireString(value.product, 'product')
  requireString(value.bundleId, 'bundleId', /^[A-Za-z0-9.-]+$/)
  requireString(value.minimumMacosVersion, 'minimumMacosVersion', /^\d+\.\d+$/)
  validateNodeReleaseInputs(value.node, RUNTIME_KEYS)
  validateElectronReleaseInputs(
    value.electron,
    ['version', 'packagerVersion', 'rebuildVersion', 'universalVersion', 'osxSignVersion', 'dmgVersion'],
  )
  return value
}

export function loadReleaseInputs(path = DEFAULT_RELEASE_INPUTS) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new ReleaseInputError(`could not read release inputs at ${path}: ${err.message}`)
  }
  return validateReleaseInputs(parsed)
}

export function validateInstalledReleaseToolsFor(inputs, toolPackages, repoRoot = REPO_ROOT) {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(resolve(repoRoot, 'package-lock.json'), 'utf8'))
  for (const [field, packageName] of Object.entries(toolPackages)) {
    const expected = inputs.electron[field]
    const rootPin = pkg.devDependencies?.[packageName]
    const lockPin = lock.packages?.['']?.devDependencies?.[packageName]
    const locked = lock.packages?.[`node_modules/${packageName}`]?.version
    let installed
    try {
      installed = JSON.parse(
        readFileSync(resolve(repoRoot, 'node_modules', packageName, 'package.json'), 'utf8'),
      ).version
    } catch (err) {
      throw new ReleaseInputError(`could not verify installed ${packageName}: ${err.message}`)
    }
    if (rootPin !== expected || lockPin !== expected || locked !== expected || installed !== expected) {
      throw new ReleaseInputError(
        `${packageName} version mismatch: manifest=${expected}, package=${rootPin}, lock=${lockPin}, locked=${locked}, installed=${installed}`,
      )
    }
  }
  return inputs
}

export function validateInstalledReleaseTools(inputs, repoRoot = REPO_ROOT) {
  return validateInstalledReleaseToolsFor(inputs, RELEASE_TOOL_PACKAGES, repoRoot)
}
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function verifyArchiveDigest(path, expectedSha256) {
  if (!SHA256_RE.test(expectedSha256)) throw new ReleaseInputError('expected archive SHA-256 is invalid')
  const actual = sha256File(path)
  if (actual !== expectedSha256) {
    throw new ReleaseInputError(`archive SHA-256 mismatch: expected ${expectedSha256}, found ${actual}`)
  }
  return actual
}

export async function downloadArchive({ url, destination, expectedSha256, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') throw new ReleaseInputError('no fetch implementation is available')
  await mkdir(dirname(destination), { recursive: true })
  const partial = `${destination}.partial-${process.pid}`
  rmSync(partial, { force: true })
  try {
    let response
    try {
      response = await fetchImpl(url, { redirect: 'error' })
    } catch (err) {
      throw new ReleaseInputError(`download failed for ${url}: ${err.message}`)
    }

    if (!response?.ok || !response.body) {
      throw new ReleaseInputError(`download failed for ${url}: HTTP ${response?.status ?? 'unknown'}`)
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: 'wx', mode: 0o600 }))
    verifyArchiveDigest(partial, expectedSha256)
    if (existsSync(destination)) {
      verifyArchiveDigest(destination, expectedSha256)
      rmSync(partial, { force: true })
    } else {
      renameSync(partial, destination)
    }
    return destination
  } catch (err) {
    rmSync(partial, { force: true })
    throw err
  }
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      inputs: { type: 'string' },
      'node-version': { type: 'boolean' },
    },
  })
  const inputs = loadReleaseInputs(values.inputs && resolve(values.inputs))
  if (values['node-version']) {
    process.stdout.write(`${inputs.node.version.slice(1)}\n`)
    return
  }
  validateInstalledReleaseTools(inputs)
  process.stdout.write(`${JSON.stringify({
    ok: true,
    nodeVersion: inputs.node.version,
    nodeModulesAbi: inputs.node.modulesAbi,
    runtimeKeys: RUNTIME_KEYS,
  })}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`release-inputs: ${err.message}\n`)
    process.exitCode = 1
  }
}
