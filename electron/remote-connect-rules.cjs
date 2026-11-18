'use strict'
// The pure rules of connect mode (#617, PR 3a), split from electron/remote-connect.cjs for size
// only; that file is the controller and the only module that requires this one. Nothing here does
// any I/O: the hub's address, the pairing code and label rules mirrored from the hub, the tailnet
// rules mirrored from the mesh command line, reading the peer list, recognising a certificate error, and the
// stored file's field rules. test/remote-connect.test.ts compares each mirrored rule with the
// TypeScript one it copies.
const { isObject, validHost } = require('./remote-tailscale.cjs')

const MAX_HUBS = 16
const BOUNDARY_HEADER = 'x-agent-inbox-remote-boundary'
const BOUNDARY = 'tailnet-v1'
const LABEL_MAX = 40
const DEVICE_ID = /^[0-9a-f]{16}$/
const SECRET = /^[A-Za-z0-9_-]{43}$/
// the encrypted secret as stored: standard base64
const BLOB = /^[A-Za-z0-9+/]+={0,2}$/
const BLOB_MAX = 4096
const HUB_ID = /^[0-9a-f]{8}$/
// a Tailscale stable node id: printable ASCII, compared exactly
const NODE_ID = /^[\x21-\x7e]{1,128}$/
// §3.1's place-name rule, the one /api/version's `machine` follows
const PLACE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/
// A device label by the hub's one rule (isDeviceLabel in src/remote-pair.ts): 1 to 40 characters,
// none a control (Cc), format (Cf) or lone surrogate (Cs) character. Mirrored; a test compares them.
const LABEL_FORBIDDEN = /[\p{Cc}\p{Cf}\p{Cs}]/u
const LABEL_FORBIDDEN_ALL = /[\p{Cc}\p{Cf}\p{Cs}]/gu
// The hub's code rule (normaliseCode in src/remote-pair.ts), mirrored; a test compares them.
const CODE_TYPED = /^[0-9A-Za-z -]{1,64}$/
const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{10}$/
// The mesh command line's suffix rule (its suffixFrom), mirrored; a test compares them.
const SUFFIX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net$/
const USER_ID = /^[1-9]\d{0,30}$/
// Tailscale's placeholder user for tagged devices: never a person
const PLACEHOLDER_LOGIN = 'tagged-devices'


// ── the rules ──────────────────────────────────────────────────────────────

/**
 * The hub's address as typed: `https://<host>` with no user, port, path other than `/`, query or
 * fragment, or a bare host, to which `https://` is added. The host is lowercased and must follow
 * the reader's host rule (letters, digits and dashes, two labels at least, the last holding a
 * letter, so no IP address). Gives `{ ok, origin, host }` with the origin canonical and no trailing
 * slash, or `{ ok: false, reason: 'bad_address' }`.
 */
function parseHubOrigin(text) {
  const no = { ok: false, reason: 'bad_address' }
  if (typeof text !== 'string' || text.length > 300) return no
  const typed = text.trim()
  // the URL parser would quietly drop tabs and newlines and turn a backslash into a slash
  if (typed === '' || /[\s\\\u0000-\u001f\u007f-\u009f]/.test(typed)) return no
  const full = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(typed) ? typed : `https://${typed}`
  if (writtenUserInfo(full)) return no
  // checked as written: an empty user, `:443`, an empty query or fragment all vanish once parsed
  const match = /^https:\/\/([^/?#@:[\]%]+)\/?$/i.exec(full)
  if (!match) return no
  const host = match[1].toLowerCase()
  if (!validHost(host)) return no
  let url
  try {
    url = new URL(full)
  } catch {
    return no
  }
  if (url.protocol !== 'https:' || url.hostname !== host || url.port !== '' || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') return no
  return { ok: true, origin: `https://${host}`, host }
}

/**
 * Whether `text`, read as the URL parser reads it, writes user info: an `@` anywhere before the
 * first `/`, `?` or `#` after the scheme and its leading slashes and backslashes. Tabs and newlines
 * are removed first and edge spaces and controls trimmed, as the parser does, so `https:@host`,
 * `https:\@host`, `https:/\@host` and `https:/<tab>/@host` all count, even where the user is empty.
 */
function writtenUserInfo(text) {
  if (typeof text !== 'string') return false
  const plain = text.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '')
  const match = /^[A-Za-z][A-Za-z0-9+.-]*:[/\\]*([^/?#]*)/.exec(plain)
  return match !== null && match[1].includes('@')
}

/** A typed pairing code, the hub's way: case, spaces and dashes ignored, I and L read as 1, O as 0; null unless 10 letters of the alphabet. */
function normaliseCode(text) {
  if (typeof text !== 'string' || !CODE_TYPED.test(text)) return null
  const plain = text.replace(/[ -]/g, '').toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0')
  return CODE_PATTERN.test(plain) ? plain : null
}

/** A device label by the hub's rule. */
function isDeviceLabel(value) {
  if (typeof value !== 'string') return false
  const length = Array.from(value).length
  return length >= 1 && length <= LABEL_MAX && !LABEL_FORBIDDEN.test(value)
}

const cut = (text, max) => Array.from(text).slice(0, max).join('')

/** This Mac's name on the hub: its host name up to the first dot, without refused characters, at most 40 characters, else `Mac`. */
function deviceLabelFor(name) {
  if (typeof name !== 'string') return 'Mac'
  const label = cut(name.split('.')[0].replace(LABEL_FORBIDDEN_ALL, ''), LABEL_MAX)
  return isDeviceLabel(label) ? label : 'Mac'
}

/** The hub's name on this Mac: the machine it reports, else the first label of its address, at most 40 characters. */
function hubLabelFor(machine, host) {
  if (typeof machine === 'string' && PLACE.test(machine)) return cut(machine, LABEL_MAX)
  return cut(String(host).split('.')[0], LABEL_MAX)
}

const suffixOf = (status) => {
  const suffix = status?.MagicDNSSuffix
  if (status?.BackendState !== 'Running' || typeof suffix !== 'string') return undefined
  return SUFFIX.test(suffix) ? suffix : undefined
}

/** The MagicDNS suffix in `tailscale status --json`, only while the backend runs (the mesh command line's suffixFrom). */
function suffixFrom(json) {
  let status
  try {
    status = JSON.parse(json)
  } catch {
    // not JSON
  }
  return suffixOf(isObject(status) ? status : undefined)
}

/** A host is in the tailnet when it is one label in front of the suffix (inTailnet in src/mesh-config.ts). */
function inTailnet(host, suffix) {
  return suffix !== undefined && host.slice(host.indexOf('.') + 1) === suffix
}

/**
 * A `UserID` as its digits. The JSON text is read where the runtime offers it, so an id past 2^53
 * keeps every digit; a number with no text that is not a safe integer, and anything that is not a
 * positive integer, is dropped, so it never equals anything.
 */
function userIdText(raw, context) {
  if (typeof raw === 'number') {
    const source = context?.source
    if (typeof source === 'string') return USER_ID.test(source) ? source : undefined
    return Number.isSafeInteger(raw) && raw > 0 ? String(raw) : undefined
  }
  return typeof raw === 'string' && USER_ID.test(raw) ? raw : undefined
}

const untagged = (tags) => tags === undefined || tags === null || (Array.isArray(tags) && tags.length === 0)
// a node's DNS name as compared with a host: lowercased, the trailing dot dropped; null when not text
const dnsName = (node) => (typeof node.DNSName === 'string' ? node.DNSName.toLowerCase().replace(/\.$/, '') : null)

/**
 * From `tailscale status --json`: `{ ok: true, node }` only when the backend runs, this node is
 * untagged and has a person's user, `host` is one label in front of the tailnet's suffix, and
 * exactly one peer has that DNS name, with this node's user, no tags and a string ID (the node).
 * `host` may also be this node's own DNS name (the app on the hub itself): then no peer may share
 * it (`duplicate_name`), and the node is `Self.ID`. Otherwise `{ ok: false, reason }`. Nothing of
 * the document outlives the call.
 */
function parsePeers(text, host) {
  const no = (reason) => ({ ok: false, reason })
  let status
  try {
    status = JSON.parse(text, (key, raw, context) => (key === 'UserID' ? userIdText(raw, context) : raw))
  } catch {
    return no('failed')
  }
  if (!isObject(status)) return no('failed')
  if (status.BackendState !== 'Running') return no('not_running')
  const self = status.Self
  if (!isObject(self) || !untagged(self.Tags) || self.UserID === undefined) return no('tagged_self')
  const user = isObject(status.User) && Object.hasOwn(status.User, self.UserID) ? status.User[self.UserID] : null
  if (!isObject(user) || typeof user.LoginName !== 'string' || user.LoginName.toLowerCase() === PLACEHOLDER_LOGIN) return no('tagged_self')
  if (typeof host !== 'string' || !inTailnet(host, suffixOf(status))) return no('not_in_tailnet')
  const peers = isObject(status.Peer) ? Object.values(status.Peer) : []
  const named = peers.filter((peer) => isObject(peer) && dnsName(peer) === host)
  // PR 3b: this node's own name is the hub when the app runs on the hub itself. A node is never in
  // its own peer list, so it is read from Self, already checked untagged with a person's user.
  if (dnsName(self) === host) {
    if (named.length > 0) return no('duplicate_name')
    if (typeof self.ID !== 'string' || !NODE_ID.test(self.ID)) return no('not_found')
    return { ok: true, node: self.ID }
  }
  if (named.length === 0) return no('not_found')
  if (named.length > 1) return no('duplicate_name')
  const peer = named[0]
  if (!untagged(peer.Tags)) return no('tagged_device')
  if (peer.UserID === undefined || peer.UserID !== self.UserID) return no('not_your_device')
  if (typeof peer.ID !== 'string' || !NODE_ID.test(peer.ID)) return no('not_found')
  return { ok: true, node: peer.ID }
}

// ── HTTP ───────────────────────────────────────────────────────────────────

// How Node's fetch reports a certificate it does not accept: a TypeError `fetch failed` whose
// `cause` carries OpenSSL's verify code (seen on Node 24: DEPTH_ZERO_SELF_SIGNED_CERT for a
// self-signed certificate, ERR_TLS_CERT_ALTNAME_INVALID for one issued to another name).
const CERT_CODES = new Set([
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_CRL', 'UNABLE_TO_DECRYPT_CERT_SIGNATURE', 'UNABLE_TO_DECRYPT_CRL_SIGNATURE',
  'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY', 'CERT_SIGNATURE_FAILURE', 'CRL_SIGNATURE_FAILURE', 'CERT_NOT_YET_VALID', 'CERT_HAS_EXPIRED',
  'CRL_NOT_YET_VALID', 'CRL_HAS_EXPIRED', 'ERROR_IN_CERT_NOT_BEFORE_FIELD', 'ERROR_IN_CERT_NOT_AFTER_FIELD',
  'ERROR_IN_CRL_LAST_UPDATE_FIELD', 'ERROR_IN_CRL_NEXT_UPDATE_FIELD', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_CHAIN_TOO_LONG', 'CERT_REVOKED', 'INVALID_CA',
  'PATH_LENGTH_EXCEEDED', 'INVALID_PURPOSE', 'CERT_UNTRUSTED', 'CERT_REJECTED', 'HOSTNAME_MISMATCH', 'ERR_TLS_CERT_ALTNAME_INVALID',
])

/** Whether a fetch failure is a certificate the TLS check refused: a known code on the error or along its `cause` chain. */
function certificateFailure(error) {
  let current = error
  for (let depth = 0; depth < 8 && current !== null && typeof current === 'object'; depth += 1) {
    if (typeof current.code === 'string' && CERT_CODES.has(current.code)) return true
    current = current.cause
  }
  return false
}

const marked = (response) => response.headers.get(BOUNDARY_HEADER) === BOUNDARY
const isRedirect = (response) => response.type === 'opaqueredirect' || response.redirected === true || (response.status >= 300 && response.status < 400)

async function discard(response) {
  try {
    await response.body?.cancel()
  } catch {
    // nothing to read
  }
}

/** The body as JSON, read up to `max` bytes as strict UTF-8; undefined when larger, not UTF-8 or not JSON. Never reads past the limit. */
async function readJson(response, max) {
  try {
    const chunks = []
    let total = 0
    if (response.body) {
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > max) {
          await reader.cancel().catch(() => {})
          return undefined
        }
        chunks.push(value)
      }
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  } catch {
    return undefined
  }
}

const versionText = (value) => typeof value === 'string' && value.length >= 1 && value.length <= 64 && !/[\u0000-\u001f\u007f-\u009f]/.test(value)

/** The Keychain-backed store can encrypt here (on Linux, not with its plain-text backend). */
function keychainReady(safeStorage, platform) {
  try {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) return false
    return !(platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function'
      && safeStorage.getSelectedStorageBackend() === 'basic_text')
  } catch {
    return false
  }
}

// ── remote-connect.json ────────────────────────────────────────────────────

/** A stored hub: every field by its rule, unknown fields allowed. */
function validEntry(entry) {
  if (!isObject(entry)) return false
  const origin = parseHubOrigin(entry.origin)
  return origin.ok && origin.origin === entry.origin && isDeviceLabel(entry.label)
    && typeof entry.node === 'string' && NODE_ID.test(entry.node)
    && (entry.machine === undefined || entry.machine === null || (typeof entry.machine === 'string' && PLACE.test(entry.machine)))
    && typeof entry.device === 'string' && DEVICE_ID.test(entry.device)
    && typeof entry.secret === 'string' && entry.secret.length % 4 === 0 && entry.secret.length <= BLOB_MAX && BLOB.test(entry.secret)
}

/** The active hub of a schema-1 document, or null; `false` when any part fails its rule. */
function activeOf(doc) {
  const hubs = doc.hubs === undefined ? {} : doc.hubs
  if (!isObject(hubs)) return false
  const ids = Object.keys(hubs)
  if (ids.length > MAX_HUBS || !ids.every((id) => HUB_ID.test(id) && validEntry(hubs[id]))) return false
  if (doc.active === undefined || doc.active === null) return null
  if (typeof doc.active !== 'string' || !Object.hasOwn(hubs, doc.active)) return false
  const entry = hubs[doc.active]
  return { id: doc.active, origin: entry.origin, label: entry.label, node: entry.node, machine: entry.machine ?? null, device: entry.device, secret: entry.secret }
}

/** What a write may start from: a readable document, or nothing when the owner confirmed a replace. */
function writeBase(read, replace) {
  if (read.state === 'problem' && read.problem === 'newer_schema') return { refuse: 'newer_schema' }
  if (read.state === 'problem' && !replace) return { refuse: 'bad_file' }
  if (read.state === 'ok' && !replace && isObject(read.doc.hubs) && Object.keys(read.doc.hubs).length > 0) return { refuse: 'hub_exists' }
  return { base: read.doc ?? {} }
}


module.exports = {
  BLOB,
  BLOB_MAX,
  DEVICE_ID,
  HUB_ID,
  MAX_HUBS,
  NODE_ID,
  PLACE,
  SECRET,
  activeOf,
  certificateFailure,
  deviceLabelFor,
  discard,
  hubLabelFor,
  inTailnet,
  isDeviceLabel,
  isRedirect,
  keychainReady,
  marked,
  normaliseCode,
  parseHubOrigin,
  parsePeers,
  readJson,
  suffixFrom,
  validEntry,
  versionText,
  writeBase,
  writtenUserInfo,
}
