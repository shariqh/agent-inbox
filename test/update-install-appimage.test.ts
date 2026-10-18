import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import * as fsp from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import appImageInstall from '../electron/update-install-appimage.cjs'
import type {
  AppImageInstallFileHandle,
  AppImageInstallFs,
  AppImageInstallStat,
  VerifiedInstallSource,
} from '../electron/update-install-appimage.cjs'
import type { VerifiedArtifact } from '../electron/update-download.cjs'

const { createAppImageInstaller } = appImageInstall
type InstallerOptions = Parameters<typeof createAppImageInstaller>[0]

const repoRoot = resolve(import.meta.dirname, '..')
const MiB = 1024 * 1024
const HOUR = 60 * 60_000
const UID = process.getuid!()
// Permission checks are meaningless for root, which bypasses them.
const asRoot = UID === 0
const realFs = fsp as unknown as AppImageInstallFs
const APPIMAGE_HEADER = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x41, 0x49, 0x02])
const PLAIN_ELF_HEADER = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00])
const STAGE_RE = /^\.Agent-Inbox-v1\.3\.0-linux-x86_64\.AppImage\.update-[0-9a-f]{16}$/

const workDirs: string[] = []
const restoreModes: Array<[string, number]> = []
const openHandles: fsp.FileHandle[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const handle of openHandles.splice(0)) await handle.close().catch(() => {})
  for (const [path, mode] of restoreModes.splice(0).reverse()) chmodSync(path, mode)
  for (const dir of workDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function workDir() {
  const dir = join(repoRoot, `.test-update-install-appimage-${process.pid}-${workDirs.length}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  workDirs.push(dir)
  return dir
}

function chmodFor(path: string, mode: number) {
  restoreModes.push([path, statSync(path).mode & 0o7777])
  chmodSync(path, mode)
}

function sha256(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex')
}

function withHeader(header: Buffer, size: number) {
  const bytes = randomBytes(size)
  header.copy(bytes, 0)
  return bytes
}

const appImageBytes = (size: number) => withHeader(APPIMAGE_HEADER, size)

function errno(code: string) {
  return Object.assign(new Error(`${code}: injected failure`), { code })
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string }
  }
  throw new Error('expected a rejection')
}

function stagesIn(folder: string) {
  return readdirSync(folder).filter((name) => name.includes('.update-'))
}

function identity(path: string) {
  const stat = lstatSync(path, { bigint: true })
  return `${stat.dev}:${stat.ino}`
}

interface Fixture {
  work: string
  folder: string
  appImage: string
  appDir: string
  execPath: string
  oldBytes: Buffer
  newBytes: Buffer
  sourcePath: string
  record: VerifiedArtifact
  relaunch: ReturnType<typeof vi.fn>
  options(overrides?: Partial<InstallerOptions>): InstallerOptions
  installer(overrides?: Partial<InstallerOptions>): ReturnType<typeof createAppImageInstaller>
  source(overrides?: { bytes?: Buffer; record?: Partial<VerifiedArtifact> }): Promise<VerifiedInstallSource>
}

function fixture(newBytes: Buffer = appImageBytes(2 * MiB + 12_345)): Fixture {
  const work = workDir()
  const folder = join(work, 'Applications')
  mkdirSync(folder)
  const appImage = join(folder, 'Agent-Inbox-v1.3.0-linux-x86_64.AppImage')
  const oldBytes = appImageBytes(256 * 1024 + 7)
  writeFileSync(appImage, oldBytes)
  chmodSync(appImage, 0o755)
  // The AppImage runtime mounts the image here and runs the app from inside it.
  const appDir = join(work, '.mount_AgentIn0QvTkK')
  mkdirSync(appDir)
  const execPath = join(appDir, 'agent-inbox')
  const downloads = join(work, 'update-downloads')
  mkdirSync(downloads)
  const filename = 'Agent-Inbox-v1.4.0-linux-x86_64.AppImage'
  const sourcePath = join(downloads, filename)
  writeFileSync(sourcePath, newBytes)
  const record: VerifiedArtifact = {
    path: sourcePath,
    version: '1.4.0',
    tag: 'v1.4.0',
    filename,
    sha256: sha256(newBytes),
    byteLength: newBytes.length,
    packageType: 'appimage',
    installStrategy: 'appimage-self-replace',
  }
  const relaunch = vi.fn()
  const options = (overrides: Partial<InstallerOptions> = {}): InstallerOptions => ({
    env: { APPIMAGE: appImage, APPDIR: appDir, HOME: work },
    execPath,
    uid: UID,
    platform: 'linux',
    isPackaged: true,
    relaunch,
    ...overrides,
  })
  return {
    work,
    folder,
    appImage,
    appDir,
    execPath,
    oldBytes,
    newBytes,
    sourcePath,
    record,
    relaunch,
    options,
    installer: (overrides) => createAppImageInstaller(options(overrides)),
    async source(overrides = {}) {
      let path = sourcePath
      if (overrides.bytes) {
        path = join(downloads, `variant-${openHandles.length}`)
        writeFileSync(path, overrides.bytes)
      }
      const handle = await fsp.open(path, 'r')
      openHandles.push(handle)
      return {
        record: { ...record, ...overrides.record },
        handle: handle as unknown as VerifiedInstallSource['handle'],
      }
    },
  }
}

interface Call {
  op: string
  path: string
  to?: string
  flags?: number
}

function recordingFs(calls: Call[], base: AppImageInstallFs = realFs): AppImageInstallFs {
  return {
    lstat: (path, options) => {
      calls.push({ op: 'lstat', path })
      return base.lstat(path, options)
    },
    access: (path, mode) => {
      calls.push({ op: 'access', path })
      return base.access(path, mode)
    },
    open: (path, flags, mode) => {
      calls.push({ op: 'open', path, flags })
      return base.open(path, flags, mode)
    },
    rename: (from, to) => {
      calls.push({ op: 'rename', path: from, to })
      return base.rename(from, to)
    },
    unlink: (path) => {
      calls.push({ op: 'unlink', path })
      return base.unlink(path)
    },
    readdir: (path) => {
      calls.push({ op: 'readdir', path })
      return base.readdir(path)
    },
  }
}

const WRITE_FLAGS = constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND

/** lstat answers for `decoy` at `target`: a file swapped in after the lstat. */
function swappedAfterLstat(target: string, decoy: string): AppImageInstallFs {
  return { ...realFs, lstat: (path, options) => realFs.lstat(path === target ? decoy : path, options) }
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

describe('AppImage install feasibility', () => {
  it('accepts a writable AppImage the app is running from, without touching anything', async () => {
    const fx = fixture()
    const calls: Call[] = []
    const before = { bytes: readFileSync(fx.appImage), id: identity(fx.appImage), listing: readdirSync(fx.folder) }

    const installer = fx.installer({ fsImpl: recordingFs(calls) })
    expect(installer.strategy).toBe('appimage-self-replace')
    await expect(installer.feasibility({ version: '1.4.0' })).resolves.toEqual({ ok: true })

    expect(calls.map((call) => call.op).every((op) => ['lstat', 'access', 'open'].includes(op))).toBe(true)
    expect(calls.filter((call) => call.op === 'open' && ((call.flags ?? 0) & WRITE_FLAGS) !== 0)).toEqual([])
    expect(readFileSync(fx.appImage).equals(before.bytes)).toBe(true)
    expect(identity(fx.appImage)).toBe(before.id)
    expect(readdirSync(fx.folder)).toEqual(before.listing)
    expect(fx.relaunch).not.toHaveBeenCalled()
  })

  type Case = [label: string, arrange: (fx: Fixture) => Partial<InstallerOptions> | void, reason: string]
  const cases: Case[] = [
    ['a non-Linux host', () => ({ platform: 'darwin' }), 'unsupported-platform'],
    ['an unpackaged (development) app', () => ({ isPackaged: false }), 'not-packaged'],
    ['no APPIMAGE variable', (fx) => ({ env: { APPDIR: fx.appDir } }), 'not-appimage'],
    ['an empty APPIMAGE variable', (fx) => ({ env: { APPIMAGE: '', APPDIR: fx.appDir } }), 'not-appimage'],
    ['a relative APPIMAGE path', (fx) => ({ env: { APPIMAGE: 'Applications/Agent-Inbox-v1.3.0-linux-x86_64.AppImage', APPDIR: fx.appDir } }), 'not-appimage'],
    ['a non-canonical APPIMAGE path', (fx) => ({ env: { APPIMAGE: `${fx.folder}/../Applications/Agent-Inbox-v1.3.0-linux-x86_64.AppImage`, APPDIR: fx.appDir } }), 'not-appimage'],
    ['no APPDIR variable', (fx) => ({ env: { APPIMAGE: fx.appImage } }), 'not-appimage'],
    ['a relative APPDIR', (fx) => ({ env: { APPIMAGE: fx.appImage, APPDIR: '.mount_AgentIn0QvTkK' } }), 'not-appimage'],
    ['APPDIR at the filesystem root', (fx) => ({ env: { APPIMAGE: fx.appImage, APPDIR: '/' } }), 'not-appimage'],
    // A .deb install launched from another AppImage inherits its APPIMAGE/APPDIR.
    ['an app running outside APPDIR (a stray inherited APPIMAGE)', () => ({ execPath: '/opt/Agent Inbox/agent-inbox' }), 'not-appimage'],
    ['an app in a sibling folder that shares the APPDIR prefix', (fx) => ({ execPath: `${fx.appDir}-other/agent-inbox` }), 'not-appimage'],
    ['an app whose executable path is APPDIR itself', (fx) => ({ execPath: fx.appDir }), 'not-appimage'],
    ['a relative executable path', () => ({ execPath: 'agent-inbox' }), 'not-appimage'],
    ['a missing AppImage file', (fx) => { unlinkSync(fx.appImage) }, 'not-regular-file'],
    ['a symlinked AppImage', (fx) => {
      const real = join(fx.work, 'real.AppImage')
      renameSync(fx.appImage, real)
      symlinkSync(real, fx.appImage)
    }, 'not-regular-file'],
    ['a directory at the AppImage path', (fx) => {
      unlinkSync(fx.appImage)
      mkdirSync(fx.appImage)
    }, 'not-regular-file'],
    ['an AppImage owned by another user', () => ({ uid: UID + 1 }), 'not-owner'],
    ['an invalid user id', () => ({ uid: Number.NaN }), 'not-owner'],
    ['a file that is not an ELF executable', (fx) => { writeFileSync(fx.appImage, withHeader(Buffer.from('#!/bin/sh\necho'), 4096)) }, 'not-recognized'],
    ['an ELF file without the AppImage type 2 magic', (fx) => { writeFileSync(fx.appImage, withHeader(PLAIN_ELF_HEADER, 4096)) }, 'not-recognized'],
    ['a file too short to carry the magic', (fx) => { writeFileSync(fx.appImage, APPIMAGE_HEADER.subarray(0, 10)) }, 'not-recognized'],
    ['an empty file', (fx) => { writeFileSync(fx.appImage, Buffer.alloc(0)) }, 'not-recognized'],
    ['an AppImage reached through a symlinked folder', (fx) => {
      const link = join(fx.work, 'Linked')
      symlinkSync(fx.folder, link)
      return { env: { APPIMAGE: join(link, 'Agent-Inbox-v1.3.0-linux-x86_64.AppImage'), APPDIR: fx.appDir } }
    }, 'read-only'],
  ]

  it.each(cases)('refuses %s with a plain-language message', async (_label, arrange, reason) => {
    const fx = fixture()
    const overrides = arrange(fx) ?? {}
    const result = await fx.installer(overrides).feasibility({ version: '1.4.0' })

    expect(result).toMatchObject({ ok: false, reason })
    if (result.ok) return
    expect(result.message).toMatch(/^Agent Inbox can.t .+\.$/)
    expect(result.message).toContain('release page')
    expect(result.message).not.toContain('/')
    expect(result.message).not.toContain(fx.work)
  })

  it.skipIf(asRoot)('refuses an AppImage the user cannot write', async () => {
    const fx = fixture()
    chmodFor(fx.appImage, 0o555)
    expect(await fx.installer().feasibility({ version: '1.4.0' })).toMatchObject({ ok: false, reason: 'read-only' })
  })

  it.skipIf(asRoot)('refuses an AppImage in a folder the user cannot write', async () => {
    const fx = fixture()
    chmodFor(fx.folder, 0o555)
    expect(await fx.installer().feasibility({ version: '1.4.0' })).toMatchObject({ ok: false, reason: 'read-only' })
  })

  it('refuses a read-only file system the way it refuses an unwritable folder', async () => {
    const fx = fixture()
    const fsImpl: AppImageInstallFs = {
      ...realFs,
      access: async (path, mode) => {
        if (path === fx.folder) throw errno('EROFS')
        return realFs.access(path, mode)
      },
    }
    expect(await fx.installer({ fsImpl }).feasibility({ version: '1.4.0' })).toMatchObject({ ok: false, reason: 'read-only' })
  })

  it('refuses a named pipe at the AppImage path without blocking on it', async () => {
    const fx = fixture()
    unlinkSync(fx.appImage)
    execFileSync('mkfifo', [fx.appImage])
    expect(await settled(fx.installer().feasibility({ version: '1.4.0' }), fx.appImage))
      .toMatchObject({ ok: false, reason: 'not-regular-file' })
  })

  it('never opens a named pipe swapped in after the lstat in a blocking way', async () => {
    const fx = fixture()
    const decoy = join(fx.work, 'decoy.AppImage')
    writeFileSync(decoy, appImageBytes(4096))
    unlinkSync(fx.appImage)
    execFileSync('mkfifo', [fx.appImage])
    const installer = fx.installer({ fsImpl: swappedAfterLstat(fx.appImage, decoy) })

    expect(await settled(installer.feasibility({ version: '1.4.0' }), fx.appImage))
      .toMatchObject({ ok: false, reason: 'not-regular-file' })
  })

  it('never follows a symlink swapped in after the lstat', async () => {
    const fx = fixture()
    const decoy = join(fx.work, 'decoy.AppImage')
    writeFileSync(decoy, appImageBytes(4096))
    unlinkSync(fx.appImage)
    symlinkSync(decoy, fx.appImage)
    const installer = fx.installer({ fsImpl: swappedAfterLstat(fx.appImage, decoy) })

    expect(await installer.feasibility({ version: '1.4.0' })).toMatchObject({ ok: false, reason: 'not-regular-file' })
  })

  it('reads the magic only from the file it inspected', async () => {
    const fx = fixture()
    const decoy = join(fx.work, 'decoy.AppImage')
    writeFileSync(decoy, appImageBytes(4096))
    const installer = fx.installer({ fsImpl: swappedAfterLstat(fx.appImage, decoy) })

    expect(await installer.feasibility({ version: '1.4.0' })).toMatchObject({ ok: false, reason: 'not-regular-file' })
  })

  it('refuses a file name too long to stage a sibling for', async () => {
    const fx = fixture()
    const fits = join(fx.folder, `${'a'.repeat(221)}.AppImage`)
    const tooLong = join(fx.folder, `${'a'.repeat(222)}.AppImage`)
    for (const path of [fits, tooLong]) {
      writeFileSync(path, appImageBytes(4096))
      chmodSync(path, 0o755)
    }

    await expect(fx.installer({ env: { APPIMAGE: fits, APPDIR: fx.appDir } }).feasibility({ version: '1.4.0' }))
      .resolves.toEqual({ ok: true })
    expect(await fx.installer({ env: { APPIMAGE: tooLong, APPDIR: fx.appDir } }).feasibility({ version: '1.4.0' }))
      .toMatchObject({ ok: false, reason: 'name-too-long' })
  })

  it('never rejects, even when the file system or environment throws', async () => {
    const fx = fixture()
    const broken: AppImageInstallFs = {
      lstat: async () => { throw errno('EIO') },
      access: async () => { throw errno('EIO') },
      open: async () => { throw errno('EIO') },
      rename: async () => { throw errno('EIO') },
      unlink: async () => { throw errno('EIO') },
      readdir: async () => { throw errno('EIO') },
    }
    expect(await fx.installer({ fsImpl: broken }).feasibility({ version: '1.4.0' })).toMatchObject({ ok: false })

    const hostileEnv = new Proxy({}, { get() { throw new Error('boom') } })
    expect(await fx.installer({ env: hostileEnv }).feasibility({ version: '1.4.0' }))
      .toMatchObject({ ok: false, reason: 'unexpected' })
    expect(await fx.installer().feasibility(undefined as never)).toEqual({ ok: true })
  })
})

function wrapHandle(handle: AppImageInstallFileHandle, overrides: Partial<AppImageInstallFileHandle> = {}): AppImageInstallFileHandle {
  return {
    read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
    write: (buffer, offset, length, position) => handle.write(buffer, offset, length, position),
    stat: (options) => handle.stat(options),
    chmod: (mode) => handle.chmod(mode),
    sync: () => handle.sync(),
    close: () => handle.close(),
    ...overrides,
  }
}

function onOtherDevice(stat: AppImageInstallStat): AppImageInstallStat {
  return {
    ...stat,
    dev: stat.dev + 1n,
    isFile: () => stat.isFile(),
    isDirectory: () => stat.isDirectory(),
    isSymbolicLink: () => stat.isSymbolicLink(),
  }
}

/** Injects faults into the stage handle only (the one opened with O_CREAT). */
function faultyStageFs(
  faults: { open?: boolean; write?: number; sync?: boolean; chmod?: boolean; close?: boolean },
  closed: () => void = () => {},
): AppImageInstallFs {
  return {
    ...realFs,
    async open(path, flags, mode) {
      if ((flags & constants.O_CREAT) === 0) return realFs.open(path, flags, mode)
      if (faults.open) throw errno('EACCES')
      const handle = await realFs.open(path, flags, mode)
      let writes = 0
      return wrapHandle(handle, {
        async write(buffer, offset, length, position) {
          writes += 1
          if (writes === faults.write) throw errno('ENOSPC')
          return handle.write(buffer, offset, length, position)
        },
        async chmod(mode) {
          if (faults.chmod) throw errno('EPERM')
          return handle.chmod(mode)
        },
        async sync() {
          if (faults.sync) throw errno('EIO')
          return handle.sync()
        },
        async close() {
          closed()
          await handle.close()
          if (faults.close) throw errno('EIO')
        },
      })
    },
  }
}

/** Reports the AppImage (consistently) on a different device from its folder's new files. */
function appImageOnAnotherDevice(appImage: string): AppImageInstallFs {
  return {
    ...realFs,
    async lstat(path, options) {
      const stat = await realFs.lstat(path, options)
      return path === appImage ? onOtherDevice(stat) : stat
    },
    async open(path, flags, mode) {
      const handle = await realFs.open(path, flags, mode)
      if (path !== appImage) return handle
      return wrapHandle(handle, { stat: async (options) => onOtherDevice(await handle.stat(options)) })
    },
  }
}

describe('preparing an AppImage update', () => {
  it('stages a verified executable sibling from the handle without touching the running AppImage', async () => {
    const fx = fixture()
    const before = identity(fx.appImage)
    const source = await fx.source()
    const positions: Array<number | null> = []
    const tracked: VerifiedInstallSource = {
      // The handle is the only source: the recorded path is never reopened.
      record: { ...source.record, path: join(fx.work, 'never-opened.AppImage') },
      handle: {
        read: (buffer, offset, length, position) => {
          positions.push(position)
          return source.handle.read(buffer, offset, length, position)
        },
        stat: () => source.handle.stat(),
      },
    }
    const calls: Call[] = []

    const prepared = await fx.installer({ fsImpl: recordingFs(calls) }).prepare(tracked)

    const stages = stagesIn(fx.folder)
    expect(stages).toHaveLength(1)
    expect(stages[0]).toMatch(STAGE_RE)
    const stage = join(fx.folder, stages[0]!)
    const stat = lstatSync(stage)
    expect(stat.isFile()).toBe(true)
    expect(stat.mode & 0o7777).toBe(0o755)
    expect(stat.uid).toBe(UID)
    expect(stat.dev).toBe(lstatSync(fx.appImage).dev)
    expect(readFileSync(stage).equals(fx.newBytes)).toBe(true)

    expect(readFileSync(fx.appImage).equals(fx.oldBytes)).toBe(true)
    expect(identity(fx.appImage)).toBe(before)
    expect(lstatSync(fx.appImage).mode & 0o7777).toBe(0o755)
    expect(fx.relaunch).not.toHaveBeenCalled()

    expect(positions.length).toBeGreaterThan(2)
    expect(positions.every((position) => typeof position === 'number')).toBe(true)
    await expect(source.handle.stat()).resolves.toMatchObject({ size: fx.newBytes.length })
    expect(calls.filter((call) => call.path.includes('update-downloads') || call.path.includes('never-opened'))).toEqual([])
    expect(calls.filter((call) => call.op === 'rename' || call.op === 'unlink')).toEqual([])
    const writes = calls.filter((call) => call.op === 'open' && ((call.flags ?? 0) & WRITE_FLAGS) !== 0)
    expect(writes.map((call) => call.path)).toEqual([stage])
    const exclusive = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
    expect((writes[0]!.flags ?? 0) & exclusive).toBe(exclusive)

    await prepared.discard()
    expect(stagesIn(fx.folder)).toEqual([])
  })

  it('refuses a source whose bytes do not match the signed digest', async () => {
    const fx = fixture()
    const source = await fx.source({ record: { sha256: sha256(Buffer.from('a different build')) } })

    const error = await failure(fx.installer().prepare(source))
    expect(error).toMatchObject({ name: 'UpdateInstallError', code: 'not-verified' })
    expect(error.message).not.toContain('/')
    expect(stagesIn(fx.folder)).toEqual([])
    expect(readFileSync(fx.appImage).equals(fx.oldBytes)).toBe(true)
  })

  it('refuses a source shorter than the signed length, even when the bytes it has hash as signed', async () => {
    const fx = fixture()
    const short = fx.newBytes.subarray(0, fx.newBytes.length - 1)
    const source = await fx.source({ bytes: short, record: { sha256: sha256(short) } })

    expect(await failure(fx.installer().prepare(source))).toMatchObject({ code: 'not-verified' })
    expect(stagesIn(fx.folder)).toEqual([])
  })

  it('refuses a source longer than the signed length, even when its signed prefix hashes as signed', async () => {
    const fx = fixture()
    const source = await fx.source({ bytes: Buffer.concat([fx.newBytes, Buffer.from('trailing')]) })

    expect(await failure(fx.installer().prepare(source))).toMatchObject({ code: 'not-verified' })
    expect(stagesIn(fx.folder)).toEqual([])
  })

  it('refuses a source that keeps yielding bytes past the signed length while reporting the signed size', async () => {
    const fx = fixture()
    const source = await fx.source({ bytes: Buffer.concat([fx.newBytes, Buffer.from('x')]) })
    const growing: VerifiedInstallSource = {
      record: source.record,
      handle: {
        read: (buffer, offset, length, position) => source.handle.read(buffer, offset, length, position),
        stat: async () => ({ isFile: () => true, size: fx.newBytes.length }),
      },
    }

    expect(await failure(fx.installer().prepare(growing))).toMatchObject({ code: 'not-verified' })
    expect(stagesIn(fx.folder)).toEqual([])
  })

  it('refuses a signed build that is not an AppImage', async () => {
    const fx = fixture(withHeader(PLAIN_ELF_HEADER, MiB + 3))

    const error = await failure(fx.installer().prepare(await fx.source()))
    expect(error).toMatchObject({ name: 'UpdateInstallError', code: 'verification-failed' })
    expect(stagesIn(fx.folder)).toEqual([])
    expect(readFileSync(fx.appImage).equals(fx.oldBytes)).toBe(true)
  })

  it('refuses anything but a verified AppImage record before creating a stage', async () => {
    const fx = fixture()
    const calls: Call[] = []
    const installer = fx.installer({ fsImpl: recordingFs(calls) })
    const source = await fx.source()
    const records: Array<Partial<VerifiedArtifact> | null> = [
      { installStrategy: 'macos-dmg' },
      { packageType: 'deb' },
      { byteLength: 0 },
      { byteLength: 1.5 },
      { byteLength: 3 * 1024 ** 3 },
      { sha256: source.record.sha256.toUpperCase() },
      { sha256: 'abc' },
      null,
    ]
    for (const overrides of records) {
      const record = overrides === null ? null : { ...source.record, ...overrides }
      expect(await failure(installer.prepare({ record, handle: source.handle } as never)), JSON.stringify(overrides))
        .toMatchObject({ code: 'not-verified' })
    }
    expect(await failure(installer.prepare({ record: source.record } as never))).toMatchObject({ code: 'not-verified' })
    expect(await failure(installer.prepare(undefined as never))).toMatchObject({ code: 'not-verified' })
    expect(calls.filter((call) => call.op === 'open' && ((call.flags ?? 0) & constants.O_CREAT) !== 0)).toEqual([])
    expect(stagesIn(fx.folder)).toEqual([])
  })

  it('refuses a source handle that is not a regular file or fails while it is read', async () => {
    const fx = fixture()
    const source = await fx.source()
    const variants: Array<VerifiedInstallSource['handle']> = [
      { read: source.handle.read.bind(source.handle), stat: async () => ({ isFile: () => false, size: fx.newBytes.length }) },
      { read: source.handle.read.bind(source.handle), stat: async () => { throw errno('EIO') } },
      { read: async () => { throw errno('EIO') }, stat: source.handle.stat.bind(source.handle) },
      { read: async (_buffer, _offset, length) => ({ bytesRead: length + 1 }), stat: source.handle.stat.bind(source.handle) },
      { read: async () => ({ bytesRead: -1 }), stat: source.handle.stat.bind(source.handle) },
    ]
    for (const handle of variants) {
      expect(await failure(fx.installer().prepare({ record: source.record, handle }))).toMatchObject({ code: 'not-verified' })
      expect(stagesIn(fx.folder)).toEqual([])
    }
    expect(readFileSync(fx.appImage).equals(fx.oldBytes)).toBe(true)
  })

  type StageFaults = Parameters<typeof faultyStageFs>[0]
  it.each<[string, StageFaults]>([
    ['the stage cannot be created', { open: true }],
    ['a write fails', { write: 2 }],
    ['fsync fails', { sync: true }],
    ['chmod fails', { chmod: true }],
    ['close fails', { close: true }],
  ])('removes the stage when %s', async (_label, faults) => {
    const fx = fixture()
    const closed = vi.fn()

    const error = await failure(fx.installer({ fsImpl: faultyStageFs(faults, closed) }).prepare(await fx.source()))
    expect(error).toMatchObject({ name: 'UpdateInstallError', code: 'staging' })
    expect(error.message).not.toContain('/')
    expect(stagesIn(fx.folder)).toEqual([])
    expect(readFileSync(fx.appImage).equals(fx.oldBytes)).toBe(true)
    if (!faults.open) expect(closed).toHaveBeenCalled()
  })

  it('refuses to stage on a different file system from the AppImage', async () => {
    const fx = fixture()

    const error = await failure(fx.installer({ fsImpl: appImageOnAnotherDevice(fx.appImage) }).prepare(await fx.source()))
    expect(error).toMatchObject({ code: 'staging' })
    expect(stagesIn(fx.folder)).toEqual([])
    expect(readFileSync(fx.appImage).equals(fx.oldBytes)).toBe(true)
  })

  it('stops and removes the stage when the signal aborts mid-copy', async () => {
    const fx = fixture()
    const controller = new AbortController()
    const source = await fx.source()
    let reads = 0
    const aborting: VerifiedInstallSource = {
      record: source.record,
      handle: {
        async read(buffer, offset, length, position) {
          const result = await source.handle.read(buffer, offset, length, position)
          reads += 1
          if (reads === 1) controller.abort()
          return result
        },
        stat: () => source.handle.stat(),
      },
    }

    const error = await failure(fx.installer().prepare(aborting, { signal: controller.signal }))
    expect(error).toMatchObject({ name: 'UpdateInstallError', code: 'staging' })
    expect(reads).toBeLessThanOrEqual(2)
    expect(stagesIn(fx.folder)).toEqual([])
    expect(readFileSync(fx.appImage).equals(fx.oldBytes)).toBe(true)
  })

  it('creates nothing when the signal has already aborted', async () => {
    const fx = fixture()
    const calls: Call[] = []
    const controller = new AbortController()
    controller.abort()

    const error = await failure(fx.installer({ fsImpl: recordingFs(calls) }).prepare(await fx.source(), { signal: controller.signal }))
    expect(error).toMatchObject({ code: 'staging' })
    expect(calls.filter((call) => call.op === 'open' && ((call.flags ?? 0) & constants.O_CREAT) !== 0)).toEqual([])
    expect(stagesIn(fx.folder)).toEqual([])
  })

  it('never reuses, follows or removes something already at the stage name', async () => {
    const fx = fixture()
    const taken = Buffer.from('0123456789abcdef', 'hex')
    const plantedName = '.Agent-Inbox-v1.3.0-linux-x86_64.AppImage.update-0123456789abcdef'
    const planted = join(fx.folder, plantedName)
    const outside = join(fx.work, 'outside.txt')
    writeFileSync(outside, 'keep me')
    symlinkSync(outside, planted)

    const error = await failure(fx.installer({ randomImpl: () => taken }).prepare(await fx.source()))
    expect(error).toMatchObject({ code: 'staging' })
    expect(lstatSync(planted).isSymbolicLink()).toBe(true)
    expect(readFileSync(outside, 'utf8')).toBe('keep me')
    expect(stagesIn(fx.folder)).toEqual([plantedName])

    const names = [taken, Buffer.from('fedcba9876543210', 'hex')]
    const prepared = await fx.installer({ randomImpl: () => names.shift() ?? randomBytes(8) }).prepare(await fx.source())
    expect(stagesIn(fx.folder).sort()).toEqual([
      plantedName,
      '.Agent-Inbox-v1.3.0-linux-x86_64.AppImage.update-fedcba9876543210',
    ].sort())
    await prepared.discard()
    expect(stagesIn(fx.folder)).toEqual([plantedName])
    expect(readFileSync(outside, 'utf8')).toBe('keep me')
  })

  it('refuses to prepare once the AppImage can no longer be replaced', async () => {
    const fx = fixture()
    const moved = join(fx.work, 'moved.AppImage')
    renameSync(fx.appImage, moved)

    const error = await failure(fx.installer().prepare(await fx.source()))
    expect(error).toMatchObject({ name: 'UpdateInstallError', code: 'not-feasible' })
    expect(error.message).not.toContain('/')
    expect(readdirSync(fx.folder)).toEqual([])
    expect(await failure(fx.installer({ platform: 'darwin' }).prepare(await fx.source()))).toMatchObject({ code: 'not-feasible' })
  })
})

describe('committing an AppImage update', () => {
  it('atomically replaces the AppImage, keeps the running image readable, then relaunches once', async () => {
    const fx = fixture()
    const calls: Call[] = []
    const replacedAtRelaunch: boolean[] = []
    fx.relaunch.mockImplementation(() => {
      replacedAtRelaunch.push(readFileSync(fx.appImage).equals(fx.newBytes))
    })
    // The running AppImage's mount holds the old inode open until the app exits.
    const running = openSync(fx.appImage, 'r')
    try {
      const prepared = await fx.installer({ fsImpl: recordingFs(calls) }).prepare(await fx.source())
      const stage = join(fx.folder, stagesIn(fx.folder)[0]!)
      const staged = identity(stage)
      calls.length = 0

      await expect(prepared.commit()).resolves.toBeUndefined()

      expect(readFileSync(fx.appImage).equals(fx.newBytes)).toBe(true)
      expect(identity(fx.appImage)).toBe(staged)
      expect(lstatSync(fx.appImage).mode & 0o7777).toBe(0o755)
      expect(stagesIn(fx.folder)).toEqual([])
      expect(fx.relaunch).toHaveBeenCalledTimes(1)
      expect(replacedAtRelaunch).toEqual([true])
      const old = Buffer.alloc(fx.oldBytes.length)
      expect(readSync(running, old, 0, old.length, 0)).toBe(old.length)
      expect(old.equals(fx.oldBytes)).toBe(true)
      const mutations = calls.filter((call) => call.op === 'rename' || call.op === 'unlink'
        || (call.op === 'open' && ((call.flags ?? 0) & WRITE_FLAGS) !== 0))
      expect(mutations).toEqual([{ op: 'rename', path: stage, to: fx.appImage }])
    } finally {
      closeSync(running)
    }
  })

  it('refuses to replace an AppImage that was itself replaced after prepare', async () => {
    const fx = fixture()
    const prepared = await fx.installer().prepare(await fx.source())
    const moved = join(fx.work, 'moved.AppImage')
    renameSync(fx.appImage, moved)
    const replacement = appImageBytes(4096)
    writeFileSync(fx.appImage, replacement)

    const error = await failure(prepared.commit())
    expect(error).toMatchObject({ name: 'UpdateInstallError', code: 'commit-failed' })
    expect(error.message).not.toContain('/')
    expect(readFileSync(fx.appImage).equals(replacement)).toBe(true)
    expect(readFileSync(moved).equals(fx.oldBytes)).toBe(true)
    expect(stagesIn(fx.folder)).toEqual([])
    expect(fx.relaunch).not.toHaveBeenCalled()
  })

  it('refuses to recreate an AppImage that was moved away after prepare', async () => {
    const fx = fixture()
    const prepared = await fx.installer().prepare(await fx.source())
    const moved = join(fx.work, 'moved.AppImage')
    renameSync(fx.appImage, moved)

    expect(await failure(prepared.commit())).toMatchObject({ code: 'commit-failed' })
    expect(existsSync(fx.appImage)).toBe(false)
    expect(readFileSync(moved).equals(fx.oldBytes)).toBe(true)
    expect(stagesIn(fx.folder)).toEqual([])
    expect(fx.relaunch).not.toHaveBeenCalled()
  })

  it('refuses when the AppImage folder was swapped after prepare, even for the very same files', async () => {
    const fx = fixture()
    const prepared = await fx.installer().prepare(await fx.source())
    const stageName = stagesIn(fx.folder)[0]!
    const swapped = join(fx.work, 'Swapped')
    mkdirSync(swapped)
    linkSync(fx.appImage, join(swapped, 'Agent-Inbox-v1.3.0-linux-x86_64.AppImage'))
    linkSync(join(fx.folder, stageName), join(swapped, stageName))
    renameSync(fx.folder, join(fx.work, 'Applications-before'))
    renameSync(swapped, fx.folder)

    expect(await failure(prepared.commit())).toMatchObject({ code: 'commit-failed' })
    expect(readFileSync(fx.appImage).equals(fx.oldBytes)).toBe(true)
    expect(fx.relaunch).not.toHaveBeenCalled()
  })

  it('refuses a stage replaced after prepare and leaves the stranger alone', async () => {
    const fx = fixture()
    const prepared = await fx.installer().prepare(await fx.source())
    const stage = join(fx.folder, stagesIn(fx.folder)[0]!)
    const stranger = appImageBytes(4096)
    // Written first, so the stranger cannot reuse the stage's inode number.
    const pending = join(fx.work, 'stranger.AppImage')
    writeFileSync(pending, stranger)
    renameSync(pending, stage)

    expect(await failure(prepared.commit())).toMatchObject({ code: 'commit-failed' })
    expect(readFileSync(fx.appImage).equals(fx.oldBytes)).toBe(true)
    expect(readFileSync(stage).equals(stranger)).toBe(true)
    expect(fx.relaunch).not.toHaveBeenCalled()
  })

  it('leaves the AppImage untouched and removes the stage when the rename fails', async () => {
    const fx = fixture()
    const fsImpl: AppImageInstallFs = { ...realFs, rename: async () => { throw errno('EXDEV') } }
    const prepared = await fx.installer({ fsImpl }).prepare(await fx.source())

    const error = await failure(prepared.commit())
    expect(error).toMatchObject({ name: 'UpdateInstallError', code: 'commit-failed' })
    expect(error.message).not.toContain('/')
    expect(readFileSync(fx.appImage).equals(fx.oldBytes)).toBe(true)
    expect(stagesIn(fx.folder)).toEqual([])
    expect(fx.relaunch).not.toHaveBeenCalled()
  })

  it('still resolves with the new build in place when the relaunch throws', async () => {
    const fx = fixture()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    fx.relaunch.mockImplementation(() => {
      throw new Error(`could not relaunch ${fx.appImage}`)
    })
    const prepared = await fx.installer().prepare(await fx.source())

    await expect(prepared.commit()).resolves.toBeUndefined()
    expect(readFileSync(fx.appImage).equals(fx.newBytes)).toBe(true)
    expect(stagesIn(fx.folder)).toEqual([])
    expect(fx.relaunch).toHaveBeenCalledTimes(1)
    expect(logged).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(logged.mock.calls)).not.toContain(fx.work)
  })

  it('treats the folder fsync as best-effort', async () => {
    const fx = fixture()
    const fsImpl: AppImageInstallFs = {
      ...realFs,
      async open(path, flags, mode) {
        if (path === fx.folder) throw errno('EINVAL')
        return realFs.open(path, flags, mode)
      },
    }
    const prepared = await fx.installer({ fsImpl }).prepare(await fx.source())

    await expect(prepared.commit()).resolves.toBeUndefined()
    expect(readFileSync(fx.appImage).equals(fx.newBytes)).toBe(true)
    expect(fx.relaunch).toHaveBeenCalledTimes(1)
  })

  it('commits once, and never commits a discarded install', async () => {
    const fx = fixture()
    const calls: Call[] = []
    const installer = fx.installer({ fsImpl: recordingFs(calls) })
    const prepared = await installer.prepare(await fx.source())

    await Promise.all([prepared.commit(), prepared.commit()])
    await expect(prepared.commit()).resolves.toBeUndefined()
    expect(calls.filter((call) => call.op === 'rename')).toHaveLength(1)
    expect(fx.relaunch).toHaveBeenCalledTimes(1)

    const discarded = await installer.prepare(await fx.source())
    await discarded.discard()
    expect(await failure(discarded.commit())).toMatchObject({ code: 'commit-failed' })
    expect(readFileSync(fx.appImage).equals(fx.newBytes)).toBe(true)
    expect(stagesIn(fx.folder)).toEqual([])
    expect(calls.filter((call) => call.op === 'rename')).toHaveLength(1)
  })
})

describe('discarding an AppImage update', () => {
  it('removes only its own stage, idempotently, and never rejects', async () => {
    const fx = fixture()
    const prepared = await fx.installer().prepare(await fx.source())
    expect(stagesIn(fx.folder)).toHaveLength(1)

    await expect(prepared.discard()).resolves.toBeUndefined()
    await expect(prepared.discard()).resolves.toBeUndefined()
    expect(stagesIn(fx.folder)).toEqual([])
    expect(readFileSync(fx.appImage).equals(fx.oldBytes)).toBe(true)

    const replaced = await fx.installer().prepare(await fx.source())
    const stage = join(fx.folder, stagesIn(fx.folder)[0]!)
    const pending = join(fx.work, 'stranger')
    writeFileSync(pending, 'not ours')
    renameSync(pending, stage)
    await expect(replaced.discard()).resolves.toBeUndefined()
    expect(readFileSync(stage, 'utf8')).toBe('not ours')
    unlinkSync(stage)

    const fsImpl: AppImageInstallFs = { ...realFs, unlink: async () => { throw errno('EIO') } }
    const stuck = await fx.installer({ fsImpl }).prepare(await fx.source())
    await expect(stuck.discard()).resolves.toBeUndefined()
    expect(readFileSync(fx.appImage).equals(fx.oldBytes)).toBe(true)
  })

  it('never removes the installed build after a commit', async () => {
    const fx = fixture()
    const prepared = await fx.installer().prepare(await fx.source())
    await prepared.commit()

    await expect(prepared.discard()).resolves.toBeUndefined()
    expect(readFileSync(fx.appImage).equals(fx.newBytes)).toBe(true)
  })

  it('lets an in-flight commit finish before reporting the stage gone', async () => {
    const fx = fixture()
    const prepared = await fx.installer().prepare(await fx.source())

    await Promise.all([prepared.commit(), prepared.discard()])
    expect(readFileSync(fx.appImage).equals(fx.newBytes)).toBe(true)
    expect(stagesIn(fx.folder)).toEqual([])
    expect(fx.relaunch).toHaveBeenCalledTimes(1)
  })
})

describe('AppImage stage cleanup', () => {
  const NAME = 'Agent-Inbox-v1.3.0-linux-x86_64.AppImage'

  function age(path: string, ageMs = 2 * HOUR) {
    const when = new Date(Date.now() - ageMs)
    lutimesSync(path, when, when)
  }

  function stage(fx: Fixture, hex: string, ageMs = 2 * HOUR) {
    const path = join(fx.folder, `.${NAME}.update-${hex}`)
    writeFileSync(path, 'partial')
    age(path, ageMs)
    return path
  }

  const gone = (path: string) => {
    try {
      lstatSync(path)
      return false
    } catch {
      return true
    }
  }

  it('removes only stale stages named exactly as it names them', async () => {
    const fx = fixture()
    const stale = stage(fx, '0123456789abcdef')
    const fresh = stage(fx, '1111111111111111', 60_000)
    const others = [
      // Distinct from every lowercase name here: macOS file systems ignore case.
      `.${NAME}.update-89ABCDEF01234567`,
      `.${NAME}.update-0123456789abcde`,
      `.${NAME}.update-0123456789abcdef0`,
      `${NAME}.update-0123456789abcdef`,
      '.Other.AppImage.update-0123456789abcdef',
      'notes.txt',
    ].map((name) => {
      const path = join(fx.folder, name)
      writeFileSync(path, 'not a stage')
      age(path)
      return path
    })
    const directory = join(fx.folder, `.${NAME}.update-2222222222222222`)
    mkdirSync(directory)
    age(directory)
    age(fx.appImage)

    await expect(fx.installer().cleanup()).resolves.toBeUndefined()
    expect(gone(stale)).toBe(true)
    for (const path of [fresh, ...others, directory]) expect(gone(path), path).toBe(false)
    expect(readFileSync(fx.appImage).equals(fx.oldBytes)).toBe(true)
  })

  it('unlinks a planted symlink, never its target', async () => {
    const fx = fixture()
    const outside = join(fx.work, 'outside.txt')
    writeFileSync(outside, 'keep me')
    const toOutside = join(fx.folder, `.${NAME}.update-3333333333333333`)
    const toAppImage = join(fx.folder, `.${NAME}.update-4444444444444444`)
    symlinkSync(outside, toOutside)
    symlinkSync(fx.appImage, toAppImage)
    for (const path of [toOutside, toAppImage, outside, fx.appImage]) age(path)

    await fx.installer().cleanup()
    expect(gone(toOutside)).toBe(true)
    expect(gone(toAppImage)).toBe(true)
    expect(readFileSync(outside, 'utf8')).toBe('keep me')
    expect(readFileSync(fx.appImage).equals(fx.oldBytes)).toBe(true)
  })

  it('leaves stages that belong to another user', async () => {
    const fx = fixture()
    const stale = stage(fx, '5555555555555555')

    await fx.installer({ uid: UID + 1 }).cleanup()
    expect(gone(stale)).toBe(false)
  })

  it('bounds the removals of one pass', async () => {
    const fx = fixture()
    for (let index = 0; index < 20; index += 1) stage(fx, index.toString(16).padStart(16, '0'))

    await fx.installer().cleanup()
    expect(stagesIn(fx.folder)).toHaveLength(4)
    await fx.installer().cleanup()
    expect(stagesIn(fx.folder)).toHaveLength(0)
  })

  it('does nothing outside a proven AppImage environment and never rejects', async () => {
    const fx = fixture()
    const stale = stage(fx, '6666666666666666')

    await fx.installer({ execPath: '/opt/Agent Inbox/agent-inbox' }).cleanup()
    await fx.installer({ platform: 'darwin' }).cleanup()
    await fx.installer({ isPackaged: false }).cleanup()
    await fx.installer({ env: { APPDIR: fx.appDir } }).cleanup()
    expect(gone(stale)).toBe(false)

    for (const fsImpl of [
      { ...realFs, readdir: async () => { throw errno('EIO') } },
      { ...realFs, lstat: async () => { throw errno('EIO') } },
      { ...realFs, unlink: async () => { throw errno('EIO') } },
    ] satisfies AppImageInstallFs[]) {
      await expect(fx.installer({ fsImpl }).cleanup()).resolves.toBeUndefined()
    }
    expect(gone(stale)).toBe(false)
    const hostileEnv = new Proxy({}, { get() { throw new Error('boom') } })
    await expect(fx.installer({ env: hostileEnv }).cleanup()).resolves.toBeUndefined()
  })

  it('keeps a stage this installer is still using, however old', async () => {
    const fx = fixture()
    const installer = fx.installer()
    const prepared = await installer.prepare(await fx.source())
    const staged = join(fx.folder, stagesIn(fx.folder)[0]!)
    age(staged)

    await installer.cleanup()
    expect(gone(staged)).toBe(false)
    await prepared.commit()
    expect(readFileSync(fx.appImage).equals(fx.newBytes)).toBe(true)
  })
})

describe('AppImage installer boundaries', () => {
  it('stays out of the MCP graph, runs no programs and never reads the recorded path', () => {
    const source = readFileSync(join(repoRoot, 'electron', 'update-install-appimage.cjs'), 'utf8')
    for (const forbidden of ['child_process', "require('electron')", 'openPath', 'spawn', 'hdiutil', 'record.path', 'attention']) {
      expect(source, forbidden).not.toContain(forbidden)
    }
    const srcDir = join(repoRoot, 'src')
    const sources = readdirSync(srcDir, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.ts'))
    expect(sources.length).toBeGreaterThan(10)
    for (const name of sources) {
      expect(readFileSync(join(srcDir, name), 'utf8'), name).not.toContain('update-install-appimage')
    }
  })
})
