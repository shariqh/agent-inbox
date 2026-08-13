import { esc } from './esc.js'
import { textLinkHtml } from './source.js'

const URL_RE = /https?:\/\/[^\s<>"']+/gi
const PROTECTED_START_RE = /<!--|<![\p{ID_Start}][\p{ID_Continue}\u200c\u200d:-]*|<\/?[\p{ID_Start}_$][\p{ID_Continue}\u200c\u200d_$:-]*(?:\.[\p{ID_Start}_$][\p{ID_Continue}\u200c\u200d_$-]*)*|&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/giu
const SAFE_BOUNDARY_RE = /[\s([{'",;…⋯。！？؛؟،۔；：，、“”‘’（）【】《》「」『』［］｛｝—–«»]/
const BULLET_RE = /^ {0,3}[-*]\s+(.+)$/
const NUMBERED_RE = /^ {0,3}([0-9]+)\.\s+(.+)$/
const IDENTIFIER_START_RE = /[\p{ID_Start}_$]/u
const IDENTIFIER_CONTINUE_RE = /[\p{ID_Continue}\u200c\u200d_$]/u
const JSX_IDENTIFIER_RE = /^[\p{ID_Start}_$][\p{ID_Continue}\u200c\u200d_$]*$/u

const TRAILING_PUNCTUATION = new Set('.,!?;:…⋯。！？؛؟،۔；：，、“”‘’—–«»）】》」』］｝')
const OPEN_TO_CLOSE = new Map([['(', ')'], ['[', ']'], ['{', '}']])
const CLOSERS = new Set(OPEN_TO_CLOSE.values())
const URL_SEPARATORS = new Set([',', ';', '؛', '،', '；', '，'])
const REGEX_PREFIX_KEYWORDS = new Set([
  'await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new',
  'return', 'throw', 'typeof', 'void', 'yield',
])
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

function scanTag(value, start, initial = {}) {
  let quote = initial.quote ?? ''
  let quoteEscaped = initial.quoteEscaped ?? false
  const expressionClosers = [...(initial.expressionClosers ?? [])]
  let expressionMode = initial.expressionMode ?? ''
  let regexCharClass = initial.regexCharClass ?? false
  let canStartRegex = initial.canStartRegex ?? true
  let afterMemberAccess = initial.afterMemberAccess ?? false
  let genericDepth = initial.genericDepth ?? 0
  const genericClosers = [...(initial.genericClosers ?? [])]
  const allowGenerics = initial.allowGenerics ?? false
  const stopAtTagStart = initial.stopAtTagStart ?? false
  const rejectGreaterEqual = initial.rejectGreaterEqual ?? true
  let hasAssignment = false
  let firstAttributeAssignment = false
  let attributeShapeValid = true
  let attributeCount = 0
  let attributeState = 'before'
  const result = (end, closed) => ({
    end,
    quote: closed ? '' : quote,
    closed,
    hasAssignment,
    firstAttributeAssignment,
    attributeCount,
    attributeShapeValid,
    expressionClosers: closed ? [] : expressionClosers,
    expressionMode: closed ? '' : expressionMode,
    regexCharClass: closed ? false : regexCharClass,
    quoteEscaped: closed ? false : quoteEscaped,
    canStartRegex,
    afterMemberAccess,
    genericDepth: closed ? 0 : genericDepth,
    genericClosers: closed ? [] : genericClosers,
    allowGenerics,
  })
  for (let index = start; index < value.length; index++) {
    const char = value[index]
    const codePoint = value.codePointAt(index)
    const tokenChar = codePoint === undefined ? char : String.fromCodePoint(codePoint)
    if (quote) {
      if ((expressionClosers.length || genericDepth) && char === '\\' && !quoteEscaped) {
        quoteEscaped = true
        continue
      }
      if (
        quote === '`' &&
        expressionClosers.length &&
        char === '$' &&
        value[index + 1] === '{' &&
        !quoteEscaped
      ) {
        quote = ''
        expressionClosers.push('template}')
        canStartRegex = true
        afterMemberAccess = false
        index++
        continue
      }
      if (char === quote && !quoteEscaped) {
        quote = ''
        canStartRegex = false
        afterMemberAccess = false
      }
      quoteEscaped = false
      continue
    }
    if (expressionMode === 'blockComment') {
      if (char === '*' && value[index + 1] === '/') {
        expressionMode = ''
        index++
      }
      continue
    }
    if (expressionMode === 'regex') {
      if (char === '\\' && !quoteEscaped) {
        quoteEscaped = true
        continue
      }
      if (quoteEscaped) {
        quoteEscaped = false
        continue
      }
      if (char === '[') regexCharClass = true
      else if (char === ']') regexCharClass = false
      else if (char === '/' && !regexCharClass) {
        expressionMode = ''
        canStartRegex = false
        afterMemberAccess = false
      }
      continue
    }
    if (expressionClosers.length) {
      if (char === '/' && value[index + 1] === '/') {
        expressionMode = ''
        return result(value.length, false)
      }
      if (char === '/' && value[index + 1] === '*') {
        expressionMode = 'blockComment'
        index++
        continue
      }
      if (char === '/' && canStartRegex) {
        expressionMode = 'regex'
        regexCharClass = false
        quoteEscaped = false
        continue
      }
      if (char === '"' || char === "'" || char === '`') {
        quote = char
        continue
      }
      const expressionClose = OPEN_TO_CLOSE.get(char)
      if (expressionClose) {
        expressionClosers.push(expressionClose)
        canStartRegex = true
        afterMemberAccess = false
      } else if (
        expressionClosers.at(-1) === char ||
        (expressionClosers.at(-1) === 'template}' && char === '}')
      ) {
        const closedTemplateExpression = expressionClosers.pop() === 'template}'
        if (closedTemplateExpression) quote = '`'
        canStartRegex = false
        afterMemberAccess = false
      } else if (IDENTIFIER_START_RE.test(tokenChar)) {
        let end = index + tokenChar.length
        while (end < value.length) {
          const nextCodePoint = value.codePointAt(end)
          if (nextCodePoint === undefined) break
          const nextChar = String.fromCodePoint(nextCodePoint)
          if (!IDENTIFIER_CONTINUE_RE.test(nextChar)) break
          end += nextChar.length
        }
        const word = value.slice(index, end)
        canStartRegex = !afterMemberAccess && REGEX_PREFIX_KEYWORDS.has(word)
        afterMemberAccess = false
        index = end - 1
      } else if (/[0-9]/.test(char)) {
        let end = index + 1
        while (end < value.length && /[0-9a-f._]/i.test(value[end])) end++
        canStartRegex = false
        afterMemberAccess = false
        index = end - 1
      } else if ((char === '+' || char === '-') && value[index + 1] === char) {
        const prefixOperator = canStartRegex
        canStartRegex = prefixOperator
        afterMemberAccess = false
        index++
      } else if (char === '!' && value[index + 1] !== '=') {
        const prefixOperator = canStartRegex
        canStartRegex = prefixOperator
        afterMemberAccess = false
      } else if (char === '.') {
        canStartRegex = false
        afterMemberAccess = true
      } else if ('=!:,;?&|+-*%<>/'.includes(char)) {
        canStartRegex = true
        afterMemberAccess = false
      }
      continue
    }
    if (genericDepth) {
      if (char === '"' || char === "'" || char === '`') {
        quote = char
      } else if (char === '/' && value[index + 1] === '*') {
        expressionMode = 'blockComment'
        index++
      } else if (char === '/' && value[index + 1] === '/') {
        return result(value.length, false)
      } else {
        const genericClose = OPEN_TO_CLOSE.get(char)
        if (genericClose) {
          genericClosers.push(genericClose)
          continue
        }
        if (genericClosers.at(-1) === char) {
          genericClosers.pop()
          continue
        }
        if (genericClosers.length) continue
        if (char === '<') {
          genericDepth++
        } else if (
          char === '>' &&
          value[index - 1] !== '=' &&
          value[index + 1] !== '='
        ) {
          genericDepth--
        }
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      attributeState = 'value'
      continue
    }
    if (char === '{') {
      expressionClosers.push('}')
      canStartRegex = true
      regexCharClass = false
      quoteEscaped = false
      if (attributeState === 'before' || attributeState === 'afterName') {
        attributeCount++
      }
      attributeState = 'value'
      continue
    }
    if (allowGenerics && char === '<' && index === start) {
      genericDepth = 1
      continue
    }
    if (char === '/' && value[index + 1] === '>') {
      return result(index + 2, true)
    }
    if (char === '>' && value[index + 1] === '=' && !hasAssignment && rejectGreaterEqual) {
      attributeShapeValid = false
      attributeState = 'other'
      continue
    }
    if (char === '>') {
      return result(index + 1, true)
    }
    if (stopAtTagStart && char === '<') {
      return result(index, false)
    }
    if (char === '=') {
      if (attributeState === 'name' || attributeState === 'afterName') {
        hasAssignment = true
        if (attributeCount === 1) firstAttributeAssignment = true
      } else if (!hasAssignment) {
        attributeShapeValid = false
      }
      attributeState = 'value'
      continue
    }
    if (/\s/.test(char)) {
      if (attributeState === 'name') attributeState = 'afterName'
      else if (attributeState !== 'afterName') attributeState = 'before'
      continue
    }
    const attributeStart =
      IDENTIFIER_START_RE.test(tokenChar) || ':@*.([{#'.includes(char)
    const attributeNameChar =
      IDENTIFIER_CONTINUE_RE.test(tokenChar) || '.:-@*[](){}#|'.includes(char)
    if (attributeState === 'before' || attributeState === 'afterName') {
      attributeState = attributeStart ? 'name' : 'other'
      if (attributeStart) attributeCount++
      if (!attributeStart && !hasAssignment) attributeShapeValid = false
    } else if (attributeState === 'name' && !attributeNameChar) {
      attributeState = 'other'
      if (!hasAssignment) attributeShapeValid = false
    }
    if (tokenChar.length > 1) index += tokenChar.length - 1
  }
  return result(value.length, false)
}

function consumeTag(scan, state) {
  state.mode = scan.closed ? '' : 'tag'
  state.quote = scan.quote
  state.expressionClosers = scan.expressionClosers
  state.expressionMode = scan.expressionMode
  state.regexCharClass = scan.regexCharClass
  state.quoteEscaped = scan.quoteEscaped
  state.canStartRegex = scan.canStartRegex
  state.afterMemberAccess = scan.afterMemberAccess
  state.genericDepth = scan.genericDepth
  state.genericClosers = scan.genericClosers
  state.allowGenerics = scan.allowGenerics
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
    return {
      credible: true,
      comment: false,
      scan: scanTag(value, match.index + token.length, { rejectGreaterEqual: false }),
    }
  }
  const rawName = token.replace(/^<\/?/, '')
  const name = rawName.toLowerCase()
  const nameParts = rawName.split('.')
  const frameworkComponent =
    (nameParts.length > 1 && nameParts.every((part) => JSX_IDENTIFIER_RE.test(part))) ||
    (JSX_IDENTIFIER_RE.test(rawName) && !/^[a-z]/.test(rawName))
  const recognized = HTML_TAG_NAMES.has(name) || name.includes('-') || frameworkComponent
  const tokenEnd = match.index + token.length
  if (lineLeading && recognized) {
    return {
      credible: true,
      comment: false,
      scan: scanTag(value, tokenEnd, {
        rejectGreaterEqual: false,
        allowGenerics: frameworkComponent,
      }),
    }
  }
  const next = value[tokenEnd] ?? ''
  if (!next || (!/[\s/>]/.test(next) && !(frameworkComponent && next === '<'))) {
    return { credible: false }
  }
  const shape = scanTag(value, tokenEnd, {
    stopAtTagStart: true,
    rejectGreaterEqual: !recognized,
    allowGenerics: frameworkComponent,
  })
  const hasUnclosedLexicalState =
    !shape.closed &&
    (shape.genericDepth > 0 ||
      shape.expressionClosers.length > 0 ||
      Boolean(shape.expressionMode) ||
      Boolean(shape.quote))
  const previous = match.index > 0 ? value[match.index - 1] : ''
  const hasSafeLeftBoundary =
    !previous || previous === '>' || SAFE_BOUNDARY_RE.test(previous)
  const shouldConsumeRejected = shape.closed || hasUnclosedLexicalState ||
    (hasSafeLeftBoundary && !shape.attributeShapeValid && shape.end > tokenEnd)
  if (!hasSafeLeftBoundary && !shape.closed) {
    return hasUnclosedLexicalState
      ? { credible: false, inertEnd: shape.end }
      : { credible: false }
  }
  if (!shape.attributeShapeValid) {
    return shouldConsumeRejected
      ? { credible: false, inertEnd: shape.end }
      : { credible: false }
  }
  const credibleOpenTag =
    frameworkComponent
      ? rawName.length > 1 &&
        (shape.firstAttributeAssignment || shape.attributeCount === 1)
      : recognized
        ? shape.attributeCount > 0
        : shape.firstAttributeAssignment
  if (!shape.closed && !credibleOpenTag) {
    return hasUnclosedLexicalState
      ? { credible: false, inertEnd: shape.end }
      : { credible: false }
  }
  return {
    credible: true,
    comment: false,
    scan: shape.closed
      ? shape
      : scanTag(value, tokenEnd, { allowGenerics: frameworkComponent }),
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

function linkedUrlRanges(value) {
  const ranges = []
  URL_RE.lastIndex = 0
  for (let match = URL_RE.exec(value); match; match = URL_RE.exec(value)) {
    const previous = match.index > 0 ? value[match.index - 1] : ''
    if (!previous || SAFE_BOUNDARY_RE.test(previous)) {
      ranges.push({ start: match.index, end: match.index + match[0].length })
    }
  }
  return ranges
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

function renderInline(value, state, linkState) {
  let html = ''
  let cursor = 0
  const firstContentIndex = value.search(/\S/)
  const urlRanges = linkedUrlRanges(value)
  let urlRangeIndex = 0
  if (state.mode) {
    if (state.mode === 'comment') {
      cursor = consumeComment(value, 0, state)
    } else {
      cursor = consumeTag(
        scanTag(value, 0, {
          quote: state.quote,
          quoteEscaped: false,
          expressionClosers: state.expressionClosers,
          expressionMode: state.expressionMode,
          regexCharClass: state.regexCharClass,
          canStartRegex: state.canStartRegex,
          afterMemberAccess: state.afterMemberAccess,
          genericDepth: state.genericDepth,
          genericClosers: state.genericClosers,
          allowGenerics: state.allowGenerics,
          rejectGreaterEqual: false,
        }),
        state,
      )
    }
    html += esc(value.slice(0, cursor))
    if (state.mode) return html
  }
  PROTECTED_START_RE.lastIndex = cursor
  for (let match = PROTECTED_START_RE.exec(value); match; match = PROTECTED_START_RE.exec(value)) {
    if (match[0].startsWith('&')) {
      while (urlRanges[urlRangeIndex]?.end <= match.index) urlRangeIndex++
      const activeUrl = urlRanges[urlRangeIndex]
      if (
        activeUrl &&
        activeUrl.start <= match.index &&
        activeUrl.end >= match.index + match[0].length
      ) {
        continue
      }
      html += renderLinkedSegment(value.slice(cursor, match.index), linkState)
      html += esc(match[0])
      cursor = match.index + match[0].length
      continue
    }
    const assessment = assessTagStart(value, match, match.index === firstContentIndex)
    if (!assessment.credible) {
      if (assessment.inertEnd > match.index) {
        html += renderLinkedSegment(value.slice(cursor, match.index), linkState)
        cursor = assessment.inertEnd
        html += esc(value.slice(match.index, cursor))
        PROTECTED_START_RE.lastIndex = cursor
      }
      continue
    }
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
  const inlineState = {
    mode: '',
    quote: '',
    expressionClosers: [],
    expressionMode: '',
    regexCharClass: false,
    quoteEscaped: false,
    canStartRegex: true,
    afterMemberAccess: false,
    genericDepth: 0,
    genericClosers: [],
    allowGenerics: false,
  }
  let paragraphLinkState = { expectedProseClosers: [] }

  const flushParagraph = () => {
    if (!paragraph.length) return
    blocks.push(paragraphHtml(paragraph))
    paragraph = []
    paragraphLinkState = { expectedProseClosers: [] }
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
      list.items.push(renderInline(bullet[1], inlineState, { expectedProseClosers: [] }))
      continue
    }
    if (numbered?.[1] !== undefined && numbered[2] !== undefined) {
      flushParagraph()
      if (list?.kind !== 'ol') {
        flushList()
        list = { kind: 'ol', items: [], start: Number(numbered[1]) }
      }
      list.items.push(renderInline(numbered[2], inlineState, { expectedProseClosers: [] }))
      continue
    }
    flushList()
    paragraph.push(renderInline(line, inlineState, paragraphLinkState))
  }
  flushParagraph()
  flushList()
  return blocks.length ? `<div class="structured-text">${blocks.join('')}</div>` : ''
}
