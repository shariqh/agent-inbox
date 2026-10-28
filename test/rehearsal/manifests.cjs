'use strict'

// The manifests the rehearsal serves (#344; update manifest v2 design §8.5): what
// releases/latest/download answers once the arm64-only release is published, signed with a
// scratch Ed25519 key made here, at run time. The private key never leaves this function.
//
// - update-manifest-v2.json describes that release, `next`: an arm64 DMG and the four Linux
//   packages, made by the publisher's own generateManifestV2. None of its files exists.
// - update-manifest.json is 1.x-last's real published manifest re-stamped by the
//   publisher's own restampV1, so its macOS target is the real, notarized 1.x-last DMG.
//
// The publisher code is this checkout's scripts/update-manifest.mjs. The code under test,
// the reader, comes from the installed app and gets only `registry`, which trusts the
// scratch key alone.

const { createHash, generateKeyPairSync } = require('node:crypto')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const DAY_MS = 24 * 60 * 60 * 1000
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
// The four top-level fields a re-stamp changes (design §5.3); it copies every other one.
const RESTAMPED_FIELDS = Object.freeze(['expiresAt', 'publishedAt', 'signingKeyId', 'trustedKeyIds'])

function digest(algorithm, text) {
  return createHash(algorithm).update(text).digest('hex')
}

function nextPatch(version) {
  const match = VERSION_RE.exec(version)
  if (!match) throw new TypeError(`${version} is not an X.Y.Z version`)
  return `${match[1]}.${match[2]}.${BigInt(match[3]) + 1n}`
}

// The release evidence generateManifestV2 needs for an arm64 release: its own DMG and the
// four Linux packages, named by the reader's own catalog. Sizes and digests are made up.
function arm64Evidence(catalog, version) {
  const tag = `v${version}`
  const assets = catalog
    .filter((spec) => spec.platform !== 'darwin' || spec.architecture === 'arm64')
    .map((spec) => {
      const name = spec.filename(tag, version)
      return {
        name,
        platform: spec.platform,
        architecture: spec.architecture,
        packageType: spec.packageType,
        size: 1024 * 1024,
        sha256: digest('sha256', `agent-inbox rehearsal ${name}`),
      }
    })
  return {
    tag,
    packageVersion: version,
    sourceCommit: digest('sha1', `agent-inbox rehearsal ${tag} commit`),
    sourceTree: digest('sha1', `agent-inbox rehearsal ${tag} tree`),
    assets,
  }
}

/**
 * Signs the rehearsal's two manifests with a fresh scratch key.
 *
 * @param {object} options
 * @param {{ manifest: Buffer, signature: Buffer }} options.published 1.x-last's published
 *   update-manifest.json and its signature
 * @param {object[]} options.releases GitHub's release listing, as restampV1 reads it
 * @param {object} options.productionRegistry release/update-keys.json, whose original key
 *   signed the published pair
 * @param {string} options.next the version of the arm64-only release both manifests come from
 * @param {Date} [options.now] the clock: both manifests are published at its whole second
 */
async function prepareManifests({ published, releases, productionRegistry, next, now = new Date() }) {
  if (typeof next !== 'string' || !VERSION_RE.test(next)) throw new TypeError('next must be an X.Y.Z version')
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('now must be a valid Date')
  const publisher = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts', 'update-manifest.mjs')).href)
  const { TARGET_SPECS_V2 } = require(path.join(REPO_ROOT, 'electron', 'update-manifest.cjs'))
  const production = publisher.validateRegistry(productionRegistry)
  const lastRelease = publisher.verifyManifest({
    manifestBytes: published.manifest,
    envelope: published.signature,
    registry: production,
  })
  const dmg = lastRelease.targets.find((target) => target.platform === 'darwin')

  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeySpkiBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  const keyId = publisher.deriveKeyId(publicKeySpkiBase64)
  const scratchKey = { keyId, algorithm: 'ed25519', publicKeySpkiBase64 }
  // The reader trusts the scratch key alone. The publisher also holds the production keys,
  // because restampV1 verifies the published pair under its own registry.
  const registry = publisher.validateRegistry({ schema: 1, signingKeyId: keyId, keys: [scratchKey] })
  const signer = publisher.validateRegistry({ schema: 1, signingKeyId: keyId, keys: [...production.keys, scratchKey] })
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const signed = (bytes) => ({
    bytes,
    signature: publisher.signManifest({ manifestBytes: bytes, registry: signer, privateKeyPem, now }).bytes,
  })

  const publishedAt = new Date(Math.floor(now.getTime() / 1000) * 1000)
  const v2 = publisher.generateManifestV2({
    registry: signer,
    evidence: arm64Evidence(TARGET_SPECS_V2, next),
    minimumMacosVersion: dmg.minimumSystemVersion,
    publishedAt,
    kind: 'arm64',
  })
  const restamp = (tag, at) => publisher.restampV1({
    earlierManifestBytes: published.manifest,
    earlierSignatureBytes: published.signature,
    registry: signer,
    newTag: tag,
    publishedAt: at,
    releases,
  })
  const v1 = restamp(`v${next}`, publishedAt)
  // The release after `next` re-stamps the same manifest a day later. Its signature beside
  // this release's manifest is the pair a reader gets while a release is being published.
  const later = restamp(`v${nextPatch(next)}`, new Date(publishedAt.getTime() + DAY_MS))

  return Object.freeze({
    registry,
    publishedAt: v1.manifest.publishedAt,
    describes: v1.describes,
    v2: Object.freeze(signed(v2.bytes)),
    v1: Object.freeze(signed(v1.bytes)),
    laterV1Signature: signed(later.bytes).signature,
  })
}

/** The top-level fields whose values differ between two manifests, sorted. */
function restampDifferences(earlierBytes, restampedBytes) {
  const earlier = JSON.parse(earlierBytes.toString('utf8'))
  const restamped = JSON.parse(restampedBytes.toString('utf8'))
  const fields = new Set([...Object.keys(earlier), ...Object.keys(restamped)])
  return [...fields].filter((field) => JSON.stringify(earlier[field]) !== JSON.stringify(restamped[field])).sort()
}

module.exports = {
  RESTAMPED_FIELDS,
  nextPatch,
  prepareManifests,
  restampDifferences,
}
