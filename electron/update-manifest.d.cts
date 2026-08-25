export const UPDATE_REGISTRY_SCHEMA: 1
export const UPDATE_MANIFEST_SCHEMA: 1
export const UPDATE_MANIFEST_KIND: 'agent-inbox-update-manifest'
export const UPDATE_REPOSITORY: 'shariqh/agent-inbox'
export const MANIFEST_LIFETIME_DAYS: 180
export const MANIFEST_ASSET_NAME: string
export const SIGNATURE_ASSET_NAME: string

export class UpdateManifestError extends Error {}

export type Ed25519KeyId = string

export type UpdateRegistryKey = {
  keyId: Ed25519KeyId
  algorithm: 'ed25519'
  publicKeySpkiBase64: string
}

export type UpdateRegistry = {
  schema: 1
  signingKeyId: Ed25519KeyId
  keys: readonly UpdateRegistryKey[]
}

export type UpdateTargetPlatform = 'darwin' | 'linux'
export type UpdateTargetArchitecture = 'universal' | 'x64' | 'arm64'
export type UpdateTargetPackageType = 'dmg' | 'appimage' | 'deb'
export type UpdateInstallStrategy = 'macos-dmg' | 'appimage-self-replace' | 'deb-notify'

export type UpdateManifestTarget = {
  platform: UpdateTargetPlatform
  architecture: UpdateTargetArchitecture
  packageType: UpdateTargetPackageType
  filename: string
  url: string
  byteLength: number
  sha256: string
  installStrategy: UpdateInstallStrategy
  minimumSystemVersion?: string
}

export type UpdateManifest = {
  schema: 1
  kind: 'agent-inbox-update-manifest'
  repository: 'shariqh/agent-inbox'
  version: string
  tag: string
  source: { commit: string; tree: string }
  publishedAt: string
  expiresAt: string
  releaseUrl: string
  signingKeyId: Ed25519KeyId
  trustedKeyIds: readonly Ed25519KeyId[]
  targets: readonly UpdateManifestTarget[]
}

export type UpdateManifestSignature = {
  algorithm: 'ed25519'
  keyId: Ed25519KeyId
  signature: string
}

export type UpdateManifestEnvelope = {
  schema: 1
  manifestSha256: string
  signatures: readonly UpdateManifestSignature[]
}

/**
 * Internal-but-shared definition of the exact five update targets this
 * manifest schema supports, pre-sorted by
 * `${platform}/${architecture}/${packageType}` (the manifest's required
 * deterministic target order). This is exported so that build-time manifest
 * generation (`scripts/update-manifest.mjs`) and runtime manifest validation
 * share a single source of truth for the target enumeration and filename
 * derivation; it is not part of the documented consumer-facing surface.
 */
export type UpdateManifestTargetSpec = {
  platform: UpdateTargetPlatform
  architecture: UpdateTargetArchitecture
  packageType: UpdateTargetPackageType
  installStrategy: UpdateInstallStrategy
  filename: (tag: string, version: string) => string
}

export const TARGET_SPECS: readonly UpdateManifestTargetSpec[]
export function targetTuple(value: {
  platform: string
  architecture: string
  packageType: string
}): string

/**
 * Derives `ed25519-<first 16 lowercase hex chars of sha256(DER SPKI bytes)>`
 * from a canonical base64-encoded SPKI DER public key. Throws
 * `UpdateManifestError` for non-canonical base64, malformed DER, or a key
 * whose `asymmetricKeyType` is not `ed25519`.
 */
export function deriveKeyId(publicKeySpkiBase64: string): Ed25519KeyId

export function parseRegistry(json: string | Buffer): UpdateRegistry
export function validateRegistry(value: unknown): UpdateRegistry

export function validateManifest(value: unknown): UpdateManifest
export function parseManifest(bytes: string | Buffer): UpdateManifest

export function serializeEnvelope(envelope: UpdateManifestEnvelope): Buffer
/**
 * Validates a detached signature envelope: exact top-level keys
 * `{schema, manifestSha256, signatures}`, `signatures` a non-empty array of
 * exactly `{algorithm:'ed25519', keyId, signature}` entries, no duplicate
 * `keyId`s or `signature`s, canonical base64 decoding to a 64-byte ed25519
 * signature per entry, and entries sorted strictly ascending by `keyId`
 * (structural-only; does not consult a registry).
 */
export function validateEnvelope(value: unknown): UpdateManifestEnvelope
export function parseEnvelope(bytes: string | Buffer): UpdateManifestEnvelope

/**
 * Verifies a detached signature envelope against `manifestBytes` and
 * `registry` (raw-byte verification: `manifestBytes` are hashed and checked
 * against `envelope.manifestSha256`, and each signature is verified over the
 * exact supplied bytes — never a re-serialization of the parsed manifest).
 * Every envelope signature entry is already structurally validated (canonical
 * order, no duplicate `keyId`/`signature`, canonical base64) regardless of
 * whether its `keyId` is present in `registry.keys`. Entries whose `keyId` is
 * absent from the registry are ignored for cryptographic verification — this
 * is not by itself a rejection, so a client that has not yet pulled a
 * registry-expansion build still accepts an envelope carrying
 * `{old known-valid, new unknown}` signatures during key rotation.
 * Verification accepts once at least one entry whose key IS present in the
 * registry cryptographically validates under it; an envelope carrying only
 * unknown keys therefore has no entry left to validate and is rejected. The
 * manifest JSON is parsed and schema-validated only AFTER the raw bytes are
 * proven authentic (digest-matched and signed by at least one pinned key) —
 * an unsigned or schema-malformed manifest fails on digest/signature grounds
 * before any parse error is ever reached. When `now` is supplied, an expired
 * manifest or one whose `publishedAt` is materially in the future is
 * rejected.
 */
export function verifyManifest(options: {
  manifestBytes: Buffer
  envelope: Buffer | string | UpdateManifestEnvelope
  registry: UpdateRegistry
  now?: string | Date
}): UpdateManifest
