// The mesh.json reading rule for packages/mesh (#483, unslop design §4.2). The
// package cannot import the app's src/mesh-config.ts, so this carries the same
// rule and the shared cases in test/fixtures/mesh-json/ hold both to the same
// verdicts: a regular file (never a symlink) of at most 64 KiB holding a JSON
// object whose `schema` is 1. Anything else is off; a newer schema is never on.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

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
