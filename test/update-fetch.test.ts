import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import updateController from '../electron/update-controller.cjs'
import updateFetch from '../electron/update-fetch.cjs'
import updatePreferences from '../electron/update-preferences.cjs'
import type { AppImageProbe, UpdateCheckOptions } from '../electron/update-fetch.cjs'
import type { UpdatePreferencesFs, UpdateTrustStateStore } from '../electron/update-preferences.cjs'

const require = createRequire(import.meta.url)
const layer1 = require('../electron/update-manifest.cjs') as typeof import('../electron/update-manifest.cjs')
const {
  deriveKeyId,
  serializeEnvelope,
} = layer1
const {
  MANIFEST_URL,
  SIGNATURE_URL,
  checkForUpdate,
  runsFromAppImage,
} = updateFetch

const now = new Date('2026-02-01T00:00:00Z')
const APPIMAGE_FILE = '/home/tester/Applications/Agent-Inbox-v1.0.0-linux-x86_64.AppImage'
const APPIMAGE_MOUNT = '/tmp/.mount_AgentIn0QvTkK'

/** How /proc/self/mountinfo escapes space, tab, newline and backslash. */
function mangle(value: string) {
  return value.replace(/[ \t\n\\]/g, (char) => `\\${char.charCodeAt(0).toString(8).padStart(3, '0')}`)
}

/** A /proc/self/mountinfo line for a FUSE mount with libfuse's default subtype `name`. */
function fuseLine(mountPoint: string, name: string) {
  return `79 131 0:62 / ${mangle(mountPoint)} ro,nosuid,nodev,relatime - fuse.${mangle(name)} ${mangle(name)} ro,user_id=1000,group_id=1000`
}

/**
 * The pinned type2-runtime's mount of `image` at `mountPoint` as the AppImage proof
 * reads it: a mount point (its device differs from its parent's) whose mountinfo
 * entry carries the image's file name as type `fuse.<name>` and as its source.
 */
function fuseMount(image: string, mountPoint: string, mountInfo = `${fuseLine(mountPoint, basename(image))}\n`): AppImageProbe {
  return {
    lstat: (target) => ({ dev: target === mountPoint ? 62n : 60n, isDirectory: () => true }),
    mountInfo: () => mountInfo,
  }
}

// The AppImage runtime's variables and where Electron runs from inside its mount.
const APPIMAGE_HOST = {
  appImagePath: APPIMAGE_FILE,
  appDir: APPIMAGE_MOUNT,
  execPath: `${APPIMAGE_MOUNT}/usr/lib/agent-inbox/Agent Inbox`,
  appImageProbe: fuseMount(APPIMAGE_FILE, APPIMAGE_MOUNT),
}

function signedFixture(version = '2.0.0') {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeySpkiBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  const keyId = deriveKeyId(publicKeySpkiBase64)
  const registry = {
    schema: 1 as const,
    signingKeyId: keyId,
    keys: [{ keyId, algorithm: 'ed25519' as const, publicKeySpkiBase64 }],
  }
  const tag = `v${version}`
  const releaseBase = `https://github.com/shariqh/agent-inbox/releases/download/${tag}`
  const target = (
    platform: 'darwin' | 'linux',
    architecture: 'universal' | 'arm64' | 'x64',
    packageType: 'dmg' | 'appimage' | 'deb',
    filename: string,
    installStrategy: 'macos-dmg' | 'appimage-self-replace' | 'deb-notify',
  ) => ({
    platform,
    architecture,
    packageType,
    filename,
    url: `${releaseBase}/${filename}`,
    byteLength: 123,
    sha256: 'a'.repeat(64),
    installStrategy,
    ...(platform === 'darwin' ? { minimumSystemVersion: '13.5' } : {}),
  })
  const publishedAt = '2026-01-01T00:00:00Z'
  const expiresAt = new Date(Date.parse(publishedAt) + 180 * 86_400_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
  const manifest = {
    schema: 1,
    kind: 'agent-inbox-update-manifest',
    repository: 'shariqh/agent-inbox',
    version,
    tag,
    source: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    publishedAt,
    expiresAt,
    releaseUrl: `https://github.com/shariqh/agent-inbox/releases/tag/${tag}`,
    signingKeyId: keyId,
    trustedKeyIds: [keyId],
    targets: [
      target('darwin', 'universal', 'dmg', `Agent-Inbox-${tag}-universal.dmg`, 'macos-dmg'),
      target('linux', 'arm64', 'appimage', `Agent-Inbox-v${version}-linux-arm64.AppImage`, 'appimage-self-replace'),
      target('linux', 'arm64', 'deb', `agent-inbox_${version}_arm64.deb`, 'deb-notify'),
      target('linux', 'x64', 'appimage', `Agent-Inbox-v${version}-linux-x86_64.AppImage`, 'appimage-self-replace'),
      target('linux', 'x64', 'deb', `agent-inbox_${version}_amd64.deb`, 'deb-notify'),
    ],
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  const envelope = {
    schema: 1 as const,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    signatures: [{
      algorithm: 'ed25519' as const,
      keyId,
      signature: sign(null, manifestBytes, privateKey).toString('base64'),
    }],
  }
  return {
    registry,
    manifestBytes,
    signatureBytes: serializeEnvelope(envelope),
    manifest,
    privateKey,
  }
}

function response(body: BodyInit | Buffer | null, status = 200, headers?: HeadersInit) {
  return new Response(body as BodyInit | null, { status, headers })
}

function baseOptions(
  fixture = signedFixture(),
  overrides: Partial<UpdateCheckOptions> = {},
): UpdateCheckOptions {
  const fetchImpl = vi.fn(async (url: string) => {
    if (url === MANIFEST_URL) return response(fixture.manifestBytes)
    if (url === SIGNATURE_URL) return response(fixture.signatureBytes)
    throw new Error(`unexpected URL ${url}`)
  })
  return {
    fetchImpl,
    registry: fixture.registry,
    currentVersion: '1.0.0',
    platform: 'darwin',
    arch: 'arm64',
    isPackaged: true,
    now: () => now,
    ...overrides,
  }
}

describe('signed update fetching', () => {
  it('uses exact immutable latest-release endpoints and minimal fetch metadata', async () => {
    const fixture = signedFixture()
    const options = baseOptions(fixture)
    const result = await checkForUpdate(options)

    expect(MANIFEST_URL).toBe('https://github.com/shariqh/agent-inbox/releases/latest/download/update-manifest.json')
    expect(SIGNATURE_URL).toBe('https://github.com/shariqh/agent-inbox/releases/latest/download/update-manifest.json.sig')
    expect(options.fetchImpl).toHaveBeenCalledTimes(2)
    for (const [url, init] of vi.mocked(options.fetchImpl).mock.calls) {
      expect(url).not.toContain('?')
      expect(init).toMatchObject({ redirect: 'manual' })
      expect(Object.keys(init?.headers ?? {})).toEqual(['cache-control'])
    }
    expect(result.status).toBe('available')
    expect(result.available).toEqual({
      version: '2.0.0',
      tag: 'v2.0.0',
      releaseUrl: 'https://github.com/shariqh/agent-inbox/releases/tag/v2.0.0',
      target: { packageType: 'dmg', installStrategy: 'macos-dmg' },
    })
    expect(JSON.stringify(result)).not.toContain('/download/')
  })

  it('validates every redirect hop and accepts five safe hops', async () => {
    const fixture = signedFixture()
    const hops = [
      'https://github.com/shariqh/agent-inbox/releases/download/v2.0.0/update-manifest.json',
      'https://release-assets.githubusercontent.com/github-production-release-asset/1/2?token=one',
      'https://objects.githubusercontent.com/github-production-release-asset/1/3?token=two',
      'https://release-assets.githubusercontent.com/github-production-release-asset/1/4?token=three',
      'https://objects.githubusercontent.com/github-production-release-asset/1/5?token=four',
    ]
    let manifestCall = 0
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === SIGNATURE_URL) return response(fixture.signatureBytes)
      if (manifestCall < hops.length) {
        return response(null, 302, { location: hops[manifestCall++]! })
      }
      return response(fixture.manifestBytes)
    })
    const result = await checkForUpdate(baseOptions(fixture, { fetchImpl }))
    expect(result.status).toBe('available')
    expect(fetchImpl).toHaveBeenCalledTimes(7)
  })

  it('cancels each accepted redirect response before following it', async () => {
    const fixture = signedFixture()
    const cancelRedirect = vi.fn(async () => {})
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === MANIFEST_URL) {
        return {
          status: 302,
          headers: new Headers({
            location: 'https://github.com/shariqh/agent-inbox/releases/download/v2.0.0/update-manifest.json',
          }),
          body: { cancel: cancelRedirect },
        }
      }
      if (url.endsWith('/update-manifest.json')) return response(fixture.manifestBytes)
      return response(fixture.signatureBytes)
    })

    await expect(checkForUpdate(baseOptions(fixture, { fetchImpl }))).resolves.toMatchObject({ status: 'available' })
    expect(cancelRedirect).toHaveBeenCalledOnce()
  })

  it.each([
    'https://evilgithubusercontent.com/github-production-release-asset/1/2',
    'https://release-assets.githubusercontent.com/not-a-release-asset/1/2',
    'https://github.com/other/repo/releases/download/v2.0.0/update-manifest.json',
    'http://github.com/shariqh/agent-inbox/releases/download/v2.0.0/update-manifest.json',
    'https://user:pass@github.com/shariqh/agent-inbox/releases/download/v2.0.0/update-manifest.json',
  ])('rejects an unsafe redirect target: %s', async (location) => {
    const fixture = signedFixture()
    const cancel = vi.fn(async () => {})
    let signal: AbortSignal | undefined
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return url === MANIFEST_URL
        ? { status: 302, headers: new Headers({ location }), body: { cancel } }
        : response(fixture.signatureBytes)
    })
    await expect(checkForUpdate(baseOptions(fixture, { fetchImpl }))).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledOnce()
    expect(signal?.aborted).toBe(true)
  })

  it('rejects more than five redirects', async () => {
    const fixture = signedFixture()
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      return response(null, 302, {
        location: `https://github.com/shariqh/agent-inbox/releases/download/v2.0.0/update-manifest.json`,
      })
    })
    await expect(checkForUpdate(baseOptions(fixture, { fetchImpl }))).rejects.toThrow()
    expect(calls).toBe(6)
  })

  it.each([
    ['manifest', 256 * 1024 + 1],
    ['signature', 16 * 1024 + 1],
  ] as const)('rejects oversized %s Content-Length before reading', async (kind, size) => {
    const fixture = signedFixture()
    const cancel = vi.fn(async () => {})
    let signal: AbortSignal | undefined
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      if ((kind === 'manifest') === (url === MANIFEST_URL)) {
        return {
          status: 200,
          headers: new Headers({ 'content-length': String(size) }),
          body: { cancel },
        }
      }
      return url === MANIFEST_URL
        ? response(fixture.manifestBytes)
        : response(fixture.signatureBytes)
    })
    await expect(checkForUpdate(baseOptions(fixture, { fetchImpl }))).rejects.toThrow()
    expect(cancel).toHaveBeenCalledOnce()
    expect(signal?.aborted).toBe(true)
  })

  it.each([
    ['manifest', 256 * 1024],
    ['signature', 16 * 1024],
  ] as const)('rejects streaming %s overflow without arrayBuffer()', async (kind, cap) => {
    const fixture = signedFixture()
    const cancel = vi.fn(async () => {})
    const chunks = [new Uint8Array(cap), new Uint8Array(1)]
    let signal: AbortSignal | undefined
    const oversized = {
      status: 200,
      headers: new Headers(),
      body: {
        getReader() {
          return {
            async read() {
              const value = chunks.shift()
              return value ? { done: false, value } : { done: true }
            },
            cancel,
            releaseLock() {},
          }
        },
      },
    }
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      if ((kind === 'manifest') === (url === MANIFEST_URL)) return oversized
      return url === MANIFEST_URL
        ? response(fixture.manifestBytes)
        : response(fixture.signatureBytes)
    })
    await expect(checkForUpdate(baseOptions(fixture, { fetchImpl }))).rejects.toThrow()
    expect(cancel).toHaveBeenCalledOnce()
    expect(signal?.aborted).toBe(true)
  })

  it('uses one abort deadline across response headers and body', async () => {
    vi.useFakeTimers()
    try {
      const fixture = signedFixture()
      const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }))
      const pending = checkForUpdate(baseOptions(fixture, {
        fetchImpl,
        timeoutMs: 500,
        setTimeoutImpl: setTimeout,
        clearTimeoutImpl: clearTimeout,
      }))
      const rejection = expect(pending).rejects.toThrow()
      await vi.advanceTimersByTimeAsync(500)
      await rejection
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('applies the same abort deadline while streaming a response body', async () => {
    vi.useFakeTimers()
    try {
      const fixture = signedFixture()
      const cancel = vi.fn(async () => {})
      const hangingResponse = {
        status: 200,
        headers: new Headers(),
        body: {
          getReader() {
            return {
              read: () => new Promise<never>(() => {}),
              cancel,
              releaseLock() {},
            }
          },
        },
      }
      const pending = checkForUpdate(baseOptions(fixture, {
        fetchImpl: vi.fn(async () => hangingResponse),
        timeoutMs: 500,
        setTimeoutImpl: setTimeout,
        clearTimeoutImpl: clearTimeout,
      }))
      const rejection = expect(pending).rejects.toThrow()
      await vi.advanceTimersByTimeAsync(500)
      await rejection
      expect(cancel).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails closed on network errors and tears down non-2xx final responses', async () => {
    const fixture = signedFixture()
    await expect(checkForUpdate(baseOptions(fixture, {
      fetchImpl: vi.fn(async () => { throw new Error('secret proxy detail') }),
    }))).rejects.toThrow()
    const cancel = vi.fn(async () => {})
    let signal: AbortSignal | undefined
    await expect(checkForUpdate(baseOptions(fixture, {
      fetchImpl: vi.fn(async (_url: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined
        return { status: 500, headers: new Headers(), body: { cancel } }
      }),
    }))).rejects.toThrow()
    expect(cancel).toHaveBeenCalledOnce()
    expect(signal?.aborted).toBe(true)
  })
})

describe('verification, versions, and targets', () => {
  it('accepts only exact stable versions and never offers equal or lower versions', async () => {
    expect((await checkForUpdate(baseOptions(signedFixture('2.0.0'), { currentVersion: '2.0.0' }))).status).toBe('current')
    expect((await checkForUpdate(baseOptions(signedFixture('1.9.9'), { currentVersion: '2.0.0' }))).status).toBe('current')
    await expect(checkForUpdate(baseOptions(signedFixture(), { currentVersion: '2.0' }))).rejects.toThrow()
  })

  it('fails verification for tampered, wrong-key, expired, and unknown-only signatures', async () => {
    const valid = signedFixture()
    const tampered = Buffer.from(valid.manifestBytes)
    const tamperIndex = tampered.length - 2
    tampered[tamperIndex] = (tampered[tamperIndex] ?? 0) ^ 1
    await expect(checkForUpdate(baseOptions(valid, {
      fetchImpl: vi.fn(async (url: string) => response(url === MANIFEST_URL ? tampered : valid.signatureBytes)),
    }))).rejects.toThrow()

    const wrong = signedFixture()
    const wrongSignature = serializeEnvelope({
      schema: 1,
      manifestSha256: createHash('sha256').update(valid.manifestBytes).digest('hex'),
      signatures: [{
        algorithm: 'ed25519',
        keyId: valid.registry.signingKeyId,
        signature: sign(null, valid.manifestBytes, wrong.privateKey).toString('base64'),
      }],
    })
    await expect(checkForUpdate(baseOptions(valid, {
      fetchImpl: vi.fn(async (url: string) => response(url === MANIFEST_URL ? valid.manifestBytes : wrongSignature)),
    }))).rejects.toThrow()

    await expect(checkForUpdate(baseOptions(valid, { now: () => new Date('2027-01-01T00:00:00Z') }))).rejects.toThrow()

    const unknown = signedFixture()
    const unknownSignature = serializeEnvelope({
      schema: 1,
      manifestSha256: createHash('sha256').update(valid.manifestBytes).digest('hex'),
      signatures: [{
        algorithm: 'ed25519',
        keyId: unknown.registry.signingKeyId,
        signature: sign(null, valid.manifestBytes, unknown.privateKey).toString('base64'),
      }],
    })
    await expect(checkForUpdate(baseOptions(valid, {
      fetchImpl: vi.fn(async (url: string) => response(url === MANIFEST_URL ? valid.manifestBytes : unknownSignature)),
    }))).rejects.toThrow()
  })

  it.each([
    [{ platform: 'darwin', arch: 'x64', isPackaged: true }, 'dmg'],
    [{ platform: 'darwin', arch: 'arm64', isPackaged: true }, 'dmg'],
    [{ platform: 'linux', arch: 'x64', isPackaged: true, ...APPIMAGE_HOST }, 'appimage'],
    [{ platform: 'linux', arch: 'arm64', isPackaged: true, ...APPIMAGE_HOST }, 'appimage'],
    [{ platform: 'linux', arch: 'x64', isPackaged: true }, 'deb'],
    [{ platform: 'linux', arch: 'arm64', isPackaged: true }, 'deb'],
  ] as const)('selects the exact packaged target for %o', async (host, packageType) => {
    const result = await checkForUpdate(baseOptions(signedFixture(), host))
    expect(result.status).toBe('available')
    expect(result.available?.target.packageType).toBe(packageType)
    expect('artifact' in result).toBe(false)
  })

  it.each([
    [{ platform: 'darwin', arch: 'arm64', isPackaged: true }, 'darwin', 'universal', 'dmg'],
    [{ platform: 'linux', arch: 'x64', isPackaged: true, ...APPIMAGE_HOST }, 'linux', 'x64', 'appimage'],
    [{ platform: 'linux', arch: 'arm64', isPackaged: true }, 'linux', 'arm64', 'deb'],
  ] as const)('attaches the signed target for the main-process downloader only on request: %o', async (host, platform, architecture, packageType) => {
    const fixture = signedFixture()
    const result = await checkForUpdate(baseOptions(fixture, { ...host, includeArtifact: true }))
    const target = fixture.manifest.targets.find((candidate) => (
      candidate.platform === platform
      && candidate.architecture === architecture
      && candidate.packageType === packageType
    ))!

    expect(result.artifact).toEqual({ version: '2.0.0', tag: 'v2.0.0', ...target })
    expect(result.available?.target).toEqual({
      packageType: target.packageType,
      installStrategy: target.installStrategy,
    })
    expect(Object.isFrozen(result.artifact)).toBe(true)
  })

  // A .deb install started from inside another AppImage inherits that image's
  // APPIMAGE and APPDIR but runs from /opt, so it must keep its deb-notify offer.
  it.each([
    ['a stray inherited APPIMAGE and APPDIR', { execPath: '/opt/Agent Inbox/agent-inbox' }],
    ['APPIMAGE without APPDIR', { appDir: undefined }],
    ['an empty APPIMAGE', { appImagePath: '' }],
    ['a relative APPIMAGE', { appImagePath: 'Agent-Inbox.AppImage' }],
    ['a relative APPDIR', { appDir: '.mount_AgentIn0QvTkK' }],
    ['a non-canonical APPDIR', { appDir: '/tmp/.mount_AgentIn0QvTkK/../.mount_AgentIn0QvTkK' }],
    ['APPDIR at the filesystem root', { appDir: '/' }],
    ['an executable in a sibling folder sharing the APPDIR prefix', { execPath: '/tmp/.mount_AgentIn0QvTkK-other/agent-inbox' }],
    ['an executable that is APPDIR itself', { execPath: '/tmp/.mount_AgentIn0QvTkK' }],
    ['no executable path', { execPath: undefined }],
    // An extracted squashfs-root started from a shell that another AppImage runs: our
    // AppRun points APPDIR at that plain folder, while APPIMAGE still names the other image.
    ['an extracted squashfs-root whose APPDIR is not a mount', {
      appImagePath: '/home/tester/Applications/Other.AppImage',
      appDir: '/home/tester/squashfs-root',
      execPath: '/home/tester/squashfs-root/usr/lib/agent-inbox/Agent Inbox',
      appImageProbe: { lstat: () => ({ dev: 60n, isDirectory: () => true }), mountInfo: () => '' },
    }],
    // Our image mounted by hand and its AppRun started the same way: a FUSE mount, of another file.
    ['an APPDIR mounted from another image than APPIMAGE names', { appImagePath: '/home/tester/Applications/Other.AppImage' }],
    ['this machine, where nothing is mounted at that APPDIR', { appImageProbe: undefined }],
  ])('keeps the deb target for %s', async (_label, overrides) => {
    const fixture = signedFixture()
    const host = { platform: 'linux', arch: 'x64', isPackaged: true, ...APPIMAGE_HOST, ...overrides }
    const result = await checkForUpdate(baseOptions(fixture, { ...host, includeArtifact: true }))

    expect(result.available?.target).toEqual({ packageType: 'deb', installStrategy: 'deb-notify' })
    expect(result.artifact?.packageType).toBe('deb')
  })

  it('exports the AppImage proof the AppImage installer applies too', () => {
    expect(runsFromAppImage(APPIMAGE_HOST)).toBe(true)
    expect(runsFromAppImage({ ...APPIMAGE_HOST, execPath: '/opt/Agent Inbox/agent-inbox' })).toBe(false)
    expect(runsFromAppImage({})).toBe(false)
  })

  // APPDIR must be the pinned runtime's FUSE mount of the file APPIMAGE names, not just
  // a folder that contains the executable (#210: an extracted squashfs-root inherits
  // another AppImage's APPIMAGE and would have replaced that application's file).
  it('accepts APPDIR only as the runtime FUSE mount of the image APPIMAGE names', () => {
    const name = basename(APPIMAGE_FILE)
    const ours = fuseLine(APPIMAGE_MOUNT, name)
    const tmpfsOver = `80 79 0:63 / ${APPIMAGE_MOUNT} rw,relatime - tmpfs tmpfs rw`
    const mountedAt = (mountInfo: string) => fuseMount(APPIMAGE_FILE, APPIMAGE_MOUNT, mountInfo)
    const cases: Array<[label: string, probe: AppImageProbe, expected: boolean]> = [
      ['the FUSE mount of that image', mountedAt(`${ours}\n`), true],
      ['the same among other mounts, with optional fields', mountedAt([
        '22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw',
        'garbage',
        `78 22 0:61 / ${APPIMAGE_MOUNT} ro - fuse.${name}`,
        `79 22 0:62 / ${APPIMAGE_MOUNT} ro,nosuid,nodev,relatime shared:7 master:2 - fuse.${name} ${name} ro,user_id=1000`,
        '',
      ].join('\n')), true],
      ['a FUSE mount over an earlier mount at APPDIR', mountedAt(`${tmpfsOver}\n${ours}\n`), true],
      ['a plain folder: the same device as its parent', { ...mountedAt(`${ours}\n`), lstat: () => ({ dev: 60n, isDirectory: () => true }) }, false],
      ['an APPDIR that is not a directory', { ...mountedAt(`${ours}\n`), lstat: (target) => ({ dev: target === APPIMAGE_MOUNT ? 62n : 60n, isDirectory: () => false }) }, false],
      ['no mount entry at APPDIR', mountedAt(`${fuseLine(`${APPIMAGE_MOUNT}-other`, name)}\n`), false],
      ['a FUSE mount of another image', mountedAt(`${fuseLine(APPIMAGE_MOUNT, 'Other.AppImage')}\n`), false],
      ['another FUSE subtype', mountedAt(`79 131 0:62 / ${APPIMAGE_MOUNT} ro - fuse.squashfuse ${name} ro\n`), false],
      ['another source', mountedAt(`79 131 0:62 / ${APPIMAGE_MOUNT} ro - fuse.${name} squashfuse ro\n`), false],
      ['a filesystem that is not FUSE', mountedAt(`79 131 0:62 / ${APPIMAGE_MOUNT} ro - squashfs ${name} ro\n`), false],
      ['a later mount that hides the FUSE mount', mountedAt(`${ours}\n${tmpfsOver}\n`), false],
      ['an unreadable mountinfo', { ...mountedAt(''), mountInfo: () => { throw new Error('ENOENT') } }, false],
      ['an APPDIR that cannot be examined', { ...mountedAt(`${ours}\n`), lstat: () => { throw new Error('EACCES') } }, false],
    ]
    for (const [label, appImageProbe, expected] of cases) {
      expect(runsFromAppImage({ ...APPIMAGE_HOST, appImageProbe }), label).toBe(expected)
    }

    // mountinfo escapes space, tab, newline and backslash in paths and names.
    const image = '/home/tester/My Apps/Agent Inbox.AppImage'
    const mount = '/home/tester/my tmp/.mount_Agent IXyZ12'
    const spaced = { appImagePath: image, appDir: mount, execPath: `${mount}/usr/lib/agent-inbox/Agent Inbox` }
    expect(runsFromAppImage({ ...spaced, appImageProbe: fuseMount(image, mount) })).toBe(true)
    expect(runsFromAppImage({ ...spaced, appImageProbe: fuseMount(image, mount, `79 131 0:62 / ${mount} ro - fuse.${basename(image)} ${basename(image)} ro\n`) })).toBe(false)

    // libfuse's option parser drops a backslash from the name it mounts under, so
    // `Agent Inbox\Beta.AppImage` mounts as `fuse.Agent InboxBeta.AppImage`. The proof
    // does not try to undo that: such a rare name fails safe to a notify-only offer.
    const slashed = '/home/tester/My Apps/Agent Inbox\\Beta.AppImage'
    const asLibfuseMountsIt = fuseMount(slashed, mount, `${fuseLine(mount, 'Agent InboxBeta.AppImage')}\n`)
    expect(runsFromAppImage({ ...spaced, appImagePath: slashed, appImageProbe: asLibfuseMountsIt })).toBe(false)
  })

  it('never attaches an artifact when no newer release is offered', async () => {
    const current = await checkForUpdate(baseOptions(signedFixture('1.0.0'), { includeArtifact: true }))
    const unsupported = await checkForUpdate(baseOptions(signedFixture(), { includeArtifact: true, platform: 'win32' }))
    expect(current.status).toBe('current')
    expect(unsupported.status).toBe('unsupported')
    expect('artifact' in current || 'artifact' in unsupported).toBe(false)
  })

  it.each([
    { platform: 'win32', arch: 'x64', isPackaged: true },
    { platform: 'darwin', arch: 'ia32', isPackaged: true },
    { platform: 'linux', arch: 'x64', isPackaged: false },
  ])('returns a safe unsupported state for %o', async (host) => {
    const result = await checkForUpdate(baseOptions(signedFixture(), host))
    expect(result).toMatchObject({ status: 'unsupported' })
    expect(result.available).toBeUndefined()
  })
})

describe('rollback high-water mark (#148)', () => {
  const { createUpdateController } = updateController
  const { createUpdatePreferences, createUpdateTrustState } = updatePreferences
  const root = resolve(import.meta.dirname, '..')
  const workDirs: string[] = []
  const legacyPreferences = '{"schema":1,"automaticChecks":true,"lastNotifiedVersion":"1.2.8"}'
  type Fixture = ReturnType<typeof signedFixture>

  afterEach(() => {
    for (const dir of workDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function userData() {
    const dir = join(root, `.test-update-high-water-${process.pid}-${workDirs.length}`)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    workDirs.push(dir)
    return {
      dir,
      preferencesPath: join(dir, 'update-preferences.json'),
      trustPath: join(dir, 'update-trust-state.json'),
    }
  }

  function seedMark(trustPath: string, highestVerifiedVersion: string) {
    const bytes = JSON.stringify({ schema: 1, highestVerifiedVersion })
    writeFileSync(trustPath, bytes)
    return bytes
  }

  function failingWrites(code: string, failures = Number.POSITIVE_INFINITY): UpdatePreferencesFs {
    let remaining = failures
    return {
      readFile: (path) => readFile(path),
      async writeFile(path, data, options) {
        if (remaining > 0) {
          remaining -= 1
          throw Object.assign(new Error(`write refused (${code})`), { code })
        }
        return writeFile(path, data, options)
      },
      rename: (from, to) => rename(from, to),
      unlink: (path) => unlink(path),
      mkdir: (path, options) => mkdir(path, options),
    }
  }

  // Wires the real controller, verifier and both userData stores the way electron/main.cjs does.
  function updater(options: {
    currentVersion: string
    dir: string
    fixtures: Fixture[]
    trustFs?: UpdatePreferencesFs
    wrapTrustState?: (store: UpdateTrustStateStore) => UpdateTrustStateStore
  }) {
    const [first] = options.fixtures
    let served = first!
    let clock = now
    const timers: Array<{ callback: () => unknown; delay: number }> = []
    const registry = {
      schema: 1 as const,
      signingKeyId: first!.registry.signingKeyId,
      keys: options.fixtures.flatMap((fixture) => fixture.registry.keys),
    }
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === MANIFEST_URL) return response(served.manifestBytes)
      if (url === SIGNATURE_URL) return response(served.signatureBytes)
      throw new Error(`unexpected URL ${url}`)
    })
    const app = { getPath: () => options.dir }
    const preferences = createUpdatePreferences({ app })
    const trustState = createUpdateTrustState({ app, fsImpl: options.trustFs })
    const notifier = vi.fn()
    const controller = createUpdateController({
      currentVersion: options.currentVersion,
      preferences,
      trustState: options.wrapTrustState ? options.wrapTrustState(trustState) : trustState,
      checker: ({ currentVersion, automaticChecks, recordVerifiedVersion }) => checkForUpdate({
        fetchImpl,
        registry,
        currentVersion,
        automaticChecks,
        recordVerifiedVersion,
        platform: 'darwin',
        arch: 'arm64',
        isPackaged: true,
        now: () => clock,
      }),
      notifier,
      clock: () => clock,
      setTimeoutImpl: (callback, delay) => {
        const timer = { callback, delay }
        timers.push(timer)
        return timer
      },
      clearTimeoutImpl: (timer) => {
        const index = timers.indexOf(timer)
        if (index !== -1) timers.splice(index, 1)
      },
      random: () => 0.5,
      initialDelayMs: 0,
    })
    return {
      controller,
      notifier,
      timers,
      serve(fixture: Fixture) {
        served = fixture
      },
      setNow(value: Date) {
        clock = value
      },
      async checkEach(...fixtures: Fixture[]) {
        const results: Array<[string, string | undefined]> = []
        for (const fixture of fixtures) {
          served = fixture
          const result = await controller.checkNow()
          results.push([result.status, result.available?.version])
        }
        return results
      },
      mark() {
        return JSON.parse(readFileSync(join(options.dir, 'update-trust-state.json'), 'utf8')).highestVerifiedVersion as unknown
      },
    }
  }

  it('offers newer releases, treats an equal release as current, and refuses an older signed manifest', async () => {
    const paths = userData()
    writeFileSync(paths.preferencesPath, legacyPreferences)
    const [v2, v3, v21] = ['2.0.0', '3.0.0', '2.1.0'].map((version) => signedFixture(version)) as [Fixture, Fixture, Fixture]
    const update = updater({ currentVersion: '2.0.0', dir: paths.dir, fixtures: [v2, v3, v21] })

    await expect(update.checkEach(v2, v3, v21)).resolves.toEqual([
      ['current', undefined],
      ['available', '3.0.0'],
      ['stale', undefined],
    ])
    expect(update.mark()).toBe('3.0.0')
    expect(update.controller.getState()).toEqual({
      status: 'stale',
      currentVersion: '2.0.0',
      automaticChecks: true,
      checkedAt: now.toISOString(),
      message: 'Update information is older than a release this app already verified.',
    })
    expect(readFileSync(paths.preferencesPath, 'utf8')).toBe(legacyPreferences)
  })

  it('still offers the newest release at or above the mark after a deliberate downgrade', async () => {
    const paths = userData()
    seedMark(paths.trustPath, '3.0.0')
    const [v25, v3, v31] = ['2.5.0', '3.0.0', '3.1.0'].map((version) => signedFixture(version)) as [Fixture, Fixture, Fixture]
    const update = updater({ currentVersion: '2.0.0', dir: paths.dir, fixtures: [v25, v3, v31] })

    await expect(update.checkEach(v25, v3, v31)).resolves.toEqual([
      ['stale', undefined],
      ['available', '3.0.0'],
      ['available', '3.1.0'],
    ])
    expect(update.mark()).toBe('3.1.0')
  })

  it('reports stale information without notifying, keeps the daily schedule, and leaves preferences 1.2.x-readable', async () => {
    const paths = userData()
    writeFileSync(paths.preferencesPath, legacyPreferences)
    const [v3, v2, v31] = ['3.0.0', '2.0.0', '3.1.0'].map((version) => signedFixture(version)) as [Fixture, Fixture, Fixture]
    const update = updater({ currentVersion: '1.0.0', dir: paths.dir, fixtures: [v3, v2, v31] })
    const notifiedPreferences = '{\n  "schema": 1,\n  "automaticChecks": true,\n  "lastNotifiedVersion": "3.0.0"\n}\n'
    const runScheduled = async () => {
      const timer = update.timers.shift()
      expect(timer).toBeDefined()
      await timer!.callback()
      return update.controller.getState()
    }

    await update.controller.rendererReady()
    await expect(runScheduled()).resolves.toMatchObject({ status: 'available', available: { version: '3.0.0' } })
    expect(update.notifier).toHaveBeenCalledTimes(1)
    expect(readFileSync(paths.preferencesPath, 'utf8')).toBe(notifiedPreferences)

    update.serve(v2)
    await expect(runScheduled()).resolves.toMatchObject({ status: 'stale', automaticChecks: true })
    expect(update.notifier).toHaveBeenCalledTimes(1)
    expect(readFileSync(paths.preferencesPath, 'utf8')).toBe(notifiedPreferences)
    expect(update.mark()).toBe('3.0.0')
    expect(update.timers.map((timer) => timer.delay)).toEqual([24 * 60 * 60_000])

    update.serve(v31)
    await expect(runScheduled()).resolves.toMatchObject({ status: 'available', available: { version: '3.1.0' } })
    expect(update.notifier).toHaveBeenCalledTimes(2)
    expect(update.notifier).toHaveBeenLastCalledWith(expect.objectContaining({ version: '3.1.0' }))
  })

  it('keeps the mark when preferences are rewritten by a 1.2.x build or deleted', async () => {
    const paths = userData()
    writeFileSync(paths.preferencesPath, legacyPreferences)
    const [v3, v25] = ['3.0.0', '2.5.0'].map((version) => signedFixture(version)) as [Fixture, Fixture]
    const relaunch = () => updater({ currentVersion: '2.0.0', dir: paths.dir, fixtures: [v3, v25] })
    await expect(relaunch().checkEach(v3)).resolves.toEqual([['available', '3.0.0']])

    writeFileSync(paths.preferencesPath, '{"schema":1,"automaticChecks":true,"lastNotifiedVersion":null}')
    await expect(relaunch().checkEach(v25)).resolves.toEqual([['stale', undefined]])
    rmSync(paths.preferencesPath)
    await expect(relaunch().checkEach(v25)).resolves.toEqual([['stale', undefined]])
  })

  it('falls back to the running version when the trust state is corrupt, without touching preferences', async () => {
    const paths = userData()
    writeFileSync(paths.preferencesPath, legacyPreferences)
    writeFileSync(paths.trustPath, '{"schema":1,"highestVerifiedVersion":"9.')
    const [v09, v2] = ['0.9.0', '2.0.0'].map((version) => signedFixture(version)) as [Fixture, Fixture]
    const update = updater({ currentVersion: '1.0.0', dir: paths.dir, fixtures: [v09, v2] })

    await expect(update.checkEach(v09, v2)).resolves.toEqual([
      ['current', undefined],
      ['available', '2.0.0'],
    ])
    expect(readFileSync(paths.trustPath, 'utf8')).toBe('{\n  "schema": 1,\n  "highestVerifiedVersion": "2.0.0"\n}\n')
    expect(readFileSync(paths.preferencesPath, 'utf8')).toBe(legacyPreferences)
  })

  it('enforces the mark from a newer trust-state schema without overwriting it', async () => {
    const paths = userData()
    const newer = '{"schema":2,"highestVerifiedVersion":"3.0.0","trustedKeyIds":[]}'
    writeFileSync(paths.trustPath, newer)
    const [v25, v31] = ['2.5.0', '3.1.0'].map((version) => signedFixture(version)) as [Fixture, Fixture]
    const update = updater({ currentVersion: '2.0.0', dir: paths.dir, fixtures: [v25, v31] })

    await expect(update.checkEach(v25, v31)).resolves.toEqual([
      ['stale', undefined],
      ['available', '3.1.0'],
    ])
    expect(readFileSync(paths.trustPath, 'utf8')).toBe(newer)
  })

  it('never lets a tampered, unpinned, or expired manifest touch the mark', async () => {
    const paths = userData()
    const seeded = seedMark(paths.trustPath, '2.0.0')
    const v3 = signedFixture('3.0.0')
    const tampered = Buffer.from(v3.manifestBytes)
    const tamperIndex = tampered.length - 2
    tampered[tamperIndex] = (tampered[tamperIndex] ?? 0) ^ 1
    const update = updater({ currentVersion: '1.0.0', dir: paths.dir, fixtures: [v3] })

    await expect(update.checkEach(
      { ...v3, manifestBytes: tampered },
      signedFixture('4.0.0'),
    )).resolves.toEqual([['unverified', undefined], ['unverified', undefined]])
    update.setNow(new Date('2027-01-01T00:00:00Z'))
    await expect(update.checkEach(v3)).resolves.toEqual([['unverified', undefined]])
    expect(readFileSync(paths.trustPath, 'utf8')).toBe(seeded)

    update.setNow(now)
    await expect(update.checkEach(v3)).resolves.toEqual([['available', '3.0.0']])
    expect(update.mark()).toBe('3.0.0')
  })

  it('keeps the stored mark and still offers newer releases when writes fail', async () => {
    const paths = userData()
    const seeded = seedMark(paths.trustPath, '3.0.0')
    const [v25, v31] = ['2.5.0', '3.1.0'].map((version) => signedFixture(version)) as [Fixture, Fixture]
    const update = updater({ currentVersion: '2.0.0', dir: paths.dir, fixtures: [v25, v31], trustFs: failingWrites('EROFS') })

    await expect(update.checkEach(v25, v31)).resolves.toEqual([
      ['stale', undefined],
      ['available', '3.1.0'],
    ])
    expect(readFileSync(paths.trustPath, 'utf8')).toBe(seeded)
  })

  it('enforces the still-readable mark when the trust store refuses to record', async () => {
    const paths = userData()
    seedMark(paths.trustPath, '3.0.0')
    const v25 = signedFixture('2.5.0')
    const update = updater({
      currentVersion: '2.0.0',
      dir: paths.dir,
      fixtures: [v25],
      wrapTrustState: (store) => ({
        read: () => store.read(),
        async recordVerifiedVersion() {
          throw Object.assign(new Error('permission denied opening the trust-state lock'), { code: 'EACCES' })
        },
      }),
    })

    await expect(update.checkEach(v25)).resolves.toEqual([['stale', undefined]])
  })

  it('remembers a release verified earlier in the session when no mark can be saved', async () => {
    const paths = userData()
    const [v3, v2] = ['3.0.0', '2.0.0'].map((version) => signedFixture(version)) as [Fixture, Fixture]
    const update = updater({ currentVersion: '2.0.0', dir: paths.dir, fixtures: [v3, v2], trustFs: failingWrites('ENOSPC') })

    await expect(update.checkEach(v3, v2)).resolves.toEqual([
      ['available', '3.0.0'],
      ['stale', undefined],
    ])
  })

  it('saves the session mark at the next successful save', async () => {
    const paths = userData()
    const [v3, v25] = ['3.0.0', '2.5.0'].map((version) => signedFixture(version)) as [Fixture, Fixture]
    const firstSaveFails = updater({
      currentVersion: '2.0.0',
      dir: paths.dir,
      fixtures: [v3, v25],
      trustFs: failingWrites('ENOSPC', 1),
    })

    await expect(firstSaveFails.checkEach(v3, v25)).resolves.toEqual([
      ['available', '3.0.0'],
      ['stale', undefined],
    ])
    expect(firstSaveFails.mark()).toBe('3.0.0')
    const relaunched = updater({ currentVersion: '2.0.0', dir: paths.dir, fixtures: [v3, v25] })
    await expect(relaunched.checkEach(v25)).resolves.toEqual([['stale', undefined]])
  })

  it('fails closed when the high-water recorder reports a malformed mark', async () => {
    await expect(checkForUpdate(baseOptions(signedFixture(), {
      recordVerifiedVersion: async () => '3.0',
    }))).rejects.toThrow()
  })
})
