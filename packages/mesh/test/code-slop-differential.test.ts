// unslop-code's scanner against the TypeScript compiler (step 1, D5): for every
// JavaScript and TypeScript source file of this repository, the lines commentLines
// calls whole-line comments are exactly the lines the compiler's parser finds holding
// one single-line comment and nothing else; an unsure file is counted and may not pass
// 2 percent. Then a seeded property test removes random whole-line comments and checks
// the program is unchanged and the patch applies with git.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import { afterAll, describe, expect, it } from 'vitest'
import { rng } from '../bench/s11/fixtures.js'
import { commentLines, patchFor, removeLines, sameProgram } from '../src/code-slop.js'

const REPO = join(import.meta.dirname, '..', '..', '..')
const SOURCE = /\.(?:[mc]?[jt]s|[jt]sx)$/
// vendored or generated: not code anyone here writes
const SKIP = /(?:^|\/)(?:node_modules|dist|vendor)\/|\.min\.js$/

function sourceFiles(): string[] {
  const listed = spawnSync('git', ['ls-files', '-z', '--', 'src', 'public', 'electron', 'packages/mesh/src'], { cwd: REPO, encoding: 'utf8' })
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`)
  return listed.stdout.split('\0').filter((f) => SOURCE.test(f) && !SKIP.test(f)).sort()
}

// only .ts, .mts and .cts sources are promised free of JSX
const jsx = (file: string): boolean => !/\.[mc]?ts$/.test(file)
const scriptKind = (file: string): ts.ScriptKind =>
  /\.[mc]?js$/.test(file) ? ts.ScriptKind.JS : /\.jsx$/.test(file) ? ts.ScriptKind.JSX : /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS

/** The 1-based lines that hold one SingleLineCommentTrivia and only whitespace besides, by the compiler's parser. */
function compilerCommentLines(file: string, text: string): Set<number> {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file))
  const ranges = new Map<number, ts.CommentRange>()
  const visit = (node: ts.Node): void => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return
    const children = node.getChildren(source)
    if (!children.length || node.kind === ts.SyntaxKind.EndOfFileToken) {
      // a token: the comments in the trivia before it (after a line break) and after it (on its line)
      for (const r of ts.getLeadingCommentRanges(text, node.pos) ?? []) ranges.set(r.pos, r)
      for (const r of ts.getTrailingCommentRanges(text, node.end) ?? []) ranges.set(r.pos, r)
    }
    for (const child of children) visit(child)
  }
  visit(source)
  const starts = [0]
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  const lines = new Set<number>()
  for (const r of ranges.values()) {
    if (r.kind !== ts.SyntaxKind.SingleLineCommentTrivia) continue
    let line = starts.length
    while (starts[line - 1]! > r.pos) line--
    if (/^[\s﻿]*$/.test(text.slice(starts[line - 1], r.pos))) lines.add(line)
  }
  return lines
}

const files = sourceFiles().map((file) => ({ file, text: readFileSync(join(REPO, file), 'utf8') }))
const dirs: string[] = []
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('code-slop against the TypeScript compiler', () => {
  it('finds exactly the compiler\'s whole-line comments in every source file of the repository', () => {
    expect(files.length).toBeGreaterThan(200)
    const unsure: string[] = []
    let lines = 0
    let compared = 0
    for (const { file, text } of files) {
      const mine = commentLines(text, { jsx: jsx(file) })
      if (mine.unsure) {
        unsure.push(file)
        continue
      }
      const theirs = compilerCommentLines(file, text)
      expect([...mine.whole].sort((a, b) => a - b), file).toEqual([...theirs].sort((a, b) => a - b))
      for (const line of mine.doc) expect(mine.whole.has(line), `${file}:${line}`).toBe(true)
      lines += theirs.size
      compared += 1
    }
    console.log(`code-slop differential: ${files.length} files, ${compared} compared, ${unsure.length} unsure${unsure.length ? ` (${unsure.join(', ')})` : ''}, ${lines} whole-line comment lines`)
    expect(unsure.length / files.length).toBeLessThanOrEqual(0.02)
  }, 600_000)

  it('keeps the program when random whole-line comments go, and the patch applies with git', () => {
    const random = rng(1201)
    const pool = files.map((f) => ({ ...f, whole: [...commentLines(f.text, { jsx: jsx(f.file) }).whole] })).filter((f) => f.whole.length)
    expect(pool.length).toBeGreaterThan(100)
    const dir = mkdtempSync(join(tmpdir(), 'mesh-code-slop-'))
    dirs.push(dir)
    let applied = 0
    for (let k = 0; k < 300; k++) {
      const { file, text, whole } = pool[Math.floor(random() * pool.length)]!
      const chosen = [...new Set(Array.from({ length: 1 + Math.floor(random() * 6) }, () => whole[Math.floor(random() * whole.length)]!))]
      const after = removeLines(text, chosen)
      expect(sameProgram(text, after, { jsx: jsx(file) }), `${file} without ${chosen.join(', ')}`).toBe(true)
      if (k % 50 !== 0) continue
      // git apply in a scratch folder: the patch applies and gives exactly `after`
      const target = join(dir, file)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, text)
      writeFileSync(join(dir, 'change.patch'), patchFor(file, text, after))
      for (const args of [['apply', '--check', 'change.patch'], ['apply', 'change.patch']]) {
        const run = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
        expect(run.status, `${file}: git ${args.join(' ')}: ${run.stderr}`).toBe(0)
      }
      expect(readFileSync(target, 'utf8') === after, file).toBe(true)
      applied += 1
    }
    expect(applied).toBe(6)
  }, 600_000)
})
