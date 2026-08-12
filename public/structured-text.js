import { esc } from './esc.js'
import { textLinkHtml } from './source.js'

const URL_RE = /https?:\/\/[^\s<>"']+/gi
const PROTECTED_START_RE = /<!--|<![a-z][a-z0-9:-]*|<\/?[a-z][a-z0-9:-]*|&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/gi
const SAFE_BOUNDARY_RE = /[\s([{'",;…⋯。！？؛؟،۔；：，、“”‘’（）【】《》「」『』［］｛｝—–«»]/
const BULLET_RE = /^ {0,3}[-*]\s+(.+)$/
const NUMBERED_RE = /^ {0,3}([0-9]+)\.\s+(.+)$/

const TRAILING_PUNCTUATION = new Set('.,!?;:…⋯。！？؛؟،۔；：，、“”‘’—–«»）】》」』］｝')
const OPEN_TO_CLOSE = new Map([['(', ')'], ['[', ']'], ['{', '}']])
const CLOSERS = new Set(OPEN_TO_CLOSE.values())
const URL_SEPARATORS = new Set([',', ';', '؛', '،', '；', '，'])
const HTML_TAG_NAMES = new Set(
  'a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript object ol optgroup option output p picture pre progress q rp rt ruby s samp script search section select slot small source span strong style sub summary sup table tbody td template textarea tfoot th thead time title tr track u ul var video wbr'.split(' '),
)

function splitTrailingPunctuation(candidate, externalClosers = []) {
  const expectedClosers = []
  const unmatchedClosers = new Uint8Array(candidate.length)
  const queryOrFragmentStart = candidate.search(/[?#]/)
  for (let index = 0; index < candidate.length; index++) {
    const char = candidate[index]
    const closeForOpen = OPEN_TO_CLOSE.get(char)
    if (closeForOpen) {
      expectedClosers.push(closeForOpen)
    } else if (CLOSERS.has(char)) {
      if (expectedClosers.at(-1) === char) expectedClosers.pop()
      else unmatchedClosers[index] = 1
    }
  }

  let end = candidate.length
  let externalIndex = 0
  while (end > 0) {
    const char = candidate[end - 1]
    if (TRAILING_PUNCTUATION.has(char)) {
      end--
      continue
    }
    const inQueryOrFragment = queryOrFragmentStart >= 0 && end - 1 > queryOrFragmentStart
    const matchesExternal = char === externalClosers[externalIndex]
    if (
      !unmatchedClosers[end - 1] ||
      (inQueryOrFragment && !matchesExternal)
    ) break
    if (matchesExternal) externalIndex++
    end--
  }
  return { url: candidate.slice(0, end), trailing: candidate.slice(end) }
}

function consumeTag(value, start, state) {
  state.mode = 'tag'
  for (let index = start; index < value.length; index++) {
    const char = value[index]
    if (state.quote) {
      if (char === state.quote) state.quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      state.quote = char
      continue
    }
    if (char !== '>') continue
    state.mode = ''
    state.quote = ''
    return index + 1
  }
  return value.length
}

function consumeComment(value, start, state) {
  state.mode = 'comment'
  state.quote = ''
  const close = value.indexOf('-->', start)
  if (close < 0) return value.length
  state.mode = ''
  return close + 3
}

function credibleTagStart(value, match) {
  const token = match[0]
  if (token === '<!--' || token.startsWith('<!')) return true
  const name = token.replace(/^<\/?/, '').toLowerCase()
  const remainder = value.slice(match.index + token.length)
  if (remainder.includes('>') || /^\s+[a-z_:][a-z0-9_.:-]*\s*=/i.test(remainder)) return true
  const lineLeading = !value.slice(0, match.index).trim()
  return lineLeading && (HTML_TAG_NAMES.has(name) || name.includes('-'))
}

function startsHttpScheme(value, index) {
  const prefix = value.slice(index, index + 8).toLowerCase()
  return prefix.startsWith('http://') || prefix.startsWith('https://')
}

function splitAdjacentUrls(candidate) {
  const segments = []
  let start = 0
  let hasQueryOrFragment = false
  for (let index = 0; index < candidate.length; index++) {
    const char = candidate[index]
    if (char === '?' || char === '#') hasQueryOrFragment = true
    if (
      hasQueryOrFragment ||
      !URL_SEPARATORS.has(char) ||
      !startsHttpScheme(candidate, index + 1)
    ) continue
    segments.push({ url: candidate.slice(start, index), trailing: char })
    start = index + 1
    hasQueryOrFragment = false
  }
  segments.push({ url: candidate.slice(start), trailing: '' })
  return segments
}

function updateDelimiterStack(value, start, end, expectedClosers) {
  for (let index = start; index < end; index++) {
    const char = value[index]
    const closeForOpen = OPEN_TO_CLOSE.get(char)
    if (closeForOpen) expectedClosers.push(closeForOpen)
    else if (expectedClosers.at(-1) === char) expectedClosers.pop()
  }
}

function renderLinkedSegment(value) {
  let html = ''
  let cursor = 0
  let boundaryCursor = 0
  const expectedProseClosers = []
  URL_RE.lastIndex = 0
  for (let match = URL_RE.exec(value); match; match = URL_RE.exec(value)) {
    const start = match.index
    const candidate = match[0]
    updateDelimiterStack(value, boundaryCursor, start, expectedProseClosers)
    html += esc(value.slice(cursor, start))
    const previous = start > 0 ? value[start - 1] : ''
    if (previous && !SAFE_BOUNDARY_RE.test(previous)) {
      html += esc(candidate)
    } else {
      const segments = splitAdjacentUrls(candidate)
      for (let index = 0; index < segments.length; index++) {
        const segment = segments[index]
        const externalClosers = index === segments.length - 1 ? expectedProseClosers : []
        const { url, trailing } = splitTrailingPunctuation(segment.url, externalClosers)
        const totalTrailing = trailing + segment.trailing
        html += textLinkHtml(url, url) + esc(totalTrailing)
        updateDelimiterStack(totalTrailing, 0, totalTrailing.length, expectedProseClosers)
      }
    }
    cursor = start + candidate.length
    boundaryCursor = cursor
  }
  return html + esc(value.slice(cursor))
}

function renderInline(value, state) {
  let html = ''
  let cursor = 0
  if (state.mode) {
    cursor = state.mode === 'comment'
      ? consumeComment(value, 0, state)
      : consumeTag(value, 0, state)
    html += esc(value.slice(0, cursor))
    if (state.mode) return html
  }
  PROTECTED_START_RE.lastIndex = cursor
  for (let match = PROTECTED_START_RE.exec(value); match; match = PROTECTED_START_RE.exec(value)) {
    if (match[0].startsWith('&')) {
      html += renderLinkedSegment(value.slice(cursor, match.index))
      html += esc(match[0])
      cursor = match.index + match[0].length
      continue
    }
    if (!credibleTagStart(value, match)) continue
    html += renderLinkedSegment(value.slice(cursor, match.index))
    cursor = match[0] === '<!--'
      ? consumeComment(value, match.index, state)
      : consumeTag(value, match.index, state)
    html += esc(value.slice(match.index, cursor))
    if (state.mode) break
    PROTECTED_START_RE.lastIndex = cursor
  }
  return html + (state.mode ? '' : renderLinkedSegment(value.slice(cursor)))
}

function paragraphHtml(lines) {
  return `<p>${lines.join('<br>')}</p>`
}

function listHtml(kind, items, start) {
  const startAttr = kind === 'ol' && start !== 1 ? ` start="${start}"` : ''
  return `<${kind}${startAttr}>${items.map((item) => `<li>${item}</li>`).join('')}</${kind}>`
}

// A deliberately small presentation grammar: paragraphs, explicit line breaks,
// simple "-"/"*" bullets, "1." numbered items, and safe HTTP(S) autolinks.
// Parsing happens on raw text; each text fragment is escaped before any markup
// is introduced, and URL markup can only come from source.js's guarded path.
export function renderStructuredText(value) {
  if (value === null || value === undefined || value === '') return ''
  const lines = String(value).replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let paragraph = []
  let list = null
  const inlineState = { mode: '', quote: '' }

  const flushParagraph = () => {
    if (!paragraph.length) return
    blocks.push(paragraphHtml(paragraph))
    paragraph = []
  }
  const flushList = () => {
    if (!list) return
    blocks.push(listHtml(list.kind, list.items, list.start))
    list = null
  }

  for (const line of lines) {
    if (!line.trim()) {
      flushParagraph()
      flushList()
      continue
    }
    const startsProtected = Boolean(inlineState.mode)
    const bullet = startsProtected ? null : BULLET_RE.exec(line)
    const numbered = startsProtected ? null : NUMBERED_RE.exec(line)
    if (bullet?.[1] !== undefined) {
      flushParagraph()
      if (list?.kind !== 'ul') {
        flushList()
        list = { kind: 'ul', items: [], start: 1 }
      }
      list.items.push(renderInline(bullet[1], inlineState))
      continue
    }
    if (numbered?.[1] !== undefined && numbered[2] !== undefined) {
      flushParagraph()
      if (list?.kind !== 'ol') {
        flushList()
        list = { kind: 'ol', items: [], start: Number(numbered[1]) }
      }
      list.items.push(renderInline(numbered[2], inlineState))
      continue
    }
    flushList()
    paragraph.push(renderInline(line, inlineState))
  }
  flushParagraph()
  flushList()
  return blocks.length ? `<div class="structured-text">${blocks.join('')}</div>` : ''
}
