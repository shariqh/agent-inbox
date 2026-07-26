// test/no-raw-control-bytes.test.ts
// The rule this guard exists to enforce:
//
//   NO source file may contain a raw control BYTE. Tab, newline and carriage
//   return are the only ones allowed. A control character a string needs at
//   RUNTIME must be written as an ESCAPE SEQUENCE (\u0000), never as the byte.
//
// Why a guard and not just a fix: this is the one defect class that code review
// structurally cannot catch. public/source.js shipped a raw U+0000 as the
// `repo|branch` separator in linkKey(). One NUL byte inside the first 8000 makes
// git classify the WHOLE file as binary, and from then on:
//
//   * `git diff` renders "Bin 0 -> 9456 bytes" — 0 insertions, 0 deletions;
//   * `git blame`, `git log -p`, and every review tool are blind to every line;
//   * the file sits in public/, which Electron lifts and drops verbatim.
//
// 9456 bytes of security-critical URL-scheme code (safeHttpUrl, the only defence
// against a `javascript:` href) went through review as an opaque blob.
//
// src/prstate.ts had the identical separator with its NUL at byte 8344 — 344
// bytes past git's sniff window, so it happened to still render as text. That is
// not a difference in kind, it is luck: adding a paragraph above line 193 flips
// it to binary too. Both are fixed; this guard is what stops the third one.
//
// The escape sequence is byte-identical at runtime — `${repo}\u0000${branch}` is
// the same 17-character string — so there is never a reason to write the byte.
//
// Deliberately a plain byte scan in the repo's own idiom (cf. dead-exports.test.ts),
// not a new dev dependency: this repo has no linter at all.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, extname } from 'node:path'

const REPO = new URL('..', import.meta.url).pathname

// The trees that are source rather than assets. public/ is the one that matters
// most — Electron ships it verbatim — but a raw byte is a review blind spot
// wherever it lands, so the net is cast over everything hand-written.
const TREES = ['public', 'src', 'test', 'electron', 'scripts', 'docs']

// Extension allowlist rather than a binary denylist: a PNG added tomorrow must
// not be able to fail this test, and a .js added tomorrow must not be able to
// escape it.
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.css', '.html',
  '.json', '.md', '.sh', '.yml', '.yaml',
])

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git'])

const TAB = 0x09
const LF = 0x0a
const CR = 0x0d
const DEL = 0x7f

// Tab, newline and carriage return are the only control bytes a text file may hold.
function isForbidden(byte: number): boolean {
  if (byte === TAB || byte === LF || byte === CR) return false
  return byte < 0x20 || byte === DEL
}

function textFilesUnder(dir: string, out: string[] = []): string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out // an optional tree that does not exist in this checkout
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) textFilesUnder(join(dir, e.name), out)
    } else if (e.isFile() && TEXT_EXT.has(extname(e.name))) {
      out.push(join(dir, e.name))
    }
  }
  return out
}

type Hit = { file: string; line: number; column: number; byte: number }

// Reported with line/column and the codepoint spelled out, because the whole
// problem with these bytes is that a failure message showing the raw character
// would be as invisible as the defect.
function scan(file: string): Hit[] {
  const buf = readFileSync(file)
  const hits: Hit[] = []
  let line = 1
  let column = 1
  for (const byte of buf) {
    if (isForbidden(byte)) hits.push({ file: relative(REPO, file), line, column, byte })
    if (byte === LF) {
      line += 1
      column = 1
    } else {
      column += 1
    }
  }
  return hits
}

const describeHits = (hits: Hit[]): string =>
  hits
    .map(
      (h) =>
        `${h.file}:${h.line}:${h.column} contains a raw U+${h.byte.toString(16).toUpperCase().padStart(4, '0')} byte` +
        ` — write it as the escape sequence \\u${h.byte.toString(16).toUpperCase().padStart(4, '0')} instead`,
    )
    .join('\n')

describe('no source file contains a raw control byte', () => {
  // The narrow, load-bearing case, asserted on its own so a failure names the
  // actual consequence: public/ is what Electron ships and what review reads.
  it('public/ contains no raw NUL byte — one is all it takes to make a file binary to git', () => {
    const hits = textFilesUnder(join(REPO, 'public'))
      .flatMap(scan)
      .filter((h) => h.byte === 0x00)
    expect(hits.length, `\n${describeHits(hits)}\n`).toBe(0)
  })

  // And the general rule, so the next one is not merely a differently-numbered
  // codepoint in a different tree. public/source.js also carried a raw U+0001,
  // inside a COMMENT explaining scheme-smuggling — an invisible character in the
  // prose describing invisible characters.
  it.each(TREES)('%s/ contains no raw control byte other than tab, newline or CR', (tree) => {
    const hits = textFilesUnder(join(REPO, tree)).flatMap(scan)
    expect(hits.length, `\n${describeHits(hits)}\n`).toBe(0)
  })

  // Proves the guard discriminates: it must FAIL on a file that has the byte.
  // Without this, a scan that silently matched nothing (a broken walk, a bad
  // extension set) would pass forever and guard nothing.
  it('the scanner actually detects a raw control byte when one is present', () => {
    const nul = String.fromCharCode(0)
    const soh = String.fromCharCode(1)
    const probe = join(REPO, 'test', 'no-raw-control-bytes.test.ts')

    // sanity: the real file is clean...
    expect(scan(probe)).toEqual([])

    // ...and the same byte-level predicate flags the bytes we just removed.
    const bytes = Buffer.from(`a${nul}b${soh}\n\tc`)
    const flagged = [...bytes].filter(isForbidden)
    expect(flagged).toEqual([0x00, 0x01])
    expect(isForbidden(TAB)).toBe(false)
    expect(isForbidden(LF)).toBe(false)
    expect(isForbidden(CR)).toBe(false)
  })

  // The walk must actually be reaching files. A guard over an empty list is a
  // guard over nothing.
  it('the scan reaches the files it claims to cover', () => {
    const found = textFilesUnder(join(REPO, 'public')).map((f) => relative(REPO, f))
    expect(found).toContain('public/source.js')
    expect(found).toContain('public/app.js')
    expect(textFilesUnder(join(REPO, 'src')).length).toBeGreaterThan(5)
  })
})

// The other half: the escape sequence has to still MEAN U+0000, or the "fix"
// would have quietly changed the separator to something a branch name can contain.
describe('the repo|branch separator survived the escape as a real U+0000', () => {
  it('public/source.js and src/prstate.ts both spell it \\u0000', () => {
    const read = (p: string) => readFileSync(join(REPO, p), 'utf8')
    expect(read('public/source.js')).toContain('${repo}\\u0000${branch}')
    expect(read('src/prstate.ts')).toContain('${repo}\\u0000${branch}')
  })

  it('and the string it builds still holds the NUL codepoint', async () => {
    const { linkKey } = await import('../public/source.js')
    const key = linkKey('owner/repo', 'feat/x')
    expect([...key].map((c) => c.codePointAt(0))).toContain(0)
    expect(key).toBe(`owner/repo${String.fromCharCode(0)}feat/x`)
  })
})
