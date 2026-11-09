// The grounding check (web search design §6): code, not the model, decides whether an
// answer may go out. Shape, always: every [n] names a source the model was given; no
// URL, Markdown link or image, HTML tag or the prompt's nonce; at most 4,000 characters;
// not cut off. Unless the answer starts NOT FOUND: every paragraph or list item that
// makes a claim cites a source, and each number, version, date and quote unslop's
// extractors find in a sentence is contained, after normalising, in a source the
// sentence cites (or, when it cites none, one its paragraph cites). A coarser value
// matches a finer one (`Node 24` ~ `v24.11.0`, `October 2025` ~ `2025-10-28`), and a
// value the question holds is exempt.
import { extractValues } from '../fidelity.js'
import { visible } from './suspect.js'

export type Rule = 'citation-range' | 'link' | 'image' | 'html' | 'nonce' | 'length' | 'truncated' | 'empty' | 'uncited-claim' | 'value-not-contained'
export type Failure = { rule: Rule; values: string[] }
export type Grounding = { ok: boolean; text: string; found: boolean; citations: number[]; failures: Failure[] }

export const ANSWER_MAX = 4000
export const NOT_FOUND_MAX = 400
const CITE = /\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g
const IMAGE = /!\[[^\]\n]*\]\(/
const LINK = /\]\([^)\n]*\)|\b[a-z][a-z\d+.-]*:\/\/|\bwww\.[a-z\d-]+\.|\bmailto:/i
const HTML = /<[a-z/!?]/i
const SENTENCE = /(?<=[.!?](?:\s*\[[\d,\s]+\])*)\s+(?!\[\d)/
const UNIT = /(\d) (?=(?:[KMGTPE]i?B|[kMG]?bps|[kMG]?Hz|ms|px|%)(?![\w%]))/g
const APPROX = /^(?:about|around|roughly|approximately|nearly|almost|up to|at least|at most|more than|less than|fewer than|~) ?/i

const norm = (t: string): string => t.replace(/[“”„]/g, '"').replace(/[‘’]/g, "'").replace(UNIT, '$1').replace(/\s+/g, ' ')
const cites = (t: string): number[] => [...t.matchAll(CITE)].flatMap((m) => m[1]!.split(',').map(Number))
const uncite = (t: string): string => t.replace(CITE, (m) => ' '.repeat(m.length))
type Num = { pre: string; parts: string[]; unit: string }
const num = (v: string): Num | undefined => {
  const m = /^(\D*?)v?(\d+(?:\.\d+)*)(.*)$/i.exec(v.replace(APPROX, ''))
  return m ? { pre: m[1]!.toLowerCase(), parts: m[2]!.split('.'), unit: m[3]!.toLowerCase() } : undefined
}
const prefix = (a: string[], b: string[]): boolean => a.length <= b.length && a.every((x, i) => x === b[i])
type Values = ReturnType<typeof extractValues> & { text: string }
const values = (text: string): Values => ({ ...extractValues(norm(text)), text: norm(text) })

/** Whether `v` (of class `cls`) is in `s`: as written, or as a coarser value of a finer one there. */
function holds(cls: 'numbers' | 'dates' | 'quotes', v: string, s: Values): boolean {
  if (cls === 'quotes') return s.text.includes(v)
  if (cls === 'dates') {
    const a = v.split(/[-T]/)
    return s.dates.some((d) => { const b = d.split(/[-T]/); return a.length <= b.length && a.every((x, i) => x === '' || x === b[i]) })
  }
  const a = num(v)
  if (!a) return false
  if (/^\d{4}$/.test(v) && s.dates.some((d) => d.startsWith(`${v}-`))) return true
  if (s.numbers.some((w) => { const b = num(w); return b !== undefined && prefix(a.parts, b.parts) && (!a.unit || a.unit === b.unit) && (!a.pre || a.pre === b.pre) })) return true
  // a value inside text the extractors take whole (a URL, a path): digits on its own
  return !a.pre && !a.unit && new RegExp(`(?<![\\d.])${a.parts.join('\\.')}(?!\\d)`).test(s.text)
}

export function checkGrounding(input: { question: string; answer: string; nonce: string; sources: Array<{ n: number; text: string }>; truncated?: boolean }): Grounding {
  const text = visible(input.answer).trim()
  const failures = new Map<Rule, string[]>()
  const fail = (rule: Rule, value?: string): void => { failures.set(rule, [...(failures.get(rule) ?? []), ...(value === undefined ? [] : [value])]) }
  const given = new Map(input.sources.map((s) => [s.n, values(s.text)]))
  if (input.truncated) fail('truncated')
  if (!text) fail('empty')
  if (input.nonce && text.includes(input.nonce)) fail('nonce')
  const long = [...text].length > ANSWER_MAX
  if (long) fail('length')
  if (IMAGE.test(text)) fail('image')
  if (LINK.test(text)) fail('link')
  if (HTML.test(text)) fail('html')
  for (const n of new Set(cites(text))) if (!given.has(n)) fail('citation-range', `[${n}]`)
  const found = !/^NOT FOUND\b/.test(text)
  // an answer too long to send is not read for claims: bounded work on any reply
  if (found && text && !long) {
    const asked = values(input.question)
    const blocks = text.split(/\n\s*\n|\n(?=\s*(?:[-*•]|\d+[.)])\s)/).map((b) => b.trim()).filter(Boolean)
    for (const block of blocks) {
      const own = cites(block)
      if (!own.length) {
        // a line that introduces a list ("The sources say:") states nothing itself
        if (!/:\s*$/.test(block) && (uncite(block).match(/[\p{L}\p{N}]+/gu) ?? []).length >= 2) fail('uncited-claim', block.slice(0, 80))
        continue
      }
      for (const sentence of block.split(SENTENCE)) {
        const cited = (cites(sentence).length ? cites(sentence) : own).flatMap((n) => given.get(n) ?? [])
        const said = values(uncite(sentence))
        for (const cls of ['numbers', 'dates', 'quotes'] as const) {
          for (const v of said[cls]) if (!holds(cls, v, asked) && !cited.some((s) => holds(cls, v, s))) fail('value-not-contained', v)
        }
      }
    }
  }
  const shown = found ? text : [...text].slice(0, NOT_FOUND_MAX).join('').trimEnd()
  return {
    ok: failures.size === 0, text: shown, found,
    citations: [...new Set(cites(text))].filter((n) => given.has(n)).sort((a, b) => a - b),
    failures: [...failures].map(([rule, vs]) => ({ rule, values: [...new Set(vs)] })),
  }
}
