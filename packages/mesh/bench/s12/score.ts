// Bench S12's scorer (unslop-code, step 1). For a set of answers it applies the
// guards (decide, with every line of a function counted as added), removes the
// lines, and reports slop comments removed, good comments removed (any comment of
// the clean original), clean functions left byte-identical, sameProgram for every
// function, and the count of each reason a listed line was kept. The change
// fixtures (step 2) are scored apart: slop comments removed, good comments the
// change added removed, comments outside the change removed, and sameProgram.
import { decide, parsePoints, removeLines, sameProgram } from '../../src/code-slop.js'
import type { Decision, DropReason } from '../../src/code-slop.js'
import type { Answer, ChangeFixture, CodeFixture, ScopeFixture } from './fixtures.js'

export type FixtureScore = {
  id: string
  seeded: boolean
  output: string
  decision: Decision
  slop: { removed: number; total: number }
  good: { removed: string[]; total: number }
  identical: boolean
  sameProgram: boolean
}
export type Score = {
  fixtures: FixtureScore[]
  slop: { removed: number; total: number }
  good: { removed: number; total: number }
  clean: { identical: number; total: number }
  sameProgram: { holds: number; total: number }
  dropped: Record<DropReason, number>
}

const REASONS: DropReason[] = ['out-of-change', 'not-a-comment', 'above-a-declaration', 'claimed-kept', 'unsure']
const jsx = (ext: string): boolean => ext !== '.ts'

/** The comments of a fixture's original: every block comment and every `//` comment to its line's end. */
export function comments(text: string): string[] {
  // the fifteen originals hold no `//` or `/*` inside a string, template or regular expression (the soundness test checks the count)
  return text.match(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g) ?? []
}

/** Lines all counted as added unless the fixture says which. */
export function apply(source: string, ext: string, answer: Answer, added?: number[]): { output: string; decision: Decision } {
  const decision = decide({
    source,
    added: added ?? source.split('\n').map((_, i) => i + 1),
    remove: parsePoints(answer.remove, 'remove'),
    keep: parsePoints(answer.keep, 'keep'),
    jsx: jsx(ext),
  })
  return { output: removeLines(source, decision.remove), decision }
}

export function scoreFixture(f: CodeFixture, answer: Answer | undefined): FixtureScore {
  const { output, decision } = answer ? apply(f.given, f.ext, answer) : { output: f.given, decision: { remove: [], dropped: [] } }
  return scoreOutput(f, output, decision)
}

/** A function's score for an output already made (by the live bench's run of the task). */
export function scoreOutput(f: CodeFixture, output: string, decision: Decision): FixtureScore {
  const slop = f.instances.filter((i) => i.cat === 'comment')
  const good = comments(f.original)
  return {
    id: f.id,
    seeded: f.seeded,
    output,
    decision,
    slop: { removed: slop.filter((i) => !new RegExp(i.gone).test(output)).length, total: slop.length },
    good: { removed: good.filter((g) => !output.includes(g)), total: good.length },
    identical: output === f.given,
    sameProgram: sameProgram(f.given, output, { jsx: jsx(f.ext) }),
  }
}

export function score(fixtures: CodeFixture[], answers: Record<string, Answer>): Score {
  return total(fixtures.map((f) => scoreFixture(f, answers[f.id])))
}

export function total(rows: FixtureScore[]): Score {
  const sum = (pick: (r: FixtureScore) => number): number => rows.reduce((n, r) => n + pick(r), 0)
  const dropped = Object.fromEntries(REASONS.map((why) => [why, 0])) as Record<DropReason, number>
  for (const r of rows) for (const d of r.decision.dropped) dropped[d.why] += 1
  const clean = rows.filter((r) => !r.seeded)
  return {
    fixtures: rows,
    slop: { removed: sum((r) => r.slop.removed), total: sum((r) => r.slop.total) },
    good: { removed: sum((r) => r.good.removed.length), total: sum((r) => r.good.total) },
    clean: { identical: clean.filter((r) => r.identical).length, total: clean.length },
    sameProgram: { holds: rows.filter((r) => r.sameProgram).length, total: rows.length },
    dropped,
  }
}

export function scoreScope(f: ScopeFixture): Decision {
  return apply(f.source, f.ext, f.answer, f.added).decision
}

export function summarize(s: Score): string {
  const lines = [
    '# S12 summary', '',
    `- Slop comments removed: ${s.slop.removed} of ${s.slop.total}.`,
    `- Good comments removed: ${s.good.removed} of ${s.good.total}.`,
    `- Clean functions byte-identical: ${s.clean.identical} of ${s.clean.total}.`,
    `- sameProgram: ${s.sameProgram.holds} of ${s.sameProgram.total}.`,
    `- Listed lines kept: ${REASONS.map((why) => `${why} ${s.dropped[why]}`).join(', ')}.`,
  ]
  for (const r of s.fixtures) {
    if (r.slop.removed < r.slop.total) lines.push(`- Slop left in ${r.id}: ${r.slop.total - r.slop.removed} of ${r.slop.total}`)
    if (r.good.removed.length) lines.push(`- Good comments lost in ${r.id}: ${r.good.removed.join(' | ')}`)
    if (!r.seeded && !r.identical) lines.push(`- Clean ${r.id} changed`)
    if (!r.sameProgram) lines.push(`- ${r.id}: the program changed`)
  }
  return `${lines.join('\n')}\n`
}

export type ChangeScore = {
  id: string
  decision: Decision
  slop: { removed: number; total: number }
  good: { removed: string[]; total: number }
  old: { removed: string[]; total: number }
  sameProgram: boolean
}
export type ChangesScore = {
  changes: ChangeScore[]
  slop: { removed: number; total: number }
  good: { removed: number; total: number }
  old: { removed: number; total: number }
  sameProgram: { holds: number; total: number }
}

/** A change fixture's score for the lines a run removed. */
export function scoreChange(f: ChangeFixture, decision: Decision): ChangeScore {
  const gone = new Set(decision.remove)
  const text = (n: number): string => f.given.split('\n')[n - 1]!.trim()
  return {
    id: f.id,
    decision,
    slop: { removed: f.slop.filter((n) => gone.has(n)).length, total: f.slop.length },
    good: { removed: f.good.filter((n) => gone.has(n)).map(text), total: f.good.length },
    old: { removed: f.old.filter((n) => gone.has(n)).map(text), total: f.old.length },
    sameProgram: sameProgram(f.given, removeLines(f.given, decision.remove), { jsx: jsx(f.ext) }),
  }
}

export function totalChanges(rows: ChangeScore[]): ChangesScore {
  const sum = (pick: (r: ChangeScore) => number): number => rows.reduce((n, r) => n + pick(r), 0)
  return {
    changes: rows,
    slop: { removed: sum((r) => r.slop.removed), total: sum((r) => r.slop.total) },
    good: { removed: sum((r) => r.good.removed.length), total: sum((r) => r.good.total) },
    old: { removed: sum((r) => r.old.removed.length), total: sum((r) => r.old.total) },
    sameProgram: { holds: rows.filter((r) => r.sameProgram).length, total: rows.length },
  }
}

export function summarizeChanges(s: ChangesScore): string {
  const lines = [
    '# S12 changes', '',
    `- Slop comments removed: ${s.slop.removed} of ${s.slop.total}.`,
    `- Good comments removed: ${s.good.removed} of ${s.good.total}.`,
    `- Comments outside the change removed: ${s.old.removed} of ${s.old.total}.`,
    `- sameProgram: ${s.sameProgram.holds} of ${s.sameProgram.total}.`,
  ]
  for (const r of s.changes) {
    if (r.slop.removed < r.slop.total) lines.push(`- Slop left in ${r.id}: ${r.slop.total - r.slop.removed} of ${r.slop.total}`)
    if (r.good.removed.length) lines.push(`- Good comments lost in ${r.id}: ${r.good.removed.join(' | ')}`)
    if (r.old.removed.length) lines.push(`- Comments outside the change lost in ${r.id}: ${r.old.removed.join(' | ')}`)
    if (!r.sameProgram) lines.push(`- ${r.id}: the program changed`)
  }
  return `${lines.join('\n')}\n`
}
