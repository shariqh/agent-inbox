'use strict'
// Issue #412 step 3 — the keys behind signed approvals (design §4.3, §14.3).
//
// A 32-byte master key lives only encrypted by Electron safeStorage, in
// userData `launch-master-key` (0600). Each launch gets
//
//   launchKey = HMAC-SHA256(master, frame('agent-inbox/launch-key/v1', launchId))
//
// which main hands its driver on fd 3, and main signs an approval as
//
//   HMAC-SHA256(launchKey, frame('agent-inbox/launch-approval/v1', item, revision, optionId))
//
// where `frame` prefixes each part with its UTF-8 byte length (4 bytes,
// big-endian). src/launch-sign.ts verifies exactly this on the driver's side;
// test/launch-fixtures.ts pins both against an independent implementation. The
// derived key is the same after a quit, an update or a crash, so a relaunched
// app can approve every running driver's asks.
//
// No plain-text fallback: if safeStorage cannot encrypt (or, on Linux, only has
// its basic_text backend), launches are refused. A key file that exists but
// cannot be decrypted is never replaced: running drivers hold keys derived
// from it.
const { createHmac, randomBytes } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')

const FILENAME = 'launch-master-key'
const KEY_BYTES = 32
const LAUNCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function frame(parts) {
  return Buffer.concat(parts.flatMap((part) => {
    const bytes = Buffer.from(part, 'utf8')
    const length = Buffer.alloc(4)
    length.writeUInt32BE(bytes.length)
    return [length, bytes]
  }))
}

function deriveLaunchKey(master, launchId) {
  if (!Buffer.isBuffer(master) || master.length !== KEY_BYTES) throw new TypeError('the master key must be 32 bytes')
  if (typeof launchId !== 'string' || !LAUNCH_ID.test(launchId)) throw new TypeError('launch id must be a lowercase UUID')
  return createHmac('sha256', master).update(frame(['agent-inbox/launch-key/v1', launchId])).digest()
}

function signApproval(launchKey, { item, revision, optionId }) {
  if (!Buffer.isBuffer(launchKey) || launchKey.length !== KEY_BYTES) throw new TypeError('the launch key must be 32 bytes')
  if (typeof item !== 'string' || !item || typeof optionId !== 'string' || !optionId || !Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError('an approval names an item, a revision and an option')
  }
  return createHmac('sha256', launchKey).update(frame(['agent-inbox/launch-approval/v1', item, String(revision), optionId])).digest('hex')
}

function encryptionAvailable(safeStorage, platform) {
  try {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) return false
    if (platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function'
      && safeStorage.getSelectedStorageBackend() === 'basic_text') return false
    return true
  } catch {
    return false
  }
}

/**
 * The master key's store. `available()` says whether launches can be signed
 * at all; `launchKey(id)` creates the master key on first use. Everything is
 * injected so it is tested without Electron.
 */
function createLaunchKeys({ safeStorage, filePath, platform = process.platform, fsImpl = fs, random = randomBytes }) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new TypeError('filePath must be absolute')
  let master = null

  async function load() {
    if (master) return master
    let stored = null
    try {
      stored = await fsImpl.readFile(filePath)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error('the launch key file cannot be read')
    }
    if (stored !== null) {
      let hex
      try {
        hex = safeStorage.decryptString(stored)
      } catch {
        throw new Error('the launch key cannot be decrypted')
      }
      if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/.test(hex)) throw new Error('the launch key file is not one')
      master = Buffer.from(hex, 'hex')
      return master
    }
    const fresh = random(KEY_BYTES)
    const encrypted = safeStorage.encryptString(fresh.toString('hex'))
    await fsImpl.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
    const temp = `${filePath}.${process.pid}.${random(6).toString('hex')}.tmp`
    await fsImpl.writeFile(temp, encrypted, { mode: 0o600, flag: 'wx' })
    try {
      // a link, never a rename: a key another process just created wins
      await fsImpl.link(temp, filePath)
    } catch (error) {
      await fsImpl.unlink(temp).catch(() => {})
      if (error?.code !== 'EEXIST') throw error
      return load()
    }
    await fsImpl.unlink(temp).catch(() => {})
    master = fresh
    return master
  }

  let loading = null
  const masterKey = () => (loading ??= load().finally(() => { loading = null }))

  async function launchKey(launchId) {
    if (!encryptionAvailable(safeStorage, platform)) throw new Error('safeStorage cannot encrypt here')
    return deriveLaunchKey(await masterKey(), launchId)
  }

  return Object.freeze({
    available: () => encryptionAvailable(safeStorage, platform),
    launchKey,
    sign: async (launchId, approval) => signApproval(await launchKey(launchId), approval),
  })
}

module.exports = { createLaunchKeys, deriveLaunchKey, signApproval }
