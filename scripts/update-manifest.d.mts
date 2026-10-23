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
  UpdateManifestV2,
  UpdateManifestSignature,
  UpdateManifestEnvelope,
} from '../electron/update-manifest.d.cts'

export {
  UPDATE_REGISTRY_SCHEMA,
  UPDATE_MANIFEST_SCHEMA,
  UPDATE_MANIFEST_SCHEMA_V2,
  UPDATE_ENVELOPE_SCHEMA,
  UPDATE_MANIFEST_KIND,
  UPDATE_REPOSITORY,
  MANIFEST_LIFETIME_DAYS,
  MANIFEST_ASSET_NAME,
  SIGNATURE_ASSET_NAME,
  MANIFEST_V2_ASSET_NAME,
  SIGNATURE_V2_ASSET_NAME,
  UpdateManifestError,
  deriveKeyId,
  parseRegistry,
  validateRegistry,
  validateManifest,
  parseManifest,
  validateManifestV2,
  parseManifestV2,
  serializeEnvelope,
  validateEnvelope,
  parseEnvelope,
  verifyManifest,
  verifyManifestV2,
} from '../electron/update-manifest.d.cts'

import type {
  UpdateRegistry,
  UpdateRegistryKey,
  UpdateManifest,
  UpdateManifestV2,
  UpdateManifestEnvelope,
} from '../electron/update-manifest.d.cts'
import type { MacosReleaseKind } from './macos-release-kind.mjs'

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

/** Signs a schema 1 or schema 2 manifest's exact bytes; either way the envelope is schema 1. */
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

// ---------------------------------------------------------------------------
// Update manifest v2 (#343; design §5 to §7): the publisher's pure functions.
// ---------------------------------------------------------------------------

/** The only key apps from 1.2 to 1.6 trust; every v1 manifest must carry its signature (G10). */
export const ORIGINAL_UPDATE_KEY: Readonly<UpdateRegistryKey>

/**
 * This release's update-manifest-v2.json: exactly its own DMG (universal or arm64, from
 * the measured kind) and the four Linux packages, a 180-day lifetime, serialized like v1.
 */
export function generateManifestV2(options: {
  registry: UpdateRegistry
  evidence: ReleaseEvidence
  minimumMacosVersion: string
  publishedAt: string | Date
  kind: MacosReleaseKind
}): { manifest: UpdateManifestV2; bytes: Buffer }

export function serializeManifestV2(manifest: UpdateManifestV2): Buffer

/**
 * The v1 manifest of a universal release: the v2 data with schema 1 and only the five
 * schema-1 types, all required. Byte-identical to generateManifest for the same evidence.
 */
export function projectV1(v2ManifestBytes: Buffer | string): { manifest: UpdateManifest; bytes: Buffer }

export type RestampedManifest = {
  manifest: UpdateManifest
  bytes: Buffer
  /** The tag of the universal release the re-stamped manifest describes. */
  describes: string
  earlierManifestSha256: string
  targets: ReadonlyArray<{ filename: string; byteLength: number; sha256: string }>
}

/**
 * The frozen v1 manifest of an arm64 release (design §5.3): the verified earlier v1
 * manifest with only publishedAt, expiresAt, signingKeyId and trustedKeyIds changed. It
 * must describe an older release, the newest published one with a universal DMG, whose
 * listed files match every copied target.
 */
export function restampV1(options: {
  earlierManifestBytes: Buffer | string
  earlierSignatureBytes: Buffer | string
  registry: UpdateRegistry
  newTag: string
  publishedAt: string | Date
  releases: readonly ReleaseLike[]
}): RestampedManifest

export type ManifestHistoryName = 'v1' | 'v2'

export type ManifestHistoryAsset = { id: number; name: string; size: number; url: string; digest?: string }

export type ManifestHistoryBootstrapPlan = {
  manifest: ManifestHistoryName
  mode: 'bootstrap'
  priorTag: null
}

export type ManifestHistoryContinuityPlan = {
  manifest: ManifestHistoryName
  mode: 'continuity'
  priorTag: string
  /** From the release before's own DMG name; null when it lists neither. */
  priorKind: MacosReleaseKind | null
  manifestAsset: ManifestHistoryAsset
  signatureAsset: ManifestHistoryAsset
}

export type ManifestHistoryPlan = ManifestHistoryBootstrapPlan | ManifestHistoryContinuityPlan

/**
 * Both manifests' release history for a new release of this macOS kind (G1 to G5): every
 * published stable release is older, no release carries half of either pair, once a
 * manifest has been published the release before carries it, and only a universal release
 * may publish the first of either.
 */
export function planReleaseHistory(options: {
  releases: readonly ReleaseLike[]
  newTag: string
  kind: MacosReleaseKind
}): { v1: ManifestHistoryPlan; v2: ManifestHistoryPlan }

export type ManifestHistoryAuthorization =
  | {
    manifest: ManifestHistoryName
    authorized: true
    mode: 'bootstrap'
    priorTag: null
    rotationOverrideUsed: false
  }
  | {
    manifest: ManifestHistoryName
    authorized: true
    mode: 'continuity'
    priorTag: string
    describes: string
    rotationOverrideUsed: boolean
    priorManifest: UpdateManifest | UpdateManifestV2
  }

/**
 * One earlier manifest, under this release's keys and without an expiry check: the bytes
 * GitHub listed; a v2 describing the release before; a v1 describing it when universal or
 * an older release when arm64; and the signing key already trusted, or the exact override.
 */
export function authorizeReleaseHistory(options: {
  plan: ManifestHistoryPlan
  priorManifestBytes?: Buffer | string
  priorSignatureBytes?: Buffer | string
  registry: UpdateRegistry
  newTag: string
  rotationOverride?: string
}): ManifestHistoryAuthorization

export type CheckedRelease = {
  kind: MacosReleaseKind
  dmgName: string
  /** What the signing evidence records about the measured kind (design §5.7). */
  macos: {
    kind: MacosReleaseKind
    architectures: { executable: readonly string[]; betterSqlite3: readonly string[] }
    expected: readonly string[]
  }
  manifest: UpdateManifestV2
  manifestSha256: string
  /** The inputs generateManifestV2 and generateManifest read for this release. */
  generation: { evidence: ReleaseEvidence; minimumMacosVersion: string; publishedAt: string }
}

/**
 * The unsigned v2 manifest against the authorized release (G7, G9). `aggregate`, `context`
 * and `macosInputs` are the parsed release-aggregation evidence, release context and the
 * release commit's release/macos-inputs.json; `packages` is each package file's measured
 * size and SHA-256.
 */
export function checkReleaseManifest(options: {
  manifestBytes: Buffer | string
  aggregate: unknown
  context: unknown
  registryBytes: Buffer | string
  macosInputs: unknown
  packages: Readonly<Record<string, { size: number; sha256: string }>>
  tag: string
  sourceCommit: string
}): CheckedRelease

export type DerivedV1 =
  | { made: 'projection'; describes: string; manifest: UpdateManifest; bytes: Buffer }
  | ({ made: 'restamp' } & RestampedManifest)

/** This release's v1 manifest: a projection (universal, G8) or a re-stamp (arm64, G6). */
export function deriveV1(options: {
  release: CheckedRelease
  v2ManifestBytes: Buffer | string
  registry: UpdateRegistry
  releases: readonly ReleaseLike[]
  earlierManifestBytes?: Buffer | string
  earlierSignatureBytes?: Buffer | string
}): DerivedV1

export type OriginalKeySignature =
  | { originalKeySignature: 'passed' }
  | { originalKeySignature: 'waived'; rotationOverride: string }

/** G10 before signing: passes only when the registry signs with the original key. */
export function planOriginalKeySignature(options: {
  registry: UpdateRegistry
  newTag: string
  rotationOverride?: string
  originalKey?: UpdateRegistryKey
}): OriginalKeySignature

/**
 * G10: the v1 envelope carries a valid signature of these bytes from the original key,
 * or the exact `ALLOW-UPDATE-KEY-ROTATION:<tag>:<signingKeyId>` override waives it.
 */
export function checkOriginalKeySignature(options: {
  manifestBytes: Buffer | string
  envelope: Buffer | string | UpdateManifestEnvelope
  registry: UpdateRegistry
  newTag: string
  rotationOverride?: string
  originalKey?: UpdateRegistryKey
}): OriginalKeySignature

export type SignedFileRecord = { name: string; size: number; sha256: string }

export type SigningHistoryRecord =
  | { mode: 'bootstrap'; priorTag: null; rotationOverrideUsed: false }
  | { mode: 'continuity'; priorTag: string; describes: string; rotationOverrideUsed: boolean }

export type SignedManifestRecord = SignedFileRecord & {
  signature: SignedFileRecord
  version: string
  tag: string
  history: SigningHistoryRecord
}

/** update-signing-evidence.json, schema 2 (design §5.7). */
export type SigningEvidence = {
  schema: 2
  tag: string
  sourceCommit: string
  sourceTree: string
  signingKeyId: string
  trustedKeyIds: string[]
  macos: {
    kind: MacosReleaseKind
    architectures: { executable: string[]; betterSqlite3: string[] }
    expected: string[]
  }
  originalKeySignature: 'passed' | 'waived'
  rotationOverride?: string
  manifests: {
    v2: SignedManifestRecord & { made: 'release' }
    v1: SignedManifestRecord & (
      | { made: 'projection' }
      | { made: 'restamp'; restamp: { earlierManifestSha256: string; targets: Array<{ filename: string; byteLength: number; sha256: string }> } }
    )
  }
  verification: { privateKeyMatchesRegistry: 'passed'; signatures: 'passed' }
}

/**
 * The signing evidence once both manifests are signed: both pairs verify under the registry
 * at `now`, each is the manifest the earlier steps checked or derived, each envelope holds
 * one signature by the signing key, both histories were authorized, and G10 passed or was
 * waived by the exact override. `release`, `history` and `derivation` are the records
 * check-release, authorize-history and derive-v1 wrote.
 */
export function bindSigningEvidence(options: {
  registryBytes: Buffer | string
  aggregate: unknown
  tag: string
  sourceCommit: string
  release: { kind: MacosReleaseKind; macos: CheckedRelease['macos']; manifestSha256: string }
  history: { v1: unknown; v2: unknown }
  derivation: { made: string; describes: string; sha256: string; earlierManifestSha256?: string; targets?: unknown }
  v2: { manifestBytes: Buffer | string; signatureBytes: Buffer | string }
  v1: { manifestBytes: Buffer | string; signatureBytes: Buffer | string }
  now: string | Date
  rotationOverride?: string
  originalKey?: UpdateRegistryKey
}): SigningEvidence

