// unslop-code's guards (step 1 of 4). The model never returns code: it answers
// with line numbers, and this module decides what may go and makes the edit.
// A line is removed only when the model listed it, the change added it, it holds
// one whole-line `//` comment and nothing else, it is not the explanation above a
// declaration, and the model did not also claim it as a comment to keep. Every
// doubt resolves to "do not remove": an unreadable answer, a line out of range, a
// file the scanner cannot read with certainty. Block comments are never removed.
//
// The scanner is our own, with no dependency, and conservative: wherever it cannot
// be certain how a `/` or a `<` is to be read (regular expression or division, JSX
// or a comparison), or meets anything else it does not model, the whole file is
// `unsure` and nothing in it is touched. JSX is not modelled: unless the caller
// passes `jsx: false`, a `<` where an expression starts makes the file unsure.
// `jsx: false` is for `.ts`, `.mts` and `.cts` sources, which cannot hold JSX, so
// such a `<` opens type parameters or a type assertion; a `.js` file can hold JSX,
// so it is read with the default. A lone CR, U+2028 or U+2029 makes a file unsure
// too, so a line here is always what git calls a line. test/code-slop.test.ts checks it against the
// TypeScript compiler on every source file of this repository.

export type SuggestionKind = 'defensive' | 'trycatch' | 'cast' | 'nesting' | 'other'
export type Suggestion = { line: number; kind: SuggestionKind }
export type DropReason = 'out-of-change' | 'not-a-comment' | 'above-a-declaration' | 'claimed-kept' | 'unsure'
export type Decision = { remove: number[]; dropped: { line: number; why: DropReason }[] }
export type CommentLines = { whole: Set<number>; doc: Set<number>; unsure: boolean }

const MAX_POINTS = 2000
const MAX_SUGGESTIONS = 200
const MAX_ANSWER = 200_000
const MAX_OBJECTS = 200
const SUGGESTION_KINDS: readonly SuggestionKind[] = ['defensive', 'trycatch', 'cast', 'nesting', 'other']

// ---- lines ---------------------------------------------------------------------------

/** The source's lines, each with its own terminator (the last may have none); `''` has none. */
function splitLines(source: string): string[] {
  const out: string[] = []
  for (let at = 0; at < source.length;) {
    const nl = source.indexOf('\n', at)
    const end = nl < 0 ? source.length : nl + 1
    out.push(source.slice(at, end))
    at = end
  }
  return out
}
const bare = (line: string): string => line.replace(/\r?\n$/, '')

/** The text a model is shown: right-aligned 1-based line numbers, then `| `. */
export function numbered(source: string): string {
  const lines = splitLines(source)
  const width = String(lines.length).length
  return lines.map((line, i) => `${String(i + 1).padStart(width)}| ${bare(line)}`).join('\n')
}

// ---- the model's answers --------------------------------------------------------------

/** The index of the `}` that closes the object opening at `open`, JSON strings respected; -1 when none. */
function closeOf(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++
    } else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return i
  }
  return -1
}
/** The value of `key` in the first JSON object of the answer that has it; text and fences around it are ignored. */
function answerValue(raw: string, key: string): unknown {
  const text = raw.slice(0, MAX_ANSWER)
  for (let from = 0, tries = 0; tries < MAX_OBJECTS; tries++) {
    const open = text.indexOf('{', from)
    if (open < 0) return undefined
    const close = closeOf(text, open)
    if (close < 0) return undefined
    try {
      const value: unknown = JSON.parse(text.slice(open, close + 1))
      if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key)) return (value as Record<string, unknown>)[key]
    } catch { /* not JSON: try the next brace */ }
    from = open + 1
  }
  return undefined
}
const isLine = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0

/** `{"remove":[3,7]}` or `{"keep":[1,2]}`: positive integers, duplicates removed; null when unreadable. */
export function parsePoints(raw: string, key: 'remove' | 'keep'): number[] | null {
  const list = answerValue(raw, key)
  if (!Array.isArray(list)) return null
  return [...new Set(list.slice(0, MAX_POINTS).filter(isLine))]
}

/** `{"suggest":[{"line":12,"kind":"trycatch"}]}`; an entry with another kind or no line is dropped. */
export function parseSuggestions(raw: string): Suggestion[] | null {
  const list = answerValue(raw, 'suggest')
  if (!Array.isArray(list)) return null
  const out: Suggestion[] = []
  for (const entry of list.slice(0, MAX_SUGGESTIONS)) {
    if (!entry || typeof entry !== 'object') continue
    const { line, kind } = entry as { line?: unknown; kind?: unknown }
    if (isLine(line) && SUGGESTION_KINDS.includes(kind as SuggestionKind)) out.push({ line, kind: kind as SuggestionKind })
  }
  return out
}

/** The suggestions on lines the change added, by line, one per line and kind. */
export function suggestionsFor(list: Suggestion[] | null, added: Iterable<number>): Suggestion[] {
  const lines = new Set(added)
  const seen = new Set<string>()
  return (list ?? []).filter((s) => lines.has(s.line) && !seen.has(`${s.line} ${s.kind}`) && seen.add(`${s.line} ${s.kind}`))
    .sort((a, b) => a.line - b.line || SUGGESTION_KINDS.indexOf(a.kind) - SUGGESTION_KINDS.indexOf(b.kind))
}

// ---- the scanner ----------------------------------------------------------------------

type Kind = 'name' | 'num' | 'str' | 'tpl' | 'regex' | 'punct' | 'hashbang' | 'line' | 'block'
// block: statements; fn: a function's body; class: class or interface members; object:
// an object literal, type literal, enum or import/export list; colon: a brace after `:`
// (an object, or a labelled or case block); module: a namespace body; unknown: anything else
type BraceKind = 'block' | 'fn' | 'class' | 'object' | 'colon' | 'module' | 'unknown'
type Frame = { t: '{'; kind: BraceKind } | { t: '('; cond: boolean } | { t: '[' } | { t: '${' }
type Token = {
  kind: Kind
  start: number
  end: number
  /** a template part that opens a substitution (`` `…${ `` or `}…${`) */
  open?: boolean
  /** `)` and `}`: the frame they closed */
  closed?: Frame
  /** the innermost frame the token sits in (undefined at the top level) */
  inside?: Frame
  /** whether the token ends an expression, so what follows is an operator */
  ends?: boolean | 'unsure'
}
class Unsure extends Error {}
const unsure = (why: string): never => { throw new Unsure(why) }

const PUNCTUATORS = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??',
  '?.', '++', '--', '+=', '-=', '*=', '%=', '&=', '|=', '^=', '**', '<<', '>>', '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '%',
  '&', '|', '^', '!', '~', '?', ':', '=', '.', '@', '#']
// after these words an expression starts, so a `/` begins a regular expression
const BEFORE_EXPRESSION = new Set(['return', 'typeof', 'instanceof', 'in', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'extends'])
// words that are a keyword or a plain name depending on context
const AMBIGUOUS = new Set(['of', 'yield', 'await', 'let'])
const CONDITION = new Set(['if', 'while', 'for', 'with', 'switch', 'catch'])
const BLOCK_AFTER = new Set(['else', 'try', 'finally', 'do'])
const OBJECT_AFTER = new Set(['export', 'import', 'return', 'typeof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'yield', 'await', 'as',
  'satisfies', 'keyof', 'extends', 'default'])
const SPACE = /[\t\v\f \u00a0\ufeff\p{Zs}]/u
const NAME = /(?:[$_\p{ID_Start}]|\\u(?:[\dA-Fa-f]{4}|\{[\dA-Fa-f]+\}))(?:[$_\u200c\u200d\p{ID_Continue}]|\\u(?:[\dA-Fa-f]{4}|\{[\dA-Fa-f]+\}))*/uy
const NUMBER = /(?:0[xX][\dA-Fa-f_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)n?/y
const FLAGS = /[$_\u200c\u200d\p{ID_Continue}]*/uy

/** Every token of the source, comments included, or Unsure. */
function tokenize(src: string, jsx: boolean): Token[] {
  if (/\r(?!\n)|[\u2028\u2029]/.test(src)) unsure('a line terminator git does not count')
  const tokens: Token[] = []
  const stack: Frame[] = []
  let prev: Token | undefined
  let prev2: Token | undefined
  let pending: { kind: BraceKind; depth: number; word: Token } | undefined
  const text = (t: Token | undefined): string => (t ? src.slice(t.start, t.end) : '')
  const isPunct = (t: Token | undefined, ...values: string[]): boolean => t?.kind === 'punct' && values.includes(text(t))
  const property = (): boolean => isPunct(prev2, '.', '?.')
  const push = (t: Token): void => {
    t.inside = stack[stack.length - 1]
    tokens.push(t)
    if (t.kind === 'line' || t.kind === 'block') return
    // `namespace` and `module` begin a heading only when a name or a string follows them
    if (pending && prev === pending.word && pending.kind === 'module' && t.kind !== 'name' && t.kind !== 'str') pending = undefined
    t.ends = ends(t, prev)
    prev2 = prev
    prev = t
  }

  const ends = (t: Token, before: Token | undefined): boolean | 'unsure' => {
    const word = text(t)
    switch (t.kind) {
      case 'hashbang': return false
      case 'tpl': return !t.open
      case 'name': return isPunct(before, '.', '?.') ? true : BEFORE_EXPRESSION.has(word) ? false : AMBIGUOUS.has(word) ? 'unsure' : true
      case 'punct': break
      default: return true
    }
    switch (word) {
      case ')': return !(t.closed?.t === '(' && t.closed.cond)
      case ']': return true
      case '}': {
        const kind = t.closed?.t === '{' ? t.closed.kind : 'unknown'
        return kind === 'block' || kind === 'module' ? false : kind === 'object' ? true : 'unsure'
      }
      // closes a type argument list, or compares
      case '>': return 'unsure'
      case '!': case '++': case '--': {
        // postfix (`x++`, TypeScript's non-null `x!`) only right after an expression on the same line
        if (!before || src.slice(before.end, t.start).includes('\n')) return false
        return before.ends === true ? true : before.ends === 'unsure' ? 'unsure' : false
      }
      default: return false
    }
  }

  /** Whether an expression may start here: yes (a `/` is a regular expression), no (an operator), or unsure. */
  const expressionStarts = (): 'yes' | 'no' | 'unsure' => (!prev ? 'yes' : prev.ends === true ? 'no' : prev.ends === 'unsure' ? 'unsure' : 'yes')

  const braceKind = (): BraceKind => {
    // the body follows the heading's last name, string, `>` or `)`; after `extends` a brace is a type or an object
    const heading = (prev?.kind === 'name' && !['extends', 'implements'].includes(text(prev))) || prev?.kind === 'str' || isPunct(prev, '>', ')')
    if (pending && pending.depth === stack.length && heading) {
      const kind = pending.kind
      pending = undefined
      return kind
    }
    if (!prev) return 'block'
    const word = text(prev)
    if (prev.kind === 'punct') {
      if ([';', '{', '}'].includes(word)) return 'block'
      if (word === ')') return prev.closed?.t === '(' && prev.closed.cond ? 'block' : 'fn'
      if (word === '=>' || word === ']' || word === '>') return 'fn'
      if (word === ':') return 'colon'
      return 'object'
    }
    if (prev.kind === 'name') {
      if (property()) return 'unknown'
      if (BLOCK_AFTER.has(word)) return 'block'
      if (word === 'static') return 'block'
      // a return type, `): void {`: the body of a function, not the operand of the `void` operator
      if (word === 'void' && isPunct(prev2, ':')) return 'fn'
      if (OBJECT_AFTER.has(word)) return 'object'
      return 'fn' // a return type: `): string {`
    }
    if (prev.kind === 'tpl' && prev.open) return 'object'
    return 'unknown'
  }

  /** A template part from `from` (just after `` ` `` or the `}` closing a substitution). */
  const template = (start: number, from: number): void => {
    for (let j = from; j < src.length; j++) {
      const ch = src[j]
      if (ch === '\\') j++
      else if (ch === '`') return push({ kind: 'tpl', start, end: j + 1 })
      else if (ch === '$' && src[j + 1] === '{') {
        push({ kind: 'tpl', start, end: j + 2, open: true })
        stack.push({ t: '${' })
        return
      }
    }
    unsure('an unclosed template literal')
  }

  let i = 0
  if (src.startsWith('#!')) {
    const nl = src.indexOf('\n')
    i = nl < 0 ? src.length : nl
    if (src[i - 1] === '\r') i--
    push({ kind: 'hashbang', start: 0, end: i })
  }
  while (i < src.length) {
    const ch = src[i]!
    const start = i
    if (ch === '\n' || ch === '\r' || SPACE.test(ch)) { i++; continue }
    if (ch === '/' && src[i + 1] === '/') {
      let end = src.indexOf('\n', i)
      if (end < 0) end = src.length
      if (src[end - 1] === '\r') end--
      push({ kind: 'line', start, end })
      i = end
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2)
      if (close < 0) unsure('an unclosed block comment')
      i = close + 2
      push({ kind: 'block', start, end: i })
      continue
    }
    if (ch === '/') {
      const reading = expressionStarts()
      if (reading === 'unsure') unsure('a `/` that may be division or a regular expression')
      if (reading === 'no') {
        i += src[i + 1] === '=' ? 2 : 1
        push({ kind: 'punct', start, end: i })
        continue
      }
      let inClass = false
      for (i++; ; i++) {
        const c = src[i]
        if (c === undefined || c === '\n' || c === '\r') unsure('an unterminated regular expression')
        if (c === '\\') {
          if (src[i + 1] === '\n' || src[i + 1] === '\r' || src[i + 1] === undefined) unsure('an unterminated regular expression')
          i++
        } else if (inClass) inClass = c !== ']'
        else if (c === '[') inClass = true
        else if (c === '/') break
      }
      i++
      FLAGS.lastIndex = i
      FLAGS.exec(src)
      if (src.slice(i, FLAGS.lastIndex).includes('v')) unsure('a regular expression with the v flag (nested classes)')
      i = FLAGS.lastIndex
      push({ kind: 'regex', start, end: i })
      continue
    }
    if (ch === '`') { template(start, i + 1); i = tokens[tokens.length - 1]!.end; continue }
    if (ch === '}' && stack[stack.length - 1]?.t === '${') {
      stack.pop()
      template(start, i + 1)
      i = tokens[tokens.length - 1]!.end
      continue
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1
      for (; ; j++) {
        const c = src[j]
        if (c === undefined || c === '\n' || c === '\r') unsure('an unterminated string')
        if (c === ch) break
        if (c === '\\') j += src[j + 1] === '\r' && src[j + 2] === '\n' ? 2 : 1
      }
      i = j + 1
      push({ kind: 'str', start, end: i })
      continue
    }
    NUMBER.lastIndex = i
    if (/[\d.]/.test(ch) && NUMBER.exec(src)) {
      i = NUMBER.lastIndex
      push({ kind: 'num', start, end: i })
      continue
    }
    NAME.lastIndex = i
    if (NAME.exec(src)) {
      i = NAME.lastIndex
      const token: Token = { kind: 'name', start, end: i }
      push(token)
      const word = src.slice(start, i)
      if (!property() && (word === 'class' || word === 'interface' || word === 'enum' || word === 'namespace' || word === 'module')) {
        pending = { kind: word === 'enum' ? 'object' : word === 'namespace' || word === 'module' ? 'module' : 'class', depth: stack.length, word: token }
      }
      continue
    }
    // without JSX, a `<` that starts an expression opens TypeScript type parameters or a type assertion
    if (ch === '<' && jsx && expressionStarts() !== 'no') unsure('a `<` where an expression starts, in a source that may hold JSX')
    const punct = PUNCTUATORS.find((p) => src.startsWith(p, i) && !(p === '?.' && /\d/.test(src[i + 2] ?? '')))
    if (!punct) return unsure('a character the scanner does not model')
    i += punct.length
    const token: Token = { kind: 'punct', start, end: i }
    if (punct === '(' || punct === '[' || punct === '{') {
      const frame: Frame = punct === '(' ? { t: '(', cond: prev?.kind === 'name' && !property() && (CONDITION.has(text(prev)) || (text(prev) === 'await' && text(prev2) === 'for')) }
        : punct === '[' ? { t: '[' } : { t: '{', kind: braceKind() }
      push(token)
      stack.push(frame)
      continue
    }
    if (punct === ')' || punct === ']' || punct === '}') {
      const frame = stack.pop()
      if (!frame || frame.t !== ({ ')': '(', ']': '[', '}': '{' } as const)[punct]) unsure('unbalanced brackets')
      token.closed = frame
    }
    if (punct === ';' && pending?.depth === stack.length) pending = undefined
    push(token)
  }
  if (stack.length) unsure('unbalanced brackets')
  return tokens
}

function scan(src: string, opts: { jsx?: boolean }): Token[] | undefined {
  try {
    return tokenize(src, opts.jsx !== false)
  } catch (error) {
    if (error instanceof Unsure) return undefined
    throw error
  }
}

// ---- comment lines --------------------------------------------------------------------

const MODIFIERS = String.raw`(?:(?:export|default|async|declare|abstract)\s+)*`
const DECLARATION = new RegExp(String.raw`^${MODIFIERS}(?:function\b|class\b|interface\s|enum\s|type\s+[$_\p{ID_Start}])`, 'u')
const VARIABLE = new RegExp(String.raw`^${MODIFIERS}(?:const|let|var)\s`)
// a variable that holds a function: `const f = (a) =>`, `let g = async function`
const FUNCTION_VALUE = /^(?:const|let|var)\s+[$\w]+\s*(?::[^=]*)?=\s*(?:async\s*)?(?:function\b|(?:\([^)]*\)|[$\w]+)\s*(?::[^=]*?)?=>)/
// a function or class assigned to a name or a property: `exports.run = (a) =>`, `A.prototype.m = function`
const ASSIGNED_FUNCTION = /^[$\w][$\w.[\]'"#]*\s*=\s*(?:async\s*)?(?:function\b|class\b|(?:\([^)]*\)|[$\w]+)\s*(?::[^=]*?)?=>)/
// a CommonJS export: `module.exports = …`, `exports.limit = …`
const COMMONJS_EXPORT = /^(?:module\.)?exports\b[$\w.[\]'"]*\s*=(?!=)/

/** Whether the line whose first token is `t` begins a declaration a comment above would explain. */
function declares(line: string, t: Token): boolean {
  const code = line.trimStart()
  if (DECLARATION.test(code)) return true
  const inside = t.inside
  const top = !inside || (inside.t === '{' && inside.kind === 'module')
  if (VARIABLE.test(code)) return top || FUNCTION_VALUE.test(code)
  if (ASSIGNED_FUNCTION.test(code) || (top && COMMONJS_EXPORT.test(code))) return true
  // a method or property of a class or an object literal
  const member = inside?.t === '{' && ['class', 'object', 'colon', 'unknown'].includes(inside.kind)
  return member && (t.kind === 'name' || t.kind === 'str' || t.kind === 'num' || ['[', '#', '*', '...', '@'].includes(line.slice(t.start, t.end)))
}

/** The lines that hold one `//` comment and nothing else, and which of them explain a declaration. */
export function commentLines(source: string, opts: { jsx?: boolean } = {}): CommentLines {
  const tokens = scan(source, opts)
  if (!tokens) return { whole: new Set(), doc: new Set(), unsure: true }
  const lines = splitLines(source)
  const starts: number[] = []
  for (let at = 0, k = 0; k < lines.length; at += lines[k]!.length, k++) starts.push(at)
  const lineOf = (pos: number): number => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid]! <= pos) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
  // per line: how many tokens touch it, whether all are comments, and the token it begins with
  const touched = new Array<number>(lines.length + 2).fill(0)
  const code = new Array<boolean>(lines.length + 2).fill(false)
  const first = new Array<Token | undefined>(lines.length + 2)
  const only = new Array<Token | undefined>(lines.length + 2)
  for (const t of tokens) {
    const a = lineOf(t.start)
    const b = lineOf(Math.max(t.start, t.end - 1))
    for (let l = a; l <= b; l++) {
      touched[l]! += 1
      only[l] = t
      if (t.kind !== 'line' && t.kind !== 'block') code[l] = true
      if (first[l] === undefined) first[l] = t
    }
  }
  const whole = new Set<number>()
  for (let l = 1; l <= lines.length; l++) if (touched[l] === 1 && only[l]!.kind === 'line') whole.add(l)

  const doc = new Set<number>()
  for (let l = 1; l <= lines.length;) {
    if (!touched[l] || code[l]) { l++; continue }
    // a run of comment-only lines; the line after it decides
    const run: number[] = []
    for (; l <= lines.length && touched[l] && !code[l]; l++) run.push(l)
    const t = first[l]
    if (l > lines.length || !t || lineOf(t.start) !== l || t.kind === 'line' || t.kind === 'block') continue
    if (declares(bare(lines[l - 1]!), { ...t, start: t.start - starts[l - 1]!, end: t.end - starts[l - 1]! })) {
      for (const k of run) if (whole.has(k)) doc.add(k)
    }
  }
  return { whole, doc, unsure: false }
}

// ---- deciding and editing -------------------------------------------------------------

/** The lines that go: listed, added, a whole-line comment, not above a declaration, not claimed by `keep`. */
export function decide(input: { source: string; added: Iterable<number>; remove: number[] | null; keep: number[] | null; jsx?: boolean }): Decision {
  const { whole, doc, unsure: unread } = commentLines(input.source, { jsx: input.jsx })
  const added = new Set(input.added)
  const keep = new Set(input.keep ?? [])
  const decision: Decision = { remove: [], dropped: [] }
  for (const line of [...new Set(input.remove ?? [])].sort((a, b) => a - b)) {
    // an unsure file: whether the line is a comment is not known, so only the reasons that do not depend on it apply
    const why: DropReason | undefined = !added.has(line) ? 'out-of-change'
      : unread ? (keep.has(line) ? 'claimed-kept' : 'unsure')
        : !whole.has(line) ? 'not-a-comment'
          : doc.has(line) ? 'above-a-declaration'
            : keep.has(line) ? 'claimed-kept'
              : undefined
    if (why) decision.dropped.push({ line, why })
    else decision.remove.push(line)
  }
  return decision
}

/** The source without those lines (each with its terminator); every other byte unchanged. */
export function removeLines(source: string, lines: number[]): string {
  const gone = new Set(lines)
  return splitLines(source).filter((_, i) => !gone.has(i + 1)).join('')
}

/** The program's tokens, comments and whitespace ignored, each with whether a line terminator precedes it. */
function program(source: string, opts: { jsx?: boolean }): string[] | undefined {
  const tokens = scan(source, opts)?.filter((t) => t.kind !== 'line' && t.kind !== 'block')
  if (!tokens) return undefined
  return tokens.map((t, k) => {
    const gap = k ? source.slice(tokens[k - 1]!.end, t.start) : ''
    return `${gap.includes('\n') ? '\n' : ' '}${t.kind} ${source.slice(t.start, t.end)}`
  })
}

/** The same tokens, and a line terminator between the same neighbours (so semicolon insertion cannot differ). */
export function sameProgram(before: string, after: string, opts: { jsx?: boolean } = {}): boolean {
  const a = program(before, opts)
  const b = program(after, opts)
  return !!a && !!b && a.length === b.length && a.every((x, k) => x === b[k])
}

/** A unified diff (three lines of context) that `git apply` accepts; `after` must be `before` with whole lines deleted. */
export function patchFor(path: string, before: string, after: string): string {
  if (before === after) return ''
  if (!path || /[\s"\\]|^\//.test(path)) throw new Error('patchFor: a relative path with no spaces, quotes or backslashes')
  const old = splitLines(before)
  const kept = splitLines(after)
  const ops: Array<{ op: ' ' | '-'; line: string }> = []
  let j = 0
  for (const line of old) {
    if (j < kept.length && line === kept[j]) {
      ops.push({ op: ' ', line })
      j++
    } else ops.push({ op: '-', line })
  }
  if (j !== kept.length) throw new Error('patchFor: after is not before with whole lines deleted')
  const changed = ops.flatMap((o, k) => (o.op === '-' ? [k] : []))
  const out = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`]
  for (let c = 0; c < changed.length;) {
    let last = c
    while (last + 1 < changed.length && changed[last + 1]! - changed[last]! <= 7) last++
    const from = Math.max(0, changed[c]! - 3)
    const to = Math.min(ops.length, changed[last]! + 4)
    const keptBefore = ops.slice(0, from).filter((o) => o.op === ' ').length
    const keptIn = ops.slice(from, to).filter((o) => o.op === ' ').length
    out.push(`@@ -${from + 1},${to - from} +${keptIn ? keptBefore + 1 : keptBefore},${keptIn} @@`)
    for (const { op, line } of ops.slice(from, to)) {
      out.push(`${op}${line.endsWith('\n') ? line.slice(0, -1) : line}`)
      if (!line.endsWith('\n')) out.push('\\ No newline at end of file')
    }
    c = last + 1
  }
  return `${out.join('\n')}\n`
}
