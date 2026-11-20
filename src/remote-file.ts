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
// 2. The entity exists, and the path appears verbatim, as a whole path, in one of its stored
//    agent-written fields (linksPath); else `not_linked`, also for an unknown entity.
// 3. The path in the card ends in a listed document extension (`not_a_document`). After symbolic links
//    are resolved, the target must be a regular file (`not_found`) whose own name ends in a listed
//    extension (`not_a_document`), of at most 25 MB (`too_large`), and readable (`unreadable`). The
//    file opened is the one checked: same device and inode, opened without following a link.
// 4. It goes out as a download, never as a page, streamed with its length; a file that changes size
//    while it is read is cut off and the request fails.
//
// Nothing here writes to the hub's disk, lists a folder or reads a pattern, and no refusal says more
// than its word: never whether a path exists outside the rule. Nothing is logged.
// Architecture notes: docs/architecture/remote-inbox.md ("Opening a card's files from another Mac").
import { closeSync, constants, fstatSync, lstatSync, openSync, read as fsRead, realpathSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type { Handler } from 'hono'
import { getBoardRow, getItem } from './store.js'

/** On the remote entry only, registered by guardRemoteApp after the gate. */
export const FILE_PATH = '/api/remote/file'
/** The largest file served, in bytes. */
export const FILE_MAX = 25 * 1024 * 1024
/** The inert documents and images a card's file may be: no HTML, no SVG, nothing executable. */
export const DOCUMENT_EXTENSIONS: readonly string[] = Object.freeze([
  '.md', '.markdown', '.txt', '.log', '.json', '.yaml', '.yml', '.csv', '.tsv', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp',
])
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
// what may stand right before or right after a path in a card's text, besides whitespace
const BOUNDARY = new Set(['`', '\'', '"', '(', ')', '[', ']', '<', '>', ',', ';'])
const WHITESPACE = /\s/
const DIGIT = /[0-9]/
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

/** Whether a path may end at `index`: the end of the text, whitespace or a boundary mark, or a `.` that ends the text or comes before whitespace. */
function closesAt(text: string, index: number): boolean {
  if (index === text.length) return true
  const ch = text[index]!
  if (WHITESPACE.test(ch) || BOUNDARY.has(ch)) return true
  return ch === '.' && (index + 1 === text.length || WHITESPACE.test(text[index + 1]!))
}

/**
 * Whether `text` holds `path` verbatim as a whole path: right after the start of the text,
 * whitespace or a boundary mark (`` ` ' " ( ) [ ] < > , ; ``), and right before the end, whitespace,
 * a boundary mark, or a `.` that ends the text or comes before whitespace, with an optional
 * `:<digits>` line between. So a path that is a prefix or a suffix of a longer one never matches.
 */
export function linksPath(text: string, path: string): boolean {
  if (typeof text !== 'string' || typeof path !== 'string' || path === '') return false
  for (let at = text.indexOf(path); at !== -1; at = text.indexOf(path, at + 1)) {
    if (at > 0 && !WHITESPACE.test(text[at - 1]!) && !BOUNDARY.has(text[at - 1]!)) continue
    let end = at + path.length
    if (text[end] === ':' && DIGIT.test(text[end + 1] ?? '')) {
      end += 1
      while (end < text.length && DIGIT.test(text[end]!)) end += 1
    }
    if (closesAt(text, end)) return true
  }
  return false
}

type TextFields = Record<string, unknown> & { options?: unknown }

/**
 * The agent-written fields of an item (title, detail, context, next step, impact, next-after,
 * outcome, option labels and details) or a row (label, note and the same others): the fields a
 * card's Links strip reads (public/link-strip.js). Never a reply, an annotation or a row's history.
 */
export function entityTexts(kind: FileKind, entity: TextFields): string[] {
  const own = kind === 'item'
    ? [entity['title'], entity['detail']]
    : [entity['label'], entity['note']]
  const options = Array.isArray(entity.options) ? entity.options : []
  return [
    ...own, entity['context'], entity['next_step'], entity['impact'], entity['next_after'], entity['outcome'],
    ...options.flatMap((option: unknown) => (option && typeof option === 'object' ? [(option as TextFields)['label'], (option as TextFields)['detail']] : [])),
  ].filter((text): text is string => typeof text === 'string' && text !== '')
}

/** The texts of the item or plan row with this id, from the store; null when there is none. Every item and every row of an active or archived plan is one the remote routes show. */
export function linkedTexts(db: Database.Database): (kind: FileKind, id: string) => string[] | null {
  return (kind, id) => {
    const entity = kind === 'item' ? getItem(db, id) : getBoardRow(db, id)
    return entity ? entityTexts(kind, entity as unknown as TextFields) : null
  }
}

export type OpenedFile = { ok: true; fd: number; size: number } | { ok: false; reason: Exclude<FileRefusal, 'bad_request' | 'not_linked'> }

const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = constants
const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code
const MISSING = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'ENAMETOOLONG'])

/**
 * Opens the file a linked path names, or says why not. `~/` is under `home`. Symbolic links are
 * resolved first; the target must have a listed extension, be a regular file and be at most
 * FILE_MAX. Then it is opened without following a link and must be the same file (device and
 * inode) that was checked, so a file swapped between the check and the open is `not_found`.
 * `seam.beforeOpen` runs between the two, for tests.
 */
export function openLinkedFile(path: string, home: string, seam: { beforeOpen?: () => void } = {}): OpenedFile {
  const full = path.startsWith('~/') ? join(home, path.slice(2)) : path
  let real: string
  try {
    real = realpathSync.native(full)
  } catch (error) {
    return { ok: false, reason: MISSING.has(errorCode(error) ?? '') ? 'not_found' : 'unreadable' }
  }
  if (!documentName(lastSegment(real))) return { ok: false, reason: 'not_a_document' }
  let checked
  try {
    checked = lstatSync(real)
  } catch (error) {
    return { ok: false, reason: MISSING.has(errorCode(error) ?? '') ? 'not_found' : 'unreadable' }
  }
  if (!checked.isFile()) return { ok: false, reason: 'not_found' }
  if (checked.size > FILE_MAX) return { ok: false, reason: 'too_large' }
  seam.beforeOpen?.()
  let fd: number
  try {
    fd = openSync(real, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (error) {
    return { ok: false, reason: MISSING.has(errorCode(error) ?? '') ? 'not_found' : 'unreadable' }
  }
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== checked.dev || opened.ino !== checked.ino) {
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
 * `texts(kind, id)` answers the entity's text fields or null; `home` is the hub user's home for `~/`.
 * Each refusal is `{ ok: false, reason }` with its word only.
 */
export function remoteFileRoute(opts: {
  texts: (kind: FileKind, id: string) => string[] | null
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
    let texts: string[] | null
    try {
      texts = opts.texts(request.kind, request.id)
    } catch {
      texts = null
    }
    if (texts === null || !texts.some((text) => linksPath(text, request.path))) return refuse('not_linked')
    if (!documentName(lastSegment(request.path))) return refuse('not_a_document')
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
