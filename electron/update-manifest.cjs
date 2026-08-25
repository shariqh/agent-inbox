'use strict'

// Side-effect-free production update-manifest trust core, shared by the
// Electron main process (which cannot rely on `scripts/` being staged in a
// packaged production build) and by `scripts/update-manifest.mjs` (which
// requires this module via `createRequire` for its own build-time generation,
// signing, and history/CLI concerns). This module owns exactly: strict
// key-registry parsing/validation, ed25519 key-id derivation, strict manifest
// parsing/validation, strict multi-signature envelope parsing/canonical
// validation, and raw-byte signature verification/freshness. It performs no
// file I/O, no process/env access, and no signing (which requires a private
// key and is a build-time-only concern).

const { createHash, createPublicKey, verify } = require('node:crypto')

const UPDATE_REGISTRY_SCHEMA = 1
const UPDATE_MANIFEST_SCHEMA = 1
const UPDATE_MANIFEST_KIND = 'agent-inbox-update-manifest'
const UPDATE_REPOSITORY = 'shariqh/agent-inbox'
const MANIFEST_LIFETIME_DAYS = 180
const MANIFEST_ASSET_NAME = 'update-manifest.json'
const SIGNATURE_ASSET_NAME = 'update-manifest.json.sig'

const KEY_ID_RE = /^ed25519-[0-9a-f]{16}$/
const SHA40_RE = /^[0-9a-f]{40}$/
const SHA64_RE = /^[0-9a-f]{64}$/
// Strict stable-SemVer core version syntax (https://semver.org/#spec-item-2):
// each numeric identifier is either exactly "0" or a nonzero digit followed by
// any digits — no leading zeros (e.g. "01.2.3" is rejected). Identifiers may
// be arbitrarily long; callers must compare them as BigInt/string, never via
// `Number.parseInt`, to avoid silent precision loss.
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const ISO_SECONDS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const MACOS_VERSION_RE = /^\d+\.\d+(\.\d+)?$/
const FUTURE_SKEW_MS = 5 * 60 * 1000

class UpdateManifestError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UpdateManifestError'
  }
}

function fail(message) {
  throw new UpdateManifestError(message)
}

// Exact five update targets this manifest schema supports, pre-sorted by
// `${platform}/${architecture}/${packageType}` — the manifest's required
// deterministic target order — so no runtime re-sort is needed. This is the
// single source of truth consumed both here (validation) and by
// `scripts/update-manifest.mjs`'s `generateManifest` (construction).
const TARGET_SPECS = Object.freeze([
  Object.freeze({
    platform: 'darwin',
    architecture: 'universal',
    packageType: 'dmg',
    installStrategy: 'macos-dmg',
    filename: (tag) => `Agent-Inbox-${tag}-universal.dmg`,
  }),
  Object.freeze({
    platform: 'linux',
    architecture: 'arm64',
    packageType: 'appimage',
    installStrategy: 'appimage-self-replace',
    filename: (_tag, version) => `Agent-Inbox-v${version}-linux-arm64.AppImage`,
  }),
  Object.freeze({
    platform: 'linux',
    architecture: 'arm64',
    packageType: 'deb',
    installStrategy: 'deb-notify',
    filename: (_tag, version) => `agent-inbox_${version}_arm64.deb`,
  }),
  Object.freeze({
    platform: 'linux',
    architecture: 'x64',
    packageType: 'appimage',
    installStrategy: 'appimage-self-replace',
    filename: (_tag, version) => `Agent-Inbox-v${version}-linux-x86_64.AppImage`,
  }),
  Object.freeze({
    platform: 'linux',
    architecture: 'x64',
    packageType: 'deb',
    installStrategy: 'deb-notify',
    filename: (_tag, version) => `agent-inbox_${version}_amd64.deb`,
  }),
])

function targetTuple(value) {
  return `${value.platform}/${value.architecture}/${value.packageType}`
}

function isCanonicalBase64(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false
  if (value.length % 4 !== 0) return false
  const decoded = Buffer.from(value, 'base64')
  return decoded.length > 0 && decoded.toString('base64') === value
}

function assertExactKeys(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be a plain object`)
  }
  const actual = Object.keys(value)
  const expected = new Set(keys)
  const seen = new Set()
  const extra = []
  for (const key of actual) {
    if (!expected.has(key)) extra.push(key)
    seen.add(key)
  }
  const missing = keys.filter((key) => !seen.has(key))
  if (extra.length > 0) fail(`${label} has unexpected field(s): ${extra.join(', ')}`)
  if (missing.length > 0) fail(`${label} is missing required field(s): ${missing.join(', ')}`)
}

function toWholeSecondIso(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function parseWholeSecondIso(value, label) {
  if (typeof value !== 'string' || !ISO_SECONDS_RE.test(value)) {
    fail(`${label} must be a whole-second UTC ISO-8601 timestamp (YYYY-MM-DDTHH:MM:SSZ)`)
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime()) || toWholeSecondIso(date) !== value) {
    fail(`${label} is not a valid calendar date/time`)
  }
  return date
}

function addDaysIso(date, days) {
  return toWholeSecondIso(new Date(date.getTime() + days * 24 * 60 * 60 * 1000))
}

function normalizeNow(now) {
  if (now === undefined) return undefined
  const date = now instanceof Date ? now : new Date(now)
  if (Number.isNaN(date.getTime())) fail('now must be a valid Date or date string')
  return date
}

function toBuffer(value, label) {
  if (Buffer.isBuffer(value)) return value
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  return fail(`${label} must be a Buffer or string`)
}

// ---------------------------------------------------------------------------
// Registry (trusted signing keys)
// ---------------------------------------------------------------------------

/**
 * Derives `ed25519-<first 16 hex chars of sha256(DER)>` from a canonical
 * base64-encoded SPKI DER public key, validating along the way that the
 * base64 is canonical and that the key is an ed25519 public key.
 */
function deriveKeyId(publicKeySpkiBase64) {
  if (!isCanonicalBase64(publicKeySpkiBase64)) {
    fail('publicKeySpkiBase64 must be canonical standard base64 of a DER SPKI key')
  }
  const der = Buffer.from(publicKeySpkiBase64, 'base64')
  let publicKey
  try {
    publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' })
  } catch (error) {
    return fail(`publicKeySpkiBase64 is not a valid SPKI DER public key: ${error.message}`)
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    fail(`publicKeySpkiBase64 must encode an ed25519 key, got ${publicKey.asymmetricKeyType ?? 'unknown'}`)
  }
  const digest = createHash('sha256').update(der).digest('hex')
  return `ed25519-${digest.slice(0, 16)}`
}

function validateRegistry(value) {
  assertExactKeys(value, ['schema', 'signingKeyId', 'keys'], 'registry')
  if (value.schema !== UPDATE_REGISTRY_SCHEMA) fail(`registry.schema must be ${UPDATE_REGISTRY_SCHEMA}`)
  if (typeof value.signingKeyId !== 'string' || !KEY_ID_RE.test(value.signingKeyId)) {
    fail('registry.signingKeyId must match ed25519-<16 lowercase hex characters>')
  }
  if (!Array.isArray(value.keys) || value.keys.length === 0) {
    fail('registry.keys must be a non-empty array')
  }
  const seenKeyIds = new Set()
  const keys = value.keys.map((rawKey, index) => {
    assertExactKeys(rawKey, ['keyId', 'algorithm', 'publicKeySpkiBase64'], `registry.keys[${index}]`)
    if (rawKey.algorithm !== 'ed25519') {
      fail(`registry.keys[${index}].algorithm must be "ed25519"`)
    }
    if (typeof rawKey.keyId !== 'string' || !KEY_ID_RE.test(rawKey.keyId)) {
      fail(`registry.keys[${index}].keyId must match ed25519-<16 lowercase hex characters>`)
    }
    const derived = deriveKeyId(rawKey.publicKeySpkiBase64)
    if (derived !== rawKey.keyId) {
      fail(
        `registry.keys[${index}].keyId does not derive from its publicKeySpkiBase64 (expected ${derived})`,
      )
    }
    if (seenKeyIds.has(rawKey.keyId)) {
      fail(`registry.keys contains duplicate keyId ${rawKey.keyId}`)
    }
    seenKeyIds.add(rawKey.keyId)
    return Object.freeze({
      keyId: rawKey.keyId,
      algorithm: 'ed25519',
      publicKeySpkiBase64: rawKey.publicKeySpkiBase64,
    })
  })
  if (!seenKeyIds.has(value.signingKeyId)) {
    fail(`registry.signingKeyId ${value.signingKeyId} is not present in registry.keys`)
  }
  return Object.freeze({
    schema: UPDATE_REGISTRY_SCHEMA,
    signingKeyId: value.signingKeyId,
    keys: Object.freeze(keys),
  })
}

function parseRegistry(json) {
  let parsed
  try {
    parsed = JSON.parse(typeof json === 'string' ? json : json.toString('utf8'))
  } catch (error) {
    return fail(`registry is not valid JSON: ${error.message}`)
  }
  return validateRegistry(parsed)
}

// ---------------------------------------------------------------------------
// Manifest targets
// ---------------------------------------------------------------------------

function validateTargetUrl(url, tag, filename, label) {
  if (typeof url !== 'string') fail(`${label}.url must be a string`)
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return fail(`${label}.url is not a valid URL`)
  }
  if (parsed.protocol !== 'https:') fail(`${label}.url must use https`)
  if (parsed.hostname !== 'github.com') fail(`${label}.url must be hosted on github.com`)
  if (parsed.username !== '' || parsed.password !== '') fail(`${label}.url must not include userinfo`)
  if (parsed.search !== '') fail(`${label}.url must not include a query string`)
  if (parsed.hash !== '') fail(`${label}.url must not include a fragment`)
  const expectedPath = `/${UPDATE_REPOSITORY}/releases/download/${tag}/${filename}`
  const expectedUrl = `https://github.com${expectedPath}`
  if (parsed.pathname !== expectedPath || url !== expectedUrl) {
    fail(`${label}.url must exactly equal the canonical release-download URL ${expectedUrl}`)
  }
}

function validateTarget(rawTarget, tag, version, label) {
  if (rawTarget === null || typeof rawTarget !== 'object' || Array.isArray(rawTarget)) {
    fail(`${label} must be a plain object`)
  }
  const spec = TARGET_SPECS.find(
    (candidate) =>
      candidate.platform === rawTarget.platform
      && candidate.architecture === rawTarget.architecture
      && candidate.packageType === rawTarget.packageType,
  )
  if (!spec) {
    fail(`${label} has an unrecognized platform/architecture/packageType combination`)
  }
  const isMac = spec.packageType === 'dmg'
  const expectedKeys = isMac
    ? ['platform', 'architecture', 'packageType', 'filename', 'url', 'byteLength', 'sha256', 'installStrategy', 'minimumSystemVersion']
    : ['platform', 'architecture', 'packageType', 'filename', 'url', 'byteLength', 'sha256', 'installStrategy']
  assertExactKeys(rawTarget, expectedKeys, label)
  if (rawTarget.installStrategy !== spec.installStrategy) {
    fail(`${label}.installStrategy must be "${spec.installStrategy}" for packageType "${spec.packageType}"`)
  }
  const expectedFilename = spec.filename(tag, version)
  if (rawTarget.filename !== expectedFilename) {
    fail(`${label}.filename must be "${expectedFilename}"`)
  }
  validateTargetUrl(rawTarget.url, tag, expectedFilename, label)
  if (!Number.isSafeInteger(rawTarget.byteLength) || rawTarget.byteLength <= 0) {
    fail(`${label}.byteLength must be a positive safe integer`)
  }
  if (typeof rawTarget.sha256 !== 'string' || !SHA64_RE.test(rawTarget.sha256)) {
    fail(`${label}.sha256 must be lowercase 64-character hex`)
  }
  const target = {
    platform: spec.platform,
    architecture: spec.architecture,
    packageType: spec.packageType,
    filename: expectedFilename,
    url: rawTarget.url,
    byteLength: rawTarget.byteLength,
    sha256: rawTarget.sha256,
    installStrategy: spec.installStrategy,
  }
  if (isMac) {
    if (typeof rawTarget.minimumSystemVersion !== 'string' || !MACOS_VERSION_RE.test(rawTarget.minimumSystemVersion)) {
      fail(`${label}.minimumSystemVersion must be a dotted version string`)
    }
    target.minimumSystemVersion = rawTarget.minimumSystemVersion
  }
  return Object.freeze(target)
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

const MANIFEST_KEYS = [
  'schema',
  'kind',
  'repository',
  'version',
  'tag',
  'source',
  'publishedAt',
  'expiresAt',
  'releaseUrl',
  'signingKeyId',
  'trustedKeyIds',
  'targets',
]

function validateManifest(value) {
  assertExactKeys(value, MANIFEST_KEYS, 'manifest')
  if (value.schema !== UPDATE_MANIFEST_SCHEMA) fail(`manifest.schema must be ${UPDATE_MANIFEST_SCHEMA}`)
  if (value.kind !== UPDATE_MANIFEST_KIND) fail(`manifest.kind must be "${UPDATE_MANIFEST_KIND}"`)
  if (value.repository !== UPDATE_REPOSITORY) fail(`manifest.repository must be "${UPDATE_REPOSITORY}"`)
  if (typeof value.version !== 'string' || !SEMVER_RE.test(value.version)) {
    fail('manifest.version must be a stable X.Y.Z semantic version')
  }
  const expectedTag = `v${value.version}`
  if (value.tag !== expectedTag) fail(`manifest.tag must be "${expectedTag}"`)
  assertExactKeys(value.source, ['commit', 'tree'], 'manifest.source')
  if (typeof value.source.commit !== 'string' || !SHA40_RE.test(value.source.commit)) {
    fail('manifest.source.commit must be lowercase 40-character hex')
  }
  if (typeof value.source.tree !== 'string' || !SHA40_RE.test(value.source.tree)) {
    fail('manifest.source.tree must be lowercase 40-character hex')
  }
  const publishedAtDate = parseWholeSecondIso(value.publishedAt, 'manifest.publishedAt')
  const expiresAtDate = parseWholeSecondIso(value.expiresAt, 'manifest.expiresAt')
  const expectedExpiresAt = addDaysIso(publishedAtDate, MANIFEST_LIFETIME_DAYS)
  if (value.expiresAt !== expectedExpiresAt) {
    fail(`manifest.expiresAt must be exactly ${MANIFEST_LIFETIME_DAYS} days after publishedAt (${expectedExpiresAt})`)
  }
  if (expiresAtDate.getTime() <= publishedAtDate.getTime()) {
    fail('manifest.expiresAt must be after manifest.publishedAt')
  }
  const expectedReleaseUrl = `https://github.com/${UPDATE_REPOSITORY}/releases/tag/${value.tag}`
  if (value.releaseUrl !== expectedReleaseUrl) {
    fail(`manifest.releaseUrl must be "${expectedReleaseUrl}"`)
  }
  if (typeof value.signingKeyId !== 'string' || !KEY_ID_RE.test(value.signingKeyId)) {
    fail('manifest.signingKeyId must match ed25519-<16 lowercase hex characters>')
  }
  if (!Array.isArray(value.trustedKeyIds) || value.trustedKeyIds.length === 0) {
    fail('manifest.trustedKeyIds must be a non-empty array')
  }
  value.trustedKeyIds.forEach((keyId, index) => {
    if (typeof keyId !== 'string' || !KEY_ID_RE.test(keyId)) {
      fail(`manifest.trustedKeyIds[${index}] must match ed25519-<16 lowercase hex characters>`)
    }
  })
  const sortedTrustedKeyIds = [...value.trustedKeyIds].sort()
  for (let i = 0; i < sortedTrustedKeyIds.length; i += 1) {
    if (value.trustedKeyIds[i] !== sortedTrustedKeyIds[i]) {
      fail('manifest.trustedKeyIds must be sorted ascending')
    }
  }
  const uniqueTrustedKeyIds = new Set(value.trustedKeyIds)
  if (uniqueTrustedKeyIds.size !== value.trustedKeyIds.length) {
    fail('manifest.trustedKeyIds must not contain duplicates')
  }
  if (!uniqueTrustedKeyIds.has(value.signingKeyId)) {
    fail('manifest.signingKeyId must be included in manifest.trustedKeyIds')
  }
  if (!Array.isArray(value.targets) || value.targets.length !== TARGET_SPECS.length) {
    fail(`manifest.targets must contain exactly ${TARGET_SPECS.length} entries`)
  }
  const targets = value.targets.map((rawTarget, index) =>
    validateTarget(rawTarget, value.tag, value.version, `manifest.targets[${index}]`))
  const seenTuples = new Set()
  for (const target of targets) {
    const tuple = targetTuple(target)
    if (seenTuples.has(tuple)) fail(`manifest.targets contains a duplicate target for ${tuple}`)
    seenTuples.add(tuple)
  }
  for (const spec of TARGET_SPECS) {
    const tuple = targetTuple(spec)
    if (!seenTuples.has(tuple)) fail(`manifest.targets is missing the required ${tuple} target`)
  }
  const expectedOrder = TARGET_SPECS.map(targetTuple)
  const actualOrder = targets.map(targetTuple)
  for (let i = 0; i < expectedOrder.length; i += 1) {
    if (actualOrder[i] !== expectedOrder[i]) {
      fail('manifest.targets must be sorted by platform/architecture/packageType')
    }
  }
  return Object.freeze({
    schema: UPDATE_MANIFEST_SCHEMA,
    kind: UPDATE_MANIFEST_KIND,
    repository: UPDATE_REPOSITORY,
    version: value.version,
    tag: value.tag,
    source: Object.freeze({ commit: value.source.commit, tree: value.source.tree }),
    publishedAt: value.publishedAt,
    expiresAt: value.expiresAt,
    releaseUrl: value.releaseUrl,
    signingKeyId: value.signingKeyId,
    trustedKeyIds: Object.freeze([...value.trustedKeyIds]),
    targets: Object.freeze(targets),
  })
}

function parseManifest(bytes) {
  let parsed
  try {
    parsed = JSON.parse(typeof bytes === 'string' ? bytes : bytes.toString('utf8'))
  } catch (error) {
    return fail(`manifest is not valid JSON: ${error.message}`)
  }
  return validateManifest(parsed)
}

// ---------------------------------------------------------------------------
// Detached signature envelope
// ---------------------------------------------------------------------------

const ENVELOPE_KEYS = ['schema', 'manifestSha256', 'signatures']
const ENVELOPE_SIGNATURE_KEYS = ['algorithm', 'keyId', 'signature']

function validateEnvelopeSignatureEntry(entry, index) {
  assertExactKeys(entry, ENVELOPE_SIGNATURE_KEYS, `envelope.signatures[${index}]`)
  if (entry.algorithm !== 'ed25519') {
    fail(`envelope.signatures[${index}].algorithm must be "ed25519"`)
  }
  if (typeof entry.keyId !== 'string' || !KEY_ID_RE.test(entry.keyId)) {
    fail(`envelope.signatures[${index}].keyId must match ed25519-<16 lowercase hex characters>`)
  }
  if (!isCanonicalBase64(entry.signature)) {
    fail(`envelope.signatures[${index}].signature must be canonical standard base64`)
  }
  const decoded = Buffer.from(entry.signature, 'base64')
  if (decoded.length !== 64) {
    fail(`envelope.signatures[${index}].signature must decode to a 64-byte ed25519 signature`)
  }
  return Object.freeze({
    algorithm: 'ed25519',
    keyId: entry.keyId,
    signature: entry.signature,
  })
}

function validateEnvelope(value) {
  assertExactKeys(value, ENVELOPE_KEYS, 'envelope')
  if (value.schema !== UPDATE_MANIFEST_SCHEMA) fail(`envelope.schema must be ${UPDATE_MANIFEST_SCHEMA}`)
  if (typeof value.manifestSha256 !== 'string' || !SHA64_RE.test(value.manifestSha256)) {
    fail('envelope.manifestSha256 must be lowercase 64-character hex')
  }
  if (!Array.isArray(value.signatures) || value.signatures.length === 0) {
    fail('envelope.signatures must be a non-empty array')
  }
  const seenKeyIds = new Set()
  const seenSignatures = new Set()
  const entries = value.signatures.map((entry, index) => {
    const validated = validateEnvelopeSignatureEntry(entry, index)
    if (seenKeyIds.has(validated.keyId)) {
      fail(`envelope.signatures contains a duplicate keyId: ${validated.keyId}`)
    }
    seenKeyIds.add(validated.keyId)
    if (seenSignatures.has(validated.signature)) {
      fail('envelope.signatures contains a duplicate signature')
    }
    seenSignatures.add(validated.signature)
    return validated
  })
  for (let i = 1; i < entries.length; i += 1) {
    if (entries[i - 1].keyId >= entries[i].keyId) {
      fail('envelope.signatures must be sorted by keyId in strictly ascending canonical order')
    }
  }
  return Object.freeze({
    schema: UPDATE_MANIFEST_SCHEMA,
    manifestSha256: value.manifestSha256,
    signatures: Object.freeze(entries),
  })
}

function serializeEnvelope(envelope) {
  const validated = validateEnvelope(envelope)
  const ordered = {
    schema: validated.schema,
    manifestSha256: validated.manifestSha256,
    signatures: validated.signatures.map((entry) => ({
      algorithm: entry.algorithm,
      keyId: entry.keyId,
      signature: entry.signature,
    })),
  }
  return Buffer.from(`${JSON.stringify(ordered, null, 2)}\n`, 'utf8')
}

function parseEnvelope(bytes) {
  let parsed
  try {
    parsed = JSON.parse(typeof bytes === 'string' ? bytes : bytes.toString('utf8'))
  } catch (error) {
    return fail(`envelope is not valid JSON: ${error.message}`)
  }
  return validateEnvelope(parsed)
}

function toEnvelope(value) {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return validateEnvelope(value)
  }
  return parseEnvelope(value)
}

// ---------------------------------------------------------------------------
// Verify (raw-byte signature verification + freshness)
// ---------------------------------------------------------------------------

function verifyManifest({ manifestBytes, envelope, registry, now }) {
  const reg = validateRegistry(registry)
  const manifestBuffer = toBuffer(manifestBytes, 'manifestBytes')
  // `toEnvelope` (via `validateEnvelope`/`parseEnvelope`) structurally validates
  // EVERY signature entry — canonical sort order, no duplicate keyId/signature,
  // canonical base64 decoding to a 64-byte signature — regardless of whether
  // its keyId is present in the local pinned registry. Structural validity is
  // required of the whole envelope; registry membership only gates whether an
  // entry is *cryptographically attempted* below.
  const parsedEnvelope = toEnvelope(envelope)
  const actualDigest = createHash('sha256').update(manifestBuffer).digest('hex')
  if (actualDigest !== parsedEnvelope.manifestSha256) {
    fail('manifest bytes do not match the digest recorded in the signature envelope')
  }
  const registryKeysById = new Map(reg.keys.map((key) => [key.keyId, key]))
  // Entries whose keyId is absent from the local pinned registry are ignored
  // for cryptographic verification (never a hard failure by themselves) — a
  // client that has not yet pulled a registry-expansion build must still
  // accept an envelope carrying `{old known-valid, new unknown}` signatures
  // during key rotation. Verification succeeds once at least one entry whose
  // key IS locally pinned cryptographically validates; an envelope carrying
  // only unknown keys therefore has no entry left to validate and is rejected
  // by the same check below.
  const verified = parsedEnvelope.signatures
    .filter((entry) => registryKeysById.has(entry.keyId))
    .some((entry) => {
      const registryKey = registryKeysById.get(entry.keyId)
      const publicKey = createPublicKey({
        key: Buffer.from(registryKey.publicKeySpkiBase64, 'base64'),
        format: 'der',
        type: 'spki',
      })
      const signatureBuffer = Buffer.from(entry.signature, 'base64')
      return verify(null, manifestBuffer, publicKey, signatureBuffer)
    })
  if (!verified) fail('signature verification failed: no envelope signature validated under any registered key')
  // Only parse and strictly validate the manifest JSON schema after the exact
  // raw manifest bytes have been proven authentic (digest-matched and signed
  // by at least one pinned key). This preserves the Layer 2 trust order:
  // untrusted bytes must never reach schema parsing/validation.
  const manifest = parseManifest(manifestBuffer)
  const nowDate = normalizeNow(now)
  if (nowDate !== undefined) {
    const publishedAtDate = new Date(manifest.publishedAt)
    const expiresAtDate = new Date(manifest.expiresAt)
    if (expiresAtDate.getTime() <= nowDate.getTime()) fail('manifest has expired')
    if (publishedAtDate.getTime() - nowDate.getTime() > FUTURE_SKEW_MS) {
      fail('manifest.publishedAt is materially in the future')
    }
  }
  return manifest
}

module.exports = {
  UPDATE_REGISTRY_SCHEMA,
  UPDATE_MANIFEST_SCHEMA,
  UPDATE_MANIFEST_KIND,
  UPDATE_REPOSITORY,
  MANIFEST_LIFETIME_DAYS,
  MANIFEST_ASSET_NAME,
  SIGNATURE_ASSET_NAME,
  UpdateManifestError,
  TARGET_SPECS,
  targetTuple,
  deriveKeyId,
  parseRegistry,
  validateRegistry,
  validateManifest,
  parseManifest,
  serializeEnvelope,
  validateEnvelope,
  parseEnvelope,
  verifyManifest,
}
