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

function scanTag(value, start, initialQuote = '', stopAtTagStart = false) {
  let quote = initialQuote
  let hasAssignment = false
  let firstAttributeAssignment = false
  let attributeCount = 0
  let attributeState = 'before'
  for (let index = start; index < value.length; index++) {
    const char = value[index]
    if (quote) {
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      attributeState = 'value'
      continue
    }
    if (char === '>') {
      return {
        end: index + 1,
        quote: '',
        closed: true,
        hasAssignment,
        firstAttributeAssignment,
      }
    }
    if (stopAtTagStart && char === '<') {
      return { end: index, quote, closed: false, hasAssignment, firstAttributeAssignment }
    }
    if (char === '=') {
      if (attributeState === 'name' || attributeState === 'afterName') {
        hasAssignment = true
        if (attributeCount === 1) firstAttributeAssignment = true
      }
      attributeState = 'value'
      continue
    }
    if (/\s/.test(char)) {
      if (attributeState === 'name') attributeState = 'afterName'
      else if (attributeState !== 'afterName') attributeState = 'before'
      continue
    }
    const attributeStart = /[a-z_:]/i.test(char)
    if (attributeState === 'before' || attributeState === 'afterName') {
      attributeState = attributeStart ? 'name' : 'other'
      if (attributeStart) attributeCount++
    } else if (attributeState === 'name' && !/[a-z0-9_.:-]/i.test(char)) {
      attributeState = 'other'
    }
  }
  return { end: value.length, quote, closed: false, hasAssignment, firstAttributeAssignment }
}

function consumeTag(scan, state) {
  state.mode = scan.closed ? '' : 'tag'
  state.quote = scan.closed ? '' : scan.quote
  return scan.end
}

function consumeComment(value, start, state) {
  state.mode = 'comment'
  state.quote = ''
  const close = value.indexOf('-->', start)
  if (close < 0) return value.length
  state.mode = ''
  return close + 3
}

function assessTagStart(value, match, lineLeading) {
  const token = match[0]
  if (token === '<!--') return { credible: true, comment: true }
  if (token.startsWith('<!')) {
    return { credible: true, comment: false, scan: scanTag(value, match.index + token.length) }
  }
  const name = token.replace(/^<\/?/, '').toLowerCase()
  const recognized = HTML_TAG_NAMES.has(name) || name.includes('-')
  const tokenEnd = match.index + token.length
  if (lineLeading && recognized) {
    return { credible: true, comment: false, scan: scanTag(value, tokenEnd) }
  }
  const next = value[tokenEnd] ?? ''
  if (!next || !/[\s/>]/.test(next)) return { credible: false }
  const shape = scanTag(value, tokenEnd, '', true)
  if (!shape.closed && !shape.firstAttributeAssignment) return { credible: false }
  return {
    credible: true,
    comment: false,
    scan: shape.closed ? shape : scanTag(value, tokenEnd),
  }
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

function renderLinkedSegment(value, linkState) {
  let html = ''
  let cursor = 0
  let boundaryCursor = 0
  const expectedProseClosers = linkState.expectedProseClosers
  URL_RE.lastIndex = 0
  for (let match = URL_RE.exec(value); match; match = URL_RE.exec(value)) {
    const start = match.index
    const candidate = match[0]
    updateDelimiterStack(value, boundaryCursor, start, expectedProseClosers)
    html += esc(value.slice(cursor, start))
    const previous = start > 0 ? value[start - 1] : ''
    if (previous && !SAFE_BOUNDARY_RE.test(previous)) {
      html += esc(candidate)
      updateDelimiterStack(candidate, 0, candidate.length, expectedProseClosers)
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
  updateDelimiterStack(value, boundaryCursor, value.length, expectedProseClosers)
  return html + esc(value.slice(cursor))
}

function renderInline(value, state) {
  let html = ''
  let cursor = 0
  const firstContentIndex = value.search(/\S/)
  const linkState = { expectedProseClosers: [] }
  if (state.mode) {
    if (state.mode === 'comment') {
      cursor = consumeComment(value, 0, state)
    } else {
      cursor = consumeTag(scanTag(value, 0, state.quote), state)
    }
    html += esc(value.slice(0, cursor))
    if (state.mode) return html
  }
  PROTECTED_START_RE.lastIndex = cursor
  for (let match = PROTECTED_START_RE.exec(value); match; match = PROTECTED_START_RE.exec(value)) {
    if (match[0].startsWith('&')) {
      html += renderLinkedSegment(value.slice(cursor, match.index), linkState)
      html += esc(match[0])
      cursor = match.index + match[0].length
      continue
    }
    const assessment = assessTagStart(value, match, match.index === firstContentIndex)
    if (!assessment.credible) continue
    html += renderLinkedSegment(value.slice(cursor, match.index), linkState)
    cursor = assessment.comment
      ? consumeComment(value, match.index, state)
      : consumeTag(assessment.scan, state)
    html += esc(value.slice(match.index, cursor))
    if (state.mode) break
    PROTECTED_START_RE.lastIndex = cursor
  }
  return html + (state.mode ? '' : renderLinkedSegment(value.slice(cursor), linkState))
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
