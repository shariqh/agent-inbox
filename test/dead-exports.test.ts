// test/dead-exports.test.ts
// The rule this guard exists to enforce:
//
//   EVERY value export in public/*.js and src/*.ts must be REACHABLE FROM CODE
//   THAT SHIPS. Two ways to be reachable, and nothing else counts:
//     (a) another production module IMPORTS it by name and actually uses that
//         binding, or
//     (b) it is used inside its OWN module, outside its own declaration, and
//         that module is itself reachable (something imports it, or it is one
//         of the entry points listed below).
//   A *test* is never a consumer: a helper that only its own unit test calls
//   looks load-bearing (typed, covered, named after a real concept) while
//   shipping nothing. The two deliberate exits are a `void X // why` marker at
//   a call site that imports X, or an entry in ALLOWED below with a reason.
//
// WHY THE RULE IS SHAPED LIKE THAT. (b) is not a loophole and it is not
// leniency: public/source.js's linkKey/linkFor/safeHttpUrl/issueRef/prChip/
// prDetail/sourceTooltip are imported by nobody, yet every one of them is
// called by sourceChipsHtml()/sourceBlockHtml(), which app.js does import — so
// they ship, and calling them dead would be wrong. What (b) requires is a
// CALL SITE. The module clause is what stops (b) from excusing a clique of
// mutually-calling helpers in a file nothing imports.
//
// HISTORY — this is the fifth occurrence, and the guard's own second draft.
// Four dead helpers accumulated through the viewer rebuild (issue #31.4 was the
// fourth) and this file was the durable answer to "what stops a fifth". Then
// #32 shipped store.ts:listClosedProjects and this guard let it through,
// because its liveness test was `\bNAME\b occurring more than once across a
// concatenation of every consumer file`: any unrelated file containing the same
// word anywhere — a local variable, a property, a column name — read as a
// consumer, and src/ was not scanned for exports at all. Reproduced by
// construction before rewriting: adding `export function status() {}` to
// public/esc.js (a dead export by any measure; `status` is a column in store.ts
// and a field in half of public/) passed the old guard and fails this one. That
// is the whole point of the rewrite: an IMPORT or a CALL is a consumer, an
// incidental word match is not.
//
// It is deliberately a readFileSync scan in the repo's own idiom rather than a
// new dev dependency: knip/ts-prune would need configuring to understand
// `void paginateGroups // kept exported+tested`, and this repo has no linter at
// all. The analyser below is a pure function of {path, code} precisely so that
// its discrimination can be tested on synthetic modules — see the second
// describe block, which is what stops a THIRD draft being needed.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = new URL('..', import.meta.url).pathname

// Exports that stay on purpose. The map IS the point: it turns a silent trap
// into a list somebody has to look at and justify.
const ALLOWED = new Map<string, string>([
  ['colors.js:RESERVED_HUE', 'the reserved state-band constant test/colors.test.ts asserts every palette hue against (spec §2) — an invariant, not a call site'],
  ['colors.js:overrideHue', 'spec §2 hue-pinning seam: the store-backed writer a future gear-panel picker calls. Delete it on purpose, never by drift'],
  ['store.ts:listClosedProjects', 'the RAW projects-table reader (issue #32). CLAUDE.md makes store.ts the only door to the DB, so "closing twice leaves ONE row" has no other way to be asserted; production must use closedProjects(), the EFFECTIVE set, and its doc comment says so. Wire it into the viewer if and when the "closed 3d ago" chip is actually built'],
])

// Modules nothing imports because something outside JS starts them. Each one is
// asserted below to exist and to be genuinely unimported, so a stale exemption
// cannot sit here silently widening the guard.
const ENTRY_POINTS = new Map<string, string>([
  ['public/app.js', 'loaded by <script type="module" src="/app.js"> in public/index.html'],
  ['src/mcp-server.ts', 'the stdio MCP entry — `npm run mcp`, dist/mcp-server.js in the packaged app'],
  ['src/viewer-server.ts', 'the viewer entry — `npm run view`'],
  ['src/hook-cli.ts', 'the hooks entry the Claude Code settings block invokes'],
  ['electron/main.cjs', "Electron's main-process entry"],
])

// electron/*.cjs is read as a CONSUMER only, never scanned for exports: it
// exports through CommonJS `module.exports`, a different form, and its one
// exporting module (reuse.cjs) has both names required by main.cjs.
const isConsumerOnly = (path: string): boolean => path.startsWith('electron/')

// ── the analyser ────────────────────────────────────────────────────────────

interface SourceFile { path: string; name: string; code: string }
interface Binding { exported: string; local: string }
interface ImportStmt { from: string; bindings: Binding[]; spec: string; text: string }
interface Analysis { exports: string[]; dead: string[]; unreached: string[] }

// A name surviving only inside prose must not read as alive. Strip lines that
// are comment-ONLY; a TRAILING comment keeps its code half, which is exactly
// what lets app.js's `void paginateGroups // kept exported+tested` marker count.
function stripCommentLines(src: string): string {
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
    })
    .join('\n')
}

// Quoted strings are TEXT, not code: 'closeProject' in a log line or a SQL
// fragment is not a call. Template literals keep their bodies on purpose —
// their `${…}` halves hold real calls (source.js builds every chip that way).
function stripQuoted(src: string): string {
  return src.replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
}

// The only export forms in the scanned tree today; `no unsupported export form`
// below fails the moment that stops being true, so this cannot miss silently.
const DECL_RE = /export\s+(?:async\s+)?function\s+(\w+)|export\s+const\s+(\w+)|export\s+class\s+(\w+)/g
// Named ESM imports (including `import type`) and CommonJS destructured
// requires. `import x from` / `import * as x from` are rejected for LOCAL
// specifiers by `no unsupported local import form` below.
const IMPORT_RE =
  /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]|(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g

// An identifier reference, not any old word: `\b` would let `link.prChip` or
// `it.project` vouch for an export named prChip/project, so a member access is
// excluded.
//
// KNOWN RESIDUAL LIMIT, stated exactly because an overstated guard is worse
// than none. This is not a tokenizer, so inside the DECLARING file a bare
// occurrence of the name still counts however it got there: a local binding, a
// parameter, an object-literal key, an interface field, or template-literal
// TEXT (`tone-${…}` in a class name, `annotation = ?` in SQL). Template bodies
// are deliberately kept because their `${…}` halves hold real calls, and
// telling those two halves apart needs a real parser. Verified consequence: an
// export named after a CSS token in public/source.js or a column in
// src/store.ts can still read as self-used. What CANNOT happen is the failure
// that actually shipped five times — a name vouched for by a DIFFERENT file it
// has nothing to do with. Cross-file liveness is import-only, no exceptions.
const word = (name: string): RegExp => new RegExp(`(?<![\\w$.])${name}(?![\\w$])`)
const declOf = (name: string): RegExp => new RegExp(`export\\s+(?:async\\s+)?(?:function|const|class)\\s+${name}\\b`)
const isLocalSpec = (spec: string): boolean => spec.startsWith('.') || spec.startsWith('/')
const moduleId = (specOrName: string): string => (specOrName.split('/').pop() ?? '').replace(/\.(ts|js|cjs|mjs)$/, '')

// The declaration and its whole body, removed. Dropping only the first line
// would let a recursive helper count as its own consumer; bracket depth ends
// the statement, and strings are gone by then so their brackets cannot skew it.
function withoutOwnDeclaration(code: string, name: string): string {
  const lines = stripQuoted(code).split('\n')
  const re = declOf(name)
  const kept: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (!re.test(line)) {
      kept.push(line)
      i++
      continue
    }
    let depth = 0
    do {
      for (const ch of lines[i] ?? '') {
        if (ch === '{' || ch === '[' || ch === '(') depth++
        else if (ch === '}' || ch === ']' || ch === ')') depth--
      }
      i++
    } while (i < lines.length && depth > 0)
  }
  return kept.join('\n')
}

function parseImports(f: SourceFile): ImportStmt[] {
  const out: ImportStmt[] = []
  IMPORT_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = IMPORT_RE.exec(f.code)) !== null) {
    const raw = m[1] ?? m[3] ?? ''
    const spec = m[2] ?? m[4] ?? ''
    const bindings: Binding[] = raw
      .split(',')
      .map((s) => s.trim().replace(/^type\s+/, ''))
      .filter(Boolean)
      .map((s) => {
        // `{ a as b }` binds b locally but consumes the export named a
        const parts = s.split(/\s+as\s+/).map((p) => p.trim())
        return { exported: parts[0] ?? s, local: parts[parts.length - 1] ?? s }
      })
    out.push({ from: f.path, bindings, spec, text: m[0] })
  }
  return out
}

function analyse(files: SourceFile[], entries: Iterable<string>): Analysis {
  const entrySet = new Set(entries)
  const imports = files.flatMap(parseImports)
  // usage bodies: the import statements themselves are removed, so NAMING a
  // symbol in an import is not by itself using it, and strings are gone
  const body = new Map<string, string>(
    files.map((f) => [
      f.path,
      stripQuoted(imports.filter((s) => s.from === f.path).reduce((acc, s) => acc.split(s.text).join(' '), f.code)),
    ]),
  )
  const uses = (path: string, name: string): boolean => word(name).test(body.get(path) ?? '')
  // an import counts only when it is FROM the declaring module: a name imported
  // out of some unrelated package is not a consumer of this file's export
  const importedFrom = (f: SourceFile, name: string): boolean =>
    imports.some(
      (s) =>
        s.from !== f.path &&
        isLocalSpec(s.spec) &&
        moduleId(s.spec) === moduleId(f.name) &&
        s.bindings.some((b) => b.exported === name && uses(s.from, b.local)),
    )
  const reached = (f: SourceFile): boolean =>
    entrySet.has(f.path) ||
    imports.some((s) => s.from !== f.path && isLocalSpec(s.spec) && moduleId(s.spec) === moduleId(f.name))

  const exports: string[] = []
  const dead: string[] = []
  for (const f of files) {
    if (isConsumerOnly(f.path)) continue
    DECL_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = DECL_RE.exec(f.code)) !== null) {
      const name = m[1] ?? m[2] ?? m[3]
      if (!name) continue
      const key = `${f.name}:${name}`
      exports.push(key)
      const selfUsed = word(name).test(withoutOwnDeclaration(f.code, name))
      if (!(importedFrom(f, name) || (selfUsed && reached(f)))) dead.push(key)
    }
  }
  return { exports, dead, unreached: files.filter((f) => !reached(f)).map((f) => f.path) }
}

// ── the real tree ───────────────────────────────────────────────────────────

function readAll(dir: string, keep: (name: string) => boolean): SourceFile[] {
  return readdirSync(join(REPO, dir))
    .filter(keep)
    .sort()
    .map((name) => ({
      path: `${dir}/${name}`,
      name,
      code: stripCommentLines(readFileSync(join(REPO, dir, name), 'utf8')),
    }))
}

// .d.ts files are DECLARATIONS, not consumers — a type alone ships nothing —
// and `export type`/`export interface` are skipped for the same reason.
const publicFiles = readAll('public', (n) => n.endsWith('.js') && n !== 'ufuzzy.iife.min.js')
const srcFiles = readAll('src', (n) => n.endsWith('.ts'))
const electronFiles = readAll('electron', (n) => n.endsWith('.cjs'))
const allFiles = [...publicFiles, ...srcFiles, ...electronFiles]
const analysis = analyse(allFiles, ENTRY_POINTS.keys())

describe('public/*.js and src/*.ts have no dead exports', () => {
  it('scans a plausible number of exports — a regex matching nothing must not pass vacuously', () => {
    expect(publicFiles.length).toBeGreaterThanOrEqual(15)
    expect(srcFiles.length).toBeGreaterThanOrEqual(9)
    expect(analysis.exports.length).toBeGreaterThanOrEqual(150)
    // sanity: names we know are exported, from both halves of the scan
    expect(analysis.exports).toContain('esc.js:esc')
    expect(analysis.exports).toContain('store.ts:insertItem')
    // …and the analyser rates real consumers alive rather than flagging everything
    expect(analysis.dead).not.toContain('esc.js:esc')
    expect(analysis.dead).not.toContain('store.ts:insertItem')
    expect(analysis.dead.length).toBeLessThan(10)
  })

  it('every export has a consumer that ships — an import or a call, not a word match', () => {
    const dead = analysis.dead.filter((key) => !ALLOWED.has(key))
    expect(dead, `dead exports — wire them up, delete them, or add them to ALLOWED with a reason:\n${dead.join('\n')}`).toEqual([])
  })

  it('the deliberate-exception list has no stale entries', () => {
    const keys = new Set(analysis.exports)
    const deadKeys = new Set(analysis.dead)
    for (const key of ALLOWED.keys()) {
      expect(keys.has(key), `ALLOWED names ${key}, which is no longer exported`).toBe(true)
      expect(deadKeys.has(key), `ALLOWED still excuses ${key}, but it now has a real consumer — drop the entry`).toBe(true)
    }
  })

  it('the entry-point list has no stale entries either', () => {
    const paths = new Set(allFiles.map((f) => f.path))
    const unreached = new Set(analyse(allFiles, []).unreached)
    for (const [path, why] of ENTRY_POINTS) {
      expect(paths.has(path), `ENTRY_POINTS names ${path}, which no longer exists`).toBe(true)
      expect(unreached.has(path), `ENTRY_POINTS excuses ${path} (${why}), but something imports it now — drop the entry`).toBe(true)
    }
    // with the entry points supplied, nothing is left unreachable
    expect(analysis.unreached).toEqual([])
  })

  it('module basenames are unique across public/ and src/, which the specifier match assumes', () => {
    const ids = [...publicFiles, ...srcFiles].map((f) => moduleId(f.name))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('no unsupported export form — the declaration regex cannot miss silently', () => {
    for (const f of [...publicFiles, ...srcFiles]) {
      expect(f.code, `${f.path} uses an export form DECL_RE does not read`).not.toMatch(
        /^export\s+(?:let|var|default|\*|\{)/m,
      )
    }
  })

  it('no unsupported local import form — the consumer regex cannot miss silently', () => {
    for (const f of allFiles) {
      const locals = [...f.code.matchAll(/^import\s+([^;\n]*?)\s*from\s*['"]([^'"]+)['"]/gm)].filter((m) =>
        isLocalSpec(m[2] ?? ''),
      )
      for (const m of locals) {
        expect(m[1] ?? '', `${f.path}: local import '${m[2]}' is not a braced named import`).toMatch(/\{/)
      }
      expect(f.code, `${f.path} has a side-effect import the scan cannot attribute`).not.toMatch(
        /^import\s*['"][./]/m,
      )
    }
  })
})

// The tests that stop a THIRD draft. Every case below is a mutation of the
// liveness predicate stated as a synthetic module tree: if the predicate ever
// slackens back into word-matching, these fail without waiting for somebody to
// ship a sixth dead export.
describe('the liveness rule discriminates', () => {
  const fx = (path: string, code: string): SourceFile => ({
    path,
    name: path.split('/').pop() ?? path,
    code: stripCommentLines(code),
  })
  const ENTRIES = ['public/entry.js']
  const deadIn = (files: SourceFile[]): string[] => analyse(files, ENTRIES).dead

  // the predicate the first draft used, kept here purely to prove the hole
  const oldPredicateSaysAlive = (files: SourceFile[], name: string): boolean =>
    (files.map((f) => f.code).join('\n').match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length > 1

  it('an incidental word match somewhere else is NOT a consumer (the hole that let a fifth through)', () => {
    const files = [
      fx('public/entry.js', `import { used } from '/helper.js'\nused()`),
      fx('public/helper.js', `export function used() { return 1 }\nexport function status() { return 2 }`),
      fx('src/noise.ts', `export function other() { const status = 1; return status }`),
    ]
    expect(oldPredicateSaysAlive(files, 'status')).toBe(true) // …and that is the bug
    expect(deadIn(files)).toContain('helper.js:status')
    expect(deadIn(files)).not.toContain('helper.js:used')
  })

  it('a named import the importer actually uses IS a consumer', () => {
    const files = [fx('public/entry.js', `import { used } from '/helper.js'\nused()`), fx('public/helper.js', `export const used = 1`)]
    expect(deadIn(files)).toEqual([])
  })

  it('an import nothing in the importer uses does NOT resurrect it', () => {
    const files = [fx('public/entry.js', `import { used } from '/helper.js'\nconsole.log(1)`), fx('public/helper.js', `export const used = 1`)]
    expect(deadIn(files)).toEqual(['helper.js:used'])
  })

  it('an aliased import is still a consumer of the name it was exported under', () => {
    const files = [
      fx('public/entry.js', `import { used as renamed } from '/helper.js'\nrenamed()`),
      fx('public/helper.js', `export function used() { return 1 }`),
    ]
    expect(deadIn(files)).toEqual([])
  })

  it("a call inside its own REACHED module is a consumer — source.js's seven helpers are not dead", () => {
    const files = [
      fx('public/entry.js', `import { outer } from '/helper.js'\nouter()`),
      fx('public/helper.js', `export function inner() { return 1 }\nexport function outer() { return inner() }`),
    ]
    expect(deadIn(files)).toEqual([])
  })

  it('…but the same call inside a module NOTHING imports is not', () => {
    const files = [
      fx('public/entry.js', `console.log(1)`),
      fx('public/orphan.js', `export function inner() { return 1 }\nexport function outer() { return inner() }`),
    ]
    expect(deadIn(files).sort()).toEqual(['orphan.js:inner', 'orphan.js:outer'])
  })

  it('a member access of the same name is not a reference to the export', () => {
    const files = [
      fx('public/entry.js', `import { used } from '/helper.js'\nused({})`),
      fx('public/helper.js', `export function used(link) { return build(link) }\nexport function chip() { return 2 }\nexport function build(link) { return link.chip }`),
    ]
    // build() reads a PROPERTY called chip; the exported chip() is still dead
    expect(deadIn(files)).toEqual(['helper.js:chip'])
  })

  it('a recursive helper is not its own consumer', () => {
    const files = [
      fx('public/entry.js', `console.log(1)`),
      fx('public/helper.js', `export function loop(n) { return n <= 0 ? 0 : loop(n - 1) }`),
    ]
    expect(deadIn(files)).toEqual(['helper.js:loop'])
  })

  it('a mention in a comment or inside a string is not a call', () => {
    const files = [
      fx('public/entry.js', `import { used } from '/helper.js'\nused()`),
      fx(
        'public/helper.js',
        `export function used() { return 1 }\nexport function ghost() { return 2 }\n// ghost is great\nconsole.log('ghost')\nconsole.log("ghost")`,
      ),
    ]
    expect(deadIn(files)).toEqual(['helper.js:ghost'])
  })

  it("a name imported from an unrelated module does not vouch for this module's export", () => {
    const files = [
      fx('public/entry.js', `import { render } from '/other.js'\nrender()`),
      fx('public/helper.js', `export function render() { return 1 }`),
      fx('public/other.js', `export function render() { return 2 }`),
    ]
    // other.js's render is imported and used; helper.js's identically-named one is not
    expect(deadIn(files)).toEqual(['helper.js:render'])
  })

  it('the `void X // why` marker keeps a name alive because the marker imports and mentions it', () => {
    const files = [
      fx('public/entry.js', `import { kept } from '/helper.js'\nvoid kept // kept exported+tested, nothing calls it`),
      fx('public/helper.js', `export function kept() { return 1 }`),
    ]
    expect(deadIn(files)).toEqual([])
  })

  it('src/*.ts is scanned exactly like public/*.js — finding (1) lived in src', () => {
    const files = [
      fx('src/mcp-server.ts', `import { live } from './store.js'\nlive()`),
      fx('src/store.ts', `export function live() { return 1 }\nexport function orphanRow() { return 2 }`),
    ]
    expect(analyse(files, ['src/mcp-server.ts']).dead).toEqual(['store.ts:orphanRow'])
  })

  it('electron/*.cjs is read as a consumer, never scanned for exports', () => {
    const files = [
      fx('public/entry.js', `console.log(1)`),
      fx('src/store.ts', `export function used() { return 1 }`),
      fx('electron/main.cjs', `const { used } = require('./store.js')\nused()`),
      fx('electron/reuse.cjs', `module.exports = { helper: () => 1 }`),
    ]
    expect(analyse(files, ['public/entry.js', 'electron/main.cjs']).dead).toEqual([])
  })
})
