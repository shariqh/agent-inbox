// test/dead-exports.test.ts
// The rule this guard exists to enforce:
//
//   EVERY export in public/*.js must have at least one consumer outside its own
//   declaration — another public/*.js module, src/*.ts, or electron/*.cjs.
//   A *test* is not a consumer: a helper that only its own unit test calls looks
//   load-bearing (typed, covered, named after a real concept) while shipping
//   nothing. The two deliberate exits are a `void X // why` marker at the call
//   site, or an entry in ALLOWED below with a written reason.
//
// Four such helpers accumulated through the viewer rebuild before anyone
// noticed; issue #31.4 is the fourth. This is the durable answer to "what stops
// a fifth". It is deliberately a plain readFileSync scan in the repo's own idiom
// rather than a new dev dependency: knip/ts-prune would need configuring to
// understand `void paginateGroups // kept exported+tested`, and this repo has no
// linter at all.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = new URL('..', import.meta.url).pathname

// Exports that stay on purpose. The map IS the point: it turns a silent trap
// into a list somebody has to look at and justify.
const ALLOWED = new Map<string, string>([
  ['colors.js:RESERVED_HUE', 'the reserved state-band constant test/colors.test.ts asserts every palette hue against (spec §2) — an invariant, not a call site'],
  ['colors.js:overrideHue', 'spec §2 hue-pinning seam: the store-backed writer a future gear-panel picker calls. Delete it on purpose, never by drift'],
])

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

function readAll(dir: string, keep: (name: string) => boolean): Array<{ name: string; src: string }> {
  return readdirSync(join(REPO, dir))
    .filter(keep)
    .sort()
    .map((name) => ({ name, src: stripCommentLines(readFileSync(join(REPO, dir, name), 'utf8')) }))
}

// The only two export forms in public/*.js today (verified: no `export {}`,
// `export class`, `export let`, `export default` anywhere in the tree).
const EXPORT_RE = /export\s+(?:async\s+)?function\s+(\w+)|export\s+const\s+(\w+)/g

const publicFiles = readAll('public', (n) => n.endsWith('.js') && n !== 'ufuzzy.iife.min.js')
// .d.ts files are DECLARATIONS, not consumers — a type alone ships nothing.
const consumerBlob = [
  ...publicFiles.map((f) => f.src),
  ...readAll('src', (n) => n.endsWith('.ts')).map((f) => f.src),
  ...readAll('electron', (n) => n.endsWith('.cjs')).map((f) => f.src),
].join('\n')

interface ExportName { key: string; name: string }

const exportNames: ExportName[] = []
for (const file of publicFiles) {
  EXPORT_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = EXPORT_RE.exec(file.src)) !== null) {
    const name = m[1] ?? m[2]
    if (!name) continue
    exportNames.push({ key: `${file.name}:${name}`, name })
  }
}

const occurrences = (name: string): number =>
  (consumerBlob.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length

// exactly one occurrence across the whole blob === its own declaration, nothing else
const unused = exportNames.filter(({ name }) => occurrences(name) === 1)

describe('public/*.js has no dead exports', () => {
  it('scans a plausible number of exports — a regex matching nothing must not pass vacuously', () => {
    expect(publicFiles.length).toBeGreaterThanOrEqual(15)
    expect(exportNames.length).toBeGreaterThanOrEqual(80)
    // sanity: a name we know is exported and consumed
    expect(exportNames.map((e) => e.key)).toContain('esc.js:esc')
    expect(occurrences('esc')).toBeGreaterThan(1)
  })

  it('every export has at least one consumer outside its own declaration', () => {
    const dead = unused.map((e) => e.key).filter((key) => !ALLOWED.has(key))
    expect(dead, `dead exports — wire them up, delete them, or add them to ALLOWED with a reason:\n${dead.join('\n')}`).toEqual([])
  })

  it('the deliberate-exception list has no stale entries', () => {
    const keys = new Set(exportNames.map((e) => e.key))
    const unusedKeys = new Set(unused.map((e) => e.key))
    for (const key of ALLOWED.keys()) {
      expect(keys.has(key), `ALLOWED names ${key}, which is no longer exported`).toBe(true)
      expect(unusedKeys.has(key), `ALLOWED still excuses ${key}, but it now has a real consumer — drop the entry`).toBe(true)
    }
  })
})
