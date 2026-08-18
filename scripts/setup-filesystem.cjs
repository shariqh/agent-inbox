const { lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } = require('node:fs')
const { posix, win32 } = require('node:path')

const STAGE_PREFIX = '.agent-inbox-stage-'

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

function createSetupFilesystem({
  platform = process.platform,
  io = defaultIo(),
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

  function stageDirectory({
    destination,
    replacement,
    prepare,
    validate,
  }) {
    if (replacement !== 'refuse' && replacement !== 'swap') {
      throw filesystemError('invalid-replacement', `unsupported directory replacement policy: ${String(replacement)}`)
    }
    if (typeof prepare !== 'function' || typeof validate !== 'function') {
      throw filesystemError('invalid-callback', 'directory prepare and validate callbacks are required')
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
      assertIdentity(scratchIdentity)
      assertIdentity(stageIdentity)
      assertParentIdentity(requestedParent, parent)

      if (previous) assertIdentity(previous, operationDestination)
      else assertMissing(operationDestination)

      if (previous) {
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
        io.rename(stage, operationDestination)
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

  function removeDirectory({ target, validate }) {
    if (typeof validate !== 'function') {
      throw filesystemError('invalid-callback', 'directory validation callback is required')
    }
    const normalized = normalizeAbsolute(pathApi, platform, target)
    const identity = identify(normalized, 'directory')
    validate(normalized)
    assertIdentity(identity, normalized)
    io.remove(normalized, { recursive: true, force: false })
    assertMissing(normalized)
    return Object.freeze({ path: normalized, identity })
  }

  return Object.freeze({
    identify,
    assertIdentity,
    stageDirectory,
    removeDirectory,
  })
}

module.exports = {
  createSetupFilesystem,
}
