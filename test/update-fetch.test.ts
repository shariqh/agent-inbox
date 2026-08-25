import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

import updateFetch from '../electron/update-fetch.cjs'
import type { UpdateCheckOptions } from '../electron/update-fetch.cjs'

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
} = updateFetch

const now = new Date('2026-02-01T00:00:00Z')

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

  it.each([
    'https://evilgithubusercontent.com/github-production-release-asset/1/2',
    'https://release-assets.githubusercontent.com/not-a-release-asset/1/2',
    'https://github.com/other/repo/releases/download/v2.0.0/update-manifest.json',
    'http://github.com/shariqh/agent-inbox/releases/download/v2.0.0/update-manifest.json',
    'https://user:pass@github.com/shariqh/agent-inbox/releases/download/v2.0.0/update-manifest.json',
  ])('rejects an unsafe redirect target: %s', async (location) => {
    const fixture = signedFixture()
    const fetchImpl = vi.fn(async (url: string) => (
      url === MANIFEST_URL
        ? response(null, 302, { location })
        : response(fixture.signatureBytes)
    ))
    await expect(checkForUpdate(baseOptions(fixture, { fetchImpl }))).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
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
    const fetchImpl = vi.fn(async (url: string) => {
      if ((kind === 'manifest') === (url === MANIFEST_URL)) {
        return response('small', 200, { 'content-length': String(size) })
      }
      return url === MANIFEST_URL
        ? response(fixture.manifestBytes)
        : response(fixture.signatureBytes)
    })
    await expect(checkForUpdate(baseOptions(fixture, { fetchImpl }))).rejects.toThrow()
  })

  it.each([
    ['manifest', 256 * 1024],
    ['signature', 16 * 1024],
  ] as const)('rejects streaming %s overflow without arrayBuffer()', async (kind, cap) => {
    const fixture = signedFixture()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(cap))
        controller.enqueue(new Uint8Array(1))
        controller.close()
      },
    })
    const oversized = response(stream)
    Object.defineProperty(oversized, 'arrayBuffer', {
      value: () => {
        throw new Error('arrayBuffer must not be used')
      },
    })
    const fetchImpl = vi.fn(async (url: string) => {
      if ((kind === 'manifest') === (url === MANIFEST_URL)) return oversized
      return url === MANIFEST_URL
        ? response(fixture.manifestBytes)
        : response(fixture.signatureBytes)
    })
    await expect(checkForUpdate(baseOptions(fixture, { fetchImpl }))).rejects.toThrow()
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

  it('fails closed on network errors and non-2xx final responses', async () => {
    const fixture = signedFixture()
    await expect(checkForUpdate(baseOptions(fixture, {
      fetchImpl: vi.fn(async () => { throw new Error('secret proxy detail') }),
    }))).rejects.toThrow()
    await expect(checkForUpdate(baseOptions(fixture, {
      fetchImpl: vi.fn(async () => response('nope', 500)),
    }))).rejects.toThrow()
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
    [{ platform: 'linux', arch: 'x64', isPackaged: true, appImagePath: '/app' }, 'appimage'],
    [{ platform: 'linux', arch: 'arm64', isPackaged: true, appImagePath: '/app' }, 'appimage'],
    [{ platform: 'linux', arch: 'x64', isPackaged: true }, 'deb'],
    [{ platform: 'linux', arch: 'arm64', isPackaged: true }, 'deb'],
  ] as const)('selects the exact packaged target for %o', async (host, packageType) => {
    const result = await checkForUpdate(baseOptions(signedFixture(), host))
    expect(result.status).toBe('available')
    expect(result.available?.target.packageType).toBe(packageType)
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
