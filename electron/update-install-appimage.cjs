'use strict'

// Electron-main-only AppImage self-replace (#196, part 3). Given an open
// handle on a verified download, it stages the new build as a hidden sibling of
// the AppImage file the app runs from (same directory, hence the same file
// system), hashing exactly the bytes it copies, and commits with one rename
// over that file. Until the rename nothing the user runs has changed. After it,
// the running app keeps executing from its mount of the old inode, which lives
// until the process exits, and a detached host /bin/sh helper starts the new
// file once this process (and any viewer child) has exited. Electron's own
// relaunch is unusable here: its helper runs from the old mount, which is torn
// down as the app exits.
//
// Every step re-proves that this process runs from that AppImage: APPIMAGE and
// APPDIR must be canonical absolute paths and the executable must live inside
// APPDIR. A stray inherited APPIMAGE (a .deb install started from another
// AppImage) therefore never points this module at somebody else's file. The
// file must also still be the one this process started from.

const { createHash, randomBytes } = require('node:crypto')
const { constants } = require('node:fs')
const fs = require('node:fs/promises')
const path = require('node:path')

const STRATEGY = 'appimage-self-replace'
const SHA256_RE = /^[0-9a-f]{64}$/
const STAGE_SUFFIX_RE = /^[0-9a-f]{16}$/
const STAGE_RANDOM_BYTES = 8
const STAGE_ATTEMPTS = 3
const NAME_MAX_BYTES = 255
// A sanity bound above any real package; the signed byteLength is the real cap.
const MAX_ARTIFACT_BYTES = 2 * 1024 ** 3
const COPY_CHUNK_BYTES = 1024 * 1024
const MAGIC_BYTES = 11
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46])
// AppImage type 2 stores "AI" and the type byte at offset 8 of the ELF header.
const APPIMAGE_TYPE2_MAGIC = Buffer.from([0x41, 0x49, 0x02])
const STAGE_MODE = 0o600
const INSTALLED_MODE = 0o755
const STALE_AFTER_MS = 60 * 60_000
const MAX_CLEANUP_REMOVALS = 16
const MAX_CLEANUP_CANDIDATES = 64
const BIGINT = Object.freeze({ bigint: true })
// O_NOFOLLOW refuses a symlink swapped in after the lstat; O_NONBLOCK keeps a
// named pipe swapped in from blocking open() (it then fails the file check).
const OPEN_READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
const OPEN_STAGE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0)
const OPEN_DIRECTORY_FLAGS = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)
const HELPER_SHELL = '/bin/sh'
const HELPER_NAME = 'agent-inbox-relaunch'
const HELPER_POLL_MS = 200
const DEFAULT_HELPER_TIMEOUT_MS = 120_000
// Waits while the app or its viewer child is alive, then replaces itself with
// the new AppImage. Every input arrives as argv; after the poll budget it gives
// up and starts nothing, and the user opens the already-installed file.
const RELAUNCH_SCRIPT = [
  'set -u',
  'app_pid="$1"',
  'viewer_pid="$2"',
  'polls="$3"',
  'target="$4"',
  'waited=0',
  'while kill -0 "$app_pid" 2>/dev/null || { [ "$viewer_pid" -gt 0 ] && kill -0 "$viewer_pid" 2>/dev/null; }; do',
  '  [ "$waited" -lt "$polls" ] || exit 0',
  '  sleep 0.2 2>/dev/null || sleep 1',
  '  waited=$((waited + 1))',
  'done',
  'exec "$target"',
  '',
].join('\n')
// The new AppImage sets these afresh; inherited, they would describe the old one.
const DROPPED_ENV = new Set(['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD', 'TARGET_APPIMAGE'])

const RELEASE_PAGE = 'Download the update from the release page.'
const INFEASIBLE = Object.freeze({
  'unsupported-platform': `Agent Inbox can’t install updates by itself on this system. ${RELEASE_PAGE}`,
  'not-packaged': `Agent Inbox can’t install updates by itself in a development build. ${RELEASE_PAGE}`,
  'not-appimage': `Agent Inbox can’t install updates by itself unless it runs from its AppImage file. ${RELEASE_PAGE}`,
  'name-too-long': `Agent Inbox can’t replace its AppImage file because the file name is too long. ${RELEASE_PAGE}`,
  'not-regular-file': `Agent Inbox can’t safely replace its AppImage file. ${RELEASE_PAGE}`,
  'not-owner': `Agent Inbox can’t replace an AppImage file that belongs to another user. ${RELEASE_PAGE}`,
  'read-only': `Agent Inbox can’t replace its AppImage file in this folder. ${RELEASE_PAGE}`,
  'not-recognized': `Agent Inbox can’t recognize its AppImage file. ${RELEASE_PAGE}`,
  'changed-since-launch': 'The AppImage file changed since Agent Inbox started. Restart Agent Inbox to update.',
  unexpected: `Agent Inbox can’t check whether it can replace its AppImage file. ${RELEASE_PAGE}`,
})
const FEASIBLE = Object.freeze({ ok: true })

const MESSAGES = Object.freeze({
  'not-feasible': 'update installation is not possible for this AppImage',
  'not-verified': 'update file no longer matches the signed release',
  'verification-failed': 'signed update is not an AppImage',
  staging: 'update could not be staged next to the AppImage',
  cancelled: 'update installation was cancelled',
  'commit-failed': 'update could not replace the AppImage; the installed version is unchanged',
})

// Phase-1 stand-in for UpdateInstallError from ./update-install.cjs (#196 part 2).
class UpdateInstallError extends Error {
  constructor(code, message = MESSAGES[code] ?? MESSAGES.staging) {
    super(message)
    this.name = 'UpdateInstallError'
    this.code = code
  }
}

function fail(code, messageKey = code) {
  throw new UpdateInstallError(code, MESSAGES[messageKey])
}

function asInstallError(error) {
  return error instanceof UpdateInstallError ? error : new UpdateInstallError('staging', MESSAGES.staging)
}

function refusal(reason) {
  return Object.freeze({ ok: false, reason, message: INFEASIBLE[reason] })
}

function canonicalAbsolute(value) {
  return typeof value === 'string' && value !== '' && path.isAbsolute(value) && path.resolve(value) === value
    ? value
    : null
}

function isInside(directory, target) {
  const relative = path.relative(directory, target)
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)
}

function stageName(name, suffix) {
  return `.${name}.update-${suffix}`
}

function identityOf(stat) {
  if (typeof stat.dev !== 'bigint' || typeof stat.ino !== 'bigint' || stat.ino === 0n) return null
  return Object.freeze({ dev: stat.dev, ino: stat.ino })
}

function sameIdentity(stat, identity) {
  return identity !== null && stat.dev === identity.dev && stat.ino === identity.ino
}

// Identity plus size and modification time, so an in-place rewrite also counts as a change.
function snapshotOf(stat) {
  const identity = identityOf(stat)
  if (identity === null || typeof stat.size !== 'bigint' || typeof stat.mtimeNs !== 'bigint') return null
  return Object.freeze({ ...identity, size: stat.size, mtimeNs: stat.mtimeNs })
}

function sameSnapshot(left, right) {
  return left !== null
    && right !== null
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
}

function hasAppImageMagic(header) {
  return header.length >= MAGIC_BYTES
    && header.subarray(0, 4).equals(ELF_MAGIC)
    && header.subarray(8, MAGIC_BYTES).equals(APPIMAGE_TYPE2_MAGIC)
}

function validUid(uid) {
  return Number.isSafeInteger(uid) && uid >= 0
}

function isPid(value) {
  return Number.isSafeInteger(value) && value > 0
}

// The new AppImage must not inherit anything that points into the old one's
// mount, which disappears with this process: drop those path-list entries.
function relaunchEnvironment(source, appDir) {
  const result = {}
  for (const key of Object.keys(source)) {
    const value = source[key]
    if (typeof value !== 'string' || DROPPED_ENV.has(key)) continue
    const entries = value.split(':')
    const kept = entries.filter((entry) => {
      if (!path.isAbsolute(entry)) return true
      const resolved = path.resolve(entry)
      return resolved !== appDir && !isInside(appDir, resolved)
    })
    if (kept.length === entries.length) result[key] = value
    else if (kept.length > 0) result[key] = kept.join(':')
  }
  return result
}

function createAppImageInstaller(options) {
  if (options === null || typeof options !== 'object') throw new TypeError('options are required')
  if (typeof options.spawnImpl !== 'function') throw new TypeError('spawnImpl is required')
  if (!isPid(options.pid)) throw new TypeError('pid must be a positive integer')
  const helperTimeoutMs = options.helperTimeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS
  if (!Number.isFinite(helperTimeoutMs) || helperTimeoutMs <= 0) throw new TypeError('helperTimeoutMs must be positive')
  const { env, execPath, uid, platform, isPackaged, pid, viewerPid, spawnImpl } = options
  const helperPolls = Math.max(1, Math.ceil(helperTimeoutMs / HELPER_POLL_MS))
  const fsImpl = options.fsImpl ?? fs
  const randomImpl = options.randomImpl ?? randomBytes
  // Stages this installer still owns; cleanup never touches them, however old.
  const live = new Set()

  // Locates the AppImage this process provably runs from. Reads env each time.
  function locate() {
    if (platform !== 'linux') return refusal('unsupported-platform')
    if (isPackaged !== true) return refusal('not-packaged')
    const appImage = canonicalAbsolute(env?.APPIMAGE)
    const appDir = canonicalAbsolute(env?.APPDIR)
    const executable = canonicalAbsolute(execPath)
    if (
      appImage === null
      || appDir === null
      || appDir === path.parse(appDir).root
      || executable === null
      || !isInside(appDir, executable)
    ) {
      return refusal('not-appimage')
    }
    const name = path.basename(appImage)
    if (Buffer.byteLength(stageName(name, '0'.repeat(STAGE_RANDOM_BYTES * 2))) > NAME_MAX_BYTES) {
      return refusal('name-too-long')
    }
    return { ok: true, appImage, appDir, parent: path.dirname(appImage), name }
  }

  // Taken as the app starts: an AppImage replaced or rewritten since then is no
  // longer the build this process runs, so it is not ours to replace.
  const launched = (async () => {
    const located = locate()
    if (!located.ok) return null
    const stat = await fsImpl.lstat(located.appImage, BIGINT)
    return stat.isFile() ? snapshotOf(stat) : null
  })().catch(() => null)

  async function readMagic(appImage, expected) {
    let handle
    try {
      handle = await fsImpl.open(appImage, OPEN_READ_FLAGS)
    } catch {
      return 'not-regular-file'
    }
    try {
      const opened = await handle.stat(BIGINT)
      if (!opened.isFile() || !sameIdentity(opened, expected)) return 'not-regular-file'
      const header = Buffer.alloc(MAGIC_BYTES)
      let filled = 0
      while (filled < MAGIC_BYTES) {
        const { bytesRead } = await handle.read(header, filled, MAGIC_BYTES - filled, filled)
        if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > MAGIC_BYTES - filled) break
        filled += bytesRead
      }
      return filled === MAGIC_BYTES && hasAppImageMagic(header) ? 'ok' : 'not-recognized'
    } catch {
      return 'not-recognized'
    } finally {
      await handle.close().catch(() => {})
    }
  }

  // Everything prepare() relies on, without writing anything.
  async function inspect() {
    const located = locate()
    if (!located.ok) return located
    const { appImage, parent } = located
    let file
    try {
      file = await fsImpl.lstat(appImage, BIGINT)
    } catch {
      return refusal('not-regular-file')
    }
    const fileSnapshot = snapshotOf(file)
    if (!file.isFile() || fileSnapshot === null) return refusal('not-regular-file')
    if (!sameSnapshot(fileSnapshot, await launched)) return refusal('changed-since-launch')
    if (!validUid(uid) || file.uid !== BigInt(uid)) return refusal('not-owner')
    try {
      await fsImpl.access(appImage, constants.W_OK)
    } catch {
      return refusal('read-only')
    }
    let folder
    try {
      folder = await fsImpl.lstat(parent, BIGINT)
    } catch {
      return refusal('read-only')
    }
    const folderIdentity = identityOf(folder)
    if (!folder.isDirectory() || folderIdentity === null) return refusal('read-only')
    try {
      await fsImpl.access(parent, constants.W_OK | constants.X_OK)
    } catch {
      return refusal('read-only')
    }
    const magic = await readMagic(appImage, fileSnapshot)
    if (magic !== 'ok') return refusal(magic)
    return { ...located, file: fileSnapshot, folder: folderIdentity }
  }

  async function feasibility() {
    try {
      const inspected = await inspect()
      return inspected.ok ? FEASIBLE : inspected
    } catch {
      return refusal('unexpected')
    }
  }

  async function removeIfOurs(target, identity) {
    try {
      const stat = await fsImpl.lstat(target, BIGINT)
      if (stat.isFile() && sameIdentity(stat, identity)) await fsImpl.unlink(target)
    } catch {
      // Already gone, or not removable now: a later cleanup pass retries.
    }
  }

  function checkedRecord(source) {
    const record = source?.record
    const handle = source?.handle
    if (
      record === null
      || typeof record !== 'object'
      || handle === null
      || typeof handle !== 'object'
      || typeof handle.read !== 'function'
      || typeof handle.stat !== 'function'
      || record.installStrategy !== STRATEGY
      || record.packageType !== 'appimage'
      || !Number.isSafeInteger(record.byteLength)
      || record.byteLength <= 0
      || record.byteLength > MAX_ARTIFACT_BYTES
      || typeof record.sha256 !== 'string'
      || !SHA256_RE.test(record.sha256)
    ) {
      fail('not-verified')
    }
    return Object.freeze({ byteLength: record.byteLength, sha256: record.sha256 })
  }

  async function checkSourceSize(handle, expected) {
    try {
      const stat = await handle.stat()
      if (stat.isFile() && stat.size === expected.byteLength) return
    } catch {
      // An unreadable source cannot be verified.
    }
    fail('not-verified')
  }

  function throwIfAborted(signal) {
    if (signal?.aborted) fail('staging', 'cancelled')
  }

  async function createStage(target) {
    for (let attempt = 0; attempt < STAGE_ATTEMPTS; attempt += 1) {
      const suffix = Buffer.from(randomImpl(STAGE_RANDOM_BYTES)).toString('hex')
      if (!STAGE_SUFFIX_RE.test(suffix)) fail('staging')
      const stagePath = path.join(target.parent, stageName(target.name, suffix))
      let handle
      try {
        handle = await fsImpl.open(stagePath, OPEN_STAGE_FLAGS, STAGE_MODE)
      } catch (error) {
        // Never reuse, follow or remove an existing entry: pick another name.
        if (error?.code === 'EEXIST') continue
        fail('staging')
      }
      let identity = null
      let sameDevice = false
      try {
        const stat = await handle.stat(BIGINT)
        identity = stat.isFile() ? identityOf(stat) : null
        // The commit is a rename, which is atomic only within one file system.
        sameDevice = identity !== null && identity.dev === target.file.dev
      } catch {
        identity = null
      }
      if (!sameDevice) {
        await handle.close().catch(() => {})
        if (identity !== null) await removeIfOurs(stagePath, identity)
        fail('staging')
      }
      return { path: stagePath, handle, identity }
    }
    return fail('staging')
  }

  async function writeAll(handle, chunk, position) {
    let offset = 0
    while (offset < chunk.length) {
      let bytesWritten
      try {
        ({ bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, position + offset))
      } catch {
        fail('staging')
      }
      if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > chunk.length - offset) {
        fail('staging')
      }
      offset += bytesWritten
    }
  }

  // Hashes exactly the bytes it writes, and reads one byte past the signed
  // length so a source that is longer than signed is refused.
  async function copyVerified(source, stageHandle, expected, signal) {
    const hash = createHash('sha256')
    const head = Buffer.alloc(MAGIC_BYTES)
    const buffer = Buffer.allocUnsafe(Math.min(COPY_CHUNK_BYTES, expected.byteLength + 1))
    let position = 0
    while (true) {
      throwIfAborted(signal)
      const length = Math.min(buffer.length, expected.byteLength + 1 - position)
      let bytesRead
      try {
        ({ bytesRead } = await source.read(buffer, 0, length, position))
      } catch {
        fail('not-verified')
      }
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > length) fail('not-verified')
      if (bytesRead === 0) break
      if (position + bytesRead > expected.byteLength) fail('not-verified')
      const chunk = buffer.subarray(0, bytesRead)
      hash.update(chunk)
      if (position < MAGIC_BYTES) chunk.copy(head, position, 0, Math.min(bytesRead, MAGIC_BYTES - position))
      await writeAll(stageHandle, chunk, position)
      position += bytesRead
    }
    if (position !== expected.byteLength || hash.digest('hex') !== expected.sha256) fail('not-verified')
    await checkSourceSize(source, expected)
    return head
  }

  async function staging(operation) {
    try {
      return await operation()
    } catch {
      return fail('staging')
    }
  }

  async function syncDirectory(directory) {
    let handle = null
    try {
      handle = await fsImpl.open(directory, OPEN_DIRECTORY_FLAGS)
      await handle.sync()
    } catch {
      // Best-effort: the staged file itself was fsynced before the rename.
    } finally {
      await handle?.close().catch(() => {})
    }
  }

  function currentViewerPid() {
    try {
      const value = typeof viewerPid === 'function' ? viewerPid() : viewerPid
      return isPid(value) ? value : 0
    } catch {
      return 0
    }
  }

  // Resolves true once the detached helper is running, false if it could not start.
  function startHelper(target) {
    return new Promise((resolveStart) => {
      let child
      try {
        child = spawnImpl(
          HELPER_SHELL,
          ['-c', RELAUNCH_SCRIPT, HELPER_NAME, String(pid), String(currentViewerPid()), String(helperPolls), target.appImage],
          { detached: true, stdio: 'ignore', env: relaunchEnvironment(env, target.appDir), cwd: target.parent },
        )
        child.once('spawn', () => {
          try {
            child.unref()
          } catch {
            // It is running either way.
          }
          resolveStart(true)
        })
        // Kept for the child's lifetime: an unhandled 'error' event would throw in main.
        child.on('error', () => resolveStart(false))
      } catch {
        resolveStart(false)
      }
    })
  }

  function preparedInstall(target, stage) {
    let state = 'prepared'
    let committing = null

    async function removeStage() {
      live.delete(stage.path)
      await removeIfOurs(stage.path, stage.identity)
    }

    // Nothing may have replaced the AppImage, its folder or the stage since prepare().
    async function unchanged() {
      try {
        const file = await fsImpl.lstat(target.appImage, BIGINT)
        const folder = await fsImpl.lstat(target.parent, BIGINT)
        const staged = await fsImpl.lstat(stage.path, BIGINT)
        return file.isFile() && sameSnapshot(snapshotOf(file), target.file)
          && folder.isDirectory() && sameIdentity(folder, target.folder)
          && staged.isFile() && sameIdentity(staged, stage.identity)
      } catch {
        return false
      }
    }

    async function runCommit() {
      let renamed = false
      if (await unchanged()) {
        try {
          await fsImpl.rename(stage.path, target.appImage)
          renamed = true
        } catch {
          renamed = false
        }
      }
      if (!renamed) {
        state = 'discarded'
        await removeStage()
        fail('commit-failed')
      }
      // The rename was the commit point: from here on nothing may reject.
      state = 'committed'
      live.delete(stage.path)
      await syncDirectory(target.parent)
      if (!(await startHelper(target))) {
        console.error('[agent-inbox] the update is installed, but Agent Inbox could not schedule its restart; open it again to use the new version')
      }
    }

    return Object.freeze({
      commit() {
        if (committing === null) {
          if (state !== 'prepared') return Promise.reject(new UpdateInstallError('commit-failed', MESSAGES['commit-failed']))
          state = 'committing'
          committing = runCommit()
        }
        return committing
      },
      async discard() {
        try {
          if (committing !== null) {
            await committing.catch(() => {})
            return
          }
          if (state !== 'prepared') return
          state = 'discarded'
          await removeStage()
        } catch {
          // discard() never rejects.
        }
      },
    })
  }

  async function prepare(source, prepareOptions = {}) {
    const signal = prepareOptions?.signal
    const expected = checkedRecord(source)
    throwIfAborted(signal)
    let target
    try {
      target = await inspect()
    } catch {
      target = null
    }
    if (!target?.ok) fail('not-feasible')
    await checkSourceSize(source.handle, expected)
    throwIfAborted(signal)
    let stage
    try {
      stage = await createStage(target)
    } catch (error) {
      throw asInstallError(error)
    }
    live.add(stage.path)
    let handle = stage.handle
    try {
      const head = await copyVerified(source.handle, handle, expected, signal)
      if (!hasAppImageMagic(head)) fail('verification-failed')
      await staging(() => handle.chmod(INSTALLED_MODE))
      await staging(() => handle.sync())
      const written = handle
      handle = null
      await staging(() => written.close())
      throwIfAborted(signal)
    } catch (error) {
      if (handle !== null) await handle.close().catch(() => {})
      live.delete(stage.path)
      await removeIfOurs(stage.path, stage.identity)
      throw asInstallError(error)
    }
    return preparedInstall(target, stage)
  }

  // Locates the AppImage folder for cleanup without requiring it to be writable.
  async function cleanupScope() {
    const located = locate()
    if (!located.ok || !validUid(uid)) return null
    const folder = await fsImpl.lstat(located.parent, BIGINT)
    return folder.isDirectory() ? located : null
  }

  async function cleanup() {
    try {
      const scope = await cleanupScope()
      if (scope === null) return
      const prefix = stageName(scope.name, '')
      const names = await fsImpl.readdir(scope.parent)
      const owner = BigInt(uid)
      const now = Date.now()
      let examined = 0
      let removed = 0
      for (const name of names) {
        if (removed >= MAX_CLEANUP_REMOVALS || examined >= MAX_CLEANUP_CANDIDATES) break
        if (typeof name !== 'string' || !name.startsWith(prefix) || !STAGE_SUFFIX_RE.test(name.slice(prefix.length))) continue
        const candidate = path.join(scope.parent, name)
        if (live.has(candidate)) continue
        examined += 1
        try {
          // lstat, then unlink: a planted symlink is removed itself, never followed.
          const stat = await fsImpl.lstat(candidate, BIGINT)
          if (!stat.isFile() && !stat.isSymbolicLink()) continue
          if (stat.uid !== owner || now - Number(stat.mtimeMs) <= STALE_AFTER_MS) continue
          await fsImpl.unlink(candidate)
          removed += 1
        } catch {
          // Removed concurrently, or not removable: a later pass retries.
        }
      }
    } catch {
      // Cleanup never fails a caller.
    }
  }

  return Object.freeze({
    strategy: STRATEGY,
    feasibility,
    prepare,
    cleanup,
  })
}

module.exports = {
  createAppImageInstaller,
}
