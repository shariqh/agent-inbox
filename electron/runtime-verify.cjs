const { createHash } = require('node:crypto')
const { existsSync, lstatSync, readFileSync, readdirSync } = require('node:fs')
const { isAbsolute, join } = require('node:path')

const MANIFEST_FILE = 'runtime-manifest.json'
const MANIFEST_SCHEMA = 1
const SHA256 = /^[0-9a-f]{64}$/
const EXPECTED_PRODUCT = 'agent-inbox-runtime'
const EXPECTED_NODE_MAJOR = 24
const EXPECTED_NODE_MODULES_ABI = '137'
const REQUIRED_ENTRYPOINTS = [
  'dist/mcp-server.js',
  'dist/hook-cli.js',
  'dist/watch-cli.js',
]
const REQUIRED_FILES = [
  'scripts/install-agents.sh',
  'scripts/runtime-payload.mjs',
  'scripts/runtime-config.mjs',
]

class RuntimeVerificationError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'RuntimeVerificationError'
    this.code = code
  }
}

function fail(code, message) {
  throw new RuntimeVerificationError(code, message)
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function safeName(value, field) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' ||
      value.includes('/') || value.includes('\\') || value.includes('\0')) {
    fail('invalid-manifest', `manifest.${field} is not a safe runtime identity component`)
  }
}

function safeRelativePath(path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || /^[A-Za-z]:/.test(path)) {
    fail('invalid-manifest', `unsafe manifest path: ${String(path)}`)
  }
  const segments = path.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    fail('invalid-manifest', `unsafe manifest path: ${path}`)
  }
}

function walkFiles(root, skip) {
  const files = []
  const stack = ['']
  while (stack.length > 0) {
    const relDir = stack.pop()
    const absDir = relDir ? join(root, relDir) : root
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name
      if (skip.has(relPath)) continue
      if (entry.isSymbolicLink()) fail('payload-integrity', `symlink not allowed in payload: ${relPath}`)
      if (entry.isDirectory()) {
        stack.push(relPath)
      } else if (entry.isFile()) {
        files.push(relPath)
      } else {
        fail('payload-integrity', `unsupported file type in payload: ${relPath}`)
      }
    }
  }
  files.sort()
  return files
}

function computePayloadDigest(manifest) {
  const hash = createHash('sha256')
  hash.update(JSON.stringify({
    product: manifest.product,
    packageVersion: manifest.packageVersion,
    sourceCommit: manifest.sourceCommit ?? null,
    platform: manifest.platform,
    arch: manifest.arch,
    nodeVersion: manifest.nodeVersion,
    nodeModulesAbi: manifest.nodeModulesAbi,
    entrypoints: [...manifest.entrypoints].sort(),
  }))
  hash.update('\n')
  for (const file of manifest.files) {
    hash.update(`${file.path}\u0000${file.size}\u0000${file.mode.toString(8)}\u0000${file.sha256}\n`)
  }
  return hash.digest('hex')
}

function computeRuntimeId(manifest, payloadDigest) {
  return `${manifest.product}-${manifest.packageVersion}-${manifest.platform}-${manifest.arch}-${payloadDigest.slice(0, 16)}`
}

function nodeMajor(version) {
  const match = typeof version === 'string' ? /^v?(\d+)\.\d+\.\d+(?:[-+].*)?$/.exec(version) : null
  return match ? Number(match[1]) : null
}

function verifyRuntimePayload({
  root,
  expectedManifestDigest,
  expectedPlatform,
  expectedArch,
  expectedPackageVersion,
  expectedProduct = EXPECTED_PRODUCT,
  expectedNodeMajor = EXPECTED_NODE_MAJOR,
  expectedNodeModulesAbi = EXPECTED_NODE_MODULES_ABI,
  requiredEntrypoints = REQUIRED_ENTRYPOINTS,
  requiredFiles = REQUIRED_FILES,
}) {
  let rootStat
  try {
    rootStat = lstatSync(root)
  } catch {
    fail('not-found', `runtime payload does not exist: ${root}`)
  }
  if (rootStat.isSymbolicLink()) fail('symlinked-payload', `runtime payload is a symlink: ${root}`)
  if (!rootStat.isDirectory()) fail('not-a-directory', `runtime payload is not a directory: ${root}`)

  const manifestPath = join(root, MANIFEST_FILE)
  if (!existsSync(manifestPath)) fail('missing-manifest', `no ${MANIFEST_FILE} in ${root}`)
  const manifestStat = lstatSync(manifestPath)
  if (manifestStat.isSymbolicLink()) fail('symlinked-payload', `${MANIFEST_FILE} is a symlink`)
  if (!manifestStat.isFile()) fail('invalid-manifest', `${MANIFEST_FILE} is not a regular file`)

  const manifestDigest = sha256File(manifestPath)
  if (expectedManifestDigest !== undefined) {
    const expectedHex = typeof expectedManifestDigest === 'string'
      ? expectedManifestDigest.replace(/^sha256:/i, '').toLowerCase()
      : ''
    if (!SHA256.test(expectedHex) || manifestDigest !== expectedHex) {
      fail('digest-mismatch', `${MANIFEST_FILE} digest does not match setup metadata`)
    }
  }

  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    fail('invalid-manifest', `${MANIFEST_FILE} is not valid JSON: ${err.message}`)
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('invalid-manifest', `${MANIFEST_FILE} is not an object`)
  }
  if (manifest.schema !== MANIFEST_SCHEMA) fail('invalid-manifest', `unsupported manifest schema: ${manifest.schema}`)

  for (const field of ['product', 'packageVersion', 'platform', 'arch']) safeName(manifest[field], field)
  for (const field of ['nodeVersion', 'nodeModulesAbi', 'payloadDigest', 'runtimeId']) {
    if (typeof manifest[field] !== 'string' || !manifest[field]) {
      fail('invalid-manifest', `manifest.${field} is missing`)
    }
  }
  const actualNodeMajor = nodeMajor(manifest.nodeVersion)
  if (actualNodeMajor === null) fail('invalid-manifest', 'manifest.nodeVersion is not a valid Node version')
  if (!/^\d+$/.test(manifest.nodeModulesAbi)) {
    fail('invalid-manifest', 'manifest.nodeModulesAbi is not numeric')
  }
  safeName(manifest.runtimeId, 'runtimeId')
  if (manifest.sourceCommit !== null && typeof manifest.sourceCommit !== 'string') {
    fail('invalid-manifest', 'manifest.sourceCommit must be a string or null')
  }
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.entrypoints) || manifest.entrypoints.length === 0) {
    fail('invalid-manifest', 'manifest files or entrypoints are missing')
  }

  if (expectedPlatform && manifest.platform !== expectedPlatform) fail('manifest-mismatch', 'manifest platform mismatch')
  if (expectedArch && manifest.arch !== expectedArch) fail('manifest-mismatch', 'manifest architecture mismatch')
  if (expectedPackageVersion && manifest.packageVersion !== expectedPackageVersion) {
    fail('manifest-mismatch', 'manifest package version mismatch')
  }
  if (expectedProduct && manifest.product !== expectedProduct) fail('manifest-mismatch', 'manifest product mismatch')
  if (expectedNodeMajor !== undefined && actualNodeMajor !== expectedNodeMajor) {
    fail('manifest-mismatch', 'manifest Node major mismatch')
  }
  if (expectedNodeModulesAbi !== undefined && manifest.nodeModulesAbi !== String(expectedNodeModulesAbi)) {
    fail('manifest-mismatch', 'manifest Node modules ABI mismatch')
  }

  const seen = new Set()
  for (const file of manifest.files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) fail('invalid-manifest', 'malformed file record')
    safeRelativePath(file.path)
    if (!Number.isSafeInteger(file.size) || file.size < 0 ||
        !Number.isSafeInteger(file.mode) || file.mode < 0 || file.mode > 0o777 ||
        typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)) {
      fail('invalid-manifest', `malformed file record: ${file.path}`)
    }
    if (seen.has(file.path)) fail('invalid-manifest', `duplicate manifest path: ${file.path}`)
    seen.add(file.path)
  }

  const onDisk = walkFiles(root, new Set([MANIFEST_FILE]))
  const onDiskSet = new Set(onDisk)
  for (const path of onDisk) {
    if (!seen.has(path)) fail('payload-integrity', `unmanifested file present: ${path}`)
  }
  for (const path of seen) {
    if (!onDiskSet.has(path)) fail('payload-integrity', `manifested file missing: ${path}`)
  }

  for (const file of manifest.files) {
    const path = join(root, file.path)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) fail('payload-integrity', `symlink not allowed: ${file.path}`)
    if (!stat.isFile()) fail('payload-integrity', `not a regular file: ${file.path}`)
    if (stat.size !== file.size) fail('payload-integrity', `size mismatch: ${file.path}`)
    if ((stat.mode & 0o777) !== file.mode) fail('payload-integrity', `mode mismatch: ${file.path}`)
    if (sha256File(path) !== file.sha256) fail('payload-integrity', `checksum mismatch: ${file.path}`)
  }

  for (const entrypoint of manifest.entrypoints) {
    safeRelativePath(entrypoint)
    if (!seen.has(entrypoint)) fail('invalid-manifest', `entrypoint missing from payload: ${entrypoint}`)
  }
  for (const entrypoint of requiredEntrypoints) {
    if (!manifest.entrypoints.includes(entrypoint) || !seen.has(entrypoint)) {
      fail('manifest-mismatch', `required runtime entrypoint missing: ${entrypoint}`)
    }
  }
  for (const file of requiredFiles) {
    if (!seen.has(file)) fail('manifest-mismatch', `required runtime file missing: ${file}`)
  }

  const payloadDigest = computePayloadDigest(manifest)
  if (payloadDigest !== manifest.payloadDigest || !SHA256.test(manifest.payloadDigest)) {
    fail('invalid-manifest', 'payload digest mismatch')
  }
  const runtimeId = computeRuntimeId(manifest, payloadDigest)
  if (runtimeId !== manifest.runtimeId) fail('invalid-manifest', 'runtimeId mismatch')

  return { manifest, manifestDigest, manifestPath }
}

module.exports = {
  EXPECTED_NODE_MAJOR,
  EXPECTED_NODE_MODULES_ABI,
  EXPECTED_PRODUCT,
  MANIFEST_FILE,
  REQUIRED_ENTRYPOINTS,
  REQUIRED_FILES,
  RuntimeVerificationError,
  verifyRuntimePayload,
}
