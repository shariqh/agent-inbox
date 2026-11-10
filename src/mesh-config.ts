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
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
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

const { O_RDONLY, O_WRONLY, O_CREAT, O_NOFOLLOW, O_NONBLOCK } = constants

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
