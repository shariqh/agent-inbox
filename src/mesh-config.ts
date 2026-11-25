// The mesh's root switch, `mesh.json` (Mesh M1, #397; design
// docs/superpowers/specs/2026-10-29-agent-mesh-design.md §2). Node core only:
// `meshctl` and its clients (src/unslop-client.ts, src/request-post-client.ts, src/mesh-call.ts) read it and must never
// open the hub. The viewer reads it only through src/mesh-agents.ts, lazily,
// for the agent cards view (the Agents view itself is always on, #454).
// Nothing in the stdio MCP server's import graph may reach this module.
//
// One rule decides what the file means, for every reader: a regular file (never
// a symlink), at most MESH_FILE_MAX bytes, a JSON object whose `schema` is 1.
// A missing key or file means off. A newer schema is never read as on: this
// build cannot know what it would turn on.
import { accessSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const MESH_SCHEMA = 1
export const MESH_FILE_MAX = 64 * 1024

/**
 * Where `mesh.json` lives: an absolute AGENT_INBOX_MESH_DIR, else the folder of
 * an AGENT_INBOX_DB hub (so a scratch hub never reads the real home's switch),
 * else `~/.agent-inbox`.
 */
export function meshDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const configured = env['AGENT_INBOX_MESH_DIR']
  if (configured && isAbsolute(configured)) return configured
  const db = env['AGENT_INBOX_DB']
  if (db) return dirname(resolve(db))
  return join(home, '.agent-inbox')
}

export const meshFile = (dir: string): string => join(dir, 'mesh.json')

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK } = constants

/** A private file meshctl's clients read (a token, a profile): regular (never a symlink), this user's, no group or other bits, at most 64 KiB. */
export function readPrivate(path: string): string {
  const fd = openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()) || stat.mode & 0o077 || stat.size > 64 * 1024) throw new Error('not private')
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

const TOKEN_FILE_MAX = 4096

/** The bearer token in `path` (meshctl's enable, add and check): a regular file the user owns, one run of at least 32 visible ASCII characters. */
export function readTokenFile(path: string, privateOnly = false): { token: string } | { refused: string } {
  let fd: number
  try {
    fd = openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (error) {
    return { refused: (error as NodeJS.ErrnoException).code === 'ELOOP' ? 'the token file is a symlink: pass the file itself' : 'the token file cannot be read' }
  }
  try {
    const stat = fstatSync(fd)
    const uid = process.getuid?.()
    if (!stat.isFile() || (uid !== undefined && stat.uid !== uid)) return { refused: 'the token file is not a regular file you own' }
    if (privateOnly && stat.mode & 0o077) return { refused: 'the token file is open to other users: chmod 600 it' }
    if (stat.size > TOKEN_FILE_MAX) return { refused: `the token file is larger than ${TOKEN_FILE_MAX} bytes` }
    const token = readFileSync(fd, 'utf8').replace(/\r?\n$/, '')
    return /^[\x21-\x7e]{32,}$/.test(token) ? { token } : { refused: 'the token file must hold one token of at least 32 printable characters, no spaces' }
  } finally {
    closeSync(fd)
  }
}

/** A file a client writes (a report, a log), opened `O_NOFOLLOW` and made 0600; `flags` adds `O_TRUNC` or `O_APPEND`. */
export function openPrivate(path: string, flags: number): number {
  const fd = openSync(path, flags | O_WRONLY | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600)
  if (!fstatSync(fd).isFile()) {
    closeSync(fd)
    throw new Error('not a regular file')
  }
  fchmodSync(fd, 0o600)
  return fd
}

// ── the card copies of added agents (Agent cards step 1, D6) ─────────────────
// `meshctl add --apply` (and `--move`) keeps the card it accepted as `<mesh dir>/mesh/cards/<id>.json`
// (0600 in a 0700 folder), so the viewer can show an added agent's card without ever contacting
// it. Both sides use one rule: a folder that is no symlink and is this user's, a regular file read
// and written through O_NOFOLLOW that no one else can read, at most the card fetch's 64 KiB.

/** A card copy's cap: the card fetch's own. */
export const CARD_COPY_MAX = 64 * 1024
export const cardCopyFile = (dir: string, id: string): string => join(dir, 'mesh', 'cards', `${id}.json`)
const mine = (s: { uid: number }): boolean => !process.getuid || s.uid === process.getuid()
const cardsFolder = (dir: string): string | undefined => {
  const cards = join(dir, 'mesh', 'cards')
  try {
    const s = lstatSync(cards)
    return s.isDirectory() && mine(s) && !(s.mode & 0o077) ? cards : undefined
  } catch {
    return undefined
  }
}

/** An added agent's card copy: the card, `missing` with no file, or `refused` when a rule above fails. */
export function readCardCopy(dir: string, id: string): { card: Record<string, unknown> } | 'missing' | 'refused' {
  if (!cardsFolder(dir)) return lstatOk(join(dir, 'mesh', 'cards')) ? 'refused' : 'missing'
  let fd: number
  try {
    fd = openSync(cardCopyFile(dir, id), O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'refused'
  }
  try {
    const s = fstatSync(fd)
    if (!s.isFile() || !mine(s) || s.mode & 0o077 || s.size > CARD_COPY_MAX) return 'refused'
    // one bounded read from the checked descriptor, so a file that grows after fstat is still refused
    const buf = Buffer.alloc(CARD_COPY_MAX + 1)
    const size = readSync(fd, buf, 0, buf.length, 0)
    if (size > CARD_COPY_MAX) return 'refused'
    const card: unknown = JSON.parse(buf.toString('utf8', 0, size))
    return card && typeof card === 'object' && !Array.isArray(card) ? { card: card as Record<string, unknown> } : 'refused'
  } catch {
    return 'refused'
  } finally {
    closeSync(fd)
  }
}
const lstatOk = (path: string): boolean => { try { lstatSync(path); return true } catch { return false } }
/** True when `<mesh dir>/mesh/cards` exists but breaks the folder rule (a symlink, another user's or open to others). */
export const cardsFolderRefused = (dir: string): boolean => !cardsFolder(dir) && lstatOk(join(dir, 'mesh', 'cards'))

/**
 * Writes an added agent's card copy as received, through a temporary file and a rename; refuses
 * (throws) a card over the cap and a cards folder that is a symlink, another user's or open to others.
 */
export function writeCardCopy(dir: string, id: string, card: unknown): void {
  const text = JSON.stringify(card)
  if (Buffer.byteLength(text) > CARD_COPY_MAX) throw new Error('card copy too large')
  mkdirSync(join(dir, 'mesh', 'cards'), { recursive: true, mode: 0o700 })
  if (!cardsFolder(dir)) throw new Error('cards folder refused')
  const path = cardCopyFile(dir, id)
  const temp = `${path}.tmp-${process.pid}`
  const fd = openSync(temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
  try {
    try {
      fchmodSync(fd, 0o600)
      writeSync(fd, text)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, path)
  } catch (error) {
    // the temporary file is ours (O_EXCL): none stays behind when the write, the sync or the rename fails
    try { unlinkSync(temp) } catch { /* already gone */ }
    throw error
  }
}

/** Deletes an added agent's card copy, then the cards folder when that leaves it empty. */
export function removeCardCopy(dir: string, id: string): void {
  try { unlinkSync(cardCopyFile(dir, id)) } catch { /* none */ }
  try { rmdirSync(join(dir, 'mesh', 'cards')) } catch { /* not empty, or not there */ }
}

export type MeshDocument = { schema: number; [key: string]: unknown }

export type MeshParse =
  | { ok: true; doc: MeshDocument }
  | { ok: false; reason: 'not-json' | 'not-object' | 'no-schema' | 'newer-schema' | 'too-large' }

export function parseMesh(text: string): MeshParse {
  if (text.length > MESH_FILE_MAX) return { ok: false, reason: 'too-large' }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'not-json' }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'not-object' }
  const schema = (value as { schema?: unknown }).schema
  if (!Number.isSafeInteger(schema) || (schema as number) < 1) return { ok: false, reason: 'no-schema' }
  if ((schema as number) > MESH_SCHEMA) return { ok: false, reason: 'newer-schema' }
  return { ok: true, doc: value as MeshDocument }
}

// Fixed words for each refusal: never a parser's message, which can quote the file.
export const MESH_REASONS: Record<Exclude<MeshParse, { ok: true }>['reason'] | 'not-regular' | 'unreadable', string> = {
  'not-json': 'is not valid JSON',
  'not-object': 'is not a JSON object',
  'no-schema': 'has no valid "schema"',
  'newer-schema': `was written by a newer Agent Inbox (schema above ${MESH_SCHEMA})`,
  'too-large': `is larger than ${MESH_FILE_MAX} bytes`,
  'not-regular': 'is not a regular file (a symlink, folder or device)',
  unreadable: 'cannot be read',
}

export type MeshRead =
  | { kind: 'missing' }
  | { kind: 'refused'; reason: string }
  | { kind: 'present'; doc: MeshDocument }

/** Reads `mesh.json` by the one rule: meshctl to change it, `meshctl unslop` to find its agent. */
export function readMesh(file: string): MeshRead {
  let stat
  try {
    stat = lstatSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'refused', reason: MESH_REASONS.unreadable }
  }
  if (!stat.isFile()) return { kind: 'refused', reason: MESH_REASONS['not-regular'] }
  if (stat.size > MESH_FILE_MAX) return { kind: 'refused', reason: MESH_REASONS['too-large'] }
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { kind: 'refused', reason: MESH_REASONS.unreadable }
  }
  const parsed = parseMesh(text)
  return parsed.ok ? { kind: 'present', doc: parsed.doc } : { kind: 'refused', reason: MESH_REASONS[parsed.reason] }
}

// ── model servers (model servers step 1, D1) ─────────────────────────────────
// `<mesh dir>/mesh/servers.json` names each model server once: its address and its key SOURCE
// (`{ file }`, `{ command }` or `{ env }`, never a key). A local agent's profile names a server
// instead of holding `baseUrl` and `apiKey` itself. packages/mesh/src/mesh-config.ts reads the file
// by this same rule; the cases in test/fixtures/servers-json/ hold both to the same verdicts.
// A file that breaks any rule is refused whole, with a reason that names the rule and never a value.

export const SERVERS_SCHEMA = 1
const SERVERS_FILE_MAX = 64 * 1024
export const SERVERS_MAX = 32
export const SERVER_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/
/** A model name, as `enable --model` takes it and `server check` lists it. */
export const MODEL_NAME = /^[A-Za-z0-9._:/-]{1,64}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const PRINTABLE = /^[^\x00-\x1f\x7f]{0,4096}$/
export const serversFile = (dir: string): string => join(dir, 'mesh', 'servers.json')

export type KeySource = { file: string } | { command: string[] } | { env: string }
/** A model server: an address with an optional key source, or Claude Code on this Mac (no address, no key). */
export type ServerEntry = { baseUrl: string; apiKey?: KeySource } | { kind: 'claude-code' }
export type ServersReason = 'not-regular' | 'not-private' | 'too-large' | 'unreadable' | 'not-json' | 'not-object' | 'no-schema' | 'newer-schema'
  | 'unknown-key' | 'no-servers' | 'too-many' | 'bad-name' | 'bad-entry' | 'bad-kind' | 'bad-base-url' | 'bad-api-key'
export type ServersRead =
  | { kind: 'missing' }
  | { kind: 'refused'; reason: ServersReason }
  | { kind: 'present'; servers: Record<string, ServerEntry> }

// fixed words for each refusal: never a value from the file
export const SERVERS_REASONS: Record<ServersReason, string> = {
  'not-regular': 'is not a regular file (a symlink, folder or device)',
  'not-private': 'is not a file you own that only you can read (chmod 600 it)',
  'too-large': `is larger than ${SERVERS_FILE_MAX} bytes`,
  unreadable: 'cannot be read',
  'not-json': 'is not valid JSON',
  'not-object': 'is not a JSON object',
  'no-schema': 'has no valid "schema"',
  'newer-schema': `was written by a newer Agent Inbox (schema above ${SERVERS_SCHEMA})`,
  'unknown-key': 'holds a key this build does not know (the file holds only schema and servers, a server only baseUrl and apiKey, or kind)',
  'no-servers': 'has no "servers" object',
  'too-many': `holds more than ${SERVERS_MAX} servers`,
  'bad-name': 'holds a server name that is not 1 to 40 lower-case letters, digits or "-" (starting with a letter or digit)',
  'bad-entry': 'holds a server that is not an object',
  'bad-kind': 'holds a kind this build does not know, or a kind beside baseUrl or apiKey',
  'bad-base-url': 'holds a baseUrl that is not https://, or http:// on a loopback address, without credentials, a query or a fragment',
  'bad-api-key': 'holds an apiKey that is not { "file": "/absolute/path" }, { "command": ["/absolute/path", "arg"] } or { "env": "NAME" }',
}

/**
 * Why `raw` is not a model server's base URL, in fixed words, or undefined when it is one. The
 * same rule as packages/mesh's checkBaseUrl, plus one: printable ASCII only, at most 2048 bytes.
 */
export function baseUrlRefusal(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(raw)) return 'the address must be one URL of at most 2048 printable characters, without spaces'
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'the address is not a URL'
  }
  const loopback = /^127(?:\.\d{1,3}){3}$/.test(url.hostname) || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return 'the address must be https://, or http:// on a loopback address'
  if (url.username || url.password || url.search || url.hash) return 'the address must not carry credentials, a query or a fragment'
  if (/\/\/|\\/.test(url.pathname) || raw.includes('\\')) return 'the address path must not contain // or a backslash'
  const out = new URL(url.href)
  out.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/chat/completions`
  return out.origin === url.origin ? undefined : 'the address changed origin'
}

/** Whether `value` is a key source by shape: exactly one of file, command or env. It is never read here. */
export function isKeySource(value: unknown): value is KeySource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (keys.length !== 1) return false
  const v = (value as Record<string, unknown>)[keys[0]!]
  if (keys[0] === 'file') return typeof v === 'string' && PRINTABLE.test(v) && (v.startsWith('/') || v.startsWith('~/'))
  if (keys[0] === 'env') return typeof v === 'string' && ENV_NAME.test(v)
  if (keys[0] === 'command') {
    return Array.isArray(v) && v.length >= 1 && v.length <= 64 && v.every((s) => typeof s === 'string' && PRINTABLE.test(s)) && (v[0] as string).startsWith('/')
  }
  return false
}

/** Whether `entry` is Claude Code on this Mac: its model calls run the claude program, with no address and no key. */
export const isClaudeServer = (entry: ServerEntry): entry is { kind: 'claude-code' } => 'kind' in entry

/** The kind of a server's key source, the only thing about it meshctl prints. */
export const keyKind = (entry: ServerEntry): 'file' | 'command' | 'env' | 'none' =>
  isClaudeServer(entry) || entry.apiKey === undefined ? 'none' : 'file' in entry.apiKey ? 'file' : 'command' in entry.apiKey ? 'command' : 'env'

/** The servers in `text` by the one rule, or the first rule it breaks. */
export function parseServers(text: string): { ok: true; servers: Record<string, ServerEntry> } | { ok: false; reason: ServersReason } {
  if (text.length > SERVERS_FILE_MAX) return { ok: false, reason: 'too-large' }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'not-json' }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'not-object' }
  const doc = value as Record<string, unknown>
  const schema = doc['schema']
  if (!Number.isSafeInteger(schema) || (schema as number) < 1) return { ok: false, reason: 'no-schema' }
  if ((schema as number) > SERVERS_SCHEMA) return { ok: false, reason: 'newer-schema' }
  if (Object.keys(doc).some((key) => key !== 'schema' && key !== 'servers')) return { ok: false, reason: 'unknown-key' }
  const list = doc['servers']
  if (!list || typeof list !== 'object' || Array.isArray(list)) return { ok: false, reason: 'no-servers' }
  const entries = Object.entries(list as Record<string, unknown>)
  if (entries.length > SERVERS_MAX) return { ok: false, reason: 'too-many' }
  const servers: Record<string, ServerEntry> = {}
  for (const [name, entry] of entries) {
    if (!SERVER_NAME.test(name)) return { ok: false, reason: 'bad-name' }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, reason: 'bad-entry' }
    const e = entry as Record<string, unknown>
    if (Object.keys(e).some((key) => key !== 'baseUrl' && key !== 'apiKey' && key !== 'kind')) return { ok: false, reason: 'unknown-key' }
    if (Object.hasOwn(e, 'kind')) {
      if (e['kind'] !== 'claude-code' || Object.hasOwn(e, 'baseUrl') || Object.hasOwn(e, 'apiKey')) return { ok: false, reason: 'bad-kind' }
      servers[name] = { kind: 'claude-code' }
      continue
    }
    if (baseUrlRefusal(e['baseUrl'])) return { ok: false, reason: 'bad-base-url' }
    if (Object.hasOwn(e, 'apiKey') && !isKeySource(e['apiKey'])) return { ok: false, reason: 'bad-api-key' }
    servers[name] = { baseUrl: e['baseUrl'] as string, ...(Object.hasOwn(e, 'apiKey') ? { apiKey: e['apiKey'] as KeySource } : {}) }
  }
  return { ok: true, servers }
}

/** Reads `servers.json` by the one rule: a regular file you own that only you can read, at most 64 KiB. */
export function readServers(dir: string): ServersRead {
  const file = serversFile(dir)
  let text: string
  try {
    if (!lstatSync(file).isFile()) return { kind: 'refused', reason: 'not-regular' }
    const fd = openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile()) return { kind: 'refused', reason: 'not-regular' }
      if ((process.getuid && stat.uid !== process.getuid()) || stat.mode & 0o077) return { kind: 'refused', reason: 'not-private' }
      if (stat.size > SERVERS_FILE_MAX) return { kind: 'refused', reason: 'too-large' }
      text = readFileSync(fd, 'utf8')
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'refused', reason: code === 'ELOOP' ? 'not-regular' : 'unreadable' }
  }
  const parsed = parseServers(text)
  return parsed.ok ? { kind: 'present', servers: parsed.servers } : { kind: 'refused', reason: parsed.reason }
}

/** The text meshctl writes: schema 1 and the servers, in the order given. */
export const serversText = (servers: Record<string, ServerEntry>): string => `${JSON.stringify({ schema: SERVERS_SCHEMA, servers }, null, 2)}\n`

/** The places findClaude looks after PATH that are not in home: a test passes [] for them. */
const CLAUDE_SYSTEM_PATHS = ['/opt/homebrew/bin/claude', '/usr/local/bin/claude']

/**
 * The claude program (Claude Code as a model server, D4): the first candidate that is a regular
 * file the user may execute, among `<dir>/claude` for each absolute folder on `env.PATH`, then
 * `fixed`, then `~/.local/bin`, `~/.claude/local` and `~/.npm-global/bin`. Its real path is
 * returned (the usual install is a link) when it is owned by this user or root and neither group
 * nor others may write it; the first candidate found decides, so an untrusted one gives undefined
 * rather than a later one. The path is never printed, logged or put in any output.
 */
export function findClaude(env: NodeJS.ProcessEnv, home: string, fixed: readonly string[] = CLAUDE_SYSTEM_PATHS): string | undefined {
  const fromPath = (env['PATH'] ?? '').split(':').filter((dir) => dir && isAbsolute(dir)).map((dir) => join(dir, 'claude'))
  const inHome = ['.local/bin/claude', '.claude/local/claude', '.npm-global/bin/claude'].map((rel) => join(home, rel))
  for (const candidate of [...fromPath, ...fixed, ...inHome]) {
    let real: string
    try {
      accessSync(candidate, constants.X_OK)
      real = realpathSync(candidate)
      if (!statSync(real).isFile()) continue
    } catch {
      continue
    }
    try {
      const info = statSync(real)
      const uid = process.getuid?.() ?? -1
      return (info.uid === uid || info.uid === 0) && (info.mode & 0o022) === 0 ? real : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

/** The port of an `agents.unslop.endpoint`: only http://127.0.0.1:<port>, never port 80 (clients drop `:80` from Host). */
export function loopbackPort(endpoint: unknown): number | undefined {
  // never String() a hand-edited object: one whose toString is not callable throws
  if (typeof endpoint !== 'string') return undefined
  const port = Number(/^http:\/\/127\.0\.0\.1:(\d{1,5})\/?$/.exec(endpoint)?.[1])
  return port >= 1 && port <= 65535 && port !== 80 ? port : undefined
}

/**
 * The mesh design's §8.8 allowlist (#556, #557): whether `host`, a `<name>.<tailnet>.ts.net` name,
 * is in this Mac's tailnet, `suffix` (its MagicDNS suffix, `<tailnet>.ts.net`; undefined when it
 * cannot be read). Another tailnet's name or a public Funnel host is not. Nothing here spawns:
 * meshctl reads the suffix from `tailscale status --json` and passes it in.
 */
export function inTailnet(host: string, suffix: string | undefined): boolean {
  return suffix !== undefined && host.slice(host.indexOf('.') + 1) === suffix
}

/**
 * An `agents.request-post.endpoint` (request-post design §6), written the one way a client
 * sends as `Host`: `https://<name>.<tailnet>.ts.net[:<port>]` (lower-case labels), or, for
 * the SSH fallback, `http://127.0.0.1:<port>`. No path, user, query, leading zero or
 * written-out default port (443, 80); one trailing `/` is dropped. Anything else is off. Which
 * tailnet is allowed is inTailnet's question (meshctl's enable and the client ask it).
 */
export function requestPostEndpoint(endpoint: unknown): string | undefined {
  if (typeof endpoint !== 'string') return undefined
  const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
  const text = endpoint
  const tailnet = new RegExp(`^(https://(?:${label}\\.){2}ts\\.net)(?::([1-9]\\d{0,4}))?/?$`).exec(text)
  const loopback = /^(http:\/\/127\.0\.0\.1):([1-9]\d{0,4})\/?$/.exec(text)
  const match = tailnet ?? loopback
  if (!match) return undefined
  const port = match[2] === undefined ? undefined : Number(match[2])
  if (port !== undefined && (port > 65535 || port === (tailnet ? 443 : 80))) return undefined
  return port === undefined ? match[1] : `${match[1]}:${port}`
}
