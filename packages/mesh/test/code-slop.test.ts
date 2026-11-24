// unslop-code's guards (step 1, D1-D5): every exported function of src/code-slop.ts.
// The scanner is also held against the TypeScript compiler on the whole repository
// in code-slop-differential.test.ts.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { commentLines, decide, numbered, parsePoints, parseSuggestions, patchFor, removeLines, sameProgram, suggestionsFor } from '../src/code-slop.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const lines = (...l: string[]): string => `${l.join('\n')}\n`
const sorted = (s: Set<number>): number[] => [...s].sort((a, b) => a - b)
const whole = (source: string, jsx?: boolean): number[] => sorted(commentLines(source, jsx === undefined ? {} : { jsx }).whole)
const doc = (source: string, jsx?: boolean): number[] => sorted(commentLines(source, jsx === undefined ? {} : { jsx }).doc)
const all = (source: string): number[] => source.split('\n').map((_, i) => i + 1)

describe('numbered', () => {
  it('right-aligns 1-based numbers before `| `, for LF and CRLF, with or without a final newline', () => {
    expect(numbered('a\nb\n')).toBe('1| a\n2| b')
    expect(numbered('a\r\nb')).toBe('1| a\n2| b')
    const ten = Array.from({ length: 10 }, (_, i) => `x${i}`).join('\n')
    expect(numbered(ten).split('\n').slice(8)).toEqual([' 9| x8', '10| x9'])
    expect(numbered('')).toBe('')
  })
})

describe('parsePoints', () => {
  it('reads the object, with text or a code fence around it', () => {
    expect(parsePoints('{"remove":[3,7]}', 'remove')).toEqual([3, 7])
    expect(parsePoints('Here are the lines: {"remove": [3, 7]} — done.', 'remove')).toEqual([3, 7])
    expect(parsePoints('```json\n{\n  "keep": [1, 2]\n}\n```\n', 'keep')).toEqual([1, 2])
    expect(parsePoints('{"note":"a } and { in a string","remove":[4]}', 'remove')).toEqual([4])
    expect(parsePoints('{"answer": {"remove": [5]}}', 'remove')).toEqual([5])
  })

  it('keeps positive integers once each, at most 2,000 read', () => {
    expect(parsePoints('{"remove":[3,3,1.5,"4",-2,0,7,3,null,1e400]}', 'remove')).toEqual([3, 7])
    expect(parsePoints(JSON.stringify({ remove: Array.from({ length: 2500 }, (_, i) => i + 1) }), 'remove')).toHaveLength(2000)
    expect(parsePoints('{"remove":[]}', 'remove')).toEqual([])
  })

  it('is null without such an object or when the value is not an array', () => {
    expect(parsePoints('no JSON here', 'remove')).toBeNull()
    expect(parsePoints('{"keep":[1]}', 'remove')).toBeNull()
    expect(parsePoints('{"remove":3}', 'remove')).toBeNull()
    expect(parsePoints('{"remove":[1,2]', 'remove')).toBeNull()
    expect(parsePoints('{remove: [1]}', 'remove')).toBeNull()
  })
})

describe('parseSuggestions and suggestionsFor', () => {
  it('keeps the five kinds with a positive line, at most 200 read', () => {
    const raw = 'Sure:\n```json\n{"suggest":[{"line":12,"kind":"trycatch"},{"line":3,"kind":"cast"},{"line":4,"kind":"style"},{"line":0,"kind":"other"},{"kind":"nesting"},{"line":5,"kind":"defensive"},7]}\n```'
    expect(parseSuggestions(raw)).toEqual([{ line: 12, kind: 'trycatch' }, { line: 3, kind: 'cast' }, { line: 5, kind: 'defensive' }])
    const many = JSON.stringify({ suggest: Array.from({ length: 300 }, (_, i) => ({ line: i + 1, kind: 'other' })) })
    expect(parseSuggestions(many)).toHaveLength(200)
    expect(parseSuggestions('{"suggest":{}}')).toBeNull()
    expect(parseSuggestions('nothing')).toBeNull()
  })

  it('restricts to added lines, sorted by line, one per line and kind', () => {
    const list = [{ line: 9, kind: 'other' as const }, { line: 2, kind: 'cast' as const }, { line: 2, kind: 'defensive' as const }, { line: 2, kind: 'cast' as const }, { line: 4, kind: 'nesting' as const }]
    expect(suggestionsFor(list, [2, 9])).toEqual([{ line: 2, kind: 'defensive' }, { line: 2, kind: 'cast' }, { line: 9, kind: 'other' }])
    expect(suggestionsFor(null, [1])).toEqual([])
  })
})

describe('commentLines', () => {
  it('finds the lines that hold one `//` comment and nothing else, LF or CRLF', () => {
    const src = lines('// one', 'const a = 1 // after code', '  // indented', '', 'f() /* block */ // two comments')
    expect(whole(src)).toEqual([1, 3])
    expect(whole(src.replace(/\n/g, '\r\n'))).toEqual([1, 3])
    expect(whole('a()\n// last, no final newline')).toEqual([2])
    expect(whole('')).toEqual([])
  })

  it('does not take `//` inside a template literal, a block comment or a string continued with a backslash', () => {
    expect(whole(lines('const t = `', '  // inside the template', '  ${x + `', '  // nested', '  `}', '`', '// real'))).toEqual([7])
    expect(whole(lines('const e = `\\` and \\${', '// still the template', '`', '// real'))).toEqual([4])
    expect(whole(lines('/*', '// inside a block comment', '*/', '/** doc', ' // also inside', ' */'))).toEqual([])
    expect(whole(lines("const s = 'line \\", "// still the string'", '// real'))).toEqual([3])
    expect(commentLines('const s = "a \\\r\n// still the string"\r\n// real\r\n')).toEqual({ whole: new Set([3]), doc: new Set(), unsure: false })
  })

  it('reads a regular expression that holds `//` as code', () => {
    expect(whole(lines('const url = /https?:\\/\\//', '// real', 'const slash = /[/]/.test(s) ? 1 : 2', 'if (!/^\\s*\\//.test(t)) go()'))).toEqual([2])
    expect(whole(lines('if (ok) /a\\/\\/b/.test(s) && go()', '// real', 'for (const x of xs) /c/.test(x) // trailing'))).toEqual([2])
    expect(whole(lines('const half = total / 2 // division, then a comment', 'const r = a / b / c', '// real'))).toEqual([3])
  })

  it('marks the explanation above a function, a class method, an exported const and a type', () => {
    const src = lines(
      '// what f is for', // 1
      'function f() {', // 2
      '  // narrates', // 3
      '  const x = 1', // 4
      '  // a helper', // 5
      '  const g = (a) => a + x', // 6
      '  return g(x)', // 7
      '}', // 8
      'class C {', // 9
      '  // why this method exists', // 10
      '  run() { return 1 }', // 11
      '  // a field', // 12
      '  #count = 0', // 13
      '}', // 14
      '// the limit', // 15
      '// and why', // 16
      'export const LIMIT = 3', // 17
      '// separated by a blank line', // 18
      '', // 19
      'export async function h() {}', // 20
      '// a type', // 21
      'export type T = { a: number }', // 22
      'const o = {', // 23
      '  // a property', // 24
      '  key: 1,', // 25
      '}', // 26
      'f()', // 27
      '// above a call', // 28
      'f()', // 29
    )
    expect(whole(src)).toEqual([1, 3, 5, 10, 12, 15, 16, 18, 21, 24, 28])
    expect(doc(src)).toEqual([1, 5, 10, 12, 15, 16, 21, 24])
  })

  it('marks the explanation above a function or class assigned to a property, and above a top-level CommonJS export', () => {
    const src = lines(
      '// what the module exports', // 1
      'module.exports = function () {}', // 2
      '// what run does', // 3
      'exports.run = async (a) => a', // 4
      '// what m does', // 5
      'A.prototype.m = function m() {}', // 6
      '// a class', // 7
      'module.exports.Thing = class {}', // 8
      '// a single parameter', // 9
      "exports['one'] = a => a", // 10
      '// an exported value', // 11
      'exports.limit = 3', // 12
      '// an assignment, not an export', // 13
      'counter = 0', // 14
      '// a comparison, not an assignment', // 15
      'exports.limit == function () {}', // 16
      'function setup() {', // 17
      '  // a handler', // 18
      '  emitter.onDone = function () {}', // 19
      '  // narrates', // 20
      '  exports.ready = true', // 21
      '  // narrates too', // 22
      '  total = (a) + b', // 23
      '}', // 24
    )
    expect(whole(src)).toEqual([1, 3, 5, 7, 9, 11, 13, 15, 18, 20, 22])
    expect(doc(src)).toEqual([1, 3, 5, 7, 9, 11, 18])
  })

  it('finds a class body after a heading that holds a type literal', () => {
    const src = lines('export class A<T extends { a: number }> extends B<{ b: string }> {', '  // why run exists', '  run(): void {}', '}')
    expect(doc(src, false)).toEqual([2])
  })

  it('reports a source it cannot read with certainty as unsure, with nothing in it', () => {
    const jsx = lines('const a = (', '  <p>', '    // JSX text, not a comment', "    Don't", '  </p>', ')')
    expect(commentLines(jsx)).toEqual({ whole: new Set(), doc: new Set(), unsure: true })
    expect(commentLines(jsx, { jsx: true }).unsure).toBe(true)
    // without JSX a `<` that starts an expression opens type parameters
    expect(commentLines(lines('// a generic arrow', 'export const id = <T>(x: T): T => x'), { jsx: false })).toEqual({ whole: new Set([1]), doc: new Set([1]), unsure: false })
    expect(commentLines(lines('function f() {}', '/x/.test(s) // after a declaration or an expression?')).unsure).toBe(true)
    expect(commentLines('const s = "unterminated\n// x\n').unsure).toBe(true)
    expect(commentLines('a()\r// a lone CR\n').unsure).toBe(true)
    expect(commentLines('const r = /[[a]--[b]]/v\n').unsure).toBe(true)
    expect(commentLines('f(\n// x\n').unsure).toBe(true)
  })

  it('reads TypeScript non-null assertions and postfix operators before `/` and `<`', () => {
    expect(whole(lines('const r = x! / 2', '// real', 'const s = n++ / 2', 'if (a!-- < 0) go()'))).toEqual([2])
    expect(whole(lines('const r = x', '!/re/.test(s) // a new statement after a line break', '// real'))).toEqual([3])
  })
})

describe('decide', () => {
  const src = lines(
    '// what f is for', // 1
    'function f(a) {', // 2
    '  // Step 1: add one', // 3
    '  const b = a + 1 // trailing', // 4
    '  /* block */', // 5
    '  // Return the result', // 6
    '  return b', // 7
    '}', // 8
  )

  it('removes a listed, added, whole-line comment not above a declaration and not claimed', () => {
    expect(decide({ source: src, added: all(src), remove: [3, 6], keep: [1] })).toEqual({ remove: [3, 6], dropped: [] })
  })

  it('drops every other listed line with the first reason that applies', () => {
    const d = decide({ source: src, added: [1, 3, 4, 5, 6, 99], remove: [6, 1, 2, 3, 4, 5, 6, 99, 120], keep: [3] })
    expect(d.remove).toEqual([6])
    expect(d.dropped).toEqual([
      { line: 1, why: 'above-a-declaration' },
      { line: 2, why: 'out-of-change' },
      { line: 3, why: 'claimed-kept' },
      { line: 4, why: 'not-a-comment' },
      { line: 5, why: 'not-a-comment' },
      { line: 99, why: 'not-a-comment' },
      { line: 120, why: 'out-of-change' },
    ])
  })

  it('removes nothing for an unreadable answer or an unsure file', () => {
    expect(decide({ source: src, added: all(src), remove: null, keep: null })).toEqual({ remove: [], dropped: [] })
    const jsx = lines('const a = <p>', '// text', '</p>')
    expect(decide({ source: jsx, added: [1, 2, 3], remove: [2, 3], keep: [3] })).toEqual({ remove: [], dropped: [{ line: 2, why: 'unsure' }, { line: 3, why: 'claimed-kept' }] })
  })
})

describe('removeLines and sameProgram', () => {
  it('deletes whole lines and leaves every other byte, CRLF and a missing final newline included', () => {
    expect(removeLines('a\r\n// x\r\nb', [2])).toBe('a\r\nb')
    expect(removeLines('a\n// x', [2])).toBe('a\n')
    expect(removeLines('// x\na\n', [1, 7])).toBe('a\n')
    expect(removeLines('a\n', [])).toBe('a\n')
  })

  it('holds after comments go, and not when a token or a line break between tokens changes', () => {
    const src = lines('// c', 'const a = b', '// d', '(c || d).run()')
    expect(sameProgram(src, removeLines(src, [1, 3]))).toBe(true)
    expect(sameProgram(src, src.replace('b\n', 'b;\n'))).toBe(false)
    expect(sameProgram('return\nx\n', 'return x\n')).toBe(false)
    expect(sameProgram('a /* \n */ b', 'a b')).toBe(false)
    expect(sameProgram('a /* c */ b', 'a b')).toBe(true)
    expect(sameProgram('const s = "a"', "const s = 'a'")).toBe(false)
    expect(sameProgram('<p>\n', '<p>\n')).toBe(false)
  })
})

describe('patchFor', () => {
  const apply = (path: string, before: string, patch: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'mesh-code-slop-patch-'))
    dirs.push(dir)
    writeFileSync(join(dir, path), before)
    writeFileSync(join(dir, 'change.patch'), patch)
    for (const args of [['apply', '--check', 'change.patch'], ['apply', 'change.patch']]) {
      const run = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
      expect(run.status, run.stderr).toBe(0)
    }
    return readFileSync(join(dir, path), 'utf8')
  }

  it('writes deletions with three lines of context and a/ b/ headers', () => {
    const before = lines('1', '2', '3', '// x', '5', '6', '7', '8')
    expect(patchFor('src/f.ts', before, before.replace('// x\n', ''))).toBe([
      'diff --git a/src/f.ts b/src/f.ts', '--- a/src/f.ts', '+++ b/src/f.ts',
      '@@ -1,7 +1,6 @@', ' 1', ' 2', ' 3', '-// x', ' 5', ' 6', ' 7', '',
    ].join('\n'))
    expect(patchFor('f.ts', before, before)).toBe('')
  })

  it('applies with git: two hunks, CRLF, no final newline, a file emptied', () => {
    const long = lines('// a', ...Array.from({ length: 12 }, (_, i) => `x${i}`), '// b', 'y')
    const longAfter = removeLines(long, [1, 14])
    const patch = patchFor('f.js', long, longAfter)
    expect(patch.match(/^@@/gm)).toHaveLength(2)
    expect(apply('f.js', long, patch)).toBe(longAfter)
    const crlf = 'a\r\n// x\r\nb\r\n'
    expect(apply('f.js', crlf, patchFor('f.js', crlf, 'a\r\nb\r\n'))).toBe('a\r\nb\r\n')
    const open = 'a\nb\n// last'
    expect(patchFor('f.js', open, 'a\nb\n')).toContain('-// last\n\\ No newline at end of file\n')
    expect(apply('f.js', open, patchFor('f.js', open, 'a\nb\n'))).toBe('a\nb\n')
    expect(apply('f.js', 'a\n// x\nb', patchFor('f.js', 'a\n// x\nb', 'a\nb'))).toBe('a\nb')
    expect(apply('f.js', '// only\n', patchFor('f.js', '// only\n', ''))).toBe('')
  })

  it('refuses anything but deleted whole lines, and paths a patch header cannot carry', () => {
    expect(() => patchFor('f.js', 'a\nb\n', 'a\nc\n')).toThrow(/whole lines deleted/)
    expect(() => patchFor('my file.js', 'a\n// x\n', 'a\n')).toThrow(/relative path/)
    expect(() => patchFor('/abs.js', 'a\n// x\n', 'a\n')).toThrow(/relative path/)
  })
})
