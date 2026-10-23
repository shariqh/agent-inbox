const { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync } = require('node:fs')
const { posix, win32 } = require('node:path')

const STAGE_PREFIX = '.agent-inbox-stage-'
// A directory being removed is first renamed into a fresh `.trash-<name>-*`
// folder beside it, so an interrupted removal leaves only trash, never a
// half-deleted tree under the name it had. Nothing with this prefix is ever a
// runtime.
const TRASH_PREFIX = '.trash-'
// Left inside a trash folder whose contents failed an identity check, so a
// later cleanup retains it for recovery as well.
const RETAINED_MARKER = '.retained'
// Leftover trash entries one cleanup tries to remove at most.
const TRASH_CLEANUP_LIMIT = 16
// Windows refuses to rename a directory while anything inside it is open: a
// process whose handles have not closed yet, or Defender scanning executables
// just written or run (#333). On win32, renameWithRetry waits these out with
// growing waits that add up to about nine seconds, the approach graceful-fs takes.
const BUSY_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const BUSY_RENAME_WAITS_MS = Object.freeze([50, 100, 200, 400, 800, 1600, 2000, 2000, 2000])

function filesystemError(code, message, options = {}) {
  const error = new Error(message)
  error.name = 'SetupFilesystemError'
  error.code = code
  error.committed = Boolean(options.committed)
  if (options.recoveryPath) error.recoveryPath = options.recoveryPath
  if (options.cause) error.cause = options.cause
  return error
}

function isMissing(error) {
  return error && typeof error === 'object' && error.code === 'ENOENT'
}

function isTrashName(name) {
  return typeof name === 'string' && name.startsWith(TRASH_PREFIX)
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// Runs check() and then rename(). On win32 only, a rename refused with a busy
// code is tried again after the next wait, check() first every time, so a path
// that changed meanwhile is refused rather than renamed. On any other platform
// or error, or once the waits run out, the rename's error is thrown.
function renameWithRetry({ check, rename, platform = process.platform, sleep = sleepSync }) {
  for (let attempt = 0; ; attempt += 1) {
    check()
    try {
      rename()
      return
    } catch (error) {
      const wait = BUSY_RENAME_WAITS_MS[attempt]
      if (platform !== 'win32' || !BUSY_RENAME_CODES.has(error?.code) || wait === undefined) throw error
      sleep(wait)
    }
  }
}

function renameOnce({ check, rename }) {
  check()
  rename()
}

function defaultIo() {
  return {
    lstat(path) {
      return lstatSync(path, { bigint: true })
    },
    realpath(path) {
      return realpathSync.native(path)
    },
    mkdir(path, options) {
      mkdirSync(path, options)
    },
    mkdtemp(prefix) {
      return mkdtempSync(prefix)
    },
    rename(from, to) {
      renameSync(from, to)
    },
    remove(path, options) {
      rmSync(path, options)
    },
    readdir(path) {
      return readdirSync(path)
    },
  }
}

function win32Root(pathApi, path) {
  const root = pathApi.parse(path).root
  if (/^[A-Za-z]:\\$/.test(root)) return root
  if (/^\\\\[^\\/]+\\[^\\/]+\\$/.test(root)) return root
  return null
}

function normalizeAbsolute(pathApi, platform, value) {
  if (typeof value !== 'string' || value === '' || value.includes('\0')) {
    throw filesystemError('invalid-path', 'filesystem path must be a non-empty absolute string')
  }

  const normalized = pathApi.normalize(value)
  if (platform === 'win32') {
    if (/^(?:\\\\|\/\/)[?.](?:\\|\/)/.test(value) || /^\\\\[?.]\\/.test(normalized)) {
      throw filesystemError('invalid-path', `Windows device or extended namespace paths are not allowed: ${value}`)
    }
    if (!pathApi.isAbsolute(value) || !win32Root(pathApi, normalized)) {
      throw filesystemError('invalid-path', `Windows filesystem path must be fully qualified: ${value}`)
    }
    const root = pathApi.parse(normalized).root
    const remainder = normalized.slice(root.length)
    if (remainder.includes(':') || (root.startsWith('\\\\') && root.slice(2).includes(':'))) {
      throw filesystemError('invalid-path', `Windows alternate data stream paths are not allowed: ${value}`)
    }
  } else if (!pathApi.isAbsolute(value)) {
    throw filesystemError('invalid-path', `filesystem path must be absolute: ${value}`)
  }
  return normalized
}

function entryKind(stat) {
  if (stat.isFile()) return 'file'
  if (stat.isDirectory()) return 'directory'
  return null
}

function sameIdentity(left, right) {
  return left.kind === right.kind &&
    left.device === right.device &&
    left.inode === right.inode
}

// Leftover trash is removed only when this uid owns it. Win32 has no POSIX
// owner to compare, so its model retains all leftover trash rather than
// trusting the name alone.
function defaultUid(platform) {
  if (platform === 'win32' || typeof process.getuid !== 'function') return null
  return process.getuid()
}

function createSetupFilesystem({
  platform = process.platform,
  io = defaultIo(),
  uid = defaultUid(platform),
} = {}) {
  const pathApi = platform === 'win32' ? win32 : posix

  function identify(path, expectedKind) {
    if (expectedKind !== 'file' && expectedKind !== 'directory') {
      throw filesystemError('invalid-kind', `unsupported filesystem entry kind: ${String(expectedKind)}`)
    }
    const normalized = normalizeAbsolute(pathApi, platform, path)
    let stat
    try {
      stat = io.lstat(normalized)
    } catch (error) {
      if (isMissing(error)) {
        throw filesystemError('not-found', `filesystem entry does not exist: ${normalized}`, { cause: error })
      }
      throw error
    }
    if (stat.isSymbolicLink()) {
      const noun = platform === 'win32' ? 'reparse point or junction' : 'symbolic link'
      throw filesystemError('link-like-entry', `filesystem entry must not be a ${noun}: ${normalized}`)
    }
    const kind = entryKind(stat)
    if (kind !== expectedKind) {
      throw filesystemError('wrong-kind', `filesystem entry must be a ${expectedKind}: ${normalized}`)
    }
    if (typeof stat.dev !== 'bigint' || typeof stat.ino !== 'bigint' || stat.dev <= 0n || stat.ino <= 0n) {
      throw filesystemError('unstable-identity', `filesystem entry has no usable stable filesystem identity: ${normalized}`)
    }
    const canonicalPath = io.realpath(normalized)
    if (typeof canonicalPath !== 'string' || canonicalPath === '') {
      throw filesystemError('unstable-identity', `filesystem entry has no canonical identity path: ${normalized}`)
    }
    return Object.freeze({
      path: normalized,
      canonicalPath,
      kind,
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
    })
  }

  function assertIdentity(identity, path = identity?.path) {
    if (!identity || typeof identity !== 'object' ||
        (identity.kind !== 'file' && identity.kind !== 'directory')) {
      throw filesystemError('invalid-identity', 'filesystem identity is missing or malformed')
    }
    const current = identify(path, identity.kind)
    if (!sameIdentity(identity, current)) {
      throw filesystemError('identity-changed', `filesystem identity changed: ${current.path}`)
    }
    return current
  }

  function identifyOptionalDirectory(path) {
    try {
      return identify(path, 'directory')
    } catch (error) {
      if (error && error.code === 'not-found') return null
      throw error
    }
  }

  function assertMissing(path) {
    const normalized = normalizeAbsolute(pathApi, platform, path)
    try {
      io.lstat(normalized)
    } catch (error) {
      if (isMissing(error)) return
      throw error
    }
    throw filesystemError('already-exists', `filesystem destination already exists: ${normalized}`)
  }

  function parentIdentity(parent) {
    if (platform === 'win32') return identify(parent, 'directory')
    return identify(io.realpath(parent), 'directory')
  }

  function assertParentIdentity(parent, identity) {
    const current = parentIdentity(parent)
    if (!sameIdentity(identity, current)) {
      throw filesystemError('identity-changed', `filesystem parent identity changed: ${parent}`)
    }
  }

  // A new tree is published with one checked rename. retryBusyRename, which
  // only the build-time publisher sets, retries a rename Windows refused
  // instead (#333), with this transaction's checks before every attempt.
  function stageDirectory({
    destination,
    replacement,
    prepare,
    validate,
    retryBusyRename = false,
  }) {
    if (replacement !== 'refuse' && replacement !== 'swap') {
      throw filesystemError('invalid-replacement', `unsupported directory replacement policy: ${String(replacement)}`)
    }
    if (typeof prepare !== 'function' || typeof validate !== 'function') {
      throw filesystemError('invalid-callback', 'directory prepare and validate callbacks are required')
    }
    if (typeof retryBusyRename !== 'boolean') {
      throw filesystemError('invalid-option', 'directory retryBusyRename option must be true or false')
    }

    const requestedDestination = normalizeAbsolute(pathApi, platform, destination)
    const requestedParent = pathApi.dirname(requestedDestination)
    if (requestedParent === requestedDestination) {
      throw filesystemError('invalid-path', `refusing to publish over a filesystem root: ${requestedDestination}`)
    }
    io.mkdir(requestedParent, { recursive: true })
    const parent = parentIdentity(requestedParent)
    const operationDestination = pathApi.join(parent.canonicalPath, pathApi.basename(requestedDestination))
    const previous = identifyOptionalDirectory(operationDestination)
    if (previous && replacement === 'refuse') {
      throw filesystemError('already-exists', `filesystem destination already exists: ${requestedDestination}`)
    }

    const scratch = io.mkdtemp(pathApi.join(parent.canonicalPath, STAGE_PREFIX))
    const scratchIdentity = identify(scratch, 'directory')
    const stage = pathApi.join(scratch, 'tree')
    const backup = pathApi.join(scratch, 'previous')
    let stageIdentity = null
    let stagePublished = false
    let preserveScratch = false
    let committed = false
    let failure = null
    let result

    try {
      try {
        io.mkdir(stage, { recursive: false })
      } catch (stageCreateError) {
        if (stageCreateError?.code === 'EEXIST') {
          preserveScratch = true
          throw filesystemError(
            'stage-already-exists',
            `private staging entry already exists; refusing to use or remove it: ${stage}`,
            { recoveryPath: stage, cause: stageCreateError },
          )
        }
        throw stageCreateError
      }
      stageIdentity = identify(stage, 'directory')
      const prepared = prepare(stage)
      validate(stage, prepared)
      const checkTransaction = () => {
        assertIdentity(scratchIdentity)
        assertIdentity(stageIdentity)
        assertParentIdentity(requestedParent, parent)
        if (previous) assertIdentity(previous, operationDestination)
        else assertMissing(operationDestination)
      }

      if (previous) {
        checkTransaction()
        io.rename(operationDestination, backup)
        try {
          assertIdentity(scratchIdentity)
          assertIdentity(previous, backup)
          io.rename(stage, operationDestination)
          stagePublished = true
          committed = true
        } catch (publishError) {
          try {
            assertIdentity(scratchIdentity)
            assertIdentity(previous, backup)
            assertMissing(operationDestination)
          } catch (recoveryIdentityError) {
            preserveScratch = true
            throw filesystemError(
              'restore-refused',
              `directory publication failed and safe restoration was refused because recovery identity changed; recovery data retained at ${scratch}`,
              { recoveryPath: scratch, cause: recoveryIdentityError },
            )
          }
          try {
            io.rename(backup, operationDestination)
            assertIdentity(previous, operationDestination)
          } catch (restoreError) {
            preserveScratch = true
            throw filesystemError(
              'restore-failed',
              `directory publication failed and prior output could not be restored; recovery data retained at ${scratch}`,
              { recoveryPath: scratch, cause: restoreError },
            )
          }
          throw publishError
        }

        try {
          assertIdentity(stageIdentity, operationDestination)
          assertIdentity(stageIdentity, requestedDestination)
        } catch (identityError) {
          preserveScratch = true
          throw filesystemError(
            'committed-identity-changed',
            `directory was published but its identity changed; prior output retained at ${backup}`,
            { committed: true, recoveryPath: backup, cause: identityError },
          )
        }

        try {
          assertIdentity(scratchIdentity)
          assertIdentity(previous, backup)
        } catch (cleanupIdentityError) {
          preserveScratch = true
          throw filesystemError(
            'committed-cleanup-refused',
            `directory was published but prior output cleanup was refused because recovery identity changed; untrusted path retained at ${backup}`,
            { committed: true, recoveryPath: backup, cause: cleanupIdentityError },
          )
        }

        try {
          io.remove(backup, { recursive: true, force: false })
        } catch (cleanupError) {
          preserveScratch = true
          throw filesystemError(
            'committed-cleanup-failed',
            `directory was published but prior output cleanup was incomplete; recovery data remains at ${backup}`,
            { committed: true, recoveryPath: backup, cause: cleanupError },
          )
        }
      } else {
        const publish = retryBusyRename ? renameWithRetry : renameOnce
        publish({ check: checkTransaction, rename: () => io.rename(stage, operationDestination), platform })
        stagePublished = true
        committed = true
        try {
          assertIdentity(stageIdentity, operationDestination)
          assertIdentity(stageIdentity, requestedDestination)
        } catch (identityError) {
          throw filesystemError(
            'committed-identity-changed',
            `directory was published but its identity changed: ${requestedDestination}`,
            { committed: true, cause: identityError },
          )
        }
      }

      result = Object.freeze({
        path: requestedDestination,
        prepared,
        replaced: Boolean(previous),
      })
    } catch (error) {
      failure = error
    }

    if (!preserveScratch) {
      try {
        assertIdentity(scratchIdentity)
        if (stageIdentity) {
          if (stagePublished) assertMissing(stage)
          else assertIdentity(stageIdentity, stage)
        } else {
          assertMissing(stage)
        }
        assertMissing(backup)
      } catch (cleanupIdentityError) {
        preserveScratch = true
        failure = filesystemError(
          'cleanup-identity-changed',
          `${committed ? 'published directory' : 'failed directory transaction'} cleanup was refused because transaction-owned paths changed; untrusted path retained at ${scratch}`,
          { committed, recoveryPath: scratch, cause: cleanupIdentityError },
        )
      }
      if (!preserveScratch) {
        try {
          io.remove(scratch, { recursive: true, force: true })
        } catch (cleanupError) {
          failure = filesystemError(
            'cleanup-failed',
            `${committed ? 'published directory' : 'failed directory transaction'} cleanup failed at ${scratch}`,
            { committed, recoveryPath: scratch, cause: failure || cleanupError },
          )
        }
      }
    }

    if (failure) throw failure
    return result
  }

  // Renames the validated directory into a fresh trash folder beside it, then
  // deletes that folder. Once the rename commits, the name is free whatever
  // happens next; an interrupted or failed deletion leaves trash that a later
  // removeLeftoverTrash() deletes. Recursive deletion removes links, never
  // what they point at.
  function removeDirectory({ target, validate }) {
    if (typeof validate !== 'function') {
      throw filesystemError('invalid-callback', 'directory validation callback is required')
    }
    const normalized = normalizeAbsolute(pathApi, platform, target)
    const requestedParent = pathApi.dirname(normalized)
    const name = pathApi.basename(normalized)
    if (requestedParent === normalized) {
      throw filesystemError('invalid-path', `refusing to remove a filesystem root: ${normalized}`)
    }
    if (isTrashName(name)) {
      throw filesystemError('invalid-path', `refusing to remove a trash entry as a directory: ${normalized}`)
    }
    const identity = identify(normalized, 'directory')
    validate(normalized)
    const parent = parentIdentity(requestedParent)
    const operationTarget = pathApi.join(parent.canonicalPath, name)
    assertIdentity(identity, operationTarget)

    const trash = io.mkdtemp(pathApi.join(parent.canonicalPath, `${TRASH_PREFIX}${name}-`))
    const trashIdentity = identify(trash, 'directory')
    const moved = pathApi.join(trash, name)
    try {
      assertParentIdentity(requestedParent, parent)
      assertIdentity(identity, operationTarget)
      io.rename(operationTarget, moved)
    } catch (error) {
      // Nothing was moved: the empty trash folder is this call's own.
      try {
        assertIdentity(trashIdentity)
        assertMissing(moved)
        io.remove(trash, { recursive: true, force: false })
      } catch {
        // Left for a later cleanup.
      }
      throw error
    }

    try {
      assertIdentity(trashIdentity)
      assertIdentity(identity, moved)
    } catch (identityError) {
      try {
        io.mkdir(pathApi.join(trash, RETAINED_MARKER), { recursive: false })
      } catch {
        // The folder is retained either way; the marker only keeps a later
        // cleanup from deleting it.
      }
      throw filesystemError(
        'trash-identity-changed',
        `directory was moved aside for deletion but its identity changed; untrusted path retained at ${trash}`,
        { committed: true, recoveryPath: trash, cause: identityError },
      )
    }

    try {
      io.remove(trash, { recursive: true, force: false })
    } catch (removeError) {
      throw filesystemError(
        'trash-cleanup-failed',
        `directory was moved aside but not fully deleted; a later cleanup removes ${trash}`,
        { committed: true, recoveryPath: trash, cause: removeError },
      )
    }
    return Object.freeze({ path: normalized, identity })
  }

  function entryKindOrLink(stat) {
    return stat.isSymbolicLink() ? 'link' : entryKind(stat)
  }

  function ownedByCaller(stat) {
    if (uid === null || uid === undefined || stat.uid === undefined || stat.uid === null) return false
    return BigInt(stat.uid) === BigInt(uid)
  }

  function retainedForRecovery(path) {
    try {
      io.lstat(pathApi.join(path, RETAINED_MARKER))
      return true
    } catch (error) {
      return !isMissing(error)
    }
  }

  // One leftover trash entry, pinned by identity and owner and checked again
  // immediately before it is deleted. A link is unlinked, never followed.
  // 'kept' means it is not one to remove (another user's, marked for
  // recovery, or unreadable), so no removal was tried.
  function removeTrashEntry(path) {
    let pinned
    let kind
    try {
      pinned = io.lstat(path)
      kind = entryKindOrLink(pinned)
      if (kind === null || !ownedByCaller(pinned)) return 'kept'
      if (kind === 'directory' && retainedForRecovery(path)) return 'kept'
    } catch {
      return 'kept'
    }
    try {
      const current = io.lstat(path)
      if (current.dev !== pinned.dev || current.ino !== pinned.ino || entryKindOrLink(current) !== kind) {
        return 'failed'
      }
      io.remove(path, { recursive: kind === 'directory', force: false })
      return 'removed'
    } catch {
      return 'failed'
    }
  }

  // Tries to delete up to TRASH_CLEANUP_LIMIT leftover trash entries directly
  // inside `parent` that this user owns; trash it keeps does not count, so it
  // can never hold back newer trash. Anything else, or anything that cannot
  // be removed safely, is retained; this never throws for a single entry.
  function removeLeftoverTrash(parent) {
    const parentPath = normalizeAbsolute(pathApi, platform, parent)
    const removed = []
    const retained = []
    let names
    try {
      names = io.readdir(parentPath)
    } catch (error) {
      if (isMissing(error)) return Object.freeze({ removed, retained })
      throw error
    }
    let attempts = 0
    for (const name of names.filter(isTrashName).sort()) {
      if (attempts === TRASH_CLEANUP_LIMIT) break
      const path = pathApi.join(parentPath, name)
      const outcome = removeTrashEntry(path)
      if (outcome !== 'kept') attempts += 1
      if (outcome === 'removed') removed.push(path)
      else retained.push(path)
    }
    return Object.freeze({ removed, retained })
  }

  return Object.freeze({
    identify,
    assertIdentity,
    stageDirectory,
    removeDirectory,
    removeLeftoverTrash,
  })
}

module.exports = {
  createSetupFilesystem,
  isTrashName,
  renameWithRetry,
}
