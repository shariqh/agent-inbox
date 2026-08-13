// Source links: the issue + PR chips (issue #30). Pure view-model plus the two
// HTML builders app.js interpolates — no DOM, same role rowview.js and boards.js
// play. Sibling public modules are imported RELATIVELY so the same file resolves
// in the browser (/source.js → /esc.js) and under vitest.
//
// THE ESCAPING BURDEN LIVES ENTIRELY IN THIS FILE. app.js interpolates
// sourceChipsHtml()/sourceBlockHtml() RAW into innerHTML, so anything unescaped
// here reaches the page. Two distinct dangers, and esc() only covers the first:
//
//   1. TEXT. PR titles and bodies are third-party network text — anyone who can
//      open a PR against a repo you work in controls them — and repo/issue_ref
//      are agent-authored. All of it goes through esc().
//   2. URL SCHEMES. esc() escapes & < > " ' for an HTML text context. It does
//      NOTHING about `javascript:`. This feature introduces the first anchors
//      this product has ever built from supplied text, so safeHttpUrl() is not
//      defence in depth — it is the only defence. Every href is built in ONE
//      place below, through esc(safeHttpUrl(...)).
import { esc } from './esc.js'

// A '/' is legal in both a repo slug and a branch name, so the separator has to
// be something neither can contain.
export function linkKey(repo, branch) {
  return `${repo}\u0000${branch}`
}

export function indexLinks(links) {
  const map = new Map()
  for (const l of links ?? []) if (l && l.repo && l.branch) map.set(linkKey(l.repo, l.branch), l)
  return map
}

// The join: an item/board carries the repo it was raised in and the branch as
// its `stream`; the cache is keyed by exactly that pair. N items on one branch
// therefore share ONE cache row, and a merge updates all of them at once.
export function linkFor(index, entity) {
  if (!index || !entity || !entity.repo || !entity.stream) return null
  return index.get(linkKey(entity.repo, entity.stream)) ?? null
}

// ONLY http: and https:, decided by the URL parser rather than by string
// matching (which `JaVaScRiPt:`, a leading \u0001 or a newline inside the scheme
// all defeat). A parse failure returns '' — never the raw string.
export function safeHttpUrl(url) {
  if (typeof url !== 'string' || !url) return ''
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : ''
  } catch {
    return ''
  }
}

// Which issue this item belongs to. The PR's closingIssuesReferences is
// AUTHORITATIVE when we have it; the locally-inferred branch guess is the
// fallback that makes the feature work with no gh, no network and no PR yet.
export function issueRef(entity, link) {
  const fromPr = link && typeof link.issue_number === 'number' ? link.issue_number : null
  const guess = entity && typeof entity.issue_ref === 'number' ? entity.issue_ref : null
  const num = fromPr ?? guess
  if (!num) return null
  const repo = (entity && entity.repo) || (link && link.repo) || null
  // a cached url that does not survive safeHttpUrl falls back to the constructed
  // one rather than to nothing — and to '' only when there is no repo either
  const constructed = repo ? `https://github.com/${repo}/issues/${num}` : ''
  const cached = fromPr === num && link ? safeHttpUrl(link.issue_url) : ''
  const url = cached || constructed
  const title = fromPr === num && link && link.issue_title ? link.issue_title : ''
  return { num, url: safeHttpUrl(url), title }
}

// The ONE priority order, worst-and-most-final first:
//   MERGED > CLOSED > draft > checks failing > changes requested > approved >
//   checks running > open
// `word` carries the meaning (the glyph is decorative and aria-hidden), and
// `tone` is the only thing the stylesheet keys on. NOTHING here ever reaches
// public/attention.js: a red CI is the agent's problem, not the human being
// blocked, so it never touches a badge (tenets 1 and 2).
export function prChip(link) {
  if (!link || typeof link.pr_number !== 'number') return null
  const text = `PR ${link.pr_number}`
  const state = String(link.pr_state || '').toUpperCase()
  if (state === 'MERGED') return { text, word: 'merged', glyph: '✓', tone: 'merged' }
  if (state === 'CLOSED') return { text, word: 'closed', glyph: '✕', tone: 'muted' }
  if (link.pr_draft) return { text, word: 'draft', glyph: '◌', tone: 'muted' }
  if (link.checks === 'failing') return { text, word: 'checks failing', glyph: '✕', tone: 'bad' }
  if (link.review_decision === 'CHANGES_REQUESTED') return { text, word: 'changes requested', glyph: '↺', tone: 'bad' }
  if (link.review_decision === 'APPROVED') return { text, word: 'approved', glyph: '✓', tone: 'good' }
  if (link.checks === 'pending') return { text, word: 'checks running', glyph: '◍', tone: 'neutral' }
  return { text, word: 'open', glyph: '·', tone: 'neutral' }
}

const ERROR_LABEL = {
  'no-gh': 'gh is not installed — showing the last state it saw',
  auth: 'gh is not logged in — showing the last state it saw',
  'rate-limit': 'GitHub rate limit hit — showing the last state it saw',
  offline: 'offline — showing the last state it saw',
}

function agoLabel(iso, nowMs) {
  const then = Date.parse(iso ?? '')
  if (Number.isNaN(then)) return ''
  const mins = Math.max(0, Math.round((nowMs - then) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

// What the expanded card shows. Deliberately reports checked_at, not fetched_at:
// the human should be able to tell a live "checked 1m ago" from a good row that
// stopped refreshing an hour ago.
export function prDetail(link, nowMs) {
  const chip = prChip(link)
  if (!chip) return null
  const ago = agoLabel(link.checked_at, nowMs)
  return {
    chip,
    title: link.pr_title || '',
    tldr: link.tldr || '',
    url: link.pr_url || '',
    checked: ago ? `checked ${ago}` : '',
    error: link.error ? ERROR_LABEL[link.error] || `last check failed (${link.error})` : '',
  }
}

// The hover TL;DR, as PLAIN TEXT for the native title= attribute — zero JS, zero
// CSS, identical in Electron and the browser, and it cannot inject HTML once
// esc()'d at the interpolation below.
export function sourceTooltip(entity, link, nowMs) {
  const lines = []
  const issue = issueRef(entity, link)
  const detail = prDetail(link, nowMs)
  if (detail) {
    lines.push(`${detail.chip.text} — ${detail.chip.word}`)
    if (detail.title) lines.push(detail.title)
    if (detail.tldr) lines.push(detail.tldr)
  }
  if (issue) lines.push(`issue #${issue.num}${issue.title ? ` — ${issue.title}` : ''}`)
  if (detail && detail.error) lines.push(detail.error)
  if (detail && detail.checked) lines.push(detail.checked)
  return lines.join('\n')
}

// THE one and only href construction in the product. Both source chips and
// structured agent text enter here, so scheme validation and opener isolation
// cannot drift between surfaces.
function anchorHtml(url, innerHtml, attrs) {
  if (!safeHttpUrl(url)) return ''
  return `<a href="${esc(safeHttpUrl(url))}" target="_blank" rel="noopener noreferrer"${attrs ? ` ${attrs}` : ''}>${innerHtml}</a>`
}

// Structured text supplies raw source text as its label. Escaping stays here
// beside href construction so callers cannot accidentally make a safe URL with
// an unsafe label (or vice versa).
export function textLinkHtml(url, label) {
  return anchorHtml(url, esc(label), 'class="structured-link"') || esc(label)
}

// A source-chip URL that does not survive safeHttpUrl renders as a plain span:
// the chip still says what it knows, and no dead-or-hostile link is emitted.
function chipHtml(url, tone, innerHtml, title, tabbable) {
  const attrs = `class="src-chip tone-${esc(tone)}"${title ? ` title="${esc(title)}"` : ''}${tabbable ? '' : ' tabindex="-1"'}`
  return anchorHtml(url, innerHtml, attrs) || `<span ${attrs}>${innerHtml}</span>`
}

function prChipInner(chip) {
  return `<span aria-hidden="true">${esc(chip.glyph)}</span> ${esc(chip.text)} <span class="src-word">${esc(chip.word)}</span>`
}

// The compact row/board chips. `tabbable` defaults to false: §13's roving tab
// order belongs to the rows, and a chip interleaved into it would make arrowing
// through the Needs-you list unusable.
export function sourceChipsHtml(index, entity, nowMs, opts = {}) {
  const link = linkFor(index, entity)
  const issue = issueRef(entity, link)
  const chip = prChip(link)
  if (!issue && !chip) return ''
  const tabbable = opts.tabbable === true
  const tip = sourceTooltip(entity, link, nowMs)
  let html = ''
  if (issue) html += chipHtml(issue.url, 'issue', `#${esc(issue.num)}`, tip, tabbable)
  if (chip) html += chipHtml(link.pr_url, chip.tone, prChipInner(chip), tip, tabbable)
  return html
}

// The full block inside an expanded card. Chips here ARE tabbable — the surface
// is already open, so they are part of its natural reading order.
export function sourceBlockHtml(index, entity, nowMs) {
  const link = linkFor(index, entity)
  const issue = issueRef(entity, link)
  const detail = prDetail(link, nowMs)
  if (!issue && !detail) return ''
  let rows = ''
  if (issue) {
    rows += `<div class="src-row">${chipHtml(issue.url, 'issue', `#${esc(issue.num)}`, '', true)}` +
      `${issue.title ? `<span class="src-tldr">${esc(issue.title)}</span>` : ''}</div>`
  }
  if (detail) {
    rows += `<div class="src-row">${chipHtml(detail.url, detail.chip.tone, prChipInner(detail.chip), '', true)}` +
      `${detail.title ? `<span class="src-tldr">${esc(detail.title)}</span>` : ''}</div>`
    if (detail.tldr) rows += `<div class="src-tldr">${esc(detail.tldr)}</div>`
    if (detail.error) rows += `<div class="src-checked">${esc(detail.error)}</div>`
  }
  const checked = detail && detail.checked ? `<div class="src-checked">${esc(detail.checked)}</div>` : ''
  return `<div class="card-source"><div class="card-source-label">SOURCE</div>${rows}${checked}</div>`
}
