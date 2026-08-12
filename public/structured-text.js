import { esc } from './esc.js'
import { textLinkHtml } from './source.js'

const URL_RE = /https?:\/\/[^\s<>"']+/gi
const PROTECTED_RE = /<[a-z!/][^>\n]*(?:>|$)|&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/gi
const SAFE_BOUNDARY_RE = /[\s([{'"]/
const BULLET_RE = /^ {0,3}[-*]\s+(.+)$/
const NUMBERED_RE = /^ {0,3}([0-9]+)\.\s+(.+)$/

function countChar(value, char) {
  let count = 0
  for (const current of value) if (current === char) count++
  return count
}

function splitTrailingPunctuation(candidate) {
  let url = candidate
  let trailing = ''
  let changed = true
  while (url && changed) {
    changed = false
    if (/[.,!?;:]$/.test(url)) {
      trailing = url.at(-1) + trailing
      url = url.slice(0, -1)
      changed = true
      continue
    }
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      if (url.endsWith(close) && countChar(url, close) > countChar(url, open)) {
        trailing = close + trailing
        url = url.slice(0, -1)
        changed = true
        break
      }
    }
  }
  return { url, trailing }
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
      const { url, trailing } = splitTrailingPunctuation(candidate)
      html += textLinkHtml(url, url) + esc(trailing)
    }
    cursor = start + candidate.length
  }
  return html + esc(value.slice(cursor))
}

function renderInline(value, state) {
  let html = ''
  let cursor = 0
  if (state.inTag) {
    const end = value.indexOf('>')
    if (end < 0) return esc(value)
    html += esc(value.slice(0, end + 1))
    cursor = end + 1
    state.inTag = false
  }
  PROTECTED_RE.lastIndex = 0
  PROTECTED_RE.lastIndex = cursor
  for (let match = PROTECTED_RE.exec(value); match; match = PROTECTED_RE.exec(value)) {
    html += renderLinkedSegment(value.slice(cursor, match.index))
    html += esc(match[0])
    cursor = match.index + match[0].length
    if (match[0].startsWith('<') && !match[0].endsWith('>')) {
      state.inTag = true
      break
    }
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
  const inlineState = { inTag: false }

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
