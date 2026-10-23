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
//
// Issue #103 (PR3) adds GitHub's sub-issue relationships to the same chips and
// block: issue titles are third-party text too, and every relationship link
// (parent, trail, sub-issue) is built here from a validated slug and number.
// The issue chip itself keeps #30's URL rules. public/issues.js computes what
// to draw (`opts.issues`); this file only draws it.
import { esc } from './esc.js'
import { closingKeys, issueKey, issueKeyFor } from './issue-key.js'

export const PREVIEW_TTL_MS = 5 * 60_000

// A '/' is legal in both a repo slug and a branch name, so the separator has to
// be something neither can contain. The HEAD repository is part of the key
// (issue #157): a branch name is only unique within the repository it is pushed
// to, and the store caches one verified answer per (repo, branch, head_repo).
// Omitted, the head is the base repo itself: a same-repository PR.
export function linkKey(repo, branch, head = repo) {
  return `${repo}\u0000${branch}\u0000${head}`
}

function cachedKey(l) {
  return linkKey(l.repo, l.branch, l.head_repo || l.repo)
}

export function indexLinks(links) {
  const map = new Map()
  for (const l of links ?? []) if (l && l.repo && l.branch) map.set(cachedKey(l), l)
  return map
}

// The join: an item/board carries the repo it was raised in, the branch as its
// `stream` and the repository that branch is pushed to as `head_repo`; the cache
// is keyed by exactly that triple. N items on one branch therefore share ONE
// cache row, and a merge updates all of them at once. An entity that recorded no
// head (raised before #157) expects a same-repository PR, exactly as the store's
// listLinkTargets() treats it, so it can never be shown a fork's PR.
export function linkFor(index, entity) {
  if (!index || !entity || !entity.repo || !entity.stream) return null
  return index.get(linkKey(entity.repo, entity.stream, entity.head_repo || entity.repo)) ?? null
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

// Which issue an item, plan or row names. issueKeyFor decides, for the chips
// and the poller alike (#103 §4.2): a plan's pin outranks its PR and branch
// issue, and a PR that closes several issues is never guessed. The PR's
// closing issue is AUTHORITATIVE when it is the only one; the locally-inferred
// branch guess is the fallback that works with no gh, no network and no PR yet.
// `row` is a plan row drawn for its plan: its own link replaces the plan's issue.
export function issueRef(entity, link, row = null) {
  const own = row ? issueKey(row.issue_repo, row.issue_number) : null
  const identity = own ? { key: own, source: 'link', certain: true } : issueKeyFor(entity, link)
  const repo = contextRepo(entity, link)
  if (!identity) return unkeyedRef(entity, link, repo)
  const hash = identity.key.lastIndexOf('#')
  const keyRepo = identity.key.slice(0, hash)
  const num = Number(identity.key.slice(hash + 1))
  // the entity's own spelling when it names the same repository, as #30 built it
  const shown = repo && repo.toLowerCase() === keyRepo ? repo : keyRepo
  // a cached url that does not survive safeHttpUrl falls back to the constructed one
  const fromPr = identity.source === 'pr' && link && link.issue_number === num
  const url = (fromPr && safeHttpUrl(link.issue_url)) || safeHttpUrl(`https://github.com/${shown}/issues/${num}`)
  const title = fromPr && link.issue_title ? link.issue_title : ''
  return { num, url, title, key: identity.key, repo: shown, certain: identity.certain }
}

// An issue number with no usable repository (a non-GitHub remote, say) cannot
// be keyed, and keeps #30's chip: the number, linked only if a URL survives
// safeHttpUrl. When the repository IS usable, issueKeyFor's verdict stands: a
// PR that closes several issues names none of them here.
function unkeyedRef(entity, link, repo) {
  const fromPr = link && typeof link.issue_number === 'number' ? link.issue_number : null
  const guess = entity && typeof entity.issue_ref === 'number' ? entity.issue_ref : null
  const num = fromPr ?? guess
  if (!num || issueKey(repo, num)) return null
  const constructed = repo ? `https://github.com/${repo}/issues/${num}` : ''
  const cached = fromPr === num && link ? safeHttpUrl(link.issue_url) : ''
  const title = fromPr === num && link && link.issue_title ? link.issue_title : ''
  return { num, url: safeHttpUrl(cached || constructed), title, key: null, repo: null, certain: false }
}

// The repository an entity's own issue numbers are read against.
function contextRepo(entity, link) {
  return (entity && entity.repo) || (link && link.repo) || null
}

// `#N` beside its own repository, `owner/name#N` anywhere else: a number is
// never shown without its repository when that differs (§4.1).
function issueLabel(repo, number, against) {
  if (!repo) return `#${number}`
  return against && against.toLowerCase() === repo.toLowerCase() ? `#${number}` : `${repo}#${number}`
}

// A relationship link is built from a validated slug and number, or not at all.
function issueUrl(repo, number) {
  return issueKey(repo, number) ? `https://github.com/${repo}/issues/${number}` : ''
}

export function previewRef(link, nowMs) {
  if (!link || link.provider !== 'github' || link.error || link.preview_error
    || link.pr_state !== 'OPEN' || !Number.isSafeInteger(link.pr_number) || link.pr_number <= 0
    || !/^[a-f0-9]{40}$/.test(link.pr_head_sha ?? '')
    || !Number.isSafeInteger(link.preview_deployment_id) || link.preview_deployment_id <= 0) return null
  const age = nowMs - Date.parse(link.fetched_at ?? '')
  if (!Number.isFinite(age) || age < 0 || age >= PREVIEW_TTL_MS) return null
  const url = safeHttpUrl(link.preview_url)
  const environment = typeof link.preview_environment === 'string' ? link.preview_environment.trim() : ''
  if (!url || !environment || !Number.isFinite(Date.parse(link.preview_updated_at ?? ''))) return null
  return { url, environment, headSha: link.pr_head_sha, deploymentId: link.preview_deployment_id }
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
export function sourceTooltip(entity, link, nowMs, opts = {}) {
  const lines = []
  const issue = issueRef(entity, link, opts.row)
  const detail = prDetail(link, nowMs)
  const against = contextRepo(entity, link)
  if (detail) {
    lines.push(`${detail.chip.text} — ${detail.chip.word}`)
    if (detail.title) lines.push(detail.title)
    if (detail.tldr) lines.push(detail.tldr)
    const closes = closesLine(link, against)
    if (closes) lines.push(closes)
  }
  if (issue) {
    const rel = relationFor(issue, opts)
    lines.push(...issueLines(issue, rel, labelRepo(rel, against), nowMs))
  }
  const preview = opts.preview ? previewRef(link, nowMs) : null
  if (preview) lines.push(`Preview — ${preview.environment}`)
  if (opts.preview && link?.preview_error) lines.push('Preview unavailable — its current deployment could not be confirmed')
  if (detail && detail.error) lines.push(detail.error)
  if (detail && detail.checked) lines.push(detail.checked)
  return lines.join('\n')
}

// ── issue #103: relationships from public/issues.js ─────────────────────────

const UNAVAILABLE = {
  'not-found': 'GitHub says this issue does not exist or is not visible',
  forbidden: 'GitHub denied access (SSO?)',
  moved: 'GitHub answered with another issue — update the link',
}
const MARK_GLYPH = { open: '●', completed: '✓', 'not planned': '⊘', duplicate: '⧉', closed: '✓' }
const ownValue = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : '')

// Relationships are drawn only for a certain identity the graph lists as a
// root (§6). Anything else, a root the node cap omitted included, keeps its
// plain chip.
function relationFor(issue, opts) {
  const relations = issue && issue.certain && opts && opts.issues ? opts.issues.relations : null
  return (relations instanceof Map && relations.get(issue.key)) || null
}

// Fresh or stale, with something reconciled to draw. Hidden and unavailable
// relations draw only a line saying why.
const drawn = (rel) => Boolean(rel && rel.node && (rel.freshness === 'fresh' || rel.freshness === 'stale'))
const parentOf = (rel) => {
  const parent = drawn(rel) ? rel.trail[rel.trail.length - 1] : null
  return parent && issueUrl(parent.repo, parent.number) ? parent : null
}
// The chip after a parent chip is read against the parent's repository.
const labelRepo = (rel, against) => parentOf(rel)?.repo ?? against
const ageText = (rel, nowMs) => `${rel.freshness === 'stale' ? 'as of' : 'checked'} ${agoLabel(rel.fetchedAt, nowMs)}`
// a stale answer says why it is stale, in ERROR_LABEL's words
const reasonOf = (rel) => (rel.freshness === 'stale' && rel.error
  ? ownValue(ERROR_LABEL, rel.error) || `last check failed (${rel.error})` : '')
const unavailableText = (rel) => ownValue(UNAVAILABLE, rel.error) || 'GitHub did not answer for this issue'
const keyAttr = (key) => `data-issue-key="${esc(key)}"`

function issueLines(issue, rel, against, nowMs) {
  const label = issueLabel(issue.repo, issue.num, against)
  if (rel && rel.freshness === 'unavailable') return [`issue ${label} — unavailable: ${unavailableText(rel)}`]
  if (!drawn(rel)) return [`issue ${label}${issue.title ? ` — ${issue.title}` : ''}`]
  const { node } = rel
  const progress = node.total > 0 ? ` (${node.completed} of ${node.total} done)` : ''
  const reason = reasonOf(rel)
  return [`issue ${label} — ${node.title}${progress} · ${ageText(rel, nowMs)}`, ...(reason ? [reason] : [])]
}

function parentTip(parent, rel, against, nowMs) {
  const progress = parent.total > 0 ? ` (${parent.completed} of ${parent.total} done)` : ''
  const reason = reasonOf(rel)
  return [
    `Parent: ${issueLabel(parent.repo, parent.number, against)} ${parent.title}${progress} · ${ageText(rel, nowMs)}`,
    ...(reason ? [reason] : []),
  ].join('\n')
}

// A PR that closes several issues names none of them as the chip's issue
// (§4.2); its tooltip lists them all instead.
function closesLine(link, against) {
  const keys = link ? closingKeys(link) : null
  if (!keys || keys.length < 2) return ''
  return `closes ${keys.map((key) => {
    const hash = key.lastIndexOf('#')
    return issueLabel(key.slice(0, hash), key.slice(hash + 1), against)
  }).join(', ')}`
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
// an unsafe label (or vice versa). `kind` (issue #300) says what the link is,
// web or a GitHub pr/issue, for the click handler and the Links strip.
export function textLinkHtml(url, label, kind = 'web') {
  return anchorHtml(url, esc(label), `class="structured-link" data-link-kind="${esc(linkKind(kind))}"`) || esc(label)
}

// ── issue #300: local files and the Links strip ─────────────────────────────
// A local file is never an href. It is a control carrying its path in an
// escaped data- attribute; public/link-open.js asks Electron main to open it,
// and main alone decides what may open. Inline it is a role="button" anchor
// with no href, so its text still reads and selects as part of the sentence.
// Where a click copies the path instead (a browser, or a viewer the app does
// not own), `copy` says so in its title.
const LINK_KINDS = { web: 'Web', pr: 'PR', issue: 'Issue', file: 'File' }
const linkKind = (kind) => (Object.hasOwn(LINK_KINDS, kind) && kind !== 'file' ? kind : 'web')

const fileTitle = (path, title, copy) => (copy ? `Copy path: ${path}` : title || path)

// Issue #324: the path a repo-relative link names inside the repository folder
// its card recorded, for its title and Copy path. Electron main does its own
// join, and alone decides what that opens. The folder's trailing separators go
// by a loop: an unanchored /[\\/]+$/ is quadratic on a long run of them.
export function repoFilePath(root, path) {
  const folder = String(root)
  let end = folder.length
  while (end > 0 && (folder[end - 1] === '/' || folder[end - 1] === '\\')) end--
  return `${folder.slice(0, end)}/${path}`
}

const rootedFile = (root) => typeof root === 'string' && root !== ''
const rootAttr = (root) => (rootedFile(root) ? ` data-link-root="${esc(root)}"` : '')

export function fileLinkHtml(path, label, title, copy = false, root = null) {
  if (typeof path !== 'string' || !path) return esc(label)
  const shown = rootedFile(root) ? repoFilePath(root, path) : path
  return `<a class="structured-link file-link" role="button" tabindex="0" data-link-kind="file" data-link-path="${esc(path)}"${rootAttr(root)}` +
    ` title="${esc(fileTitle(shown, title, copy))}">${esc(label)}</a>`
}

const STRIP_VISIBLE = 6
// Static markup, no supplied text: the two secondary file actions (part 2).
const REVEAL_ICON = '<svg class="link-action-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
  '<circle cx="7" cy="7" r="4.25"/><path d="M10.25 10.25 13.5 13.5"/></svg>'
const COPY_ICON = '<svg class="link-action-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
  '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3.5 10.5v-6a1 1 0 0 1 1-1h6"/></svg>'

// In the desktop app (`actions`), a file chip also offers Reveal and Copy path:
// two buttons carrying the same escaped path, never an href. A repo-relative
// file (#324) carries its repository folder beside it on all three.
function fileChipHtml(link, inner, actions, copyFiles) {
  const path = esc(link.path)
  const root = rootAttr(link.root)
  const shown = rootedFile(link.root) ? repoFilePath(link.root, link.path) : link.path
  const chip = `<button type="button" class="src-chip tone-link" data-link-kind="file" data-link-path="${path}"${root}` +
    ` title="${esc(fileTitle(shown, link.title, copyFiles))}">${inner}</button>`
  if (!actions || typeof actions.reveal !== 'string') return chip
  return `<span class="link-file" role="group" aria-label="${esc(`File ${link.label}`)}">${chip}` +
    `<button type="button" class="link-file-action" data-link-action="reveal" data-link-path="${path}"${root}` +
    ` title="${esc(actions.reveal)}" aria-label="${esc(`${actions.reveal}: ${link.label}`)}">${REVEAL_ICON}</button>` +
    `<button type="button" class="link-file-action" data-link-action="copy" data-link-path="${path}"${root}` +
    ` title="Copy path" aria-label="${esc(`Copy path: ${link.label}`)}">${COPY_ICON}</button></span>`
}

function linkChipHtml(link, actions, copyFiles) {
  if (!link || !Object.hasOwn(LINK_KINDS, link.kind)) return ''
  const inner = `<span class="link-kind">${esc(LINK_KINDS[link.kind])}</span> <span class="link-label">${esc(link.label)}</span>`
  if (link.kind === 'file') {
    if (typeof link.path !== 'string' || !link.path) return ''
    return fileChipHtml(link, inner, actions, copyFiles)
  }
  if (!safeHttpUrl(link.url)) return ''
  return chipHtml(link.url, 'link', inner, link.title || '', true, `data-link-kind="${esc(link.kind)}"`)
}

// The compact Links strip at the top of an open card (§2 of the issue): every
// link the card's text shows, the item's own PR and issue first, each with
// its kind and a short label; past the first few, a "+N more" disclosure whose
// open state the caller keeps by `key` across rebuilds. `copyFiles`: a file
// chip's click copies its path here (see fileLinkHtml).
export function linkStripHtml(links, { key = '', open = false, actions = null, copyFiles = false } = {}) {
  const chips = (Array.isArray(links) ? links : []).map((link) => linkChipHtml(link, actions, copyFiles)).filter(Boolean)
  if (!chips.length) return ''
  const rest = chips.slice(STRIP_VISIBLE)
  const more = rest.length
    ? `<details class="card-links-more" data-context-key="${esc(key)}"${open ? ' open' : ''}>` +
      `<summary>${esc(`+${rest.length} more`)}</summary><span class="card-links-rest">${rest.join('')}</span></details>`
    : ''
  return `<div class="card-links" role="group" aria-label="Links"><span class="card-links-label" aria-hidden="true">Links</span>` +
    `${chips.slice(0, STRIP_VISIBLE).join('')}${more}</div>`
}

// A source-chip URL that does not survive safeHttpUrl renders as a plain span:
// the chip still says what it knows, and no dead-or-hostile link is emitted.
function chipHtml(url, tone, innerHtml, title, tabbable, extraAttrs = '') {
  const attrs = `class="src-chip tone-${esc(tone)}"${title ? ` title="${esc(title)}"` : ''}${tabbable ? '' : ' tabindex="-1"'}${extraAttrs ? ` ${extraAttrs}` : ''}`
  return anchorHtml(url, innerHtml, attrs) || `<span ${attrs}>${innerHtml}</span>`
}

function prChipInner(chip) {
  return `<span aria-hidden="true">${esc(chip.glyph)}</span> ${esc(chip.text)} <span class="src-word">${esc(chip.word)}</span>`
}

function previewChipHtml(link, preview, entity, tabbable) {
  const attrs = `data-preview-key="${esc(encodeURIComponent(cachedKey(link)))}" data-preview-head="${esc(preview.headSha)}" data-preview-deployment="${esc(preview.deploymentId)}" data-preview-project="${esc(entity?.project ?? '')}"`
  return chipHtml(preview.url, 'neutral', 'Preview',
    `Open ${preview.environment} preview for the current PR commit (new tab)`, tabbable, attrs)
}

// The issue's own chips. With relationships: the nearest parent as its own
// anchor, `›`, then the issue, with GitHub's child progress when it has
// children (§7.1). Stale ones are dimmed; an unavailable one says so; anything
// else is #30's plain chip, byte for byte.
function issueChipsHtml(issue, rel, against, tip, tabbable, nowMs) {
  const label = (ctx) => esc(issueLabel(issue.repo, issue.num, ctx))
  if (rel && rel.freshness === 'unavailable') {
    return chipHtml(issue.url, 'issue', `${label(against)} <span class="src-word">unavailable</span>`, tip, tabbable, keyAttr(issue.key))
  }
  if (!drawn(rel)) return chipHtml(issue.url, 'issue', label(against), tip, tabbable)
  const tone = rel.freshness === 'stale' ? 'stale' : 'issue'
  const parent = parentOf(rel)
  let html = ''
  if (parent) {
    const text = issueLabel(parent.repo, parent.number, against)
    html += chipHtml(issueUrl(parent.repo, parent.number), tone, esc(text), parentTip(parent, rel, against, nowMs), tabbable,
      `${keyAttr(parent.key)} aria-label="${esc(`Parent issue ${text}`)}"`)
    html += '<span class="src-sep" aria-hidden="true">›</span>'
  }
  const { node } = rel
  const progress = node.total > 0 ? ` <span class="src-progress">· ${esc(node.completed)}/${esc(node.total)}</span>` : ''
  return html + chipHtml(issue.url, tone, `${label(labelRepo(rel, against))}${progress}`, tip, tabbable, keyAttr(issue.key))
}

function markHtml(node) {
  const word = Object.hasOwn(MARK_GLYPH, node.mark) ? node.mark : node.state === 'OPEN' ? 'open' : 'closed'
  return `<span class="src-mark" role="img" aria-label="${esc(word)}" title="${esc(word)}">${MARK_GLYPH[word]}</span>`
}

function nodeChipHtml(node, against, tone) {
  return chipHtml(issueUrl(node.repo, node.number), tone, esc(issueLabel(node.repo, node.number, against)), '', true, keyAttr(node.key))
}

// Agent Inbox activity (§7.3). A label with a target opens that item, plan or
// row here; app.js binds the click to its focusItem path.
function activityHtml(activity) {
  const target = activity && activity.target
  if (!target || typeof target.id !== 'string') return `<span class="src-activity">${esc(activity ? activity.label : '')}</span>`
  const row = typeof target.rowId === 'string' ? ` data-issue-row="${esc(target.rowId)}"` : ''
  return `<button type="button" class="src-activity" data-issue-open="${esc(target.id)}"${row}>${esc(activity.label)}</button>`
}

const linkable = (node) => Boolean(node && issueUrl(node.repo, node.number))

// The parent trail, top first, each level read against the one above it.
function trailHtml(rel, against, tone) {
  const trail = rel.trail.filter(linkable)
  if (!trail.length) return ''
  let ctx = against
  const levels = trail.map((node, index) => {
    const progress = index === trail.length - 1 && node.total > 0
      ? `<span class="src-progress">${esc(`· ${node.completed} of ${node.total} done`)}</span>` : ''
    const html = `<li class="src-row">${markHtml(node)}${nodeChipHtml(node, ctx, tone)}<span class="src-tldr">${esc(node.title)}</span>${progress}</li>`
    ctx = node.repo
    return html
  })
  return `<ol class="src-trail" aria-label="Parent issues on GitHub">${levels.join('')}</ol>`
}

// "Sub-issues on GitHub · N of M done", in GitHub's order. GitHub's progress
// stays separate from a plan's own progress bar, which measures its rows.
function childrenHtml(rel, tone) {
  const { node, more } = rel
  const children = rel.children.filter((child) => linkable(child.node))
  if (!children.length && !(node.total > 0)) return ''
  const head = `Sub-issues on GitHub${node.total > 0 ? ` · ${node.completed} of ${node.total} done` : ''}`
  const items = children.map(({ node: child, activity }) =>
    `<li class="src-child">${markHtml(child)}${nodeChipHtml(child, node.repo, tone)}<span class="src-tldr">${esc(child.title)}</span>${activityHtml(activity)}</li>`)
  for (const [n, what] of [[more.notVisible, 'not visible to your GitHub account'], [more.onGitHub, 'more on GitHub'], [more.notShown, 'not shown']]) {
    if (n > 0) items.push(`<li class="src-more">${esc(`+${n} ${what}`)}</li>`)
  }
  return `<div class="src-children"><div class="src-children-head">${esc(head)}</div><ol class="src-child-list">${items.join('')}</ol></div>`
}

const lineHtml = (text) => `<div class="src-checked">${esc(text)}</div>`

// Slice 2 §9.1: "Dependencies on GitHub", open issues only, below the
// sub-issues. A dependency is not the human's blocker: neutral tones, never
// the blocked mark or the word, and only text says "waits on" or "circular".
function dependencySideHtml(heading, side, more, against, tone) {
  const items = side.filter((dep) => linkable(dep.node)).map(({ node, activity }) =>
    `<li class="src-child">${markHtml(node)}${nodeChipHtml(node, against, tone)}<span class="src-tldr">${esc(node.title)}</span>${activityHtml(activity)}</li>`)
  for (const [n, what] of [[more.notVisible, 'not visible to your GitHub account'], [more.onGitHub, 'more on GitHub']]) {
    if (n > 0) items.push(`<li class="src-more">${esc(`+${n} ${what}`)}</li>`)
  }
  if (!items.length) return ''
  return `<div class="src-deps-head">${esc(heading)}</div><ul class="src-child-list src-dep-list" aria-label="${esc(heading)}">${items.join('')}</ul>`
}

function dependenciesHtml(rel, tone) {
  const deps = rel.dependencies
  if (!deps) return ''
  if (deps.status === 'unavailable') return lineHtml('Dependencies unavailable — GitHub returned this issue but not its dependencies')
  if (deps.status !== 'ok') return ''
  const against = rel.node.repo
  const body = (deps.cycle ? lineHtml('Circular dependency on GitHub') : '')
    + dependencySideHtml('Waits on', deps.waitsOn, deps.more.waitsOn, against, tone)
    + dependencySideHtml('Unblocks', deps.unblocks, deps.more.unblocks, against, tone)
    + (deps.more.notShown > 0 ? `<div class="src-more">${esc(`+${deps.more.notShown} not shown`)}</div>` : '')
  return body ? `<div class="src-children src-deps"><div class="src-children-head">Dependencies on GitHub</div>${body}</div>` : ''
}

// How fresh the relationships are, or why there are none. Only drawn ones ever
// say "checked" or "as of".
function freshnessHtml(rel, nowMs) {
  if (rel.freshness === 'unavailable') return lineHtml(`Relationships unavailable — ${unavailableText(rel)}`)
  if (rel.freshness === 'hidden') return lineHtml(`Relationships unavailable — last seen ${agoLabel(rel.fetchedAt, nowMs)}`)
  if (rel.freshness === 'no-hierarchy') {
    return lineHtml('Relationships unavailable — GitHub returned this issue but not its parent or sub-issues')
  }
  if (!drawn(rel)) return ''
  const reason = reasonOf(rel)
  return lineHtml(`Relationships ${ageText(rel, nowMs)}${reason ? ` — ${reason}` : ''}`)
}

// The issue's part of the card block: its trail, its own row, its sub-issues
// and a freshness line. With no relationship it is #30's row, byte for byte.
function issueBlockHtml(issue, rel, against, nowMs) {
  if (rel && rel.freshness === 'unavailable') {
    return `<div class="src-row">${chipHtml(issue.url, 'issue', `${esc(issueLabel(issue.repo, issue.num, against))} <span class="src-word">unavailable</span>`, '', true, keyAttr(issue.key))}</div>${freshnessHtml(rel, nowMs)}`
  }
  if (!drawn(rel)) {
    return `<div class="src-row">${chipHtml(issue.url, 'issue', esc(issueLabel(issue.repo, issue.num, against)), '', true)}` +
      `${issue.title ? `<span class="src-tldr">${esc(issue.title)}</span>` : ''}</div>${rel ? freshnessHtml(rel, nowMs) : ''}`
  }
  const tone = rel.freshness === 'stale' ? 'stale' : 'issue'
  const self = `<div class="src-row">${markHtml(rel.node)}${chipHtml(issue.url, tone, esc(issueLabel(issue.repo, issue.num, labelRepo(rel, against))), '', true, keyAttr(issue.key))}` +
    `<span class="src-tldr">${esc(rel.node.title)}</span></div>`
  return trailHtml(rel, against, tone) + self + childrenHtml(rel, tone) + dependenciesHtml(rel, tone) + freshnessHtml(rel, nowMs)
}

// The compact row/board chips. `tabbable` defaults to false: §13's roving tab
// order belongs to the rows, and a chip interleaved into it would make arrowing
// through the Needs-you list unusable.
export function sourceChipsHtml(index, entity, nowMs, opts = {}) {
  const link = linkFor(index, entity)
  const issue = issueRef(entity, link, opts.row)
  const chip = prChip(link)
  const preview = opts.preview ? previewRef(link, nowMs) : null
  if (!issue && !chip) return ''
  const tabbable = opts.tabbable === true
  const tip = sourceTooltip(entity, link, nowMs, opts)
  let html = ''
  if (issue) html += issueChipsHtml(issue, relationFor(issue, opts), contextRepo(entity, link), tip, tabbable, nowMs)
  if (chip) html += chipHtml(link.pr_url, chip.tone, prChipInner(chip), tip, tabbable)
  if (preview) html += previewChipHtml(link, preview, entity, tabbable)
  return html
}

// A plan row's own issue, beside its note in the plan's matrix (§7.1). A row
// with no link of its own draws nothing there: the plan's chips name its issue.
export function rowIssueChipsHtml(row, plan, nowMs, opts = {}) {
  if (!row || !issueKey(row.issue_repo, row.issue_number)) return ''
  const issue = issueRef(plan, null, row)
  const rel = relationFor(issue, opts)
  const against = contextRepo(plan, null)
  const tip = issueLines(issue, rel, labelRepo(rel, against), nowMs).join('\n')
  return issueChipsHtml(issue, rel, against, tip, opts.tabbable === true, nowMs)
}

// The full block inside an expanded card. Chips here ARE tabbable — the surface
// is already open, so they are part of its natural reading order.
export function sourceBlockHtml(index, entity, nowMs, opts = {}) {
  const link = linkFor(index, entity)
  const issue = issueRef(entity, link, opts.row)
  const detail = prDetail(link, nowMs)
  const preview = opts.preview ? previewRef(link, nowMs) : null
  if (!issue && !detail) return ''
  const against = contextRepo(entity, link)
  let rows = ''
  if (issue) rows += issueBlockHtml(issue, relationFor(issue, opts), against, nowMs)
  if (detail) {
    rows += `<div class="src-row">${chipHtml(detail.url, detail.chip.tone, prChipInner(detail.chip), '', true)}` +
      `${detail.title ? `<span class="src-tldr">${esc(detail.title)}</span>` : ''}</div>`
    if (detail.tldr) rows += `<div class="src-tldr">${esc(detail.tldr)}</div>`
    const closes = closesLine(link, against)
    if (closes) rows += lineHtml(closes)
    if (detail.error) rows += `<div class="src-checked">${esc(detail.error)}</div>`
  }
  if (preview) rows += `<div class="src-row">${previewChipHtml(link, preview, entity, true)}</div>`
  const checked = detail && detail.checked ? `<div class="src-checked">${esc(detail.checked)}</div>` : ''
  return `<div class="card-source"><div class="card-source-label">SOURCE</div>${rows}${checked}</div>`
}

// A plan card's relationships (§3.2): its issue's parent trail and its
// sub-issues with their Agent Inbox activity. The plan's chips already name the
// issue itself, so this is '' unless there is a trail, a child, or a reason why
// relationships are missing.
export function issueRelationsHtml(index, entity, nowMs, opts = {}) {
  const link = linkFor(index, entity)
  const issue = issueRef(entity, link, opts.row)
  const rel = relationFor(issue, opts)
  if (!rel) return ''
  let body = ''
  if (drawn(rel)) {
    const tone = rel.freshness === 'stale' ? 'stale' : 'issue'
    body = trailHtml(rel, contextRepo(entity, link), tone) + childrenHtml(rel, tone) + dependenciesHtml(rel, tone)
    if (!body) return ''
  }
  const line = freshnessHtml(rel, nowMs)
  return line ? `<div class="card-source src-relations">${body}${line}</div>` : ''
}

// Slice 2 §7.5: one group of plans under their shared GitHub parent. A heading,
// not a control: the parent's chip, its title, GitHub's progress when known,
// how many plans, and their project, since plans of two projects never share
// a group. A group whose members are all stale is dimmed and says "as of".
export function planGroupHeadHtml(group, nowMs, opts = {}) {
  const { parent } = group
  const tone = group.stale ? 'stale' : 'issue'
  const label = issueLabel(parent.repo, parent.number, group.against)
  const chip = chipHtml(issueUrl(parent.repo, parent.number), tone, esc(label), `issue ${label} — ${parent.title}`, true,
    keyAttr(parent.key))
  const meta = [
    ...(parent.total > 0 ? [`${parent.completed} of ${parent.total} sub-issues done`] : []),
    `${group.size} plan${group.size === 1 ? '' : 's'}`,
    group.project,
    ...(group.stale ? [`as of ${agoLabel(group.fetchedAt, nowMs)}`] : []),
  ].join(' · ')
  const title = `${parent.title}${opts.continued ? ' (continued)' : ''}`
  return `<h3 class="plan-group-head${group.stale ? ' stale' : ''}">${chip}` +
    `<span class="plan-group-title">${esc(title)}</span><span class="plan-group-meta">${esc(meta)}</span></h3>`
}

// A thin "Part of #117" over a run of a plan's rows (§7.1), a header cell for
// the matrix's own <tr>.
export function rowParentHeadHtml(parent, plan) {
  const label = issueLabel(parent.repo, parent.number, contextRepo(plan, null))
  return `<th colspan="5" scope="colgroup" class="row-parent-head" title="${esc(parent.title)}">${esc(`Part of ${label}`)}</th>`
}

// ── slice 2 §9.1: what a plan or row waits on ───────────────────────────────

const waitsOf = (opts, table, id) => {
  const map = opts && opts.issues ? opts.issues[table] : null
  const entries = map instanceof Map && typeof id === 'string' ? map.get(id) : null
  // an issue that is no valid slug and number is never named, as everywhere here
  return (Array.isArray(entries) ? entries : []).flatMap((entry) => {
    if (!entry.node || linkable(entry.node)) return [entry]
    return entry.step ? [{ ...entry, node: null, activity: null, freshness: null, sources: ['step'] }] : []
  })
}
const waitIssueLabel = (entry, against) => issueLabel(entry.node.repo, entry.node.number, against)
const waitSource = (entry) => entry.sources.map((source) => (source === 'step' ? 'step in this plan' : 'GitHub')).join(' · ')

// One target as plain text: "step Build (#119 Title)", "#119 Title" or "step Build".
function waitText(entry, against) {
  const issue = entry.node ? `${waitIssueLabel(entry, against)} ${entry.node.title}` : ''
  if (!entry.step) return issue
  return `step ${entry.step.label}${issue ? ` (${issue})` : ''}`
}

// The chip's age line: "as of …" once any GitHub half is stale.
function waitsAge(entries, nowMs) {
  const github = entries.filter((entry) => entry.node && entry.freshness)
  if (!github.length) return ''
  const stale = github.find((entry) => entry.freshness === 'stale')
  return stale ? `as of ${agoLabel(stale.fetchedAt, nowMs)}` : `checked ${agoLabel(github[0].fetchedAt, nowMs)}`
}

// "waits on #119", "waits on 3", "waits on step Build" or "waits on 2 steps";
// its title lists each target with its source. Only one issue is a link.
function waitsChipHtml(entries, against, nowMs, tabbable) {
  if (!entries.length) return ''
  const [first] = entries
  let label
  if (entries.length > 1) label = `waits on ${entries.length}${entries.every((entry) => entry.step) ? ' steps' : ''}`
  else label = first.step ? `waits on step ${first.step.label}` : `waits on ${waitIssueLabel(first, against)}`
  const url = entries.length === 1 && !first.step && first.node ? issueUrl(first.node.repo, first.node.number) : ''
  const age = waitsAge(entries, nowMs)
  const tip = ['Waits on:', ...entries.map((entry) => `${waitText(entry, against)} — ${waitSource(entry)}`), ...(age ? [age] : [])].join('\n')
  const tone = entries.some((entry) => entry.freshness === 'stale') ? 'stale' : 'issue'
  return chipHtml(url, tone, esc(label), tip, tabbable, `data-waits-on="${esc(entries.length)}"`)
}

// After a row's issue chip, in the plan's matrix and the row's card.
export function rowWaitsChipHtml(row, plan, nowMs, opts = {}) {
  return waitsChipHtml(waitsOf(opts, 'rowWaits', row && row.id), contextRepo(plan, null), nowMs, opts.tabbable === true)
}

// Beside a plan's own issue chip.
export function planWaitsChipHtml(plan, nowMs, opts = {}) {
  return waitsChipHtml(waitsOf(opts, 'planWaits', plan && plan.id), contextRepo(plan, null), nowMs, opts.tabbable === true)
}

// The row detail's "Waits on" (rowPanelEl): both kinds, each with its source.
export function rowWaitsHtml(row, plan, nowMs, opts = {}) {
  const entries = waitsOf(opts, 'rowWaits', row && row.id)
  if (!entries.length) return ''
  const against = contextRepo(plan, null)
  const items = entries.map((entry) => {
    const step = entry.step ? `<span class="src-step">${esc(`step ${entry.step.label}`)}</span>` : ''
    const tone = entry.freshness === 'stale' ? 'stale' : 'issue'
    const issue = entry.node
      ? `${markHtml(entry.node)}${nodeChipHtml(entry.node, against, tone)}<span class="src-tldr">${esc(entry.node.title)}</span>` : ''
    return `<li class="src-wait">${step}${issue}<span class="src-wait-source">${esc(waitSource(entry))}</span></li>`
  })
  const age = waitsAge(entries, nowMs)
  return `<div class="card-source src-waits"><div class="card-source-label">WAITS ON</div><ul class="src-wait-list">${items.join('')}</ul>` +
    `${age ? lineHtml(age) : ''}</div>`
}

// ── slice 2 §9.2: dependencies in Plan flow ─────────────────────────────────
// A step of this plan is a button that moves focus to its node (app.js binds
// `data-mission-step`); an issue no row of this plan links is its GitHub chip
// and its Agent Inbox activity, never an edge to another plan. Text, not
// colour, says "waits on", "unblocks", "part of" and "circular".

function missionDepHtml(dep, verb, against) {
  if (dep.kind === 'step') {
    const text = `${dep.label}${dep.issue ? ` (${issueLabel(dep.issue.repo, dep.issue.number, against)})` : ''}`
    return `<button type="button" class="mission-step-link" data-mission-step="${esc(dep.rowId)}"` +
      ` aria-label="${esc(`${verb} step ${text}`)}" title="${esc(waitSource(dep))}">${esc(text)}</button>`
  }
  if (!linkable(dep.node)) return ''
  const tone = dep.freshness === 'stale' ? 'stale' : 'issue'
  return `<span class="mission-ext">${nodeChipHtml(dep.node, against, tone)}<span class="src-tldr">${esc(dep.node.title)}</span>` +
    `${dep.activity ? activityHtml(dep.activity) : ''}</span>`
}

function missionEdgeHtml(cls, verb, deps, against) {
  const items = deps.map((dep) => missionDepHtml(dep, verb, against)).filter(Boolean)
  if (!items.length) return ''
  const list = items.map((html, i) => `<li>${i ? '<span class="mission-sep" aria-hidden="true">·</span>' : ''}${html}</li>`).join('')
  return `<div class="${cls}"><span class="mission-edge-word">${esc(verb)}:</span><ul class="mission-edge-list" aria-label="${esc(verb)}">${list}</ul></div>`
}

// Below a step's summary: "Circular dependency", the "Part of #117" rail, then
// "Waits on:" and "Unblocks:". '' when the step has none of them.
export function missionDepsHtml(path, plan) {
  const against = contextRepo(plan, null)
  let html = path.circular ? '<div class="mission-circular">Circular dependency</div>' : ''
  const parent = path.partOf && linkable(path.partOf.node) ? path.partOf.node : null
  if (parent) {
    html += `<div class="mission-edge-contains" title="${esc(parent.title)}">${esc(`Part of ${issueLabel(parent.repo, parent.number, against)}`)}</div>`
  }
  html += missionEdgeHtml('mission-edge-waits', 'Waits on', path.waitsOn, against)
  html += missionEdgeHtml('mission-edge-waits mission-edge-unblocks', 'Unblocks', path.unblocks, against)
  return html ? `<div class="mission-deps">${html}</div>` : ''
}

// The foot's fold: the plan issue's sub-issues that no row of the plan links.
export function missionOutsideHtml(outside, plan, opts = {}) {
  const list = outside ? outside.list.filter((child) => linkable(child.node)) : []
  if (!list.length) return ''
  const against = contextRepo(plan, null)
  const tone = outside.freshness === 'stale' ? 'stale' : 'issue'
  const items = list.map(({ node, activity }) =>
    `<li class="src-child">${markHtml(node)}${nodeChipHtml(node, against, tone)}<span class="src-tldr">${esc(node.title)}</span>${activityHtml(activity)}</li>`)
  const key = typeof opts.key === 'string' && opts.key ? ` data-context-key="${esc(opts.key)}"` : ''
  return `<details class="mission-outside"${key}${opts.open ? ' open' : ''}><summary>${esc(`Not in this plan · ${list.length}`)}</summary>` +
    `<ul class="src-child-list" aria-label="Sub-issues not in this plan">${items.join('')}</ul></details>`
}
