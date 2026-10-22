import { parseArgs } from 'node:util'
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

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
} = runtime
// Internal-only shared constant (not part of the combined public API): the
// exact five update targets, reused here so manifest generation can never
// drift from what `electron/update-manifest.cjs`'s `validateManifest` accepts.
const { TARGET_SPECS, targetTuple } = runtime

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
