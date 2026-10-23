// test/update-lanes.test.ts — the hand-off from update-manifest.json to update-manifest-v2.json,
// end to end (#343, design §8.3).
//
// A synthetic history from 1.6.0 to 2.0.1, built only by the publisher functions, is served
// through a fake `latest`. After each release, every app checks with the reader it runs: the
// code 1.2.x and 1.6.0 shipped (test/fixtures/shipped-updaters/, #340), or the new reader
// through the real controller and its trust-state file. It installs whatever it is offered
// and checks again, until nothing is offered.
import { createHash, generateKeyPairSync } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import updateController from '../electron/update-controller.cjs'
import updateFetch from '../electron/update-fetch.cjs'
import updatePreferences from '../electron/update-preferences.cjs'
import type { UpdateArtifact, UpdateCheckResult } from '../electron/update-controller.cjs'
import type { VerifiedArtifact } from '../electron/update-download.cjs'
import {
  deriveKeyId,
  generateManifest,
  generateManifestV2,
  projectV1,
  restampV1,
  signManifest,
} from '../scripts/update-manifest.mjs'
import type { ReleaseAssetEvidence, ReleaseLike } from '../scripts/update-manifest.d.mts'
import { removeScratchDirs, scratchDir } from './scratch.js'

const { createUpdateController } = updateController
const { MANIFEST_URL, SIGNATURE_URL, MANIFEST_V2_URL, SIGNATURE_V2_URL, checkForUpdate } = updateFetch

interface ShippedResult {
  status: string
  available?: { version: string; target: { packageType: string } }
  artifact?: { filename: string; architecture: string }
}

interface ShippedReader {
  checkForUpdate(options: Record<string, unknown>): Promise<ShippedResult>
}

interface ShippedTrustState {
  recordVerifiedVersion(version: string): Promise<{ highestVerifiedVersion: string | null }>
}

const require = createRequire(import.meta.url)
const FIXTURES = resolve(import.meta.dirname, 'fixtures', 'shipped-updaters')
const shipped12 = require(join(FIXTURES, 'v1.2.8', 'update-fetch.cjs')) as ShippedReader
const shipped16 = require(join(FIXTURES, 'v1.6.0', 'update-fetch.cjs')) as ShippedReader
const shippedPreferences = require(join(FIXTURES, 'v1.6.0', 'update-preferences.cjs')) as {
  createUpdateTrustState(options: { filePath: string }): ShippedTrustState
}

afterEach(removeScratchDirs)

// A scratch key: the production key never signs anything in tests.
const scratchKey = generateKeyPairSync('ed25519')
const publicKeySpkiBase64 = scratchKey.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
const keyId = deriveKeyId(publicKeySpkiBase64)
const registry = { schema: 1 as const, signingKeyId: keyId, keys: [{ keyId, algorithm: 'ed25519' as const, publicKeySpkiBase64 }] }
const privateKeyPem = scratchKey.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const after = (iso: string, ms = HOUR_MS) => new Date(Date.parse(iso) + ms)

function compareVersions(left: string, right: string) {
  const [a, b] = [left.split('.').map(Number), right.split('.').map(Number)]
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1
  }
  return 0
}

// 1.9.0 is 1.x-last: the last universal release, before 2.0.0 builds for Apple silicon only.
const HISTORY = [
  { version: '1.6.0', kind: 'v1-only', taggedAt: '2026-10-20T12:00:00Z' },
  { version: '1.7.0', kind: 'universal', taggedAt: '2026-11-16T12:00:00Z' },
  { version: '1.8.0', kind: 'universal', taggedAt: '2026-12-07T12:00:00Z' },
  { version: '1.9.0', kind: 'universal', taggedAt: '2027-01-04T12:00:00Z' },
  { version: '2.0.0', kind: 'arm64', taggedAt: '2027-01-18T12:00:00Z' },
  { version: '2.0.1', kind: 'arm64', taggedAt: '2027-02-01T12:00:00Z' },
] as const

type Pair = { bytes: Buffer; signature: Buffer }
type Published = { version: string; tag: string; kind: string; taggedAt: string; v1: Pair; v2?: Pair; listing: ReleaseLike }

function packagesOf(version: string, dmg: 'universal' | 'arm64'): ReleaseAssetEvidence[] {
  const asset = (name: string, packageType: 'dmg' | 'appimage' | 'deb', platform: 'darwin' | 'linux', architecture: 'universal' | 'arm64' | 'x64') => (
    { name, packageType, platform, architecture, size: 100_000 + name.length, sha256: sha256(name) }
  )
  return [
    asset(`Agent-Inbox-v${version}-${dmg}.dmg`, 'dmg', 'darwin', dmg),
    asset(`Agent-Inbox-v${version}-linux-arm64.AppImage`, 'appimage', 'linux', 'arm64'),
    asset(`agent-inbox_${version}_arm64.deb`, 'deb', 'linux', 'arm64'),
    asset(`Agent-Inbox-v${version}-linux-x86_64.AppImage`, 'appimage', 'linux', 'x64'),
    asset(`agent-inbox_${version}_amd64.deb`, 'deb', 'linux', 'x64'),
  ]
}

let nextAssetId = 1
function listingOf(tag: string, packages: ReleaseAssetEvidence[], pairs: Array<[string, Pair]>): ReleaseLike {
  const listed = (name: string, size: number, digest: string) => ({
    id: nextAssetId++,
    name,
    size,
    digest: `sha256:${digest}`,
    browser_download_url: `https://github.com/shariqh/agent-inbox/releases/download/${tag}/${name}`,
  })
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: [
      ...packages.map(({ name, size, sha256: digest }) => listed(name, size, digest)),
      listed('SHA256SUMS.txt', 400, sha256('sums')),
      ...pairs.flatMap(([name, pair]) => [
        listed(name, pair.bytes.length, sha256(pair.bytes)),
        listed(`${name}.sig`, pair.signature.length, sha256(pair.signature)),
      ]),
    ],
  }
}

/** The history, published release by release with the publisher's own functions. */
function publishHistory(): Published[] {
  const published: Published[] = []
  for (const { version, kind, taggedAt } of HISTORY) {
    const tag = `v${version}`
    const packages = packagesOf(version, kind === 'arm64' ? 'arm64' : 'universal')
    const evidence = { tag, packageVersion: version, sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), assets: packages }
    const signed = (bytes: Buffer): Pair => ({
      bytes,
      signature: signManifest({ manifestBytes: bytes, registry, privateKeyPem, now: taggedAt }).bytes,
    })
    let v1: Pair
    let v2: Pair | undefined
    if (kind === 'v1-only') {
      v1 = signed(generateManifest({ registry, evidence, minimumMacosVersion: '13.5', publishedAt: taggedAt }).bytes)
    } else {
      const v2Bytes = generateManifestV2({ registry, evidence, minimumMacosVersion: '13.5', publishedAt: taggedAt, kind }).bytes
      v2 = signed(v2Bytes)
      if (kind === 'universal') {
        v1 = signed(projectV1(v2Bytes).bytes)
      } else {
        const before = published.at(-1)!
        v1 = signed(restampV1({
          earlierManifestBytes: before.v1.bytes,
          earlierSignatureBytes: before.v1.signature,
          registry,
          newTag: tag,
          publishedAt: taggedAt,
          releases: published.map((release) => release.listing),
        }).bytes)
      }
    }
    const pairs: Array<[string, Pair]> = [['update-manifest.json', v1], ...(v2 ? [['update-manifest-v2.json', v2] as [string, Pair]] : [])]
    published.push({ version, tag, kind, taggedAt, v1, v2, listing: listingOf(tag, packages, pairs) })
  }
  return published
}

const PUBLISHED = publishHistory()
const release = (version: string) => PUBLISHED.find((entry) => entry.version === version)!

/** `latest` as GitHub serves it while `published` is the latest release; nothing else answers. */
function latest(published: Published, v1: Partial<Pair> = {}) {
  const files = new Map<string, Buffer>([
    [MANIFEST_URL, v1.bytes ?? published.v1.bytes],
    [SIGNATURE_URL, v1.signature ?? published.v1.signature],
    ...(published.v2 ? [[MANIFEST_V2_URL, published.v2.bytes], [SIGNATURE_V2_URL, published.v2.signature]] as Array<[string, Buffer]> : []),
  ])
  return async (url: string) => {
    const body = files.get(url)
    return body ? new Response(new Uint8Array(body)) : new Response(null, { status: 404 })
  }
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

// What each host's main.cjs passes; `translated` is app.runningUnderARM64Translation.
const HOSTS = {
  intel: { name: 'Intel Mac', options: { platform: 'darwin', arch: 'x64', translated: false } },
  appleSilicon: { name: 'Apple silicon Mac', options: { platform: 'darwin', arch: 'arm64', translated: false } },
  rosetta: { name: 'Apple silicon Mac under Rosetta', options: { platform: 'darwin', arch: 'x64', translated: true } },
  linuxX64AppImage: { name: 'Linux x64 AppImage', options: { platform: 'linux', arch: 'x64', ...appImageHost('/home/tester/Applications/Agent-Inbox-v1.6.0-linux-x86_64.AppImage') } },
  linuxX64Deb: { name: 'Linux x64 DEB', options: { platform: 'linux', arch: 'x64' } },
  linuxArm64AppImage: { name: 'Linux arm64 AppImage', options: { platform: 'linux', arch: 'arm64', ...appImageHost('/home/tester/Applications/Agent-Inbox-v1.6.0-linux-arm64.AppImage') } },
  linuxArm64Deb: { name: 'Linux arm64 DEB', options: { platform: 'linux', arch: 'arm64' } },
} as const

type Host = (typeof HOSTS)[keyof typeof HOSTS]
type App = { host: Host; version: string; trustFile: string }
type Reader = '1.2.x' | '1.3 to 1.6' | 'new'
type Outcome = {
  reader: Reader
  status: string
  version?: string
  packageType?: string
  /** The signed file the app could download, when it was offered one. */
  file?: string
  architecture?: string
  downloadable?: boolean
  blocked?: string
  manifest?: string
}

function newApp(host: Host, version: string): App {
  const trustFile = join(scratchDir('agent-inbox-lane-'), 'update-trust-state.json')
  return { host, version, trustFile }
}

const readerOf = (version: string): Reader => (compareVersions(version, '1.3.0') < 0
  ? '1.2.x'
  : compareVersions(version, '1.7.0') < 0 ? '1.3 to 1.6' : 'new')

function memoryPreferences() {
  const preferences = { schema: 1 as const, automaticChecks: false, lastNotifiedVersion: null }
  return { read: async () => preferences, setAutomatic: async () => preferences, setLastNotifiedVersion: async () => preferences }
}

// What a packaged macOS app registers: a downloader, and an installer that can install here.
function packagedMacAdapters() {
  return {
    downloader: {
      normalize: (artifact: UpdateArtifact) => (artifact.installStrategy === 'deb-notify' ? null : Object.freeze({ ...artifact })),
      download: async () => { throw new Error('not downloaded in the lanes') },
      cancel: async () => {},
      prune: async () => {},
      openVerified: async () => { throw new Error('not installed in the lanes') },
    },
    installers: {
      'macos-dmg': {
        strategy: 'macos-dmg' as const,
        feasibility: async () => ({ ok: true as const }),
        prepare: async () => { throw new Error('not installed in the lanes') },
      },
    },
    requestRestart: () => {},
  }
}

/** One check by the app as it runs now; a check that fails is `unverified`, as the app shows it. */
async function checkOnce(app: App, fetchImpl: ReturnType<typeof latest>, now: Date): Promise<Outcome> {
  const reader = readerOf(app.version)
  const host = { fetchImpl, registry, currentVersion: app.version, automaticChecks: true, isPackaged: true, now: () => now, ...app.host.options }
  if (reader !== 'new') {
    const trust = shippedPreferences.createUpdateTrustState({ filePath: app.trustFile })
    try {
      const result = reader === '1.2.x'
        ? await shipped12.checkForUpdate(host)
        : await shipped16.checkForUpdate({
          ...host,
          includeArtifact: true,
          recordVerifiedVersion: async (version: string) => (await trust.recordVerifiedVersion(version)).highestVerifiedVersion,
        })
      return {
        reader,
        status: result.status,
        version: result.available?.version,
        packageType: result.available?.target.packageType,
        file: result.artifact?.filename,
        architecture: result.artifact?.architecture,
      }
    } catch {
      return { reader, status: 'unverified' }
    }
  }
  const checked: UpdateCheckResult[] = []
  const controller = createUpdateController({
    currentVersion: app.version,
    preferences: memoryPreferences(),
    trustState: updatePreferences.createUpdateTrustState({ filePath: app.trustFile }),
    checker: async ({ currentVersion, automaticChecks, recordVerifiedVersion }) => {
      const result = await checkForUpdate({ ...host, currentVersion, automaticChecks, recordVerifiedVersion, includeArtifact: true })
      checked.push(result)
      return result
    },
    notifier: () => {},
    ...(app.host.options.platform === 'darwin' ? packagedMacAdapters() : {}),
  })
  try {
    const state = await controller.checkNow()
    const [result] = checked
    return {
      reader,
      status: state.status,
      version: state.available?.version,
      packageType: state.available?.target.packageType,
      file: result?.artifact?.filename,
      architecture: result?.artifact?.architecture,
      downloadable: state.available?.downloadable,
      blocked: state.available?.blocked,
      manifest: result?.manifest,
    }
  } finally {
    controller.dispose()
  }
}

function marks(app: App) {
  try {
    return JSON.parse(readFileSync(app.trustFile, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

// What must hold on every check along the history.
function expectSafe(app: App, outcome: Outcome) {
  const label = `${app.host.name} on ${app.version} (${outcome.reader})`
  // Nothing reads as stale, and nothing fails to verify.
  expect(['available', 'current'], label).toContain(outcome.status)
  // No v1 reader is ever offered a 2.x file.
  if (outcome.reader !== 'new' && outcome.version) expect(compareVersions(outcome.version, '2.0.0'), label).toBeLessThan(0)
  // No app running as x64 on macOS is offered an arm64 build it could download.
  if (app.host.options.platform === 'darwin' && app.host.options.arch === 'x64') {
    if (outcome.file) expect(outcome.architecture, label).not.toBe('arm64')
    if (outcome.blocked) expect({ file: outcome.file, downloadable: outcome.downloadable }, label).toEqual({ file: undefined, downloadable: false })
  }
  // The v1 mark never holds a 2.x version.
  const v1Mark = marks(app).highestVerifiedVersion
  if (typeof v1Mark === 'string') expect(compareVersions(v1Mark, '2.0.0'), label).toBeLessThan(0)
}

/** Check, install what is offered, and check again, until nothing is offered. */
async function settle(app: App, fetchImpl: ReturnType<typeof latest>, now: Date) {
  const outcomes: Outcome[] = []
  for (;;) {
    const outcome = await checkOnce(app, fetchImpl, now)
    expectSafe(app, outcome)
    outcomes.push(outcome)
    if (outcome.status !== 'available' || outcome.blocked) return outcomes
    app.version = outcome.version!
    if (outcomes.length > 6) throw new Error(`${app.host.name} never settled`)
  }
}

const installed = (outcomes: Outcome[]) => outcomes.filter((outcome) => outcome.status === 'available' && !outcome.blocked).map((outcome) => outcome.version)

describe('the hand-off from update-manifest.json to update-manifest-v2.json', () => {
  it('takes every app on every host from 1.2.8 and 1.6.0 along the paths of design §4.4', async () => {
    const fleet = Object.values(HOSTS).flatMap((host) => ['1.2.8', '1.6.0'].map((version) => ({
      app: newApp(host, version),
      start: version,
      path: [version] as string[],
      last: undefined as Outcome | undefined,
    })))
    for (const published of PUBLISHED) {
      for (const lane of fleet) {
        const outcomes = await settle(lane.app, latest(published), after(published.taggedAt))
        lane.path.push(...installed(outcomes) as string[])
        lane.last = outcomes.at(-1)
      }
    }
    const pathOf = (host: Host, start: string) => fleet.find((lane) => lane.app.host === host && lane.start === start)!
    for (const start of ['1.2.8', '1.6.0']) {
      const before = start === '1.2.8' ? ['1.2.8', '1.6.0'] : ['1.6.0']
      // Intel Macs, and Apple silicon Macs under Rosetta, end on 1.x-last.
      for (const [host, blocked] of [[HOSTS.intel, 'apple-silicon'], [HOSTS.rosetta, 'rosetta']] as const) {
        expect(pathOf(host, start).path, host.name).toEqual([...before, '1.7.0', '1.8.0', '1.9.0'])
        expect(pathOf(host, start).last, host.name).toMatchObject({ reader: 'new', status: 'available', version: '2.0.1', blocked })
      }
      // Apple silicon running natively and Linux continue to 2.x.
      for (const host of [HOSTS.appleSilicon, HOSTS.linuxX64AppImage, HOSTS.linuxX64Deb, HOSTS.linuxArm64AppImage, HOSTS.linuxArm64Deb]) {
        expect(pathOf(host, start).path, host.name).toEqual([...before, '1.7.0', '1.8.0', '1.9.0', '2.0.0', '2.0.1'])
        expect(pathOf(host, start).last, host.name).toMatchObject({ reader: 'new', status: 'current' })
      }
    }
  })

  // Design §4.4, once 2.0.1 is the latest release: each row, from an app installed then.
  it.each([
    ['1.2.x', 'intel', '1.2.8', ['1.9.0'], { blocked: 'apple-silicon' }],
    ['1.2.x', 'appleSilicon', '1.2.8', ['1.9.0', '2.0.1'], { status: 'current' }],
    ['1.2.x', 'linuxX64Deb', '1.2.8', ['1.9.0', '2.0.1'], { status: 'current' }],
    ['1.3 to 1.6', 'intel', '1.6.0', ['1.9.0'], { blocked: 'apple-silicon' }],
    ['1.3 to 1.6', 'rosetta', '1.6.0', ['1.9.0'], { blocked: 'rosetta' }],
    ['1.3 to 1.6', 'appleSilicon', '1.6.0', ['1.9.0', '2.0.1'], { status: 'current' }],
    ['1.3 to 1.6', 'linuxArm64AppImage', '1.6.0', ['1.9.0', '2.0.1'], { status: 'current' }],
    ['1.7.0 to 1.x-last', 'appleSilicon', '1.7.0', ['2.0.1'], { status: 'current' }],
    ['1.7.0 to just before 1.x-last', 'intel', '1.8.0', ['1.9.0'], { blocked: 'apple-silicon' }],
    ['1.7.0 to just before 1.x-last', 'rosetta', '1.8.0', ['1.9.0'], { blocked: 'rosetta' }],
    ['1.x-last', 'intel', '1.9.0', [], { blocked: 'apple-silicon' }],
    ['1.x-last', 'rosetta', '1.9.0', [], { blocked: 'rosetta' }],
    ['1.7.0 and later', 'linuxX64AppImage', '1.7.0', ['2.0.1'], { status: 'current' }],
    ['2.x', 'appleSilicon', '2.0.0', ['2.0.1'], { status: 'current' }],
  ] as const)('%s on %s, from %s', async (_row, hostKey, version, path, last) => {
    const app = newApp(HOSTS[hostKey], version)
    const latestRelease = release('2.0.1')
    const outcomes = await settle(app, latest(latestRelease), after(latestRelease.taggedAt))
    expect(installed(outcomes)).toEqual(path)
    expect(outcomes.at(-1)).toMatchObject(last)
  })

  it('offers each Mac its own file: the universal 1.x-last through v1 on Intel, the arm64 DMG through v2 on Apple silicon', async () => {
    const latestRelease = release('2.0.1')
    const now = after(latestRelease.taggedAt)
    await expect(checkOnce(newApp(HOSTS.intel, '1.8.0'), latest(latestRelease), now)).resolves.toMatchObject({
      status: 'available', version: '1.9.0', manifest: 'v1', file: 'Agent-Inbox-v1.9.0-universal.dmg', downloadable: true,
    })
    await expect(checkOnce(newApp(HOSTS.appleSilicon, '1.8.0'), latest(latestRelease), now)).resolves.toMatchObject({
      status: 'available', version: '2.0.1', manifest: 'v2', file: 'Agent-Inbox-v2.0.1-arm64.dmg', architecture: 'arm64', downloadable: true,
    })
    await expect(checkOnce(newApp(HOSTS.intel, '1.6.0'), latest(latestRelease), now)).resolves.toMatchObject({
      reader: '1.3 to 1.6', version: '1.9.0', file: 'Agent-Inbox-v1.9.0-universal.dmg', architecture: 'universal',
    })
  })

  it('shows every reader unverified 181 days after the last re-stamp, and offers nothing', async () => {
    const latestRelease = release('2.0.1')
    const now = after(latestRelease.taggedAt, 181 * DAY_MS)
    for (const [host, version] of [[HOSTS.intel, '1.2.8'], [HOSTS.intel, '1.6.0'], [HOSTS.linuxX64Deb, '1.6.0'], [HOSTS.intel, '1.9.0'], [HOSTS.appleSilicon, '2.0.0']] as const) {
      const outcome = await checkOnce(newApp(host, version), latest(latestRelease), now)
      expect(outcome, `${host.name} on ${version}`).toEqual({ reader: readerOf(version), status: 'unverified' })
    }
    // One day earlier, the same files are fresh.
    await expect(checkOnce(newApp(HOSTS.intel, '1.6.0'), latest(latestRelease), after(latestRelease.taggedAt, 179 * DAY_MS)))
      .resolves.toMatchObject({ status: 'available', version: '1.9.0' })
  })
})

describe('an Intel Mac holding a verified download of 1.x-last', () => {
  // 1.8.0 on an Intel Mac, with 1.9.0 downloaded and verified through the v1 fallback.
  async function holding() {
    const app = newApp(HOSTS.intel, '1.8.0')
    let fetchImpl = latest(release('2.0.0'))
    const prune = vi.fn(async () => {})
    const controller = createUpdateController({
      currentVersion: app.version,
      preferences: memoryPreferences(),
      trustState: updatePreferences.createUpdateTrustState({ filePath: app.trustFile }),
      checker: ({ currentVersion, automaticChecks, recordVerifiedVersion }) => checkForUpdate({
        fetchImpl: (url: string) => fetchImpl(url),
        registry,
        currentVersion,
        automaticChecks,
        recordVerifiedVersion,
        isPackaged: true,
        now: () => after(release('2.0.1').taggedAt),
        includeArtifact: true,
        ...HOSTS.intel.options,
      }),
      notifier: () => {},
      downloader: {
        normalize: (artifact: UpdateArtifact) => Object.freeze({ ...artifact }),
        download: async (artifact: UpdateArtifact): Promise<VerifiedArtifact> => ({
          path: '/private/update-downloads/v1.9.0/Agent-Inbox-v1.9.0-universal.dmg',
          version: artifact.version,
          tag: artifact.tag,
          filename: artifact.filename,
          sha256: artifact.sha256,
          byteLength: artifact.byteLength,
          architecture: artifact.architecture,
          packageType: artifact.packageType,
          installStrategy: artifact.installStrategy,
          ...(artifact.minimumSystemVersion ? { minimumSystemVersion: artifact.minimumSystemVersion } : {}),
        }) as VerifiedArtifact,
        cancel: async () => {},
        prune,
        openVerified: async () => { throw new Error('not installed here') },
      },
    })
    await expect(controller.checkNow()).resolves.toMatchObject({ status: 'available', available: { version: '1.9.0' } })
    await expect(controller.downloadNow()).resolves.toMatchObject({ status: 'verified', available: { version: '1.9.0' } })
    prune.mockClear()
    return { app, controller, prune, serve: (next: typeof fetchImpl) => { fetchImpl = next } }
  }

  it('keeps it through the publication race, a manifest from one release and a signature from the next', async () => {
    const { controller, prune, serve } = await holding()
    for (const v1 of [
      { bytes: release('2.0.1').v1.bytes, signature: release('2.0.0').v1.signature },
      { bytes: release('2.0.0').v1.bytes, signature: release('2.0.1').v1.signature },
    ]) {
      serve(latest(release('2.0.1'), v1))
      await expect(controller.checkNow()).resolves.toMatchObject({ status: 'verified', available: { version: '1.9.0' } })
      expect(controller.getVerifiedArtifact()).toMatchObject({ version: '1.9.0', architecture: 'universal' })
    }
    expect(prune).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('keeps it when the v1 manifest is stale', async () => {
    const { controller, prune, serve } = await holding()
    // An older release's v1 pair beside the latest v2, below the v1 mark of 1.9.0.
    serve(latest(release('2.0.1'), release('1.8.0').v1))
    await expect(controller.checkNow()).resolves.toMatchObject({ status: 'verified', available: { version: '1.9.0' } })
    expect(controller.getVerifiedArtifact()).toMatchObject({ version: '1.9.0' })
    expect(prune).not.toHaveBeenCalled()
    // Once the race settles, the same file is offered again and stays.
    serve(latest(release('2.0.1')))
    await expect(controller.checkNow()).resolves.toMatchObject({ status: 'verified', available: { version: '1.9.0' } })
    controller.dispose()
  })
})

// Design §8.3: a deliberate downgrade to 1.6.0 shares the trust-state file with the new reader.
describe('a downgrade to 1.6.0 on the same update-trust-state.json', () => {
  it.each([
    ['an Apple silicon Mac on 2.0.1', HOSTS.appleSilicon, '1.7.0', '2.0.1'],
    ['an Intel Mac on 1.9.0', HOSTS.intel, '1.7.0', '1.9.0'],
  ] as const)('leaves %s offered 1.x-last, never stale, with the v2 mark intact', async (_label, host, start, end) => {
    const app = newApp(host, start)
    for (const published of PUBLISHED.filter((entry) => compareVersions(entry.version, '1.7.0') >= 0)) {
      await settle(app, latest(published), after(published.taggedAt))
    }
    expect(app.version).toBe(end)
    expect(marks(app)).toMatchObject({ schema: 1, highestVerifiedVersionV2: '2.0.1' })

    app.version = '1.6.0'
    const latestRelease = release('2.0.1')
    const outcome = await checkOnce(app, latest(latestRelease), after(latestRelease.taggedAt))
    expect(outcome).toMatchObject({ reader: '1.3 to 1.6', status: 'available', version: '1.9.0', file: 'Agent-Inbox-v1.9.0-universal.dmg' })
    expect(marks(app)).toEqual({ schema: 1, highestVerifiedVersion: '1.9.0', highestVerifiedVersionV2: '2.0.1' })
  })
})
