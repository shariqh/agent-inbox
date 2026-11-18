// The remote entry (#617, PR 2a): a second loopback listener that Tailscale Serve forwards to,
// for the owner's own paired devices. VIEWER PROCESS ONLY: nothing in the stdio MCP server's
// import graph may reach this module (test/prstate.test.ts). It is separate from the loopback
// boundary in src/viewer-network.ts, which it does not change.
//
// Design: docs/superpowers/specs/2026-11-17-remote-inbox-design.md §3.2; architecture notes in
// docs/architecture/remote-inbox.md. Off unless `remote.json` beside the hub database (remoteDir: the folder
// of AGENT_INBOX_DB, else ~/.agent-inbox; AGENT_INBOX_MESH_DIR does not move it) turns it on,
// and with no paired device every request but pairing is refused. Pairing (PR 2b) lives in
// src/remote-pair.ts; the Settings panel and every Tailscale command are the desktop app's.
//
// Agents on the hub may run commands without asking, and a message to a session is as good as
// running commands on the hub, so this gate is the line between the owner and everyone else.
// Every refusal is a bare 403 `Forbidden`; its reason goes only into a counter. Nothing here logs
// a login, a header value, a secret, a hash or a query.
import crypto from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import type { IncomingMessage, Server } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createAdaptorServer } from '@hono/node-server'
import type { HttpBindings } from '@hono/node-server'
import { Hono } from 'hono'
import type { Handler, MiddlewareHandler } from 'hono'
import { PAIR_PATH, createPairing, isDeviceLabel } from './remote-pair.js'
import type { MadeCode, PairedDevice } from './remote-pair.js'

const LOOPBACK_HOST = '127.0.0.1'
const REMOTE_FILE = 'remote.json'
const REMOTE_SCHEMA = 1
const REMOTE_FILE_MAX = 64 * 1024
const BOUNDARY_HEADER = 'x-agent-inbox-remote-boundary'
const BOUNDARY_VERSION = 'tailnet-v1'
const LOCAL_BOUNDARY_HEADER = 'x-agent-inbox-local-boundary'
// The loopback entry's policy, word for word (src/viewer-network.ts keeps its own copy unexported, and
// does not change for this PR). test/viewer-remote.test.ts compares the two entries' headers, so a
// change to one without the other fails.
const CONTENT_SECURITY_POLICY = [
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const POLL_MS = 5_000

// ── the setting ─────────────────────────────────────────────────────────────

/**
 * Where `remote.json` lives: the folder of an AGENT_INBOX_DB hub, else `~/.agent-inbox`, so a
 * viewer only ever opens the entry for the database it serves. Unlike meshDir it never reads
 * AGENT_INBOX_MESH_DIR. PR 2b's main must name the same file, by this rule or by being told the path.
 */
export function remoteDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const db = env['AGENT_INBOX_DB']
  return db ? dirname(resolve(db)) : join(home, '.agent-inbox')
}

export interface RemoteDevice {
  id: string
  label: string
  /** SHA-256 of the device secret's 43 ASCII characters (remote.json's `secretSha256`, decoded from hex) */
  digest: Buffer
}

export interface RemoteSetting {
  enabled: boolean
  viewerPort: number
  port: number
  host: string
  /** lowercased */
  logins: string[]
  devices: RemoteDevice[]
}

type RemoteRefusal =
  | 'missing' | 'unsupported' | 'unreadable' | 'not-regular' | 'not-owner' | 'open-to-others' | 'too-large'
  | 'not-json' | 'not-object' | 'no-schema' | 'newer-schema' | 'bad-host' | 'bad-logins' | 'bad-port' | 'bad-devices'

export type RemoteRead = { ok: true; setting: RemoteSetting } | { ok: false; reason: RemoteRefusal }

// Fixed words for the status route: never a parser's message, which can quote the file.
const REFUSAL_WORDS: Record<Exclude<RemoteRefusal, 'missing'>, string> = {
  unsupported: 'remote.json cannot be checked on this system',
  unreadable: 'remote.json cannot be read',
  'not-regular': 'remote.json is not a regular file (a symlink, folder or device)',
  'not-owner': 'remote.json is not owned by this user',
  'open-to-others': 'remote.json is open to other users: chmod 600 it',
  'too-large': `remote.json is larger than ${REMOTE_FILE_MAX / 1024} KiB`,
  'not-json': 'remote.json is not valid JSON',
  'not-object': 'remote.json is not a JSON object',
  'no-schema': 'remote.json has no valid "schema"',
  'newer-schema': `remote.json was written by a newer Agent Inbox (schema above ${REMOTE_SCHEMA})`,
  'bad-host': 'remote.json has no valid "host"',
  'bad-logins': 'remote.json needs 1 to 16 valid "logins"',
  'bad-port': 'remote.json needs a "port" from 1024 to 65535, not "viewerPort", and a valid "viewerPort"',
  'bad-devices': 'remote.json\'s "devices" must be a list of at most 16',
}

const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = constants
const HOST_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const DEVICE_ID = /^[0-9a-f]{16}$/
const SHA256_HEX = /^[0-9a-f]{64}$/

const isPort = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535
const chars = (text: string): number => Array.from(text).length
const plainText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && chars(value) >= 1 && chars(value) <= max && !CONTROL.test(value)

function parseDevice(value: unknown): RemoteDevice | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { id, label, secretSha256 } = value as Record<string, unknown>
  if (typeof id !== 'string' || !DEVICE_ID.test(id)) return null
  // the same rule as a pairing request's label (src/remote-pair.ts): a person reads it
  if (!isDeviceLabel(label)) return null
  if (typeof secretSha256 !== 'string' || !SHA256_HEX.test(secretSha256)) return null
  return { id, label, digest: Buffer.from(secretSha256, 'hex') }
}

function parseSetting(value: unknown): RemoteDocumentRead {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'not-object' }
  const doc = value as Record<string, unknown>
  if (!Number.isSafeInteger(doc['schema']) || (doc['schema'] as number) < 1) return { ok: false, reason: 'no-schema' }
  // a newer schema is never read as on: this build cannot know what it would turn on
  if ((doc['schema'] as number) > REMOTE_SCHEMA) return { ok: false, reason: 'newer-schema' }

  const host = typeof doc['host'] === 'string' ? doc['host'].toLowerCase() : ''
  // the last label must hold a letter, so an address such as 127.0.0.1 is never a host
  if (host.length > 253 || !HOST_PATTERN.test(host) || !/[a-z]/.test(host.slice(host.lastIndexOf('.') + 1))) return { ok: false, reason: 'bad-host' }

  const logins = doc['logins']
  if (!Array.isArray(logins) || logins.length < 1 || logins.length > 16 || !logins.every((login) => plainText(login, 254))) {
    return { ok: false, reason: 'bad-logins' }
  }

  // Both ports are required: main (PR 2b) always writes them, so a missing one is a bad file.
  const { port, viewerPort } = doc
  if (!isPort(viewerPort) || !isPort(port) || port < 1024 || port === viewerPort) return { ok: false, reason: 'bad-port' }

  const listed = doc['devices'] === undefined ? [] : doc['devices']
  if (!Array.isArray(listed) || listed.length > 16) return { ok: false, reason: 'bad-devices' }
  // a malformed device is dropped, never turning the rest off. The first entry with an id is the
  // device: a later entry with that id is dropped whatever it holds, so its key never opens the gate
  // (#617, PR 2d review round 2; electron/remote-entry.cjs reads it the same way)
  const devices: RemoteDevice[] = []
  const seen = new Set<string>()
  for (const entry of listed) {
    const id = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>)['id'] : undefined
    const first = typeof id === 'string' && !seen.has(id)
    if (typeof id === 'string') seen.add(id)
    const device = parseDevice(entry)
    if (device && first) devices.push(device)
  }

  return {
    ok: true,
    setting: {
      enabled: doc['enabled'] === true,
      viewerPort,
      port,
      host,
      logins: (logins as string[]).map((login) => login.toLowerCase()),
      devices,
    },
    doc,
  }
}

/** A checked setting and the parsed document it came from, read from the same bytes (pairing writes the document back). */
type RemoteDocumentRead = { ok: true; setting: RemoteSetting; doc: Record<string, unknown> } | { ok: false; reason: RemoteRefusal }

/**
 * Reads `remote.json`: opened without following a symlink, checked on the open descriptor (a
 * regular file this user owns, no group or other bits, at most 64 KiB), read from that
 * descriptor, then a JSON object with `schema: 1` and valid fields. Anything else is off.
 */
export function readRemoteSetting(file: string): RemoteRead {
  const read = readRemoteDocument(file)
  return read.ok ? { ok: true, setting: read.setting } : read
}

function readRemoteDocument(file: string): RemoteDocumentRead {
  const uid = process.getuid?.()
  if (uid === undefined) return { ok: false, reason: 'unsupported' }
  let fd: number
  try {
    fd = openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: false, reason: 'missing' }
    return { ok: false, reason: code === 'ELOOP' ? 'not-regular' : 'unreadable' }
  }
  let bytes: Buffer
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) return { ok: false, reason: 'not-regular' }
    if (stat.uid !== uid) return { ok: false, reason: 'not-owner' }
    if (stat.mode & 0o077) return { ok: false, reason: 'open-to-others' }
    if (stat.size > REMOTE_FILE_MAX) return { ok: false, reason: 'too-large' }
    // read one byte past the limit, so a file that grew after the fstat is still refused
    const buffer = Buffer.alloc(REMOTE_FILE_MAX + 1)
    let total = 0
    for (;;) {
      const read = readSync(fd, buffer, total, buffer.length - total, null)
      if (read === 0) break
      total += read
      if (total === buffer.length) break
    }
    if (total > REMOTE_FILE_MAX) return { ok: false, reason: 'too-large' }
    bytes = buffer.subarray(0, total)
  } catch {
    return { ok: false, reason: 'unreadable' }
  } finally {
    closeSync(fd)
  }
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return { ok: false, reason: 'not-json' }
  }
  return parseSetting(value)
}

/** What changes when the file does: its identity, owner, mode, size and both times, to the nanosecond. */
function fileStamp(file: string): string {
  try {
    const stat = lstatSync(file, { bigint: true })
    return [stat.dev, stat.ino, stat.mode, stat.uid, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
  } catch (error) {
    return `error:${(error as NodeJS.ErrnoException).code ?? 'unknown'}`
  }
}

/**
 * The current setting: one `lstat` per call, and a re-read only when that stat changed, so the gate
 * sees a removed device on the very next request. `version` rises with each re-read.
 */
export function remoteSettingCache(
  file: string,
  read: (file: string) => RemoteRead = readRemoteSetting,
): { current(): RemoteRead; readonly version: number } {
  let stamp: string | undefined
  let value: RemoteRead = { ok: false, reason: 'missing' }
  let version = 0
  return {
    current() {
      const now = fileStamp(file)
      if (now !== stamp) {
        // stamp first: a write between the stat and the read leaves a newer stamp for the next call
        stamp = now
        value = read(file)
        version += 1
      }
      return value
    },
    get version() {
      return version
    },
  }
}

// ── what it serves ──────────────────────────────────────────────────────────

/**
 * The routes a paired device may reach, besides static files (any GET outside `/api/`). The rule,
 * the same for every route: a route is ALLOWED only when the page needs it to show or answer the
 * Inbox. It is REFUSED when it acts on the hub's processes or files, hands out a credential, or
 * belongs to setup or launching, which only make sense at the hub. GET /api/chats (each chat's
 * folder, Copilot's automatic titles), GET /api/mesh/agents (endpoint and fix hints) and
 * GET /api/mesh/agents/runs (a forget command) carry the owner's own hub-side details to the
 * owner's paired device, by decision. test/remote-routes.test.ts classifies every route createViewer
 * registers, so a new route is refused here and fails that test until someone classifies it.
 */
export const REMOTE_ROUTES: ReadonlyArray<{ method: 'GET' | 'POST'; path: string }> = [
  ...[
    '/api/items', '/api/items/history',
    '/api/boards', '/api/boards/archived', '/api/boards/archived/summary', '/api/boards/archived/plans',
    '/api/activity', '/api/activity/history', '/api/version', '/api/links', '/api/issues', '/api/messages',
    '/api/projects/closed', '/api/chats', '/api/mesh/agents', '/api/mesh/agents/runs',
  ].map((path) => ({ method: 'GET' as const, path })),
  ...[
    ...['resolve', 'acknowledge', 'dismiss', 'annotate', 'reply', 'snooze', 'stop-waiting', 'later'].map((action) => `/api/items/:id/${action}`),
    '/api/boards/:id/archive', '/api/boards/:id/unarchive',
    ...['annotate', 'snooze', 'stop-waiting', 'later', 'handled'].map((action) => `/api/boards/:id/rows/:rowId/${action}`),
    '/api/projects/close', '/api/projects/reopen',
    // the owner's accepted risk: a message is a command to an agent that may act without asking (§3.2)
    '/api/sessions/:session/messages', '/api/messages/:id/withdraw',
    // public/app.js posts it whenever an agent tab opens
    '/api/mesh/agents/refresh',
  ].map((path) => ({ method: 'POST' as const, path })),
]

const ROUTE_SEGMENTS = REMOTE_ROUTES.map((route) => ({ method: route.method, segments: route.path.split('/') }))

const isApiPath = (path: string): boolean => path === '/api' || path.startsWith('/api/')

/** Step 9: a GET outside `/api/` (a static file), or a route on REMOTE_ROUTES (`:param` is one non-empty segment). */
export function remoteRouteAllowed(method: string, path: string): boolean {
  if (method === 'GET' && !isApiPath(path)) return true
  const segments = path.split('/')
  return ROUTE_SEGMENTS.some((route) => route.method === method
    && route.segments.length === segments.length
    && route.segments.every((segment, i) => (segment.startsWith(':') ? segments[i] !== '' : segment === segments[i])))
}

// ── the gate ────────────────────────────────────────────────────────────────

export type RemoteReason = 'host' | 'funnel' | 'login' | 'path' | 'origin' | 'device' | 'route' | 'pair'
type RemoteCounts = Record<RemoteReason, number>

/** Every value of one header as received, from the raw header lines (Node joins or drops repeats). */
function headerValues(incoming: IncomingMessage | undefined, name: string): string[] {
  const raw = incoming?.rawHeaders ?? []
  const values: string[] = []
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (raw[i]!.toLowerCase() === name) values.push(raw[i + 1]!)
  }
  return values
}

/** Step 1: `Host`, sent once, lowercased, is the setting's host or host:443. */
function hostMatches(setting: RemoteSetting, incoming: IncomingMessage | undefined): boolean {
  const hosts = headerValues(incoming, 'host')
  const host = hosts.length === 1 ? hosts[0]!.toLowerCase() : undefined
  return host === setting.host || host === `${setting.host}:443`
}

/** Step 3: the login Serve sets, once, one of the allowed logins ignoring case; a comma means a joined repeat. */
function loginMatches(setting: RemoteSetting, incoming: IncomingMessage | undefined): boolean {
  const logins = headerValues(incoming, 'tailscale-user-login')
  const login = logins.length === 1 && !logins[0]!.includes(',') ? logins[0]!.toLowerCase() : undefined
  return login !== undefined && setting.logins.includes(login)
}

const PRINTABLE_ASCII = /^[\x21-\x7e]+$/

/**
 * Step 4. `raw` is the request target exactly as the client sent it (`incoming.url`, which
 * @hono/node-server never rewrites); `routed` is the path Hono routes on (`c.req.path`), which
 * node-server's URL building and Hono's decoding may have normalised. No `%`, `\`, `//` or `#`
 * anywhere in the target, no `.` or `..` segment, the path byte-equal to the routed one, and no
 * trailing `/` on an `/api/` path. An absolute-form target (`http://…`) does not start with `/`.
 */
export function pathFormOk(raw: unknown, routed: string): boolean {
  if (typeof raw !== 'string' || !PRINTABLE_ASCII.test(raw) || raw[0] !== '/') return false
  if (raw.includes('%') || raw.includes('\\') || raw.includes('//') || raw.includes('#')) return false
  const query = raw.indexOf('?')
  const path = query === -1 ? raw : raw.slice(0, query)
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return false
  if (path !== routed) return false
  return !(isApiPath(path) && path.endsWith('/'))
}

const DEVICE_SECRET = /^[A-Za-z0-9_-]{43}$/

/** Step 8: the secret's SHA-256 against every paired device's, all of them, with no early exit. */
function deviceMatches(secret: string, devices: readonly RemoteDevice[]): boolean {
  const digest = crypto.createHash('sha256').update(secret, 'ascii').digest()
  let matched = 0
  for (const device of devices) matched |= crypto.timingSafeEqual(digest, device.digest) ? 1 : 0
  return matched === 1
}

/**
 * The gate, in the design's order (§3.2). `setting` answers the setting that is on for this
 * request's socket, or null; null refuses at step 1. Each refusal is a 403 `Forbidden` with no
 * marker, counted under one reason.
 */
export function remoteGate(opts: {
  setting: (incoming: IncomingMessage | undefined) => RemoteSetting | null
  refused: RemoteCounts
}): MiddlewareHandler<{ Bindings: HttpBindings }> {
  return async (c, next) => {
    const incoming = (c.env as Partial<HttpBindings> | undefined)?.incoming
    const refuse = (reason: RemoteReason) => {
      opts.refused[reason] += 1
      return c.text('Forbidden', 403)
    }
    const setting = opts.setting(incoming)

    // 1. Host, lowercased, is the setting's host or host:443, sent once
    if (!setting || !hostMatches(setting, incoming)) return refuse('host')

    // 2. Serve sets this only on Funnel (public) traffic and strips it from clients: a second lock
    if (headerValues(incoming, 'tailscale-funnel-request').length > 0) return refuse('funnel')

    // 3. the login Serve sets, once, one of the allowed logins ignoring case; a comma means a joined repeat
    if (!loginMatches(setting, incoming)) return refuse('login')

    // 4. the path form, on the raw request target
    if (!pathFormOk(incoming?.url, c.req.path)) return refuse('path')

    // 5. an Origin, when present, is exactly https://<host>
    const origins = headerValues(incoming, 'origin')
    if (origins.length > 1 || (origins.length === 1 && origins[0] !== `https://${setting.host}`)) return refuse('origin')

    // 6. on ANY method, Sec-Fetch-Site, when present, is sent once and is same-origin or none (never
    //    same-site: on a tailnet that is another node's Serve page). Safe methods too: once the laptop
    //    app adds the device header by URL filter, a no-cors GET from another page would carry it.
    //    An unsafe method also needs the Origin.
    const sites = headerValues(incoming, 'sec-fetch-site')
    const site = sites.length === 1 ? sites[0]!.toLowerCase() : sites.length === 0 ? 'none' : 'repeated'
    if (site !== 'same-origin' && site !== 'none') return refuse('origin')
    if (!SAFE_METHODS.has(c.req.method) && origins.length !== 1) return refuse('origin')

    // 7. Pairing, the one route that passes with the login alone: exactly POST and exactly the target
    //    `/api/remote/pair` as received (no query, no trailing slash). It skips steps 8 and 9, so a
    //    device header sent with it is ignored. Anything else falls through to step 8.
    const pairing = c.req.method === 'POST' && incoming?.url === PAIR_PATH

    if (!pairing) {
      // 8. a paired device's secret, sent once
      const secrets = headerValues(incoming, 'x-agent-inbox-device')
      if (secrets.length !== 1 || !DEVICE_SECRET.test(secrets[0]!) || !deviceMatches(secrets[0]!, setting.devices)) {
        return refuse('device')
      }

      // 9. the method (HEAD as GET, as Hono routes it) and the routed path on the allowlist
      if (!remoteRouteAllowed(c.req.method === 'HEAD' ? 'GET' : c.req.method, c.req.path)) return refuse('route')
    }

    await next()
    // a pairing refusal stays the bare 403, with no marker, like every refusal at the gate
    if (pairing && c.res.status !== 200) return
    c.header('Cache-Control', 'no-store')
    c.header('Content-Security-Policy', CONTENT_SECURITY_POLICY)
    c.header('X-Frame-Options', 'DENY')
    c.header(BOUNDARY_HEADER, BOUNDARY_VERSION)
    // never the loopback marker, so a reuse probe can never take this port for a viewer
    c.res.headers.delete(LOCAL_BOUNDARY_HEADER)
  }
}

// ── the listener ────────────────────────────────────────────────────────────

/**
 * The app the listener serves: `gate` first, then `app`'s routes, and an error handler that logs
 * one fixed line naming only the error's class (a store error can quote ids taken from the path)
 * and answers a bare 500.
 */
export function guardRemoteApp(app: Hono, gate: MiddlewareHandler<{ Bindings: HttpBindings }>, pair: Handler): Hono<{ Bindings: HttpBindings }> {
  const guarded = new Hono<{ Bindings: HttpBindings }>()
  // The gate must precede route(), as in src/viewer-network.ts: middleware added after the routes
  // would let Hono match those routes first.
  guarded.use('*', gate)
  // Pairing is served by this guarded app, never by the wrapped one: after the gate, before route().
  // It answers itself, so the wrapped app's middleware never runs for it.
  guarded.post(PAIR_PATH, pair)
  // Hono copies the app's routes at this call: a route added to `app` afterwards is never served.
  guarded.route('/', app as unknown as Hono<{ Bindings: HttpBindings }>)
  // createViewer sets no onError, so this one handles its errors (Hono's default logs the error itself)
  guarded.onError((error, c) => {
    console.error(`agent-inbox remote entry: a request failed (${error.constructor?.name ?? 'Error'})`)
    return c.text('Internal Server Error', 500)
  })
  return guarded
}

export interface RemoteEntryStatus {
  on: boolean
  listening: boolean
  port: number | null
  host: string | null
  error: string | null
  /** a pairing code is waiting to be used */
  codePending: boolean
  /** the devices paired since this viewer started, each with the identity of the code that paired it, the last 16 */
  paired: PairedDevice[]
  refused: RemoteCounts
}

export interface RemoteEntry {
  /** for GET /api/remote-entry on the loopback app: counts since start and paired ids, never a login, header value, secret, hash, label or code */
  status(): RemoteEntryStatus
  /** A new pairing code, voiding any older one, or null while the entry is not on and listening. */
  makeCode(): MadeCode | null
  address(): ReturnType<Server['address']>
  close(): Promise<void>
}

/**
 * Opens the remote entry on 127.0.0.1 at the setting's `port` while `remote.json` is valid,
 * `enabled` is true and its `viewerPort` is this viewer's port, and closes it (every connection
 * too) when that stops being so. Checked on every request and every 5 seconds. A bind failure is
 * logged once and shown in the status; nothing else stops.
 */
export function startRemoteEntry(opts: { app: Hono; dir: string; viewerPort: number; intervalMs?: number; now?: () => number }): RemoteEntry {
  const file = join(opts.dir, REMOTE_FILE)
  const cache = remoteSettingCache(file)
  const refused: RemoteCounts = { host: 0, funnel: 0, login: 0, path: 0, origin: 0, device: 0, route: 0, pair: 0 }
  let server: Server | null = null
  let serverPort: number | null = null
  let listening = false
  let bindError: string | null = null
  let loggedFailure: string | null = null
  let reconciled = -1
  let stopped = false
  let closing: Promise<void> = Promise.resolve()

  const active = (read: RemoteRead): RemoteSetting | null =>
    read.ok && read.setting.enabled && read.setting.viewerPort === opts.viewerPort ? read.setting : null

  const pairing = createPairing<RemoteSetting>({
    file,
    maxBytes: REMOTE_FILE_MAX,
    now: opts.now ?? Date.now,
    read: readRemoteDocument,
    // under the lock: the file as it is now is still on for this viewer, on this request's port, and
    // still names the Host and the login the request passed the gate with
    stillOn: (setting, incoming) => active({ ok: true, setting }) !== null
      && incoming?.socket.localPort === setting.port
      && hostMatches(setting, incoming)
      && loginMatches(setting, incoming),
    refused: () => { refused.pair += 1 },
  })

  // A code is tied to the file it was made under: once the cache re-reads remote.json for any reason
  // (the entry off and on again, a device added or removed, a hand edit), the code is void. Every
  // read of the setting goes through here, and the gate reads it before the pairing handler runs.
  let codeVersion: number | null = null
  function current(): RemoteRead {
    const read = cache.current()
    if (codeVersion !== null && cache.version !== codeVersion) {
      pairing.voidCode()
      codeVersion = null
    }
    return read
  }

  const guarded = guardRemoteApp(opts.app, remoteGate({
    refused,
    setting: (incoming) => {
      const read = current()
      if (cache.version !== reconciled) setImmediate(reconcile)
      const setting = active(read)
      // only on the listener the current setting names: a request still on an old port is refused
      return setting && incoming?.socket.localPort === setting.port ? setting : null
    },
  }), pairing.handler)

  function closeServer(): void {
    const current = server
    if (!current) return
    server = null
    serverPort = null
    const wasListening = listening
    listening = false
    closing = new Promise((resolve) => current.close(() => resolve()))
    // no kept-alive connection outlives the switch
    current.closeAllConnections()
    if (wasListening) console.log('agent-inbox remote entry closed')
  }

  function openServer(port: number): void {
    const created = createAdaptorServer({ fetch: guarded.fetch }) as Server
    server = created
    serverPort = port
    listening = false
    created.on('listening', () => {
      if (server !== created) return
      listening = true
      bindError = null
      loggedFailure = null
      console.log(`agent-inbox remote entry on http://${LOOPBACK_HOST}:${port}`)
    })
    created.on('error', (error: NodeJS.ErrnoException) => {
      if (server !== created) return
      server = null
      serverPort = null
      listening = false
      bindError = `could not listen on ${LOOPBACK_HOST}:${port} (${error.code ?? 'error'})`
      // once per setting and cause, though the next check tries again
      const failure = `${cache.version}:${port}:${error.code}`
      if (loggedFailure !== failure) {
        loggedFailure = failure
        console.error(`agent-inbox remote entry ${bindError}`)
      }
      created.close()
    })
    created.listen(port, LOOPBACK_HOST)
  }

  function reconcile(): void {
    if (stopped) return
    const setting = active(current())
    reconciled = cache.version
    const wanted = setting ? setting.port : null
    if (server && serverPort !== wanted) closeServer()
    if (wanted === null) {
      bindError = null
      // a code made for an entry that is now off never pairs, even if the entry comes back
      pairing.voidCode()
      return
    }
    if (!server) openServer(wanted)
  }

  reconcile()
  const timer = setInterval(reconcile, opts.intervalMs ?? POLL_MS)
  timer.unref()

  return {
    status() {
      const read = current()
      // #617 PR 2d: main reads this right after it writes remote.json, so a changed file opens or
      // closes the listener now, as the gate's own read does, not at the next poll
      if (cache.version !== reconciled) setImmediate(reconcile)
      const setting = read.ok ? read.setting : null
      let error = bindError
      if (!read.ok && read.reason !== 'missing') error = REFUSAL_WORDS[read.reason]
      else if (setting?.enabled && setting.viewerPort !== opts.viewerPort) error = `remote.json is for the viewer on port ${setting.viewerPort}`
      return {
        on: active(read) !== null,
        listening,
        port: setting?.port ?? null,
        host: setting?.host ?? null,
        error,
        codePending: pairing.codePending(),
        paired: pairing.paired(),
        refused: { ...refused },
      }
    },
    makeCode() {
      // only for a listener that is there: on for this viewer, and bound
      const read = current()
      if (cache.version !== reconciled) setImmediate(reconcile)
      const setting = active(read)
      if (setting === null || !listening || serverPort !== setting.port) return null
      const made = pairing.makeCode()
      codeVersion = cache.version
      return made
    },
    address() {
      return listening && server ? server.address() : null
    },
    async close() {
      stopped = true
      clearInterval(timer)
      closeServer()
      await closing
    },
  }
}
