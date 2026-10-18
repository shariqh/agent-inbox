import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import * as fsp from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import updateDownload from '../electron/update-download.cjs'
import type {
  DownloadFetchInit,
  UpdateArtifact,
  UpdateDownloadFs,
  VerifiedArtifact,
} from '../electron/update-download.cjs'
import type { FetchResponse } from '../electron/update-fetch.cjs'

const { createUpdateDownloader } = updateDownload

const repoRoot = resolve(import.meta.dirname, '..')
const workDirs: string[] = []
const ASSET_URL = 'https://release-assets.githubusercontent.com/github-production-release-asset/1302278444/'
  + '9d9153b6-d4af-43ac-8042-3d60cdec2ee1?sp=r&sig=secret-sas-signature&jwt=secret-jwt'
const CHUNK = 64 * 1024

afterEach(() => {
  for (const dir of workDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function workDir() {
  const dir = join(repoRoot, `.test-update-download-${process.pid}-${workDirs.length}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  workDirs.push(dir)
  return dir
}

function sha256(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex')
}

type Kind = 'dmg' | 'appimage' | 'deb'

function artifactFor(body: Buffer, version = '2.0.0', kind: Kind = 'dmg'): UpdateArtifact {
  const tag = `v${version}`
  const shape = {
    dmg: {
      platform: 'darwin' as const,
      architecture: 'universal' as const,
      packageType: 'dmg' as const,
      installStrategy: 'macos-dmg' as const,
      filename: `Agent-Inbox-${tag}-universal.dmg`,
      minimumSystemVersion: '13.5',
    },
    appimage: {
      platform: 'linux' as const,
      architecture: 'x64' as const,
      packageType: 'appimage' as const,
      installStrategy: 'appimage-self-replace' as const,
      filename: `Agent-Inbox-v${version}-linux-x86_64.AppImage`,
    },
    deb: {
      platform: 'linux' as const,
      architecture: 'x64' as const,
      packageType: 'deb' as const,
      installStrategy: 'deb-notify' as const,
      filename: `agent-inbox_${version}_amd64.deb`,
    },
  }[kind]
  return {
    version,
    tag,
    ...shape,
    url: `https://github.com/shariqh/agent-inbox/releases/download/${tag}/${shape.filename}`,
    byteLength: body.length,
    sha256: sha256(body),
  }
}

function streamOf(body: Buffer, chunkSize = CHUNK) {
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= body.length) {
        controller.close()
        return
      }
      controller.enqueue(new Uint8Array(body.subarray(offset, offset + chunkSize)))
      offset += chunkSize
    },
  })
}

function redirect(location: string) {
  return new Response(null, { status: 302, headers: { location } })
}

/** github.com answers 302 to the signed asset host, which streams `bodies[url]`. */
function releaseFetch(bodies: Map<string, Buffer>, served: (body: Buffer) => FetchResponse = (body) =>
  new Response(streamOf(body), { status: 200, headers: { 'content-length': String(body.length) } })) {
  return vi.fn(async (url: string, _init: DownloadFetchInit): Promise<FetchResponse> => {
    const body = bodies.get(url)
    if (body) return redirect(`${ASSET_URL}&file=${encodeURIComponent(url.split('/').pop()!)}`)
    for (const [releaseUrl, assetBody] of bodies) {
      if (url === `${ASSET_URL}&file=${encodeURIComponent(releaseUrl.split('/').pop()!)}`) return served(assetBody)
    }
    throw new Error(`unexpected URL ${url}`)
  })
}

function tree(root: string): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      out.push(relative(root, full))
      if (statSync(full).isDirectory()) walk(full)
    }
  }
  walk(root)
  return out.sort()
}

function expectNoPartials(root: string) {
  const entries = tree(root)
  expect(entries.filter((entry) => entry.includes('.staging-') || entry.endsWith('.part'))).toEqual([])
}

function expectNothingVerified(root: string) {
  expect(tree(root)).toEqual([])
}

function controllableBody() {
  const reads: Array<(value: { done: boolean; value?: Uint8Array }) => void> = []
  const readCalled: Array<() => void> = []
  const cancel = vi.fn(async () => {})
  let readCount = 0
  const waitForRead = (count: number) => new Promise<void>((resolveWait) => {
    if (readCount >= count) resolveWait()
    else readCalled.push(() => { if (readCount >= count) resolveWait() })
  })
  return {
    cancel,
    waitForRead,
    push(value: Uint8Array) { reads.shift()?.({ done: false, value }) },
    body: {
      getReader() {
        return {
          read() {
            readCount += 1
            for (const notify of readCalled.splice(0)) notify()
            return new Promise<{ done: boolean; value?: Uint8Array }>((resolveRead) => { reads.push(resolveRead) })
          },
          cancel,
          releaseLock() {},
        }
      },
    },
  }
}

function manualTimers() {
  const timers: Array<{ callback: () => void; delay: number; cleared: boolean }> = []
  return {
    setTimeoutImpl: (callback: () => void, delay: number) => {
      const timer = { callback, delay, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimeoutImpl: (timer: { cleared: boolean } | undefined) => {
      if (timer) timer.cleared = true
    },
    fire(delay: number) {
      const timer = timers.filter((candidate) => !candidate.cleared && candidate.delay === delay).at(-1)
      expect(timer, `no active ${delay}ms timer`).toBeDefined()
      timer!.cleared = true
      timer!.callback()
    },
  }
}

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return { code: (error as { code?: string }).code, message: String((error as Error).message) }
  }
  throw new Error('expected the download to fail')
}

describe('verified update download', () => {
  it('streams the exact manifest artifact into a private directory and returns the installer seam', async () => {
    const root = join(workDir(), 'update-downloads')
    const body = randomBytes(5 * CHUNK + 123)
    const artifact = artifactFor(body)
    const fetchImpl = releaseFetch(new Map([[artifact.url, body]]))
    const progress: number[] = []
    const downloader = createUpdateDownloader({ directory: root, fetchImpl })

    const record = await downloader.download(artifact, {
      onProgress: (received, total) => {
        expect(total).toBe(body.length)
        progress.push(received)
      },
    })

    const finalPath = join(root, `v2.0.0-${artifact.sha256}`, 'Agent-Inbox-v2.0.0-universal.dmg')
    expect(record).toEqual({
      path: finalPath,
      version: '2.0.0',
      tag: 'v2.0.0',
      filename: 'Agent-Inbox-v2.0.0-universal.dmg',
      sha256: artifact.sha256,
      byteLength: body.length,
      packageType: 'dmg',
      installStrategy: 'macos-dmg',
      minimumSystemVersion: '13.5',
    } satisfies VerifiedArtifact)
    expect(Object.isFrozen(record)).toBe(true)
    expect(readFileSync(finalPath).equals(body)).toBe(true)
    expect(statSync(root).mode & 0o777).toBe(0o700)
    expect(statSync(join(root, `v2.0.0-${artifact.sha256}`)).mode & 0o777).toBe(0o700)
    expect(statSync(finalPath).mode & 0o777).toBe(0o600)
    expect(tree(root)).toEqual([`v2.0.0-${artifact.sha256}`, relative(root, finalPath)])
    expect(progress.at(-1)).toBe(body.length)
    expect(progress).toEqual([...progress].sort((a, b) => a - b))

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([artifact.url, expect.stringMatching(/^https:\/\/release-assets\.githubusercontent\.com\//)])
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(new URL(url).username).toBe('')
      expect(init).toEqual({
        redirect: 'manual',
        signal: expect.any(AbortSignal),
        credentials: 'omit',
        headers: { 'cache-control': 'no-cache' },
      })
    }
  })

  it('downloads AppImage targets and refuses the notify-only deb strategy without a request', async () => {
    const root = join(workDir(), 'update-downloads')
    const body = randomBytes(CHUNK)
    const appImage = artifactFor(body, '2.0.0', 'appimage')
    const deb = artifactFor(body, '2.0.0', 'deb')
    const fetchImpl = releaseFetch(new Map([[appImage.url, body], [deb.url, body]]))
    const downloader = createUpdateDownloader({ directory: root, fetchImpl })

    expect(downloader.normalize(deb)).toBeNull()
    expect(downloader.normalize(appImage)).toEqual(appImage)
    expect(await codeOf(downloader.download(deb))).toMatchObject({ code: 'unsupported-strategy' })
    expect(fetchImpl).not.toHaveBeenCalled()

    await expect(downloader.download(appImage)).resolves.toMatchObject({
      installStrategy: 'appimage-self-replace',
      filename: 'Agent-Inbox-v2.0.0-linux-x86_64.AppImage',
    })
  })

  it.each([
    ['plain HTTP', (a: UpdateArtifact) => ({ ...a, url: a.url.replace('https:', 'http:') })],
    ['another repository', (a: UpdateArtifact) => ({ ...a, url: a.url.replace('shariqh/agent-inbox', 'attacker/agent-inbox') })],
    ['a query string', (a: UpdateArtifact) => ({ ...a, url: `${a.url}?x=1` })],
    ['credentials', (a: UpdateArtifact) => ({ ...a, url: a.url.replace('https://', 'https://user:pass@') })],
    ['a renamed asset', (a: UpdateArtifact) => ({ ...a, url: a.url.replace('universal.dmg', 'other.dmg') })],
    ['a filename outside the manifest spec', (a: UpdateArtifact) => ({ ...a, filename: '../escape.dmg' })],
    ['a mismatched tag', (a: UpdateArtifact) => ({ ...a, tag: 'v9.9.9' })],
    ['an uppercase digest', (a: UpdateArtifact) => ({ ...a, sha256: a.sha256.toUpperCase() })],
    ['a zero length', (a: UpdateArtifact) => ({ ...a, byteLength: 0 })],
    ['a fractional length', (a: UpdateArtifact) => ({ ...a, byteLength: 1.5 })],
    ['an absurd length', (a: UpdateArtifact) => ({ ...a, byteLength: 64 * 1024 ** 3 })],
    ['a strategy that does not match the package', (a: UpdateArtifact) => ({ ...a, installStrategy: 'appimage-self-replace' as const })],
  ])('rejects an artifact with %s before any request', async (_label, mutate) => {
    const root = join(workDir(), 'update-downloads')
    const body = randomBytes(CHUNK)
    const fetchImpl = vi.fn()
    const downloader = createUpdateDownloader({ directory: root, fetchImpl })
    const artifact = mutate(artifactFor(body)) as UpdateArtifact

    expect(() => downloader.normalize(artifact)).toThrow()
    expect(await codeOf(downloader.download(artifact))).toMatchObject({ code: 'invalid-artifact' })
    expect(fetchImpl).not.toHaveBeenCalled()
    expectNothingVerified(root)
  })

  it('rejects a wrong digest and leaves no verified artifact or partial file', async () => {
    const root = join(workDir(), 'update-downloads')
    const body = randomBytes(3 * CHUNK)
    const artifact = { ...artifactFor(body), sha256: sha256(Buffer.from('something else')) }
    const downloader = createUpdateDownloader({
      directory: root,
      fetchImpl: releaseFetch(new Map([[artifact.url, body]])),
    })

    expect(await codeOf(downloader.download(artifact))).toMatchObject({ code: 'hash-mismatch' })
    expectNothingVerified(root)
  })

  it('rejects a short body', async () => {
    const root = join(workDir(), 'update-downloads')
    const body = randomBytes(3 * CHUNK)
    const artifact = artifactFor(body)
    const downloader = createUpdateDownloader({
      directory: root,
      fetchImpl: releaseFetch(new Map([[artifact.url, body.subarray(0, body.length - 1)]])),
    })

    expect(await codeOf(downloader.download(artifact))).toMatchObject({ code: 'too-short' })
    expectNothingVerified(root)
  })

  it('stops reading at the signed length when a body overflows it', async () => {
    const root = join(workDir(), 'update-downloads')
    const body = randomBytes(2 * CHUNK)
    const artifact = artifactFor(body)
    const chunks = [body, Buffer.from([1]), Buffer.alloc(CHUNK)]
    let reads = 0
    const cancel = vi.fn(async () => {})
    const downloader = createUpdateDownloader({
      directory: root,
      fetchImpl: releaseFetch(new Map([[artifact.url, body]]), () => ({
        status: 200,
        headers: new Headers(),
        body: {
          getReader() {
            return {
              async read() {
                reads += 1
                const value = chunks.shift()
                return value ? { done: false, value: new Uint8Array(value) } : { done: true }
              },
              cancel,
              releaseLock() {},
            }
          },
        },
      })),
    })

    expect(await codeOf(downloader.download(artifact))).toMatchObject({ code: 'too-large' })
    expect(reads).toBe(2)
    expect(cancel).toHaveBeenCalled()
    expectNothingVerified(root)
  })

  it('rejects an oversized Content-Length before reading the body', async () => {
    const root = join(workDir(), 'update-downloads')
    const body = randomBytes(CHUNK)
    const artifact = artifactFor(body)
    const cancel = vi.fn(async () => {})
    const getReader = vi.fn()
    const downloader = createUpdateDownloader({
      directory: root,
      fetchImpl: releaseFetch(new Map([[artifact.url, body]]), () => ({
        status: 200,
        headers: new Headers({ 'content-length': String(body.length + 1) }),
        body: { cancel, getReader },
      })),
    })

    expect(await codeOf(downloader.download(artifact))).toMatchObject({ code: 'too-large' })
    expect(getReader).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce()
    expectNothingVerified(root)
  })

  it.each([
    'https://evil.example.com/github-production-release-asset/1/2',
    'https://raw.githubusercontent.com/github-production-release-asset/1/2',
    'https://release-assets.githubusercontent.com.evil.example/github-production-release-asset/1/2',
    'http://release-assets.githubusercontent.com/github-production-release-asset/1/2',
    'https://release-assets.githubusercontent.com:8443/github-production-release-asset/1/2',
    'https://user:pass@release-assets.githubusercontent.com/github-production-release-asset/1/2',
    'https://release-assets.githubusercontent.com/not-a-release-asset/1/2',
    'https://release-assets.githubusercontent.com/github-production-release-asset/1/2#fragment',
    'https://github.com/shariqh/agent-inbox/releases/download/v2.0.0/other.dmg',
    'https://github.com/attacker/agent-inbox/releases/download/v2.0.0/Agent-Inbox-v2.0.0-universal.dmg',
    'file:///etc/passwd',
  ])('refuses a redirect to %s without following it', async (location) => {
    const root = join(workDir(), 'update-downloads')
    const body = randomBytes(CHUNK)
    const artifact = artifactFor(body)
    const cancel = vi.fn(async () => {})
    let signal: AbortSignal | undefined
    const fetchImpl = vi.fn(async (_url: string, init: DownloadFetchInit) => {
      signal = init.signal
      return { status: 302, headers: new Headers({ location }), body: { cancel } }
    })
    const downloader = createUpdateDownloader({ directory: root, fetchImpl })

    expect(await codeOf(downloader.download(artifact))).toMatchObject({ code: 'redirect-rejected' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledOnce()
    expect(signal?.aborted).toBe(true)
    expectNothingVerified(root)
  })

  it('follows the legacy objects host and a canonical self-redirect within the hop limit', async () => {
    const root = join(workDir(), 'update-downloads')
    const body = randomBytes(CHUNK)
    const artifact = artifactFor(body)
    const hops = [
      artifact.url,
      'https://objects.githubusercontent.com/github-production-release-asset-2e65be/123/abc?X-Amz-Signature=secret',
      'https://release-assets.githubusercontent.com/github-production-release-asset/1302278444/def?sig=secret',
    ]
    let call = 0
    const fetchImpl = vi.fn(async () => (call < hops.length
      ? redirect(hops[call++]!)
      : new Response(streamOf(body), { status: 200 })))
    const downloader = createUpdateDownloader({ directory: root, fetchImpl })

    await expect(downloader.download(artifact)).resolves.toMatchObject({ sha256: artifact.sha256 })
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })

  it('gives up after five redirects', async () => {
    const root = join(workDir(), 'update-downloads')
    const body = randomBytes(CHUNK)
    const artifact = artifactFor(body)
    const fetchImpl = vi.fn(async () => redirect(artifact.url))
    const downloader = createUpdateDownloader({ directory: root, fetchImpl })

    expect(await codeOf(downloader.download(artifact))).toMatchObject({ code: 'too-many-redirects' })
    expect(fetchImpl).toHaveBeenCalledTimes(6)
    expectNothingVerified(root)
  })

  it('fails closed on HTTP errors and network failures without leaking the signed URL', async () => {
    const root = join(workDir(), 'update-downloads')
    const body = randomBytes(CHUNK)
    const artifact = artifactFor(body)
    const cancel = vi.fn(async () => {})
    const notFound = createUpdateDownloader({
      directory: root,
      fetchImpl: releaseFetch(new Map([[artifact.url, body]]), () => ({ status: 404, headers: new Headers(), body: { cancel } })),
    })
    expect(await codeOf(notFound.download(artifact))).toMatchObject({ code: 'http-status' })
    expect(cancel).toHaveBeenCalledOnce()

    const offline = createUpdateDownloader({
      directory: root,
      fetchImpl: vi.fn(async () => { throw new Error(`getaddrinfo ENOTFOUND ${ASSET_URL}`) }),
    })
    const failure = await codeOf(offline.download(artifact))
    expect(failure.code).toBe('network')
    expect(failure.message).not.toContain('secret')
    expectNothingVerified(root)
  })

  it('deletes the partial file when the connection drops mid-stream', async () => {
    const root = join(workDir(), 'update-downloads')
    const body = randomBytes(4 * CHUNK)
    const artifact = artifactFor(body)
    let reads = 0
    const downloader = createUpdateDownloader({
      directory: root,
      fetchImpl: releaseFetch(new Map([[artifact.url, body]]), () => ({
        status: 200,
        headers: new Headers(),
        body: {
          getReader() {
            return {
              async read() {
                reads += 1
                if (reads === 3) throw new TypeError('terminated: other side closed')
                return { done: false, value: new Uint8Array(body.subarray(0, CHUNK)) }
              },
              cancel: async () => {},
              releaseLock() {},
            }
          },
        },
      })),
    })

    expect(await codeOf(downloader.download(artifact))).toMatchObject({ code: 'network' })
    expectNothingVerified(root)
  })

  it('times out a stalled body and a hung request, deleting partial files', async () => {
    const root = join(workDir(), 'update-downloads')
    const body = randomBytes(2 * CHUNK)
    const artifact = artifactFor(body)
    const stalled = controllableBody()
    const timers = manualTimers()
    const stalling = createUpdateDownloader({
      directory: root,
      fetchImpl: releaseFetch(new Map([[artifact.url, body]]), () => ({ status: 200, headers: new Headers(), body: stalled.body })),
      stallTimeoutMs: 1_000,
      totalTimeoutMs: 60_000,
      ...timers,
    })
    const first = codeOf(stalling.download(artifact))
    await stalled.waitForRead(1)
    stalled.push(new Uint8Array(body.subarray(0, CHUNK)))
    await stalled.waitForRead(2)
    timers.fire(1_000)
    expect(await first).toMatchObject({ code: 'timeout' })
    expect(stalled.cancel).toHaveBeenCalled()
    expectNothingVerified(root)

    const deadline = manualTimers()
    let requested!: () => void
    const requestStarted = new Promise<void>((resolveStarted) => { requested = resolveStarted })
    const hanging = createUpdateDownloader({
      directory: root,
      fetchImpl: vi.fn(() => {
        requested()
        return new Promise<never>(() => {})
      }),
      stallTimeoutMs: 1_000,
      totalTimeoutMs: 60_000,
      ...deadline,
    })
    const second = codeOf(hanging.download(artifact))
    await requestStarted
    deadline.fire(60_000)
    expect(await second).toMatchObject({ code: 'timeout' })
    expectNothingVerified(root)
  })

  it('cancels an in-flight download and resolves only after its partial file is gone', async () => {
    const root = join(workDir(), 'update-downloads')
    const body = randomBytes(2 * CHUNK)
    const artifact = artifactFor(body)
    const stream = controllableBody()
    const downloader = createUpdateDownloader({
      directory: root,
      fetchImpl: releaseFetch(new Map([[artifact.url, body]]), () => ({ status: 200, headers: new Headers(), body: stream.body })),
    })
    await expect(downloader.cancel()).resolves.toBeUndefined()

    const outcome = codeOf(downloader.download(artifact))
    await stream.waitForRead(1)
    stream.push(new Uint8Array(body.subarray(0, CHUNK)))
    await stream.waitForRead(2)
    expect(tree(root).some((entry) => entry.endsWith('.part'))).toBe(true)

    await downloader.cancel()
    expectNothingVerified(root)
    expect(await outcome).toMatchObject({ code: 'cancelled' })
  })

  it('maps disk failures to a clean failure, including after a verified stream', async () => {
    const root = join(workDir(), 'update-downloads')
    const body = randomBytes(3 * CHUNK)
    const artifact = artifactFor(body)
    const diskFull: UpdateDownloadFs = {
      ...(fsp as unknown as UpdateDownloadFs),
      async open(path, flags, mode) {
        const handle = await fsp.open(path, flags, mode)
        let writes = 0
        return new Proxy(handle, {
          get(target, property, receiver) {
            if (property === 'write') {
              return async (...args: Parameters<typeof handle.write>) => {
                writes += 1
                if (writes === 2) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
                return target.write(...args)
              }
            }
            const value = Reflect.get(target, property, receiver)
            return typeof value === 'function' ? value.bind(target) : value
          },
        }) as never
      },
    }
    const full = createUpdateDownloader({
      directory: root,
      fetchImpl: releaseFetch(new Map([[artifact.url, body]])),
      fsImpl: diskFull,
    })
    expect(await codeOf(full.download(artifact))).toMatchObject({ code: 'disk' })
    expectNothingVerified(root)

    const renameFails: UpdateDownloadFs = {
      ...(fsp as unknown as UpdateDownloadFs),
      rename: async () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }) },
    }
    const blocked = createUpdateDownloader({
      directory: root,
      fetchImpl: releaseFetch(new Map([[artifact.url, body]])),
      fsImpl: renameFails,
    })
    expect(await codeOf(blocked.download(artifact))).toMatchObject({ code: 'disk' })
    expectNothingVerified(root)

    const closed = vi.fn()
    const syncFails: UpdateDownloadFs = {
      ...(fsp as unknown as UpdateDownloadFs),
      async open(path, flags, mode) {
        const handle = await fsp.open(path, flags, mode)
        return {
          write: handle.write.bind(handle),
          read: handle.read.bind(handle),
          stat: handle.stat.bind(handle),
          sync: async () => { throw Object.assign(new Error('I/O error'), { code: 'EIO' }) },
          close: async () => {
            closed()
            await handle.close()
          },
        } as never
      },
    }
    const unsynced = createUpdateDownloader({
      directory: root,
      fetchImpl: releaseFetch(new Map([[artifact.url, body]])),
      fsImpl: syncFails,
    })
    expect(await codeOf(unsynced.download(artifact))).toMatchObject({ code: 'disk' })
    expect(closed).toHaveBeenCalled()
    expectNothingVerified(root)
  })

  it('joins an in-flight download and reuses a re-verified file instead of downloading again', async () => {
    const root = join(workDir(), 'update-downloads')
    const body = randomBytes(3 * CHUNK)
    const artifact = artifactFor(body)
    const fetchImpl = releaseFetch(new Map([[artifact.url, body]]))
    const downloader = createUpdateDownloader({ directory: root, fetchImpl })

    const first = downloader.download(artifact)
    const joined = downloader.download({ ...artifact })
    const [a, b] = await Promise.all([first, joined])
    expect(b).toBe(a)
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    const progress: number[] = []
    const again = createUpdateDownloader({ directory: root, fetchImpl })
    await expect(again.download(artifact, { onProgress: (received) => progress.push(received) })).resolves.toEqual(a)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(progress).toEqual([body.length])

    const tampered = Buffer.from(body)
    tampered[0] = (tampered[0] ?? 0) ^ 0xff
    writeFileSync(a.path, tampered)
    await expect(again.download(artifact)).resolves.toEqual(a)
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    expect(readFileSync(a.path).equals(body)).toBe(true)
  })

  it('lets a newer artifact supersede both an in-flight and a completed older download', async () => {
    const root = join(workDir(), 'update-downloads')
    const oldBody = randomBytes(2 * CHUNK)
    const newBody = randomBytes(2 * CHUNK)
    const older = artifactFor(oldBody, '2.0.0')
    const newer = artifactFor(newBody, '2.1.0')
    const slow = controllableBody()
    const bodies = new Map([[older.url, oldBody], [newer.url, newBody]])
    const fetchImpl = releaseFetch(bodies, (body) => (body === oldBody
      ? { status: 200, headers: new Headers(), body: slow.body }
      : new Response(streamOf(body), { status: 200 })))
    const downloader = createUpdateDownloader({ directory: root, fetchImpl })

    const superseded = codeOf(downloader.download(older))
    await slow.waitForRead(1)
    slow.push(new Uint8Array(oldBody.subarray(0, CHUNK)))
    await slow.waitForRead(2)
    const latest = await downloader.download(newer)
    expect(await superseded).toMatchObject({ code: 'superseded' })
    expect(tree(root)).toEqual([`v2.1.0-${newer.sha256}`, join(`v2.1.0-${newer.sha256}`, newer.filename)])

    // A failed newer download never destroys the previously verified one.
    const sequential = createUpdateDownloader({ directory: root, fetchImpl: releaseFetch(bodies) })
    const completed = await sequential.download(newer)
    expect(completed).toEqual(latest)
    expect(await codeOf(sequential.download(artifactFor(oldBody, '2.2.0')))).toMatchObject({ code: 'network' })
    expect(existsSync(completed.path)).toBe(true)

    const third = artifactFor(newBody, '2.3.0')
    await createUpdateDownloader({ directory: root, fetchImpl: releaseFetch(new Map([[third.url, newBody]])) }).download(third)
    expect(tree(root)).toEqual([`v2.3.0-${third.sha256}`, join(`v2.3.0-${third.sha256}`, third.filename)])
  })

  it('re-verifies a recorded artifact only at its expected location', async () => {
    const root = join(workDir(), 'update-downloads')
    const body = randomBytes(2 * CHUNK)
    const artifact = artifactFor(body)
    const downloader = createUpdateDownloader({
      directory: root,
      fetchImpl: releaseFetch(new Map([[artifact.url, body]])),
    })
    const record = await downloader.download(artifact)

    await expect(downloader.verify(record)).resolves.toEqual(record)
    expect(await codeOf(downloader.verify({ ...record, path: join(root, '..', 'elsewhere.dmg') }))).toMatchObject({ code: 'not-verified' })
    writeFileSync(record.path, Buffer.alloc(body.length))
    expect(await codeOf(downloader.verify(record))).toMatchObject({ code: 'not-verified' })
  })
})

describe('something planted at a verified path', () => {
  function recordFor(root: string, artifact: UpdateArtifact): VerifiedArtifact {
    return {
      path: join(root, `${artifact.tag}-${artifact.sha256}`, artifact.filename),
      version: artifact.version,
      tag: artifact.tag,
      filename: artifact.filename,
      sha256: artifact.sha256,
      byteLength: artifact.byteLength,
      packageType: artifact.packageType,
      installStrategy: artifact.installStrategy as VerifiedArtifact['installStrategy'],
      ...(artifact.minimumSystemVersion ? { minimumSystemVersion: artifact.minimumSystemVersion } : {}),
    }
  }

  // Fails rather than hangs, and releases an open() a regression left blocked on the FIFO.
  async function settled<T>(promise: Promise<T>, fifo: string): Promise<T | 'hung'> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<'hung'>((resolveHung) => { timer = setTimeout(() => resolveHung('hung'), 2_000) }),
      ])
    } finally {
      clearTimeout(timer)
      try {
        closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK))
      } catch {
        // No blocked reader (or no FIFO left): nothing to release.
      }
    }
  }

  it('fails a named pipe at the verified path instead of blocking on it, then replaces it', async () => {
    const root = join(workDir(), 'update-downloads')
    const body = randomBytes(2 * CHUNK)
    const artifact = artifactFor(body)
    const record = recordFor(root, artifact)
    mkdirSync(join(root, `${artifact.tag}-${artifact.sha256}`), { recursive: true, mode: 0o700 })
    execFileSync('mkfifo', [record.path])
    const fetchImpl = releaseFetch(new Map([[artifact.url, body]]))
    const downloader = createUpdateDownloader({ directory: root, fetchImpl })

    expect(await settled(codeOf(downloader.verify(record)), record.path)).toMatchObject({ code: 'not-verified' })
    expect(await settled(downloader.download(artifact), record.path)).toEqual(record)
    expect(lstatSync(record.path).isFile()).toBe(true)
    expect(readFileSync(record.path).equals(body)).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('never reuses or verifies a symlinked artifact, even one with the signed bytes', async () => {
    const work = workDir()
    const root = join(work, 'update-downloads')
    const body = randomBytes(2 * CHUNK)
    const artifact = artifactFor(body)
    const record = recordFor(root, artifact)
    const outside = join(work, 'outside.dmg')
    writeFileSync(outside, body)
    mkdirSync(join(root, `${artifact.tag}-${artifact.sha256}`), { recursive: true, mode: 0o700 })
    symlinkSync(outside, record.path)
    const fetchImpl = releaseFetch(new Map([[artifact.url, body]]))
    const downloader = createUpdateDownloader({ directory: root, fetchImpl })

    expect(await codeOf(downloader.verify(record))).toMatchObject({ code: 'not-verified' })
    await expect(downloader.download(artifact)).resolves.toEqual(record)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(lstatSync(record.path).isSymbolicLink()).toBe(false)
    expect(readFileSync(outside).equals(body)).toBe(true)
  })

  it('never reuses or verifies through a symlinked download directory, even one with the signed bytes', async () => {
    const work = workDir()
    const root = join(work, 'update-downloads')
    const body = randomBytes(2 * CHUNK)
    const artifact = artifactFor(body)
    const record = recordFor(root, artifact)
    const keyDir = join(root, `${artifact.tag}-${artifact.sha256}`)
    const outside = join(work, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, artifact.filename), body)
    mkdirSync(root, { recursive: true, mode: 0o700 })
    symlinkSync(outside, keyDir)
    const fetchImpl = releaseFetch(new Map([[artifact.url, body]]))
    const downloader = createUpdateDownloader({ directory: root, fetchImpl })

    expect(await codeOf(downloader.verify(record))).toMatchObject({ code: 'not-verified' })
    await expect(downloader.download(artifact)).resolves.toEqual(record)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(lstatSync(keyDir).isSymbolicLink()).toBe(false)
    expect(lstatSync(keyDir).isDirectory()).toBe(true)
    expect(readFileSync(join(outside, artifact.filename)).equals(body)).toBe(true)
  })
})

describe('download cleanup', () => {
  function staging(root: string, name: string, ageMs: number) {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, 'Agent-Inbox-v2.0.0-universal.dmg.part'), 'partial')
    const when = new Date(Date.now() - ageMs)
    utimesSync(join(dir, 'Agent-Inbox-v2.0.0-universal.dmg.part'), when, when)
    utimesSync(dir, when, when)
    return dir
  }

  function verifiedDir(root: string, version: string, body = randomBytes(16)) {
    const artifact = artifactFor(body, version)
    const dir = join(root, `v${version}-${artifact.sha256}`)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, artifact.filename), body)
    return { artifact, dir }
  }

  it('removes only abandoned staging directories and downloads that are no longer useful', async () => {
    const root = join(workDir(), 'update-downloads')
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const stale = staging(root, '.staging-AAAAAA', 2 * 60 * 60_000)
    const fresh = staging(root, '.staging-BBBBBB', 60_000)
    const installed = verifiedDir(root, '1.0.0')
    const pending = verifiedDir(root, '2.0.0')
    writeFileSync(join(root, 'notes.txt'), 'not ours')
    mkdirSync(join(root, 'v2.0.0-not-a-digest'))
    const downloader = createUpdateDownloader({ directory: root, fetchImpl: vi.fn() })

    await downloader.prune({ currentVersion: '1.0.0' })
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(installed.dir)).toBe(false)
    expect(existsSync(pending.dir)).toBe(true)
    expect(existsSync(join(root, 'notes.txt'))).toBe(true)
    expect(existsSync(join(root, 'v2.0.0-not-a-digest'))).toBe(true)

    const newer = verifiedDir(root, '2.1.0')
    await downloader.prune({ keep: newer.artifact, currentVersion: '1.0.0' })
    expect(existsSync(pending.dir)).toBe(false)
    expect(existsSync(newer.dir)).toBe(true)

    await downloader.prune({ keep: null, currentVersion: '1.0.0' })
    expect(existsSync(newer.dir)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  it('never follows a planted symlink while cleaning up', async () => {
    const work = workDir()
    const root = join(work, 'update-downloads')
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const outside = join(work, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'precious.txt'), 'keep me')
    symlinkSync(outside, join(root, '.staging-CCCCCC'))
    symlinkSync(outside, join(root, `v1.0.0-${'a'.repeat(64)}`))
    const downloader = createUpdateDownloader({ directory: root, fetchImpl: vi.fn(), nowMs: () => Date.now() + 24 * 60 * 60_000 })

    await downloader.prune({ keep: null, currentVersion: '1.0.0' })
    expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('keep me')
    expect(readdirSync(root)).toEqual([])
  })

  it('bounds the work done by one cleanup pass', async () => {
    const root = join(workDir(), 'update-downloads')
    mkdirSync(root, { recursive: true, mode: 0o700 })
    for (let index = 0; index < 20; index += 1) {
      staging(root, `.staging-${String(index).padStart(6, '0')}`, 2 * 60 * 60_000)
    }
    const downloader = createUpdateDownloader({ directory: root, fetchImpl: vi.fn() })

    await downloader.prune()
    expect(readdirSync(root)).toHaveLength(4)
    await downloader.prune()
    expect(readdirSync(root)).toHaveLength(0)
  })

  it('refuses to download into a symlinked directory', async () => {
    const work = workDir()
    const elsewhere = join(work, 'elsewhere')
    mkdirSync(elsewhere)
    const root = join(work, 'update-downloads')
    symlinkSync(elsewhere, root)
    const body = randomBytes(CHUNK)
    const artifact = artifactFor(body)
    const downloader = createUpdateDownloader({
      directory: root,
      fetchImpl: releaseFetch(new Map([[artifact.url, body]])),
    })

    expect(await codeOf(downloader.download(artifact))).toMatchObject({ code: 'disk' })
    expect(readdirSync(elsewhere)).toEqual([])
  })
})
