import { describe, expect, it } from 'vitest'
import { existsSync, globSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'

// #379: CLAUDE.md and .github/copilot-instructions.md load on every agent request, so
// they stay small and point to docs/architecture/, whose files load only when an agent
// reads or edits a file matching their globs (through the .claude/rules/ and
// .github/instructions/ symlinks). Grow a subsystem doc, not these two files.
const REPO = resolve(import.meta.dirname, '..')
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8')
const lineCount = (text: string) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0)

const ARCH = 'docs/architecture'
const docs = readdirSync(join(REPO, ARCH)).filter((name) => name.endsWith('.md')).sort()

function frontmatter(text: string): { paths: string[]; applyTo: string[] } | null {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!match) return null
  const body = match[1]!
  const paths = [...body.matchAll(/^ {2}- "([^"]+)"$/gm)].map((m) => m[1]!)
  const applyTo = /^applyTo: "([^"]*)"$/m.exec(body)?.[1]?.split(',') ?? []
  return { paths, applyTo }
}

describe('#379 · per-request instruction budget', () => {
  it('keeps CLAUDE.md under 200 lines and 12,000 characters', () => {
    const text = read('CLAUDE.md')
    expect(lineCount(text)).toBeLessThan(200)
    expect(text.length).toBeLessThanOrEqual(12_000)
  })

  it('keeps .github/copilot-instructions.md no larger than CLAUDE.md allows', () => {
    const text = read('.github/copilot-instructions.md')
    expect(lineCount(text)).toBeLessThan(200)
    expect(text.length).toBeLessThanOrEqual(12_000)
  })

  it('names only architecture docs that exist, and names every one of them', () => {
    const claude = read('CLAUDE.md')
    const tableNames = [...claude.matchAll(/\| `([a-z-]+\.md)` \|/g)].map((m) => m[1]!)
    const pointers = [...claude.matchAll(/→ ([a-z-]+(?:, [a-z-]+)*)(?=$|, `)/gm)].flatMap((m) => m[1]!.split(', ')).map((name) => `${name}.md`)
    expect(tableNames.length).toBeGreaterThan(0)
    expect(pointers.length).toBeGreaterThan(0)
    for (const name of [...tableNames, ...pointers]) expect(docs, name).toContain(name)
    for (const doc of docs.filter((name) => name !== 'backlog.md')) expect(tableNames, doc).toContain(doc)
    expect(claude).toContain(`${ARCH}/backlog.md`)
  })

  it('keeps no stray rule or instruction file beside the links', () => {
    for (const [dir, suffix] of [['.claude/rules', '.md'], ['.github/instructions', '.instructions.md']] as const) {
      for (const name of readdirSync(join(REPO, dir))) {
        expect(docs, `${dir}/${name}`).toContain(name.slice(0, -suffix.length) + '.md')
      }
    }
  })

  it('links every scoped architecture doc into both hosts, with matching globs that match files', () => {
    for (const doc of docs) {
      const text = read(`${ARCH}/${doc}`)
      const fm = frontmatter(text)
      const base = doc.replace(/\.md$/, '')
      const links = [`.claude/rules/${base}.md`, `.github/instructions/${base}.instructions.md`]
      if (!fm) {
        for (const link of links) expect(existsSync(join(REPO, link)), link).toBe(false)
        continue
      }
      expect(fm.paths.length, doc).toBeGreaterThan(0)
      expect(fm.applyTo, doc).toEqual(fm.paths)
      for (const pattern of fm.paths) {
        expect(globSync(pattern, { cwd: REPO }).length, `${doc}: ${pattern}`).toBeGreaterThan(0)
      }
      for (const link of links) {
        expect(lstatSync(join(REPO, link)).isSymbolicLink(), link).toBe(true)
        expect(readlinkSync(join(REPO, link)), link).toBe(`../../${ARCH}/${doc}`)
      }
    }
  })
})
