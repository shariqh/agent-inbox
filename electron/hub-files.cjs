'use strict'
// A card's files from the connecting Mac (#634; architecture notes in docs/architecture/remote-inbox.md,
// "Opening a card's files from another Mac").
//
// On a Mac that shows another Mac's Inbox (the hub), a card's file link names a path on the hub. The
// hub's page offers "Open a copy on this Mac" for a listed document; it names only the entity whose
// card links the file and the path, through agentInboxDesk.openFile({ kind, id, path }). Main decides
// everything else, in this order, each with its own reason word: the sender is the hub view's top
// frame on the hub's own page (`unavailable`), the request is exactly `{ kind, id, path }` with a path
// by the hub's form rule (`bad_request`) that names a listed document under `~/` or an allowed root,
// with no hidden segment (`not_a_document`), that view is focused and had a key press or click
// under 5 seconds ago, used up by this open (`no_gesture`), at most one open a second and twenty a
// minute, never two at once (`busy`). Then main asks the hub itself, through the connection's hub
// fetch only (`unreachable`): GET /api/remote/file, where the hub checks the link again
// (src/remote-file.ts) and answers its own word (`not_linked`, `not_a_document`, `too_large`,
// `not_found`, `unreadable`, or `busy` when it is already serving two files); a 403 is `old_hub` from a hub older than the route, else `refused`. The
// bytes become a private copy, `hub-files/<hub id>/<16 hex of the path's SHA-256>/<file name>` beside
// the local database (folders 0700, the file 0600, written to a new name created exclusively without
// following a link, then renamed into place), whose name is the path's own last segment, cleaned,
// with a listed extension (`failed`), and the copy is opened with the person's default app
// (`open_failed`) through electron/link-open.cjs openHubCopy, main's one opener. Nothing from the hub is ever run, its headers never name the copy, and nothing
// whose extension is not on the list is opened. Copies older than a day are swept at the start of
// each open. A refusal logs its reason word, except the first three, which come before the gesture
// check and so log nothing.
//
// Policy only, with every dependency injected (the hub view, the connection, the opener), so
// test/hub-files.test.ts runs no fetch and opens no app.
const { createHash, randomBytes: nodeRandomBytes } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { discard, marked, readJson } = require('./remote-connect-rules.cjs')

const FILE_ROUTE = 'api/remote/file'
// the first version whose hub serves the route: an older hub answers it with a 403
const FILES_FROM = '2.16.0'
const FILE_MAX = 25 * 1024 * 1024
// the hub's list (src/remote-file.ts DOCUMENT_EXTENSIONS), compared in a test
const DOCUMENT_EXTENSIONS = Object.freeze([
  '.md', '.markdown', '.txt', '.log', '.json', '.yaml', '.yml', '.csv', '.tsv', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp',
])
const LISTED = new Set(DOCUMENT_EXTENSIONS)
// the hub's allowed roots besides `~/` (src/remote-file.ts ALLOWED_ROOTS), compared in a test
const ALLOWED_ROOTS = Object.freeze(['/Users/', '/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/'])
const PATH_MAX = 4096
const NAME_MAX = 120
// what a file name may hold in UTF-8, with room to spare under the file system's 255
const NAME_BYTES_MAX = 240
const ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const HUB_ID = /^[0-9a-f]{8}$/
const COPY_DIR = /^[0-9a-f]{16}$/
const RANDOM_HEX = /^[0-9a-f]{16}$/
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
// separators, control characters, format characters (a right-to-left override, a zero-width space)
// and the two Unicode line breaks: each becomes `_` in a copy's name
const NAME_UNSAFE = /[\/\\:\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/gu
const LENGTH = /^(0|[1-9]\d{0,8})$/
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const KEEP_MS = 24 * 60 * 60_000
const GAP_MS = 1_000
const PER_MINUTE = 20
const MINUTE_MS = 60_000
// the whole request and its body: up to 25 MB over the tailnet
const FETCH_MS = 60_000
const REFUSAL_MAX = 1024
// the hub's refusal words (src/remote-file.ts FileRefusal); its `busy` (two files already being served) reads as ours
const HUB_WORDS = new Set(['bad_request', 'not_linked', 'not_a_document', 'too_large', 'not_found', 'unreadable', 'busy'])
const REASONS = Object.freeze([
  'unavailable', 'bad_request', 'no_gesture', 'busy', 'unreachable', 'old_hub', 'refused',
  'not_linked', 'not_a_document', 'too_large', 'not_found', 'unreadable', 'failed', 'open_failed',
])
const OFF = Object.freeze({ files: false })

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** A file name ending in a listed extension, compared without case; a name that is only an extension is not one. */
function documentName(name) {
  if (typeof name !== 'string') return false
  const dot = name.lastIndexOf('.')
  return dot > 0 && LISTED.has(name.slice(dot).toLowerCase())
}

/** The hub's path rule (src/remote-file.ts linkedPathForm): absolute or `~/`, no control character, no empty, `.` or `..` segment. */
function linkedPathForm(value) {
  if (typeof value !== 'string' || value.length < 2 || value.length > PATH_MAX || CONTROL.test(value)) return false
  let body
  if (value.startsWith('~/')) body = value.slice(2)
  else if (value.startsWith('/')) body = value.slice(1)
  else return false
  return body.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/**
 * The name a copy of `filePath` is saved under, or null: its last segment with every separator,
 * control or format character as `_`, no leading dot, at most 120 characters and 240 UTF-8 bytes
 * (the stem is shortened, the extension kept), ending in a listed extension.
 */
function copyName(filePath) {
  if (typeof filePath !== 'string') return null
  let name = filePath.slice(filePath.lastIndexOf('/') + 1).replace(NAME_UNSAFE, '_').replace(/^\.+/, '')
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  const extension = name.slice(dot)
  let stem = Array.from(name.slice(0, dot))
  while (stem.length > 0 && (stem.length + extension.length > NAME_MAX || Buffer.byteLength(stem.join('') + extension) > NAME_BYTES_MAX)) stem.pop()
  name = stem.join('') + extension
  return stem.length > 0 && documentName(name) ? name : null
}

/** Whether any segment of `filePath` starts with `.`: a hidden file or folder, which stays on the hub. */
function hiddenPath(filePath) {
  return filePath.split('/').some((segment) => segment.startsWith('.'))
}

/** The hub's servablePath (src/remote-file.ts): a path by the hub's form rule, under `~/` or an allowed root, with a listed name and no hidden segment. */
function servablePath(filePath) {
  return linkedPathForm(filePath) && (filePath.startsWith('~/') || ALLOWED_ROOTS.some((root) => filePath.startsWith(root))) && documentName(filePath.slice(filePath.lastIndexOf('/') + 1)) && !hiddenPath(filePath) && copyName(filePath) !== null
}

/** `{ kind, id, path }` from exactly one plain object with exactly those keys and a path the hub's form rule takes; else null. */
function fileRequest(args) {
  if (!Array.isArray(args) || args.length !== 1 || !isPlainObject(args[0])) return null
  const given = args[0]
  const keys = Object.keys(given).sort()
  if (keys.join(',') !== 'id,kind,path') return null
  const { kind, id, path: filePath } = given
  if ((kind !== 'item' && kind !== 'row') || typeof id !== 'string' || !ENTITY_ID.test(id)) return null
  if (!linkedPathForm(filePath)) return null
  return { kind, id, path: filePath }
}

function isOlder(version, than) {
  if (typeof version !== 'string' || !VERSION.test(version)) return false
  const left = VERSION.exec(version).slice(1).map(BigInt)
  const right = VERSION.exec(than).slice(1).map(BigInt)
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index]
  }
  return false
}

/** A real directory this user owns at `dir`, made 0700 if missing and tightened to 0700 if wider; false for a link or anything else. */
function privateDir(dir) {
  try {
    fs.mkdirSync(dir, { mode: 0o700 })
  } catch (error) {
    if (error?.code !== 'EEXIST') return false
  }
  try {
    const folder = fs.lstatSync(dir)
    if (!folder.isDirectory() || folder.isSymbolicLink()) return false
    if (typeof process.getuid === 'function' && folder.uid !== process.getuid()) return false
    if ((folder.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700)
    return true
  } catch {
    return false
  }
}

const listed = (dir) => {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}
const isRealDir = (dir) => {
  try {
    const stat = fs.lstatSync(dir)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Copies older than a day, ours only: under `root`, a hub folder (8 hex), a copy folder (16 hex) and
 * the regular files in it (a copy, or a partial write left behind). lstat throughout, so a link or a
 * folder is never followed or removed. A folder left empty is removed.
 */
function sweepCopies(root, nowMs) {
  if (!Number.isFinite(nowMs)) return
  for (const hub of listed(root)) {
    const hubDir = path.join(root, hub)
    if (!HUB_ID.test(hub) || !isRealDir(hubDir)) continue
    for (const copy of listed(hubDir)) {
      const copyDir = path.join(hubDir, copy)
      if (!COPY_DIR.test(copy) || !isRealDir(copyDir)) continue
      for (const name of listed(copyDir)) {
        const file = path.join(copyDir, name)
        try {
          const stat = fs.lstatSync(file)
          if (stat.isFile() && nowMs - stat.mtimeMs > KEEP_MS) fs.unlinkSync(file)
        } catch {
          // gone meanwhile, or not ours to remove
        }
      }
      try {
        fs.rmdirSync(copyDir)
      } catch {
        // not empty: a fresh copy, or something not ours
      }
    }
    try {
      fs.rmdirSync(hubDir)
    } catch {
      // not empty
    }
  }
}

/**
 * The body into `folder/name`: written to `.<random>.part` (created with O_EXCL and O_NOFOLLOW at
 * 0600), counted against `size` as it arrives, then renamed over `name`, which replaces a copy or a
 * link there without following it. `{ ok: true, file }`, or `{ ok: false }` with nothing left behind.
 */
async function writeCopy({ folder, name, response, size, random }) {
  const partial = path.join(folder, `.${random}.part`)
  const file = path.join(folder, name)
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants
  let fd = null
  let reader = null
  try {
    fd = fs.openSync(partial, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    fs.fchmodSync(fd, 0o600)
    let total = 0
    if (response.body) {
      reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > size || total > FILE_MAX) throw new Error('longer than its length')
        // a write may take fewer bytes than given: write the rest
        for (let offset = 0; offset < value.byteLength;) {
          const written = fs.writeSync(fd, value, offset, value.byteLength - offset)
          if (!(written > 0)) throw new Error('nothing written')
          offset += written
        }
      }
      reader = null
    }
    if (total !== size) throw new Error('shorter than its length')
    fs.closeSync(fd)
    fd = null
    fs.renameSync(partial, file)
    return { ok: true, file }
  } catch {
    if (reader !== null) await reader.cancel().catch(() => {})
    if (fd !== null) {
      try { fs.closeSync(fd) } catch { /* already closed */ }
    }
    try { fs.unlinkSync(partial) } catch { /* nothing to remove */ }
    return { ok: false }
  }
}

/**
 * Main's handler for the two file channels. Every dependency is an option: `platform`, `hubView()`
 * (its `trusts(event)` and `takeGesture(event)`), `connect()` (the connection controller: its
 * `connection()`, `hubBase(id)` and `hubFetch()`), `dir` (the hub-files folder), `openCopy(file)`
 * (electron/link-open.cjs openHubCopy, which opens only a listed regular file inside that folder:
 * `{ ok: true }` when opened), `now`, `randomBytes` and `log`. No method rejects.
 */
function createHubFiles(options) {
  const { platform, hubView, dir, openCopy } = options
  const now = options.now ?? Date.now
  const randomBytes = options.randomBytes ?? nodeRandomBytes
  const log = (line) => {
    try {
      options.log?.(line)
    } catch {
      // a logger that throws changes nothing
    }
  }
  const opens = []
  let inFlight = false

  const clock = () => {
    try {
      const t = now()
      return Number.isFinite(t) ? t : Number.NaN
    } catch {
      return Number.NaN
    }
  }
  const view = () => {
    try {
      return hubView() ?? null
    } catch {
      return null
    }
  }
  const connection = () => {
    try {
      return options.connect() ?? null
    } catch {
      return null
    }
  }
  // the reason word is all a refusal logs: no host, path, id or file
  const refused = (reason) => {
    log(`hub-files: ${reason}`)
    return { ok: false, reason }
  }
  const unlogged = (reason) => ({ ok: false, reason })

  function trusted(event) {
    const current = view()
    try {
      return current !== null && current.trusts(event) === 'hub' ? current : null
    } catch {
      return null
    }
  }

  function mayOpen(t) {
    if (!Number.isFinite(t)) return false
    while (opens.length > 0 && !(t - opens[0] < MINUTE_MS)) opens.shift()
    if (opens.length >= PER_MINUTE) return false
    return opens.length === 0 || t - opens[opens.length - 1] >= GAP_MS
  }

  /** Whether the connection to hub `id` probed a valid version older than the route's. */
  function olderHub(connect, id) {
    try {
      const current = connect.connection()
      return isObject(current) && current.mode === 'hub' && current.id === id && isOlder(current.version, FILES_FROM)
    } catch {
      return false
    }
  }

  async function openChecked(id, request) {
    const connect = connection()
    let base = null
    try {
      base = connect === null ? null : connect.hubBase(id)
    } catch {
      base = null
    }
    const fetchImpl = typeof base === 'string' ? connect.hubFetch() : null
    if (typeof fetchImpl !== 'function') return refused('unreachable')
    sweepCopies(dir, clock())
    const encoded = Buffer.from(request.path, 'utf8').toString('base64url')
    let response
    try {
      response = await fetchImpl(`${base}${FILE_ROUTE}?kind=${request.kind}&id=${request.id}&path=${encoded}`, { method: 'GET', timeoutMs: FETCH_MS })
    } catch {
      return refused('unreachable')
    }
    if (!response || typeof response !== 'object') return refused('unreachable')
    if (response.status === 403) {
      await discard(response)
      return refused(olderHub(connect, id) ? 'old_hub' : 'refused')
    }
    if (!marked(response)) {
      await discard(response)
      return refused('unreachable')
    }
    if (response.status !== 200) {
      const body = await readJson(response, REFUSAL_MAX)
      return refused(isObject(body) && body.ok === false && HUB_WORDS.has(body.reason) ? body.reason : 'failed')
    }
    const length = response.headers.get('content-length')
    if (response.headers.get('content-type') !== 'application/octet-stream' || typeof length !== 'string' || !LENGTH.test(length)) {
      await discard(response)
      return refused('failed')
    }
    const size = Number(length)
    if (size > FILE_MAX) {
      await discard(response)
      return refused('too_large')
    }
    const name = copyName(request.path)
    let random = ''
    try {
      random = Buffer.from(randomBytes(8)).toString('hex')
    } catch {
      random = ''
    }
    const hubDir = path.join(dir, id)
    const folder = path.join(hubDir, createHash('sha256').update(request.path, 'utf8').digest('hex').slice(0, 16))
    if (name === null || !RANDOM_HEX.test(random) || !path.isAbsolute(dir) || !privateDir(dir) || !privateDir(hubDir) || !privateDir(folder)) {
      await discard(response)
      return refused('failed')
    }
    const saved = await writeCopy({ folder, name, response, size, random })
    if (!saved.ok) return refused('failed')
    // nothing whose extension is off the list is ever opened
    if (!documentName(path.basename(saved.file))) return refused('failed')
    let opened
    try {
      opened = await openCopy(saved.file)
    } catch {
      opened = null
    }
    if (!isObject(opened) || opened.ok !== true) return refused('open_failed')
    log('hub-files: opened')
    return { ok: true }
  }

  return Object.freeze({
    /** `{ files: true }` only for the hub view's top frame on the hub's page, on macOS, with no argument, while the connection has the hub. */
    async available(event, args) {
      try {
        if (platform !== 'darwin' || !Array.isArray(args) || args.length !== 0 || trusted(event) === null) return { ...OFF }
        const connect = connection()
        const current = connect === null ? null : connect.connection()
        if (!isObject(current) || current.mode !== 'hub' || typeof current.id !== 'string') return { ...OFF }
        return { files: typeof connect.hubBase(current.id) === 'string' }
      } catch {
        return { ...OFF }
      }
    },
    /** The checks in order (see the head of this file); `{ ok: true }` or `{ ok: false, reason }`. */
    async open(event, args) {
      const current = platform === 'darwin' ? trusted(event) : null
      if (current === null) return unlogged('unavailable')
      const request = fileRequest(args)
      if (request === null) return unlogged('bad_request')
      // the hub's rule, before anything is asked: a listed document, nothing hidden
      if (!servablePath(request.path)) return unlogged('not_a_document')
      let id = null
      try {
        id = current.takeGesture(event)
      } catch {
        id = null
      }
      if (typeof id !== 'string' || !HUB_ID.test(id)) return unlogged('no_gesture')
      const t = clock()
      if (inFlight || !mayOpen(t)) return refused('busy')
      inFlight = true
      opens.push(t)
      try {
        return await openChecked(id, request)
      } catch {
        return refused('failed')
      } finally {
        inFlight = false
      }
    },
  })
}

module.exports = {
  ALLOWED_ROOTS,
  DOCUMENT_EXTENSIONS,
  FILES_FROM,
  FILE_MAX,
  KEEP_MS,
  REASONS,
  copyName,
  createHubFiles,
  documentName,
  fileRequest,
  hiddenPath,
  linkedPathForm,
  servablePath,
  sweepCopies,
}
