export type {
  Ed25519KeyId,
  UpdateRegistryKey,
  UpdateRegistry,
  UpdateTargetPlatform,
  UpdateTargetArchitecture,
  UpdateTargetPackageType,
  UpdateInstallStrategy,
  UpdateManifestTarget,
  UpdateManifest,
  UpdateManifestSignature,
  UpdateManifestEnvelope,
} from '../electron/update-manifest.d.cts'

export {
  UPDATE_REGISTRY_SCHEMA,
  UPDATE_MANIFEST_SCHEMA,
  UPDATE_MANIFEST_KIND,
  UPDATE_REPOSITORY,
  MANIFEST_LIFETIME_DAYS,
  MANIFEST_ASSET_NAME,
  SIGNATURE_ASSET_NAME,
  UpdateManifestError,
  deriveKeyId,
  parseRegistry,
  validateRegistry,
  validateManifest,
  parseManifest,
  serializeEnvelope,
  validateEnvelope,
  parseEnvelope,
  verifyManifest,
} from '../electron/update-manifest.d.cts'

import type { UpdateRegistry, UpdateManifest, UpdateManifestEnvelope } from '../electron/update-manifest.d.cts'

/**
 * Release evidence describing one built/uploaded update artifact. Field names
 * mirror `ReleaseAssetEvidence` from `release-aggregation.mjs`, but
 * `platform`/`architecture`/`packageType` are the manifest-normalized values
 * (e.g. `platform: 'darwin'`, `architecture: 'x64'`, `packageType: 'appimage'`)
 * rather than the raw per-tool strings (`macos`/`x86_64`/`AppImage`, etc.). The
 * caller integrating real release aggregation evidence is responsible for
 * mapping into this normalized shape before calling `generateManifest`.
 */
export type ReleaseAssetEvidence = {
  name: string
  packageType: 'dmg' | 'appimage' | 'deb'
  platform: 'darwin' | 'linux'
  architecture: 'universal' | 'x64' | 'arm64'
  size: number
  sha256: string
}

export type ReleaseEvidence = {
  tag: string
  packageVersion: string
  sourceCommit: string
  sourceTree: string
  assets: readonly ReleaseAssetEvidence[]
}

export function generateManifest(options: {
  registry: UpdateRegistry
  evidence: ReleaseEvidence
  minimumMacosVersion: string
  publishedAt: string | Date
}): { manifest: UpdateManifest; bytes: Buffer }

export function serializeManifest(manifest: UpdateManifest): Buffer

export function signManifest(options: {
  manifestBytes: Buffer
  registry: UpdateRegistry
  privateKeyPem: string | Buffer
  now?: string | Date
}): { envelope: UpdateManifestEnvelope; bytes: Buffer }

/** Minimal shape of a GitHub REST API release, restricted to the fields used here. */
export type ReleaseAssetLike = {
  id: number
  name: string
  size: number
  browser_download_url: string
  /**
   * Optional GitHub API asset content digest. GitHub's REST API may omit this
   * field, report it as `null`, or (matching existing publisher behavior)
   * report an empty string when a digest is unavailable — all three mean "no
   * digest". Any other value must be exactly `sha256:<64 lowercase hex>`.
   */
  digest?: string | null
}

export type ReleaseLike = {
  tag_name: string
  draft: boolean
  prerelease: boolean
  assets: readonly ReleaseAssetLike[]
}

export type ReleaseHistoryBootstrapPlan = {
  mode: 'bootstrap'
  priorTag: null
}

export type ReleaseHistoryContinuityPlan = {
  mode: 'continuity'
  priorTag: string
  manifestAsset: { id: number; name: string; size: number; url: string; digest?: string }
  signatureAsset: { id: number; name: string; size: number; url: string; digest?: string }
}

export type ReleaseHistoryPlan = ReleaseHistoryBootstrapPlan | ReleaseHistoryContinuityPlan

/**
 * Anti-brick release-history assessment. Filters `releases` to published
 * (`draft:false`), non-prerelease (`prerelease:false`) releases whose
 * `tag_name` is a strict stable `vX.Y.Z` tag, rejects any such prior release
 * whose version is `>= newTag`'s version, rejects a release carrying only one
 * of the manifest/signature asset pair, and requires the latest qualifying
 * prior release to carry both assets unless no qualifying prior release
 * carries either (bootstrap).
 */
export function planReleaseHistoryContinuity(options: {
  releases: readonly ReleaseLike[]
  newTag: string
}): ReleaseHistoryPlan

export type ReleaseContinuityAuthorization = {
  authorized: true
  priorManifest: UpdateManifest
  priorTag: string
  rotationOverrideUsed: boolean
}

/**
 * Verifies a downloaded prior manifest/signature pair against the CURRENT
 * registry (structure + signature only; current expiry is not applied) and
 * requires the current registry's `signingKeyId` to already be present in the
 * prior manifest's `trustedKeyIds`, unless `rotationOverride` exactly equals
 * `` `ALLOW-UPDATE-KEY-ROTATION:${newTag}:${registry.signingKeyId}` ``, which
 * bypasses only that membership check.
 */
export function authorizeReleaseContinuity(options: {
  priorManifestBytes: Buffer
  priorSignatureBytes: Buffer
  registry: UpdateRegistry
  newTag: string
  rotationOverride?: string
}): ReleaseContinuityAuthorization
