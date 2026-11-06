// The agent's private files (#483, unslop design §4.2): the profile, the token,
// the deny list, the daily budget and the logs. Each is read only when it is a
// regular file (never a symlink) owned by this user with no group or other
// permission bits, and written 0600 through O_NOFOLLOW. Errors name the path and
// the reason, never the content.
import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

const FILE_MAX = 64 * 1024

/** An error this package raised with a fixed message: safe to print. Anything else prints as "internal error". */
export class ConfigError extends Error {}
const { O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC, O_APPEND, O_NOFOLLOW, O_NONBLOCK } = constants

export function readPrivate(path: string, optional: true): string | undefined
export function readPrivate(path: string, optional?: false): string
export function readPrivate(path: string, optional = false): string | undefined {
  let fd: number
  try {
    fd = openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (optional && code === 'ENOENT') return undefined
    throw new ConfigError(`${path} ${code === 'ELOOP' ? 'is a symlink' : code === 'ENOENT' ? 'is missing' : 'cannot be read'}`)
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new ConfigError(`${path} is not a regular file`)
    if (process.getuid && stat.uid !== process.getuid()) throw new ConfigError(`${path} is not owned by this user`)
    if (stat.mode & 0o077) throw new ConfigError(`${path} must be mode 0600`)
    if (stat.size > FILE_MAX) throw new ConfigError(`${path} is larger than ${FILE_MAX} bytes`)
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

function writeFd(path: string, flags: number, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const fd = openSync(path, flags | O_WRONLY | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600)
  try {
    if (!fstatSync(fd).isFile()) throw new ConfigError(`${path} is not a regular file`)
    fchmodSync(fd, 0o600)
    writeSync(fd, text)
  } finally {
    closeSync(fd)
  }
}

/** Write through a temporary file and an atomic rename. */
export function writePrivate(path: string, text: string): void {
  const temp = `${path}.tmp-${process.pid}`
  writeFd(temp, O_TRUNC, text)
  renameSync(temp, path)
}

export const appendPrivate = (path: string, line: string): void => writeFd(path, O_APPEND, `${line}\n`)

/** YYYY-MM-DD in local time. */
export function localDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
