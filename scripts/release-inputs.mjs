import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { parseArgs } from 'node:util'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_RELEASE_INPUTS = resolve(REPO_ROOT, 'release', 'macos-inputs.json')
export const RUNTIME_KEYS = ['darwin-arm64', 'darwin-x64']
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

function requireExactKeys(value, expected, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReleaseInputError(`${field} must be an object`)
  }
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new ReleaseInputError(`${field} keys must be exactly: ${wanted.join(', ')}`)
  }
}

function requireString(value, field, pattern) {
  if (typeof value !== 'string' || !value || (pattern && !pattern.test(value))) {
    throw new ReleaseInputError(`${field} is invalid`)
  }
}

export function validateReleaseInputs(value) {
  requireExactKeys(value, ['schema', 'product', 'bundleId', 'node', 'electron'], 'release inputs')
  if (value.schema !== 1) throw new ReleaseInputError(`unsupported release input schema: ${value.schema}`)
  requireString(value.product, 'product')
  requireString(value.bundleId, 'bundleId', /^[A-Za-z0-9.-]+$/)

  requireExactKeys(value.node, ['version', 'modulesAbi', 'distributions'], 'node')
  requireString(value.node.version, 'node.version', VERSION_RE)
  requireString(value.node.modulesAbi, 'node.modulesAbi', /^\d+$/)
  requireExactKeys(value.node.distributions, RUNTIME_KEYS, 'node.distributions')

  for (const key of RUNTIME_KEYS) {
    const distribution = value.node.distributions[key]
    requireExactKeys(distribution, ['platform', 'arch', 'archive', 'root', 'url', 'sha256'], `node.distributions.${key}`)
    const [, expectedArch] = key.split('-')
    const expectedArchive = `node-${value.node.version}-${key}.tar.xz`
    requireString(distribution.platform, `${key}.platform`)
    requireString(distribution.arch, `${key}.arch`)
    if (distribution.platform !== 'darwin' || distribution.arch !== expectedArch) {
      throw new ReleaseInputError(`${key} platform/arch does not match its runtime key`)
    }
    if (distribution.archive !== expectedArchive) {
      throw new ReleaseInputError(`${key}.archive must be ${expectedArchive}`)
    }
    const expectedRoot = expectedArchive.replace(/\.tar\.xz$/, '')
    if (distribution.root !== expectedRoot) {
      throw new ReleaseInputError(`${key}.root must be ${expectedRoot}`)
    }
    const expectedUrl = `https://nodejs.org/dist/${value.node.version}/${expectedArchive}`
    if (distribution.url !== expectedUrl) {
      throw new ReleaseInputError(`${key}.url must be the official Node distribution URL`)
    }
    requireString(distribution.sha256, `${key}.sha256`, SHA256_RE)
  }

  requireExactKeys(
    value.electron,
    ['version', 'packagerVersion', 'rebuildVersion', 'universalVersion', 'osxSignVersion', 'dmgVersion'],
    'electron',
  )
  for (const [field, version] of Object.entries(value.electron)) {
    requireString(version, `electron.${field}`, SEMVER_RE)
  }
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

export function validateInstalledReleaseTools(inputs, repoRoot = REPO_ROOT) {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(resolve(repoRoot, 'package-lock.json'), 'utf8'))
  for (const [field, packageName] of Object.entries(RELEASE_TOOL_PACKAGES)) {
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
