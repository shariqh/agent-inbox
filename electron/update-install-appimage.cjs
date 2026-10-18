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

const { randomBytes } = require('node:crypto')
const { constants } = require('node:fs')
const fs = require('node:fs/promises')
const path = require('node:path')
const { runsFromAppImage } = require('./update-fetch.cjs')
const { INSTALL_HELPER_EXIT, UpdateInstallError, copyVerifiedSource } = require('./update-install.cjs')

const STRATEGY = 'appimage-self-replace'
const SHA256_RE = /^[0-9a-f]{64}$/
const STAGE_SUFFIX_RE = /^[0-9a-f]{16}$/
const STAGE_RANDOM_BYTES = 8
const NAME_MAX_BYTES = 255
// A sanity bound above any real package; the signed byteLength is the real cap.
const MAX_ARTIFACT_BYTES = 2 * 1024 ** 3
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
// The stage is created like copyVerifiedSource's `wx`, plus O_NOFOLLOW.
const OPEN_READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
const OPEN_STAGE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0)
const OPEN_DIRECTORY_FLAGS = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)
const HELPER_SHELL = '/bin/sh'
const HELPER_NAME = 'agent-inbox-relaunch'
const HELPER_POLL_MS = 200
const DEFAULT_HELPER_TIMEOUT_MS = 120_000
const EXIT = INSTALL_HELPER_EXIT
// Constant text: every input arrives as an argument and is expanded only inside
// double quotes. Waits while the app or the viewer process it started (`-` when
// the viewer runs in-process or was reused) is alive, then replaces itself with
// the new AppImage, which the commit already renamed into place. Before every
// exit, and just before that exec, it writes its INSTALL_HELPER_EXIT code to
// <result> (temp file + rename, `-` for no report); an invalid <result> is
// checked first and exits 64 writing nowhere. 64 bad arguments, 75 the app never
// exited (nothing started), 65 the AppImage path no longer holds a regular,
// executable, non-symlink file (nothing started), 0 about to start it.
const RELAUNCH_SCRIPT = `set -u
[ "$#" -eq 5 ] || exit ${EXIT.badArguments}
app_pid="$1"
viewer_pid="$2"
polls="$3"
target="$4"
result="$5"
valid_path() {
  case "$1" in /*) ;; *) return 1 ;; esac
  case "$1" in */|*/../*|*/..|*/./*|*/.) return 1 ;; esac
  return 0
}
[ "$result" = - ] || valid_path "$result" || exit ${EXIT.badArguments}
report() {
  [ "$result" = - ] && return 0
  if (umask 077 && printf '%s\n' "$1" > "$result.tmp.$$") 2>/dev/null; then
    mv -f "$result.tmp.$$" "$result" 2>/dev/null || rm -f "$result.tmp.$$"
  fi
}
finish() {
  report "$1"
  exit "$1"
}
case "$app_pid" in ''|0*|*[!0-9]*) finish ${EXIT.badArguments} ;; esac
case "$viewer_pid" in -) ;; ''|0*|*[!0-9]*) finish ${EXIT.badArguments} ;; esac
case "$polls" in ''|0*|*[!0-9]*) finish ${EXIT.badArguments} ;; esac
valid_path "$target" || finish ${EXIT.badArguments}
running() {
  kill -0 "$app_pid" 2>/dev/null && return 0
  [ "$viewer_pid" != - ] && kill -0 "$viewer_pid" 2>/dev/null
}
waited=0
while running; do
  [ "$waited" -lt "$polls" ] || finish ${EXIT.timedOut}
  waited=$((waited + 1))
  sleep 0.2 2>/dev/null || sleep 1
done
if [ ! -f "$target" ] || [ -L "$target" ] || [ ! -x "$target" ]; then
  finish ${EXIT.refused}
fi
report ${EXIT.installed}
exec "$target"
`
// The new AppImage sets these afresh; inherited, they would describe the old one.
const DROPPED_ENV = new Set(['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD', 'TARGET_APPIMAGE'])

const REVIEW = 'Use Review release instead.'
const INFEASIBLE = Object.freeze({
  'unsupported-platform': `Agent Inbox cannot install updates from the app on this system. ${REVIEW}`,
  'not-packaged': `Installing updates from the app needs the packaged AppImage. ${REVIEW}`,
  'not-appimage': `Agent Inbox installs updates from the app only when it runs from its AppImage file. ${REVIEW}`,
  'name-too-long': `The AppImage file name is too long to update in place. ${REVIEW}`,
  'not-regular-file': `Agent Inbox cannot safely replace its AppImage file. ${REVIEW}`,
  'not-owner': `This AppImage file belongs to another user account, so Agent Inbox cannot update it. ${REVIEW}`,
  'read-only': `Agent Inbox cannot replace its AppImage file in its current folder. ${REVIEW}`,
  'not-recognized': `Agent Inbox does not recognize its AppImage file. ${REVIEW}`,
  'changed-since-launch': 'The AppImage file changed since Agent Inbox started. Restart Agent Inbox to update.',
  unexpected: `Agent Inbox cannot install updates from the app here. ${REVIEW}`,
})
const FEASIBLE = Object.freeze({ ok: true })

const CANCELLED = 'update install was cancelled'

function fail(code, message) {
  throw new UpdateInstallError(code, message)
}

function asInstallError(error) {
  return error instanceof UpdateInstallError ? error : new UpdateInstallError('staging')
}

function refusal(reason) {
  return Object.freeze({ ok: false, reason, message: INFEASIBLE[reason] })
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

// The helper's own rule for its report location: absolute, no dot segments, no trailing slash.
function validResultPath(value) {
  return typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value && !value.endsWith('/')
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
  if (options.viewerPid !== undefined && typeof options.viewerPid !== 'function') {
    throw new TypeError('viewerPid must be a function')
  }
  const helperTimeoutMs = options.helperTimeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS
  if (!Number.isFinite(helperTimeoutMs) || helperTimeoutMs <= 0) throw new TypeError('helperTimeoutMs must be positive')
  const { env, execPath, uid, platform, isPackaged, pid, spawnImpl } = options
  // Read at commit time: the viewer this app started and stops when it quits.
  const viewerPid = options.viewerPid ?? (() => null)
  const helperPolls = Math.max(1, Math.ceil(helperTimeoutMs / HELPER_POLL_MS))
  const fsImpl = options.fsImpl ?? fs
  const randomImpl = options.randomImpl ?? randomBytes
  // Stages this installer still owns; cleanup never touches them, however old.
  const live = new Set()

  // Locates the AppImage this process provably runs from. Reads env each time.
  function locate() {
    if (platform !== 'linux') return refusal('unsupported-platform')
    if (isPackaged !== true) return refusal('not-packaged')
    const appImage = env?.APPIMAGE
    const appDir = env?.APPDIR
    // The same proof that selected the AppImage target for this offer.
    if (!runsFromAppImage({ appImagePath: appImage, appDir, execPath })) return refusal('not-appimage')
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

  function checkRecord(source) {
    const record = source?.record
    if (
      record === null
      || typeof record !== 'object'
      || record.installStrategy !== STRATEGY
      || record.packageType !== 'appimage'
      || !Number.isSafeInteger(record.byteLength)
      || record.byteLength <= 0
      || record.byteLength > MAX_ARTIFACT_BYTES
      || typeof record.sha256 !== 'string'
      || !SHA256_RE.test(record.sha256)
      || typeof source.handle?.read !== 'function'
      || typeof source.handle?.stat !== 'function'
    ) {
      fail('not-verified')
    }
  }

  function throwIfAborted(signal) {
    if (signal?.aborted) fail('staging', CANCELLED)
  }

  async function staging(operation) {
    try {
      return await operation()
    } catch {
      return fail('staging')
    }
  }

  // copyVerifiedSource opens its destination `wx`; this adds O_NOFOLLOW.
  const stageCopyFs = Object.freeze({
    open: (target, _flags, mode) => fsImpl.open(target, OPEN_STAGE_FLAGS, mode),
    unlink: (target) => fsImpl.unlink(target),
  })

  function stagePathFor(target) {
    let suffix = ''
    try {
      suffix = Buffer.from(randomImpl(STAGE_RANDOM_BYTES)).toString('hex')
    } catch {
      suffix = ''
    }
    if (!STAGE_SUFFIX_RE.test(suffix)) fail('staging')
    return path.join(target.parent, stageName(target.name, suffix))
  }

  // Binds the file copyVerifiedSource just wrote and verified: it must sit on
  // the AppImage's file system (the commit is a rename) with the signed size,
  // and the bytes that will run must carry the AppImage magic. Then 0755.
  async function finalizeStage(stagePath, target, byteLength) {
    let handle
    try {
      handle = await fsImpl.open(stagePath, OPEN_READ_FLAGS)
    } catch {
      await fsImpl.unlink(stagePath).catch(() => {})
      return fail('staging')
    }
    let identity = null
    try {
      const stat = await staging(() => handle.stat(BIGINT))
      identity = stat.isFile() ? identityOf(stat) : null
      if (identity === null || identity.dev !== target.file.dev || stat.size !== BigInt(byteLength)) fail('staging')
      const head = Buffer.alloc(MAGIC_BYTES)
      let filled = 0
      while (filled < MAGIC_BYTES) {
        const { bytesRead } = await staging(() => handle.read(head, filled, MAGIC_BYTES - filled, filled))
        if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > MAGIC_BYTES - filled) break
        filled += bytesRead
      }
      if (filled !== MAGIC_BYTES || !hasAppImageMagic(head)) fail('verification-failed')
      await staging(() => handle.chmod(INSTALLED_MODE))
      await staging(() => handle.sync())
      const opened = handle
      handle = null
      await staging(() => opened.close())
      return identity
    } catch (error) {
      if (handle !== null) await handle.close().catch(() => {})
      if (identity !== null) await removeIfOurs(stagePath, identity)
      else await fsImpl.unlink(stagePath).catch(() => {})
      throw error
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

  // `-` tells the helper there is no separate viewer process to wait for.
  function viewerArgument() {
    const value = viewerPid()
    if (value === null || value === undefined) return '-'
    if (!isPid(value)) throw new Error('viewer pid is invalid')
    return String(value)
  }

  // Resolves true once the detached helper is running, false if it could not start.
  function startHelper(target, report) {
    return new Promise((resolveStart) => {
      let child
      try {
        child = spawnImpl(
          HELPER_SHELL,
          ['-c', RELAUNCH_SCRIPT, HELPER_NAME, String(pid), viewerArgument(), String(helperPolls), target.appImage, report],
          { detached: true, stdio: 'ignore', env: relaunchEnvironment(env, target.appDir), cwd: '/' },
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

    // `resultPath` is where the helper reports its exit code; the controller
    // passes the attempt store's path. Without one the helper reports nowhere.
    async function runCommit(commitOptions) {
      const resultPath = commitOptions?.resultPath
      let renamed = false
      if ((resultPath === undefined || validResultPath(resultPath)) && (await unchanged())) {
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
      if (!(await startHelper(target, resultPath ?? '-'))) {
        console.error('[agent-inbox] the update is installed, but Agent Inbox could not schedule its restart; open it again to use the new version')
      }
    }

    return Object.freeze({
      commit(commitOptions) {
        if (committing === null) {
          if (state !== 'prepared') return Promise.reject(new UpdateInstallError('commit-failed'))
          state = 'committing'
          committing = runCommit(commitOptions)
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
    checkRecord(source)
    throwIfAborted(signal)
    let target
    try {
      target = await inspect()
    } catch {
      target = null
    }
    if (!target?.ok) fail('not-feasible')
    throwIfAborted(signal)
    const stagePath = stagePathFor(target)
    live.add(stagePath)
    let identity = null
    try {
      // Hashes exactly the bytes it consumes; keeps the copy only at the signed length and SHA-256.
      await copyVerifiedSource(source, stagePath, { fsImpl: stageCopyFs, signal, mode: STAGE_MODE })
      identity = await finalizeStage(stagePath, target, source.record.byteLength)
      throwIfAborted(signal)
    } catch (error) {
      live.delete(stagePath)
      if (identity !== null) await removeIfOurs(stagePath, identity)
      throw asInstallError(error)
    }
    return preparedInstall(target, { path: stagePath, identity })
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
