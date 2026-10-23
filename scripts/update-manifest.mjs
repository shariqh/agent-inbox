import { parseArgs } from 'node:util'
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { MacosReleaseKindError, macosRelease, measuredMacosKind } from './macos-release-kind.mjs'

// The side-effect-free production runtime (registry/key-id/manifest/envelope
// parsing + validation, and raw-byte signature verification/freshness) lives
// in `electron/update-manifest.cjs` so that Electron's main process can load
// it directly without depending on `scripts/` being staged in a packaged
// production build. This module requires that runtime via `createRequire`
// and retains only build-time concerns: manifest generation, signing (which
// needs a private key and is CI/build-only), release-history anti-brick
// continuity/authorization, and the CLI.
const require = createRequire(import.meta.url)
const runtime = require('../electron/update-manifest.cjs')

export const {
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
} = runtime
// Internal-only shared constants (not part of the combined public API): the
// update target types of each schema, reused here so manifest generation can
// never drift from what `electron/update-manifest.cjs`'s validators accept.
const { TARGET_SPECS, TARGET_SPECS_V2, targetTuple } = runtime

const DATA_MODE = 0o644
// See `electron/update-manifest.cjs`'s SEMVER_RE for the strict core-version
// syntax rationale (no leading-zero numeric identifiers).
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const SHA40_RE = /^[0-9a-f]{40}$/
const SHA64_RE = /^[0-9a-f]{64}$/
const ISO_SECONDS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const MACOS_VERSION_RE = /^\d+\.\d+(\.\d+)?$/
const STABLE_TAG_RE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
// GitHub's optional per-asset content digest, exactly `sha256:<64 lowercase hex>`.
const RELEASE_ASSET_DIGEST_RE = /^sha256:[0-9a-f]{64}$/

function fail(message) {
  throw new UpdateManifestError(message)
}

function toWholeSecondIso(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function addDaysIso(date, days) {
  return toWholeSecondIso(new Date(date.getTime() + days * 24 * 60 * 60 * 1000))
}

function normalizePublishedAtInput(input) {
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) fail('publishedAt Date is invalid')
    const flooredMs = Math.floor(input.getTime() / 1000) * 1000
    return toWholeSecondIso(new Date(flooredMs))
  }
  if (typeof input === 'string' && ISO_SECONDS_RE.test(input) && !Number.isNaN(new Date(input).getTime())) {
    return input
  }
  return fail('publishedAt must be a Date or a whole-second UTC ISO-8601 string (YYYY-MM-DDTHH:MM:SSZ)')
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
// Manifest generation
// ---------------------------------------------------------------------------

export function generateManifest({ registry, evidence, minimumMacosVersion, publishedAt }) {
  const reg = validateRegistry(registry)
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) {
    fail('evidence must be an object')
  }
  const { tag, packageVersion, sourceCommit, sourceTree, assets } = evidence
  if (typeof packageVersion !== 'string' || !SEMVER_RE.test(packageVersion)) {
    fail('evidence.packageVersion must be a stable X.Y.Z semantic version')
  }
  const expectedTag = `v${packageVersion}`
  if (tag !== expectedTag) fail(`evidence.tag must be "${expectedTag}"`)
  if (typeof sourceCommit !== 'string' || !SHA40_RE.test(sourceCommit)) {
    fail('evidence.sourceCommit must be lowercase 40-character hex')
  }
  if (typeof sourceTree !== 'string' || !SHA40_RE.test(sourceTree)) {
    fail('evidence.sourceTree must be lowercase 40-character hex')
  }
  if (typeof minimumMacosVersion !== 'string' || !MACOS_VERSION_RE.test(minimumMacosVersion)) {
    fail('minimumMacosVersion must be a dotted version string')
  }
  if (!Array.isArray(assets) || assets.length !== TARGET_SPECS.length) {
    fail(`evidence.assets must contain exactly ${TARGET_SPECS.length} entries`)
  }
  const publishedAtIso = normalizePublishedAtInput(publishedAt)
  const publishedAtDate = new Date(publishedAtIso)
  const expiresAtIso = addDaysIso(publishedAtDate, MANIFEST_LIFETIME_DAYS)

  const targets = TARGET_SPECS.map((spec) => {
    const tuple = targetTuple(spec)
    const matches = assets.filter(
      (asset) => asset
        && asset.platform === spec.platform
        && asset.architecture === spec.architecture
        && asset.packageType === spec.packageType,
    )
    if (matches.length === 0) fail(`evidence.assets is missing the required ${tuple} asset`)
    if (matches.length > 1) fail(`evidence.assets contains duplicate ${tuple} assets`)
    const [assetEvidence] = matches
    const expectedFilename = spec.filename(expectedTag, packageVersion)
    if (assetEvidence.name !== expectedFilename) {
      fail(`evidence asset for ${tuple} must be named "${expectedFilename}"`)
    }
    if (!Number.isSafeInteger(assetEvidence.size) || assetEvidence.size <= 0) {
      fail(`evidence asset for ${tuple} must have a positive safe integer size`)
    }
    if (typeof assetEvidence.sha256 !== 'string' || !SHA64_RE.test(assetEvidence.sha256)) {
      fail(`evidence asset for ${tuple} must have a lowercase 64-character hex sha256`)
    }
    const target = {
      platform: spec.platform,
      architecture: spec.architecture,
      packageType: spec.packageType,
      filename: expectedFilename,
      url: `https://github.com/${UPDATE_REPOSITORY}/releases/download/${expectedTag}/${expectedFilename}`,
      byteLength: assetEvidence.size,
      sha256: assetEvidence.sha256,
      installStrategy: spec.installStrategy,
    }
    if (spec.packageType === 'dmg') target.minimumSystemVersion = minimumMacosVersion
    return target
  })

  const trustedKeyIds = reg.keys.map((key) => key.keyId).sort()
  const manifestInput = {
    schema: UPDATE_MANIFEST_SCHEMA,
    kind: UPDATE_MANIFEST_KIND,
    repository: UPDATE_REPOSITORY,
    version: packageVersion,
    tag: expectedTag,
    source: { commit: sourceCommit, tree: sourceTree },
    publishedAt: publishedAtIso,
    expiresAt: expiresAtIso,
    releaseUrl: `https://github.com/${UPDATE_REPOSITORY}/releases/tag/${expectedTag}`,
    signingKeyId: reg.signingKeyId,
    trustedKeyIds,
    targets,
  }
  const manifest = validateManifest(manifestInput)
  return { manifest, bytes: serializeManifest(manifest) }
}

function orderedTarget(target) {
  const ordered = {
    platform: target.platform,
    architecture: target.architecture,
    packageType: target.packageType,
    filename: target.filename,
    url: target.url,
    byteLength: target.byteLength,
    sha256: target.sha256,
    installStrategy: target.installStrategy,
  }
  if (target.packageType === 'dmg') ordered.minimumSystemVersion = target.minimumSystemVersion
  return ordered
}

function orderedManifest(manifest) {
  return {
    schema: manifest.schema,
    kind: manifest.kind,
    repository: manifest.repository,
    version: manifest.version,
    tag: manifest.tag,
    source: { commit: manifest.source.commit, tree: manifest.source.tree },
    publishedAt: manifest.publishedAt,
    expiresAt: manifest.expiresAt,
    releaseUrl: manifest.releaseUrl,
    signingKeyId: manifest.signingKeyId,
    trustedKeyIds: [...manifest.trustedKeyIds],
    targets: manifest.targets.map(orderedTarget),
  }
}

export function serializeManifest(manifest) {
  const validated = validateManifest(manifest)
  return Buffer.from(`${JSON.stringify(orderedManifest(validated), null, 2)}\n`, 'utf8')
}

// ---------------------------------------------------------------------------
// Sign
// ---------------------------------------------------------------------------

export function signManifest({ manifestBytes, registry, privateKeyPem, now }) {
  const reg = validateRegistry(registry)
  const manifestBuffer = toBuffer(manifestBytes, 'manifestBytes')
  const manifest = parseManifest(manifestBuffer)
  const nowDate = normalizeNow(now) ?? new Date()
  if (new Date(manifest.expiresAt).getTime() <= nowDate.getTime()) {
    fail('refusing to sign a manifest that is already expired')
  }
  const pemBuffer = toBuffer(privateKeyPem, 'privateKeyPem')
  let privateKey
  try {
    privateKey = createPrivateKey({ key: pemBuffer, format: 'pem', type: 'pkcs8' })
  } catch (error) {
    return fail(`privateKeyPem is not a valid PKCS#8 PEM private key: ${error.message}`)
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    fail(`privateKeyPem must be an ed25519 key, got ${privateKey.asymmetricKeyType ?? 'unknown'}`)
  }
  const publicKey = createPublicKey(privateKey)
  const publicKeyBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  const derivedKeyId = deriveKeyId(publicKeyBase64)
  if (derivedKeyId !== reg.signingKeyId) {
    fail(`privateKeyPem derives key id ${derivedKeyId}, which does not match registry.signingKeyId ${reg.signingKeyId}`)
  }
  if (derivedKeyId !== manifest.signingKeyId) {
    fail(`privateKeyPem derives key id ${derivedKeyId}, which does not match manifest.signingKeyId ${manifest.signingKeyId}`)
  }
  const registryKey = reg.keys.find((key) => key.keyId === derivedKeyId)
  if (!registryKey || registryKey.publicKeySpkiBase64 !== publicKeyBase64) {
    fail('registry key material does not match the derived public key')
  }
  const signatureBuffer = sign(null, manifestBuffer, privateKey)
  const envelope = validateEnvelope({
    schema: UPDATE_MANIFEST_SCHEMA,
    manifestSha256: createHash('sha256').update(manifestBuffer).digest('hex'),
    signatures: [
      {
        algorithm: 'ed25519',
        keyId: derivedKeyId,
        signature: signatureBuffer.toString('base64'),
      },
    ],
  })
  return { envelope, bytes: serializeEnvelope(envelope) }
}

// ---------------------------------------------------------------------------
// Release history — anti-brick continuity
// ---------------------------------------------------------------------------

function parseVersionTuple(version) {
  // Numeric identifiers are validated by SEMVER_RE/STABLE_TAG_RE (strict core
  // version syntax, no leading zeros) before this is called, but they may be
  // arbitrarily long — parse with BigInt rather than `Number.parseInt` so
  // large-but-valid identifiers are compared exactly instead of silently
  // losing precision above Number.MAX_SAFE_INTEGER.
  return version.split('.').map((part) => BigInt(part))
}

function compareVersionTuples(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

function findAsset(release, name) {
  return release.assets.find((asset) => asset && asset.name === name)
}

// Every release record — regardless of whether it turns out to be a
// "qualifying" stable published release we care about — must prove a sane
// shape before we decide to ignore it. Silently filtering ambiguous/malformed
// entries into "not stable, skip it" would let a corrupted or attacker-shaped
// GitHub API response quietly fall through to the `bootstrap` path (e.g. by
// making every real prior release look absent), which is exactly the
// anti-brick continuity check this function exists to prevent.
function validateReleaseRecordShape(release, index) {
  const label = `releases[${index}]`
  if (release === null || typeof release !== 'object' || Array.isArray(release)) {
    fail(`${label} must be an object`)
  }
  if (typeof release.tag_name !== 'string' || release.tag_name.length === 0) {
    fail(`${label}.tag_name must be a nonempty string`)
  }
  if (typeof release.draft !== 'boolean') fail(`${label}.draft must be a boolean`)
  if (typeof release.prerelease !== 'boolean') fail(`${label}.prerelease must be a boolean`)
  if (!Array.isArray(release.assets)) fail(`${label}.assets must be an array`)
}

// Mirrors `electron/update-manifest.cjs`'s `validateTargetUrl` for manifest
// targets, but scoped to a GitHub release-list API asset's
// `browser_download_url` for an arbitrary (tag, filename) pair.
function validateReleaseAssetUrl(url, tag, filename, label) {
  if (typeof url !== 'string') fail(`${label}.browser_download_url must be a string`)
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return fail(`${label}.browser_download_url is not a valid URL`)
  }
  if (parsed.protocol !== 'https:') fail(`${label}.browser_download_url must use https`)
  if (parsed.hostname !== 'github.com') fail(`${label}.browser_download_url must be hosted on github.com`)
  if (parsed.username !== '' || parsed.password !== '') {
    fail(`${label}.browser_download_url must not include userinfo`)
  }
  if (parsed.search !== '') fail(`${label}.browser_download_url must not include a query string`)
  if (parsed.hash !== '') fail(`${label}.browser_download_url must not include a fragment`)
  const expectedPath = `/${UPDATE_REPOSITORY}/releases/download/${tag}/${filename}`
  const expectedUrl = `https://github.com${expectedPath}`
  if (parsed.pathname !== expectedPath || url !== expectedUrl) {
    fail(`${label}.browser_download_url must exactly equal the canonical release-download URL ${expectedUrl}`)
  }
}

// Deep per-asset validation, applied only once a release has proven itself a
// qualifying stable published release (draft:false, prerelease:false, a
// STABLE_TAG_RE tag) — non-stable/unrelated releases are ignored (after their
// own record shape is proven by `validateReleaseRecordShape`) without this
// deeper check.
function validateStableReleaseAssets(release, label) {
  const seenNames = new Set()
  release.assets.forEach((asset, assetIndex) => {
    const assetLabel = `${label}.assets[${assetIndex}]`
    if (asset === null || typeof asset !== 'object' || Array.isArray(asset)) {
      fail(`${assetLabel} must be an object`)
    }
    if (typeof asset.name !== 'string' || asset.name.length === 0) {
      fail(`${assetLabel}.name must be a nonempty string`)
    }
    if (seenNames.has(asset.name)) {
      fail(`${label} has duplicate asset name "${asset.name}"`)
    }
    seenNames.add(asset.name)
    if (!Number.isSafeInteger(asset.id) || asset.id <= 0) {
      fail(`${assetLabel}.id must be a positive safe integer`)
    }
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
      fail(`${assetLabel}.size must be a positive safe integer`)
    }
    validateReleaseAssetUrl(asset.browser_download_url, release.tag_name, asset.name, assetLabel)
    // The GitHub REST API optionally reports a content digest per asset. It
    // may be omitted entirely, explicitly `null`, or (matching existing
    // publisher behavior) an empty string when unavailable — all three are
    // treated as "no digest". Any other value must be exactly
    // `sha256:<64 lowercase hex>` so a malformed digest cannot be silently
    // accepted.
    const digestUnavailable = asset.digest === undefined || asset.digest === null || asset.digest === ''
    if (!digestUnavailable && (typeof asset.digest !== 'string' || !RELEASE_ASSET_DIGEST_RE.test(asset.digest))) {
      fail(`${assetLabel}.digest must be exactly "sha256:<64 lowercase hex>" when present`)
    }
  })
}

export function planReleaseHistoryContinuity({ releases, newTag }) {
  if (!Array.isArray(releases)) fail('releases must be an array')
  if (typeof newTag !== 'string' || !STABLE_TAG_RE.test(newTag)) {
    fail('newTag must be a stable vX.Y.Z tag')
  }
  releases.forEach((release, index) => validateReleaseRecordShape(release, index))

  const newVersionTuple = parseVersionTuple(newTag.slice(1))
  // Now that every record's shape is proven, unrelated non-stable tags
  // (drafts, prereleases, or tags that are not a stable vX.Y.Z at all) may be
  // safely ignored — but only having reached this point via the shape check
  // above, never as a way to avoid validating an ambiguous record.
  const qualifying = releases.filter(
    (release) => release.draft === false && release.prerelease === false && STABLE_TAG_RE.test(release.tag_name),
  )
  const seenTags = new Set()
  for (const release of qualifying) {
    if (seenTags.has(release.tag_name)) {
      fail(`duplicate stable release tag ${release.tag_name}`)
    }
    seenTags.add(release.tag_name)

    const label = `release ${release.tag_name}`
    validateStableReleaseAssets(release, label)

    const versionTuple = parseVersionTuple(release.tag_name.slice(1))
    if (compareVersionTuples(versionTuple, newVersionTuple) >= 0) {
      fail(`prior stable release ${release.tag_name} is not older than the new release ${newTag}`)
    }
    const manifestAsset = findAsset(release, MANIFEST_ASSET_NAME)
    const signatureAsset = findAsset(release, SIGNATURE_ASSET_NAME)
    if (Boolean(manifestAsset) !== Boolean(signatureAsset)) {
      fail(`release ${release.tag_name} has a partial update-manifest/signature asset pair`)
    }
  }
  const sorted = [...qualifying].sort(
    (a, b) => compareVersionTuples(parseVersionTuple(b.tag_name.slice(1)), parseVersionTuple(a.tag_name.slice(1))),
  )
  const anyHasAssets = sorted.some(
    (release) => findAsset(release, MANIFEST_ASSET_NAME) || findAsset(release, SIGNATURE_ASSET_NAME),
  )
  if (!anyHasAssets) {
    return Object.freeze({ mode: 'bootstrap', priorTag: null })
  }
  const [latest] = sorted
  const manifestAsset = latest ? findAsset(latest, MANIFEST_ASSET_NAME) : undefined
  const signatureAsset = latest ? findAsset(latest, SIGNATURE_ASSET_NAME) : undefined
  if (!latest || !manifestAsset || !signatureAsset) {
    fail(
      `the latest previous stable release${latest ? ` (${latest.tag_name})` : ''} is missing the update `
      + 'manifest and signature; bootstrap is only permitted when no prior release has published either asset',
    )
  }
  return Object.freeze({
    mode: 'continuity',
    priorTag: latest.tag_name,
    manifestAsset: Object.freeze({
      id: manifestAsset.id,
      name: manifestAsset.name,
      size: manifestAsset.size,
      url: manifestAsset.browser_download_url,
      // Omit digest when unavailable (undefined, null, or empty string).
      ...(manifestAsset.digest ? { digest: manifestAsset.digest } : {}),
    }),
    signatureAsset: Object.freeze({
      id: signatureAsset.id,
      name: signatureAsset.name,
      size: signatureAsset.size,
      url: signatureAsset.browser_download_url,
      // Omit digest when unavailable (undefined, null, or empty string).
      ...(signatureAsset.digest ? { digest: signatureAsset.digest } : {}),
    }),
  })
}

export function authorizeReleaseContinuity({ priorManifestBytes, priorSignatureBytes, registry, newTag, rotationOverride }) {
  const reg = validateRegistry(registry)
  if (typeof newTag !== 'string' || !STABLE_TAG_RE.test(newTag)) {
    fail('newTag must be a stable vX.Y.Z tag')
  }
  const priorManifest = verifyManifest({
    manifestBytes: priorManifestBytes,
    envelope: priorSignatureBytes,
    registry: reg,
  })
  const newSigningKeyId = reg.signingKeyId
  const membershipOk = priorManifest.trustedKeyIds.includes(newSigningKeyId)
  let rotationOverrideUsed = false
  if (!membershipOk) {
    const expectedOverride = `ALLOW-UPDATE-KEY-ROTATION:${newTag}:${newSigningKeyId}`
    if (rotationOverride !== expectedOverride) {
      fail(
        `new signing key ${newSigningKeyId} is not trusted by the prior release manifest (${priorManifest.tag}); `
        + `supply rotationOverride "${expectedOverride}" to authorize key rotation`,
      )
    }
    rotationOverrideUsed = true
  }
  return Object.freeze({
    authorized: true,
    priorManifest,
    priorTag: priorManifest.tag,
    rotationOverrideUsed,
  })
}

// ---------------------------------------------------------------------------
// Update manifest v2 (#343; design §5 to §7). Pure functions for the trusted
// signer: generate and check this release's v2 manifest, derive its v1
// manifest (a projection of v2, or a re-stamp of the release before's v1),
// plan and authorize both histories, and require the original key on v1.
// ---------------------------------------------------------------------------

/**
 * The key apps from 1.2 to 1.6 trust, and the only one they ever will: every v1
 * manifest must carry its signature (design I8, G10), whatever
 * release/update-keys.json later lists. Pinned here, not read from a registry.
 */
export const ORIGINAL_UPDATE_KEY = Object.freeze({
  keyId: 'ed25519-99927ba2f6af6482',
  algorithm: 'ed25519',
  publicKeySpkiBase64: 'MCowBQYDK2VwAyEAshsgCvPUphCyxSv/sgvDCBvdde/Ws+CU0Fgdl62SU/k=',
})

const MANIFEST_PAIRS = Object.freeze({
  v1: Object.freeze({ manifest: MANIFEST_ASSET_NAME, signature: SIGNATURE_ASSET_NAME }),
  v2: Object.freeze({ manifest: MANIFEST_V2_ASSET_NAME, signature: SIGNATURE_V2_ASSET_NAME }),
})

const SCHEMA_1_PREFIX = '{\n  "schema": 1,\n'
const SCHEMA_2_PREFIX = '{\n  "schema": 2,\n'

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// The shared macOS kind table (#341) throws its own error; this module reports its own.
function withKind(operation) {
  try {
    return operation()
  } catch (error) {
    if (error instanceof MacosReleaseKindError) fail(error.message)
    throw error
  }
}

function rotationOverrideFor(tag, keyId) {
  return `ALLOW-UPDATE-KEY-ROTATION:${tag}:${keyId}`
}

function compareTags(left, right) {
  return compareVersionTuples(parseVersionTuple(left.slice(1)), parseVersionTuple(right.slice(1)))
}

// The v2 types a release of this macOS kind publishes: its own DMG and the four Linux
// packages, nothing else (design §7.3). Readers skip types they don't know, so the
// publisher is the strict side.
function releaseSpecsV2(kind, tag) {
  const macos = withKind(() => macosRelease({ kind, tag }))
  const specs = TARGET_SPECS_V2.filter((spec) => spec.platform !== 'darwin' || spec.architecture === macos.architecture)
  const dmg = specs.find((spec) => spec.platform === 'darwin')
  if (!dmg || dmg.filename(tag, tag.slice(1)) !== macos.dmgName) {
    fail(`no v2 target type names ${macos.dmgName}, the ${macos.kind} DMG`)
  }
  return specs
}

export function generateManifestV2({ registry, evidence, minimumMacosVersion, publishedAt, kind }) {
  const reg = validateRegistry(registry)
  if (!isPlainObject(evidence)) fail('evidence must be an object')
  const { tag, packageVersion, sourceCommit, sourceTree, assets } = evidence
  if (typeof packageVersion !== 'string' || !SEMVER_RE.test(packageVersion)) {
    fail('evidence.packageVersion must be a stable X.Y.Z semantic version')
  }
  const expectedTag = `v${packageVersion}`
  if (tag !== expectedTag) fail(`evidence.tag must be "${expectedTag}"`)
  if (typeof sourceCommit !== 'string' || !SHA40_RE.test(sourceCommit)) {
    fail('evidence.sourceCommit must be lowercase 40-character hex')
  }
  if (typeof sourceTree !== 'string' || !SHA40_RE.test(sourceTree)) {
    fail('evidence.sourceTree must be lowercase 40-character hex')
  }
  if (typeof minimumMacosVersion !== 'string' || !MACOS_VERSION_RE.test(minimumMacosVersion)) {
    fail('minimumMacosVersion must be a dotted version string')
  }
  const specs = releaseSpecsV2(kind, expectedTag)
  if (!Array.isArray(assets) || assets.length !== specs.length) {
    fail(`evidence.assets must contain exactly ${specs.length} entries: the ${kind} DMG and the four Linux packages`)
  }
  const publishedAtIso = normalizePublishedAtInput(publishedAt)
  const expiresAtIso = addDaysIso(new Date(publishedAtIso), MANIFEST_LIFETIME_DAYS)
  const targets = specs.map((spec) => {
    const tuple = targetTuple(spec)
    const matches = assets.filter(
      (asset) => asset
        && asset.platform === spec.platform
        && asset.architecture === spec.architecture
        && asset.packageType === spec.packageType,
    )
    if (matches.length === 0) fail(`evidence.assets is missing the required ${tuple} asset`)
    if (matches.length > 1) fail(`evidence.assets contains duplicate ${tuple} assets`)
    const [assetEvidence] = matches
    const expectedFilename = spec.filename(expectedTag, packageVersion)
    if (assetEvidence.name !== expectedFilename) {
      fail(`evidence asset for ${tuple} must be named "${expectedFilename}"`)
    }
    if (!Number.isSafeInteger(assetEvidence.size) || assetEvidence.size <= 0) {
      fail(`evidence asset for ${tuple} must have a positive safe integer size`)
    }
    if (typeof assetEvidence.sha256 !== 'string' || !SHA64_RE.test(assetEvidence.sha256)) {
      fail(`evidence asset for ${tuple} must have a lowercase 64-character hex sha256`)
    }
    const target = {
      platform: spec.platform,
      architecture: spec.architecture,
      packageType: spec.packageType,
      filename: expectedFilename,
      url: `https://github.com/${UPDATE_REPOSITORY}/releases/download/${expectedTag}/${expectedFilename}`,
      byteLength: assetEvidence.size,
      sha256: assetEvidence.sha256,
      installStrategy: spec.installStrategy,
    }
    if (spec.packageType === 'dmg') target.minimumSystemVersion = minimumMacosVersion
    return target
  })
  const manifest = validateManifestV2({
    schema: UPDATE_MANIFEST_SCHEMA_V2,
    kind: UPDATE_MANIFEST_KIND,
    repository: UPDATE_REPOSITORY,
    version: packageVersion,
    tag: expectedTag,
    source: { commit: sourceCommit, tree: sourceTree },
    publishedAt: publishedAtIso,
    expiresAt: expiresAtIso,
    releaseUrl: `https://github.com/${UPDATE_REPOSITORY}/releases/tag/${expectedTag}`,
    signingKeyId: reg.signingKeyId,
    trustedKeyIds: reg.keys.map((key) => key.keyId).sort(),
    targets,
  })
  return { manifest, bytes: serializeManifestV2(manifest) }
}

// Serialized exactly like schema 1 (fixed key order, two-space indentation, one trailing
// newline), so a universal release's two manifests differ only in their schema line.
export function serializeManifestV2(manifest) {
  const validated = validateManifestV2(manifest)
  return Buffer.from(`${JSON.stringify(orderedManifest(validated), null, 2)}\n`, 'utf8')
}

/**
 * The v1 manifest of a universal release (design §7.3): the v2 data with schema 1, keeping
 * only the five types schema 1 can express, all five required, and schema 1's exact
 * 180-day lifetime. Its bytes equal today's generateManifest output for the same evidence.
 */
export function projectV1(v2ManifestBytes) {
  const v2 = parseManifestV2(toBuffer(v2ManifestBytes, 'v2ManifestBytes'))
  const targets = TARGET_SPECS.map((spec) => {
    const target = v2.targets.find((candidate) => targetTuple(candidate) === targetTuple(spec))
    if (!target) fail(`projectV1 needs the ${targetTuple(spec)} target: only a universal release has a v1 projection`)
    return target
  })
  const { schema: _schema, targets: _targets, ...header } = v2
  const manifest = validateManifest({ ...header, schema: UPDATE_MANIFEST_SCHEMA, targets })
  return { manifest, bytes: serializeManifest(manifest) }
}

// The published stable releases older than `newTag`, every record's shape proven first,
// as planReleaseHistoryContinuity reads the listing (G1 included).
function qualifyingStableReleases(releases, newTag) {
  if (!Array.isArray(releases)) fail('releases must be an array')
  releases.forEach((release, index) => validateReleaseRecordShape(release, index))
  const qualifying = releases.filter(
    (release) => release.draft === false && release.prerelease === false && STABLE_TAG_RE.test(release.tag_name),
  )
  const seenTags = new Set()
  for (const release of qualifying) {
    if (seenTags.has(release.tag_name)) fail(`duplicate stable release tag ${release.tag_name}`)
    seenTags.add(release.tag_name)
    validateStableReleaseAssets(release, `release ${release.tag_name}`)
    if (compareTags(release.tag_name, newTag) >= 0) {
      fail(`prior stable release ${release.tag_name} is not older than the new release ${newTag}`)
    }
  }
  return qualifying
}

function dmgNameOf(kind, release) {
  return withKind(() => macosRelease({ kind, tag: release.tag_name })).dmgName
}

// Whether a published release was universal or arm64, from its own DMG's name.
function releaseKindOf(release) {
  const universal = Boolean(findAsset(release, dmgNameOf('universal', release)))
  const arm64 = Boolean(findAsset(release, dmgNameOf('arm64', release)))
  if (universal && arm64) fail(`release ${release.tag_name} lists both a universal and an arm64 DMG`)
  if (universal) return 'universal'
  return arm64 ? 'arm64' : null
}

// G6: the release every v1 manifest describes, the newest published one with a universal DMG.
function newestUniversalRelease(releases, newTag) {
  let newest = null
  for (const release of qualifyingStableReleases(releases, newTag)) {
    if (!findAsset(release, dmgNameOf('universal', release))) continue
    if (newest === null || compareTags(release.tag_name, newest.tag_name) > 0) newest = release
  }
  return newest
}

/**
 * The frozen v1 manifest of an arm64 release (design §5.3): the earlier v1 manifest,
 * verified under this release's keys with no expiry check, copied with only `publishedAt`
 * (this release's tag time), `expiresAt`, `signingKeyId` and `trustedKeyIds` changed. It
 * must describe an older release, the newest published one with a universal DMG (G6),
 * and every copied target must be a file GitHub lists for that release.
 */
export function restampV1({ earlierManifestBytes, earlierSignatureBytes, registry, newTag, publishedAt, releases }) {
  const reg = validateRegistry(registry)
  if (typeof newTag !== 'string' || !STABLE_TAG_RE.test(newTag)) fail('newTag must be a stable vX.Y.Z tag')
  const manifestBytes = toBuffer(earlierManifestBytes, 'earlierManifestBytes')
  const earlier = verifyManifest({
    manifestBytes,
    envelope: toBuffer(earlierSignatureBytes, 'earlierSignatureBytes'),
    registry: reg,
  })
  if (compareTags(earlier.tag, newTag) >= 0) {
    fail(`the earlier v1 manifest describes ${earlier.tag}, which is not older than the new release ${newTag}`)
  }
  const described = newestUniversalRelease(releases, newTag)
  if (described === null) fail('no published release has a universal DMG, so there is nothing for the v1 manifest to describe')
  if (described.tag_name !== earlier.tag) {
    fail(`the earlier v1 manifest describes ${earlier.tag}, but the newest published release with a universal DMG is ${described.tag_name}`)
  }
  for (const target of earlier.targets) {
    const asset = findAsset(described, target.filename)
    if (!asset) fail(`release ${described.tag_name} does not list ${target.filename}, which its v1 manifest names`)
    if (asset.size !== target.byteLength || (asset.digest && asset.digest !== `sha256:${target.sha256}`)) {
      fail(`${target.filename} in release ${described.tag_name} is not the file its v1 manifest describes (size or digest differs)`)
    }
  }
  const publishedAtIso = normalizePublishedAtInput(publishedAt)
  const manifest = validateManifest({
    ...earlier,
    publishedAt: publishedAtIso,
    expiresAt: addDaysIso(new Date(publishedAtIso), MANIFEST_LIFETIME_DAYS),
    signingKeyId: reg.signingKeyId,
    trustedKeyIds: reg.keys.map((key) => key.keyId).sort(),
  })
  return {
    manifest,
    bytes: serializeManifest(manifest),
    describes: earlier.tag,
    earlierManifestSha256: sha256Hex(manifestBytes),
    targets: earlier.targets.map(({ filename, byteLength, sha256 }) => ({ filename, byteLength, sha256 })),
  }
}

function assetPlan(asset) {
  return Object.freeze({
    id: asset.id,
    name: asset.name,
    size: asset.size,
    url: asset.browser_download_url,
    // Omit digest when unavailable (undefined, null, or empty string).
    ...(asset.digest ? { digest: asset.digest } : {}),
  })
}

function planManifestHistory(manifest, newestFirst, macos) {
  const names = MANIFEST_PAIRS[manifest]
  if (!newestFirst.some((release) => findAsset(release, names.manifest))) {
    // G3 to G5: the first file of each pair comes from a release that describes itself in
    // it, which an arm64 release can't do in v1 and mustn't do in v2.
    if (macos.kind !== 'universal') {
      fail(`no earlier release carries ${names.manifest}, and only a universal release may publish the first one`)
    }
    return Object.freeze({ manifest, mode: 'bootstrap', priorTag: null })
  }
  const [latest] = newestFirst
  const manifestAsset = findAsset(latest, names.manifest)
  const signatureAsset = findAsset(latest, names.signature)
  if (!manifestAsset || !signatureAsset) {
    fail(
      `the latest previous stable release (${latest.tag_name}) is missing ${names.manifest} and its signature; `
      + 'once a release has published them, every later release must',
    )
  }
  return Object.freeze({
    manifest,
    mode: 'continuity',
    priorTag: latest.tag_name,
    priorKind: releaseKindOf(latest),
    manifestAsset: assetPlan(manifestAsset),
    signatureAsset: assetPlan(signatureAsset),
  })
}

/**
 * The release history of both manifests for a new release of this macOS kind (design
 * §7.3, G1 to G5): every published stable release is older; no release carries half of
 * either pair; once a release has published a manifest, the release right before this one
 * carries it too; and only a universal release may publish the first of either.
 */
export function planReleaseHistory({ releases, newTag, kind }) {
  if (typeof newTag !== 'string' || !STABLE_TAG_RE.test(newTag)) fail('newTag must be a stable vX.Y.Z tag')
  const macos = withKind(() => macosRelease({ kind, tag: newTag }))
  const qualifying = qualifyingStableReleases(releases, newTag)
  for (const release of qualifying) {
    for (const names of Object.values(MANIFEST_PAIRS)) {
      if (Boolean(findAsset(release, names.manifest)) !== Boolean(findAsset(release, names.signature))) {
        fail(`release ${release.tag_name} has a partial ${names.manifest}/signature asset pair`)
      }
    }
  }
  const newestFirst = [...qualifying].sort((left, right) => compareTags(right.tag_name, left.tag_name))
  return Object.freeze({
    v1: planManifestHistory('v1', newestFirst, macos),
    v2: planManifestHistory('v2', newestFirst, macos),
  })
}

function requireListedBytes(bytes, asset, priorTag, name) {
  if (
    !isPlainObject(asset)
    || bytes.length !== asset.size
    || (asset.digest && asset.digest !== `sha256:${sha256Hex(bytes)}`)
  ) {
    fail(`the downloaded ${name} is not the file GitHub listed for ${priorTag} (size or digest differs)`)
  }
}

/**
 * Authorizes one manifest of the release before, from its plan (design §7.3): the bytes are
 * the files GitHub listed; they verify under this release's keys, with no expiry check; the
 * earlier v2 describes the release before; the earlier v1 describes it too when it was
 * universal, or an older release when it was arm64; and this release's signing key is
 * already trusted there, or the exact rotation override names it.
 */
export function authorizeReleaseHistory({ plan, priorManifestBytes, priorSignatureBytes, registry, newTag, rotationOverride }) {
  const reg = validateRegistry(registry)
  if (typeof newTag !== 'string' || !STABLE_TAG_RE.test(newTag)) fail('newTag must be a stable vX.Y.Z tag')
  const manifest = plan?.manifest
  if (manifest !== 'v1' && manifest !== 'v2') fail('plan.manifest must be "v1" or "v2"')
  const names = MANIFEST_PAIRS[manifest]
  if (plan.mode === 'bootstrap' && plan.priorTag === null) {
    return Object.freeze({ manifest, authorized: true, mode: 'bootstrap', priorTag: null, rotationOverrideUsed: false })
  }
  if (plan.mode !== 'continuity' || typeof plan.priorTag !== 'string' || !STABLE_TAG_RE.test(plan.priorTag)) {
    fail(`the ${names.manifest} history plan is malformed`)
  }
  if (priorManifestBytes === undefined || priorSignatureBytes === undefined) {
    fail(`${plan.priorTag}'s ${names.manifest} and its signature are needed to continue its history`)
  }
  const manifestBytes = toBuffer(priorManifestBytes, 'priorManifestBytes')
  const signatureBytes = toBuffer(priorSignatureBytes, 'priorSignatureBytes')
  requireListedBytes(manifestBytes, plan.manifestAsset, plan.priorTag, names.manifest)
  requireListedBytes(signatureBytes, plan.signatureAsset, plan.priorTag, names.signature)
  const prior = (manifest === 'v2' ? verifyManifestV2 : verifyManifest)({
    manifestBytes,
    envelope: signatureBytes,
    registry: reg,
  })
  if (manifest === 'v2' || plan.priorKind === 'universal') {
    if (prior.tag !== plan.priorTag) {
      fail(`the earlier ${names.manifest} describes ${prior.tag}, but it must describe the release before, ${plan.priorTag}`)
    }
  } else if (plan.priorKind === 'arm64') {
    if (compareTags(prior.tag, plan.priorTag) >= 0) {
      fail(`the earlier ${names.manifest} describes ${prior.tag}, but ${plan.priorTag} is arm64, so it must describe an older universal release`)
    }
  } else {
    fail(`cannot tell whether the release before (${plan.priorTag}) was universal or arm64, so its ${names.manifest} cannot be checked`)
  }
  let rotationOverrideUsed = false
  if (!prior.trustedKeyIds.includes(reg.signingKeyId)) {
    const expectedOverride = rotationOverrideFor(newTag, reg.signingKeyId)
    if (rotationOverride !== expectedOverride) {
      fail(
        `new signing key ${reg.signingKeyId} is not trusted by the prior release manifest (${prior.tag}); `
        + `supply rotationOverride "${expectedOverride}" to authorize key rotation`,
      )
    }
    rotationOverrideUsed = true
  }
  return Object.freeze({
    manifest,
    authorized: true,
    mode: 'continuity',
    priorTag: plan.priorTag,
    describes: prior.tag,
    rotationOverrideUsed,
    priorManifest: prior,
  })
}

// One aggregate evidence asset in generateManifestV2's terms, mapped as release
// aggregation maps it for the manifest it writes.
function manifestAssetFrom(asset, macos) {
  if (!isPlainObject(asset)) fail('aggregate evidence assets must be objects')
  if (asset.platform === 'macos') {
    return {
      name: asset.name,
      packageType: 'dmg',
      platform: 'darwin',
      architecture: macos.architecture,
      size: asset.size,
      sha256: asset.sha256,
    }
  }
  if (asset.platform !== 'linux' || !['linux-x64', 'linux-arm64'].includes(asset.target)) {
    fail(`Linux update target evidence is malformed for ${asset.name}`)
  }
  const packageType = asset.packageType === 'AppImage' ? 'appimage' : asset.packageType === 'DEB' ? 'deb' : null
  if (!packageType) fail(`Linux update package type is malformed for ${asset.name}`)
  return {
    name: asset.name,
    packageType,
    platform: 'linux',
    architecture: asset.target === 'linux-x64' ? 'x64' : 'arm64',
    size: asset.size,
    sha256: asset.sha256,
  }
}

function requirePackages(packages, assets) {
  if (!isPlainObject(packages)) fail('packages must map each package file name to its measured size and SHA-256')
  const names = Object.keys(packages).sort()
  const listed = assets.map((asset) => asset?.name).sort()
  if (JSON.stringify(names) !== JSON.stringify(listed)) {
    fail(`the release's package files (${names.join(', ')}) are not the ones its evidence lists (${listed.join(', ')})`)
  }
  for (const asset of assets) {
    const measured = packages[asset.name]
    if (!isPlainObject(measured) || measured.size !== asset.size || measured.sha256 !== asset.sha256) {
      fail(`${asset.name} is not the file the aggregate evidence describes (size or SHA-256 differs)`)
    }
  }
}

/**
 * Checks the unsigned v2 manifest against the release before anything is signed (design
 * §7.1 and §7.3). The context and evidence must be the authorized tag and commit; G9: the
 * CPU types measured in the shipped app give the kind, which must agree with the expected
 * set read from the release commit, the DMG name, its labels and the native Intel gate;
 * the package files (re-hashed by the caller) must be the ones the evidence lists; and G7:
 * the manifest must be exactly the bytes generateManifestV2 writes for this evidence.
 */
export function checkReleaseManifest({ manifestBytes, aggregate, context, registryBytes, macosInputs, packages, tag, sourceCommit }) {
  if (typeof tag !== 'string' || !STABLE_TAG_RE.test(tag)) fail('tag must be the authorized stable vX.Y.Z tag')
  if (typeof sourceCommit !== 'string' || !SHA40_RE.test(sourceCommit)) {
    fail('sourceCommit must be the authorized lowercase 40-character commit')
  }
  const version = tag.slice(1)
  const bytes = toBuffer(manifestBytes, 'manifestBytes')
  const registryBuffer = toBuffer(registryBytes, 'registryBytes')
  const registry = parseRegistry(registryBuffer)
  if (
    !isPlainObject(context)
    || context.schema !== 1
    || context.annotated !== true
    || context.tag !== tag
    || context.version !== version
    || context.sourceCommit !== sourceCommit
    || typeof context.taggedAt !== 'string'
    || !ISO_SECONDS_RE.test(context.taggedAt)
  ) {
    fail('the release context is not the authorized tag and source commit')
  }
  if (
    !isPlainObject(aggregate)
    || aggregate.schema !== 1
    || aggregate.tag !== tag
    || aggregate.packageVersion !== version
    || aggregate.sourceCommit !== sourceCommit
    || typeof aggregate.sourceTree !== 'string'
    || !SHA40_RE.test(aggregate.sourceTree)
    || aggregate.annotatedTag !== true
    || aggregate.publishable !== true
    || !Array.isArray(aggregate.assets)
  ) {
    fail('the aggregate evidence does not describe the authorized release')
  }
  const listed = aggregate.updateManifest
  if (
    !isPlainObject(listed)
    || listed.name !== MANIFEST_V2_ASSET_NAME
    || listed.size !== bytes.length
    || listed.sha256 !== sha256Hex(bytes)
    || listed.keyRegistrySha256 !== sha256Hex(registryBuffer)
  ) {
    fail(`the aggregate evidence does not describe this ${MANIFEST_V2_ASSET_NAME} and key registry`)
  }
  if (!isPlainObject(macosInputs) || typeof macosInputs.minimumMacosVersion !== 'string' || !MACOS_VERSION_RE.test(macosInputs.minimumMacosVersion)) {
    fail('the macOS release inputs must carry a minimumMacosVersion')
  }

  const macAssets = aggregate.assets.filter((asset) => isPlainObject(asset) && asset.platform === 'macos')
  if (macAssets.length !== 1) fail('the aggregate evidence must list exactly one macOS package')
  const [mac] = macAssets
  const architectures = mac.architectures
  if (!isPlainObject(architectures) || Object.keys(architectures).sort().join(',') !== 'betterSqlite3,executable') {
    fail('the macOS package must record the CPU types of exactly its executable and its better-sqlite3 addon')
  }
  const kind = withKind(() => measuredMacosKind({
    expected: macosInputs.macosArchitectures,
    executable: architectures.executable,
    betterSqlite3: architectures.betterSqlite3,
  }))
  const macos = withKind(() => macosRelease({ kind, tag }))
  if (
    mac.name !== macos.dmgName
    || mac.packageType !== 'DMG'
    || mac.architecture !== macos.architecture
    || mac.target !== macos.target
  ) {
    fail(
      `the measured CPU types give the ${kind} kind, ${macos.dmgName} labelled ${macos.architecture} `
      + `(${macos.target}), but the evidence says ${mac.name} labelled ${mac.architecture} (${mac.target})`,
    )
  }
  if (macos.needsNativeIntel && mac.nativeIntel !== 'passed') {
    fail(`a ${kind} release needs the native Intel gate to have passed`)
  }
  if (!macos.needsNativeIntel && Object.hasOwn(mac, 'nativeIntel')) fail(`an ${kind} release has no native Intel gate`)

  requirePackages(packages, aggregate.assets)

  const generation = Object.freeze({
    evidence: Object.freeze({
      tag,
      packageVersion: version,
      sourceCommit,
      sourceTree: aggregate.sourceTree,
      assets: Object.freeze(aggregate.assets.map((asset) => Object.freeze(manifestAssetFrom(asset, macos)))),
    }),
    minimumMacosVersion: macosInputs.minimumMacosVersion,
    publishedAt: context.taggedAt,
  })
  const expected = generateManifestV2({ registry, ...generation, kind })
  if (!expected.bytes.equals(bytes)) {
    fail(`${MANIFEST_V2_ASSET_NAME} is not the manifest this release's evidence, keys and inputs give`)
  }
  return Object.freeze({
    kind,
    dmgName: macos.dmgName,
    macos: Object.freeze({
      kind,
      architectures: Object.freeze({
        executable: Object.freeze([...architectures.executable]),
        betterSqlite3: Object.freeze([...architectures.betterSqlite3]),
      }),
      expected: Object.freeze([...macosInputs.macosArchitectures]),
    }),
    manifest: expected.manifest,
    manifestSha256: sha256Hex(bytes),
    generation,
  })
}

/**
 * This release's v1 manifest, from verified inputs only (design §7.3). A universal release
 * projects its checked v2 manifest; G8 holds (the two carry the same data apart from
 * schema) and the bytes are today's generateManifest output. An arm64 release re-stamps the
 * release before's v1 manifest, which must describe the newest universal release (G6).
 */
export function deriveV1({ release, v2ManifestBytes, registry, releases, earlierManifestBytes, earlierSignatureBytes }) {
  if (!isPlainObject(release) || !isPlainObject(release.manifest) || !isPlainObject(release.generation)) {
    fail('deriveV1 needs the result of checkReleaseManifest')
  }
  const v2Bytes = toBuffer(v2ManifestBytes, 'v2ManifestBytes')
  if (sha256Hex(v2Bytes) !== release.manifestSha256) {
    fail('v2ManifestBytes are not the v2 manifest checkReleaseManifest checked')
  }
  const reg = validateRegistry(registry)
  const { tag, publishedAt } = release.manifest
  if (release.kind === 'universal') {
    const projected = projectV1(v2Bytes)
    const v2Text = v2Bytes.toString('utf8')
    if (!v2Text.startsWith(SCHEMA_2_PREFIX) || `${SCHEMA_1_PREFIX}${v2Text.slice(SCHEMA_2_PREFIX.length)}` !== projected.bytes.toString('utf8')) {
      fail('a universal release\'s v1 manifest must carry the data of its v2 manifest, apart from schema')
    }
    const today = generateManifest({ registry: reg, ...release.generation })
    if (!today.bytes.equals(projected.bytes)) {
      fail('the projected v1 manifest is not what generateManifest writes for this release')
    }
    return Object.freeze({ made: 'projection', describes: tag, manifest: projected.manifest, bytes: projected.bytes })
  }
  if (release.kind !== 'arm64') fail(`${JSON.stringify(release.kind)} is not a macOS release kind`)
  if (earlierManifestBytes === undefined || earlierSignatureBytes === undefined) {
    fail('an arm64 release re-stamps the earlier v1 manifest: pass its bytes and signature')
  }
  const restamped = restampV1({ earlierManifestBytes, earlierSignatureBytes, registry: reg, newTag: tag, publishedAt, releases })
  return Object.freeze({ made: 'restamp', ...restamped })
}

function originalKeyFrom(originalKey) {
  if (
    !isPlainObject(originalKey)
    || originalKey.algorithm !== 'ed25519'
    || typeof originalKey.keyId !== 'string'
    || deriveKeyId(originalKey.publicKeySpkiBase64) !== originalKey.keyId
  ) {
    fail('originalKey must be an ed25519 key whose id derives from its public key')
  }
  return originalKey
}

// G10's only waiver: the exact emergency override for this tag and signing key, which
// knowingly cuts off apps from 1.2 to 1.6 (design §7.3).
function waiveOriginalKey(reg, newTag, rotationOverride, key) {
  const expected = rotationOverrideFor(newTag, reg.signingKeyId)
  if (rotationOverride !== expected) {
    fail(
      `the v1 manifest has no valid signature from ${key.keyId}, the only key apps from 1.2 to 1.6 trust; `
      + `only the exact emergency override "${expected}" waives that, and it cuts those apps off`,
    )
  }
  return Object.freeze({ originalKeySignature: 'waived', rotationOverride: expected })
}

/**
 * G10 before anything is signed: the signer will sign v1 with the registry's signing key
 * alone, so v1 will carry the original key's signature only when that is the signing key.
 * Otherwise the exact override must be set now, so a release that would fail G10 never
 * touches the private key.
 */
export function planOriginalKeySignature({ registry, newTag, rotationOverride, originalKey = ORIGINAL_UPDATE_KEY }) {
  const reg = validateRegistry(registry)
  const key = originalKeyFrom(originalKey)
  if (typeof newTag !== 'string' || !STABLE_TAG_RE.test(newTag)) fail('newTag must be a stable vX.Y.Z tag')
  const signingKey = reg.keys.find((candidate) => candidate.keyId === reg.signingKeyId)
  if (reg.signingKeyId === key.keyId && signingKey.publicKeySpkiBase64 === key.publicKeySpkiBase64) {
    return Object.freeze({ originalKeySignature: 'passed' })
  }
  return waiveOriginalKey(reg, newTag, rotationOverride, key)
}

/**
 * G10 (design §7.3): the signed v1 envelope carries a valid signature of these exact bytes
 * from the original key, or the exact emergency override for this release waives it. The
 * result is what the signing evidence records.
 */
export function checkOriginalKeySignature({ manifestBytes, envelope, registry, newTag, rotationOverride, originalKey = ORIGINAL_UPDATE_KEY }) {
  const reg = validateRegistry(registry)
  const key = originalKeyFrom(originalKey)
  if (typeof newTag !== 'string' || !STABLE_TAG_RE.test(newTag)) fail('newTag must be a stable vX.Y.Z tag')
  const bytes = toBuffer(manifestBytes, 'manifestBytes')
  const parsed = isPlainObject(envelope) && !Buffer.isBuffer(envelope) ? validateEnvelope(envelope) : parseEnvelope(envelope)
  if (sha256Hex(bytes) !== parsed.manifestSha256) {
    fail('manifest bytes do not match the digest recorded in the signature envelope')
  }
  const entry = parsed.signatures.find((candidate) => candidate.keyId === key.keyId)
  const publicKey = createPublicKey({ key: Buffer.from(key.publicKeySpkiBase64, 'base64'), format: 'der', type: 'spki' })
  if (entry && verify(null, bytes, publicKey, Buffer.from(entry.signature, 'base64'))) {
    return Object.freeze({ originalKeySignature: 'passed' })
  }
  return waiveOriginalKey(reg, newTag, rotationOverride, key)
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function readJsonFile(path, label) {
  let raw
  try {
    raw = readFileSync(resolve(path), 'utf8')
  } catch (error) {
    return fail(`unable to read ${label} at ${path}: ${error.message}`)
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    return fail(`${label} at ${path} is not valid JSON: ${error.message}`)
  }
}

function writeBytes(path, bytes) {
  writeFileSync(resolve(path), bytes, { mode: DATA_MODE })
}

function main(argv) {
  const [command, ...rest] = argv

  if (command === 'generate') {
    const { values } = parseArgs({
      args: rest,
      options: {
        registry: { type: 'string' },
        evidence: { type: 'string' },
        'minimum-macos-version': { type: 'string' },
        'published-at': { type: 'string' },
        output: { type: 'string' },
      },
      strict: true,
    })
    if (!values.registry || !values.evidence || !values['minimum-macos-version'] || !values['published-at'] || !values.output) {
      fail('generate requires --registry, --evidence, --minimum-macos-version, --published-at, and --output')
    }
    const registry = validateRegistry(readJsonFile(values.registry, 'registry'))
    const evidence = readJsonFile(values.evidence, 'evidence')
    // `--published-at` is required (no wall-clock fallback): generation must
    // be fully deterministic from its inputs, never silently dependent on the
    // ambient system clock at the moment the CLI happens to run.
    const { bytes } = generateManifest({
      registry,
      evidence,
      minimumMacosVersion: values['minimum-macos-version'],
      publishedAt: values['published-at'],
    })
    writeBytes(values.output, bytes)
    process.stdout.write(`${JSON.stringify({ output: resolve(values.output) })}\n`)
    return
  }

  if (command === 'inspect-history') {
    const { values } = parseArgs({
      args: rest,
      options: {
        releases: { type: 'string' },
        'new-tag': { type: 'string' },
      },
      strict: true,
    })
    if (!values.releases || !values['new-tag']) {
      fail('inspect-history requires --releases and --new-tag')
    }
    const releases = readJsonFile(values.releases, 'releases')
    const plan = planReleaseHistoryContinuity({ releases, newTag: values['new-tag'] })
    process.stdout.write(`${JSON.stringify(plan)}\n`)
    return
  }

  if (command === 'authorize-history') {
    const { values } = parseArgs({
      args: rest,
      options: {
        'prior-manifest': { type: 'string' },
        'prior-signature': { type: 'string' },
        registry: { type: 'string' },
        'new-tag': { type: 'string' },
        'rotation-override': { type: 'string' },
      },
      strict: true,
    })
    if (!values['prior-manifest'] || !values['prior-signature'] || !values.registry || !values['new-tag']) {
      fail('authorize-history requires --prior-manifest, --prior-signature, --registry, and --new-tag')
    }
    const registry = validateRegistry(readJsonFile(values.registry, 'registry'))
    const priorManifestBytes = readFileSync(resolve(values['prior-manifest']))
    const priorSignatureBytes = readFileSync(resolve(values['prior-signature']))
    const result = authorizeReleaseContinuity({
      priorManifestBytes,
      priorSignatureBytes,
      registry,
      newTag: values['new-tag'],
      rotationOverride: values['rotation-override'],
    })
    process.stdout.write(`${JSON.stringify({
      authorized: result.authorized,
      priorTag: result.priorTag,
      rotationOverrideUsed: result.rotationOverrideUsed,
    })}\n`)
    return
  }

  if (command === 'sign') {
    const { values } = parseArgs({
      args: rest,
      options: {
        manifest: { type: 'string' },
        registry: { type: 'string' },
        output: { type: 'string' },
      },
      strict: true,
    })
    if (!values.manifest || !values.registry || !values.output) {
      fail('sign requires --manifest, --registry, and --output')
    }
    const envVarName = 'AGENT_INBOX_UPDATE_PRIVATE_KEY_BASE64'
    const rawEnvValue = process.env[envVarName]
    if (!rawEnvValue) {
      fail(`sign requires the private key PEM (base64-encoded) in the ${envVarName} environment variable`)
    }
    let pemBuffer
    try {
      // Reject non-canonical base64 (nonstandard alphabet, missing/extra
      // padding, embedded whitespace, or an empty value) BEFORE the decoded
      // bytes are used for anything: `Buffer.from(value, 'base64')` silently
      // tolerates and normalizes malformed input, which could otherwise mask
      // a corrupted or truncated secret. Standard base64 (RFC 4648 §4) must
      // round-trip byte-for-byte through decode + re-encode. Neither the raw
      // value nor the decoded bytes are ever included in an error message,
      // stdout, or any other log output.
      pemBuffer = Buffer.from(rawEnvValue, 'base64')
      if (pemBuffer.length === 0 || pemBuffer.toString('base64') !== rawEnvValue) {
        fail(`${envVarName} must be canonical standard base64 (RFC 4648) encoding a nonempty value`)
      }
      const registry = validateRegistry(readJsonFile(values.registry, 'registry'))
      const manifestBytes = readFileSync(resolve(values.manifest))
      const { envelope, bytes } = signManifest({ manifestBytes, registry, privateKeyPem: pemBuffer })
      writeBytes(values.output, bytes)
      process.stdout.write(`${JSON.stringify({
        keyIds: envelope.signatures.map((entry) => entry.keyId),
        manifestSha256: envelope.manifestSha256,
      })}\n`)
    } finally {
      if (pemBuffer) pemBuffer.fill(0)
      delete process.env[envVarName]
    }
    return
  }

  if (command === 'verify') {
    const { values } = parseArgs({
      args: rest,
      options: {
        manifest: { type: 'string' },
        signature: { type: 'string' },
        registry: { type: 'string' },
        now: { type: 'string' },
      },
      strict: true,
    })
    if (!values.manifest || !values.signature || !values.registry) {
      fail('verify requires --manifest, --signature, and --registry')
    }
    const registry = validateRegistry(readJsonFile(values.registry, 'registry'))
    const manifestBytes = readFileSync(resolve(values.manifest))
    const signatureBytes = readFileSync(resolve(values.signature))
    const manifest = verifyManifest({
      manifestBytes,
      envelope: signatureBytes,
      registry,
      now: values.now,
    })
    process.stdout.write(`${JSON.stringify({ valid: true, tag: manifest.tag, expiresAt: manifest.expiresAt })}\n`)
    return
  }

  fail(`unknown update-manifest command: ${command ?? '(missing)'}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`update-manifest: ${error.message}\n`)
    process.exitCode = 1
  }
}
