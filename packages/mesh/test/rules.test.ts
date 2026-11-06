// The unslop rules loader (#483, unslop design §3.1-§3.2).
import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRulesLoader, readRules } from '../src/rules.js'

const made: string[] = []
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function skillDir(rules = '# Rules\n\nNever change facts.\n', skill = '---\nname: unslop\ndescription: x\n---\nbody\n'): string {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-rules-'))
  made.push(dir)
  writeFileSync(join(dir, 'rules.md'), rules)
  writeFileSync(join(dir, 'SKILL.md'), skill)
  return dir
}
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

describe('readRules', () => {
  it('returns rules.md and its SHA-256', () => {
    const dir = skillDir()
    expect(readRules(dir)).toEqual({ text: '# Rules\n\nNever change facts.\n', sha256: sha('# Rules\n\nNever change facts.\n') })
  })

  it('refuses a symlinked file, a folder, a file over 64 KiB, invalid UTF-8 and a SKILL.md that does not name unslop', () => {
    const link = skillDir()
    rmSync(join(link, 'rules.md'))
    symlinkSync(join(skillDir(), 'rules.md'), join(link, 'rules.md'))
    expect(() => readRules(link)).toThrow(/rules\.md is not a regular file/)

    const folder = skillDir()
    rmSync(join(folder, 'rules.md'))
    mkdirSync(join(folder, 'rules.md'))
    expect(() => readRules(folder)).toThrow(/rules\.md is not a regular file/)

    expect(() => readRules(skillDir('x'.repeat(64 * 1024 + 1)))).toThrow(/rules\.md is larger than 65536 bytes/)
    expect(readRules(skillDir('x'.repeat(64 * 1024))).text).toHaveLength(64 * 1024)

    const binary = skillDir()
    writeFileSync(join(binary, 'rules.md'), Buffer.from([0x66, 0xff, 0xfe]))
    expect(() => readRules(binary)).toThrow(/rules\.md is not valid UTF-8/)

    expect(() => readRules(skillDir(undefined, '---\nname: other\n---\n'))).toThrow(/SKILL\.md does not name unslop/)
    expect(() => readRules(skillDir(undefined, 'no frontmatter, name: unslop\n'))).toThrow(/SKILL\.md does not name unslop/)
  })

  it('reads through a symlinked skill folder', () => {
    const dir = skillDir()
    const parent = mkdtempSync(join(tmpdir(), 'mesh-rules-link-'))
    made.push(parent)
    symlinkSync(dir, join(parent, 'unslop'))
    expect(readRules(join(parent, 'unslop')).sha256).toBe(sha('# Rules\n\nNever change facts.\n'))
  })
})

describe('createRulesLoader', () => {
  it('re-reads only when size or mtime change, and the hash follows the edit', () => {
    const dir = skillDir()
    let reads = 0
    const load = createRulesLoader(dir, (d) => { reads++; return readRules(d) })
    const first = load()
    expect(load()).toEqual(first)
    expect(reads).toBe(1)

    writeFileSync(join(dir, 'rules.md'), '# Rules\n\nNever change dates.\n')
    utimesSync(join(dir, 'rules.md'), new Date(2030, 0, 1), new Date(2030, 0, 1))
    const second = load()
    expect(reads).toBe(2)
    expect(second).toEqual({ text: '# Rules\n\nNever change dates.\n', sha256: sha('# Rules\n\nNever change dates.\n'), stale: false })
    expect(second.sha256).not.toBe(first.sha256)
  })

  it('keeps the last good rules and marks them stale when a re-read fails; a failed first read throws', () => {
    const dir = skillDir()
    const load = createRulesLoader(dir)
    const good = load()
    writeFileSync(join(dir, 'rules.md'), 'x'.repeat(64 * 1024 + 1))
    expect(load()).toEqual({ ...good, stale: true })
    writeFileSync(join(dir, 'rules.md'), 'fixed\n')
    expect(load()).toEqual({ text: 'fixed\n', sha256: sha('fixed\n'), stale: false })

    const broken = skillDir(undefined, '---\nname: other\n---\n')
    expect(() => createRulesLoader(broken)()).toThrow(/SKILL\.md does not name unslop/)
  })
})
