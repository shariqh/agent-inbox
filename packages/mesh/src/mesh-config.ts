// The mesh.json reading rule for packages/mesh (#483, unslop design §4.2). The
// package cannot import the app's src/mesh-config.ts, so this carries the same
// rule and the shared cases in test/fixtures/mesh-json/ hold both to the same
// verdicts: a regular file (never a symlink) of at most 64 KiB holding a JSON
// object whose `schema` is 1. Anything else is off; a newer schema is never on.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { checkBaseUrl } from './backend.js'
import type { KeySource } from './key-source.js'

const MESH_SCHEMA = 1
const MESH_FILE_MAX = 64 * 1024

/** An absolute AGENT_INBOX_MESH_DIR, else the folder of AGENT_INBOX_DB, else ~/.agent-inbox. */
export function meshDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const configured = env['AGENT_INBOX_MESH_DIR']
  if (configured && isAbsolute(configured)) return configured
  const db = env['AGENT_INBOX_DB']
  if (db) return dirname(resolve(db))
  return join(home, '.agent-inbox')
}

export const meshFile = (dir: string): string => join(dir, 'mesh.json')

type Reason = 'not-json' | 'not-object' | 'no-schema' | 'newer-schema' | 'too-large' | 'not-regular' | 'unreadable'
export type MeshRead =
  | { kind: 'missing' }
  | { kind: 'refused'; reason: Reason }
  | { kind: 'present'; doc: { schema: number; [key: string]: unknown } }

export function readMesh(file: string): MeshRead {
  let text: string
  try {
    if (!lstatSync(file).isFile()) return { kind: 'refused', reason: 'not-regular' }
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile()) return { kind: 'refused', reason: 'not-regular' }
      if (stat.size > MESH_FILE_MAX) return { kind: 'refused', reason: 'too-large' }
      text = readFileSync(fd, 'utf8')
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'refused', reason: code === 'ELOOP' ? 'not-regular' : 'unreadable' }
  }
  if (text.length > MESH_FILE_MAX) return { kind: 'refused', reason: 'too-large' }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { kind: 'refused', reason: 'not-json' }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'refused', reason: 'not-object' }
  const schema = (value as { schema?: unknown }).schema
  if (!Number.isSafeInteger(schema) || (schema as number) < 1) return { kind: 'refused', reason: 'no-schema' }
  if ((schema as number) > MESH_SCHEMA) return { kind: 'refused', reason: 'newer-schema' }
  return { kind: 'present', doc: value as { schema: number } }
}

// ── model servers (model servers step 1, D1) ─────────────────────────────────
// `<mesh dir>/mesh/servers.json`, by the rule src/mesh-config.ts's readServers applies (the cases in
// test/fixtures/servers-json/ hold both to the same verdicts): a regular file this user owns with
// no group or other bits, at most 64 KiB, `{ "schema": 1, "servers": { "<name>": { "baseUrl",
// "apiKey"? } or { "kind": "claude-code" } } }` with nothing else, at most 32 servers. Refused whole
// on any broken rule.

const SERVERS_SCHEMA = 1
const SERVERS_FILE_MAX = 64 * 1024
const SERVERS_MAX = 32
export const SERVER_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const PRINTABLE = /^[^\x00-\x1f\x7f]{0,4096}$/

/** A model server: an address with an optional key source, or Claude Code on this Mac (no address, no key). */
export type ServerEntry = { baseUrl: string; apiKey?: KeySource } | { kind: 'claude-code' }
export type ServersReason = 'not-regular' | 'not-private' | 'too-large' | 'unreadable' | 'not-json' | 'not-object' | 'no-schema' | 'newer-schema'
  | 'unknown-key' | 'no-servers' | 'too-many' | 'bad-name' | 'bad-entry' | 'bad-kind' | 'bad-base-url' | 'bad-api-key'

/** Whether `entry` is Claude Code on this Mac: its model calls run the claude program, with no address and no key. */
export const isClaudeServer = (entry: ServerEntry): entry is { kind: 'claude-code' } => 'kind' in entry
export type ServersRead =
  | { kind: 'missing' }
  | { kind: 'refused'; reason: ServersReason }
  | { kind: 'present'; servers: Record<string, ServerEntry> }

const baseUrlOk = (raw: unknown): boolean => {
  if (typeof raw !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(raw)) return false
  try {
    checkBaseUrl(raw)
    return true
  } catch {
    return false
  }
}

function isKeySource(value: unknown): value is KeySource {
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

function parseServers(text: string): ServersRead {
  if (text.length > SERVERS_FILE_MAX) return { kind: 'refused', reason: 'too-large' }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { kind: 'refused', reason: 'not-json' }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'refused', reason: 'not-object' }
  const doc = value as Record<string, unknown>
  const schema = doc['schema']
  if (!Number.isSafeInteger(schema) || (schema as number) < 1) return { kind: 'refused', reason: 'no-schema' }
  if ((schema as number) > SERVERS_SCHEMA) return { kind: 'refused', reason: 'newer-schema' }
  if (Object.keys(doc).some((key) => key !== 'schema' && key !== 'servers')) return { kind: 'refused', reason: 'unknown-key' }
  const list = doc['servers']
  if (!list || typeof list !== 'object' || Array.isArray(list)) return { kind: 'refused', reason: 'no-servers' }
  const entries = Object.entries(list as Record<string, unknown>)
  if (entries.length > SERVERS_MAX) return { kind: 'refused', reason: 'too-many' }
  const servers: Record<string, ServerEntry> = {}
  for (const [name, entry] of entries) {
    if (!SERVER_NAME.test(name)) return { kind: 'refused', reason: 'bad-name' }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { kind: 'refused', reason: 'bad-entry' }
    const e = entry as Record<string, unknown>
    if (Object.keys(e).some((key) => key !== 'baseUrl' && key !== 'apiKey' && key !== 'kind')) return { kind: 'refused', reason: 'unknown-key' }
    if (Object.hasOwn(e, 'kind')) {
      if (e['kind'] !== 'claude-code' || Object.hasOwn(e, 'baseUrl') || Object.hasOwn(e, 'apiKey')) return { kind: 'refused', reason: 'bad-kind' }
      servers[name] = { kind: 'claude-code' }
      continue
    }
    if (!baseUrlOk(e['baseUrl'])) return { kind: 'refused', reason: 'bad-base-url' }
    if (Object.hasOwn(e, 'apiKey') && !isKeySource(e['apiKey'])) return { kind: 'refused', reason: 'bad-api-key' }
    servers[name] = { baseUrl: e['baseUrl'] as string, ...(Object.hasOwn(e, 'apiKey') ? { apiKey: e['apiKey'] as KeySource } : {}) }
  }
  return { kind: 'present', servers }
}

export function readServers(dir: string): ServersRead {
  const file = join(dir, 'mesh', 'servers.json')
  let text: string
  try {
    if (!lstatSync(file).isFile()) return { kind: 'refused', reason: 'not-regular' }
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
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
  return parseServers(text)
}
