// The fidelity check (#483, unslop design §6.1-§6.2). Code, not the model,
// decides whether a rewrite kept every protected value. Extraction masks each
// value it takes (same length, newlines kept), so later classes never see it
// and offsets stay valid for the neighbour check. U2a adds retry and timing.
const HARD = ['code', 'urls', 'refs', 'numbers', 'dates', 'quotes', 'paths', 'terms', 'negations', 'conditions'] as const
export type HardClass = (typeof HARD)[number]
type WarningClass = 'modal' | 'hedge' | 'short-quote' | 'sentences' | 'headings' | 'negation-added' | 'condition-added'
export type Failure = { class: HardClass; kind: 'lost' | 'added' | 'changed' | 'moved'; lost: string[]; added: string[]; moved?: string[] }
export type FidelityReport = {
  ok: boolean
  hard: Record<HardClass, 'ok' | 'failed'>
  failures: Failure[]
  warnings: Array<{ class: WarningClass; detail: string }>
}

type Item = { value: string; start: number; end: number; ctx: Set<string> }
type Extract = { items: Record<HardClass, Item[]>; soft: Record<'modal' | 'hedge' | 'short-quote', string[]>; sentences: number; headings: string[] }

const MONTHS = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?'
const SEG = String.raw`[\w@~+-](?:[\w.@~+-]*[\w@~+-])?`
const PATH = new RegExp(String.raw`(?<![\w/.~@-])(?:(?:~|\.{1,2})?\/${SEG}(?:\/${SEG})*\/?|${SEG}(?:\/${SEG}){2,}\/?|${SEG}(?:\/${SEG})+\/|(?:${SEG}\/)?[\w-]{2,}(?:\.[\w-]+)*\.[A-Za-z][A-Za-z0-9]{0,4}(?![\w/])|--?[A-Za-z][\w-]*)`, 'g')
const NUMBER = /(?:\b(about|around|roughly|approximately|nearly|almost|up to|at least|at most|more than|less than|fewer than)\s+|(~)\s?)?(?<![\w%+$€£.,:/-])([$€£]?(?:[\w%+-]|[.,:/](?=\w))*\d(?:[\w%+-]|[.,:/](?=\w))*)( %)?/gi
const DROP_ONLY = new Set<HardClass>(['negations', 'conditions'])
const HEDGES = /\b(?:likely|probably|perhaps|possibly|maybe|apparently|seemingly|presumably|arguably|roughly|approximately|around|nearly|almost|somewhat|generally|typically|usually)\b/gi
const STOP = new Set('an the and or but nor of to in on at for with by from as is are was were be been it its this that these those then than so if do does did has have had we you he she they them our your their my me us there here which who what when where how into via per'.split(' '))
const MONTH_NUM = (m: string): string => String('janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(m.slice(0, 3).toLowerCase()) / 3 + 1).padStart(2, '0')
const pad = (n: string | number): string => String(n).padStart(2, '0')

function words(seg: string, fromEnd: boolean): string[] {
  const all = seg.match(/[A-Za-z][\w'-]*/g) ?? []
  return (fromEnd ? all.slice(-3) : all.slice(0, 3))
    .map((w) => w.toLowerCase().replace(/'s$/, '').replace(/(?<=\w{3})s$/, ''))
    .filter((w) => w.length > 1 && !STOP.has(w))
}

function neighbours(w: string, start: number, end: number): Set<string> {
  const left = w.slice(0, start)
  const right = w.slice(end)
  const near = [...words(left.split(/[.!?]\s|\n/).pop() ?? '', true), ...words(right.split(/[.!?](?:\s|$)|\n/)[0] ?? '', false)]
  return new Set(near.length ? near : [...words(left, true), ...words(right, false)])
}

function extract(input: string, terms: string[]): Extract {
  const orig = input.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
  let w = orig
  const items = Object.fromEntries(HARD.map((c) => [c, [] as Item[]])) as Record<HardClass, Item[]>
  const soft: Extract['soft'] = { modal: [], hedge: [], 'short-quote': [] }
  const take = (cls: HardClass | null, re: RegExp, value: (m: RegExpMatchArray) => string, mask = true): void => {
    for (const m of [...w.matchAll(re)]) {
      const start = m.index!
      const end = start + m[0].length
      if (cls) items[cls].push({ value: value(m), start, end, ctx: new Set() })
      if (mask) w = w.slice(0, start) + m[0].replace(/[^\n]/g, ' ') + w.slice(end)
    }
  }
  const raw = (m: RegExpMatchArray): string => input.slice(m.index!, m.index! + m[0].length)
  take('code', /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\1[ \t]*$/gm, raw)
  take('code', /(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g, raw)
  for (const m of w.matchAll(/"([^"\n]+)"/g)) {
    const q = m[1]!.trim().replace(/\s+/g, ' ')
    if (q.split(' ').length >= 3) items.quotes.push({ value: q, start: m.index!, end: m.index! + m[0].length, ctx: new Set() })
    else soft['short-quote'].push(q)
  }
  take('urls', /\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g, (m) => m[1]!)
  take('urls', /<(https?:\/\/[^>\s]+)>/g, (m) => m[1]!)
  take('urls', /\bhttps?:\/\/[^\s<>()[\]"'`]*[^\s<>()[\]"'`.,;:!?]/g, (m) => m[0])
  for (const term of terms.filter((t) => t && w.includes(t))) {
    take('terms', new RegExp(`(?<!\\w)${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\w)`, 'g'), (m) => m[0], false)
  }
  take('refs', /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, (m) => m[0].toLowerCase())
  take('refs', /(?<![\w&])(?:[\w.-]+\/[\w.-]+)?#\d+\b/g, (m) => m[0])
  take('paths', PATH, (m) => m[0])
  take('refs', /(?<![\w@./])@[A-Za-z0-9][\w-]*/g, (m) => m[0])
  take('refs', /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g, (m) => m[0])
  take('dates', /\b(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?\b/g, (m) => `${m[1]}-${m[2]}-${m[3]}${m[4] ? `T${m[4]}:${m[5]}` : ''}`)
  take('dates', new RegExp(String.raw`\b(${MONTHS})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4})\b)?`, 'g'), (m) => `${m[3] ?? '-'}-${MONTH_NUM(m[1]!)}-${pad(m[2]!)}`)
  take('dates', new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTHS})(?![a-z])\.?(?:,?\s+(\d{4})\b)?`, 'g'), (m) => `${m[3] ?? '-'}-${MONTH_NUM(m[2]!)}-${pad(m[1]!)}`)
  take('dates', new RegExp(String.raw`\b(${MONTHS})\.?\s+(\d{4})\b`, 'g'), (m) => `${m[2]}-${MONTH_NUM(m[1]!)}`)
  take('dates', /\b(\d{1,2}):(\d{2})(?:\s?([ap])\.?m\b)?|\b(\d{1,2})\s?([ap])\.?m\b/gi, (m) => {
    let h = Number(m[1] ?? m[4])
    const ap = (m[3] ?? m[5])?.toLowerCase()
    if (ap === 'p' && h < 12) h += 12
    if (ap === 'a' && h === 12) h = 0
    return `${pad(h)}:${m[2] ?? '00'}`
  })
  take(null, /^[ \t]*\d+[.)](?=[ \t])/gm, () => '')
  take(null, /(?:\bnot|n't)\s+(?:just|only|merely|simply)\b(?=[^.!?\n]*\bbut\b)/gi, () => '')
  take('numbers', NUMBER, (m) => {
    const n = `${m[3]!.replace(/(\d),(?=\d{3}(?!\d))/g, '$1')}${m[4] ? '%' : ''}`
    return m[1] || m[2] ? `${(m[1] ?? m[2])!.toLowerCase().replace(/\s+/g, ' ')} ${n}` : n
  })
  take('negations', /\b(?:not|never|no|without|cannot)\b|n't\b/gi, (m) => (/^(?:cannot|n't)$/i.test(m[0]) ? 'not' : m[0].toLowerCase()), false)
  take('conditions', /\b(?:unless|except|until|only if)\b/gi, (m) => m[0].toLowerCase(), false)
  soft.modal = [...w.matchAll(/\b(?:may|might|could|should|must|will|won't)\b|'ll\b/gi)].map((m) => (/^(?:won't|'ll)$/i.test(m[0]) ? 'will' : m[0].toLowerCase()))
  soft.hedge = [...w.matchAll(HEDGES)].map((m) => m[0].toLowerCase())
  for (const cls of HARD) {
    items[cls].sort((a, b) => a.start - b.start)
    for (const item of items[cls]) item.ctx = neighbours(w, item.start, item.end)
  }
  const lines = w.split('\n')
  const headings = lines.filter((l) => /^\s*#{1,6}\s/.test(l)).map((l) => l.trim().replace(/\s+/g, ' '))
  const sentences = lines.filter((l) => !/^\s*#{1,6}\s/.test(l)).join('\n')
    .split(/(?<!\b(?:e\.g|i\.e|etc|vs|cf))[.!?]+(?=\s|$)|\n/).filter((s) => /[A-Za-z]{2}/.test(s)).length
  return { items, soft, sentences, headings }
}

function minus(a: string[], b: string[]): string[] {
  const left = [...b]
  return a.filter((v) => {
    const i = left.indexOf(v)
    if (i < 0) return true
    left.splice(i, 1)
    return false
  })
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const shared = [...a].filter((x) => b.has(x)).length
  const all = new Set([...a, ...b]).size
  return all ? shared / all : 0
}

function compare(cls: HardClass, a: Item[], b: Item[]): Failure | undefined {
  const av = a.map((i) => i.value)
  const bv = b.map((i) => i.value)
  const lost = minus(av, bv)
  const added = minus(bv, av)
  if (lost.length || added.length) {
    // §6.1: negations and conditions are hard on any drop; one added alone is a warning
    if (!lost.length && DROP_ONLY.has(cls)) return undefined
    return { class: cls, kind: lost.length && added.length ? 'changed' : lost.length ? 'lost' : 'added', lost, added }
  }
  if (av.every((v, i) => v === bv[i])) return undefined
  const at = new Map<string, number[]>()
  bv.forEach((v, k) => { const list = at.get(v); if (list) list.push(k); else at.set(v, [k]) })
  const moved = a.filter((item, i) => {
    const j = at.get(item.value)!.shift()!
    const out = b[j]!
    if (i === j) return false
    const own = jaccard(item.ctx, out.ctx)
    if (own === 0 && item.ctx.size + out.ctx.size > 0) return true
    return a.some((other) => other.value !== item.value && jaccard(other.ctx, out.ctx) > own)
  }).map((item) => item.value)
  return moved.length ? { class: cls, kind: 'moved', lost: [], added: [], moved } : undefined
}

export function checkFidelity(input: string, output: string, options: { terms?: string[] } = {}): FidelityReport {
  const terms = options.terms ?? []
  const a = extract(input, terms)
  const b = extract(output, terms.filter((t) => a.items.terms.some((i) => i.value === t)))
  const failures = HARD.map((cls) => compare(cls, a.items[cls], b.items[cls])).filter((f): f is Failure => Boolean(f))
  const hard = Object.fromEntries(HARD.map((cls) => [cls, failures.some((f) => f.class === cls) ? 'failed' : 'ok'])) as FidelityReport['hard']
  const warnings: FidelityReport['warnings'] = []
  for (const cls of ['modal', 'hedge', 'short-quote'] as const) {
    const lost = minus(a.soft[cls], b.soft[cls])
    const added = minus(b.soft[cls], a.soft[cls])
    if (lost.length || added.length) warnings.push({ class: cls, detail: `${lost.join(', ') || 'none'} → ${added.join(', ') || 'none'}` })
  }
  for (const [cls, warn] of [['negations', 'negation-added'], ['conditions', 'condition-added']] as const) {
    const added = minus(b.items[cls].map((i) => i.value), a.items[cls].map((i) => i.value))
    if (added.length && hard[cls] === 'ok') warnings.push({ class: warn, detail: added.join(', ') })
  }
  if (b.sentences < a.sentences * 0.8) warnings.push({ class: 'sentences', detail: `${a.sentences} → ${b.sentences}` })
  if (a.headings.join('\n') !== b.headings.join('\n')) warnings.push({ class: 'headings', detail: `${a.headings.length} → ${b.headings.length}` })
  return { ok: failures.length === 0, hard, failures, warnings }
}
