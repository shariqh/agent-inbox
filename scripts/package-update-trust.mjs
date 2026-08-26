import { lstatSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const verifier = require('../electron/update-manifest.cjs')
const sourceRoot = resolve(import.meta.dirname, '..')

export class PackagedUpdateTrustError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PackagedUpdateTrustError'
  }
}

function requirePlainFile(path, label) {
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    throw new PackagedUpdateTrustError(`packaged app is missing ${label}: ${error.message}`)
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
    throw new PackagedUpdateTrustError(`${label} must be a nonempty plain file`)
  }
}

export function verifyPackagedUpdateTrust(appResources) {
  const root = resolve(appResources)
  const verifierPath = join(root, 'electron', 'update-manifest.cjs')
  const boundaryPath = join(root, 'electron', 'update-trust.cjs')
  const registryPath = join(root, 'release', 'update-keys.json')
  requirePlainFile(verifierPath, 'update manifest verifier')
  requirePlainFile(boundaryPath, 'update trust initialization boundary')
  requirePlainFile(registryPath, 'update key registry')

  const packagedVerifier = readFileSync(verifierPath)
  const expectedVerifier = readFileSync(join(sourceRoot, 'electron', 'update-manifest.cjs'))
  const packagedBoundary = readFileSync(boundaryPath)
  const expectedBoundary = readFileSync(join(sourceRoot, 'electron', 'update-trust.cjs'))
  const packagedRegistry = readFileSync(registryPath)
  const expectedRegistry = readFileSync(join(sourceRoot, 'release', 'update-keys.json'))
  if (
    !packagedVerifier.equals(expectedVerifier)
    || !packagedBoundary.equals(expectedBoundary)
    || !packagedRegistry.equals(expectedRegistry)
  ) {
    throw new PackagedUpdateTrustError(
      'packaged update trust runtime or key registry does not match the trusted release source',
    )
  }
  const registry = verifier.parseRegistry(packagedRegistry)
  return {
    signingKeyId: registry.signingKeyId,
    trustedKeyIds: registry.keys.map((key) => key.keyId).sort(),
  }
}
