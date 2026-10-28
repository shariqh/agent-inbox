// test/rehearsal.test.ts — the rehearsal harness of 1.x-last's Intel and Rosetta update
// path (#344; update manifest v2 design §8.5).
//
// The harness itself (test/rehearsal/rehearsal.cjs) runs only on a Mac, under the installed
// app's own Electron. What runs here is its manifest preparation, against byte-exact copies
// of the pairs v1.8.0, 1.x-last, and v1.7.0, the release before it, published
// (test/fixtures/rehearsal/, from `gh release download`), the source pins it shares with
// test/electron-updates.test.ts, its hosted-runner override (#381), and the check the
// hosted-runner workflow makes of a published DMG before installing it.
import { spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import updateManifest from '../electron/update-manifest.cjs'
import type { UpdateRegistry } from '../electron/update-manifest.cjs'
import { deriveKeyId, generateManifest, signManifest } from '../scripts/update-manifest.mjs'
import { removeScratchDirs, scratchDir } from './scratch.js'

type Pair = { bytes: Buffer; signature: Buffer }
type Prepared = {
  registry: UpdateRegistry
  publishedAt: string
  describes: string
  olderDescribes: string
  v1: Pair
  v2: Pair
  laterV1Signature: Buffer
  olderV1: Pair
}
type PublishedPair = { manifest: Buffer; signature: Buffer }

const require = createRequire(import.meta.url)
const { RESTAMPED_FIELDS, prepareManifests, restampDifferences } = require('./rehearsal/manifests.cjs') as {
  RESTAMPED_FIELDS: readonly string[]
  prepareManifests(options: {
    published: PublishedPair
    older: PublishedPair
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
type Report = {
  beginRun(name: string): void
  check(name: string, ok: boolean, detail?: string): boolean
  handOff(): void
}
const { createReport } = require('./rehearsal/runs.cjs') as { createReport(write: (line: string) => void): Report }
type Override = { active: boolean; refusal: string | null }
const { EXIT, accountRefusal, hostedRunnerOverride, parseOptions, summarize } = require('./rehearsal/rehearsal.cjs') as {
  EXIT: Record<'pass' | 'fail' | 'refused' | 'handedOff', number>
  accountRefusal(groups: string | null, hostedRunner: boolean): string | null
  hostedRunnerOverride(flag: unknown, env: Record<string, string | undefined>): Override
  parseOptions(argv: string[]): { hostedRunner: boolean }
  summarize(report: Report, hostLabel?: string, reason?: string, hostedRunner?: boolean): { lines: string[]; exitCode: number }
}
const { checkPublishedDmg } = require('./rehearsal/published-dmg.cjs') as {
  checkPublishedDmg(options: { folder: string; version: string; registry?: UpdateRegistry }): Promise<{ dmg: string; sha256: string; byteLength: number }>
}

afterEach(removeScratchDirs)
const { parseRegistry, verifyManifest, verifyManifestV2 } = updateManifest

const FIXTURES = resolve(import.meta.dirname, 'fixtures', 'rehearsal')
// A published update-manifest.json pair and GitHub's listing of its release, trimmed to the
// fields restampV1 reads.
function publishedRelease(tag: string) {
  const folder = join(FIXTURES, tag)
  return {
    pair: {
      manifest: readFileSync(join(folder, 'update-manifest.json')),
      signature: readFileSync(join(folder, 'update-manifest.json.sig')),
    },
    listing: JSON.parse(readFileSync(join(folder, 'release.json'), 'utf8')) as {
      tag_name: string
      assets: Array<{ name: string; size: number; digest: string }>
    },
  }
}
const last = publishedRelease('v1.8.0')
const before = publishedRelease('v1.7.0')
const published = last.pair
const production = parseRegistry(readFileSync(resolve(import.meta.dirname, '..', 'release', 'update-keys.json')))
const now = new Date('2026-11-02T12:00:00.250Z')

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const prepare = () => prepareManifests({
  published,
  older: before.pair,
  releases: [last.listing, before.listing],
  productionRegistry: production,
  next: '2.0.0',
  now,
})

function changedFields(earlier: Buffer, restamped: Buffer) {
  const a = JSON.parse(earlier.toString('utf8')) as Record<string, unknown>
  const b = JSON.parse(restamped.toString('utf8')) as Record<string, unknown>
  expect(Object.keys(b)).toEqual(Object.keys(a))
  return { a, b, changed: Object.keys(a).filter((field) => JSON.stringify(a[field]) !== JSON.stringify(b[field])).sort() }
}

describe('the rehearsal manifests (#344)', () => {
  it('start from the pairs v1.8.0 and v1.7.0 published, byte for byte', () => {
    for (const [tag, { pair, listing }] of [['v1.8.0', last], ['v1.7.0', before]] as const) {
      for (const [name, bytes] of [['update-manifest.json', pair.manifest], ['update-manifest.json.sig', pair.signature]] as const) {
        const listed = listing.assets.find((asset) => asset.name === name)
        expect(listed, `${tag} ${name}`).toMatchObject({ size: bytes.length, digest: `sha256:${sha256(bytes)}` })
      }
      expect(verifyManifest({ manifestBytes: pair.manifest, envelope: pair.signature, registry: production }).tag).toBe(tag)
    }
  })

  it('re-stamp 1.x-last\'s published manifest, changing only the four re-stamped fields', async () => {
    const { registry, v1, describes } = await prepare()
    const { a: before, b: after, changed } = changedFields(published.manifest, v1.bytes)

    expect(changed).toEqual(['expiresAt', 'publishedAt', 'signingKeyId', 'trustedKeyIds'])
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

  // restampV1 re-stamps the newest release with a universal DMG in the list it gets, so the
  // release before 1.x-last is re-stamped from the list as it stood then: a genuinely older
  // update-manifest.json, below the v1 mark 1.x-last's own sets.
  it('re-stamp the release before 1.x-last the same way, for run 3\'s older v1', async () => {
    const { registry, olderV1, olderDescribes, publishedAt } = await prepare()
    const { a: earlier, b: restamped, changed } = changedFields(before.pair.manifest, olderV1.bytes)

    expect(olderDescribes).toBe('v1.7.0')
    expect(changed).toEqual(['expiresAt', 'publishedAt', 'signingKeyId', 'trustedKeyIds'])
    expect(restamped.targets).toEqual(earlier.targets)
    expect(verifyManifest({ manifestBytes: olderV1.bytes, envelope: olderV1.signature, registry, now })).toMatchObject({
      version: '1.7.0',
      publishedAt,
    })
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

  it('pin the macOS installer\'s own options, which the AppImage installer partly shares', () => {
    const start = main.indexOf('function updateInstallers()')
    const end = main.indexOf('\n}\n', start)
    expect(start).toBeGreaterThan(-1)
    const withoutPid = main.slice(0, start) + main.slice(start, end).replace(/\n\s+pid: process\.pid,/, '') + main.slice(end)
    expect(withoutPid).toContain('pid: process.pid,')
    expect(pinFailures(withoutPid, MAIN_PINS.macInstaller)).toEqual(['updateInstallers does not contain "pid: process.pid,"'])
  })
})

describe('the rehearsal summary', () => {
  const host = 'an Intel Mac, x64 process'
  const finished = (...checks: boolean[]) => {
    const report = createReport(() => {})
    report.beginRun('Run 1 (install step)')
    for (const ok of checks) report.check('a check', ok)
    report.handOff()
    return summarize(report, host)
  }

  it('never passes run 1\'s install step: only --run 1 --verify can pass run 1', () => {
    expect(finished(true, true)).toEqual({
      lines: [
        '',
        'Summary',
        'Run 1 (install step): HANDED OFF (2 passed, 0 failed)',
        `Result: HANDED OFF, not a pass until --run 1 --verify passes (on ${host})`,
      ],
      exitCode: EXIT.handedOff,
    })
    expect(finished(true, false)).toMatchObject({ lines: expect.arrayContaining([`Result: FAIL on ${host}`]), exitCode: EXIT.fail })
    expect(new Set(Object.values(EXIT)).size).toBe(4)

    const verify = createReport(() => {})
    verify.beginRun('Run 1 --verify')
    verify.check('a check', true)
    expect(summarize(verify, host)).toEqual({
      lines: ['', 'Summary', 'Run 1 --verify: PASS (1 passed, 0 failed)', `Result: PASS on ${host}`],
      exitCode: EXIT.pass,
    })
  })
})

describe('the hosted-runner override (#381)', () => {
  const hosted = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' }
  // Each lacks one thing a GitHub-hosted runner sets, exactly.
  const elsewhere = [
    {},
    { GITHUB_ACTIONS: 'true' },
    { RUNNER_ENVIRONMENT: 'github-hosted' },
    { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' },
    { GITHUB_ACTIONS: 'false', RUNNER_ENVIRONMENT: 'github-hosted' },
    { GITHUB_ACTIONS: 'TRUE', RUNNER_ENVIRONMENT: 'github-hosted' },
    { GITHUB_ACTIONS: '1', RUNNER_ENVIRONMENT: 'github-hosted' },
    { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'GitHub-hosted' },
    { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted ' },
  ]
  const administrator = 'staff everyone localaccounts _appserverusr admin _appserveradm'

  it('takes effect only with the flag, GITHUB_ACTIONS=true and RUNNER_ENVIRONMENT=github-hosted', () => {
    expect(hostedRunnerOverride(true, hosted)).toEqual({ active: true, refusal: null })
    for (const env of [hosted, ...elsewhere]) {
      // Without the flag nothing changes, wherever it runs; a flag that isn't true is no flag.
      expect(hostedRunnerOverride(false, env)).toEqual({ active: false, refusal: null })
      expect(hostedRunnerOverride('true', env)).toEqual({ active: false, refusal: null })
    }
    for (const env of elsewhere) {
      // With it, anywhere else, it is refused rather than ignored.
      expect(hostedRunnerOverride(true, env), JSON.stringify(env)).toEqual({
        active: false,
        refusal: '--hosted-runner is only for GitHub-hosted runners: it needs GITHUB_ACTIONS=true and RUNNER_ENVIRONMENT=github-hosted',
      })
    }
  })

  it('lifts run 1\'s administrator refusal only when it is in effect', () => {
    const refusal = accountRefusal(administrator, false)
    expect(refusal).toBe('this account is an administrator (or `id -Gn` did not answer): run 1 needs a standard test account (docs/macos-release.md)')
    for (const flag of [false, true]) {
      for (const env of [hosted, ...elsewhere]) {
        const { active } = hostedRunnerOverride(flag, env)
        expect(accountRefusal(administrator, active), `${flag} ${JSON.stringify(env)}`).toBe(flag && env === hosted ? null : refusal)
      }
    }
    expect(accountRefusal('staff everyone localaccounts', false)).toBeNull()
    // An account `id -Gn` can't read is refused even then.
    expect(accountRefusal(null, true)).toBe(refusal)
  })

  it('is off unless the command line asks for it', () => {
    expect(parseOptions(['--run', '1', '--work', 'w']).hostedRunner).toBe(false)
    expect(parseOptions(['--run', '1', '--work', 'w', '--hosted-runner']).hostedRunner).toBe(true)
  })

  it('is refused on the command line outside a GitHub-hosted runner, before anything else happens', () => {
    const work = join(scratchDir('agent-inbox-rehearsal-cli-'), 'work')
    const harness = resolve(import.meta.dirname, 'rehearsal', 'rehearsal.cjs')
    const run = (env: Record<string, string>) => spawnSync(process.execPath, [harness, '--run', '2', '--work', work, '--hosted-runner'], {
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf8',
    })
    const outside: Record<string, string>[] = [{}, { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' }]
    for (const env of outside) {
      const refused = run(env)
      expect(refused.status).toBe(EXIT.refused)
      expect(refused.stdout).toContain('REFUSED  --hosted-runner is only for GitHub-hosted runners')
    }
    // On a hosted runner it passes the gate, and the next check refuses this Node.
    const next = run(hosted)
    expect(next.status).toBe(EXIT.refused)
    expect(next.stdout).not.toContain('--hosted-runner is only')
    expect(next.stdout).toMatch(/REFUSED {2}(the rehearsal runs on macOS only|run this with the installed app's own Electron)/)
    expect(existsSync(work)).toBe(false)
  })

  it('marks every result hosted-runner evidence, not the human gate', () => {
    const host = 'an Intel Mac, x64 process'
    const report = createReport(() => {})
    report.beginRun('Run 2')
    report.check('a check', true)
    expect(summarize(report, host, undefined, true)).toEqual({
      lines: [
        '',
        'Summary',
        'Run 2: PASS (1 passed, 0 failed)',
        'HOSTED RUNNER: hosted-runner evidence, not the human gate (docs/macos-release.md)',
        `Result: PASS on ${host}, hosted-runner evidence, not the human gate`,
      ],
      exitCode: EXIT.pass,
    })
    report.beginRun('Run 1 (install step)')
    report.handOff()
    expect(summarize(report, host, undefined, true).lines.at(-1))
      .toBe(`Result: HANDED OFF, not a pass until --run 1 --verify passes (on ${host}, hosted-runner evidence, not the human gate)`)
  })
})

describe('the published DMG check of the hosted-runner workflow (#381)', () => {
  // A release folder as the workflow downloads it, signed with a scratch key.
  function release() {
    const key = generateKeyPairSync('ed25519')
    const publicKeySpkiBase64 = key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    const keyId = deriveKeyId(publicKeySpkiBase64)
    const registry = { schema: 1 as const, signingKeyId: keyId, keys: [{ keyId, algorithm: 'ed25519' as const, publicKeySpkiBase64 }] }
    const folder = scratchDir('agent-inbox-published-dmg-')
    const filename = 'Agent-Inbox-v1.8.0-universal.dmg'
    const dmg = Buffer.from('a stand-in for the universal DMG')
    writeFileSync(join(folder, filename), dmg)
    const asset = (name: string, platform: 'darwin' | 'linux', architecture: 'universal' | 'arm64' | 'x64', packageType: 'dmg' | 'appimage' | 'deb', bytes: Buffer) => (
      { name, platform, architecture, packageType, size: bytes.length, sha256: sha256(bytes) }
    )
    const assets = [
      asset(filename, 'darwin', 'universal', 'dmg', dmg),
      asset('Agent-Inbox-v1.8.0-linux-arm64.AppImage', 'linux', 'arm64', 'appimage', Buffer.from('arm64 AppImage')),
      asset('agent-inbox_1.8.0_arm64.deb', 'linux', 'arm64', 'deb', Buffer.from('arm64 deb')),
      asset('Agent-Inbox-v1.8.0-linux-x86_64.AppImage', 'linux', 'x64', 'appimage', Buffer.from('x64 AppImage')),
      asset('agent-inbox_1.8.0_amd64.deb', 'linux', 'x64', 'deb', Buffer.from('x64 deb')),
    ]
    const evidence = { tag: 'v1.8.0', packageVersion: '1.8.0', sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), assets }
    const { bytes } = generateManifest({ registry, evidence, minimumMacosVersion: '13.5', publishedAt: '2026-10-28T17:46:28Z' })
    const privateKeyPem = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    writeFileSync(join(folder, 'update-manifest.json'), bytes)
    writeFileSync(join(folder, 'update-manifest.json.sig'), signManifest({ manifestBytes: bytes, registry, privateKeyPem, now: '2026-10-28T18:00:00Z' }).bytes)
    const sums = (entries: Array<{ name: string; sha256: string }>) => entries.map((entry) => `${entry.sha256}  ${entry.name}\n`).join('')
    writeFileSync(join(folder, 'SHA256SUMS.txt'), sums(assets))
    return { folder, registry, filename, dmg, assets, sums }
  }

  it('accepts the DMG SHA256SUMS.txt and the signed update-manifest.json both list', async () => {
    const { folder, registry, filename, dmg } = release()
    await expect(checkPublishedDmg({ folder, version: '1.8.0', registry })).resolves.toEqual({
      dmg: join(folder, filename),
      sha256: sha256(dmg),
      byteLength: dmg.length,
    })
  })

  it('refuses a DMG either list disagrees with, and a manifest the keys did not sign', async () => {
    const changed = release()
    appendFileSync(join(changed.folder, changed.filename), 'x')
    await expect(checkPublishedDmg({ folder: changed.folder, version: '1.8.0', registry: changed.registry })).rejects.toThrow(/is not the one SHA256SUMS\.txt lists/)

    // SHA256SUMS.txt agrees with the changed DMG, the signed manifest doesn't.
    const relisted = release()
    const bytes = Buffer.concat([relisted.dmg, Buffer.from('x')])
    writeFileSync(join(relisted.folder, relisted.filename), bytes)
    writeFileSync(join(relisted.folder, 'SHA256SUMS.txt'), relisted.sums([{ name: relisted.filename, sha256: sha256(bytes) }]))
    await expect(checkPublishedDmg({ folder: relisted.folder, version: '1.8.0', registry: relisted.registry })).rejects.toThrow(/not the file update-manifest\.json describes/)

    const unlisted = release()
    writeFileSync(join(unlisted.folder, 'SHA256SUMS.txt'), unlisted.sums(unlisted.assets.slice(1)))
    await expect(checkPublishedDmg({ folder: unlisted.folder, version: '1.8.0', registry: unlisted.registry })).rejects.toThrow(/lists Agent-Inbox-v1\.8\.0-universal\.dmg 0 times/)

    const other = release()
    await expect(checkPublishedDmg({ folder: other.folder, version: '1.8.0', registry: release().registry })).rejects.toThrow(/signature verification failed/)
    await expect(checkPublishedDmg({ folder: other.folder, version: '1.7.0', registry: other.registry })).rejects.toThrow(/describes v1\.8\.0, not v1\.7\.0/)
  })
})
