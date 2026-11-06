// unslop's rules for the agent (#483, unslop design §3.1-§3.2). The skill folder
// holds SKILL.md (frontmatter that must name unslop) and rules.md (the prompt).
// Each must be a regular file owned by this user (a symlinked folder is fine),
// at most 64 KiB of valid UTF-8. The version is rules.md's SHA-256. The loader
// re-reads when either file's size or mtime changes; a failed re-read keeps the
// last good rules and marks them stale, and a failed first read throws.
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const RULES_MAX = 64 * 1024

export type Rules = { text: string; sha256: string }

function readSkillFile(dir: string, name: string): { text: string; bytes: Buffer } {
  let fd: number
  try {
    fd = openSync(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    throw new Error((error as NodeJS.ErrnoException).code === 'ELOOP' ? `${name} is not a regular file` : `${name} cannot be read`)
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Error(`${name} is not a regular file`)
    if (process.getuid && stat.uid !== process.getuid()) throw new Error(`${name} is not owned by this user`)
    const bytes = stat.size > RULES_MAX ? Buffer.alloc(0) : readFileSync(fd)
    if (stat.size > RULES_MAX || bytes.length > RULES_MAX) throw new Error(`${name} is larger than ${RULES_MAX} bytes`)
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), bytes }
    } catch {
      throw new Error(`${name} is not valid UTF-8`)
    }
  } finally {
    closeSync(fd)
  }
}

export function readRules(dir: string): Rules {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readSkillFile(dir, 'SKILL.md').text)?.[1] ?? ''
  if (!/^name:\s*["']?unslop["']?\s*$/m.test(front)) throw new Error('SKILL.md does not name unslop')
  const { text, bytes } = readSkillFile(dir, 'rules.md')
  return { text, sha256: createHash('sha256').update(bytes).digest('hex') }
}

function statKey(dir: string): string | undefined {
  try {
    return ['SKILL.md', 'rules.md'].map((name) => {
      const s = lstatSync(join(dir, name))
      return `${s.ino}:${s.size}:${s.mtimeMs}`
    }).join('|')
  } catch {
    return undefined
  }
}

export function createRulesLoader(dir: string, read: (dir: string) => Rules = readRules): () => Rules & { stale: boolean } {
  let last: { key: string | undefined; rules: Rules } | undefined
  return () => {
    const key = statKey(dir)
    if (last && key !== undefined && key === last.key) return { ...last.rules, stale: false }
    try {
      last = { key, rules: read(dir) }
      return { ...last.rules, stale: false }
    } catch (error) {
      if (!last) throw error
      last.key = undefined
      return { ...last.rules, stale: true }
    }
  }
}
