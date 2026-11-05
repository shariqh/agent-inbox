// The mesh's root switch, `mesh.json` (Mesh M1, #397; design
// docs/superpowers/specs/2026-10-29-agent-mesh-design.md §2). Node core only:
// `meshctl` reads it and must never open the hub. Since #454 the viewer reads
// nothing here: the Agents view is always on, and the viewer's watch returns
// with the first mesh phase that needs it (M3). Nothing in the stdio MCP
// server's import graph may reach this module.
//
// One rule decides what the file means, for every reader: a regular file (never
// a symlink), at most MESH_FILE_MAX bytes, a JSON object whose `schema` is 1.
// A missing key or file means off. A newer schema is never read as on: this
// build cannot know what it would turn on.
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
