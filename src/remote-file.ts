// A card's files from the connecting Mac (#634), the hub's half. VIEWER PROCESS ONLY: nothing in the
// stdio MCP server's import graph may reach this module (test/prstate.test.ts).
//
// GET /api/remote/file is on the remote entry only, served by the guarded app after the whole gate
// (src/viewer-remote.ts, GUARDED_ROUTES), so every request comes from a paired device. It is the first
// route that returns file contents, so it serves only a file a card already links, read-only:
//
// 1. The request names an entity and a path, and nothing else: `kind` (item or row), its `id`, and
//    the path as base64url of its UTF-8 (the gate refuses `%` anywhere in a target, so a path with a
//    space or a non-ASCII letter could not travel as plain text). A bad form is `bad_request`.
// 2. The entity exists, and its card draws the path as a file link: the page's own scanner
//    (public/link-strip.js cardLinks, which reads the same stored fields through public/links.js)
//    finds a file link whose path is exactly the requested one, absolute or under `~/`. A
//    repo-relative link is not served. Else `not_linked`, also for an unknown entity.
// 3. The path in the card is under an allowed root (`~/`, /Users, /tmp, /private/tmp,
//    /var/folders, /private/var/folders), ends in a listed document extension and has no segment that
//    starts with `.` (`not_a_document`). After symbolic links are resolved, the target must be a
//    regular file (`not_found`) under an allowed root or the real home folder with no hidden segment (else
//    `not_found`, as for a missing target, so a refusal never says whether a target outside the rule exists),
//    whose own name ends in a listed extension (`not_a_document`), of at most 25 MB (`too_large`), and readable (`unreadable`). The file is
//    opened with no link allowed anywhere in its resolved path, and its type and size are read from the opened descriptor.
// 4. It goes out as a download, never as a page, streamed with its length; a file that changes size
//    while it is read is cut off and the request fails.
//
// Nothing here writes to the hub's disk, lists a folder or reads a pattern, and no refusal says more
// than its word: never whether a path exists outside the rule. Nothing is logged.
// Architecture notes: docs/architecture/remote-inbox.md ("Opening a card's files from another Mac").
import { closeSync, constants, fstatSync, openSync, read as fsRead, realpathSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type { Handler } from 'hono'
// The page's link scanner, so "linked" means exactly what a card draws as a file link. This module is
// reached only from src/viewer-remote.ts and src/viewer-server.ts, never from the stdio MCP server
// (test/prstate.test.ts), so the scanner stays out of that server's import graph.
import { cardLinks } from '../public/link-strip.js'
import { getBoardRowWithPlan, getItem } from './store.js'

/** On the remote entry only, registered by guardRemoteApp after the gate. */
export const FILE_PATH = '/api/remote/file'
/** The largest file served, in bytes. */
export const FILE_MAX = 25 * 1024 * 1024
/** The inert documents and images a card's file may be: no HTML, no SVG, nothing executable. */
export const DOCUMENT_EXTENSIONS: readonly string[] = Object.freeze([
  '.md', '.markdown', '.txt', '.log', '.json', '.yaml', '.yml', '.csv', '.tsv', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp',
])
/**
 * The folders a served file may be under, besides the hub user's home: on the path as the card names
 * it (where `~/` stands for the home) and again on its resolved target (where the real home folder
 * counts). System locations (`/etc`, `/Library`, `/System`, `/Applications`, `/usr`, `/opt`, the rest
 * of `/var`) and volumes (`/Volumes`: a network or removable volume can hang the hub's viewer) stay on the hub. The connecting Mac's main and the page keep the same list.
 */
export const ALLOWED_ROOTS: readonly string[] = Object.freeze(['/Users/', '/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/'])
export type FileRefusal = 'bad_request' | 'not_linked' | 'not_a_document' | 'too_large' | 'not_found' | 'unreadable'

export type FileKind = 'item' | 'row'
export interface FileRequest {
  kind: FileKind
  id: string
  path: string
}

const STATUS: Record<FileRefusal, 400 | 404 | 413 | 415 | 422> = {
  bad_request: 400, not_linked: 404, not_found: 404, not_a_document: 415, too_large: 413, unreadable: 422,
}
const LISTED = new Set(DOCUMENT_EXTENSIONS)
const PATH_MAX = 4096
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
// item and row ids: UUIDs, and in tests short words; never a character a query or a path gives meaning to
const ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const BASE64URL = /^[A-Za-z0-9_-]{2,5464}$/
const CHUNK = 64 * 1024
const NAME_MAX = 120

const lastSegment = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** A file name that ends in a listed extension, compared without case; a name that is only an extension is not one. */
export function documentName(name: string): boolean {
  if (typeof name !== 'string') return false
  const dot = name.lastIndexOf('.')
  return dot > 0 && LISTED.has(name.slice(dot).toLowerCase())
}

/**
 * A path a request may name: at most 4,096 characters with no control character, absolute (`/…`)
 * or under the hub user's home (`~/…`), and every segment after that non-empty and neither `.` nor
 * `..`, so no `//`, no trailing `/` and no climbing. Nothing is decoded: `%2e` is three characters.
 */
export function linkedPathForm(path: unknown): path is string {
  if (typeof path !== 'string' || path.length < 2 || path.length > PATH_MAX || CONTROL.test(path)) return false
  let body: string
  if (path.startsWith('~/')) body = path.slice(2)
  else if (path.startsWith('/')) body = path.slice(1)
  else return false
  return body.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/**
 * The request in the raw target (`incoming.url`, as the gate checked it), or null: exactly
 * FILE_PATH, then a query of exactly `kind`, `id` and `path`, each once, in any order. `path` is
 * canonical unpadded base64url of strict UTF-8 that passes linkedPathForm.
 */
export function readFileQuery(raw: unknown): FileRequest | null {
  if (typeof raw !== 'string' || !raw.startsWith(`${FILE_PATH}?`)) return null
  const fields = new Map<string, string>()
  for (const pair of raw.slice(FILE_PATH.length + 1).split('&')) {
    const parts = pair.split('=')
    if (parts.length !== 2 || fields.has(parts[0]!)) return null
    fields.set(parts[0]!, parts[1]!)
  }
  if (fields.size !== 3) return null
  const kind = fields.get('kind')
  const id = fields.get('id')
  const encoded = fields.get('path')
  if ((kind !== 'item' && kind !== 'row') || id === undefined || !ENTITY_ID.test(id) || encoded === undefined || !BASE64URL.test(encoded)) return null
  const bytes = Buffer.from(encoded, 'base64url')
  if (bytes.toString('base64url') !== encoded) return null
  let path: string
  try {
    path = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
  return linkedPathForm(path) ? { kind, id, path } : null
}

/** Whether any segment of `path` starts with `.`: a hidden file or folder (`~/.ssh`, `.git/…`, `.env.json`). */
export function hiddenPath(path: string): boolean {
  return path.split('/').some((segment) => segment.startsWith('.'))
}

/**
 * Whether `path` is under an allowed root: `~/…`, one of ALLOWED_ROOTS, or (for a resolved target)
 * inside `realHome`, the hub user's real home folder.
 */
export function allowedPath(path: string, realHome?: string): boolean {
  if (path.startsWith('~/') || ALLOWED_ROOTS.some((root) => path.startsWith(root))) return true
  if (typeof realHome !== 'string' || realHome === '' || realHome === '/') return false
  const home = realHome.endsWith('/') ? realHome : `${realHome}/`
  return path.startsWith(home)
}

/** A path the route may serve by its form, on the path as the card names it: under an allowed root, a listed document name, no hidden segment. */
export function servablePath(path: string): boolean {
  return linkedPathForm(path) && allowedPath(path) && documentName(lastSegment(path)) && !hiddenPath(path)
}

type CardEntity = Parameters<typeof cardLinks>[0]
type CardIdentity = Parameters<typeof cardLinks>[1]

/**
 * The absolute and `~/` file paths the card of `entity` (an item, or a plan row read against its plan
 * `identity`) draws as file links: public/link-strip.js's cardLinks, the Links strip's own model, with
 * no link index (a PR or issue chip is never a file). A repo-relative link is left out.
 */
export function cardFilePaths(entity: CardEntity, identity: CardIdentity): string[] {
  const paths: string[] = []
  for (const link of cardLinks(entity, identity, null)) {
    if (link.kind !== 'file' || typeof link.path !== 'string' || link.root !== undefined) continue
    if (link.path.startsWith('/') || link.path.startsWith('~/')) paths.push(link.path)
  }
  return paths
}

/** The file paths the card of the item or plan row with this id links, from the store; null when there is none. Every item and every row of an active or archived plan is one the remote routes show. */
export function linkedFiles(db: Database.Database): (kind: FileKind, id: string) => string[] | null {
  return (kind, id) => {
    if (kind === 'item') {
      const item = getItem(db, id)
      return item ? cardFilePaths(item as unknown as CardEntity, item as unknown as CardIdentity) : null
    }
    const found = getBoardRowWithPlan(db, id)
    return found ? cardFilePaths(found.row as unknown as CardEntity, found.board as unknown as CardIdentity) : null
  }
}

export type OpenedFile = { ok: true; fd: number; size: number } | { ok: false; reason: Exclude<FileRefusal, 'bad_request' | 'not_linked'> }

const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = constants
// macOS: O_NOFOLLOW_ANY (sys/fcntl.h, not in fs.constants) fails with ELOOP on a link in ANY component,
// where O_NOFOLLOW covers only the last one. The kernel refuses the two flags together (EINVAL), so it replaces it.
const O_NOFOLLOW_ANY = 0x20000000
const OPEN_FLAGS = O_RDONLY | O_NONBLOCK | (process.platform === 'darwin' ? O_NOFOLLOW_ANY : O_NOFOLLOW)
const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code
const MISSING = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'ENAMETOOLONG', 'ENXIO'])

/**
 * Opens the file a linked path names, or says why not. `~/` is under `home`. Symbolic links are
 * resolved first; the target must be under an allowed root with no hidden segment (else `not_found`,
 * as for a missing target) and have a listed extension (else `not_a_document`). Then it is opened
 * with no link allowed anywhere in the resolved path (macOS: O_NOFOLLOW_ANY; elsewhere the last
 * component only), so a folder swapped for a link after the check is `not_found`. Its type and size
 * are those of the opened descriptor: a regular file of at most FILE_MAX.
 * `seam.beforeOpen` runs between the checks and the open, for tests.
 */
export function openLinkedFile(path: string, home: string, seam: { beforeOpen?: () => void } = {}): OpenedFile {
  const full = path.startsWith('~/') ? join(home, path.slice(2)) : path
  let real: string
  try {
    real = realpathSync.native(full)
  } catch (error) {
    return { ok: false, reason: MISSING.has(errorCode(error) ?? '') ? 'not_found' : 'unreadable' }
  }
  let realHome = home
  try {
    realHome = realpathSync.native(home)
  } catch {
    // a home that cannot be resolved counts only as written
  }
  // A target outside the rule (outside the roots, or with a hidden segment) answers as a missing one
  // does, so a refusal never says whether such a path exists; an unlisted type inside the rule is not_a_document.
  if (!allowedPath(real, realHome) || hiddenPath(real)) return { ok: false, reason: 'not_found' }
  if (!documentName(lastSegment(real))) return { ok: false, reason: 'not_a_document' }
  seam.beforeOpen?.()
  let fd: number
  try {
    fd = openSync(real, OPEN_FLAGS)
  } catch (error) {
    return { ok: false, reason: MISSING.has(errorCode(error) ?? '') ? 'not_found' : 'unreadable' }
  }
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile()) {
      closeSync(fd)
      return { ok: false, reason: 'not_found' }
    }
    if (opened.size > FILE_MAX) {
      closeSync(fd)
      return { ok: false, reason: 'too_large' }
    }
    return { ok: true, fd, size: opened.size }
  } catch {
    closeSync(fd)
    return { ok: false, reason: 'unreadable' }
  }
}

const readAt = (fd: number, length: number, position: number): Promise<Buffer> => new Promise((resolve, reject) => {
  const buffer = Buffer.alloc(length)
  fsRead(fd, buffer, 0, length, position, (error, bytes) => (error ? reject(error) : resolve(buffer.subarray(0, bytes))))
})

const changed = (): Error => new Error('the file changed while it was read')

/**
 * The open file as a stream of exactly `size` bytes, read in 64 KiB chunks from fixed positions,
 * and closed at its end, on an error or when the reader cancels. Before the chunk that completes
 * `size` goes out, one more byte is asked for: a file that grew, like one that shrank, fails the
 * stream with what went out still short of the promised length, and `onChanged` runs (the route
 * closes the connection there, so the client sees the response cut off). A size over FILE_MAX fails at once.
 */
export function fileStream(fd: number, size: number, opts: {
  read?: (fd: number, length: number, position: number) => Promise<Buffer>
  close?: (fd: number) => void
  onChanged?: () => void
} = {}): ReadableStream<Uint8Array> {
  const read = opts.read ?? readAt
  const closeFd = opts.close ?? closeSync
  let closed = false
  let sent = 0
  const finish = () => {
    if (closed) return
    closed = true
    try {
      closeFd(fd)
    } catch {
      // already closed
    }
  }
  const fail = (controller: ReadableStreamDefaultController<Uint8Array>, error: Error, wasChange: boolean) => {
    finish()
    if (wasChange) {
      try {
        opts.onChanged?.()
      } catch {
        // the connection is going anyway
      }
    }
    controller.error(error)
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!Number.isSafeInteger(size) || size < 0 || size > FILE_MAX) return fail(controller, new Error('the file is too large'), false)
      try {
        const want = Math.min(CHUNK, size - sent)
        const chunk = want > 0 ? await read(fd, want, sent) : Buffer.alloc(0)
        if (want > 0 && chunk.length === 0) return fail(controller, changed(), true)
        if (sent + chunk.length < size) {
          sent += chunk.length
          controller.enqueue(new Uint8Array(chunk))
          return
        }
        // the last chunk: only once the file has nothing past its size
        const extra = await read(fd, 1, size)
        if (extra.length > 0) return fail(controller, changed(), true)
        sent += chunk.length
        finish()
        if (chunk.length > 0) controller.enqueue(new Uint8Array(chunk))
        controller.close()
      } catch {
        fail(controller, new Error('the file could not be read'), true)
      }
    },
    cancel() {
      finish()
    },
  })
}

/** The name a download is offered under: the path's last segment in ASCII letters, digits, `.`, `_` and `-`, no leading dot, at most 120 characters with its extension kept. */
function attachmentName(path: string): string {
  let name = lastSegment(path).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '')
  if (name.length > NAME_MAX) {
    const dot = name.lastIndexOf('.')
    const extension = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : ''
    name = name.slice(0, NAME_MAX - extension.length) + extension
  }
  return name === '' ? 'file' : name
}

const incomingOf = (env: unknown): IncomingMessage | undefined => (env as { incoming?: IncomingMessage } | undefined)?.incoming

/**
 * The route, registered on the guarded app after the gate (guardRemoteApp): every request has passed
 * it with a paired device's secret, and the handler refuses one with no matched device by itself.
 * `linked(kind, id)` answers the file paths the entity's card links, or null; `home` is the hub user's home for `~/`.
 * Each refusal is `{ ok: false, reason }` with its word only.
 */
export function remoteFileRoute(opts: {
  linked: (kind: FileKind, id: string) => string[] | null
  deviceOf: (incoming: IncomingMessage | undefined) => string | null
  home: string
}): Handler {
  return (c) => {
    const incoming = incomingOf(c.env)
    if (opts.deviceOf(incoming) === null) return c.text('Forbidden', 403)
    const refuse = (reason: FileRefusal) => c.json({ ok: false, reason }, STATUS[reason])
    // a HEAD would open a file whose stream nobody reads; a request with a body names more than it may
    const length = incoming?.headers['content-length']
    if (c.req.method !== 'GET' || (length !== undefined && length !== '0') || incoming?.headers['transfer-encoding'] !== undefined) return refuse('bad_request')
    const request = readFileQuery(incoming?.url)
    if (request === null) return refuse('bad_request')
    let linked: string[] | null
    try {
      linked = opts.linked(request.kind, request.id)
    } catch {
      linked = null
    }
    if (linked === null || !linked.includes(request.path)) return refuse('not_linked')
    if (!servablePath(request.path)) return refuse('not_a_document')
    const opened = openLinkedFile(request.path, opts.home)
    if (!opened.ok) return refuse(opened.reason)
    const socket = incoming?.socket
    const body = fileStream(opened.fd, opened.size, { onChanged: () => socket?.destroy() })
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${attachmentName(request.path)}"`,
        'Content-Length': String(opened.size),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    })
  }
}
