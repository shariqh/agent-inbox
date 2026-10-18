import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import updateInstall from '../electron/update-install.cjs'
import type { InstallCopyFs, VerifiedInstallSource } from '../electron/update-install.cjs'
import type { VerifiedArtifact } from '../electron/update-download.cjs'

const { INSTALL_HELPER_EXIT, UpdateInstallError, copyVerifiedSource, createInstallAttemptStore } = updateInstall

const repoRoot = resolve(import.meta.dirname, '..')
const workDirs: string[] = []

afterEach(() => {
  for (const dir of workDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function workDir() {
  const dir = join(repoRoot, `.test-update-install-${process.pid}-${workDirs.length}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  workDirs.push(dir)
  return dir
}

function recordFor(body: Buffer, overrides: Partial<VerifiedArtifact> = {}): VerifiedArtifact {
  return {
    path: '/not/read/by/the/copy',
    version: '2.0.0',
    tag: 'v2.0.0',
    filename: 'Agent-Inbox-v2.0.0-universal.dmg',
    sha256: createHash('sha256').update(body).digest('hex'),
    byteLength: body.length,
    packageType: 'dmg',
    installStrategy: 'macos-dmg',
    minimumSystemVersion: '13.5',
    ...overrides,
  }
}

/** An in-memory read-only handle that records every positioned read. */
function memoryHandle(bytes: Buffer, options: { size?: number; isFile?: boolean } = {}) {
  const positions: Array<number | null> = []
  return {
    positions,
    handle: {
      async stat() {
        return { isFile: () => options.isFile ?? true, size: options.size ?? bytes.length }
      },
      async read(buffer: Uint8Array, offset: number, length: number, position: number | null) {
        positions.push(position)
        const start = position ?? 0
        const chunk = bytes.subarray(start, start + length)
        Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength).set(chunk, offset)
        return { bytesRead: chunk.length }
      },
    },
  }
}

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return { code: (error as { code?: string }).code, message: String((error as Error).message), error }
  }
  throw new Error('expected the operation to fail')
}

describe('install contract errors', () => {
  it('carries a stable code and a generic message that names no path', () => {
    for (const code of ['not-feasible', 'not-verified', 'stale', 'busy', 'staging', 'verification-failed', 'commit-failed'] as const) {
      const error = new UpdateInstallError(code)
      expect(error).toBeInstanceOf(Error)
      expect(error.name).toBe('UpdateInstallError')
      expect(error.code).toBe(code)
      expect(error.message).not.toMatch(/\//)
      expect(error.message.length).toBeGreaterThan(0)
    }
    expect(new UpdateInstallError('staging', 'custom').message).toBe('custom')
  })
})

describe('copying a verified source while hashing it', () => {
  it('writes exactly the signed bytes with positioned reads into a new private file', async () => {
    const work = workDir()
    const body = randomBytes(3 * 1024 * 1024 + 11)
    const file = join(work, 'source.dmg')
    writeFileSync(file, body)
    const handle = await fsp.open(file, 'r')
    const destination = join(work, 'copy.dmg')
    try {
      await copyVerifiedSource({ record: recordFor(body), handle }, destination)
    } finally {
      await handle.close()
    }
    expect(readFileSync(destination).equals(body)).toBe(true)
    expect(statSync(destination).mode & 0o777).toBe(0o600)

    const memory = memoryHandle(body)
    const second = join(work, 'second.dmg')
    await copyVerifiedSource({ record: recordFor(body), handle: memory.handle }, second)
    expect(memory.positions[0]).toBe(0)
    expect(memory.positions.every((position) => typeof position === 'number')).toBe(true)
    expect(memory.positions).toEqual([...memory.positions].sort((a, b) => (a ?? 0) - (b ?? 0)))
  })

  it('refuses bytes that do not hash to the signed digest and removes its copy', async () => {
    const work = workDir()
    const body = randomBytes(64 * 1024)
    const altered = Buffer.from(body)
    altered[1000] = (altered[1000] ?? 0) ^ 0xff
    const destination = join(work, 'copy.dmg')

    const failure = await codeOf(copyVerifiedSource({ record: recordFor(body), handle: memoryHandle(altered).handle }, destination))
    expect(failure.code).toBe('not-verified')
    expect(failure.error).toBeInstanceOf(UpdateInstallError)
    expect(existsSync(destination)).toBe(false)
  })

  it('refuses a short handle, a size mismatch and a non-file before using any bytes', async () => {
    const work = workDir()
    const body = randomBytes(64 * 1024)
    const destination = join(work, 'copy.dmg')

    // stat claims the signed size but the reads end early.
    const short = memoryHandle(body.subarray(0, body.length - 1), { size: body.length })
    expect(await codeOf(copyVerifiedSource({ record: recordFor(body), handle: short.handle }, destination))).toMatchObject({ code: 'not-verified' })
    expect(existsSync(destination)).toBe(false)

    const longer = memoryHandle(Buffer.concat([body, Buffer.from([1])]))
    expect(await codeOf(copyVerifiedSource({ record: recordFor(body), handle: longer.handle }, destination))).toMatchObject({ code: 'not-verified' })
    expect(longer.positions).toEqual([])

    const directory = memoryHandle(body, { isFile: false })
    expect(await codeOf(copyVerifiedSource({ record: recordFor(body), handle: directory.handle }, destination))).toMatchObject({ code: 'not-verified' })
    expect(directory.positions).toEqual([])
    expect(existsSync(destination)).toBe(false)
  })

  it.each([
    ['no handle', () => ({ record: recordFor(Buffer.alloc(8)) }) as unknown as VerifiedInstallSource],
    ['an uppercase digest', () => ({ record: { ...recordFor(Buffer.alloc(8)), sha256: 'A'.repeat(64) }, handle: memoryHandle(Buffer.alloc(8)).handle })],
    ['a zero length', () => ({ record: { ...recordFor(Buffer.alloc(8)), byteLength: 0 }, handle: memoryHandle(Buffer.alloc(8)).handle })],
    ['no record', () => ({ handle: memoryHandle(Buffer.alloc(8)).handle }) as unknown as VerifiedInstallSource],
  ])('refuses a source with %s', async (_label, source) => {
    const destination = join(workDir(), 'copy.dmg')
    expect(await codeOf(copyVerifiedSource(source(), destination))).toMatchObject({ code: 'not-verified' })
    expect(existsSync(destination)).toBe(false)
  })

  it('never replaces or removes a file that already exists at the destination', async () => {
    const work = workDir()
    const body = randomBytes(1024)
    const destination = join(work, 'copy.dmg')
    writeFileSync(destination, 'planted')

    expect(await codeOf(copyVerifiedSource({ record: recordFor(body), handle: memoryHandle(body).handle }, destination))).toMatchObject({ code: 'staging' })
    expect(readFileSync(destination, 'utf8')).toBe('planted')
  })

  it('maps write failures and cancellation to staging and removes the partial copy', async () => {
    const work = workDir()
    const body = randomBytes(3 * 1024 * 1024)
    const diskFull: InstallCopyFs = {
      unlink: fsp.unlink,
      async open(path, flags, mode) {
        const real = await fsp.open(path, flags, mode)
        let writes = 0
        return {
          async write(buffer: Uint8Array, offset: number, length: number) {
            writes += 1
            if (writes === 2) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
            return real.write(buffer, offset, length)
          },
          sync: () => real.sync(),
          close: () => real.close(),
        }
      },
    }
    const full = join(work, 'full.dmg')
    expect(await codeOf(copyVerifiedSource({ record: recordFor(body), handle: memoryHandle(body).handle }, full, { fsImpl: diskFull }))).toMatchObject({ code: 'staging' })
    expect(existsSync(full)).toBe(false)

    const controller = new AbortController()
    const cancelled = join(work, 'cancelled.dmg')
    const slow = memoryHandle(body)
    const read = slow.handle.read
    slow.handle.read = async (...args) => {
      controller.abort()
      return read(...args)
    }
    expect(await codeOf(copyVerifiedSource({ record: recordFor(body), handle: slow.handle }, cancelled, { signal: controller.signal }))).toMatchObject({ code: 'staging' })
    expect(existsSync(cancelled)).toBe(false)
  })
})

describe('recording an install attempt across the restart', () => {
  const at = new Date('2026-10-18T05:00:00.000Z')
  function store(directory: string, platform = 'darwin') {
    return createInstallAttemptStore({ directory, platform, now: () => at })
  }

  it('names one exit-code convention for every platform helper', () => {
    expect(INSTALL_HELPER_EXIT).toEqual({
      installed: 0,
      badArguments: 64,
      refused: 65,
      couldNotMoveAside: 70,
      couldNotMoveIn: 71,
      timedOut: 75,
    })
    expect(Object.isFrozen(INSTALL_HELPER_EXIT)).toBe(true)
  })

  it('writes the record atomically in a private folder and hands back where the helper reports', async () => {
    const directory = join(workDir(), 'update-install')
    const attempts = store(directory)

    const { resultPath } = await attempts.begin({ from: '1.3.0', to: '1.3.1', strategy: 'macos-dmg' })

    expect(resultPath).toBe(join(directory, 'last-attempt.result'))
    expect(JSON.parse(readFileSync(join(directory, 'last-attempt.json'), 'utf8'))).toEqual({
      schema: 1,
      from: '1.3.0',
      to: '1.3.1',
      at: '2026-10-18T05:00:00.000Z',
      platform: 'darwin',
      strategy: 'macos-dmg',
    })
    expect(statSync(directory).mode & 0o777).toBe(0o700)
    expect(statSync(join(directory, 'last-attempt.json')).mode & 0o777).toBe(0o600)
    expect(readdirSync(directory)).toEqual(['last-attempt.json'])
  })

  it('reads and deletes the record and the helper result, once', async () => {
    const directory = join(workDir(), 'update-install')
    const attempts = store(directory)
    const { resultPath } = await attempts.begin({ from: '1.3.0', to: '1.3.1', strategy: 'macos-dmg' })
    writeFileSync(resultPath, '70\n')

    await expect(attempts.take()).resolves.toEqual({
      from: '1.3.0',
      to: '1.3.1',
      at: '2026-10-18T05:00:00.000Z',
      platform: 'darwin',
      strategy: 'macos-dmg',
      exitCode: 70,
    })
    expect(readdirSync(directory)).toEqual([])
    await expect(attempts.take()).resolves.toBeNull()
  })

  it('reports no exit code when the helper never wrote one, or wrote anything but a code', async () => {
    const directory = join(workDir(), 'update-install')
    const attempts = store(directory)
    for (const content of [null, '', 'seventy', '70; rm -rf /', '1000', `${'7'.repeat(40)}`]) {
      const { resultPath } = await attempts.begin({ from: '1.3.0', to: '1.3.1', strategy: 'macos-dmg' })
      if (content !== null) writeFileSync(resultPath, content)
      await expect(attempts.take(), String(content)).resolves.toMatchObject({ to: '1.3.1', exitCode: null })
      expect(readdirSync(directory)).toEqual([])
    }
  })

  it('drops a stale helper result when a new attempt begins, and both files when the hand-off never started', async () => {
    const directory = join(workDir(), 'update-install')
    const attempts = store(directory)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(join(directory, 'last-attempt.result'), '0\n')

    await attempts.begin({ from: '1.3.0', to: '1.3.1', strategy: 'macos-dmg' })
    expect(existsSync(join(directory, 'last-attempt.result'))).toBe(false)
    writeFileSync(join(directory, 'last-attempt.result'), '75\n')
    await attempts.abandon()
    await attempts.abandon()
    expect(readdirSync(directory)).toEqual([])
    await expect(attempts.take()).resolves.toBeNull()
  })

  it.each([
    ['not JSON', '{'],
    ['another schema', JSON.stringify({ schema: 2, from: '1.3.0', to: '1.3.1', at: '2026-10-18T05:00:00.000Z', platform: 'darwin', strategy: 'macos-dmg' })],
    ['a malformed version', JSON.stringify({ schema: 1, from: '1.3', to: '1.3.1', at: '2026-10-18T05:00:00.000Z', platform: 'darwin', strategy: 'macos-dmg' })],
    ['a notify-only strategy', JSON.stringify({ schema: 1, from: '1.3.0', to: '1.3.1', at: '2026-10-18T05:00:00.000Z', platform: 'linux', strategy: 'deb-notify' })],
    ['an unreadable time', JSON.stringify({ schema: 1, from: '1.3.0', to: '1.3.1', at: 'yesterday', platform: 'darwin', strategy: 'macos-dmg' })],
  ])('ignores and removes a record with %s', async (_label, content) => {
    const directory = join(workDir(), 'update-install')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(join(directory, 'last-attempt.json'), content)
    writeFileSync(join(directory, 'last-attempt.result'), '70\n')

    await expect(store(directory).take()).resolves.toBeNull()
    expect(readdirSync(directory)).toEqual([])
  })

  it('never follows a planted link and never rejects', async () => {
    const work = workDir()
    const directory = join(work, 'update-install')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const outside = join(work, 'outside.json')
    writeFileSync(outside, JSON.stringify({ schema: 1, from: '1.3.0', to: '1.3.1', at: '2026-10-18T05:00:00.000Z', platform: 'darwin', strategy: 'macos-dmg' }))
    symlinkSync(outside, join(directory, 'last-attempt.json'))

    await expect(store(directory).take()).resolves.toBeNull()
    expect(existsSync(outside)).toBe(true)
    expect(existsSync(join(directory, 'last-attempt.json'))).toBe(false)

    const missing = createInstallAttemptStore({ directory: join(work, 'never-created'), platform: 'darwin' })
    await expect(missing.take()).resolves.toBeNull()
    await expect(missing.abandon()).resolves.toBeUndefined()
  })

  it('refuses to record into a symlinked folder or a malformed attempt', async () => {
    const work = workDir()
    const elsewhere = join(work, 'elsewhere')
    mkdirSync(elsewhere)
    const directory = join(work, 'update-install')
    symlinkSync(elsewhere, directory)

    await expect(store(directory).begin({ from: '1.3.0', to: '1.3.1', strategy: 'macos-dmg' })).rejects.toThrow()
    expect(readdirSync(elsewhere)).toEqual([])
    expect(lstatSync(directory).isSymbolicLink()).toBe(true)

    const real = join(work, 'real')
    await expect(store(real).begin({ from: '1.3', to: '1.3.1', strategy: 'macos-dmg' })).rejects.toThrow(TypeError)
    await expect(store(real).begin({ from: '1.3.0', to: '1.3.1', strategy: 'deb-notify' as never })).rejects.toThrow(TypeError)
  })
})
