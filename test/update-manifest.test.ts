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
  planReleaseHistoryContinuity,
  authorizeReleaseContinuity,
} from '../scripts/update-manifest.mjs'
import type {
  ReleaseEvidence,
  ReleaseAssetEvidence,
  ReleaseLike,
  ReleaseAssetLike,
} from '../scripts/update-manifest.d.mts'

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
} = updateManifestRuntime

const root = resolve(process.cwd())

// --- Production registry constants supplied by the issue (public only). ---
const PROD_KEY_ID = 'ed25519-99927ba2f6af6482'
const PROD_PUBLIC_KEY_SPKI_BASE64 = 'MCowBQYDK2VwAyEAshsgCvPUphCyxSv/sgvDCBvdde/Ws+CU0Fgdl62SU/k='

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
  it('parses and validates with the exact documented schema/keyId/algorithm/publicKey', () => {
    const raw = readFileSync(join(root, 'release', 'update-keys.json'), 'utf8')
    const registry = parseRegistry(raw)
    expect(registry.schema).toBe(UPDATE_REGISTRY_SCHEMA)
    expect(registry.signingKeyId).toBe(PROD_KEY_ID)
    expect(registry.keys).toHaveLength(1)
    expect(registry.keys[0]).toEqual({
      keyId: PROD_KEY_ID,
      algorithm: 'ed25519',
      publicKeySpkiBase64: PROD_PUBLIC_KEY_SPKI_BASE64,
    })
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

describe('planReleaseHistoryContinuity', () => {
  it('bootstraps when there are no prior releases at all', () => {
    const plan = planReleaseHistoryContinuity({ releases: [], newTag: 'v1.0.0' })
    expect(plan).toEqual({ mode: 'bootstrap', priorTag: null })
  })

  it('bootstraps when no prior published release carries either asset', () => {
    const releases = [
      githubRelease({ tag_name: 'v0.9.0' }),
      githubRelease({ tag_name: 'v0.8.0' }),
    ]
    const plan = planReleaseHistoryContinuity({ releases, newTag: 'v1.0.0' })
    expect(plan).toEqual({ mode: 'bootstrap', priorTag: null })
  })

  it('rejects a release carrying only one of the manifest/signature asset pair', () => {
    const releases = [
      githubRelease({ tag_name: 'v0.9.0', assets: [releaseAsset(1, MANIFEST_ASSET_NAME, 'v0.9.0')] }),
    ]
    expect(() => planReleaseHistoryContinuity({ releases, newTag: 'v1.0.0' })).toThrow(UpdateManifestError)
  })

  it('rejects a prior qualifying stable release with a version >= the new tag', () => {
    const releases = [githubRelease({ tag_name: 'v1.0.0' })]
    expect(() => planReleaseHistoryContinuity({ releases, newTag: 'v1.0.0' })).toThrow(UpdateManifestError)
    const releasesGreater = [githubRelease({ tag_name: 'v1.1.0' })]
    expect(() => planReleaseHistoryContinuity({ releases: releasesGreater, newTag: 'v1.0.0' })).toThrow(UpdateManifestError)
  })

  it('ignores draft and prerelease releases when checking for a blocking prior version', () => {
    const releases = [
      githubRelease({ tag_name: 'v5.0.0', draft: true }),
      githubRelease({ tag_name: 'v5.0.0', prerelease: true }),
    ]
    expect(() => planReleaseHistoryContinuity({ releases, newTag: 'v1.0.0' })).not.toThrow()
  })

  it('requires the latest previous stable release to carry both assets, even if an older one has them', () => {
    const releases = [
      githubRelease({
        tag_name: 'v0.8.0',
        assets: [releaseAsset(1, MANIFEST_ASSET_NAME, 'v0.8.0'), releaseAsset(2, SIGNATURE_ASSET_NAME, 'v0.8.0')],
      }),
      githubRelease({ tag_name: 'v0.9.0' }), // latest previous stable release — missing both assets
    ]
    expect(() => planReleaseHistoryContinuity({ releases, newTag: 'v1.0.0' })).toThrow(UpdateManifestError)
  })

  it('returns a continuity plan with asset ids/metadata when the latest previous stable release has both', () => {
    const releases = [
      githubRelease({ tag_name: 'v0.8.0' }),
      githubRelease({
        tag_name: 'v0.9.0',
        assets: [releaseAsset(10, MANIFEST_ASSET_NAME, 'v0.9.0'), releaseAsset(11, SIGNATURE_ASSET_NAME, 'v0.9.0')],
      }),
    ]
    const plan = planReleaseHistoryContinuity({ releases, newTag: 'v1.0.0' })
    expect(plan.mode).toBe('continuity')
    expect(plan.priorTag).toBe('v0.9.0')
    if (plan.mode !== 'continuity') throw new Error('expected continuity plan')
    expect(plan.manifestAsset.id).toBe(10)
    expect(plan.signatureAsset.id).toBe(11)
    expect(plan.manifestAsset.name).toBe(MANIFEST_ASSET_NAME)
    expect(plan.signatureAsset.name).toBe(SIGNATURE_ASSET_NAME)
  })

  it('rejects a leading-zero numeric identifier in newTag', () => {
    expect(() => planReleaseHistoryContinuity({ releases: [], newTag: 'v01.0.0' })).toThrow(UpdateManifestError)
  })

  it('compares arbitrarily large numeric identifiers exactly, without Number precision loss', () => {
    // 2**53 and 2**53 + 1 are not distinguishable as IEEE-754 doubles, so a
    // `Number.parseInt`-based comparison would treat these two tags as equal
    // (or compare them incorrectly) instead of correctly ordering them.
    const huge = '9007199254740992' // 2**53
    const hugePlusOne = '9007199254740993' // 2**53 + 1, > Number.MAX_SAFE_INTEGER
    const releases = [githubRelease({ tag_name: `v${huge}.0.0` })]
    // huge.0.0 is older than (huge+1).0.0 — must bootstrap-block-free (no throw).
    expect(() => planReleaseHistoryContinuity({ releases, newTag: `v${hugePlusOne}.0.0` })).not.toThrow()
    // huge.0.0 is NOT older than itself — must be rejected as not-older.
    expect(() => planReleaseHistoryContinuity({ releases, newTag: `v${huge}.0.0` })).toThrow(UpdateManifestError)
    // (huge+1).0.0 prior release compared against huge.0.0 new tag: prior is
    // newer than new, must be rejected.
    const releasesNewer = [githubRelease({ tag_name: `v${hugePlusOne}.0.0` })]
    expect(() => planReleaseHistoryContinuity({ releases: releasesNewer, newTag: `v${huge}.0.0` })).toThrow(UpdateManifestError)
  })

  it('fails closed on a malformed release record instead of silently ignoring it as non-stable', () => {
    expect(() => planReleaseHistoryContinuity({ releases: [null as unknown as ReleaseLike], newTag: 'v1.0.0' })).toThrow(UpdateManifestError)
    expect(() => planReleaseHistoryContinuity({ releases: ['not-an-object' as unknown as ReleaseLike], newTag: 'v1.0.0' })).toThrow(UpdateManifestError)
    expect(() => planReleaseHistoryContinuity({
      releases: [{ tag_name: 'v0.9.0', draft: false, prerelease: false } as unknown as ReleaseLike], // missing assets
      newTag: 'v1.0.0',
    })).toThrow(UpdateManifestError)
    expect(() => planReleaseHistoryContinuity({
      releases: [{ tag_name: 'v0.9.0', draft: 'false' as unknown as boolean, prerelease: false, assets: [] }], // draft not boolean
      newTag: 'v1.0.0',
    })).toThrow(UpdateManifestError)
    expect(() => planReleaseHistoryContinuity({
      releases: [{ tag_name: '', draft: false, prerelease: false, assets: [] }], // empty tag_name
      newTag: 'v1.0.0',
    })).toThrow(UpdateManifestError)
  })

  it('permits a proven-shaped but unrelated non-stable-tag release to be ignored', () => {
    const releases = [
      { tag_name: 'nightly-build', draft: false, prerelease: false, assets: [] },
      { tag_name: 'v2.0.0', draft: false, prerelease: true, assets: [] },
    ]
    expect(() => planReleaseHistoryContinuity({ releases, newTag: 'v1.0.0' })).not.toThrow()
  })

  it('rejects a stable published release with a duplicate asset name', () => {
    const dup = releaseAsset(1, MANIFEST_ASSET_NAME, 'v0.9.0')
    const releases = [githubRelease({ tag_name: 'v0.9.0', assets: [dup, { ...dup, id: 2 }] })]
    expect(() => planReleaseHistoryContinuity({ releases, newTag: 'v1.0.0' })).toThrow(UpdateManifestError)
  })

  it('rejects a stable published release asset with a non-positive or non-integer id/size', () => {
    const base = releaseAsset(1, MANIFEST_ASSET_NAME, 'v0.9.0')
    expect(() => planReleaseHistoryContinuity({
      releases: [githubRelease({ tag_name: 'v0.9.0', assets: [{ ...base, id: 0 }] })],
      newTag: 'v1.0.0',
    })).toThrow(UpdateManifestError)
    expect(() => planReleaseHistoryContinuity({
      releases: [githubRelease({ tag_name: 'v0.9.0', assets: [{ ...base, id: 1.5 }] })],
      newTag: 'v1.0.0',
    })).toThrow(UpdateManifestError)
    expect(() => planReleaseHistoryContinuity({
      releases: [githubRelease({ tag_name: 'v0.9.0', assets: [{ ...base, size: -1 }] })],
      newTag: 'v1.0.0',
    })).toThrow(UpdateManifestError)
  })

  it('rejects a stable published release asset with a non-canonical browser_download_url', () => {
    const base = releaseAsset(1, MANIFEST_ASSET_NAME, 'v0.9.0')
    for (const badUrl of [
      base.browser_download_url.replace('https://', 'http://'),
      base.browser_download_url.replace('github.com', 'evil.example.com'),
      `${base.browser_download_url}?x=1`,
      `${base.browser_download_url}#frag`,
      base.browser_download_url.replace('v0.9.0', 'v0.8.0'), // wrong tag in path
      'https://user:pass@github.com/shariqh/agent-inbox/releases/download/v0.9.0/update-manifest.json',
    ]) {
      expect(() => planReleaseHistoryContinuity({
        releases: [githubRelease({ tag_name: 'v0.9.0', assets: [{ ...base, browser_download_url: badUrl }] })],
        newTag: 'v1.0.0',
      })).toThrow(UpdateManifestError)
    }
  })

  it('rejects a malformed nonempty digest field but accepts an exact sha256:<64 lowercase hex>', () => {
    const base = releaseAsset(1, MANIFEST_ASSET_NAME, 'v0.9.0')
    const sig = releaseAsset(2, SIGNATURE_ASSET_NAME, 'v0.9.0')
    const validDigest = `sha256:${'a1b2c3d4'.repeat(8)}`
    const malformedDigests = [
      'sha256:abc123', // too short, not 64 hex chars
      `sha256:${'A1B2C3D4'.repeat(8)}`, // uppercase hex is not accepted
      `md5:${'a1b2c3d4'.repeat(8)}`, // wrong algorithm prefix
      'a1b2c3d4'.repeat(8), // missing "sha256:" prefix entirely
      `sha256:${'g1b2c3d4'.repeat(8)}`, // non-hex character
    ]
    for (const digest of malformedDigests) {
      expect(() => planReleaseHistoryContinuity({
        releases: [githubRelease({ tag_name: 'v0.9.0', assets: [{ ...base, digest }, sig] })],
        newTag: 'v1.0.0',
      })).toThrow(UpdateManifestError)
    }
    expect(() => planReleaseHistoryContinuity({
      releases: [githubRelease({ tag_name: 'v0.9.0', assets: [{ ...base, digest: validDigest }, sig] })],
      newTag: 'v1.0.0',
    })).not.toThrow()
  })

  it('treats a missing, null, or empty-string digest as "unavailable" rather than malformed', () => {
    const base = releaseAsset(1, MANIFEST_ASSET_NAME, 'v0.9.0')
    const sig = releaseAsset(2, SIGNATURE_ASSET_NAME, 'v0.9.0')
    // `undefined` (field omitted entirely)
    expect(() => planReleaseHistoryContinuity({
      releases: [githubRelease({ tag_name: 'v0.9.0', assets: [base, sig] })],
      newTag: 'v1.0.0',
    })).not.toThrow()
    // GitHub's REST API reports `digest: null` when unavailable.
    expect(() => planReleaseHistoryContinuity({
      releases: [githubRelease({ tag_name: 'v0.9.0', assets: [{ ...base, digest: null }, sig] })],
      newTag: 'v1.0.0',
    })).not.toThrow()
    // Matches existing publisher behavior of reporting an empty string.
    expect(() => planReleaseHistoryContinuity({
      releases: [githubRelease({ tag_name: 'v0.9.0', assets: [{ ...base, digest: '' }, sig] })],
      newTag: 'v1.0.0',
    })).not.toThrow()
  })

  it('propagates a valid asset digest into the continuity plan, and omits it when unavailable (undefined, null, or empty string)', () => {
    const validDigest = `sha256:${'a1b2c3d4'.repeat(8)}`
    const withDigest = planReleaseHistoryContinuity({
      releases: [githubRelease({
        tag_name: 'v0.9.0',
        assets: [
          { ...releaseAsset(1, MANIFEST_ASSET_NAME, 'v0.9.0'), digest: validDigest },
          releaseAsset(2, SIGNATURE_ASSET_NAME, 'v0.9.0'),
        ],
      })],
      newTag: 'v1.0.0',
    })
    if (withDigest.mode !== 'continuity') throw new Error('expected continuity plan')
    expect(withDigest.manifestAsset.digest).toBe(validDigest)
    expect(withDigest.signatureAsset).not.toHaveProperty('digest')

    const withoutDigest = planReleaseHistoryContinuity({
      releases: [githubRelease({
        tag_name: 'v0.9.0',
        assets: [releaseAsset(1, MANIFEST_ASSET_NAME, 'v0.9.0'), releaseAsset(2, SIGNATURE_ASSET_NAME, 'v0.9.0')],
      })],
      newTag: 'v1.0.0',
    })
    if (withoutDigest.mode !== 'continuity') throw new Error('expected continuity plan')
    expect(withoutDigest.manifestAsset).not.toHaveProperty('digest')
    expect(withoutDigest.signatureAsset).not.toHaveProperty('digest')

    for (const unavailable of [null, '']) {
      const plan = planReleaseHistoryContinuity({
        releases: [githubRelease({
          tag_name: 'v0.9.0',
          assets: [
            { ...releaseAsset(1, MANIFEST_ASSET_NAME, 'v0.9.0'), digest: unavailable },
            releaseAsset(2, SIGNATURE_ASSET_NAME, 'v0.9.0'),
          ],
        })],
        newTag: 'v1.0.0',
      })
      if (plan.mode !== 'continuity') throw new Error('expected continuity plan')
      expect(plan.manifestAsset).not.toHaveProperty('digest')
      expect(plan.signatureAsset).not.toHaveProperty('digest')
    }
  })

  it('rejects duplicate stable release tags across the release list', () => {
    const releases = [
      githubRelease({ tag_name: 'v0.9.0' }),
      githubRelease({ tag_name: 'v0.9.0' }),
    ]
    expect(() => planReleaseHistoryContinuity({ releases, newTag: 'v1.0.0' })).toThrow(UpdateManifestError)
  })
})

describe('authorizeReleaseContinuity', () => {
  function priorRelease(
    keypair: ReturnType<typeof makeEphemeralKeypair>,
    registry: UpdateRegistry,
    priorTag = 'v0.9.0',
  ) {
    const priorEvidence = buildEvidence({ tag: priorTag, packageVersion: priorTag.slice(1) })
    const { bytes: manifestBytes } = generateManifest({
      registry,
      evidence: priorEvidence,
      minimumMacosVersion,
      publishedAt,
    })
    const { bytes: signatureBytes } = signManifest({ manifestBytes, registry, privateKeyPem: keypair.privateKeyPem, now: publishedAt })
    return { manifestBytes, signatureBytes }
  }

  it('authorizes continuity when the current signing key is already trusted by the prior manifest', () => {
    const good = makeEphemeralKeypair()
    const registry = makeRegistry(good)
    const { manifestBytes, signatureBytes } = priorRelease(good, registry)
    const result = authorizeReleaseContinuity({
      priorManifestBytes: manifestBytes,
      priorSignatureBytes: signatureBytes,
      registry,
      newTag: 'v1.0.0',
    })
    expect(result.authorized).toBe(true)
    expect(result.rotationOverrideUsed).toBe(false)
    expect(result.priorTag).toBe('v0.9.0')
  })

  it('refuses continuity when the new signing key is not trusted by the prior manifest and no override is given', () => {
    const oldKey = makeEphemeralKeypair()
    const oldRegistry = makeRegistry(oldKey)
    const { manifestBytes, signatureBytes } = priorRelease(oldKey, oldRegistry)

    const newKey = makeEphemeralKeypair()
    const newRegistry = makeRegistry(newKey) // does not include oldKey — the prior manifest can't be re-verified either
    expect(() => authorizeReleaseContinuity({
      priorManifestBytes: manifestBytes,
      priorSignatureBytes: signatureBytes,
      registry: newRegistry,
      newTag: 'v1.0.0',
    })).toThrow(UpdateManifestError)
  })

  it('refuses rotation when new key is untrusted by prior manifest even though prior signature still verifies (registry retains old key)', () => {
    const oldKey = makeEphemeralKeypair()
    const rotatingRegistry = makeRegistry(oldKey)
    const { manifestBytes, signatureBytes } = priorRelease(oldKey, rotatingRegistry)

    const newKey = makeEphemeralKeypair()
    // Registry now signs with newKey but still lists oldKey so the prior signature verifies.
    const registryAfterRotation: UpdateRegistry = {
      schema: 1,
      signingKeyId: newKey.keyId,
      keys: [
        { keyId: oldKey.keyId, algorithm: 'ed25519', publicKeySpkiBase64: oldKey.publicKeySpkiBase64 },
        { keyId: newKey.keyId, algorithm: 'ed25519', publicKeySpkiBase64: newKey.publicKeySpkiBase64 },
      ],
    }
    expect(() => authorizeReleaseContinuity({
      priorManifestBytes: manifestBytes,
      priorSignatureBytes: signatureBytes,
      registry: registryAfterRotation,
      newTag: 'v1.0.0',
    })).toThrow(UpdateManifestError)
  })

  it('permits rotation with the exact rotationOverride string, and rejects a mismatched one', () => {
    const oldKey = makeEphemeralKeypair()
    const rotatingRegistry = makeRegistry(oldKey)
    const { manifestBytes, signatureBytes } = priorRelease(oldKey, rotatingRegistry)

    const newKey = makeEphemeralKeypair()
    const registryAfterRotation: UpdateRegistry = {
      schema: 1,
      signingKeyId: newKey.keyId,
      keys: [
        { keyId: oldKey.keyId, algorithm: 'ed25519', publicKeySpkiBase64: oldKey.publicKeySpkiBase64 },
        { keyId: newKey.keyId, algorithm: 'ed25519', publicKeySpkiBase64: newKey.publicKeySpkiBase64 },
      ],
    }
    const wrongOverride = `ALLOW-UPDATE-KEY-ROTATION:v1.0.0:${oldKey.keyId}` // wrong key id
    expect(() => authorizeReleaseContinuity({
      priorManifestBytes: manifestBytes,
      priorSignatureBytes: signatureBytes,
      registry: registryAfterRotation,
      newTag: 'v1.0.0',
      rotationOverride: wrongOverride,
    })).toThrow(UpdateManifestError)

    const correctOverride = `ALLOW-UPDATE-KEY-ROTATION:v1.0.0:${newKey.keyId}`
    const result = authorizeReleaseContinuity({
      priorManifestBytes: manifestBytes,
      priorSignatureBytes: signatureBytes,
      registry: registryAfterRotation,
      newTag: 'v1.0.0',
      rotationOverride: correctOverride,
    })
    expect(result.authorized).toBe(true)
    expect(result.rotationOverrideUsed).toBe(true)
  })

  it('verifies prior signature/structure without applying current expiry (long-expired prior manifest still authorizes)', () => {
    const good = makeEphemeralKeypair()
    const registry = makeRegistry(good)
    const longAgo = '2000-01-01T00:00:00Z'
    const priorEvidence = buildEvidence({ tag: 'v0.9.0', packageVersion: '0.9.0' })
    const { bytes: manifestBytes } = generateManifest({
      registry,
      evidence: priorEvidence,
      minimumMacosVersion,
      publishedAt: longAgo,
    })
    const { bytes: signatureBytes } = signManifest({ manifestBytes, registry, privateKeyPem: good.privateKeyPem, now: longAgo })
    // This manifest's expiresAt was 180 days after year 2000 — long expired relative to "now" — yet authorization succeeds.
    const result = authorizeReleaseContinuity({
      priorManifestBytes: manifestBytes,
      priorSignatureBytes: signatureBytes,
      registry,
      newTag: 'v1.0.0',
    })
    expect(result.authorized).toBe(true)
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
