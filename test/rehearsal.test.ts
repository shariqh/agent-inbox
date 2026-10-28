// test/rehearsal.test.ts — the rehearsal harness of 1.x-last's Intel and Rosetta update
// path (#344; update manifest v2 design §8.5).
//
// The harness itself (test/rehearsal/rehearsal.cjs) runs only on a Mac, under the installed
// app's own Electron. What runs here is its manifest preparation, against a byte-exact copy
// of the pair v1.8.0, 1.x-last, published (test/fixtures/rehearsal/v1.8.0/, from
// `gh release download v1.8.0`), and the source pins it shares with
// test/electron-updates.test.ts.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import updateManifest from '../electron/update-manifest.cjs'
import type { UpdateRegistry } from '../electron/update-manifest.cjs'

type Pair = { bytes: Buffer; signature: Buffer }
type Prepared = {
  registry: UpdateRegistry
  publishedAt: string
  describes: string
  v1: Pair
  v2: Pair
  laterV1Signature: Buffer
}

const require = createRequire(import.meta.url)
const { RESTAMPED_FIELDS, prepareManifests, restampDifferences } = require('./rehearsal/manifests.cjs') as {
  RESTAMPED_FIELDS: readonly string[]
  prepareManifests(options: {
    published: { manifest: Buffer; signature: Buffer }
    releases: unknown[]
    productionRegistry: UpdateRegistry
    next: string
    now?: Date
  }): Promise<Prepared>
  restampDifferences(earlier: Buffer, restamped: Buffer): string[]
}
const { MAIN_PINS, pinFailures } = require('./rehearsal/main-pins.cjs') as {
  MAIN_PINS: Record<'rosetta' | 'macInstaller' | 'recorder' | 'downloads', readonly unknown[]>
  pinFailures(main: string, pins: readonly unknown[]): string[]
}
const { parseRegistry, verifyManifest, verifyManifestV2 } = updateManifest

const FIXTURE = resolve(import.meta.dirname, 'fixtures', 'rehearsal', 'v1.8.0')
const published = {
  manifest: readFileSync(join(FIXTURE, 'update-manifest.json')),
  signature: readFileSync(join(FIXTURE, 'update-manifest.json.sig')),
}
// GitHub's listing of v1.8.0, trimmed to the fields restampV1 reads.
const release = JSON.parse(readFileSync(join(FIXTURE, 'release.json'), 'utf8')) as {
  tag_name: string
  assets: Array<{ name: string; size: number; digest: string }>
}
const production = parseRegistry(readFileSync(resolve(import.meta.dirname, '..', 'release', 'update-keys.json')))
const now = new Date('2026-11-02T12:00:00.250Z')

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const prepare = () => prepareManifests({ published, releases: [release], productionRegistry: production, next: '2.0.0', now })

describe('the rehearsal manifests (#344)', () => {
  it('start from the pair v1.8.0 published, byte for byte', () => {
    for (const [name, bytes] of [['update-manifest.json', published.manifest], ['update-manifest.json.sig', published.signature]] as const) {
      const listed = release.assets.find((asset) => asset.name === name)
      expect(listed, name).toMatchObject({ size: bytes.length, digest: `sha256:${sha256(bytes)}` })
    }
    expect(verifyManifest({ manifestBytes: published.manifest, envelope: published.signature, registry: production }).tag).toBe('v1.8.0')
  })

  it('re-stamp 1.x-last\'s published manifest, changing only the four re-stamped fields', async () => {
    const { registry, v1, describes } = await prepare()
    const before = JSON.parse(published.manifest.toString('utf8')) as Record<string, unknown>
    const after = JSON.parse(v1.bytes.toString('utf8')) as Record<string, unknown>

    expect(Object.keys(after)).toEqual(Object.keys(before))
    const changed = Object.keys(before).filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
    expect(changed.sort()).toEqual(['expiresAt', 'publishedAt', 'signingKeyId', 'trustedKeyIds'])
    expect(restampDifferences(published.manifest, v1.bytes)).toEqual([...RESTAMPED_FIELDS])
    // Its macOS target is still the real, notarized v1.8.0 DMG.
    expect(after.targets).toEqual(before.targets)
    expect(describes).toBe('v1.8.0')
    expect(after).toMatchObject({
      publishedAt: '2026-11-02T12:00:00Z',
      expiresAt: '2027-05-01T12:00:00Z',
      signingKeyId: registry.signingKeyId,
      trustedKeyIds: [...production.keys.map((key) => key.keyId), registry.signingKeyId].sort(),
    })

    const tampered = Buffer.from(v1.bytes.toString('utf8').replace('"byteLength": 232016051', '"byteLength": 232016052'))
    expect(restampDifferences(published.manifest, tampered)).toEqual([...RESTAMPED_FIELDS, 'targets'].sort())
  })

  it('both verify with the scratch registry, which trusts the scratch key alone', async () => {
    const { registry, v1, v2, publishedAt, laterV1Signature } = await prepare()
    expect(registry.keys.map((key) => key.keyId)).toEqual([registry.signingKeyId])
    expect(production.keys.map((key) => key.keyId)).not.toContain(registry.signingKeyId)

    expect(verifyManifest({ manifestBytes: v1.bytes, envelope: v1.signature, registry, now })).toMatchObject({ tag: 'v1.8.0', publishedAt })
    const arm64Release = verifyManifestV2({ manifestBytes: v2.bytes, envelope: v2.signature, registry, now })
    expect(arm64Release).toMatchObject({ tag: 'v2.0.0', publishedAt })
    // v2 lists only an arm64 DMG, plus the Linux packages.
    expect(arm64Release.targets.map(({ platform, architecture, packageType }) => `${platform}/${architecture}/${packageType}`)).toEqual([
      'darwin/arm64/dmg',
      'linux/arm64/appimage',
      'linux/arm64/deb',
      'linux/x64/appimage',
      'linux/x64/deb',
    ])
    expect(arm64Release.targets[0]).toMatchObject({
      filename: 'Agent-Inbox-v2.0.0-arm64.dmg',
      url: 'https://github.com/shariqh/agent-inbox/releases/download/v2.0.0/Agent-Inbox-v2.0.0-arm64.dmg',
      minimumSystemVersion: '13.5',
    })

    // Nothing the original key signed verifies here, and run 3's pair from two releases fails.
    expect(() => verifyManifest({ manifestBytes: published.manifest, envelope: published.signature, registry })).toThrow(/signature verification failed/)
    expect(() => verifyManifest({ manifestBytes: v1.bytes, envelope: laterV1Signature, registry })).toThrow(/do not match the digest/)
  })

  it('make a new scratch key on every run', async () => {
    const [first, second] = await Promise.all([prepare(), prepare()])
    expect(first.registry.signingKeyId).not.toBe(second.registry.signingKeyId)
  })
})

describe('the main.cjs pins the harness applies to 1.x-last', () => {
  const main = readFileSync(resolve(import.meta.dirname, '..', 'electron', 'main.cjs'), 'utf8')

  it('name each pin main.cjs no longer satisfies', () => {
    expect(Object.values(MAIN_PINS).flatMap((pins) => pinFailures(main, pins))).toEqual([])
    const translated = '      translated: app.runningUnderARM64Translation === true,\n'
    expect(main).toContain(translated)
    expect(pinFailures(main.replace(translated, ''), MAIN_PINS.rosetta)).toEqual([
      expect.stringMatching(/^initializeUpdateController does not match \/checkForUpdate/),
    ])
    const handler = "ipcMain.handle('agent-inbox:update-open-release'"
    expect(pinFailures(main.replace(handler, "ipcMain.handle('agent-inbox:update-open-releases'"), MAIN_PINS.rosetta)).toEqual([
      'the update-open-release handler is missing from main.cjs',
      'the update-open-release handler is missing from main.cjs',
    ])
  })
})
