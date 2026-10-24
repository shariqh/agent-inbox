// test/shipped-updaters.test.ts — the updater code that installed apps already run (#340).
//
// Every app from 1.2.0 to 1.6.x reads update-manifest.json for good, with the reader it
// shipped, and that code can never change. test/fixtures/shipped-updaters/ holds it byte
// for byte: v1.2.8/ is what 1.2.0 to 1.2.8 shipped and v1.6.0/ what 1.3.0 to 1.6.0 shipped.
// update-fetch.cjs changed once, at 1.3.0 (the rollback mark and the verified download);
// update-manifest.cjs has not changed since 1.2.0. Each update-fetch.cjs requires
// ./update-manifest.cjs, so each folder keeps its own copy. v1.6.0/update-preferences.cjs
// holds the trust-state writer (#148), unchanged since 1.3.0: 1.6.0 only added exports.
//
// CI checks out without tags, so this file reads the fixtures and never runs `git show`.
// Never edit, reformat or regenerate a fixture: the hashes below are those of the tags'
// own files. The update manifest v2 (#295, #343) must keep every test here passing.
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  deriveKeyId,
  generateManifest,
  generateManifestV2,
  projectV1,
  restampV1,
  serializeEnvelope,
  signManifest,
} from '../scripts/update-manifest.mjs'
import type { ReleaseAssetEvidence, ReleaseLike } from '../scripts/update-manifest.d.mts'
import { removeScratchDirs, scratchDir } from './scratch.js'

const FIXTURES = resolve(import.meta.dirname, 'fixtures', 'shipped-updaters')

const SHIPPED = [
  // update-manifest.cjs: the same bytes in all 16 tags from v1.2.0 to v1.6.0.
  { file: 'v1.2.8/update-manifest.cjs', sha256: '5ce1d6758bc934907f2b5c4039d4744fb1d923a5e9a84fa69cfdddfacf91e5c3' },
  { file: 'v1.6.0/update-manifest.cjs', sha256: '5ce1d6758bc934907f2b5c4039d4744fb1d923a5e9a84fa69cfdddfacf91e5c3' },
  // update-fetch.cjs: v1.2.0 to v1.2.8, then v1.3.0 to v1.6.0.
  { file: 'v1.2.8/update-fetch.cjs', sha256: 'd31aeadc960151e1a9086862c8a3a1d462e6ceb953f354e355f67b44ba96c66f' },
  { file: 'v1.6.0/update-fetch.cjs', sha256: '85d1195bfe5435dd81d4ad5aa3b6e2e67e6227aac1622985e9781198ddcb52e8' },
  // update-preferences.cjs as v1.6.0 shipped it.
  { file: 'v1.6.0/update-preferences.cjs', sha256: '5d0edf706a924b6449e89817d8c792dc2942c54638fd84600f80a4b1d1c585c2' },
] as const

interface ShippedTarget {
  platform: string
  architecture: string
  packageType: string
  filename: string
  url: string
  byteLength: number
  sha256: string
  installStrategy: string
  minimumSystemVersion?: string
}

interface ShippedCheckResult {
  status: string
  available?: { version: string; tag: string; releaseUrl: string; target: { packageType: string; installStrategy: string } }
  artifact?: ShippedTarget & { version: string; tag: string }
}

interface ShippedFetch {
  MANIFEST_URL: string
  SIGNATURE_URL: string
  checkForUpdate(options: Record<string, unknown>): Promise<ShippedCheckResult>
}

interface ShippedManifestModule {
  verifyManifest(options: { manifestBytes: Buffer; envelope: Buffer; registry: unknown; now: Date }): {
    trustedKeyIds: readonly string[]
    targets: readonly ShippedTarget[]
  }
}

interface ShippedTrustState {
  read(): Promise<{ highestVerifiedVersion: string | null }>
  recordVerifiedVersion(version: string): Promise<{ highestVerifiedVersion: string | null }>
}

const require = createRequire(import.meta.url)
const fixture = (file: string) => join(FIXTURES, file)

// Each reader with its own update-manifest.cjs. `options` is what that version's main.cjs
// adds to the host facts below; fetch, the registry and the clock are injected here.
const READERS = [
  {
    name: '1.2.0 to 1.2.8',
    currentVersion: '1.2.8',
    module: require(fixture('v1.2.8/update-fetch.cjs')) as ShippedFetch,
    manifest: require(fixture('v1.2.8/update-manifest.cjs')) as ShippedManifestModule,
    options: {},
  },
  {
    name: '1.3.0 to 1.6.0',
    currentVersion: '1.6.0',
    module: require(fixture('v1.6.0/update-fetch.cjs')) as ShippedFetch,
    manifest: require(fixture('v1.6.0/update-manifest.cjs')) as ShippedManifestModule,
    options: { includeArtifact: true },
  },
] as const

const shippedPreferences = require(fixture('v1.6.0/update-preferences.cjs')) as {
  createUpdateTrustState(options: { filePath: string }): ShippedTrustState
}

// A scratch key: the production key never signs anything in tests.
const scratchKey = generateKeyPairSync('ed25519')
const publicKeySpkiBase64 = scratchKey.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
const keyId = deriveKeyId(publicKeySpkiBase64)
const registry = {
  schema: 1 as const,
  signingKeyId: keyId,
  keys: [{ keyId, algorithm: 'ed25519' as const, publicKeySpkiBase64 }],
}

const VERSION = '1.7.0'
const TAG = `v${VERSION}`
const TAGGED_AT = '2026-11-16T12:00:00Z'
const NOW = new Date('2026-11-17T09:30:00Z')
const DOWNLOAD = `https://github.com/shariqh/agent-inbox/releases/download/${TAG}`

// The five packages in the shape release aggregation hands generateManifest.
const PACKAGES: readonly ReleaseAssetEvidence[] = [
  { name: `Agent-Inbox-${TAG}-universal.dmg`, packageType: 'dmg', platform: 'darwin', architecture: 'universal', size: 338_700_001, sha256: '1'.repeat(64) },
  { name: `Agent-Inbox-v${VERSION}-linux-arm64.AppImage`, packageType: 'appimage', platform: 'linux', architecture: 'arm64', size: 167_500_002, sha256: '2'.repeat(64) },
  { name: `agent-inbox_${VERSION}_arm64.deb`, packageType: 'deb', platform: 'linux', architecture: 'arm64', size: 121_100_003, sha256: '3'.repeat(64) },
  { name: `Agent-Inbox-v${VERSION}-linux-x86_64.AppImage`, packageType: 'appimage', platform: 'linux', architecture: 'x64', size: 168_700_004, sha256: '4'.repeat(64) },
  { name: `agent-inbox_${VERSION}_amd64.deb`, packageType: 'deb', platform: 'linux', architecture: 'x64', size: 127_900_005, sha256: '5'.repeat(64) },
]

const STRATEGY = { dmg: 'macos-dmg', appimage: 'appimage-self-replace', deb: 'deb-notify' } as const

/** Today's publisher: generateManifest and signManifest, exactly as the release uses them. */
function publish() {
  const { manifest, bytes } = generateManifest({
    registry,
    evidence: {
      tag: TAG,
      packageVersion: VERSION,
      sourceCommit: 'c'.repeat(40),
      sourceTree: 'd'.repeat(40),
      assets: PACKAGES,
    },
    minimumMacosVersion: '13.5',
    publishedAt: TAGGED_AT,
  })
  const signature = signManifest({
    manifestBytes: bytes,
    registry,
    privateKeyPem: scratchKey.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    now: NOW,
  })
  return { manifest, manifestBytes: bytes, signatureBytes: signature.bytes }
}

/** Bytes today's publisher refuses to produce, signed with the scratch key anyway. */
function signRaw(manifest: unknown) {
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const signatureBytes = serializeEnvelope({
    schema: 1,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    signatures: [{
      algorithm: 'ed25519',
      keyId,
      signature: sign(null, manifestBytes, scratchKey.privateKey).toString('base64'),
    }],
  })
  return { manifestBytes, signatureBytes }
}

const appImageMount = '/run/user/1000/.mount_AgentIn0QvTkK'

/** A Linux app running from its AppImage, as the type2-runtime mounts it (#210). */
function appImageHost(image: string) {
  const name = image.slice(image.lastIndexOf('/') + 1)
  return {
    appImagePath: image,
    appDir: appImageMount,
    execPath: `${appImageMount}/usr/lib/agent-inbox/Agent Inbox`,
    appImageProbe: {
      lstat: (target: string) => ({ dev: target === appImageMount ? 62n : 60n, isDirectory: () => true }),
      mountInfo: () => `79 131 0:62 / ${appImageMount} ro,nosuid,nodev,relatime - fuse.${name} ${name} ro,user_id=1000,group_id=1000\n`,
    },
  }
}

// Each host, the options its main.cjs would pass, and the one package it must be offered.
const HOSTS = [
  { name: 'macOS on Apple silicon', options: { platform: 'darwin', arch: 'arm64' }, offered: `Agent-Inbox-${TAG}-universal.dmg` },
  { name: 'macOS on Intel', options: { platform: 'darwin', arch: 'x64' }, offered: `Agent-Inbox-${TAG}-universal.dmg` },
  {
    name: 'Linux x64 AppImage',
    options: { platform: 'linux', arch: 'x64', ...appImageHost('/home/tester/Applications/Agent-Inbox-v1.6.0-linux-x86_64.AppImage') },
    offered: `Agent-Inbox-v${VERSION}-linux-x86_64.AppImage`,
  },
  { name: 'Linux x64 DEB', options: { platform: 'linux', arch: 'x64' }, offered: `agent-inbox_${VERSION}_amd64.deb` },
  {
    name: 'Linux arm64 AppImage',
    options: { platform: 'linux', arch: 'arm64', ...appImageHost('/home/tester/Applications/Agent-Inbox-v1.6.0-linux-arm64.AppImage') },
    offered: `Agent-Inbox-v${VERSION}-linux-arm64.AppImage`,
  },
  { name: 'Linux arm64 DEB', options: { platform: 'linux', arch: 'arm64' }, offered: `agent-inbox_${VERSION}_arm64.deb` },
] as const

/** Run one shipped reader on one host against the files `latest` serves; nothing else answers. */
async function check(
  reader: (typeof READERS)[number],
  host: (typeof HOSTS)[number],
  served: { manifestBytes: Buffer; signatureBytes: Buffer },
  trusted: unknown = registry,
) {
  const requested: string[] = []
  const fetchImpl = async (url: string) => {
    requested.push(url)
    if (url === reader.module.MANIFEST_URL) return new Response(served.manifestBytes as BodyInit)
    if (url === reader.module.SIGNATURE_URL) return new Response(served.signatureBytes as BodyInit)
    throw new Error(`no network here: ${url}`)
  }
  try {
    return await reader.module.checkForUpdate({
      fetchImpl,
      registry: trusted,
      currentVersion: reader.currentVersion,
      automaticChecks: true,
      isPackaged: true,
      now: () => NOW,
      ...reader.options,
      ...host.options,
    })
  } finally {
    expect(requested).toEqual([reader.module.MANIFEST_URL, reader.module.SIGNATURE_URL])
  }
}

afterEach(removeScratchDirs)

describe('the shipped updater fixtures', () => {
  it.each(SHIPPED)('$file is byte-identical to the shipped file', ({ file, sha256 }) => {
    expect(createHash('sha256').update(readFileSync(fixture(file))).digest('hex')).toBe(sha256)
  })

  it('holds exactly the pinned files', () => {
    const files = readdirSync(FIXTURES, { recursive: true, withFileTypes: true })
      .filter((entry) => !entry.isDirectory())
      .map((entry) => relative(FIXTURES, join(entry.parentPath, entry.name)).split('\\').join('/'))
      .sort()
    expect(files).toEqual(SHIPPED.map(({ file }) => file).sort())
  })

  it('load in plain Node, from their own folders and Node built-ins only', () => {
    const files = SHIPPED.map(({ file }) => realpathSync(fixture(file)))
    const { NODE_OPTIONS: _ignored, ...env } = process.env
    const loaded = spawnSync(process.execPath, [
      '-e',
      `const exported = process.argv.slice(1).map((file) => Object.keys(require(file)).sort())
       process.stdout.write(JSON.stringify({ exported, cache: Object.keys(require.cache).sort() }))`,
      ...files,
    ], { encoding: 'utf8', env })
    expect(loaded.stderr).toBe('')
    expect(loaded.status).toBe(0)
    const { exported, cache } = JSON.parse(loaded.stdout) as { exported: string[][]; cache: string[] }
    expect(cache).toEqual([...files].sort())
    expect(exported).toEqual([
      expect.arrayContaining(['TARGET_SPECS', 'verifyManifest']),
      expect.arrayContaining(['TARGET_SPECS', 'verifyManifest']),
      ['MANIFEST_URL', 'SIGNATURE_URL', 'checkForUpdate'],
      ['MANIFEST_URL', 'SIGNATURE_URL', 'checkForUpdate', 'runsFromAppImage'],
      ['createLockedFile', 'createUpdatePreferences', 'createUpdateTrustState', 'resolveFilePath'],
    ])
  })

  it.each(READERS)('$name fetch exactly the latest release\'s update-manifest.json pair', ({ module }) => {
    expect(module.MANIFEST_URL).toBe('https://github.com/shariqh/agent-inbox/releases/latest/download/update-manifest.json')
    expect(module.SIGNATURE_URL).toBe('https://github.com/shariqh/agent-inbox/releases/latest/download/update-manifest.json.sig')
  })
})

describe("the shipped readers accept today's publisher output", () => {
  const release = publish()

  it.each(READERS)('$name verify it and offer the universal DMG on macOS, whatever the CPU', async (reader) => {
    // The v1 schema admits exactly one DMG, so the DMG a reader offers is this one.
    const verified = reader.manifest.verifyManifest({
      manifestBytes: release.manifestBytes,
      envelope: release.signatureBytes,
      registry,
      now: NOW,
    })
    expect(verified.targets.filter(({ packageType }) => packageType === 'dmg').map(({ filename, architecture }) => ({ filename, architecture })))
      .toEqual([{ filename: `Agent-Inbox-${TAG}-universal.dmg`, architecture: 'universal' }])

    for (const host of HOSTS.filter(({ options }) => options.platform === 'darwin')) {
      const result = await check(reader, host, release)
      expect(result.status, host.name).toBe('available')
      expect(result.available, host.name).toEqual({
        version: VERSION,
        tag: TAG,
        releaseUrl: `https://github.com/shariqh/agent-inbox/releases/tag/${TAG}`,
        target: { packageType: 'dmg', installStrategy: 'macos-dmg' },
      })
    }
  })

  // 1.2.x is notify-only and reports just the package type it would offer.
  it.each(READERS)('$name offer each Linux host its own package', async (reader) => {
    for (const host of HOSTS.filter(({ options }) => options.platform === 'linux')) {
      const offered = PACKAGES.find(({ name }) => name === host.offered)!
      const result = await check(reader, host, release)
      expect(result.status, host.name).toBe('available')
      expect(result.available?.target, host.name).toEqual({
        packageType: offered.packageType,
        installStrategy: STRATEGY[offered.packageType],
      })
    }
  })

  // 1.3.0 to 1.6.0 also hand the signed target to the downloader, so they show which
  // file, URL, length and digest they picked.
  it('1.3.0 to 1.6.0 pick each host\'s exact signed file, the universal DMG on both Macs', async () => {
    const reader = READERS[1]
    for (const host of HOSTS) {
      const offered = PACKAGES.find(({ name }) => name === host.offered)!
      const result = await check(reader, host, release)
      expect(result.artifact, host.name).toEqual({
        version: VERSION,
        tag: TAG,
        platform: offered.platform,
        architecture: offered.architecture,
        packageType: offered.packageType,
        filename: offered.name,
        url: `${DOWNLOAD}/${offered.name}`,
        byteLength: offered.size,
        sha256: offered.sha256,
        installStrategy: STRATEGY[offered.packageType],
        ...(offered.packageType === 'dmg' ? { minimumSystemVersion: '13.5' } : {}),
      })
    }
  })
})

describe('the shipped readers reject the whole file for every host', () => {
  const { manifest } = publish()
  const [universalDmg, ...linux] = manifest.targets
  const arm64Dmg = {
    ...universalDmg!,
    architecture: 'arm64',
    filename: `Agent-Inbox-${TAG}-arm64.dmg`,
    url: `${DOWNLOAD}/Agent-Inbox-${TAG}-arm64.dmg`,
  }

  const VARIANTS = [
    {
      name: 'schema 2 (a v2 manifest of a universal release)',
      manifest: { ...manifest, schema: 2 },
      error: 'manifest.schema must be 1',
    },
    {
      name: 'schema 2 (a v2 manifest of an arm64 release)',
      manifest: { ...manifest, schema: 2, targets: [arm64Dmg, ...linux] },
      error: 'manifest.schema must be 1',
    },
    {
      name: 'a sixth target (an arm64 DMG beside the universal one)',
      manifest: { ...manifest, targets: [arm64Dmg, universalDmg, ...linux] },
      error: 'manifest.targets must contain exactly 5 entries',
    },
    {
      name: 'four targets (no macOS package)',
      manifest: { ...manifest, targets: linux },
      error: 'manifest.targets must contain exactly 5 entries',
    },
    {
      name: 'five targets with the macOS one for arm64 only',
      manifest: { ...manifest, targets: [arm64Dmg, ...linux] },
      error: 'manifest.targets[0] has an unrecognized platform/architecture/packageType combination',
    },
  ]

  const cases = READERS.flatMap((reader) => VARIANTS.map((variant) => ({ reader, variant, label: `${reader.name}: ${variant.name}` })))

  it.each(cases)('$label', async ({ reader, variant }) => {
    const served = signRaw(variant.manifest)
    for (const host of HOSTS) {
      await expect(check(reader, host, served), host.name).rejects.toThrow(variant.error)
    }
  })
})

describe('the trust-state writer 1.3.0 to 1.6.0 shipped (#148)', () => {
  it.each([
    ['beside its own mark', { schema: 1, highestVerifiedVersion: '1.6.0', highestVerifiedVersionV2: '2.0.1' }],
    ['when it has no mark yet', { schema: 1, highestVerifiedVersionV2: '2.0.1' }],
  ])('keeps highestVerifiedVersionV2 when it raises highestVerifiedVersion %s', async (_, stored) => {
    const filePath = join(scratchDir('agent-inbox-shipped-trust-'), 'update-trust-state.json')
    writeFileSync(filePath, `${JSON.stringify(stored, null, 2)}\n`)
    const trust = shippedPreferences.createUpdateTrustState({ filePath })

    await expect(trust.recordVerifiedVersion('1.9.0')).resolves.toEqual({ highestVerifiedVersion: '1.9.0' })
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({
      schema: 1,
      highestVerifiedVersion: '1.9.0',
      highestVerifiedVersionV2: '2.0.1',
    })
    await expect(trust.read()).resolves.toEqual({ highestVerifiedVersion: '1.9.0' })
  })
})

// Update manifest v2 (#343): the publisher keeps writing update-manifest.json for these
// readers, as a projection of the v2 manifest in a universal release and as a re-stamp of
// the newest universal release's in an arm64 one. They must accept both, and never take a
// v2 file for theirs.
describe('the shipped readers and the v2 publisher (#343)', () => {
  const evidenceOf = (releaseVersion: string, dmg: 'universal' | 'arm64') => ({
    tag: `v${releaseVersion}`,
    packageVersion: releaseVersion,
    sourceCommit: 'c'.repeat(40),
    sourceTree: 'd'.repeat(40),
    assets: PACKAGES.map((asset) => (asset.packageType === 'dmg'
      ? { ...asset, architecture: dmg, name: `Agent-Inbox-v${releaseVersion}-${dmg}.dmg` }
      : { ...asset, name: asset.name.replaceAll(VERSION, releaseVersion) })),
  })
  const signed = (manifestBytes: Buffer) => {
    const signature = serializeEnvelope({
      schema: 1,
      manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
      signatures: [{ algorithm: 'ed25519', keyId, signature: sign(null, manifestBytes, scratchKey.privateKey).toString('base64') }],
    })
    return { manifestBytes, signatureBytes: signature }
  }
  const v2Of = (releaseVersion: string, dmg: 'universal' | 'arm64', taggedAt: string) => generateManifestV2({
    registry,
    evidence: evidenceOf(releaseVersion, dmg),
    minimumMacosVersion: '13.5',
    publishedAt: taggedAt,
    kind: dmg,
  })

  // One reader on one host at `currentVersion`, with the clock at `now`.
  async function read(
    reader: (typeof READERS)[number],
    host: (typeof HOSTS)[number],
    served: { manifestBytes: Buffer; signatureBytes: Buffer },
    currentVersion: string,
    now: Date,
  ) {
    const fetchImpl = async (url: string) => {
      if (url === reader.module.MANIFEST_URL) return new Response(served.manifestBytes as BodyInit)
      if (url === reader.module.SIGNATURE_URL) return new Response(served.signatureBytes as BodyInit)
      throw new Error(`no network here: ${url}`)
    }
    return reader.module.checkForUpdate({
      fetchImpl,
      registry,
      currentVersion,
      automaticChecks: true,
      isPackaged: true,
      now: () => now,
      ...reader.options,
      ...host.options,
    })
  }

  it('the projection of a universal release is the file they read today, byte for byte', () => {
    expect(projectV1(v2Of(VERSION, 'universal', TAGGED_AT).bytes).bytes.equals(publish().manifestBytes)).toBe(true)
  })

  // 1.9.0 is the last universal release; 2.0.0 is arm64 and re-stamps its v1 manifest.
  const last = v2Of('1.9.0', 'universal', '2027-01-04T12:00:00Z')
  const lastV1 = signed(projectV1(last.bytes).bytes)
  const listing: ReleaseLike = {
    tag_name: 'v1.9.0',
    draft: false,
    prerelease: false,
    assets: [
      ...last.manifest.targets.map((target, index) => ({
        id: 100 + index,
        name: target.filename,
        size: target.byteLength,
        browser_download_url: target.url,
        digest: `sha256:${target.sha256}`,
      })),
      { id: 110, name: 'update-manifest.json', size: lastV1.manifestBytes.length, browser_download_url: 'https://github.com/shariqh/agent-inbox/releases/download/v1.9.0/update-manifest.json' },
      { id: 111, name: 'update-manifest.json.sig', size: lastV1.signatureBytes.length, browser_download_url: 'https://github.com/shariqh/agent-inbox/releases/download/v1.9.0/update-manifest.json.sig' },
    ],
  }
  const restamped = signed(restampV1({
    earlierManifestBytes: lastV1.manifestBytes,
    earlierSignatureBytes: lastV1.signatureBytes,
    registry,
    newTag: 'v2.0.0',
    publishedAt: '2027-01-18T12:00:00Z',
    releases: [listing],
  }).bytes)
  const afterRestamp = new Date('2027-01-19T09:30:00Z')

  it.each(READERS)('$name offer every host the last universal release through a re-stamp', async (reader) => {
    for (const host of HOSTS) {
      const result = await read(reader, host, restamped, reader.currentVersion, afterRestamp)
      expect(result.status, host.name).toBe('available')
      expect(result.available?.version, host.name).toBe('1.9.0')
      expect(result.available?.releaseUrl, host.name).toBe('https://github.com/shariqh/agent-inbox/releases/tag/v1.9.0')
      if ('artifact' in result && result.artifact) {
        expect(result.artifact.url, host.name).toMatch(/^https:\/\/github\.com\/shariqh\/agent-inbox\/releases\/download\/v1\.9\.0\//)
        if (host.options.platform === 'darwin') expect(result.artifact.filename, host.name).toBe('Agent-Inbox-v1.9.0-universal.dmg')
      }
    }
  })

  it.each(READERS)('$name read a re-stamp as up to date on the release it describes', async (reader) => {
    for (const host of HOSTS) {
      await expect(read(reader, host, restamped, '1.9.0', afterRestamp), host.name).resolves.toMatchObject({ status: 'current' })
    }
  })

  it.each(READERS)('$name reject every manifest the v2 publisher writes, universal or arm64', async (reader) => {
    for (const v2 of [v2Of('2.0.0', 'universal', '2027-01-18T12:00:00Z'), v2Of('2.0.0', 'arm64', '2027-01-18T12:00:00Z')]) {
      for (const host of HOSTS) {
        await expect(read(reader, host, signed(v2.bytes), reader.currentVersion, afterRestamp), host.name)
          .rejects.toThrow('manifest.schema must be 1')
      }
    }
  })
})


// The backup update key (#342): from 1.7.0, release/update-keys.json trusts a second key
// beside the original, so every manifest lists both ids in trustedKeyIds while the
// original key alone signs. These readers trust the original key alone, for good.
describe('the shipped readers and the backup update key (#342)', () => {
  const production = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'release', 'update-keys.json'), 'utf8')) as {
    signingKeyId: string
    keys: Array<{ keyId: string; algorithm: 'ed25519'; publicKeySpkiBase64: string }>
  }
  // Every key production trusts beside the one that signs: the backup key.
  const backupKeys = production.keys.filter((key) => key.keyId !== production.signingKeyId)
  const evidence = { tag: TAG, packageVersion: VERSION, sourceCommit: 'c'.repeat(40), sourceTree: 'd'.repeat(40), assets: PACKAGES }

  function scratch() {
    const pair = generateKeyPairSync('ed25519')
    const spki = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    return {
      entry: { keyId: deriveKeyId(spki), algorithm: 'ed25519' as const, publicKeySpkiBase64: spki },
      privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    }
  }

  /** A scratch key in the original key's place, whose id sorts before or after the backup key's. */
  function standIn(position: 'first' | 'last') {
    for (;;) {
      const key = scratch()
      if ((key.entry.keyId < backupKeys[0]!.keyId) !== (position === 'first')) continue
      return {
        ...key,
        // What these apps hold, and what every release from 1.7.0 on is published with.
        shipped: { schema: 1 as const, signingKeyId: key.entry.keyId, keys: [key.entry] },
        released: { schema: 1 as const, signingKeyId: key.entry.keyId, keys: [key.entry, ...backupKeys] },
      }
    }
  }

  it('find the backup key beside the original in production', () => {
    expect(backupKeys.map(({ keyId }) => keyId)).toEqual(['ed25519-c8adddea0de080d6'])
  })

  // In production the original key's id sorts first.
  it.each(['first', 'last'] as const)('with the original key\'s id %s, accept a v1 manifest that lists both ids, signed by the original key alone', async (position) => {
    const original = standIn(position)
    const v1 = projectV1(generateManifestV2({ registry: original.released, evidence, minimumMacosVersion: '13.5', publishedAt: TAGGED_AT, kind: 'universal' }).bytes)
    const ids = [original.entry.keyId, ...backupKeys.map(({ keyId }) => keyId)].sort()
    expect(v1.manifest.trustedKeyIds).toEqual(ids)
    const signature = signManifest({ manifestBytes: v1.bytes, registry: original.released, privateKeyPem: original.privateKeyPem, now: NOW })
    expect(signature.envelope.signatures.map((signed) => signed.keyId)).toEqual([original.entry.keyId])
    for (const reader of READERS) {
      expect(reader.manifest.verifyManifest({ manifestBytes: v1.bytes, envelope: signature.bytes, registry: original.shipped, now: NOW }).trustedKeyIds, reader.name)
        .toEqual(ids)
      for (const host of HOSTS) {
        const result = await check(reader, host, { manifestBytes: v1.bytes, signatureBytes: signature.bytes }, original.shipped)
        expect({ status: result.status, version: result.available?.version }, `${reader.name} on ${host.name}`).toEqual({ status: 'available', version: VERSION })
      }
    }
  })

  // The emergency procedure in docs/macos-release.md signs with the backup key alone, which
  // knowingly cuts these apps off.
  it.each(READERS)('$name reject a manifest signed by the backup key alone, on every host', async (reader) => {
    const original = scratch()
    const backup = scratch()
    const shipped = { schema: 1 as const, signingKeyId: original.entry.keyId, keys: [original.entry] }
    const emergency = { schema: 1 as const, signingKeyId: backup.entry.keyId, keys: [original.entry, backup.entry] }
    const { bytes } = generateManifest({ registry: emergency, evidence, minimumMacosVersion: '13.5', publishedAt: TAGGED_AT })
    const signature = signManifest({ manifestBytes: bytes, registry: emergency, privateKeyPem: backup.privateKeyPem, now: NOW })
    for (const host of HOSTS) {
      await expect(check(reader, host, { manifestBytes: bytes, signatureBytes: signature.bytes }, shipped), host.name)
        .rejects.toThrow('signature verification failed')
    }
  })
})
