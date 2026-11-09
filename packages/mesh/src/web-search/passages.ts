// Passages (web search design §6): page text is cut at 200 KB and loses images, link
// targets (keeping the link text), HTML and control characters; it is split at headings
// and blank lines into chunks of about 200-800 characters; chunks that are mostly link
// text, navigation or under 40 characters of words are dropped. Every chunk of the task
// is scored by BM25 against the query, with a small bonus for a page's first chunk, and
// each source keeps its top 3 chunks, at most 2,400 characters, in page order.
export const PAGE_CUT = 200_000
export const KEEP_CHUNKS = 3
export const KEEP_CHARS = 2400
import { visible } from './suspect.js'

const MIN = 200
const MAX = 800
const MIN_WORD_CHARS = 40
const FIRST_BONUS = 0.25
const LINK = /\[([^\]\n]{0,500})\]\([^)\s]{0,2048}(?:\s+"[^"\n]{0,500}")?\)/g

const clean = (text: string): string => visible(text.slice(0, PAGE_CUT))
  .replace(/!\[[^\]\n]{0,500}\]\([^)\n]{0,2048}\)/g, '')
  .replace(/!\[/g, '[')
  .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
  .replace(/<[^>\n]{0,500}>/g, '')

const sentences = (text: string): string[] => {
  const out: string[] = []
  let rest = text
  while (rest.length > MAX) {
    const window = rest.slice(0, MAX)
    const end = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '))
    const cut = end >= MIN ? end + 1 : (window.lastIndexOf(' ') > MIN ? window.lastIndexOf(' ') : MAX)
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  return rest ? [...out, rest] : out
}

const plain = (chunk: string): string => chunk.replace(LINK, '$1')
/** Mostly link text, or a menu: many lines of a few words each. */
function navigation(block: string): boolean {
  const text = plain(block)
  const linkChars = [...block.matchAll(LINK)].reduce((n, m) => n + m[1]!.length, 0)
  const lines = text.split('\n').filter((l) => l.trim())
  return linkChars > text.trim().length / 2 || (lines.length >= 4 && lines.filter((l) => l.trim().split(/\s+/).length <= 3).length / lines.length >= 0.6)
}

/** A page's chunks: navigation blocks go before short blocks merge, so a menu never rides along with content. */
export function chunks(page: string): string[] {
  const blocks = clean(page).split(/\n\s*\n|\n(?=#{1,6}\s)/).map((b) => b.trim()).filter((b) => b && !navigation(b)).map(plain).flatMap(sentences)
  const out: string[] = []
  for (const block of blocks) {
    const last = out.at(-1)
    if (last !== undefined && last.length < MIN && last.length + block.length + 2 <= MAX) out[out.length - 1] = `${last}\n\n${block}`
    else out.push(block)
  }
  return out.filter((c) => (c.match(/\p{L}+/gu) ?? []).join('').length >= MIN_WORD_CHARS)
}

const terms = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []

/** For each page (or snippet), the passages it keeps, scored over every chunk of the task. */
export function rankPassages(query: string, pages: Array<{ text: string; whole: boolean }>): string[][] {
  const perPage = pages.map((p) => (p.whole ? chunks(p.text) : [clean(p.text).trim()].filter(Boolean)))
  const all = perPage.flat().map(terms)
  const avg = all.reduce((n, t) => n + t.length, 0) / Math.max(1, all.length)
  const q = [...new Set(terms(query))]
  const df = new Map(q.map((t) => [t, all.filter((c) => c.includes(t)).length]))
  const bm25 = (tokens: string[]): number => q.reduce((score, t) => {
    const tf = tokens.filter((x) => x === t).length
    const n = df.get(t)!
    const idf = Math.log(1 + (all.length - n + 0.5) / (n + 0.5))
    return score + (tf === 0 ? 0 : (idf * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * tokens.length) / (avg || 1))))
  }, 0)
  return perPage.map((list) => {
    const ranked = list.map((text, i) => ({ text, i, score: bm25(terms(text)) + (i === 0 ? FIRST_BONUS : 0) })).sort((a, b) => b.score - a.score || a.i - b.i)
    const kept: typeof ranked = []
    let chars = 0
    for (const c of ranked) {
      if (kept.length === KEEP_CHUNKS) break
      const text = c.text.slice(0, KEEP_CHARS)
      if (chars + text.length > KEEP_CHARS) continue
      kept.push({ ...c, text })
      chars += text.length
    }
    return kept.sort((a, b) => a.i - b.i).map((c) => c.text)
  })
}
