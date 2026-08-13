import { esc } from './esc.js'
import { textLinkHtml } from './source.js'

const URL_RE = /https?:\/\/[^\s<>"']+/gi
const MARKUP_START_RE = /<!--|<!doctype(?=[\s>])|<\/?([\p{ID_Start}_$][\p{ID_Continue}\u200c\u200d_$:-]*(?:\.[\p{ID_Start}_$][\p{ID_Continue}\u200c\u200d_$:-]*)*)/giu
const SAFE_BOUNDARY_RE = /[\s([{'",;…⋯。！？؛؟،۔；：，、“”‘’（）【】《》「」『』［］｛｝—–«»]/
const LINE_LEADING_WRAPPER_RE = /[\s(\[{"'`«“‘]/u
const JSX_LEFT_PUNCTUATION = new Set('=([{,:;')
const BULLET_RE = /^ {0,3}[-*]\s+(.+)$/
const NUMBERED_RE = /^ {0,3}([0-9]+)\.\s+(.+)$/
const JSX_IDENTIFIER_RE = /^[\p{ID_Start}_$][\p{ID_Continue}\u200c\u200d_$:-]*$/u

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

function isFrameworkName(name) {
  const parts = name.split('.')
  if (!parts.every((part) => JSX_IDENTIFIER_RE.test(part))) return false
  if (parts.length > 1) return true
  const first = Array.from(name)[0] ?? ''
  return first === '_' || first === '$' || /\p{Lu}/u.test(first) || !/[A-Za-z]/.test(first)
}

function recognizedTagName(name) {
  return HTML_TAG_NAMES.has(name.toLowerCase()) || name.includes('-') || isFrameworkName(name)
}

function obviousTagEvidence(value, start) {
  let quote = ''
  let escaped = false
  for (let index = start; index < value.length; index++) {
    const char = value[index]
    if (char === '<') return { credible: false, next: index }
    if (quote) {
      if (char === '\\' && !escaped) {
        escaped = true
      } else {
        if (char === quote && !escaped) quote = ''
        escaped = false
      }
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '{') return { credible: true, next: index + 1 }
    if (char === '>') return { credible: true, next: index + 1 }
    if (char !== '=') continue
    const previous = value[index - 1] ?? ''
    const next = value[index + 1] ?? ''
    if (!'=!<>+-*/%&|^?'.includes(previous) && !'=>'.includes(next)) {
      return { credible: true, next: index + 1 }
    }
  }
  return { credible: false, next: value.length }
}

function findQuarantineStart(value) {
  MARKUP_START_RE.lastIndex = 0
  let prefixCursor = 0
  let prefixIsWrappers = true
  let previousNonSpace = ''
  for (let match = MARKUP_START_RE.exec(value); match; match = MARKUP_START_RE.exec(value)) {
    for (; prefixCursor < match.index; prefixCursor++) {
      const char = value[prefixCursor]
      if (char === '\n') {
        prefixIsWrappers = true
        previousNonSpace = ''
      } else {
        if (prefixIsWrappers && !LINE_LEADING_WRAPPER_RE.test(char)) {
          prefixIsWrappers = false
        }
        if (!/\s/.test(char)) previousNonSpace = char
      }
    }
    const token = match[0]
    if (token === '<!--' || /^<!doctype/i.test(token)) return match.index
    const name = match[1] ?? ''
    const closing = token.startsWith('</')
    const next = value[match.index + token.length] ?? ''
    const framework = isFrameworkName(name)
    const boundary = !next || /[\s/>]/.test(next) || (framework && next === '<')
    if (!boundary) continue
    if (closing) return match.index
    if (
      prefixIsWrappers ||
      JSX_LEFT_PUNCTUATION.has(previousNonSpace)
    ) {
      return match.index
    }
    const evidence = obviousTagEvidence(value, match.index + token.length)
    if (evidence.credible) return match.index
    if (recognizedTagName(name) && !framework) return match.index
    if (evidence.next >= value.length) return -1
    MARKUP_START_RE.lastIndex = evidence.next
  }
  return -1
}

function renderBlockLines(lines) {
  const value = lines.join('\n')
  const quarantineAt = findQuarantineStart(value)
  const linkState = { expectedProseClosers: [] }
  let offset = 0
  return lines.map((line) => {
    const lineEnd = offset + line.length
    let html
    if (quarantineAt < 0 || quarantineAt >= lineEnd) {
      html = renderLinkedSegment(line, linkState)
    } else if (quarantineAt <= offset) {
      html = esc(line)
    } else {
      const local = quarantineAt - offset
      html = renderLinkedSegment(line.slice(0, local), linkState) + esc(line.slice(local))
    }
    offset = lineEnd + 1
    return html
  }).join('<br>')
}

function paragraphHtml(lines) {
  return `<p>${renderBlockLines(lines)}</p>`
}

function listHtml(kind, items, start) {
  const startAttr = kind === 'ol' && start !== 1 ? ` start="${start}"` : ''
  return `<${kind}${startAttr}>${items.map((item) => `<li>${renderBlockLines([item])}</li>`).join('')}</${kind}>`
}

// A deliberately small presentation grammar: paragraphs, explicit line breaks,
// simple "-"/"*" bullets, "1." numbered items, and safe HTTP(S) autolinks.
// A credible markup-like start quarantines the rest of its paragraph or list item.
export function renderStructuredText(value) {
  if (value === null || value === undefined || value === '') return ''
  const lines = String(value).replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let paragraph = []
  let list = null

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
    const bullet = BULLET_RE.exec(line)
    const numbered = NUMBERED_RE.exec(line)
    if (bullet?.[1] !== undefined) {
      flushParagraph()
      if (list?.kind !== 'ul') {
        flushList()
        list = { kind: 'ul', items: [], start: 1 }
      }
      list.items.push(bullet[1])
      continue
    }
    if (numbered?.[1] !== undefined && numbered[2] !== undefined) {
      flushParagraph()
      if (list?.kind !== 'ol') {
        flushList()
        list = { kind: 'ol', items: [], start: Number(numbered[1]) }
      }
      list.items.push(numbered[2])
      continue
    }
    flushList()
    paragraph.push(line)
  }
  flushParagraph()
  flushList()
  return blocks.length ? `<div class="structured-text">${blocks.join('')}</div>` : ''
}
