import { createHash } from 'node:crypto'
import { generateKeyPairSync, sign as edSign } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
// Generation, signing, and release-history/anti-brick concerns are build-time
// only and remain owned by `scripts/update-manifest.mjs`.
import {
  generateManifest,
  serializeManifest,
  signManifest,
  ORIGINAL_UPDATE_KEY,
  generateManifestV2,
  projectV1,
  restampV1,
  planReleaseHistory,
  authorizeReleaseHistory,
  checkReleaseManifest,
  deriveV1,
  planOriginalKeySignature,
  checkOriginalKeySignature,
  bindSigningEvidence,
} from '../scripts/update-manifest.mjs'
import type {
  ManifestHistoryAsset,
  ManifestHistoryPlan,
  ReleaseEvidence,
  ReleaseAssetEvidence,
  ReleaseLike,
  ReleaseAssetLike,
} from '../scripts/update-manifest.d.mts'
import { macosRelease } from '../scripts/macos-release-kind.mjs'

// Verification-related exports (registry/key-id/manifest/envelope parsing,
// validation, and raw-byte signature verification) are tested against the
// shipped `electron/update-manifest.cjs` runtime directly — the same module
// Electron's main process loads in production — rather than through
// `scripts/update-manifest.mjs`, which merely re-exports it via
// `createRequire` for build-time convenience.
//
// This test file also loads it through `createRequire` (rather than a static
// ESM import), matching `scripts/update-manifest.mjs`'s own loading
// mechanism and the existing convention in `test/setup-process.test.ts` /
// `test/setup-runner.test.ts`. Under real Node this is not required (a
// `.cjs` module resolves to one singleton regardless of how it's imported),
// but Vitest's SSR module loader can otherwise instantiate `.mjs`-imported
// vs. `createRequire`-required copies of the same `.cjs` file separately,
// which would break `instanceof UpdateManifestError` checks for errors
// thrown from inside `scripts/update-manifest.mjs` (which always reaches
// the runtime via `createRequire`). Requiring it the same way here keeps
// both references pinned to Node's single native module cache entry.
const require = createRequire(import.meta.url)
const updateManifestRuntime = require('../electron/update-manifest.cjs') as typeof import('../electron/update-manifest.cjs')
type UpdateRegistry = import('../electron/update-manifest.cjs').UpdateRegistry

const {
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
  TARGET_SPECS,
  TARGET_SPECS_V2,
  targetTuple,
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
} = updateManifestRuntime

const root = resolve(process.cwd())

// --- Production registry constants supplied by the issue (public only). ---
const PROD_KEY_ID = 'ed25519-99927ba2f6af6482'
const PROD_PUBLIC_KEY_SPKI_BASE64 = 'MCowBQYDK2VwAyEAshsgCvPUphCyxSv/sgvDCBvdde/Ws+CU0Fgdl62SU/k='
// The backup key (#342): trusted beside the original key, never signing unless the
// emergency procedure in docs/macos-release.md switches to it.
const BACKUP_KEY_ID = 'ed25519-c8adddea0de080d6'
const BACKUP_PUBLIC_KEY_SPKI_BASE64 = 'MCowBQYDK2VwAyEAifNxVIclsvrJJ9+4Lx6Q0ahVR6dRpCt/dJ6B3U2hRLA='

function makeEphemeralKeypair(): { keyId: string; publicKeySpkiBase64: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeySpkiBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString('utf8')
  const keyId = deriveKeyId(publicKeySpkiBase64)
  return { keyId, publicKeySpkiBase64, privateKeyPem }
}

function makeRegistry(...keypairs: ReturnType<typeof makeEphemeralKeypair>[]): UpdateRegistry {
  const first = keypairs[0]
  if (!first) throw new Error('makeRegistry requires at least one keypair')
  return {
    schema: 1,
    signingKeyId: first.keyId,
    keys: keypairs.map((k) => ({
      keyId: k.keyId,
      algorithm: 'ed25519' as const,
      publicKeySpkiBase64: k.publicKeySpkiBase64,
    })),
  }
}

const version = '1.2.3'
const tag = `v${version}`
const sourceCommit = 'a'.repeat(40)
const sourceTree = 'b'.repeat(40)
const publishedAt = '2026-01-01T00:00:00Z'
const minimumMacosVersion = '13.5'

function evidenceAsset(overrides: Partial<ReleaseAssetEvidence>): ReleaseAssetEvidence {
  return {
    name: '',
    packageType: 'dmg',
    platform: 'darwin',
    architecture: 'universal',
    size: 100,
    sha256: 'a'.repeat(64),
    ...overrides,
  }
}

function buildEvidence(overrides: Partial<ReleaseEvidence> = {}): ReleaseEvidence {
  const effectiveTag = overrides.tag ?? tag
  const effectiveVersion = overrides.packageVersion ?? effectiveTag.replace(/^v/, '')
  return {
    tag: effectiveTag,
    packageVersion: effectiveVersion,
    sourceCommit,
    sourceTree,
    assets: [
      evidenceAsset({
        name: `Agent-Inbox-${effectiveTag}-universal.dmg`,
        packageType: 'dmg',
        platform: 'darwin',
        architecture: 'universal',
        size: 111,
        sha256: 'a'.repeat(64),
      }),
      evidenceAsset({
        name: `Agent-Inbox-v${effectiveVersion}-linux-x86_64.AppImage`,
        packageType: 'appimage',
        platform: 'linux',
        architecture: 'x64',
        size: 222,
        sha256: 'b'.repeat(64),
      }),
      evidenceAsset({
        name: `Agent-Inbox-v${effectiveVersion}-linux-arm64.AppImage`,
        packageType: 'appimage',
        platform: 'linux',
        architecture: 'arm64',
        size: 333,
        sha256: 'c'.repeat(64),
      }),
      evidenceAsset({
        name: `agent-inbox_${effectiveVersion}_amd64.deb`,
        packageType: 'deb',
        platform: 'linux',
        architecture: 'x64',
        size: 444,
        sha256: 'd'.repeat(64),
      }),
      evidenceAsset({
        name: `agent-inbox_${effectiveVersion}_arm64.deb`,
        packageType: 'deb',
        platform: 'linux',
        architecture: 'arm64',
        size: 555,
        sha256: 'e'.repeat(64),
      }),
    ],
    ...overrides,
  }
}

const EXPECTED_TARGET_ORDER = [
  'darwin/universal/dmg',
  'linux/arm64/appimage',
  'linux/arm64/deb',
  'linux/x64/appimage',
  'linux/x64/deb',
]

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function at<T>(arr: readonly T[], index: number): T {
  const value = arr[index]
  if (value === undefined) throw new Error(`expected element at index ${index}`)
  return value
}

describe('deriveKeyId', () => {
  it('derives the documented production key id from its SPKI DER base64', () => {
    expect(deriveKeyId(PROD_PUBLIC_KEY_SPKI_BASE64)).toBe(PROD_KEY_ID)
  })

  it('rejects non-canonical base64 (invalid characters)', () => {
    expect(() => deriveKeyId('not base64!!')).toThrow(UpdateManifestError)
  })

  it('rejects non-canonical base64 (non-canonical padding/whitespace)', () => {
    expect(() => deriveKeyId(`${PROD_PUBLIC_KEY_SPKI_BASE64}\n`)).toThrow(UpdateManifestError)
    expect(() => deriveKeyId(PROD_PUBLIC_KEY_SPKI_BASE64.replace(/=$/, ''))).toThrow(UpdateManifestError)
  })

  it('rejects a non-ed25519 key type (e.g. X25519)', () => {
    const { publicKey } = generateKeyPairSync('x25519')
    const der = publicKey.export({ type: 'spki', format: 'der' })
    expect(() => deriveKeyId(der.toString('base64'))).toThrow(UpdateManifestError)
  })

  it('rejects malformed DER', () => {
    expect(() => deriveKeyId(Buffer.from('not a real der key').toString('base64'))).toThrow(UpdateManifestError)
  })
})

describe('release/update-keys.json (production registry)', () => {
  it('lists the original key and the backup key, and still signs with the original', () => {
    const raw = readFileSync(join(root, 'release', 'update-keys.json'), 'utf8')
    expect(parseRegistry(raw)).toEqual({
      schema: UPDATE_REGISTRY_SCHEMA,
      signingKeyId: PROD_KEY_ID,
      keys: [
        { keyId: PROD_KEY_ID, algorithm: 'ed25519', publicKeySpkiBase64: PROD_PUBLIC_KEY_SPKI_BASE64 },
        { keyId: BACKUP_KEY_ID, algorithm: 'ed25519', publicKeySpkiBase64: BACKUP_PUBLIC_KEY_SPKI_BASE64 },
      ],
    })
    expect(deriveKeyId(BACKUP_PUBLIC_KEY_SPKI_BASE64)).toBe(BACKUP_KEY_ID)
  })

  it('never contains private key material', () => {
    const raw = readFileSync(join(root, 'release', 'update-keys.json'), 'utf8')
    expect(raw).not.toMatch(/PRIVATE KEY/)
  })
})

describe('validateRegistry — malformed registries', () => {
  const good = makeEphemeralKeypair()

  it('rejects extra top-level fields', () => {
    expect(() => validateRegistry({ ...makeRegistry(good), extra: true })).toThrow(UpdateManifestError)
  })

  it('rejects missing top-level fields', () => {
    const { keys } = makeRegistry(good)
    expect(() => validateRegistry({ schema: 1, keys })).toThrow(UpdateManifestError)
  })

  it('rejects a wrong schema value', () => {
    expect(() => validateRegistry({ ...makeRegistry(good), schema: 2 })).toThrow(UpdateManifestError)
  })

  it('rejects extra/missing fields on a key entry', () => {
    const reg = makeRegistry(good)
    expect(() => validateRegistry({ ...reg, keys: [{ ...reg.keys[0], extra: 1 }] })).toThrow(UpdateManifestError)
    const { keyId, algorithm } = at(reg.keys, 0)
    expect(() => validateRegistry({ ...reg, keys: [{ keyId, algorithm }] })).toThrow(UpdateManifestError)
  })

  it('rejects a non-ed25519 algorithm value', () => {
    const reg = makeRegistry(good)
    expect(() => validateRegistry({ ...reg, keys: [{ ...reg.keys[0], algorithm: 'rsa' }] })).toThrow(UpdateManifestError)
  })

  it('rejects a keyId that does not derive from its DER', () => {
    const reg = makeRegistry(good)
    expect(() => validateRegistry({
      ...reg,
      keys: [{ ...reg.keys[0], keyId: 'ed25519-0000000000000000' }],
    })).toThrow(UpdateManifestError)
  })

  it('rejects duplicate keyIds', () => {
    const other = makeEphemeralKeypair()
    const reg = makeRegistry(good, other)
    expect(() => validateRegistry({
      ...reg,
      keys: [...reg.keys, reg.keys[0]],
    })).toThrow(UpdateManifestError)
  })

  it('rejects a signingKeyId not present among keys', () => {
    const reg = makeRegistry(good)
    expect(() => validateRegistry({ ...reg, signingKeyId: 'ed25519-1111111111111111' })).toThrow(UpdateManifestError)
  })

  it('rejects malformed base64 inside a key entry', () => {
    const reg = makeRegistry(good)
    expect(() => validateRegistry({
      ...reg,
      keys: [{ ...reg.keys[0], publicKeySpkiBase64: 'not-base64!!' }],
    })).toThrow(UpdateManifestError)
  })

  it('accepts a well-formed multi-key registry', () => {
    const other = makeEphemeralKeypair()
    const reg = makeRegistry(good, other)
    const validated = validateRegistry(reg)
    expect(validated.keys.map((k) => k.keyId).sort()).toEqual([good.keyId, other.keyId].sort())
  })
})

describe('generateManifest — exact five-target mapping', () => {
  it('produces exactly the five required targets in deterministic sorted order', () => {
    const good = makeEphemeralKeypair()
    const registry = makeRegistry(good)
    const { manifest } = generateManifest({
      registry,
      evidence: buildEvidence(),
      minimumMacosVersion,
      publishedAt,
    })
    expect(manifest.targets.map((t) => `${t.platform}/${t.architecture}/${t.packageType}`))
      .toEqual(EXPECTED_TARGET_ORDER)
    const dmg = at(manifest.targets, 0)
    expect(dmg.installStrategy).toBe('macos-dmg')
    expect(dmg.minimumSystemVersion).toBe('13.5')
    expect(dmg.filename).toBe(`Agent-Inbox-${tag}-universal.dmg`)
    expect(dmg.url).toBe(`https://github.com/shariqh/agent-inbox/releases/download/${tag}/Agent-Inbox-${tag}-universal.dmg`)
    for (const t of manifest.targets.slice(1)) {
      expect(t).not.toHaveProperty('minimumSystemVersion')
      expect(['appimage-self-replace', 'deb-notify']).toContain(t.installStrategy)
    }
    expect(at(manifest.targets, 1).filename).toBe(`Agent-Inbox-v${version}-linux-arm64.AppImage`)
    expect(at(manifest.targets, 2).filename).toBe(`agent-inbox_${version}_arm64.deb`)
    expect(at(manifest.targets, 3).filename).toBe(`Agent-Inbox-v${version}-linux-x86_64.AppImage`)
    expect(at(manifest.targets, 4).filename).toBe(`agent-inbox_${version}_amd64.deb`)
  })

  it('derives targets only from evidence, not from ambient state', () => {
    const good = makeEphemeralKeypair()
    const registry = makeRegistry(good)
    const originalNow = Date.now
    Date.now = () => {
      throw new Error('generateManifest must not read the ambient clock when publishedAt is supplied')
    }
    try {
      expect(() => generateManifest({
        registry,
        evidence: buildEvidence(),
        minimumMacosVersion,
        publishedAt,
      })).not.toThrow()
    } finally {
      Date.now = originalNow
    }
  })

  it('computes expiresAt exactly 180 days after publishedAt', () => {
    const good = makeEphemeralKeypair()
    const registry = makeRegistry(good)
    const { manifest } = generateManifest({
      registry,
      evidence: buildEvidence(),
      minimumMacosVersion,
      publishedAt,
    })
    expect(MANIFEST_LIFETIME_DAYS).toBe(180)
    const expected = new Date(new Date(publishedAt).getTime() + 180 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    expect(manifest.expiresAt).toBe(expected)
  })

  it('sets signingKeyId from registry.signingKeyId and trustedKeyIds to the complete sorted registry key ids', () => {
    const a = makeEphemeralKeypair()
    const b = makeEphemeralKeypair()
    const registry = makeRegistry(a, b)
    const { manifest } = generateManifest({
      registry,
      evidence: buildEvidence(),
      minimumMacosVersion,
      publishedAt,
    })
    expect(manifest.signingKeyId).toBe(registry.signingKeyId)
    expect(manifest.trustedKeyIds).toEqual([a.keyId, b.keyId].sort())
  })

  it('rejects evidence missing a required target asset', () => {
    const good = makeEphemeralKeypair()
    const registry = makeRegistry(good)
    const evidence = { ...buildEvidence() }
    evidence.assets = evidence.assets.slice(1)
    expect(() => generateManifest({ registry, evidence, minimumMacosVersion, publishedAt })).toThrow(UpdateManifestError)
  })

  it('rejects evidence with a duplicate target asset', () => {
    const good = makeEphemeralKeypair()
    const registry = makeRegistry(good)
    const base = buildEvidence()
    const evidence = { ...base, assets: [...base.assets, { ...at(base.assets, 0) }] }
    expect(() => generateManifest({ registry, evidence, minimumMacosVersion, publishedAt })).toThrow(UpdateManifestError)
  })

  it('rejects an asset filename that does not match the tag/version convention', () => {
    const good = makeEphemeralKeypair()
    const registry = makeRegistry(good)
    const base = buildEvidence()
    const evidence = {
      ...base,
      assets: base.assets.map((a, i) => (i === 0 ? { ...a, name: 'wrong-name.dmg' } : a)),
    }
    expect(() => generateManifest({ registry, evidence, minimumMacosVersion, publishedAt })).toThrow(UpdateManifestError)
  })

  it('rejects a tag/version mismatch in evidence', () => {
    const good = makeEphemeralKeypair()
    const registry = makeRegistry(good)
    const evidence = buildEvidence({ tag: 'v9.9.9', packageVersion: '1.2.3' })
    expect(() => generateManifest({ registry, evidence, minimumMacosVersion, publishedAt })).toThrow(UpdateManifestError)
  })

  it('rejects a leading-zero numeric identifier in evidence.packageVersion', () => {
    const good = makeEphemeralKeypair()
    const registry = makeRegistry(good)
    const evidence = buildEvidence({ tag: 'v01.2.3', packageVersion: '01.2.3' })
    expect(() => generateManifest({ registry, evidence, minimumMacosVersion, publishedAt })).toThrow(UpdateManifestError)
  })
})

describe('deterministic serialization', () => {
  it('produces byte-identical output across different ambient TZ settings', () => {
    const good = makeEphemeralKeypair()
    const registry = makeRegistry(good)
    const originalTz = process.env.TZ

    process.env.TZ = 'UTC'
    const { bytes: bytesUtc } = generateManifest({ registry, evidence: buildEvidence(), minimumMacosVersion, publishedAt })

    process.env.TZ = 'Pacific/Kiritimati'
    const { bytes: bytesFarTz } = generateManifest({ registry, evidence: buildEvidence(), minimumMacosVersion, publishedAt })

    process.env.TZ = originalTz

    expect(bytesFarTz.equals(bytesUtc)).toBe(true)
  })

  it('produces byte-identical output across repeated calls with the same explicit inputs', () => {
    const good = makeEphemeralKeypair()
    const registry = makeRegistry(good)
    const { bytes: first } = generateManifest({ registry, evidence: buildEvidence(), minimumMacosVersion, publishedAt })
    const { bytes: second } = generateManifest({ registry, evidence: buildEvidence(), minimumMacosVersion, publishedAt })
    expect(second.equals(first)).toBe(true)
  })

  it('serializes with fixed key order regardless of input object key order', () => {
    const good = makeEphemeralKeypair()
    const registry = makeRegistry(good)
    const { manifest, bytes } = generateManifest({ registry, evidence: buildEvidence(), minimumMacosVersion, publishedAt })
    const shuffled = JSON.parse(JSON.stringify(manifest))
    const reordered = {
      targets: shuffled.targets,
      trustedKeyIds: shuffled.trustedKeyIds,
      signingKeyId: shuffled.signingKeyId,
      releaseUrl: shuffled.releaseUrl,
      expiresAt: shuffled.expiresAt,
      publishedAt: shuffled.publishedAt,
      source: { tree: shuffled.source.tree, commit: shuffled.source.commit },
      tag: shuffled.tag,
      version: shuffled.version,
      repository: shuffled.repository,
      kind: shuffled.kind,
      schema: shuffled.schema,
    }
    const reorderedBytes = serializeManifest(reordered)
    expect(reorderedBytes.equals(bytes)).toBe(true)
  })

  it('ends with exactly one trailing newline and pretty-printed 2-space indentation', () => {
    const good = makeEphemeralKeypair()
    const registry = makeRegistry(good)
    const { bytes } = generateManifest({ registry, evidence: buildEvidence(), minimumMacosVersion, publishedAt })
    const text = bytes.toString('utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect(text.endsWith('\n\n')).toBe(false)
    expect(text).toContain('\n  "schema": 1,')
  })
})

describe('validateManifest — malformed manifests', () => {
  function goodManifest() {
    const good = makeEphemeralKeypair()
    const registry = makeRegistry(good)
    return generateManifest({ registry, evidence: buildEvidence(), minimumMacosVersion, publishedAt }).manifest
  }

  it('accepts a well-formed manifest unchanged', () => {
    const manifest = goodManifest()
    expect(validateManifest(JSON.parse(JSON.stringify(manifest)))).toBeTruthy()
  })

  it('rejects extra or missing top-level fields', () => {
    const manifest = goodManifest()
    expect(() => validateManifest({ ...manifest, extra: 1 })).toThrow(UpdateManifestError)
    const { schema: _schema, ...withoutSchema } = manifest
    expect(() => validateManifest(withoutSchema)).toThrow(UpdateManifestError)
  })

  it('rejects wrong schema/kind/repository', () => {
    const manifest = goodManifest()
    expect(() => validateManifest({ ...manifest, schema: 2 })).toThrow(UpdateManifestError)
    expect(() => validateManifest({ ...manifest, kind: 'something-else' })).toThrow(UpdateManifestError)
    expect(() => validateManifest({ ...manifest, repository: 'someone/else' })).toThrow(UpdateManifestError)
  })

  it('rejects a non-stable semver version', () => {
    const manifest = goodManifest()
    for (const bad of ['1.2', '1.2.3-rc.1', '1.2.3+build.5', 'v1.2.3', '1.2.3.4', '01.2.3', '1.02.3', '1.2.03', '01.02.03']) {
      expect(() => validateManifest({ ...manifest, version: bad })).toThrow(UpdateManifestError)
    }
  })

  it('rejects a tag that does not exactly match vX.Y.Z of version', () => {
    const manifest = goodManifest()
    expect(() => validateManifest({ ...manifest, tag: 'v9.9.9' })).toThrow(UpdateManifestError)
  })

  it('rejects non-lowercase or wrong-length source commit/tree', () => {
    const manifest = goodManifest()
    expect(() => validateManifest({ ...manifest, source: { ...manifest.source, commit: 'A'.repeat(40) } })).toThrow(UpdateManifestError)
    expect(() => validateManifest({ ...manifest, source: { ...manifest.source, commit: 'a'.repeat(39) } })).toThrow(UpdateManifestError)
    expect(() => validateManifest({ ...manifest, source: { ...manifest.source, tree: 'z'.repeat(41) } })).toThrow(UpdateManifestError)
  })

  it('rejects publishedAt/expiresAt with sub-second precision or non-Z offsets', () => {
    const manifest = goodManifest()
    expect(() => validateManifest({ ...manifest, publishedAt: '2026-01-01T00:00:00.000Z' })).toThrow(UpdateManifestError)
    expect(() => validateManifest({ ...manifest, publishedAt: '2026-01-01T00:00:00+00:00' })).toThrow(UpdateManifestError)
  })

  it('rejects an expiresAt that is not exactly 180 days after publishedAt', () => {
    const manifest = goodManifest()
    const oneDayOff = new Date(new Date(manifest.expiresAt).getTime() - 24 * 60 * 60 * 1000)
      .toISOString().replace(/\.\d{3}Z$/, 'Z')
    expect(() => validateManifest({ ...manifest, expiresAt: oneDayOff })).toThrow(UpdateManifestError)
  })

  it('rejects expiresAt at or before publishedAt', () => {
    const manifest = goodManifest()
    expect(() => validateManifest({ ...manifest, expiresAt: manifest.publishedAt })).toThrow(UpdateManifestError)
  })

  it('rejects a releaseUrl that does not exactly match the canonical tag URL', () => {
    const manifest = goodManifest()
    expect(() => validateManifest({
      ...manifest,
      releaseUrl: `https://github.com/${UPDATE_REPOSITORY}/releases/tag/${manifest.tag}?utm=1`,
    })).toThrow(UpdateManifestError)
  })

  it('rejects signingKeyId not included in trustedKeyIds', () => {
    const manifest = goodManifest()
    expect(() => validateManifest({ ...manifest, signingKeyId: 'ed25519-2222222222222222' })).toThrow(UpdateManifestError)
  })

  it('rejects unsorted or duplicate trustedKeyIds', () => {
    const a = makeEphemeralKeypair()
    const b = makeEphemeralKeypair()
    const registry = makeRegistry(a, b)
    const { manifest } = generateManifest({ registry, evidence: buildEvidence(), minimumMacosVersion, publishedAt })
    const reversed = [...manifest.trustedKeyIds].reverse()
    if (reversed.join() !== manifest.trustedKeyIds.join()) {
      expect(() => validateManifest({ ...manifest, trustedKeyIds: reversed })).toThrow(UpdateManifestError)
    }
    expect(() => validateManifest({ ...manifest, trustedKeyIds: [...manifest.trustedKeyIds, manifest.trustedKeyIds[0]] })).toThrow(UpdateManifestError)
  })

  it('rejects missing/duplicate/extra targets', () => {
    const manifest = goodManifest()
    expect(() => validateManifest({ ...manifest, targets: manifest.targets.slice(1) })).toThrow(UpdateManifestError)
    expect(() => validateManifest({ ...manifest, targets: [...manifest.targets, at(manifest.targets, 0)] })).toThrow(UpdateManifestError)
  })

  it('rejects targets out of the required sorted order', () => {
    const manifest = goodManifest()
    const swapped = [...manifest.targets]
    const first = at(swapped, 0)
    const second = at(swapped, 1)
    swapped[0] = second
    swapped[1] = first
    expect(() => validateManifest({ ...manifest, targets: swapped })).toThrow(UpdateManifestError)
  })

  it('rejects the wrong installStrategy for a packageType', () => {
    const manifest = goodManifest()
    const targets = manifest.targets.map((t, i) => (i === 1 ? { ...t, installStrategy: 'deb-notify' } : t))
    expect(() => validateManifest({ ...manifest, targets })).toThrow(UpdateManifestError)
  })

  it('rejects minimumSystemVersion present on a non-mac target', () => {
    const manifest = goodManifest()
    const targets = manifest.targets.map((t, i) => (i === 1 ? { ...t, minimumSystemVersion: '13.5' } : t))
    expect(() => validateManifest({ ...manifest, targets })).toThrow(UpdateManifestError)
  })

  it('rejects a mac target missing minimumSystemVersion', () => {
    const manifest = goodManifest()
    const targets = manifest.targets.map((t, i) => {
      if (i !== 0) return t
      const { minimumSystemVersion: _drop, ...rest } = t
      return rest
    })
    expect(() => validateManifest({ ...manifest, targets })).toThrow(UpdateManifestError)
  })

  it('rejects target URLs with a query string, fragment, userinfo, wrong host, or wrong scheme', () => {
    const manifest = goodManifest()
    const base = at(manifest.targets, 0).url
    const userinfoUser = 'no'
    const userinfoPass = 'op'
    const userinfoUrl = base.replace('https://github.com', `https://${userinfoUser}:${userinfoPass}@github.com`)
    const bads = [
      `${base}?x=1`,
      `${base}#frag`,
      userinfoUrl,
      base.replace('github.com', 'evil.example.com'),
      base.replace('https://', 'http://'),
    ]
    for (const bad of bads) {
      const targets = manifest.targets.map((t, i) => (i === 0 ? { ...t, url: bad } : t))
      expect(() => validateManifest({ ...manifest, targets })).toThrow(UpdateManifestError)
    }
  })

  it('rejects a non-positive or non-integer byteLength', () => {
    const manifest = goodManifest()
    for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 10]) {
      const targets = manifest.targets.map((t, i) => (i === 0 ? { ...t, byteLength: bad } : t))
      expect(() => validateManifest({ ...manifest, targets })).toThrow(UpdateManifestError)
    }
  })

  it('rejects a malformed sha256 on a target', () => {
    const manifest = goodManifest()
    const targets = manifest.targets.map((t, i) => (i === 0 ? { ...t, sha256: 'A'.repeat(64) } : t))
    expect(() => validateManifest({ ...manifest, targets })).toThrow(UpdateManifestError)
  })
})

describe('validateEnvelope — malformed envelopes', () => {
  function goodEnvelope() {
    const good = makeEphemeralKeypair()
    const registry = makeRegistry(good)
    const { bytes } = generateManifest({ registry, evidence: buildEvidence(), minimumMacosVersion, publishedAt })
    return signManifest({ manifestBytes: bytes, registry, privateKeyPem: good.privateKeyPem, now: publishedAt }).envelope
  }

  it('accepts a well-formed single-signature envelope', () => {
    expect(validateEnvelope(goodEnvelope())).toBeTruthy()
  })

  it('accepts a well-formed multi-signature envelope with entries sorted by keyId', () => {
    const envelope = goodEnvelope()
    const other = makeEphemeralKeypair()
    const otherSig = edSign(null, Buffer.from(envelope.manifestSha256, 'hex'), {
      key: other.privateKeyPem,
      format: 'pem',
      type: 'pkcs8',
    })
    const entries = [
      { algorithm: 'ed25519' as const, keyId: at(envelope.signatures, 0).keyId, signature: at(envelope.signatures, 0).signature },
      { algorithm: 'ed25519' as const, keyId: other.keyId, signature: otherSig.toString('base64') },
    ].sort((a, b) => (a.keyId < b.keyId ? -1 : a.keyId > b.keyId ? 1 : 0))
    const multiEnvelope = { schema: 1 as const, manifestSha256: envelope.manifestSha256, signatures: entries }
    const validated = validateEnvelope(multiEnvelope)
    expect(validated.signatures.map((s) => s.keyId)).toEqual(entries.map((e) => e.keyId))
  })

  it('rejects extra/missing top-level fields', () => {
    const envelope = goodEnvelope()
    expect(() => validateEnvelope({ ...envelope, extra: 1 })).toThrow(UpdateManifestError)
    const { schema: _s, ...withoutSchema } = envelope
    expect(() => validateEnvelope(withoutSchema)).toThrow(UpdateManifestError)
  })

  it('rejects a wrong schema', () => {
    const envelope = goodEnvelope()
    expect(() => validateEnvelope({ ...envelope, schema: 2 })).toThrow(UpdateManifestError)
  })

  it('rejects a malformed manifestSha256', () => {
    const envelope = goodEnvelope()
    expect(() => validateEnvelope({ ...envelope, manifestSha256: 'zz'.repeat(32) })).toThrow(UpdateManifestError)
  })

  it('rejects signatures that are not a non-empty array', () => {
    const envelope = goodEnvelope()
    expect(() => validateEnvelope({ ...envelope, signatures: [] })).toThrow(UpdateManifestError)
    expect(() => validateEnvelope({ ...envelope, signatures: 'nope' })).toThrow(UpdateManifestError)
  })

  it('rejects a signature entry with extra/missing fields, wrong algorithm, or malformed keyId', () => {
    const envelope = goodEnvelope()
    const entry = at(envelope.signatures, 0)
    expect(() => validateEnvelope({ ...envelope, signatures: [{ ...entry, extra: 1 }] })).toThrow(UpdateManifestError)
    const { algorithm: _a, ...withoutAlgorithm } = entry
    expect(() => validateEnvelope({ ...envelope, signatures: [withoutAlgorithm] })).toThrow(UpdateManifestError)
    expect(() => validateEnvelope({ ...envelope, signatures: [{ ...entry, algorithm: 'rsa' }] })).toThrow(UpdateManifestError)
    expect(() => validateEnvelope({ ...envelope, signatures: [{ ...entry, keyId: 'not-a-key-id' }] })).toThrow(UpdateManifestError)
  })

  it('rejects non-canonical or wrong-length signature base64', () => {
    const envelope = goodEnvelope()
    const entry = at(envelope.signatures, 0)
    expect(() => validateEnvelope({ ...envelope, signatures: [{ ...entry, signature: 'not base64!!' }] })).toThrow(UpdateManifestError)
    expect(() => validateEnvelope({
      ...envelope,
      signatures: [{ ...entry, signature: Buffer.alloc(10).toString('base64') }],
    })).toThrow(UpdateManifestError)
  })

  it('rejects duplicate keyIds and duplicate signatures across entries', () => {
    const envelope = goodEnvelope()
    const entry = at(envelope.signatures, 0)
    expect(() => validateEnvelope({ ...envelope, signatures: [entry, entry] })).toThrow(UpdateManifestError)

    const other = makeEphemeralKeypair()
    const dupSignatureEntry = { algorithm: 'ed25519' as const, keyId: other.keyId, signature: entry.signature }
    const orderedPair = [entry, dupSignatureEntry].sort((a, b) => (a.keyId < b.keyId ? -1 : a.keyId > b.keyId ? 1 : 0))
    expect(() => validateEnvelope({ ...envelope, signatures: orderedPair })).toThrow(UpdateManifestError)
  })

  it('rejects a non-canonically ordered signatures array (not sorted ascending by keyId)', () => {
    const envelope = goodEnvelope()
    const entry = at(envelope.signatures, 0)
    const other = makeEphemeralKeypair()
    const registry2 = makeRegistry(other)
    const { bytes: manifestBytes2 } = generateManifest({ registry: registry2, evidence: buildEvidence(), minimumMacosVersion, publishedAt })
    const otherSig = edSign(null, manifestBytes2, { key: other.privateKeyPem, format: 'pem', type: 'pkcs8' })
    const otherEntry = { algorithm: 'ed25519' as const, keyId: other.keyId, signature: otherSig.toString('base64') }
    const ascending = [entry, otherEntry].sort((a, b) => (a.keyId < b.keyId ? -1 : a.keyId > b.keyId ? 1 : 0))
    const descending = [...ascending].reverse()
    if (ascending[0]?.keyId === descending[0]?.keyId) return // identical keyIds would be a duplicate, not an ordering case
    expect(() => validateEnvelope({ ...envelope, signatures: descending })).toThrow(UpdateManifestError)
  })

  it('round-trips through serializeEnvelope/parseEnvelope with fixed key order', () => {
    const envelope = goodEnvelope()
    const bytes = serializeEnvelope(envelope)
    expect(parseEnvelope(bytes)).toEqual(envelope)
    const text = bytes.toString('utf8')
    expect(text.indexOf('"schema"')).toBeLessThan(text.indexOf('"manifestSha256"'))
    expect(text.indexOf('"manifestSha256"')).toBeLessThan(text.indexOf('"signatures"'))
    expect(text.indexOf('"algorithm"')).toBeLessThan(text.indexOf('"keyId"'))
    expect(text.indexOf('"keyId"')).toBeGreaterThan(text.indexOf('"signatures"'))
    const keyIdIndex = text.indexOf('"keyId"')
    const signatureFieldIndex = text.indexOf('"signature"', keyIdIndex)
    expect(keyIdIndex).toBeLessThan(signatureFieldIndex)
  })
})

describe('sign / verify — good, wrong key, tamper, whitespace, multi-signature', () => {
  function setup() {
    const good = makeEphemeralKeypair()
    const registry = makeRegistry(good)
    const { bytes: manifestBytes } = generateManifest({ registry, evidence: buildEvidence(), minimumMacosVersion, publishedAt })
    return { good, registry, manifestBytes }
  }

  it('signs with the correct key and verifies successfully, returning the manifest', () => {
    const { good, registry, manifestBytes } = setup()
    const { envelope, bytes: envelopeBytes } = signManifest({ manifestBytes, registry, privateKeyPem: good.privateKeyPem, now: publishedAt })
    const verified = verifyManifest({ manifestBytes, envelope: envelopeBytes, registry })
    expect(verified.tag).toBe(tag)
    expect(envelope.signatures).toHaveLength(1)
    expect(at(envelope.signatures, 0).keyId).toBe(good.keyId)
  })

  it('rejects signing with a private key that does not match registry.signingKeyId', () => {
    const { registry, manifestBytes } = setup()
    const wrong = makeEphemeralKeypair()
    expect(() => signManifest({ manifestBytes, registry, privateKeyPem: wrong.privateKeyPem, now: publishedAt })).toThrow(UpdateManifestError)
  })

  it('rejects verification when the envelope key is not present in the registry', () => {
    const { good, registry, manifestBytes } = setup()
    const { bytes: envelopeBytes } = signManifest({ manifestBytes, registry, privateKeyPem: good.privateKeyPem, now: publishedAt })
    // Simulate an unknown/unrecognized signer by verifying against a registry that trusts a different key entirely.
    const other = makeEphemeralKeypair()
    const foreignRegistry = makeRegistry(other)
    expect(() => verifyManifest({ manifestBytes, envelope: envelopeBytes, registry: foreignRegistry })).toThrow(UpdateManifestError)
  })

  it('rejects a tampered manifest (single byte flip breaks the digest check)', () => {
    const { good, registry, manifestBytes } = setup()
    const { bytes: envelopeBytes } = signManifest({ manifestBytes, registry, privateKeyPem: good.privateKeyPem, now: publishedAt })
    const tampered = Buffer.from(manifestBytes)
    tampered[tampered.length - 2] = tampered[tampered.length - 2] === 0x0a ? 0x20 : 0x0a
    expect(() => verifyManifest({ manifestBytes: tampered, envelope: envelopeBytes, registry })).toThrow(UpdateManifestError)
  })

  it('rejects a tampered signature', () => {
    const { good, registry, manifestBytes } = setup()
    const { envelope } = signManifest({ manifestBytes, registry, privateKeyPem: good.privateKeyPem, now: publishedAt })
    const entry = at(envelope.signatures, 0)
    const sigBuf = Buffer.from(entry.signature, 'base64')
    sigBuf[0] = (sigBuf[0] ?? 0) ^ 0xff
    const tamperedEnvelope = { ...envelope, signatures: [{ ...entry, signature: sigBuf.toString('base64') }] }
    expect(() => verifyManifest({ manifestBytes, envelope: tamperedEnvelope, registry })).toThrow(UpdateManifestError)
  })

  it('rejects semantically identical but whitespace-reformatted manifest bytes', () => {
    const { good, registry, manifestBytes } = setup()
    const { bytes: envelopeBytes } = signManifest({ manifestBytes, registry, privateKeyPem: good.privateKeyPem, now: publishedAt })
    const reparsed = JSON.parse(manifestBytes.toString('utf8'))
    const reformatted = Buffer.from(`${JSON.stringify(reparsed, null, 4)}\n`, 'utf8') // different indentation, same content
    expect(reformatted.equals(manifestBytes)).toBe(false)
    expect(() => verifyManifest({ manifestBytes: reformatted, envelope: envelopeBytes, registry })).toThrow(UpdateManifestError)
  })

  it('rejects a manually forged signature over the exact bytes using a random (non-registered) key', () => {
    const { registry, manifestBytes } = setup()
    const stranger = makeEphemeralKeypair()
    const forgedSig = edSign(null, manifestBytes, { key: stranger.privateKeyPem, format: 'pem', type: 'pkcs8' })
    const forgedEnvelope = {
      schema: 1 as const,
      manifestSha256: sha256Hex(manifestBytes),
      signatures: [
        { algorithm: 'ed25519' as const, keyId: stranger.keyId, signature: forgedSig.toString('base64') },
      ],
    }
    expect(() => verifyManifest({ manifestBytes, envelope: forgedEnvelope, registry })).toThrow(UpdateManifestError)
  })

  it('accepts when at least one of several registered-key signatures validates, even if another entry is tampered (old+new key overlap)', () => {
    const good = makeEphemeralKeypair()
    const stale = makeEphemeralKeypair()
    const registry: UpdateRegistry = {
      schema: 1,
      signingKeyId: good.keyId,
      keys: [
        { keyId: good.keyId, algorithm: 'ed25519', publicKeySpkiBase64: good.publicKeySpkiBase64 },
        { keyId: stale.keyId, algorithm: 'ed25519', publicKeySpkiBase64: stale.publicKeySpkiBase64 },
      ],
    }
    const { bytes: manifestBytes } = generateManifest({ registry, evidence: buildEvidence(), minimumMacosVersion, publishedAt })
    const { envelope: signedByGood } = signManifest({ manifestBytes, registry, privateKeyPem: good.privateKeyPem, now: publishedAt })
    const staleSig = Buffer.from(edSign(null, manifestBytes, { key: stale.privateKeyPem, format: 'pem', type: 'pkcs8' }))
    staleSig[0] = (staleSig[0] ?? 0) ^ 0xff // tamper the second (stale-key) signature so only the first entry is valid
    const entries = [
      { algorithm: 'ed25519' as const, keyId: good.keyId, signature: at(signedByGood.signatures, 0).signature },
      { algorithm: 'ed25519' as const, keyId: stale.keyId, signature: staleSig.toString('base64') },
    ].sort((a, b) => (a.keyId < b.keyId ? -1 : a.keyId > b.keyId ? 1 : 0))
    const multiEnvelope = { schema: 1 as const, manifestSha256: signedByGood.manifestSha256, signatures: entries }
    const verified = verifyManifest({ manifestBytes, envelope: multiEnvelope, registry })
    expect(verified.tag).toBe(tag)
  })

  it('accepts an envelope containing a signature from a key absent from the registry, alongside an otherwise-valid known-key signature (client has not pulled a registry-expansion build yet)', () => {
    const good = makeEphemeralKeypair()
    const registry = makeRegistry(good)
    const { bytes: manifestBytes } = generateManifest({ registry, evidence: buildEvidence(), minimumMacosVersion, publishedAt })
    const { envelope: signedByGood } = signManifest({ manifestBytes, registry, privateKeyPem: good.privateKeyPem, now: publishedAt })
    const stranger = makeEphemeralKeypair()
    const strangerSig = edSign(null, manifestBytes, { key: stranger.privateKeyPem, format: 'pem', type: 'pkcs8' })
    const entries = [
      { algorithm: 'ed25519' as const, keyId: good.keyId, signature: at(signedByGood.signatures, 0).signature },
      { algorithm: 'ed25519' as const, keyId: stranger.keyId, signature: strangerSig.toString('base64') },
    ].sort((a, b) => (a.keyId < b.keyId ? -1 : a.keyId > b.keyId ? 1 : 0))
    const multiEnvelope = { schema: 1 as const, manifestSha256: signedByGood.manifestSha256, signatures: entries }
    // The `stranger` keyId is absent from the local registry — it must be
    // ignored for cryptographic verification (not treated as an outright
    // rejection reason), while the `good` entry is genuinely pinned and
    // valid, so overall verification must succeed.
    const verified = verifyManifest({ manifestBytes, envelope: multiEnvelope, registry })
    expect(verified.tag).toBe(tag)
  })

  it('rejects an envelope whose signatures are all from keys absent from the local pinned registry', () => {
    const good = makeEphemeralKeypair()
    const registry = makeRegistry(good)
    const { bytes: manifestBytes } = generateManifest({ registry, evidence: buildEvidence(), minimumMacosVersion, publishedAt })
    const strangerOne = makeEphemeralKeypair()
    const strangerTwo = makeEphemeralKeypair()
    const sigOne = edSign(null, manifestBytes, { key: strangerOne.privateKeyPem, format: 'pem', type: 'pkcs8' })
    const sigTwo = edSign(null, manifestBytes, { key: strangerTwo.privateKeyPem, format: 'pem', type: 'pkcs8' })
    const entries = [
      { algorithm: 'ed25519' as const, keyId: strangerOne.keyId, signature: sigOne.toString('base64') },
      { algorithm: 'ed25519' as const, keyId: strangerTwo.keyId, signature: sigTwo.toString('base64') },
    ].sort((a, b) => (a.keyId < b.keyId ? -1 : a.keyId > b.keyId ? 1 : 0))
    const multiEnvelope = { schema: 1 as const, manifestSha256: sha256Hex(manifestBytes), signatures: entries }
    // No entry's keyId is present in the registry, so there is nothing left
    // to cryptographically attempt — the envelope must be rejected even
    // though each individual signature is structurally well-formed.
    expect(() => verifyManifest({ manifestBytes, envelope: multiEnvelope, registry })).toThrow(UpdateManifestError)
  })

  it('rejects an envelope with a duplicate keyId across an unknown entry, even alongside an otherwise-valid known entry (structural validation is not bypassed by registry filtering)', () => {
    const good = makeEphemeralKeypair()
    const registry = makeRegistry(good)
    const { bytes: manifestBytes } = generateManifest({ registry, evidence: buildEvidence(), minimumMacosVersion, publishedAt })
    const { envelope: signedByGood } = signManifest({ manifestBytes, registry, privateKeyPem: good.privateKeyPem, now: publishedAt })
    const stranger = makeEphemeralKeypair()
    const strangerSig = edSign(null, manifestBytes, { key: stranger.privateKeyPem, format: 'pem', type: 'pkcs8' })
    const entries = [
      { algorithm: 'ed25519' as const, keyId: good.keyId, signature: at(signedByGood.signatures, 0).signature },
      { algorithm: 'ed25519' as const, keyId: stranger.keyId, signature: strangerSig.toString('base64') },
      { algorithm: 'ed25519' as const, keyId: stranger.keyId, signature: strangerSig.toString('base64') }, // duplicate keyId, unknown to the registry
    ].sort((a, b) => (a.keyId < b.keyId ? -1 : a.keyId > b.keyId ? 1 : 0))
    const multiEnvelope = { schema: 1 as const, manifestSha256: signedByGood.manifestSha256, signatures: entries }
    expect(() => verifyManifest({ manifestBytes, envelope: multiEnvelope, registry })).toThrow(UpdateManifestError)
  })

  it('rejects an envelope with a non-canonically ordered signatures array, even when the out-of-order entry is unknown to the registry', () => {
    const good = makeEphemeralKeypair()
    const registry = makeRegistry(good)
    const { bytes: manifestBytes } = generateManifest({ registry, evidence: buildEvidence(), minimumMacosVersion, publishedAt })
    const { envelope: signedByGood } = signManifest({ manifestBytes, registry, privateKeyPem: good.privateKeyPem, now: publishedAt })
    const stranger = makeEphemeralKeypair()
    const strangerSig = edSign(null, manifestBytes, { key: stranger.privateKeyPem, format: 'pem', type: 'pkcs8' })
    const unsorted = [
      { algorithm: 'ed25519' as const, keyId: good.keyId, signature: at(signedByGood.signatures, 0).signature },
      { algorithm: 'ed25519' as const, keyId: stranger.keyId, signature: strangerSig.toString('base64') },
    ].sort((a, b) => (a.keyId < b.keyId ? 1 : a.keyId > b.keyId ? -1 : 0)) // deliberately descending, not the required ascending order
    const multiEnvelope = { schema: 1 as const, manifestSha256: signedByGood.manifestSha256, signatures: unsorted }
    expect(() => verifyManifest({ manifestBytes, envelope: multiEnvelope, registry })).toThrow(UpdateManifestError)
  })

  it('trust order: rejects schema-malformed manifest bytes with a mismatched digest as a digest failure, never reaching manifest-schema parsing', () => {
    const good = makeEphemeralKeypair()
    const registry = makeRegistry(good)
    // Deliberately schema-malformed "manifest" bytes: valid JSON, but does not
    // conform to the manifest schema in any way (missing every required
    // field). If verifyManifest parsed/schema-validated the manifest before
    // checking the raw-byte digest, this would surface a schema error instead
    // of the digest mismatch it must report first.
    const malformedBytes = Buffer.from(`${JSON.stringify({ not: 'a manifest' }, null, 2)}\n`, 'utf8')
    const envelope = {
      schema: 1 as const,
      manifestSha256: '0'.repeat(64), // deliberately does not match malformedBytes
      signatures: [{ algorithm: 'ed25519' as const, keyId: good.keyId, signature: Buffer.alloc(64).toString('base64') }],
    }
    let caught: unknown
    try {
      verifyManifest({ manifestBytes: malformedBytes, envelope, registry })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(UpdateManifestError)
    expect((caught as Error).message).toMatch(/digest/i)
    expect((caught as Error).message).not.toMatch(/schema/i)
  })

  it('trust order: rejects schema-malformed manifest bytes with a correct digest but no valid registered signature as a signature failure, never reaching manifest-schema parsing', () => {
    const good = makeEphemeralKeypair()
    const registry = makeRegistry(good)
    const malformedBytes = Buffer.from(`${JSON.stringify({ not: 'a manifest' }, null, 2)}\n`, 'utf8')
    const stranger = makeEphemeralKeypair()
    const forgedSig = edSign(null, malformedBytes, { key: stranger.privateKeyPem, format: 'pem', type: 'pkcs8' })
    const envelope = {
      schema: 1 as const,
      manifestSha256: sha256Hex(malformedBytes),
      signatures: [{ algorithm: 'ed25519' as const, keyId: stranger.keyId, signature: forgedSig.toString('base64') }],
    }
    let caught: unknown
    try {
      verifyManifest({ manifestBytes: malformedBytes, envelope, registry })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(UpdateManifestError)
    expect((caught as Error).message).not.toMatch(/schema/i)
  })

  it('trust order: parses/schema-validates the manifest only after a pinned signature succeeds — a genuinely signed but schema-malformed manifest fails on schema grounds, not digest/signature grounds', () => {
    const good = makeEphemeralKeypair()
    const registry = makeRegistry(good)
    const malformedBytes = Buffer.from(`${JSON.stringify({ not: 'a manifest' }, null, 2)}\n`, 'utf8')
    const goodSignature = edSign(null, malformedBytes, { key: good.privateKeyPem, format: 'pem', type: 'pkcs8' })
    const envelope = {
      schema: 1 as const,
      manifestSha256: sha256Hex(malformedBytes),
      signatures: [{ algorithm: 'ed25519' as const, keyId: good.keyId, signature: goodSignature.toString('base64') }],
    }
    // Digest matches and the signature genuinely validates under the pinned
    // key, so verification must proceed past both checks and fail only when
    // it then parses/schema-validates the manifest JSON.
    let caught: unknown
    try {
      verifyManifest({ manifestBytes: malformedBytes, envelope, registry })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(UpdateManifestError)
    const message = (caught as Error).message
    expect(message).not.toMatch(/digest/i)
    expect(message).not.toMatch(/signature/i)
    expect(message).toMatch(/unexpected field|missing required field/i)
  })
})

describe('freshness — expiry, ordering, lifetime', () => {
  function setup() {
    const good = makeEphemeralKeypair()
    const registry = makeRegistry(good)
    const { bytes: manifestBytes } = generateManifest({ registry, evidence: buildEvidence(), minimumMacosVersion, publishedAt })
    const { bytes: envelopeBytes } = signManifest({ manifestBytes, registry, privateKeyPem: good.privateKeyPem, now: publishedAt })
    return { good, registry, manifestBytes, envelopeBytes }
  }

  it('verify() without now performs no freshness check even long after expiry', () => {
    const { registry, manifestBytes, envelopeBytes } = setup()
    expect(() => verifyManifest({ manifestBytes, envelope: envelopeBytes, registry })).not.toThrow()
  })

  it('verify() with now before expiresAt succeeds', () => {
    const { registry, manifestBytes, envelopeBytes } = setup()
    const inWindow = new Date(new Date(publishedAt).getTime() + 24 * 60 * 60 * 1000)
    expect(() => verifyManifest({ manifestBytes, envelope: envelopeBytes, registry, now: inWindow })).not.toThrow()
  })

  it('verify() with now at/after expiresAt rejects as expired', () => {
    const { registry, manifestBytes, envelopeBytes } = setup()
    const manifest = parseManifest(manifestBytes)
    const atExpiry = new Date(manifest.expiresAt)
    expect(() => verifyManifest({ manifestBytes, envelope: envelopeBytes, registry, now: atExpiry })).toThrow(UpdateManifestError)
  })

  it('verify() rejects a publishedAt materially in the future relative to now', () => {
    const { registry, manifestBytes, envelopeBytes } = setup()
    const wayBefore = new Date(new Date(publishedAt).getTime() - 60 * 60 * 1000) // 1 hour before publishedAt
    expect(() => verifyManifest({ manifestBytes, envelope: envelopeBytes, registry, now: wayBefore })).toThrow(UpdateManifestError)
  })

  it('sign() rejects signing a manifest that is already expired at the supplied now', () => {
    const good = makeEphemeralKeypair()
    const registry = makeRegistry(good)
    const { bytes: manifestBytes } = generateManifest({ registry, evidence: buildEvidence(), minimumMacosVersion, publishedAt })
    const manifest = parseManifest(manifestBytes)
    const afterExpiry = new Date(new Date(manifest.expiresAt).getTime() + 1000)
    expect(() => signManifest({
      manifestBytes,
      registry,
      privateKeyPem: good.privateKeyPem,
      now: afterExpiry,
    })).toThrow(UpdateManifestError)
  })

  it('enforces exactly 180 days lifetime — 179 or 181 days is rejected by validateManifest', () => {
    const good = makeEphemeralKeypair()
    const registry = makeRegistry(good)
    const { manifest } = generateManifest({ registry, evidence: buildEvidence(), minimumMacosVersion, publishedAt })
    const off = (days: number) => new Date(new Date(publishedAt).getTime() + days * 24 * 60 * 60 * 1000)
      .toISOString().replace(/\.\d{3}Z$/, 'Z')
    expect(() => validateManifest({ ...manifest, expiresAt: off(179) })).toThrow(UpdateManifestError)
    expect(() => validateManifest({ ...manifest, expiresAt: off(181) })).toThrow(UpdateManifestError)
    expect(() => validateManifest({ ...manifest, expiresAt: off(180) })).not.toThrow()
  })
})

function githubRelease({
  tag_name,
  draft = false,
  prerelease = false,
  assets = [],
}: {
  tag_name: string
  draft?: boolean
  prerelease?: boolean
  assets?: ReleaseAssetLike[]
}): ReleaseLike {
  return { tag_name, draft, prerelease, assets }
}

function releaseAsset(id: number, name: string, tag: string): ReleaseAssetLike {
  return { id, name, size: 100 + id, browser_download_url: `https://github.com/${UPDATE_REPOSITORY}/releases/download/${tag}/${name}` }
}

// The listing checks every history plan makes (G1, G2 and the shape of each record), first
// written for the v1-only history and kept for both manifests (#343).
describe('planReleaseHistory — the release listing', () => {
  const plan = (releases: ReleaseLike[], newTag = 'v1.0.0') => planReleaseHistory({ releases, newTag, kind: 'universal' })
  const pair = (releaseTag: string) => [releaseAsset(1, MANIFEST_ASSET_NAME, releaseTag), releaseAsset(2, SIGNATURE_ASSET_NAME, releaseTag)]

  it('bootstraps both manifests when no published release carries either file', () => {
    expect(plan([githubRelease({ tag_name: 'v0.9.0' }), githubRelease({ tag_name: 'v0.8.0' })])).toEqual({
      v1: { manifest: 'v1', mode: 'bootstrap', priorTag: null },
      v2: { manifest: 'v2', mode: 'bootstrap', priorTag: null },
    })
  })

  it('ignores drafts, prereleases and proven-shaped releases with other tags', () => {
    expect(() => plan([
      githubRelease({ tag_name: 'v5.0.0', draft: true }),
      githubRelease({ tag_name: 'v5.0.0', prerelease: true }),
      { tag_name: 'nightly-build', draft: false, prerelease: false, assets: [] },
    ])).not.toThrow()
  })

  it('refuses a leading-zero numeric identifier in the new tag', () => {
    expect(() => plan([], 'v01.0.0')).toThrow(UpdateManifestError)
  })

  it('compares arbitrarily large numeric identifiers exactly, without Number precision loss', () => {
    // 2**53 and 2**53 + 1 are not distinguishable as IEEE-754 doubles.
    const huge = '9007199254740992'
    const hugePlusOne = '9007199254740993'
    expect(() => plan([githubRelease({ tag_name: `v${huge}.0.0` })], `v${hugePlusOne}.0.0`)).not.toThrow()
    expect(() => plan([githubRelease({ tag_name: `v${huge}.0.0` })], `v${huge}.0.0`)).toThrow(UpdateManifestError)
    expect(() => plan([githubRelease({ tag_name: `v${hugePlusOne}.0.0` })], `v${huge}.0.0`)).toThrow(UpdateManifestError)
  })

  it('fails closed on a malformed release record instead of ignoring it as non-stable', () => {
    for (const record of [
      null,
      'not-an-object',
      { tag_name: 'v0.9.0', draft: false, prerelease: false },
      { tag_name: 'v0.9.0', draft: 'false', prerelease: false, assets: [] },
      { tag_name: '', draft: false, prerelease: false, assets: [] },
    ]) {
      expect(() => plan([record as unknown as ReleaseLike]), JSON.stringify(record)).toThrow(UpdateManifestError)
    }
  })

  it('refuses duplicate stable tags, duplicate asset names and non-positive or fractional ids and sizes', () => {
    expect(() => plan([githubRelease({ tag_name: 'v0.9.0' }), githubRelease({ tag_name: 'v0.9.0' })])).toThrow(UpdateManifestError)
    const asset = releaseAsset(1, MANIFEST_ASSET_NAME, 'v0.9.0')
    for (const assets of [
      [asset, { ...asset, id: 2 }],
      [{ ...asset, id: 0 }],
      [{ ...asset, id: 1.5 }],
      [{ ...asset, size: -1 }],
    ]) {
      expect(() => plan([githubRelease({ tag_name: 'v0.9.0', assets })]), JSON.stringify(assets)).toThrow(UpdateManifestError)
    }
  })

  it('refuses a download URL that is not the canonical release-download URL', () => {
    const asset = releaseAsset(1, MANIFEST_ASSET_NAME, 'v0.9.0')
    for (const url of [
      asset.browser_download_url.replace('https://', 'http://'),
      asset.browser_download_url.replace('github.com', 'evil.example.com'),
      `${asset.browser_download_url}?x=1`,
      `${asset.browser_download_url}#frag`,
      asset.browser_download_url.replace('v0.9.0', 'v0.8.0'),
      'https://user:pass@github.com/shariqh/agent-inbox/releases/download/v0.9.0/update-manifest.json',
    ]) {
      expect(() => plan([githubRelease({ tag_name: 'v0.9.0', assets: [{ ...asset, browser_download_url: url }] })]), url)
        .toThrow(UpdateManifestError)
    }
  })

  it('accepts a digest only as sha256:<64 lowercase hex>, and treats a missing, null or empty one as unavailable', () => {
    const [manifest, signature] = pair('v0.9.0') as [ReleaseAssetLike, ReleaseAssetLike]
    const valid = `sha256:${'a1b2c3d4'.repeat(8)}`
    for (const digest of [
      'sha256:abc123',
      `sha256:${'A1B2C3D4'.repeat(8)}`,
      `md5:${'a1b2c3d4'.repeat(8)}`,
      'a1b2c3d4'.repeat(8),
      `sha256:${'g1b2c3d4'.repeat(8)}`,
    ]) {
      expect(() => plan([githubRelease({ tag_name: 'v0.9.0', assets: [{ ...manifest, digest }, signature] })]), digest)
        .toThrow(UpdateManifestError)
    }
    const listed = (digest: string | null | undefined) => {
      const result = plan([githubRelease({
        tag_name: 'v0.9.0',
        assets: [{ ...manifest, ...(digest === undefined ? {} : { digest }) }, signature],
      })])
      if (result.v1.mode !== 'continuity') throw new Error('expected continuity')
      return result.v1
    }
    expect(listed(valid).manifestAsset.digest).toBe(valid)
    expect(listed(valid).signatureAsset).not.toHaveProperty('digest')
    for (const unavailable of [undefined, null, '']) {
      expect(listed(unavailable).manifestAsset).not.toHaveProperty('digest')
    }
  })
})

describe('CLI (scripts/update-manifest.mjs) — env-only private key, deterministic output', () => {
  const cliPath = join(root, 'scripts', 'update-manifest.mjs')
  const work: string[] = []

  function runCli(args: string[], { env = {} }: { env?: Record<string, string> } = {}) {
    return spawnSync(process.execPath, [cliPath, ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    })
  }

  const fixturesDir = join(root, 'test', 'fixtures')

  function tempPath(name: string): string {
    mkdirSync(fixturesDir, { recursive: true })
    const path = join(fixturesDir, `.tmp-update-manifest-${process.pid}-${name}`)
    work.push(path)
    return path
  }

  afterEach(() => {
    for (const path of work.splice(0)) {
      rmSync(path, { force: true })
    }
  })

  it('generate + sign + verify round-trips through the CLI with the private key read only from env', () => {
    const good = makeEphemeralKeypair()
    const registry = makeRegistry(good)
    const registryPath = tempPath('registry.json')
    const evidencePath = tempPath('evidence.json')
    const manifestPath = tempPath('manifest.json')
    const signaturePath = tempPath('manifest.sig.json')

    // Use a currently-fresh publishedAt (unlike the fixed 2026-01-01 fixture used elsewhere)
    // so the CLI's default sign-time freshness check does not reject it as expired.
    const freshPublishedAt = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

    writeFileSync(registryPath, JSON.stringify(registry))
    writeFileSync(evidencePath, JSON.stringify(buildEvidence()))

    const genResult = runCli([
      'generate',
      '--registry', registryPath,
      '--evidence', evidencePath,
      '--minimum-macos-version', minimumMacosVersion,
      '--published-at', freshPublishedAt,
      '--output', manifestPath,
    ])
    expect(genResult.status).toBe(0)

    const privateKeyPemBase64 = Buffer.from(good.privateKeyPem, 'utf8').toString('base64')
    const signResult = runCli([
      'sign',
      '--manifest', manifestPath,
      '--registry', registryPath,
      '--output', signaturePath,
    ], { env: { AGENT_INBOX_UPDATE_PRIVATE_KEY_BASE64: privateKeyPemBase64 } })
    expect(signResult.status).toBe(0)
    expect(signResult.stdout).not.toContain(good.privateKeyPem)
    expect(signResult.stdout).not.toContain(privateKeyPemBase64)

    const verifyResult = runCli([
      'verify',
      '--manifest', manifestPath,
      '--signature', signaturePath,
      '--registry', registryPath,
    ])
    expect(verifyResult.status).toBe(0)
    expect(JSON.parse(verifyResult.stdout).valid).toBe(true)
  })

  it('rejects an unknown CLI flag (strict parseArgs)', () => {
    const result = runCli(['generate', '--not-a-real-flag', 'x'])
    expect(result.status).not.toBe(0)
  })

  it('rejects `generate` when --published-at is omitted (no wall-clock fallback)', () => {
    const good = makeEphemeralKeypair()
    const registry = makeRegistry(good)
    const registryPath = tempPath('registry-no-published-at.json')
    const evidencePath = tempPath('evidence-no-published-at.json')
    const manifestPath = tempPath('manifest-no-published-at.json')
    writeFileSync(registryPath, JSON.stringify(registry))
    writeFileSync(evidencePath, JSON.stringify(buildEvidence()))

    const result = runCli([
      'generate',
      '--registry', registryPath,
      '--evidence', evidencePath,
      '--minimum-macos-version', minimumMacosVersion,
      '--output', manifestPath,
    ])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('--published-at')
  })

  it('rejects `sign` when the private key env value is not canonical base64, without ever printing it', () => {
    const good = makeEphemeralKeypair()
    const registry = makeRegistry(good)
    const registryPath = tempPath('registry-bad-base64.json')
    const evidencePath = tempPath('evidence-bad-base64.json')
    const manifestPath = tempPath('manifest-bad-base64.json')
    writeFileSync(registryPath, JSON.stringify(registry))
    writeFileSync(evidencePath, JSON.stringify(buildEvidence()))

    const freshPublishedAt = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const genResult = runCli([
      'generate',
      '--registry', registryPath,
      '--evidence', evidencePath,
      '--minimum-macos-version', minimumMacosVersion,
      '--published-at', freshPublishedAt,
      '--output', manifestPath,
    ])
    expect(genResult.status).toBe(0)

    const canonical = Buffer.from(good.privateKeyPem, 'utf8').toString('base64')
    const noncanonicalValues = [
      '', // empty
      `${canonical} `, // trailing whitespace breaks the round-trip
      canonical.slice(0, -1), // truncated — breaks base64 grouping
      `-${canonical.slice(1)}`, // invalid leading character
      `not-valid-base64!!!${canonical}`,
    ]
    for (const badValue of noncanonicalValues) {
      const signaturePath = tempPath(`sig-bad-${noncanonicalValues.indexOf(badValue)}.json`)
      const signResult = runCli([
        'sign',
        '--manifest', manifestPath,
        '--registry', registryPath,
        '--output', signaturePath,
      ], { env: { AGENT_INBOX_UPDATE_PRIVATE_KEY_BASE64: badValue } })
      expect(signResult.status).not.toBe(0)
      expect(signResult.stdout).not.toContain(good.privateKeyPem)
      expect(signResult.stdout).not.toContain(canonical)
      expect(signResult.stderr).not.toContain(good.privateKeyPem)
      expect(signResult.stderr).not.toContain(canonical)
    }
  })
})

// ---------------------------------------------------------------------------
// Update manifest v2 (#343; design §5 to §7): the schema-2 reader and the publisher's
// pure functions. Nothing in the app or the release workflow calls them yet: #343's
// second PR wires the client and the signer to them together (design §7.5).
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000

type Signer = ReturnType<typeof makeEphemeralKeypair>
type Kind = 'universal' | 'arm64'
type RawTarget = Record<string, unknown>
type RawManifest = Record<string, unknown> & {
  publishedAt: string
  source: Record<string, unknown>
  targets: RawTarget[]
}

function isoAfter(start: string, ms: number): string {
  return new Date(Date.parse(start) + ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function rawBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** An envelope over exact bytes, whatever their schema, signed by each signer in key order. */
function signBytes(manifestBytes: Buffer, ...signers: Signer[]): Buffer {
  return serializeEnvelope({
    schema: 1,
    manifestSha256: sha256Hex(manifestBytes),
    signatures: signers
      .map((signer) => ({
        algorithm: 'ed25519' as const,
        keyId: signer.keyId,
        signature: edSign(null, manifestBytes, signer.privateKeyPem).toString('base64'),
      }))
      .sort((left, right) => (left.keyId < right.keyId ? -1 : 1)),
  })
}

/** buildEvidence for an arm64 release: the arm64 DMG in place of the universal one. */
function buildArm64Evidence(overrides: Partial<ReleaseEvidence> = {}): ReleaseEvidence {
  const evidence = buildEvidence(overrides)
  return {
    ...evidence,
    assets: evidence.assets.map((asset) => (asset.platform === 'darwin'
      ? { ...asset, architecture: 'arm64' as const, name: `Agent-Inbox-${evidence.tag}-arm64.dmg` }
      : asset)),
  }
}

function evidenceFor(kind: Kind, overrides: Partial<ReleaseEvidence> = {}): ReleaseEvidence {
  return kind === 'universal' ? buildEvidence(overrides) : buildArm64Evidence(overrides)
}

function v2Release(kind: Kind = 'universal', signer: Signer = makeEphemeralKeypair()) {
  const registry = makeRegistry(signer)
  const evidence = evidenceFor(kind)
  const generated = generateManifestV2({ registry, evidence, minimumMacosVersion, publishedAt, kind })
  return { signer, registry, evidence, ...generated, raw: JSON.parse(generated.bytes.toString('utf8')) as RawManifest }
}

function without(target: RawTarget | undefined, key: string): RawTarget {
  const copy = { ...target }
  delete copy[key]
  return copy
}

describe('update manifest v2 — the schema-2 reader (design §5.4)', () => {
  it('knows six target types in part-by-part order, the five of schema 1 plus the arm64 DMG', () => {
    expect(UPDATE_MANIFEST_SCHEMA_V2).toBe(2)
    expect(UPDATE_ENVELOPE_SCHEMA).toBe(1)
    expect(MANIFEST_V2_ASSET_NAME).toBe('update-manifest-v2.json')
    expect(SIGNATURE_V2_ASSET_NAME).toBe('update-manifest-v2.json.sig')
    expect(TARGET_SPECS_V2.map(targetTuple)).toEqual(['darwin/arm64/dmg', ...EXPECTED_TARGET_ORDER])
    expect(TARGET_SPECS_V2.slice(1)).toEqual(TARGET_SPECS)
    // The catalog's DMG names are the ones the measured macOS kind gives (#341).
    for (const kind of ['universal', 'arm64'] as const) {
      const macos = macosRelease({ kind, tag })
      const spec = TARGET_SPECS_V2.find((candidate) => candidate.platform === 'darwin' && candidate.architecture === macos.architecture)
      expect(spec?.filename(tag, version)).toBe(macos.dmgName)
      expect(spec?.installStrategy).toBe('macos-dmg')
    }
  })

  it('accepts any lifetime above 0 and up to 180 days, and refuses 0 or anything longer', () => {
    const { raw } = v2Release()
    const cases: Array<[string, number, boolean]> = [
      ['180 days', 180 * DAY_MS, true],
      ['30 days', 30 * DAY_MS, true],
      ['1 second', 1000, true],
      ['0', 0, false],
      ['-1 day', -DAY_MS, false],
      ['181 days', 181 * DAY_MS, false],
      ['180 days and 1 second', 180 * DAY_MS + 1000, false],
    ]
    for (const [label, ms, accepted] of cases) {
      const value = { ...raw, expiresAt: isoAfter(raw.publishedAt, ms) }
      if (accepted) expect(() => validateManifestV2(value), label).not.toThrow()
      else expect(() => validateManifestV2(value), label).toThrow(UpdateManifestError)
    }
  })

  it('ignores keys it does not know, at the top level, in source and in a known target', () => {
    const { raw, manifest } = v2Release()
    const value = {
      ...raw,
      channel: 'stable',
      source: { ...raw.source, ref: 'refs/tags/v1.2.3' },
      targets: raw.targets.map((target, index) => (index === 0
        ? { ...target, notarizedAt: '2026-01-01T00:00:00Z', delta: { from: '1.2.2' } }
        : target)),
    }
    expect(validateManifestV2(value)).toEqual(manifest)
    expect(validateManifestV2(value)).not.toHaveProperty('channel')
    expect(validateManifestV2(value).source).toEqual({ commit: sourceCommit, tree: sourceTree })
  })

  it('skips a target type it does not know, after checking its name, uniqueness and order', () => {
    const { raw, manifest } = v2Release()
    // Nothing but the three type names of an unknown type is ever read.
    const windows = { platform: 'win32', architecture: 'x64', packageType: 'msix', filename: 7, url: null }
    expect(validateManifestV2({ ...raw, targets: [...raw.targets, windows] }).targets).toEqual(manifest.targets)
    expect(() => validateManifestV2({ ...raw, targets: [...raw.targets, { ...windows, packageType: 'a'.repeat(32) }] })).not.toThrow()
    for (const name of [{ platform: 'Win32' }, { architecture: '-x64' }, { packageType: 'a'.repeat(33) }, { platform: 'win 32' }, { packageType: '' }, { architecture: 64 }]) {
      expect(() => validateManifestV2({ ...raw, targets: [...raw.targets, { ...windows, ...name }] }), JSON.stringify(name))
        .toThrow(UpdateManifestError)
    }
    expect(() => validateManifestV2({ ...raw, targets: [...raw.targets, windows, { ...windows }] })).toThrow(/duplicate target for win32\/x64\/msix/)
    expect(() => validateManifestV2({ ...raw, targets: [windows, ...raw.targets] })).toThrow(/must be sorted/)
    expect(() => validateManifestV2({ ...raw, targets: [...raw.targets, 'win32/x64/msix'] })).toThrow(/must be a plain object/)
  })

  it('orders target types part by part, so a name that extends another sorts after it', () => {
    const { raw } = v2Release()
    const [dmg, ...linux] = raw.targets
    // Part by part, "linux" sorts before "linux-musl". The joined strings would sort the other
    // way, because "-" comes before "/": this reader can never change, so the rule is pinned.
    const musl = { platform: 'linux-musl', architecture: 'x64', packageType: 'appimage' }
    expect(() => validateManifestV2({ ...raw, targets: [dmg, ...linux, musl] })).not.toThrow()
    expect(() => validateManifestV2({ ...raw, targets: [dmg, musl, ...linux] })).toThrow(/must be sorted by platform, then architecture, then packageType/)
    const dmg2 = { platform: 'darwin', architecture: 'universal', packageType: 'dmg-2' }
    expect(() => validateManifestV2({ ...raw, targets: [dmg, dmg2, ...linux] })).not.toThrow()
    expect(() => validateManifestV2({ ...raw, targets: [dmg2, dmg, ...linux] })).toThrow(/must be sorted/)
  })

  it('leaves a host without a target when its change ships only under a new type name', () => {
    const { raw } = v2Release('arm64')
    const [arm64Dmg, ...linux] = raw.targets
    const renamed = { ...arm64Dmg, packageType: 'dmg-2', filename: `Agent-Inbox-${tag}-arm64-2.dmg` }
    const validated = validateManifestV2({ ...raw, targets: [renamed, ...linux] })
    // No Mac finds its target any more; every Linux host still finds its own package.
    expect(validated.targets.map(targetTuple)).toEqual(EXPECTED_TARGET_ORDER.slice(1))
  })

  it('rejects the whole manifest when a known type misses or breaks a required field, as schema 1 does', () => {
    const { raw } = v2Release()
    const [dmg, ...linux] = raw.targets
    const cases: Array<[string, RawTarget[]]> = [
      ['no sha256', [without(dmg, 'sha256'), ...linux]],
      ['no minimumSystemVersion on a DMG', [without(dmg, 'minimumSystemVersion'), ...linux]],
      ['an uppercase sha256', [{ ...dmg, sha256: 'A'.repeat(64) }, ...linux]],
      ['a zero byteLength', [{ ...dmg, byteLength: 0 }, ...linux]],
      ['the arm64 filename on the universal type', [{ ...dmg, filename: `Agent-Inbox-${tag}-arm64.dmg` }, ...linux]],
      ['a URL under another tag', [{ ...dmg, url: String(dmg?.url).replace(`/${tag}/`, '/v1.2.2/') }, ...linux]],
      ['another install strategy', [{ ...dmg, installStrategy: 'deb-notify' }, ...linux]],
      ['a Linux filename of another version', [dmg!, { ...linux[0], filename: 'Agent-Inbox-v1.2.2-linux-arm64.AppImage' }, ...linux.slice(1)]],
      ['a known type listed twice', [dmg!, dmg!, ...linux]],
    ]
    for (const [label, targets] of cases) {
      expect(() => validateManifestV2({ ...raw, targets }), label).toThrow(UpdateManifestError)
    }
  })

  it('holds 1 to 32 targets', () => {
    const { raw } = v2Release()
    const unknown = (index: number) => ({ platform: 'zz', architecture: `a${String(index).padStart(2, '0')}`, packageType: 'pkg' })
    const extra = Array.from({ length: 27 }, (_, index) => unknown(index))
    expect(validateManifestV2({ ...raw, targets: [...raw.targets, ...extra] }).targets).toHaveLength(5)
    expect(() => validateManifestV2({ ...raw, targets: [...raw.targets, ...extra, unknown(27)] })).toThrow(/1 to 32 entries/)
    expect(() => validateManifestV2({ ...raw, targets: [] })).toThrow(/1 to 32 entries/)
    expect(validateManifestV2({ ...raw, targets: [unknown(0)] }).targets).toEqual([])
  })

  it('keeps every other top-level rule of schema 1', () => {
    const { raw } = v2Release()
    const cases: Array<[string, unknown]> = [
      ['schema 1', { ...raw, schema: 1 }],
      ['another kind', { ...raw, kind: 'agent-inbox-update-manifest-2' }],
      ['another repository', { ...raw, repository: 'someone/agent-inbox' }],
      ['a leading zero', { ...raw, version: '01.2.3', tag: 'v01.2.3' }],
      ['a tag of another version', { ...raw, tag: 'v1.2.4' }],
      ['no source tree', { ...raw, source: { commit: sourceCommit } }],
      ['no releaseUrl', (() => { const copy: Record<string, unknown> = { ...raw }; delete copy.releaseUrl; return copy })()],
      ['a releaseUrl of another tag', { ...raw, releaseUrl: 'https://github.com/shariqh/agent-inbox/releases/tag/v1.2.4' }],
      ['no trusted keys', { ...raw, trustedKeyIds: [] }],
      ['a signing key it does not trust', { ...raw, signingKeyId: `ed25519-${'0'.repeat(16)}` }],
      ['a publishedAt with milliseconds', { ...raw, publishedAt: '2026-01-01T00:00:00.000Z' }],
      ['an array', [raw]],
    ]
    for (const [label, value] of cases) {
      expect(() => validateManifestV2(value), label).toThrow(UpdateManifestError)
    }
  })

  it('parses only its own schema, so neither file can stand in for the other', () => {
    const { registry, bytes } = v2Release()
    const v1 = generateManifest({ registry, evidence: buildEvidence(), minimumMacosVersion, publishedAt })
    expect(() => parseManifestV2(v1.bytes)).toThrow('manifest.schema must be 2')
    expect(() => parseManifest(bytes)).toThrow('manifest.schema must be 1')
    expect(parseManifestV2(bytes).schema).toBe(2)
  })

  it('verifies in the trust order of schema 1: digest, signature, schema, then freshness', () => {
    const { signer, registry, bytes, manifest } = v2Release()
    const envelope = signBytes(bytes, signer)
    expect(verifyManifestV2({ manifestBytes: bytes, envelope, registry, now: publishedAt })).toEqual(manifest)
    expect(parseEnvelope(envelope).schema).toBe(1)
    const schema2Envelope = Buffer.from(envelope.toString('utf8').replace('"schema": 1', '"schema": 2'))
    expect(() => verifyManifestV2({ manifestBytes: bytes, envelope: schema2Envelope, registry })).toThrow('envelope.schema must be 1')

    const tampered = Buffer.from(bytes.toString('utf8').replace('"schema": 2', '"schema": 9'))
    expect(() => verifyManifestV2({ manifestBytes: tampered, envelope, registry })).toThrow(/do not match the digest/)
    expect(() => verifyManifestV2({ manifestBytes: bytes, envelope: signBytes(bytes, makeEphemeralKeypair()), registry }))
      .toThrow(/signature verification failed/)
    // Schema is read only once the bytes are proven authentic.
    const v1Bytes = generateManifest({ registry, evidence: buildEvidence(), minimumMacosVersion, publishedAt }).bytes
    expect(() => verifyManifestV2({ manifestBytes: v1Bytes, envelope: signBytes(v1Bytes, signer), registry }))
      .toThrow('manifest.schema must be 2')

    expect(() => verifyManifestV2({ manifestBytes: bytes, envelope, registry, now: manifest.expiresAt })).toThrow('manifest has expired')
    expect(() => verifyManifestV2({ manifestBytes: bytes, envelope, registry, now: isoAfter(publishedAt, -6 * 60 * 1000) }))
      .toThrow(/materially in the future/)
    expect(() => verifyManifestV2({ manifestBytes: bytes, envelope, registry, now: isoAfter(publishedAt, -4 * 60 * 1000) }))
      .not.toThrow()
  })

  it('verifies a signed manifest that carries keys and types this reader does not know', () => {
    const { signer, registry, raw, manifest } = v2Release()
    const later = rawBytes({ ...raw, channel: 'stable', targets: [...raw.targets, { platform: 'win32', architecture: 'x64', packageType: 'msix' }] })
    expect(verifyManifestV2({ manifestBytes: later, envelope: signBytes(later, signer), registry, now: publishedAt })).toEqual(manifest)
  })
})

describe('generateManifestV2 — the strict set for each macOS kind', () => {
  it('writes a universal release: the universal DMG and the four Linux packages', () => {
    const { manifest, bytes, registry } = v2Release('universal')
    expect(manifest.schema).toBe(2)
    expect(manifest.targets.map(targetTuple)).toEqual(EXPECTED_TARGET_ORDER)
    expect(manifest.expiresAt).toBe(isoAfter(publishedAt, 180 * DAY_MS))
    expect(manifest.signingKeyId).toBe(registry.signingKeyId)
    expect(bytes.toString('utf8')).toContain('\n  "schema": 2,')
    expect(parseManifestV2(bytes)).toEqual(manifest)
  })

  it('writes an arm64 release: the arm64 DMG and the four Linux packages', () => {
    const { manifest } = v2Release('arm64')
    expect(manifest.targets.map(targetTuple)).toEqual(['darwin/arm64/dmg', ...EXPECTED_TARGET_ORDER.slice(1)])
    expect(at(manifest.targets, 0)).toEqual({
      platform: 'darwin',
      architecture: 'arm64',
      packageType: 'dmg',
      filename: `Agent-Inbox-${tag}-arm64.dmg`,
      url: `https://github.com/shariqh/agent-inbox/releases/download/${tag}/Agent-Inbox-${tag}-arm64.dmg`,
      byteLength: 111,
      sha256: 'a'.repeat(64),
      installStrategy: 'macos-dmg',
      minimumSystemVersion: '13.5',
    })
  })

  it('serializes like schema 1, so a universal release differs from today\'s bytes only in schema', () => {
    const signer = makeEphemeralKeypair()
    const registry = makeRegistry(signer, makeEphemeralKeypair())
    const v2 = generateManifestV2({ registry, evidence: buildEvidence(), minimumMacosVersion, publishedAt, kind: 'universal' })
    const v1 = generateManifest({ registry, evidence: buildEvidence(), minimumMacosVersion, publishedAt })
    expect(v2.bytes.toString('utf8').replace('\n  "schema": 2,\n', '\n  "schema": 1,\n')).toBe(v1.bytes.toString('utf8'))
  })

  it('refuses evidence that disagrees with the kind, a mislabelled DMG, a missing or extra package and an unknown kind', () => {
    const registry = makeRegistry(makeEphemeralKeypair())
    const universal = buildEvidence()
    const arm64 = buildArm64Evidence()
    const generate = (evidence: ReleaseEvidence, kind: string) => () => generateManifestV2({
      registry,
      evidence,
      minimumMacosVersion,
      publishedAt,
      kind: kind as Kind,
    })
    expect(generate(universal, 'universal')).not.toThrow()
    expect(generate(arm64, 'arm64')).not.toThrow()
    expect(generate(arm64, 'universal')).toThrow(UpdateManifestError)
    expect(generate(universal, 'arm64')).toThrow(UpdateManifestError)
    const relabel = (evidence: ReleaseEvidence, patch: Partial<ReleaseAssetEvidence>) => ({
      ...evidence,
      assets: evidence.assets.map((asset) => (asset.platform === 'darwin' ? { ...asset, ...patch } : asset)),
    })
    // A universal filename claimed as arm64, and the reverse.
    expect(generate(relabel(universal, { architecture: 'arm64' }), 'arm64')).toThrow(UpdateManifestError)
    expect(generate(relabel(arm64, { architecture: 'universal' }), 'universal')).toThrow(UpdateManifestError)
    expect(generate({ ...universal, assets: universal.assets.slice(1) }, 'universal')).toThrow(UpdateManifestError)
    expect(generate({ ...universal, assets: [...universal.assets, at(arm64.assets, 0)] }, 'universal')).toThrow(UpdateManifestError)
    expect(generate(universal, 'intel')).toThrow(UpdateManifestError)
  })
})

describe('projectV1 — the v1 manifest of a universal release', () => {
  it('is byte-identical to today\'s generator for the same evidence', () => {
    for (const registry of [makeRegistry(makeEphemeralKeypair()), makeRegistry(makeEphemeralKeypair(), makeEphemeralKeypair())]) {
      for (const evidence of [buildEvidence(), buildEvidence({ tag: 'v10.20.30', packageVersion: '10.20.30' })]) {
        const v2 = generateManifestV2({ registry, evidence, minimumMacosVersion, publishedAt, kind: 'universal' })
        const today = generateManifest({ registry, evidence, minimumMacosVersion, publishedAt })
        const projected = projectV1(v2.bytes)
        expect(projected.bytes.equals(today.bytes)).toBe(true)
        expect(projected.manifest).toEqual(today.manifest)
      }
    }
  })

  it('refuses an arm64 release, which has no universal DMG to describe', () => {
    const { bytes } = v2Release('arm64')
    expect(() => projectV1(bytes)).toThrow(/darwin\/universal\/dmg/)
  })

  it('keeps only the five types of schema 1, and only a 180-day lifetime', () => {
    const { raw, registry } = v2Release('universal')
    const [universalDmg, ...linux] = raw.targets
    const arm64Dmg = at(v2Release('arm64').raw.targets, 0)
    const both = rawBytes({
      ...raw,
      targets: [arm64Dmg, universalDmg, ...linux, { platform: 'win32', architecture: 'x64', packageType: 'msix' }],
    })
    const today = generateManifest({ registry, evidence: buildEvidence(), minimumMacosVersion, publishedAt })
    expect(projectV1(both).bytes.equals(today.bytes)).toBe(true)
    expect(() => projectV1(rawBytes({ ...raw, expiresAt: isoAfter(publishedAt, 90 * DAY_MS) }))).toThrow(/exactly 180 days/)
  })

  it('reads only a v2 manifest', () => {
    const registry = makeRegistry(makeEphemeralKeypair())
    const today = generateManifest({ registry, evidence: buildEvidence(), minimumMacosVersion, publishedAt })
    expect(() => projectV1(today.bytes)).toThrow('manifest.schema must be 2')
  })
})

// A release as GitHub lists it, built only by the publisher functions above.
interface PublishedRelease {
  tag: string
  kind: Kind | 'v1-only'
  v1: { bytes: Buffer; signature: Buffer }
  v2?: { bytes: Buffer; signature: Buffer }
  listing: ReleaseLike
}

let nextAssetId = 1000

function listedAsset(releaseTag: string, name: string, size: number, digestOf?: Buffer | string): ReleaseAssetLike {
  nextAssetId += 1
  const digest = digestOf === undefined
    ? undefined
    : `sha256:${typeof digestOf === 'string' ? digestOf : sha256Hex(digestOf)}`
  return {
    id: nextAssetId,
    name,
    size,
    browser_download_url: `https://github.com/${UPDATE_REPOSITORY}/releases/download/${releaseTag}/${name}`,
    ...(digest ? { digest } : {}),
  }
}

function listing(releaseTag: string, evidence: ReleaseEvidence, pairs: Array<{ names: [string, string]; bytes: Buffer; signature: Buffer }>): ReleaseLike {
  return githubRelease({
    tag_name: releaseTag,
    assets: [
      ...evidence.assets.map((asset) => listedAsset(releaseTag, asset.name, asset.size, asset.sha256)),
      listedAsset(releaseTag, 'SHA256SUMS.txt', 400),
      ...pairs.flatMap(({ names, bytes, signature }) => [
        listedAsset(releaseTag, names[0], bytes.length, bytes),
        listedAsset(releaseTag, names[1], signature.length, signature),
      ]),
    ],
  })
}

const V1_NAMES: [string, string] = ['update-manifest.json', 'update-manifest.json.sig']
const V2_NAMES: [string, string] = ['update-manifest-v2.json', 'update-manifest-v2.json.sig']

/** A 1.3 to 1.6 release: today's generator, the v1 pair only. */
function publishV1Only(releaseVersion: string, signer: Signer, registry: UpdateRegistry, taggedAt: string): PublishedRelease {
  const releaseTag = `v${releaseVersion}`
  const evidence = buildEvidence({ tag: releaseTag, packageVersion: releaseVersion })
  const { bytes } = generateManifest({ registry, evidence, minimumMacosVersion, publishedAt: taggedAt })
  const signature = signBytes(bytes, signer)
  return { tag: releaseTag, kind: 'v1-only', v1: { bytes, signature }, listing: listing(releaseTag, evidence, [{ names: V1_NAMES, bytes, signature }]) }
}

/** A universal release from #343 on: v2, and v1 as its projection. */
function publishUniversal(releaseVersion: string, signer: Signer, registry: UpdateRegistry, taggedAt: string): PublishedRelease {
  const releaseTag = `v${releaseVersion}`
  const evidence = buildEvidence({ tag: releaseTag, packageVersion: releaseVersion })
  const v2 = generateManifestV2({ registry, evidence, minimumMacosVersion, publishedAt: taggedAt, kind: 'universal' })
  const v1 = projectV1(v2.bytes)
  const pair = (bytes: Buffer) => ({ bytes, signature: signBytes(bytes, signer) })
  const v1Pair = pair(v1.bytes)
  const v2Pair = pair(v2.bytes)
  return {
    tag: releaseTag,
    kind: 'universal',
    v1: v1Pair,
    v2: v2Pair,
    listing: listing(releaseTag, evidence, [{ names: V1_NAMES, ...v1Pair }, { names: V2_NAMES, ...v2Pair }]),
  }
}

/** An arm64 release: v2, and v1 as a re-stamp of the previous release's. */
function publishArm64(
  releaseVersion: string,
  signer: Signer,
  registry: UpdateRegistry,
  taggedAt: string,
  previous: PublishedRelease,
  releases: ReleaseLike[],
): PublishedRelease {
  const releaseTag = `v${releaseVersion}`
  const evidence = buildArm64Evidence({ tag: releaseTag, packageVersion: releaseVersion })
  const v2 = generateManifestV2({ registry, evidence, minimumMacosVersion, publishedAt: taggedAt, kind: 'arm64' })
  const v1 = restampV1({
    earlierManifestBytes: previous.v1.bytes,
    earlierSignatureBytes: previous.v1.signature,
    registry,
    newTag: releaseTag,
    publishedAt: taggedAt,
    releases,
  })
  const pair = (bytes: Buffer) => ({ bytes, signature: signBytes(bytes, signer) })
  const v1Pair = pair(v1.bytes)
  const v2Pair = pair(v2.bytes)
  return {
    tag: releaseTag,
    kind: 'arm64',
    v1: v1Pair,
    v2: v2Pair,
    listing: listing(releaseTag, evidence, [{ names: V1_NAMES, ...v1Pair }, { names: V2_NAMES, ...v2Pair }]),
  }
}

function history(signer = makeEphemeralKeypair(), registry = makeRegistry(signer)) {
  const v160 = publishV1Only('1.6.0', signer, registry, '2026-10-20T12:00:00Z')
  const v170 = publishUniversal('1.7.0', signer, registry, '2026-11-16T12:00:00Z')
  const v190 = publishUniversal('1.9.0', signer, registry, '2027-01-04T12:00:00Z')
  const v200 = publishArm64('2.0.0', signer, registry, '2027-01-18T12:00:00Z', v190, [v160.listing, v170.listing, v190.listing])
  return { signer, registry, v160, v170, v190, v200 }
}

function manifestDiff(left: Buffer, right: Buffer): string[] {
  const a = JSON.parse(left.toString('utf8')) as Record<string, unknown>
  const b = JSON.parse(right.toString('utf8')) as Record<string, unknown>
  expect(Object.keys(b)).toEqual(Object.keys(a))
  return Object.keys(a).filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key])).sort()
}

describe('restampV1 — the frozen v1 manifest of an arm64 release (design §5.3)', () => {
  it('copies the earlier v1 manifest and changes only publishedAt, expiresAt, signingKeyId and trustedKeyIds', () => {
    const { signer, registry, v160, v170, v190 } = history()
    // The release that re-stamps rotated to a new signing key while still trusting the old one.
    const next = makeEphemeralKeypair()
    const rotated: UpdateRegistry = { ...makeRegistry(next, signer), signingKeyId: next.keyId }
    const restamped = restampV1({
      earlierManifestBytes: v190.v1.bytes,
      earlierSignatureBytes: v190.v1.signature,
      registry: rotated,
      newTag: 'v2.0.0',
      publishedAt: '2027-01-18T12:00:00Z',
      releases: [v160.listing, v170.listing, v190.listing],
    })
    expect(manifestDiff(v190.v1.bytes, restamped.bytes)).toEqual(['expiresAt', 'publishedAt', 'signingKeyId', 'trustedKeyIds'])
    expect(restamped.manifest).toMatchObject({
      schema: 1,
      version: '1.9.0',
      tag: 'v1.9.0',
      publishedAt: '2027-01-18T12:00:00Z',
      expiresAt: '2027-07-17T12:00:00Z',
      releaseUrl: 'https://github.com/shariqh/agent-inbox/releases/tag/v1.9.0',
      signingKeyId: next.keyId,
      trustedKeyIds: [next.keyId, signer.keyId].sort(),
    })
    expect(restamped.describes).toBe('v1.9.0')
    expect(restamped.earlierManifestSha256).toBe(sha256Hex(v190.v1.bytes))
    expect(restamped.targets).toEqual(parseManifest(v190.v1.bytes).targets.map(({ filename, byteLength, sha256 }) => ({ filename, byteLength, sha256 })))
    expect(serializeManifest(restamped.manifest).equals(restamped.bytes)).toBe(true)
    expect(registry.signingKeyId).toBe(signer.keyId)
  })

  it('re-stamps a re-stamp, so every later arm64 release still describes the newest universal one', () => {
    const { signer, registry, v160, v170, v190, v200 } = history()
    const restamped = restampV1({
      earlierManifestBytes: v200.v1.bytes,
      earlierSignatureBytes: v200.v1.signature,
      registry,
      newTag: 'v2.0.1',
      publishedAt: '2027-02-01T12:00:00Z',
      releases: [v160.listing, v170.listing, v190.listing, v200.listing],
    })
    expect(restamped.describes).toBe('v1.9.0')
    expect(manifestDiff(v190.v1.bytes, restamped.bytes)).toEqual(['expiresAt', 'publishedAt'])
    expect(restamped.manifest.expiresAt).toBe(isoAfter('2027-02-01T12:00:00Z', 180 * DAY_MS))
    expect(verifyManifest({ manifestBytes: restamped.bytes, envelope: signBytes(restamped.bytes, signer), registry }).tag).toBe('v1.9.0')
  })

  it('refuses a forged earlier manifest, a v2 one and one that is not older', () => {
    const { registry, v160, v170, v190 } = history()
    const releases = [v160.listing, v170.listing, v190.listing]
    const restamp = (overrides: Partial<Parameters<typeof restampV1>[0]>) => () => restampV1({
      earlierManifestBytes: v190.v1.bytes,
      earlierSignatureBytes: v190.v1.signature,
      registry,
      newTag: 'v2.0.0',
      publishedAt: '2027-01-18T12:00:00Z',
      releases,
      ...overrides,
    })
    expect(restamp({})).not.toThrow()
    expect(restamp({ earlierSignatureBytes: signBytes(v190.v1.bytes, makeEphemeralKeypair()) })).toThrow(/signature verification failed/)
    expect(restamp({ earlierManifestBytes: Buffer.from(v190.v1.bytes.toString('utf8').replace('"byteLength": 111', '"byteLength": 112')) }))
      .toThrow(/do not match the digest/)
    expect(restamp({ earlierManifestBytes: v190.v2!.bytes, earlierSignatureBytes: v190.v2!.signature })).toThrow('manifest.schema must be 1')
    expect(restamp({ newTag: 'v1.9.0', releases: [] })).toThrow(/not older/)
    expect(restamp({ newTag: 'v1.8.9', releases: [] })).toThrow(/not older/)
  })

  it('refuses a copied target that disagrees with the files GitHub lists for the release it describes', () => {
    const { registry, v160, v170, v190 } = history()
    const tamper = (patch: (asset: ReleaseAssetLike) => ReleaseAssetLike | null, name = 'Agent-Inbox-v1.9.0-universal.dmg') => ({
      ...v190.listing,
      assets: v190.listing.assets.flatMap((asset) => {
        if (asset.name !== name) return [asset]
        const patched = patch(asset)
        return patched ? [patched] : []
      }),
    })
    const restamp = (described: ReleaseLike) => () => restampV1({
      earlierManifestBytes: v190.v1.bytes,
      earlierSignatureBytes: v190.v1.signature,
      registry,
      newTag: 'v2.0.0',
      publishedAt: '2027-01-18T12:00:00Z',
      releases: [v160.listing, v170.listing, described],
    })
    // GitHub may not report a digest; the size is still checked.
    expect(restamp(tamper(({ digest: _digest, ...asset }) => asset))).not.toThrow()
    expect(restamp(tamper((asset) => ({ ...asset, size: asset.size + 1 })))).toThrow(/Agent-Inbox-v1\.9\.0-universal\.dmg/)
    expect(restamp(tamper((asset) => ({ ...asset, digest: `sha256:${'f'.repeat(64)}` })))).toThrow(/Agent-Inbox-v1\.9\.0-universal\.dmg/)
    expect(restamp(tamper(() => null, 'agent-inbox_1.9.0_arm64.deb'))).toThrow(/does not list agent-inbox_1\.9\.0_arm64\.deb/)
    // Without its universal DMG, 1.9.0 is no longer the newest universal release (G6).
    expect(restamp(tamper(() => null))).toThrow(/newest .*v1\.7\.0/)
  })

  it('refuses unless it describes the newest published release with a universal DMG (G6)', () => {
    const { signer, registry, v160, v170, v190 } = history()
    const v191 = publishUniversal('1.9.1', signer, registry, '2027-01-10T12:00:00Z')
    const restamp = (releases: ReleaseLike[]) => () => restampV1({
      earlierManifestBytes: v190.v1.bytes,
      earlierSignatureBytes: v190.v1.signature,
      registry,
      newTag: 'v2.0.0',
      publishedAt: '2027-01-18T12:00:00Z',
      releases,
    })
    expect(restamp([v160.listing, v170.listing, v190.listing, v191.listing])).toThrow(/newest .*v1\.9\.1/)
    // Drafts and prereleases are not published releases.
    expect(restamp([v160.listing, v170.listing, v190.listing, { ...v191.listing, draft: true }, { ...v191.listing, prerelease: true }])).not.toThrow()
    expect(restamp([v160.listing, v170.listing])).toThrow(/newest .*v1\.7\.0/)
    expect(restamp([])).toThrow(/no published release/)
    expect(restamp([v160.listing, v170.listing, v190.listing, githubRelease({ tag_name: 'v2.0.0' })])).toThrow(/not older/)
  })
})

describe('planReleaseHistory — both manifests (G1 to G5)', () => {
  it('starts v2 in a universal release and continues v1 from the release before', () => {
    const { v160 } = history()
    const plan = planReleaseHistory({ releases: [v160.listing], newTag: 'v1.7.0', kind: 'universal' })
    expect(plan.v2).toEqual({ manifest: 'v2', mode: 'bootstrap', priorTag: null })
    expect(plan.v1).toMatchObject({ manifest: 'v1', mode: 'continuity', priorTag: 'v1.6.0', priorKind: 'universal' })
    if (plan.v1.mode !== 'continuity') throw new Error('expected continuity')
    const [manifestAsset, signatureAsset] = v160.listing.assets.filter((asset) => V1_NAMES.includes(asset.name))
    expect(plan.v1.manifestAsset).toEqual({
      id: manifestAsset!.id,
      name: 'update-manifest.json',
      size: manifestAsset!.size,
      url: manifestAsset!.browser_download_url,
      digest: manifestAsset!.digest,
    })
    expect(plan.v1.signatureAsset.id).toBe(signatureAsset!.id)
  })

  it('lets only a universal release start v2, and an arm64 release needs the release before to carry it (G4, G5)', () => {
    const { v160, v170, v190 } = history()
    expect(() => planReleaseHistory({ releases: [v160.listing], newTag: 'v2.0.0', kind: 'arm64' })).toThrow(/only a universal release/)
    const plan = planReleaseHistory({ releases: [v160.listing, v170.listing, v190.listing], newTag: 'v2.0.0', kind: 'arm64' })
    expect(plan.v1).toMatchObject({ mode: 'continuity', priorTag: 'v1.9.0', priorKind: 'universal' })
    expect(plan.v2).toMatchObject({ mode: 'continuity', priorTag: 'v1.9.0', priorKind: 'universal' })
    if (plan.v2.mode !== 'continuity') throw new Error('expected continuity')
    expect(plan.v2.manifestAsset.name).toBe('update-manifest-v2.json')
    expect(plan.v2.signatureAsset.name).toBe('update-manifest-v2.json.sig')
  })

  it('records an arm64 release before as arm64', () => {
    const { v160, v170, v190, v200 } = history()
    const plan = planReleaseHistory({ releases: [v160.listing, v170.listing, v190.listing, v200.listing], newTag: 'v2.0.1', kind: 'arm64' })
    expect(plan.v1).toMatchObject({ mode: 'continuity', priorTag: 'v2.0.0', priorKind: 'arm64' })
    expect(plan.v2).toMatchObject({ mode: 'continuity', priorTag: 'v2.0.0', priorKind: 'arm64' })
  })

  it('refuses a gap: once a release has published v2, the release before every new one must have it', () => {
    const { v160, v170, signer, registry } = history()
    const v180 = publishV1Only('1.8.0', signer, registry, '2026-12-01T12:00:00Z')
    for (const kind of ['universal', 'arm64'] as const) {
      expect(() => planReleaseHistory({ releases: [v160.listing, v170.listing, v180.listing], newTag: 'v1.9.0', kind }))
        .toThrow(/v1\.8\.0.*update-manifest-v2\.json/)
    }
  })

  it('refuses half of either pair in any release (G2)', () => {
    const { v160, v170, v190 } = history()
    for (const name of [...V1_NAMES, ...V2_NAMES]) {
      const half = { ...v170.listing, assets: v170.listing.assets.filter((asset) => asset.name !== name) }
      expect(() => planReleaseHistory({ releases: [v160.listing, half, v190.listing], newTag: 'v2.0.0', kind: 'universal' }), name)
        .toThrow(/partial/)
    }
  })

  it('bootstraps v1 only when no release has either v1 file, and never in an arm64 release', () => {
    expect(planReleaseHistory({ releases: [], newTag: 'v1.0.0', kind: 'universal' })).toEqual({
      v1: { manifest: 'v1', mode: 'bootstrap', priorTag: null },
      v2: { manifest: 'v2', mode: 'bootstrap', priorTag: null },
    })
    expect(() => planReleaseHistory({ releases: [], newTag: 'v1.0.0', kind: 'arm64' })).toThrow(/only a universal release/)
    const { v160 } = history()
    const noV1 = { ...v160.listing, tag_name: 'v1.6.1', assets: [] }
    expect(() => planReleaseHistory({ releases: [v160.listing, noV1], newTag: 'v1.7.0', kind: 'universal' }))
      .toThrow(/v1\.6\.1.*update-manifest\.json/)
  })

  it('tells the kind of the release before only from its own DMG, and refuses both', () => {
    const { v160 } = history()
    const noDmg = { ...v160.listing, assets: v160.listing.assets.filter((asset) => !asset.name.endsWith('.dmg')) }
    expect(planReleaseHistory({ releases: [noDmg], newTag: 'v1.7.0', kind: 'universal' }).v1).toMatchObject({ priorKind: null })
    const both = { ...v160.listing, assets: [...v160.listing.assets, listedAsset('v1.6.0', 'Agent-Inbox-v1.6.0-arm64.dmg', 5)] }
    expect(() => planReleaseHistory({ releases: [both], newTag: 'v1.7.0', kind: 'universal' })).toThrow(/both/)
  })

  it('keeps G1 and the listing checks of the v1 history', () => {
    const { v160, v170 } = history()
    expect(() => planReleaseHistory({ releases: [v160.listing, v170.listing], newTag: 'v1.7.0', kind: 'universal' })).toThrow(/not older/)
    expect(() => planReleaseHistory({ releases: [null as unknown as ReleaseLike], newTag: 'v1.7.0', kind: 'universal' })).toThrow(UpdateManifestError)
    expect(() => planReleaseHistory({ releases: [v160.listing], newTag: 'v1.7.0', kind: 'intel' as Kind })).toThrow(UpdateManifestError)
    expect(() => planReleaseHistory({ releases: [v160.listing], newTag: '1.7.0', kind: 'universal' })).toThrow(UpdateManifestError)
  })
})

describe('authorizeReleaseHistory — each earlier manifest, under this release\'s keys', () => {
  // The plan as it would read had GitHub listed `pair` as the release before's files.
  function listedAs(plan: ManifestHistoryPlan, pair: { bytes: Buffer; signature: Buffer }, digests = true): ManifestHistoryPlan {
    if (plan.mode !== 'continuity') throw new Error('expected a continuity plan')
    const listed = (asset: ManifestHistoryAsset, bytes: Buffer): ManifestHistoryAsset => {
      const { digest: _digest, ...rest } = asset
      return { ...rest, size: bytes.length, ...(digests ? { digest: `sha256:${sha256Hex(bytes)}` } : {}) }
    }
    return { ...plan, manifestAsset: listed(plan.manifestAsset, pair.bytes), signatureAsset: listed(plan.signatureAsset, pair.signature) }
  }

  function authorize(
    plan: ManifestHistoryPlan,
    pair: { bytes: Buffer; signature: Buffer } | undefined,
    registry: UpdateRegistry,
    newTag: string,
    rotationOverride?: string,
  ) {
    return authorizeReleaseHistory({
      plan,
      priorManifestBytes: pair?.bytes,
      priorSignatureBytes: pair?.signature,
      registry,
      newTag,
      rotationOverride,
    })
  }

  it('authorizes both earlier manifests of the release before', () => {
    const { registry, v160, v170, v190 } = history()
    const plan = planReleaseHistory({ releases: [v160.listing, v170.listing, v190.listing], newTag: 'v2.0.0', kind: 'arm64' })
    expect(authorize(plan.v1, v190.v1, registry, 'v2.0.0')).toMatchObject({
      manifest: 'v1', authorized: true, mode: 'continuity', priorTag: 'v1.9.0', describes: 'v1.9.0', rotationOverrideUsed: false,
    })
    expect(authorize(plan.v2, v190.v2, registry, 'v2.0.0')).toMatchObject({
      manifest: 'v2', authorized: true, mode: 'continuity', priorTag: 'v1.9.0', describes: 'v1.9.0', rotationOverrideUsed: false,
    })
  })

  it('authorizes a bootstrap with nothing to read', () => {
    const { registry, v160 } = history()
    const plan = planReleaseHistory({ releases: [v160.listing], newTag: 'v1.7.0', kind: 'universal' })
    expect(authorize(plan.v2, undefined, registry, 'v1.7.0')).toEqual({
      manifest: 'v2', authorized: true, mode: 'bootstrap', priorTag: null, rotationOverrideUsed: false,
    })
  })

  it('requires an earlier v1 to describe a universal release before, and an older one after an arm64 release', () => {
    const { registry, v160, v170, v190, v200 } = history()
    const releases = [v160.listing, v170.listing, v190.listing, v200.listing]
    const plan = planReleaseHistory({ releases, newTag: 'v2.0.1', kind: 'arm64' })
    expect(authorize(plan.v1, v200.v1, registry, 'v2.0.1')).toMatchObject({ priorTag: 'v2.0.0', describes: 'v1.9.0' })
    // A universal release's v1 must describe that release itself.
    const after190 = planReleaseHistory({ releases: [v160.listing, v170.listing, v190.listing], newTag: 'v2.0.0', kind: 'arm64' })
    expect(() => authorize(listedAs(after190.v1, v170.v1), v170.v1, registry, 'v2.0.0')).toThrow(/describes v1\.7\.0.*v1\.9\.0/)
    // A v1 of unknown kind is never trusted to describe anything.
    expect(() => authorize({ ...plan.v1, priorKind: null } as ManifestHistoryPlan, v200.v1, registry, 'v2.0.1')).toThrow(/universal or arm64/)
  })

  it('requires an earlier v2 to describe the release before', () => {
    const { registry, v160, v170, v190 } = history()
    const plan = planReleaseHistory({ releases: [v160.listing, v170.listing, v190.listing], newTag: 'v2.0.0', kind: 'arm64' })
    expect(() => authorize(listedAs(plan.v2, v170.v2!, false), v170.v2, registry, 'v2.0.0')).toThrow(/describes v1\.7\.0.*v1\.9\.0/)
    // A v1 file in the v2 slot fails on schema, once its size and signature check out.
    expect(() => authorize(listedAs(plan.v2, v190.v1, false), v190.v1, registry, 'v2.0.0')).toThrow('manifest.schema must be 2')
  })

  it('refuses bytes that are not the ones GitHub listed', () => {
    const { registry, v160, v170, v190 } = history()
    const plan = planReleaseHistory({ releases: [v160.listing, v170.listing, v190.listing], newTag: 'v2.0.0', kind: 'arm64' })
    expect(() => authorize(plan.v2, { bytes: Buffer.concat([v190.v2!.bytes, Buffer.from(' ')]), signature: v190.v2!.signature }, registry, 'v2.0.0'))
      .toThrow(/GitHub/)
    const sameSize = Buffer.from(v190.v2!.signature)
    sameSize[sameSize.length - 2] = 0x20
    expect(() => authorize(plan.v2, { bytes: v190.v2!.bytes, signature: sameSize }, registry, 'v2.0.0')).toThrow(/GitHub/)
    expect(() => authorize(plan.v2, undefined, registry, 'v2.0.0')).toThrow(UpdateManifestError)
  })

  it('keeps the key rule: the new signing key is trusted already, or the exact override names it', () => {
    const { signer, v160, v170, v190 } = history()
    const next = makeEphemeralKeypair()
    const rotated: UpdateRegistry = { ...makeRegistry(next, signer), signingKeyId: next.keyId }
    const plan = planReleaseHistory({ releases: [v160.listing, v170.listing, v190.listing], newTag: 'v2.0.0', kind: 'arm64' })
    for (const [manifestPlan, pair] of [[plan.v1, v190.v1], [plan.v2, v190.v2]] as const) {
      expect(() => authorize(manifestPlan, pair, rotated, 'v2.0.0')).toThrow(`ALLOW-UPDATE-KEY-ROTATION:v2.0.0:${next.keyId}`)
      expect(() => authorize(manifestPlan, pair, rotated, 'v2.0.0', `ALLOW-UPDATE-KEY-ROTATION:v2.0.1:${next.keyId}`)).toThrow(UpdateManifestError)
      expect(() => authorize(manifestPlan, pair, rotated, 'v2.0.0', `ALLOW-UPDATE-KEY-ROTATION:v2.0.0:${signer.keyId}`)).toThrow(UpdateManifestError)
      expect(authorize(manifestPlan, pair, rotated, 'v2.0.0', `ALLOW-UPDATE-KEY-ROTATION:v2.0.0:${next.keyId}`))
        .toMatchObject({ authorized: true, rotationOverrideUsed: true })
    }
  })

  it('reads an earlier manifest long after it expired', () => {
    const signer = makeEphemeralKeypair()
    const registry = makeRegistry(signer)
    const old = publishUniversal('1.7.0', signer, registry, '2000-01-01T00:00:00Z')
    const plan = planReleaseHistory({ releases: [old.listing], newTag: 'v1.8.0', kind: 'universal' })
    expect(authorize(plan.v2, old.v2, registry, 'v1.8.0').authorized).toBe(true)
    expect(authorize(plan.v1, old.v1, registry, 'v1.8.0').authorized).toBe(true)
  })
})

// The aggregate evidence the release's own code hands the signer (#341's field names).
function aggregateAssets(kind: Kind, evidence: ReleaseEvidence) {
  const macos = macosRelease({ kind, tag: evidence.tag })
  const sets = kind === 'universal' ? ['arm64', 'x86_64'] : ['arm64']
  const packageArch = { appimage: { x64: 'x86_64', arm64: 'aarch64' }, deb: { x64: 'amd64', arm64: 'arm64' } } as const
  return evidence.assets.map((asset) => {
    if (asset.platform === 'darwin') {
      return {
        name: asset.name,
        packageType: 'DMG',
        platform: 'macos',
        architecture: macos.architecture,
        target: macos.target,
        architectures: { executable: [...sets], betterSqlite3: [...sets] },
        ...(macos.needsNativeIntel ? { nativeIntel: 'passed' } : {}),
        size: asset.size,
        sha256: asset.sha256,
        notarization: { appStatus: 'Accepted', dmgStatus: 'Accepted' },
      }
    }
    const linuxType = asset.packageType === 'appimage' ? 'appimage' : 'deb'
    const arch = asset.architecture === 'x64' ? 'x64' : 'arm64'
    return {
      name: asset.name,
      packageType: linuxType === 'appimage' ? 'AppImage' : 'DEB',
      platform: 'linux',
      architecture: packageArch[linuxType][arch],
      target: `linux-${arch}`,
      size: asset.size,
      sha256: asset.sha256,
    }
  }).sort((left, right) => (left.name < right.name ? -1 : 1))
}

function releaseHandoff(
  kind: Kind = 'universal',
  signer: Signer = makeEphemeralKeypair(),
  releaseVersion = version,
  taggedAt = publishedAt,
) {
  const releaseTag = `v${releaseVersion}`
  const registry = makeRegistry(signer)
  const registryBytes = Buffer.from(`${JSON.stringify(registry, null, 2)}\n`)
  const evidence = evidenceFor(kind, { tag: releaseTag, packageVersion: releaseVersion })
  const { bytes: manifestBytes } = generateManifestV2({ registry, evidence, minimumMacosVersion, publishedAt: taggedAt, kind })
  const assets = aggregateAssets(kind, evidence)
  const aggregate = {
    schema: 1,
    product: 'Agent Inbox',
    tag: releaseTag,
    packageVersion: releaseVersion,
    sourceCommit,
    sourceTree,
    annotatedTag: true,
    publishable: true,
    assets,
    updateManifest: {
      name: 'update-manifest-v2.json',
      size: manifestBytes.length,
      sha256: sha256Hex(manifestBytes),
      keyRegistrySha256: sha256Hex(registryBytes),
    },
  }
  return {
    tag: releaseTag,
    signer,
    registry,
    registryBytes,
    evidence,
    manifestBytes,
    aggregate,
    context: { schema: 1, tag: releaseTag, version: releaseVersion, sourceCommit, taggedAt, annotated: true },
    macosInputs: { macosArchitectures: kind === 'universal' ? ['arm64', 'x86_64'] : ['arm64'], minimumMacosVersion },
    packages: Object.fromEntries(assets.map((asset) => [asset.name, { size: asset.size, sha256: asset.sha256 }])),
  }
}

type Handoff = ReturnType<typeof releaseHandoff>

function checkHandoff(handoff: Handoff, overrides: Record<string, unknown> = {}) {
  return checkReleaseManifest({
    manifestBytes: handoff.manifestBytes,
    aggregate: handoff.aggregate,
    context: handoff.context,
    registryBytes: handoff.registryBytes,
    macosInputs: handoff.macosInputs,
    packages: handoff.packages,
    tag: handoff.tag,
    sourceCommit,
    ...overrides,
  } as Parameters<typeof checkReleaseManifest>[0])
}

function withMacAsset(handoff: Handoff, patch: Record<string, unknown>, drop: string[] = []) {
  return {
    ...handoff.aggregate,
    assets: handoff.aggregate.assets.map((asset) => {
      if (asset.platform !== 'macos') return asset
      const patched: Record<string, unknown> = { ...asset, ...patch }
      for (const key of drop) delete patched[key]
      return patched
    }),
  }
}

describe('checkReleaseManifest — the unsigned v2 manifest describes this release (G7, G9)', () => {
  it('accepts a universal and an arm64 release and reports the measured kind', () => {
    const universal = checkHandoff(releaseHandoff('universal'))
    expect(universal).toMatchObject({
      kind: 'universal',
      dmgName: `Agent-Inbox-${tag}-universal.dmg`,
      macos: {
        kind: 'universal',
        architectures: { executable: ['arm64', 'x86_64'], betterSqlite3: ['arm64', 'x86_64'] },
        expected: ['arm64', 'x86_64'],
      },
    })
    expect(universal.manifest.tag).toBe(tag)
    const arm64Handoff = releaseHandoff('arm64')
    expect(checkHandoff(arm64Handoff)).toMatchObject({
      kind: 'arm64',
      dmgName: `Agent-Inbox-${tag}-arm64.dmg`,
      manifestSha256: sha256Hex(arm64Handoff.manifestBytes),
      macos: { kind: 'arm64', architectures: { executable: ['arm64'], betterSqlite3: ['arm64'] }, expected: ['arm64'] },
    })
  })

  it('refuses a name, a label or an Intel record that disagrees with the measured CPU types (G9)', () => {
    const universal = releaseHandoff('universal')
    const arm64 = releaseHandoff('arm64')
    const arm64Only = { executable: ['arm64'], betterSqlite3: ['arm64'] }
    const cases: Array<[string, Handoff, Record<string, unknown>]> = [
      ['arm64-only sets under the universal name and labels', universal, { aggregate: withMacAsset(universal, { architectures: arm64Only, nativeIntel: undefined }) }],
      ['arm64-only sets with the universal label', arm64, { aggregate: withMacAsset(arm64, { architecture: 'universal' }) }],
      ['arm64-only sets with the universal target', arm64, { aggregate: withMacAsset(arm64, { target: 'darwin-arm64+darwin-x64' }) }],
      ['arm64-only sets under the universal DMG name', arm64, { aggregate: withMacAsset(arm64, { name: `Agent-Inbox-${tag}-universal.dmg` }) }],
      ['an executable and an addon that disagree', universal, { aggregate: withMacAsset(universal, { architectures: { executable: ['arm64', 'x86_64'], betterSqlite3: ['arm64'] } }) }],
      ['x86_64 alone', universal, { aggregate: withMacAsset(universal, { architectures: { executable: ['x86_64'], betterSqlite3: ['x86_64'] } }) }],
      ['measured sets that differ from the expected set', universal, { macosInputs: { ...universal.macosInputs, macosArchitectures: ['arm64'] } }],
      ['an expected set that is no kind', universal, { macosInputs: { ...universal.macosInputs, macosArchitectures: ['x86_64'] } }],
      ['a universal release without the Intel gate\'s pass', universal, { aggregate: withMacAsset(universal, {}, ['nativeIntel']) }],
      ['an arm64 release that claims an Intel gate', arm64, { aggregate: withMacAsset(arm64, { nativeIntel: 'passed' }) }],
      ['a third measured file', universal, { aggregate: withMacAsset(universal, { architectures: { executable: ['arm64', 'x86_64'], betterSqlite3: ['arm64', 'x86_64'], helper: ['arm64'] } }) }],
    ]
    for (const [label, handoff, overrides] of cases) {
      expect(() => checkHandoff(handoff, overrides), label).toThrow(UpdateManifestError)
    }
  })

  it('refuses a v2 manifest that is not exactly what this release\'s evidence gives (G7)', () => {
    const handoff = releaseHandoff('universal')
    const raw = JSON.parse(handoff.manifestBytes.toString('utf8')) as RawManifest
    const regenerated = (value: unknown) => {
      const bytes = rawBytes(value)
      return {
        manifestBytes: bytes,
        aggregate: { ...handoff.aggregate, updateManifest: { ...handoff.aggregate.updateManifest, size: bytes.length, sha256: sha256Hex(bytes) } },
      }
    }
    const other = generateManifestV2({
      registry: handoff.registry,
      evidence: buildEvidence({ tag: 'v1.2.4', packageVersion: '1.2.4' }),
      minimumMacosVersion,
      publishedAt,
      kind: 'universal',
    })
    const cases: Array<[string, Record<string, unknown>]> = [
      ['a v2 manifest of another release', regenerated(JSON.parse(other.bytes.toString('utf8')))],
      ['a key the publisher never writes', regenerated({ ...raw, channel: 'stable' })],
      ['a shorter lifetime', regenerated({ ...raw, expiresAt: isoAfter(publishedAt, 90 * DAY_MS) })],
      ['another package size', regenerated({ ...raw, targets: raw.targets.map((target, index) => (index === 1 ? { ...target, byteLength: 334 } : target)) })],
      ['another minimum macOS', regenerated({ ...raw, targets: raw.targets.map((target, index) => (index === 0 ? { ...target, minimumSystemVersion: '14.0' } : target)) })],
      ['the v1 file named in the evidence', { aggregate: { ...handoff.aggregate, updateManifest: { ...handoff.aggregate.updateManifest, name: 'update-manifest.json' } } }],
      ['evidence about other bytes', { aggregate: { ...handoff.aggregate, updateManifest: { ...handoff.aggregate.updateManifest, sha256: 'f'.repeat(64) } } }],
      ['another key registry', { registryBytes: Buffer.from(`${JSON.stringify(makeRegistry(makeEphemeralKeypair()), null, 2)}\n`) }],
      ['another publishedAt in the context', { context: { ...handoff.context, taggedAt: '2026-01-02T00:00:00Z' } }],
      ['another tag than authorized', { tag: 'v1.2.4' }],
      ['another source commit than authorized', { sourceCommit: 'c'.repeat(40) }],
      ['an unannotated tag', { context: { ...handoff.context, annotated: false } }],
      ['evidence for another commit', { aggregate: { ...handoff.aggregate, sourceCommit: 'c'.repeat(40) } }],
      ['evidence that is not publishable', { aggregate: { ...handoff.aggregate, publishable: false } }],
    ]
    for (const [label, overrides] of cases) {
      expect(() => checkHandoff(handoff, overrides), label).toThrow(UpdateManifestError)
    }
  })

  it('re-hashes the packages: each file must be the one the evidence describes', () => {
    const handoff = releaseHandoff('universal')
    const dmgName = `Agent-Inbox-${tag}-universal.dmg`
    const { [dmgName]: dmg, ...linux } = handoff.packages
    const cases: Array<[string, Record<string, { size: number; sha256: string }>]> = [
      ['another size', { ...handoff.packages, [dmgName]: { ...dmg!, size: dmg!.size + 1 } }],
      ['another digest', { ...handoff.packages, [dmgName]: { ...dmg!, sha256: 'f'.repeat(64) } }],
      ['a missing package', linux],
      ['an extra file', { ...handoff.packages, 'Agent-Inbox-v1.2.3-arm64.dmg': { size: 1, sha256: 'f'.repeat(64) } }],
    ]
    for (const [label, packages] of cases) {
      expect(() => checkHandoff(handoff, { packages }), label).toThrow(UpdateManifestError)
    }
  })
})

describe('deriveV1 — v1 by projection or re-stamp (G6, G8)', () => {
  it('projects a universal release, with today\'s generator bytes and the same data as v2 (G8)', () => {
    const handoff = releaseHandoff('universal')
    const checked = checkHandoff(handoff)
    const derived = deriveV1({ release: checked, v2ManifestBytes: handoff.manifestBytes, registry: handoff.registry, releases: [] })
    const today = generateManifest({ registry: handoff.registry, evidence: buildEvidence(), minimumMacosVersion, publishedAt })
    expect(derived).toMatchObject({ made: 'projection', describes: tag })
    expect(derived.bytes.equals(today.bytes)).toBe(true)
    expect(handoff.manifestBytes.toString('utf8').replace('\n  "schema": 2,\n', '\n  "schema": 1,\n')).toBe(derived.bytes.toString('utf8'))
    expect(() => deriveV1({ release: checked, v2ManifestBytes: Buffer.concat([handoff.manifestBytes, Buffer.from('\n')]), registry: handoff.registry, releases: [] }))
      .toThrow(/not the v2 manifest/)
  })

  it('re-stamps for an arm64 release, describing the newest universal one (G6)', () => {
    const { signer, registry, v160, v170, v190 } = history()
    const handoff = releaseHandoff('arm64', signer, '2.0.0', '2027-01-18T12:00:00Z')
    const arm64Checked = checkHandoff(handoff)
    const releases = [v160.listing, v170.listing, v190.listing]
    const derived = deriveV1({
      release: arm64Checked,
      v2ManifestBytes: handoff.manifestBytes,
      registry,
      releases,
      earlierManifestBytes: v190.v1.bytes,
      earlierSignatureBytes: v190.v1.signature,
    })
    expect(derived).toMatchObject({ made: 'restamp', describes: 'v1.9.0', earlierManifestSha256: sha256Hex(v190.v1.bytes) })
    expect(manifestDiff(v190.v1.bytes, derived.bytes)).toEqual(['expiresAt', 'publishedAt'])
    expect(derived.manifest.publishedAt).toBe('2027-01-18T12:00:00Z')
    expect(derived.manifest.expiresAt).toBe('2027-07-17T12:00:00Z')
    expect(() => deriveV1({ release: arm64Checked, v2ManifestBytes: handoff.manifestBytes, registry, releases }))
      .toThrow(/earlier v1 manifest/)
    // The v1 of a universal release before an older universal one is refused (G6).
    expect(() => deriveV1({
      release: arm64Checked,
      v2ManifestBytes: handoff.manifestBytes,
      registry,
      releases,
      earlierManifestBytes: v170.v1.bytes,
      earlierSignatureBytes: v170.v1.signature,
    })).toThrow(/newest .*v1\.9\.0/)
  })
})

describe('the original key on every v1 manifest (G10)', () => {
  const v1For = (signers: Signer[], registry: UpdateRegistry) => {
    const { bytes } = generateManifest({ registry, evidence: buildEvidence(), minimumMacosVersion, publishedAt })
    return { manifestBytes: bytes, envelope: signBytes(bytes, ...signers) }
  }

  it('pins the key 1.2 to 1.6 trust, as the production registry lists it', () => {
    const production = parseRegistry(readFileSync(join(root, 'release', 'update-keys.json')))
    expect(ORIGINAL_UPDATE_KEY).toEqual({ keyId: PROD_KEY_ID, algorithm: 'ed25519', publicKeySpkiBase64: PROD_PUBLIC_KEY_SPKI_BASE64 })
    expect(production.keys).toContainEqual(ORIGINAL_UPDATE_KEY)
    expect(deriveKeyId(ORIGINAL_UPDATE_KEY.publicKeySpkiBase64)).toBe(ORIGINAL_UPDATE_KEY.keyId)
  })

  it('passes when the original key signed the v1 manifest', () => {
    const original = makeEphemeralKeypair()
    const backup = makeEphemeralKeypair()
    const registry = makeRegistry(original, backup)
    const originalKey = { keyId: original.keyId, algorithm: 'ed25519' as const, publicKeySpkiBase64: original.publicKeySpkiBase64 }
    const signed = v1For([original], registry)
    expect(checkOriginalKeySignature({ ...signed, registry, newTag: tag, originalKey })).toEqual({ originalKeySignature: 'passed' })
    expect(checkOriginalKeySignature({ ...v1For([original, backup], registry), registry, newTag: tag, originalKey }))
      .toEqual({ originalKeySignature: 'passed' })
    expect(planOriginalKeySignature({ registry, newTag: tag, originalKey })).toEqual({ originalKeySignature: 'passed' })
  })

  it('refuses a v1 manifest without it, unless the exact override for this tag and signing key waives it', () => {
    const signer = makeEphemeralKeypair()
    const registry = makeRegistry(signer)
    const signed = v1For([signer], registry)
    const exact = `ALLOW-UPDATE-KEY-ROTATION:${tag}:${signer.keyId}`
    // The production key never signs in tests, so its signature is missing here.
    expect(() => checkOriginalKeySignature({ ...signed, registry, newTag: tag })).toThrow(exact)
    expect(() => planOriginalKeySignature({ registry, newTag: tag })).toThrow(exact)
    for (const override of [
      `ALLOW-UPDATE-KEY-ROTATION:v1.2.4:${signer.keyId}`,
      `ALLOW-UPDATE-KEY-ROTATION:${tag}:${PROD_KEY_ID}`,
      `${exact} `,
      exact.toLowerCase(),
      '',
    ]) {
      expect(() => checkOriginalKeySignature({ ...signed, registry, newTag: tag, rotationOverride: override }), override).toThrow(UpdateManifestError)
      expect(() => planOriginalKeySignature({ registry, newTag: tag, rotationOverride: override }), override).toThrow(UpdateManifestError)
    }
    const waived = { originalKeySignature: 'waived', rotationOverride: exact }
    expect(checkOriginalKeySignature({ ...signed, registry, newTag: tag, rotationOverride: exact })).toEqual(waived)
    expect(planOriginalKeySignature({ registry, newTag: tag, rotationOverride: exact })).toEqual(waived)
  })

  it('counts only a valid signature of the exact bytes by the original key', () => {
    const original = makeEphemeralKeypair()
    const other = makeEphemeralKeypair()
    const registry = makeRegistry(other, original)
    const originalKey = { keyId: original.keyId, algorithm: 'ed25519' as const, publicKeySpkiBase64: original.publicKeySpkiBase64 }
    const { manifestBytes } = v1For([other], registry)
    // An entry under the original key id that holds another key's signature.
    const impostor = serializeEnvelope({
      schema: 1,
      manifestSha256: sha256Hex(manifestBytes),
      signatures: [{ algorithm: 'ed25519', keyId: original.keyId, signature: edSign(null, manifestBytes, other.privateKeyPem).toString('base64') }],
    })
    expect(() => checkOriginalKeySignature({ manifestBytes, envelope: impostor, registry, newTag: tag, originalKey })).toThrow(UpdateManifestError)
    const signedByOriginal = signBytes(manifestBytes, original)
    const otherBytes = Buffer.concat([manifestBytes, Buffer.from(' ')])
    expect(() => checkOriginalKeySignature({ manifestBytes: otherBytes, envelope: signedByOriginal, registry, newTag: tag, originalKey }))
      .toThrow(/digest/)
    // The registry signs with another key, so a v1 signed only by that key needs the waiver.
    expect(() => planOriginalKeySignature({ registry, newTag: tag, originalKey })).toThrow(UpdateManifestError)
  })
})

describe('signManifest — either schema, one envelope schema', () => {
  it('signs a v2 manifest that only the v2 verifier accepts, in an envelope of schema 1', () => {
    const release = v2Release('arm64')
    const { envelope, bytes } = signManifest({ manifestBytes: release.bytes, registry: release.registry, privateKeyPem: release.signer.privateKeyPem, now: publishedAt })
    expect(envelope.schema).toBe(UPDATE_ENVELOPE_SCHEMA)
    expect(verifyManifestV2({ manifestBytes: release.bytes, envelope: bytes, registry: release.registry, now: publishedAt }).tag).toBe(tag)
    expect(() => verifyManifest({ manifestBytes: release.bytes, envelope: bytes, registry: release.registry, now: publishedAt }))
      .toThrow('manifest.schema must be 1')
  })

  it('refuses an expired v2 manifest and a manifest of any other schema', () => {
    const release = v2Release()
    const sign = (manifestBytes: Buffer, now = publishedAt) => signManifest({ manifestBytes, registry: release.registry, privateKeyPem: release.signer.privateKeyPem, now })
    expect(() => sign(release.bytes, isoAfter(publishedAt, 181 * DAY_MS))).toThrow(/expired/)
    expect(() => sign(rawBytes({ ...release.raw, schema: 3 }))).toThrow(UpdateManifestError)
    expect(() => sign(Buffer.from('not json'))).toThrow(UpdateManifestError)
  })
})

// What the signer's bind step records (design §5.7), from what the earlier steps checked.
describe('bindSigningEvidence — signing evidence schema 2', () => {
  const asKey = (signer: Signer) => ({ keyId: signer.keyId, algorithm: 'ed25519' as const, publicKeySpkiBase64: signer.publicKeySpkiBase64 })

  // A release through the trusted steps in process: check, plan, authorize, derive, sign.
  function signedRelease(kind: Kind) {
    const { signer, registry, v160, v170, v190 } = history()
    const releases = kind === 'universal' ? [v160.listing] : [v160.listing, v170.listing, v190.listing]
    const releaseVersion = kind === 'universal' ? '1.7.0' : '2.0.0'
    const taggedAt = kind === 'universal' ? '2026-11-16T12:00:00Z' : '2027-01-18T12:00:00Z'
    const handoff = releaseHandoff(kind, signer, releaseVersion, taggedAt)
    const checked = checkHandoff(handoff)
    const plan = planReleaseHistory({ releases, newTag: handoff.tag, kind })
    const prior = kind === 'universal' ? { v1: v160.v1, v2: undefined } : { v1: v190.v1, v2: v190.v2 }
    const authorized = (manifest: 'v1' | 'v2') => {
      const pair = prior[manifest]
      const { priorManifest: _prior, ...result } = authorizeReleaseHistory({
        plan: plan[manifest],
        priorManifestBytes: pair?.bytes,
        priorSignatureBytes: pair?.signature,
        registry,
        newTag: handoff.tag,
      }) as ReturnType<typeof authorizeReleaseHistory> & { priorManifest?: unknown }
      return result
    }
    const derived = deriveV1({
      release: checked,
      v2ManifestBytes: handoff.manifestBytes,
      registry,
      releases,
      ...(kind === 'arm64' ? { earlierManifestBytes: v190.v1.bytes, earlierSignatureBytes: v190.v1.signature } : {}),
    })
    const sign = (manifestBytes: Buffer) => signManifest({ manifestBytes, registry, privateKeyPem: signer.privateKeyPem, now: taggedAt }).bytes
    const { bytes: v1Bytes, manifest: _manifest, ...derivation } = derived as typeof derived & { manifest: unknown }
    return {
      signer,
      handoff,
      v190,
      input: {
        registryBytes: handoff.registryBytes,
        aggregate: handoff.aggregate,
        tag: handoff.tag,
        sourceCommit,
        release: { kind: checked.kind, macos: checked.macos, manifestSha256: checked.manifestSha256 },
        history: { v1: authorized('v1'), v2: authorized('v2') },
        derivation: { ...derivation, sha256: sha256Hex(v1Bytes) },
        v2: { manifestBytes: handoff.manifestBytes, signatureBytes: sign(handoff.manifestBytes) },
        v1: { manifestBytes: v1Bytes, signatureBytes: sign(v1Bytes) },
        now: isoAfter(taggedAt, DAY_MS),
        originalKey: asKey(signer),
        rotationOverride: undefined as string | undefined,
      },
    }
  }

  const file = (name: string, bytes: Buffer) => ({ name, size: bytes.length, sha256: sha256Hex(bytes) })

  it('records a universal release: v2 as released, v1 as its projection', () => {
    const { signer, input } = signedRelease('universal')
    expect(bindSigningEvidence(input)).toEqual({
      schema: 2,
      tag: 'v1.7.0',
      sourceCommit,
      sourceTree,
      signingKeyId: signer.keyId,
      trustedKeyIds: [signer.keyId],
      macos: { kind: 'universal', architectures: { executable: ['arm64', 'x86_64'], betterSqlite3: ['arm64', 'x86_64'] }, expected: ['arm64', 'x86_64'] },
      originalKeySignature: 'passed',
      manifests: {
        v2: {
          ...file('update-manifest-v2.json', input.v2.manifestBytes),
          signature: file('update-manifest-v2.json.sig', input.v2.signatureBytes),
          version: '1.7.0',
          tag: 'v1.7.0',
          made: 'release',
          history: { mode: 'bootstrap', priorTag: null, rotationOverrideUsed: false },
        },
        v1: {
          ...file('update-manifest.json', input.v1.manifestBytes),
          signature: file('update-manifest.json.sig', input.v1.signatureBytes),
          version: '1.7.0',
          tag: 'v1.7.0',
          made: 'projection',
          history: { mode: 'continuity', priorTag: 'v1.6.0', describes: 'v1.6.0', rotationOverrideUsed: false },
        },
      },
      verification: { privateKeyMatchesRegistry: 'passed', signatures: 'passed' },
    })
  })

  it('records an arm64 release: v1 re-stamped from the newest universal release, with what it copied', () => {
    const { input, v190 } = signedRelease('arm64')
    const evidence = bindSigningEvidence(input)
    expect(evidence.macos).toEqual({ kind: 'arm64', architectures: { executable: ['arm64'], betterSqlite3: ['arm64'] }, expected: ['arm64'] })
    expect(evidence.manifests.v2).toMatchObject({ version: '2.0.0', tag: 'v2.0.0', made: 'release', history: { mode: 'continuity', priorTag: 'v1.9.0', describes: 'v1.9.0' } })
    const earlier = parseManifest(v190.v1.bytes)
    expect(evidence.manifests.v1).toMatchObject({
      version: '1.9.0',
      tag: 'v1.9.0',
      made: 'restamp',
      history: { mode: 'continuity', priorTag: 'v1.9.0', describes: 'v1.9.0', rotationOverrideUsed: false },
      restamp: {
        earlierManifestSha256: sha256Hex(v190.v1.bytes),
        targets: earlier.targets.map(({ filename, byteLength, sha256 }) => ({ filename, byteLength, sha256 })),
      },
    })
  })

  it('records the waiver, with its exact override, only when the original key did not sign v1 (G10)', () => {
    const { signer, input } = signedRelease('universal')
    const { originalKey: _scratch, ...withProductionKey } = input
    const exact = `ALLOW-UPDATE-KEY-ROTATION:v1.7.0:${signer.keyId}`
    expect(() => bindSigningEvidence(withProductionKey)).toThrow(exact)
    expect(() => bindSigningEvidence({ ...withProductionKey, rotationOverride: `ALLOW-UPDATE-KEY-ROTATION:v1.7.1:${signer.keyId}` })).toThrow(UpdateManifestError)
    const evidence = bindSigningEvidence({ ...withProductionKey, rotationOverride: exact })
    expect(evidence).toMatchObject({ originalKeySignature: 'waived', rotationOverride: exact })
    expect(Object.keys(evidence)).toEqual([
      'schema', 'tag', 'sourceCommit', 'sourceTree', 'signingKeyId', 'trustedKeyIds', 'macos',
      'originalKeySignature', 'rotationOverride', 'manifests', 'verification',
    ])
    expect(bindSigningEvidence({ ...input, rotationOverride: exact })).not.toHaveProperty('rotationOverride')
  })

  it('refuses files that are not the ones the earlier steps checked, derived and signed', () => {
    const { signer, input } = signedRelease('universal')
    const other = makeEphemeralKeypair()
    const resigned = (bytes: Buffer, ...signers: Signer[]) => signBytes(bytes, ...signers)
    const v1Changed = Buffer.from(input.v1.manifestBytes.toString('utf8').replace('"schema": 1', '"schema": 1 '))
    for (const [label, patch, message] of [
      ['a v2 manifest other than the checked one', { release: { ...input.release, manifestSha256: 'f'.repeat(64) } }, /not the v2 manifest/],
      ['a v1 manifest other than the derived one', { v1: { manifestBytes: v1Changed, signatureBytes: resigned(v1Changed, signer) } }, /not the v1 manifest/],
      ['a v2 envelope signed by two keys', { v2: { ...input.v2, signatureBytes: resigned(input.v2.manifestBytes, signer, other) } }, /exactly one signature/],
      ['a v1 envelope by an unregistered key', { v1: { ...input.v1, signatureBytes: resigned(input.v1.manifestBytes, other) } }, UpdateManifestError],
      ['manifests that have expired by now', { now: isoAfter('2026-11-16T12:00:00Z', 181 * DAY_MS) }, /expired/],
      ['a history that was not authorized', { history: { ...input.history, v2: { ...input.history.v2, authorized: false } } }, /history/],
      ['a v1 made the other way', { derivation: { ...input.derivation, made: 'restamp' } }, /projection/],
      ['measured CPU types that give another kind', { release: { ...input.release, macos: { ...input.release.macos, expected: ['arm64'] } } }, UpdateManifestError],
      ['another tag', { tag: 'v1.7.1' }, UpdateManifestError],
      ['another registry', { registryBytes: Buffer.from(`${JSON.stringify(makeRegistry(other), null, 2)}\n`) }, UpdateManifestError],
    ] as const) {
      expect(() => bindSigningEvidence({ ...input, ...patch } as typeof input), label).toThrow(message)
    }
  })
})


// The backup update key (#342, design §10 decision 7). The original key still signs every
// manifest; the backup is only trusted, so a release signed with it under the exact override
// still reaches every app from 1.7.0 on. Neither private half is available here: scratch keys
// stand in for them wherever something is signed.
describe('the backup update key (#342)', () => {
  const production = () => parseRegistry(readFileSync(join(root, 'release', 'update-keys.json')))
  const entry = (signer: Signer) => ({ keyId: signer.keyId, algorithm: 'ed25519' as const, publicKeySpkiBase64: signer.publicKeySpkiBase64 })
  /** The production registry with a scratch key in the original key's place, and the backup key, found by its id. */
  const asReleased = (original: Signer): UpdateRegistry => ({
    schema: 1,
    signingKeyId: original.keyId,
    keys: [entry(original), ...production().keys.filter((key) => key.keyId === BACKUP_KEY_ID)],
  })

  it('lists both keys in every manifest generated from the production registry, sorted, with the original signing', () => {
    const registry = production()
    // Whatever order the registry lists them in.
    for (const keys of [registry.keys, [...registry.keys].reverse()]) {
      const reg = { ...registry, keys }
      const v2 = generateManifestV2({ registry: reg, evidence: buildEvidence(), minimumMacosVersion, publishedAt, kind: 'universal' })
      for (const manifest of [
        generateManifest({ registry: reg, evidence: buildEvidence(), minimumMacosVersion, publishedAt }).manifest,
        projectV1(v2.bytes).manifest,
        v2.manifest,
        generateManifestV2({ registry: reg, evidence: buildArm64Evidence(), minimumMacosVersion, publishedAt, kind: 'arm64' }).manifest,
      ]) {
        expect(manifest.trustedKeyIds).toEqual([PROD_KEY_ID, BACKUP_KEY_ID])
        expect(manifest.signingKeyId).toBe(PROD_KEY_ID)
      }
    }
  })

  it('signs each manifest once, with the original key, and refuses any other key', () => {
    const original = makeEphemeralKeypair()
    const registry = asReleased(original)
    const v2 = generateManifestV2({ registry, evidence: buildEvidence(), minimumMacosVersion, publishedAt, kind: 'universal' })
    for (const bytes of [v2.bytes, projectV1(v2.bytes).bytes]) {
      expect(JSON.parse(bytes.toString('utf8')).trustedKeyIds).toEqual([original.keyId, BACKUP_KEY_ID].sort())
      const { envelope } = signManifest({ manifestBytes: bytes, registry, privateKeyPem: original.privateKeyPem, now: publishedAt })
      expect(envelope.signatures.map((signature) => signature.keyId)).toEqual([original.keyId])
    }
    // The backup key is registered, but it is not the signing key.
    const backup = makeEphemeralKeypair()
    const withBackup = makeRegistry(original, backup)
    const manifestBytes = generateManifest({ registry: withBackup, evidence: buildEvidence(), minimumMacosVersion, publishedAt }).bytes
    expect(() => signManifest({ manifestBytes, registry: withBackup, privateKeyPem: backup.privateKeyPem, now: publishedAt }))
      .toThrow(`privateKeyPem derives key id ${backup.keyId}, which does not match registry.signingKeyId ${original.keyId}`)
    // The production registry signs with the original key alone.
    const stranger = makeEphemeralKeypair()
    expect(() => signManifest({ manifestBytes, registry: production(), privateKeyPem: stranger.privateKeyPem, now: publishedAt }))
      .toThrow(`which does not match registry.signingKeyId ${PROD_KEY_ID}`)
  })

  it('passes G10 with the original key\'s signature alone', () => {
    expect(planOriginalKeySignature({ registry: production(), newTag: 'v1.7.0' })).toEqual({ originalKeySignature: 'passed' })
    const original = makeEphemeralKeypair()
    const registry = asReleased(original)
    const { manifest, bytes } = generateManifest({ registry, evidence: buildEvidence(), minimumMacosVersion, publishedAt })
    expect(manifest.trustedKeyIds).toEqual([original.keyId, BACKUP_KEY_ID].sort())
    const { bytes: envelope } = signManifest({ manifestBytes: bytes, registry, privateKeyPem: original.privateKeyPem, now: publishedAt })
    expect(checkOriginalKeySignature({ manifestBytes: bytes, envelope, registry, newTag: tag, originalKey: entry(original) }))
      .toEqual({ originalKeySignature: 'passed' })
  })

  it('is accepted by the current v1 and v2 readers, whether they hold the original key alone or both', () => {
    const original = makeEphemeralKeypair()
    const registry = asReleased(original)
    const v2 = generateManifestV2({ registry, evidence: buildEvidence(), minimumMacosVersion, publishedAt, kind: 'universal' })
    const v1 = projectV1(v2.bytes)
    expect(v1.manifest.trustedKeyIds).toEqual([original.keyId, BACKUP_KEY_ID].sort())
    const sign = (bytes: Buffer) => signManifest({ manifestBytes: bytes, registry, privateKeyPem: original.privateKeyPem, now: publishedAt }).bytes
    for (const trusted of [makeRegistry(original), registry]) {
      expect(verifyManifest({ manifestBytes: v1.bytes, envelope: sign(v1.bytes), registry: trusted, now: publishedAt }).trustedKeyIds)
        .toEqual(v1.manifest.trustedKeyIds)
      expect(verifyManifestV2({ manifestBytes: v2.bytes, envelope: sign(v2.bytes), registry: trusted, now: publishedAt }).trustedKeyIds)
        .toEqual(v2.manifest.trustedKeyIds)
    }
  })

  // The emergency procedure in docs/macos-release.md: the original key is lost, so 1.7.1
  // switches signingKeyId to the backup key, which 1.7.0 already trusts.
  it('lets an emergency release sign with the backup key under the exact override, which every later release needs too', () => {
    const original = makeEphemeralKeypair()
    const backup = makeEphemeralKeypair()
    const released = makeRegistry(original, backup)
    const emergency: UpdateRegistry = { ...released, signingKeyId: backup.keyId }
    const originalKey = entry(original)
    const override = (releaseTag: string) => `ALLOW-UPDATE-KEY-ROTATION:${releaseTag}:${backup.keyId}`
    const v170 = publishUniversal('1.7.0', original, released, '2026-11-16T12:00:00Z')
    const plan = planReleaseHistory({ releases: [v170.listing], newTag: 'v1.7.1', kind: 'universal' })
    const continueFrom = (manifest: 'v1' | 'v2', registry: UpdateRegistry) => authorizeReleaseHistory({
      plan: plan[manifest],
      priorManifestBytes: v170[manifest]!.bytes,
      priorSignatureBytes: v170[manifest]!.signature,
      registry,
      newTag: 'v1.7.1',
    })
    // 1.7.0's manifests already trust the backup key, so the history needs no override...
    expect(continueFrom('v1', emergency)).toMatchObject({ authorized: true, rotationOverrideUsed: false })
    expect(continueFrom('v2', emergency)).toMatchObject({ authorized: true, rotationOverrideUsed: false })
    // ...but only while the registry still lists the original key, which alone signed them.
    expect(() => continueFrom('v1', makeRegistry(backup))).toThrow(/signature verification failed/)
    // G10: only the exact override for this release lets the backup key sign v1, and the next
    // release the backup key signs needs its own.
    expect(() => planOriginalKeySignature({ registry: emergency, newTag: 'v1.7.1', originalKey })).toThrow(override('v1.7.1'))
    expect(planOriginalKeySignature({ registry: emergency, newTag: 'v1.7.1', rotationOverride: override('v1.7.1'), originalKey }))
      .toEqual({ originalKeySignature: 'waived', rotationOverride: override('v1.7.1') })
    expect(() => planOriginalKeySignature({ registry: emergency, newTag: 'v1.7.2', rotationOverride: override('v1.7.1'), originalKey }))
      .toThrow(override('v1.7.2'))
    // One signature, by the backup key: apps that trust it accept the manifest, apps that
    // trust only the original key (1.2 to 1.6) cannot verify it.
    const { bytes } = generateManifest({ registry: emergency, evidence: buildEvidence({ tag: 'v1.7.1' }), minimumMacosVersion, publishedAt })
    const { envelope, bytes: signature } = signManifest({ manifestBytes: bytes, registry: emergency, privateKeyPem: backup.privateKeyPem, now: publishedAt })
    expect(envelope.signatures.map((signed) => signed.keyId)).toEqual([backup.keyId])
    expect(checkOriginalKeySignature({ manifestBytes: bytes, envelope: signature, registry: emergency, newTag: 'v1.7.1', rotationOverride: override('v1.7.1'), originalKey }))
      .toMatchObject({ originalKeySignature: 'waived' })
    expect(verifyManifest({ manifestBytes: bytes, envelope: signature, registry: released }).tag).toBe('v1.7.1')
    expect(() => verifyManifest({ manifestBytes: bytes, envelope: signature, registry: makeRegistry(original) })).toThrow(/signature verification failed/)
    // If the original key was compromised, the release after the emergency one can drop it,
    // because the backup key alone signed the emergency release.
    const v171 = publishUniversal('1.7.1', backup, emergency, '2026-11-20T12:00:00Z')
    const next = planReleaseHistory({ releases: [v170.listing, v171.listing], newTag: 'v1.7.2', kind: 'universal' })
    for (const manifest of ['v1', 'v2'] as const) {
      expect(authorizeReleaseHistory({
        plan: next[manifest],
        priorManifestBytes: v171[manifest]!.bytes,
        priorSignatureBytes: v171[manifest]!.signature,
        registry: makeRegistry(backup),
        newTag: 'v1.7.2',
      })).toMatchObject({ authorized: true, rotationOverrideUsed: false })
    }
  })
})
