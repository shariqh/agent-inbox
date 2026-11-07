// The fidelity check (#483, unslop design §6.1-§6.2). Code, not the model,
// decides whether a rewrite kept every protected value. Extraction masks each
// value it takes (same length, newlines kept), so later classes never see it
// and offsets stay valid. Ordering is checked per sentence: output sentences
// are aligned to input sentences by their words, values must keep their order
// inside an aligned sentence, and a value that crossed sentences must keep its
// own neighbours better than any other value's. A text with more than
// MAX_UNITS sentences or values is not compared at all (`tooComplex`). U2a adds
// retry and timing.
const HARD = ['code', 'urls', 'refs', 'numbers', 'dates', 'quotes', 'paths', 'terms', 'negations', 'conditions'] as const
export type HardClass = (typeof HARD)[number]
type WarningClass = 'modal' | 'hedge' | 'short-quote' | 'sentences' | 'headings' | 'negation-added' | 'condition-added'
export type Failure = { class: HardClass; kind: 'lost' | 'added' | 'changed' | 'moved'; lost: string[]; added: string[]; moved?: string[] }
export type FidelityReport = {
  ok: boolean
  /** too many sentences or values to compare in bounded time: callers keep the original */
  tooComplex?: true
  hard: Record<HardClass, 'ok' | 'failed' | 'unchecked'>
  failures: Failure[]
  warnings: Array<{ class: WarningClass; detail: string }>
}

// `key` is what is compared; `value` is what is reported (every negation form shares one key)
type Item = { value: string; key: string; start: number; end: number; sent: number; clause: number; ctx: Set<string>; head: Set<string>; tail: Set<string> }
type Extract = {
  items: Record<HardClass, Item[]>
  soft: Record<'modal' | 'hedge' | 'short-quote', string[]>
  sentences: number
  headings: string[]
  sents: Set<string>[]
  clauses: Set<string>[]
  negatives: number[]
  tooComplex: boolean
}

const MONTHS = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?'
const SEG = String.raw`[\w@~+-](?:[\w.@~+-]*[\w@~+-])?`
const PATH = new RegExp(String.raw`(?<![\w/.~@-])(?:(?:~|\.{1,2})?\/${SEG}(?:\/${SEG})*\/?|${SEG}(?:\/${SEG}){2,}\/?|${SEG}(?:\/${SEG})+\/|(?:${SEG}\/)?[\w-]{2,}(?:\.[\w-]+)*\.[A-Za-z][A-Za-z0-9]{0,4}(?![\w/])|--?[A-Za-z][\w-]*)`, 'g')
const NUMBER = /(?:\b(about|around|roughly|approximately|nearly|almost|up to|at least|at most|more than|less than|fewer than)\s+|(~)\s?)?(?<![\w%+$€£.,:/-])([$€£]?(?:[\w%+-]|[.,:/](?=\w))*\d(?:[\w%+-]|[.,:/](?=\w))*)( %)?/gi
const DROP_ONLY = new Set<HardClass>(['negations', 'conditions'])
const MAX_UNITS = 500
// a dropped one of these pays for one added negation or condition in its clause
const NEGATIVE = /\b(?:fail(?:s|ed|ing)?|lack(?:s|ed|ing)?|unable|missing|refus(?:e|es|ed|ing)|prevent(?:s|ed|ing)?|absent|broken|disabled)\b/gi
const SENTENCE = /[.!?](?=\s)|\n/g
const CLAUSE = /[.!?](?=\s)|\n|[,;:()—–]|\s(?:but|and|or|while|whereas|although|though)(?=\s)/gi
const LOGIC = /^(?:not|never|no|without|cannot|none|nothing|nobody|nowhere|neither|nor|unless|except|until|only|if)$/
const HEDGES = /\b(?:likely|probably|perhaps|possibly|maybe|apparently|seemingly|presumably|arguably|roughly|approximately|around|nearly|almost|somewhat|generally|typically|usually)\b/gi
const STOP = new Set('an the and or but nor of to in on at for with by from as is are was were be been it its this that these those then than so if do does did has have had we you he she they them our your their my me us there here which who what when where how into via per'.split(' '))
const MONTH_NUM = (m: string): string => String('janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(m.slice(0, 3).toLowerCase()) / 3 + 1).padStart(2, '0')
const pad = (n: string | number): string => String(n).padStart(2, '0')

function norm(raw: string[]): string[] {
  return raw.map((t) => t.toLowerCase().replace(/^[^\w#@~/.$]+|[^\w%]+$/g, ''))
    .filter((t) => !STOP.has(t))
    .map((t) => (/^[a-z]+$/.test(t) ? t.replace(/(?<=\w{2}[^s])s$/, '') : t.replace(/'s$/, '')))
    .filter((t) => t.length > 1)
}
const tokens = (s: string): string[] => norm(s.split(/\s+/))

// Window of three raw tokens each side inside the sentence, from the unmasked
// text so nearby protected values count; across sentences only when empty.
function neighbours(text: string, [s, e]: [number, number], start: number, end: number): Set<string> {
  const side = (t: string, fromEnd: boolean): string[] => {
    const raw = t.split(/\s+/).filter(Boolean)
    return norm(fromEnd ? raw.slice(-3) : raw.slice(0, 3))
  }
  const near = [...side(text.slice(Math.min(s, start), start), true), ...side(text.slice(end, Math.max(e, end)), false)]
  return new Set(near.length ? near : [...side(text.slice(Math.max(0, start - 200), start), true), ...side(text.slice(end, end + 200), false)])
}

function spans(w: string, re: RegExp): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let start = 0
  for (const m of w.matchAll(re)) {
    const end = m.index! + m[0].length
    out.push([start, end])
    start = end
  }
  out.push([start, w.length])
  return out
}
const spanOf = (list: Array<[number, number]>, at: number): number => Math.max(0, list.findIndex(([, e]) => at < e))

function extract(input: string, terms: string[]): Extract {
  const orig = input.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
  let w = orig
  const items = Object.fromEntries(HARD.map((c) => [c, [] as Item[]])) as Record<HardClass, Item[]>
  const soft: Extract['soft'] = { modal: [], hedge: [], 'short-quote': [] }
  const take = (cls: HardClass | null, re: RegExp, value: (m: RegExpMatchArray) => string, mask = true): void => {
    const parts: string[] = []
    let last = 0
    for (const m of w.matchAll(re)) {
      const start = m.index!
      const end = start + m[0].length
      if (cls) items[cls].push({ value: value(m), key: '', start, end, sent: 0, clause: 0, ctx: new Set(), head: new Set(), tail: new Set() })
      parts.push(w.slice(last, start), m[0].replace(/[^\n]/g, ' '))
      last = end
    }
    if (mask) w = parts.join('') + w.slice(last)
  }
  const raw = (m: RegExpMatchArray): string => input.slice(m.index!, m.index! + m[0].length)
  take('code', /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\1[ \t]*$/gm, raw)
  take('code', /(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g, raw)
  for (const m of w.matchAll(/"([^"\n]+)"/g)) {
    const q = m[1]!.trim().replace(/\s+/g, ' ')
    if (q.split(' ').length >= 3) items.quotes.push({ value: q, key: q, start: m.index!, end: m.index! + m[0].length, sent: 0, clause: 0, ctx: new Set(), head: new Set(), tail: new Set() })
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
  // pattern 9, "not just X but Y" or "not just X — it's Y", is cut by the rules; its "not" is no negation
  take(null, /(?:\bnot|n't)\s+(?:just|only|merely|simply)\b(?=[^.!?\n]*?(?:\bbut\b|(?:[—–;,]|\s-)\s*(?:it's|it is|this is|that's|that is)\b))/gi, () => '')
  take('numbers', NUMBER, (m) => {
    const n = `${m[3]!.replace(/(\d),(?=\d{3}(?!\d))/g, '$1')}${m[4] ? '%' : ''}`
    return m[1] || m[2] ? `${(m[1] ?? m[2])!.toLowerCase().replace(/\s+/g, ' ')} ${n}` : n
  })
  take('negations', /\b(?:not|never|no|without|cannot|none|nothing|nobody|nowhere|neither|nor)\b|n't\b/gi, (m) => (/^(?:cannot|n't)$/i.test(m[0]) ? 'not' : m[0].toLowerCase()), false)
  take('conditions', /\b(?:unless|except|until|only if)\b/gi, (m) => m[0].toLowerCase(), false)
  soft.modal = [...w.matchAll(/\b(?:may|might|could|should|must|will|won't)\b|'ll\b/gi)].map((m) => (/^(?:won't|'ll)$/i.test(m[0]) ? 'will' : m[0].toLowerCase()))
  soft.hedge = [...w.matchAll(HEDGES)].map((m) => m[0].toLowerCase())
  for (const cls of HARD) for (const item of items[cls]) item.key = cls === 'negations' ? 'not' : item.value
  const sentSpans = spans(w, SENTENCE)
  const clauseSpans = spans(w, CLAUSE)
  const tooComplex = sentSpans.filter(([st, e]) => /\S/.test(w.slice(st, e))).length > MAX_UNITS
    || HARD.reduce((n, cls) => n + items[cls].length, 0) > MAX_UNITS
  for (const cls of tooComplex ? [] : HARD) {
    items[cls].sort((a, b) => a.start - b.start)
    for (const item of items[cls]) {
      item.sent = spanOf(sentSpans, item.start)
      item.clause = spanOf(clauseSpans, item.start)
      item.ctx = neighbours(orig, sentSpans[item.sent]!, item.start, item.end)
      // up to three content words on each side of a negation or condition in its clause
      // (a partial word such as "ca" of "can't" dropped); its output clause must keep one
      if (DROP_ONLY.has(cls)) {
        const [cs, ce] = clauseSpans[item.clause]!
        item.head = new Set(tokens(w.slice(cs, item.start).replace(/\S+$/, '')).filter((t) => !LOGIC.test(t)).slice(-3))
        item.tail = new Set(tokens(w.slice(item.end, ce)).filter((t) => !LOGIC.test(t)).slice(0, 3))
      }
    }
  }
  const lines = w.split('\n')
  const headings = lines.filter((l) => /^\s*#{1,6}\s/.test(l)).map((l) => l.trim().replace(/\s+/g, ' '))
  const sentences = lines.filter((l) => !/^\s*#{1,6}\s/.test(l)).join('\n')
    .split(/(?<!\b(?:e\.g|i\.e|etc|vs|cf))[.!?]+(?=\s|$)|\n/).filter((s) => /[A-Za-z]{2}/.test(s)).length
  return {
    items, soft, sentences, headings,
    sents: sentSpans.map(([st, e]) => new Set(tokens(w.slice(st, e)))),
    clauses: clauseSpans.map(([st, e]) => new Set(tokens(w.slice(st, e)).filter((t) => !LOGIC.test(t)))),
    negatives: clauseSpans.map(([st, e]) => w.slice(st, e).match(NEGATIVE)?.length ?? 0),
    tooComplex,
  }
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

function shared(a: Set<string>, b: Set<string>): number {
  let n = 0
  for (const x of a) if (b.has(x)) n++
  return n
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const n = shared(a, b)
  return n ? n / (a.size + b.size - n) : 0
}

// Each output sentence (or clause) maps to its best-matching input one; ties go to the nearer.
function align(a: Set<string>[], b: Set<string>[]): number[] {
  return b.map((t, j) => {
    let best = 0
    let score = -1
    a.forEach((u, i) => {
      const sc = jaccard(t, u)
      if (sc > score || (sc === score && Math.abs(i - j) < Math.abs(best - j))) [best, score] = [i, sc]
    })
    return best
  })
}

function compare(cls: HardClass, A: Extract, B: Extract, at: number[], clauseAt: () => number[]): Failure | undefined {
  const a = A.items[cls]
  const b = B.items[cls]
  const queue = new Map<string, number[]>()
  a.forEach((item, i) => { const q = queue.get(item.key); if (q) q.push(i); else queue.set(item.key, [i]) })
  const pair = b.map((item) => queue.get(item.key)?.shift() ?? -1)
  const lost = [...queue.values()].flat().sort((x, y) => x - y).map((i) => a[i]!.value)
  // §6.1: negations and conditions are hard on any drop; one added fails unless
  // its clause dropped a negative word ("fails to load" → "does not load"). The
  // credit belongs to the input clause, shared by every output clause aligned to it.
  let credit: number[] | undefined
  const added = b.filter((item, j) => {
    if (pair[j] !== -1) return false
    if (!DROP_ONLY.has(cls)) return true
    const ca = clauseAt()
    if (!credit) {
      credit = [...A.negatives]
      B.negatives.forEach((n, k) => { credit![ca[k]!]! -= n })
    }
    return credit[ca[item.clause]!]!-- <= 0
  }).map((item) => item.value)
  if (lost.length || added.length) return { class: cls, kind: lost.length && added.length ? 'changed' : lost.length ? 'lost' : 'added', lost, added }
  const moved = new Set<number>()
  const order = pair.filter((i) => i >= 0)
  // Inside one aligned sentence the order is strict: a reordering that keeps the
  // meaning is rare, and U2a's retry names these values ("keep them in this order").
  if (order.some((i, k) => k > 0 && i < order[k - 1]!)) {
    const seen = new Map<number, number>()
    b.forEach((out, j) => {
      const i = pair[j]!
      if (i < 0) return
      const inp = a[i]!
      if (inp.sent === at[out.sent]) {
        const prev = seen.get(out.sent) ?? -1
        if (i < prev) moved.add(j)
        seen.set(out.sent, Math.max(prev, i))
        return
      }
      const own = jaccard(inp.ctx, out.ctx)
      if (a.some((other) => other.key !== inp.key && jaccard(other.ctx, out.ctx) >= own)) moved.add(j)
    })
  }
  if (DROP_ONLY.has(cls)) {
    // A negation or condition fails when it had context words on both sides and its
    // output clause lost every one of them (a new subject alone, "This change" →
    // "It", is no move),
    // or when another input clause (two or more shared words) survives around it
    // better than its own clause does.
    const kept = (c: Set<string>, mine: Set<string>): number => (c.size ? shared(c, mine) / c.size : 0)
    const rivals = new Map<string, Array<[number, number]>>()
    b.forEach((out, j) => {
      const i = pair[j]!
      const mine = B.clauses[out.clause]!
      const inp = a[i]
      if (inp && inp.head.size && inp.tail.size && !shared(inp.head, mine) && !shared(inp.tail, mine)) moved.add(j)
      if (i < 0 || !mine.size) return
      const key = [...mine].join(' ')
      if (!rivals.has(key)) {
        rivals.set(key, A.clauses.flatMap((c, k): Array<[number, number]> => (shared(c, mine) >= 2 ? [[kept(c, mine), k]] : []))
          .sort((x, y) => y[0] - x[0]).slice(0, 2))
      }
      const own = kept(A.clauses[a[i]!.clause]!, mine)
      if (rivals.get(key)!.some(([score, k]) => k !== a[i]!.clause && score > own)) moved.add(j)
    })
  }
  return moved.size ? { class: cls, kind: 'moved', lost: [], added: [], moved: [...moved].sort((x, y) => x - y).map((j) => b[j]!.value) } : undefined
}

export function checkFidelity(input: string, output: string, options: { terms?: string[] } = {}): FidelityReport {
  const terms = options.terms ?? []
  const a = extract(input, terms)
  const b = extract(output, terms.filter((t) => a.items.terms.some((i) => i.value === t)))
  if (a.tooComplex || b.tooComplex) {
    const hard = Object.fromEntries(HARD.map((cls) => [cls, 'unchecked'])) as FidelityReport['hard']
    return { ok: false, tooComplex: true, hard, failures: [], warnings: [] }
  }
  const at = align(a.sents, b.sents)
  let clauseAt: number[] | undefined
  const failures = HARD.map((cls) => compare(cls, a, b, at, () => (clauseAt ??= align(a.clauses, b.clauses))))
    .filter((f): f is Failure => Boolean(f))
  const hard = Object.fromEntries(HARD.map((cls) => [cls, failures.some((f) => f.class === cls) ? 'failed' : 'ok'])) as FidelityReport['hard']
  const warnings: FidelityReport['warnings'] = []
  for (const cls of ['modal', 'hedge', 'short-quote'] as const) {
    const lost = minus(a.soft[cls], b.soft[cls])
    const added = minus(b.soft[cls], a.soft[cls])
    if (lost.length || added.length) warnings.push({ class: cls, detail: `${lost.join(', ') || 'none'} → ${added.join(', ') || 'none'}` })
  }
  for (const [cls, warn] of [['negations', 'negation-added'], ['conditions', 'condition-added']] as const) {
    const left = a.items[cls].map((i) => i.key)
    const added = b.items[cls].filter((i) => { const k = left.indexOf(i.key); if (k >= 0) left.splice(k, 1); return k < 0 }).map((i) => i.value)
    if (added.length && hard[cls] === 'ok') warnings.push({ class: warn, detail: added.join(', ') })
  }
  if (b.sentences < a.sentences * 0.8) warnings.push({ class: 'sentences', detail: `${a.sentences} → ${b.sentences}` })
  if (a.headings.join('\n') !== b.headings.join('\n')) warnings.push({ class: 'headings', detail: `${a.headings.length} → ${b.headings.length}` })
  return { ok: failures.length === 0, hard, failures, warnings }
}
