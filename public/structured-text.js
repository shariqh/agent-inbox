import { esc } from './esc.js'
import { textLinkHtml } from './source.js'

const URL_RE = /https?:\/\/[^\s<>"'…⋯。！？：、“”‘’（）【】《》「」『』［］｛｝—–]+/gi
const PROTECTED_START_RE = /<[a-z!/]|&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/gi
const SAFE_BOUNDARY_RE = /[\s([{'",;…⋯。！？；：，、“”‘’（）【】《》「」『』［］｛｝—–]/
const BULLET_RE = /^ {0,3}[-*]\s+(.+)$/
const NUMBERED_RE = /^ {0,3}([0-9]+)\.\s+(.+)$/

const TRAILING_PUNCTUATION = new Set('.,!?;:…⋯。！？；：，、“”‘’—–')
const DELIMITER_PAIRS = new Map([
  [')', '('], [']', '['], ['}', '{'],
])
const OPEN_TO_CLOSE = new Map([...DELIMITER_PAIRS].map(([close, open]) => [open, close]))
const URL_SEPARATORS = new Set([',', ';', '，', '；'])

function splitTrailingPunctuation(candidate) {
  const balances = new Map([...DELIMITER_PAIRS.keys()].map((close) => [close, { open: 0, close: 0 }]))
  const queryOrFragmentStart = candidate.search(/[?#]/)
  for (const char of candidate) {
    const closeForOpen = OPEN_TO_CLOSE.get(char)
    if (closeForOpen) balances.get(closeForOpen).open++
    if (DELIMITER_PAIRS.has(char)) balances.get(char).close++
  }

  let end = candidate.length
  while (end > 0) {
    const char = candidate[end - 1]
    if (TRAILING_PUNCTUATION.has(char)) {
      end--
      continue
    }
    const balance = balances.get(char)
    if (
      !balance ||
      balance.close <= balance.open ||
      (queryOrFragmentStart >= 0 && end - 1 > queryOrFragmentStart)
    ) break
    balance.close--
    end--
  }
  return { url: candidate.slice(0, end), trailing: candidate.slice(end) }
}

function consumeTag(value, start, state) {
  state.inTag = true
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
    state.inTag = false
    state.quote = ''
    return index + 1
  }
  return value.length
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
    segments.push({ url: candidate.slice(start, index), separator: char })
    start = index + 1
    hasQueryOrFragment = false
  }
  segments.push({ url: candidate.slice(start), separator: '' })
  return segments
}

function renderLinkedSegment(value) {
  let html = ''
  let cursor = 0
  URL_RE.lastIndex = 0
  for (let match = URL_RE.exec(value); match; match = URL_RE.exec(value)) {
    const start = match.index
    const candidate = match[0]
    html += esc(value.slice(cursor, start))
    const previous = start > 0 ? value[start - 1] : ''
    if (previous && !SAFE_BOUNDARY_RE.test(previous)) {
      html += esc(candidate)
    } else {
      for (const segment of splitAdjacentUrls(candidate)) {
        const { url, trailing } = splitTrailingPunctuation(segment.url)
        html += textLinkHtml(url, url) + esc(trailing + segment.separator)
      }
    }
    cursor = start + candidate.length
  }
  return html + esc(value.slice(cursor))
}

function renderInline(value, state) {
  let html = ''
  let cursor = 0
  if (state.inTag) {
    cursor = consumeTag(value, 0, state)
    html += esc(value.slice(0, cursor))
    if (state.inTag) return html
  }
  PROTECTED_START_RE.lastIndex = cursor
  for (let match = PROTECTED_START_RE.exec(value); match; match = PROTECTED_START_RE.exec(value)) {
    html += renderLinkedSegment(value.slice(cursor, match.index))
    if (match[0].startsWith('&')) {
      html += esc(match[0])
      cursor = match.index + match[0].length
      continue
    }
    cursor = consumeTag(value, match.index, state)
    html += esc(value.slice(match.index, cursor))
    if (state.inTag) break
    PROTECTED_START_RE.lastIndex = cursor
  }
  return html + (state.inTag ? '' : renderLinkedSegment(value.slice(cursor)))
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
  const inlineState = { inTag: false, quote: '' }

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
    const startsInTag = inlineState.inTag
    const bullet = startsInTag ? null : BULLET_RE.exec(line)
    const numbered = startsInTag ? null : NUMBERED_RE.exec(line)
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
