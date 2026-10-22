// Links in agent-written text (issue #300). Pure: no DOM, no network, no clock.
//
// structured-text.js finds web URLs; this module finds the other two kinds in
// the plain runs between them: GitHub references (#287, PR #284, owner/name#12)
// and local file paths (/Users/…, ~/…, with an optional :line). It renders
// each inline through source.js, which owns every href and escaped attribute,
// and hands every link it renders to an optional collector, which is how a
// card's Links strip lists exactly the links its text shows.
//
// Conservative on purpose: a wrong link is worse than none. Ordinals ("the #1
// cause", "step #12"), CSS colours, entities, version numbers, dates, routes
// such as /api/items, globs, and anything glued to a neighbouring token stay
// plain text. Every check looks a bounded distance back or ahead, so a run is
// scanned in linear time.
import { esc } from './esc.js'
import { issueKey } from './issue-key.js'
import { fileLinkHtml, safeHttpUrl, textLinkHtml } from './source.js'

const CANDIDATE_RE = /[#~/]/g
const REF_NUMBER_RE = /#([1-9]\d{0,6})/y
const LINE_RE = /:(\d{1,7})(?::\d{1,7})?(?:-\d{1,7})?/y
// What may come before a reference or a path. A backtick may open a path,
// never a reference: `#12` is code.
const REF_OPEN_RE = /[\s([{"'«“‘,;\-–—]/u
const PATH_OPEN_RE = /[\s([{"'`«“‘,;=]/u
// What may come after either, directly or after one sentence mark.
const CLOSE_RE = /[\s)\]}"'`»”’]/u
const PUNCT_RE = /[.,;:!?…]/u
const DASH_RE = /[-–—]/u
const PATH_CHAR_RE = /[\p{L}\p{N}\p{M}._~@%+\-/]/u
const NAME_CHAR_RE = /[A-Za-z0-9._-]/
const OWNER_CHAR_RE = /[A-Za-z0-9-]/
// GitHub owners: letters, digits and single inner hyphens, at most 39.
const OWNER_RE = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/
const NAME_LIKE_RE = /^[\p{L}\p{N}._-]+\//u
const EXTENSION_RE = /\.[A-Za-z][A-Za-z0-9]{0,7}["'`)\]}.,;:!?…]*$/u

// The roots a local file an agent names starts from. Anything else that
// starts with a slash (a route such as /api/items, a regex, /dev/null) is not
// a file someone opens from the Inbox.
const PATH_ROOTS = new Set([
  'Applications', 'Library', 'Network', 'System', 'Users', 'Volumes',
  'etc', 'home', 'media', 'mnt', 'nix', 'opt', 'private', 'root', 'snap', 'srv', 'tmp', 'usr', 'var', 'workspaces',
])
// A number after one of these words counts something else: "step #12",
// "CI run #1234", "color: #111".
const NOT_REFS = new Set([
  'attempt', 'background', 'batch', 'border', 'build', 'case', 'cell', 'chapter', 'check', 'col', 'color', 'colour',
  'column', 'comment', 'commit', 'day', 'entry', 'episode', 'fig', 'figure', 'fill', 'finding', 'gate', 'hex', 'item',
  'iteration', 'job', 'lane', 'layer', 'level', 'line', 'lines', 'message', 'msg', 'no', 'nr', 'num', 'number', 'option',
  'page', 'part', 'pass', 'phase', 'point', 'position', 'priority', 'question', 'rank', 'ranked', 'release', 'rev',
  'revision', 'round', 'row', 'rule', 'run', 'sample', 'section', 'session', 'slide', 'slot', 'sprint', 'stage', 'step',
  'stroke', 'table', 'task', 'test', 'ticket', 'tier', 'try', 'version', 'wave', 'week', 'worker', 'year',
])
// A single-digit #N links only after one of these: on its own, "#1" is far
// more often an ordinal than an issue.
const REF_WORDS = new Set([
  'issue', 'issues', 'pr', 'prs', 'fix', 'fixes', 'fixed', 'close', 'closes', 'closed', 'resolve', 'resolves', 'resolved',
  'ref', 'refs',
])

const opensRef = (value, index) => index === 0 || REF_OPEN_RE.test(value[index - 1])
const opensPath = (value, index) => index === 0 || PATH_OPEN_RE.test(value[index - 1])

// Whether a link may end at `index`: the end of the text, a space or closing
// mark, a sentence mark that is itself followed by one, or a dash that leads
// to the next reference ("#12–#15").
function closesAt(value, index) {
  const ch = value[index]
  if (ch === undefined || CLOSE_RE.test(ch)) return true
  const next = value[index + 1]
  if (PUNCT_RE.test(ch)) return next === undefined || CLOSE_RE.test(next) || PUNCT_RE.test(next)
  return DASH_RE.test(ch) && (next === '#' || next === undefined || /\s/.test(next))
}

// The word right before `index`, lowercased, across at most three spaces or
// one colon or equals sign ("Refs: #12", "color: #111"); '' when there is none.
function wordBefore(value, index, min) {
  let j = index - 1
  while (j >= min && j > index - 4 && /[\s:=]/.test(value[j])) j--
  const end = j + 1
  while (j >= min && end - j <= 16 && /[A-Za-z]/.test(value[j])) j--
  if (j >= min && /\w/.test(value[j])) return { word: '', start: end }
  return { word: value.slice(j + 1, end).toLowerCase(), start: j + 1 }
}

// owner/name right before a '#', or null.
function slugBefore(value, hash, min) {
  let j = hash - 1
  while (j >= min && j > hash - 102 && NAME_CHAR_RE.test(value[j])) j--
  const slash = j
  if (slash < min || value[slash] !== '/' || slash === hash - 1) return null
  j = slash - 1
  while (j >= min && j > slash - 41 && OWNER_CHAR_RE.test(value[j])) j--
  const start = j + 1
  if (start === slash || !opensRef(value, start)) return null
  const owner = value.slice(start, slash)
  const name = value.slice(slash + 1, hash)
  if (!OWNER_RE.test(owner) || name === '.' || name === '..') return null
  return { start, repo: `${owner}/${name}` }
}

function refAt(value, hash, min, to, ctx) {
  REF_NUMBER_RE.lastIndex = hash
  const match = REF_NUMBER_RE.exec(value)
  const end = match ? hash + match[0].length : -1
  if (!match || end > to || !closesAt(value, end)) return null
  const number = Number(match[1])
  const slug = slugBefore(value, hash, min)
  // "PR#284": the one place a reference may touch the word before it
  const touchingPr = !slug && hash - 2 >= min && /^pr$/i.test(value.slice(hash - 2, hash)) && opensRef(value, hash - 2)
  if (!slug && !touchingPr && !opensRef(value, hash)) return null
  const start = slug ? slug.start : hash
  const before = wordBefore(value, touchingPr ? hash - 2 : start, min)
  if (NOT_REFS.has(before.word)) return null
  const pull = before.word === 'request' && wordBefore(value, before.start, min).word === 'pull'
  const pr = touchingPr || pull || before.word === 'pr' || before.word === 'prs'
  const explicit = Boolean(slug) || pr || REF_WORDS.has(before.word) || (value[hash - 1] === '(' && value[end] === ')')
  if (!explicit && number < 10) return null
  const repo = slug ? slug.repo : ctx.repo
  const key = issueKey(repo, number)
  if (!key) return null
  const kind = pr ? 'pr' : 'issue'
  const url = safeHttpUrl(`https://github.com/${repo}/${pr ? 'pull' : 'issues'}/${number}`)
  if (!url) return null
  return { kind, start, end, text: value.slice(start, end), repo, number, key, url }
}

// After a folder name with no extension, a space and then "Documents/a.md" or
// "Notes.md" means the path went on across the space ("My Documents/a.md"):
// linking only its first half would open the wrong thing.
function continuesAcrossSpace(value, path, stop) {
  if (value[stop] !== ' ') return false
  const last = path.slice(path.lastIndexOf('/') + 1)
  if (!last || last.includes('.')) return false
  let end = stop + 1
  while (end < value.length && end < stop + 257 && !/\s/.test(value[end])) end++
  const token = value.slice(stop + 1, end)
  return NAME_LIKE_RE.test(token) || EXTENSION_RE.test(token)
}

function pathAt(value, start, to) {
  if (!opensPath(value, start)) return null
  let body
  if (value[start] === '~') {
    if (value[start + 1] !== '/') return null
    body = start + 2
  } else {
    let k = start + 1
    while (k < to && k < start + 14 && /[A-Za-z]/.test(value[k])) k++
    if (value[k] !== '/' || !PATH_ROOTS.has(value.slice(start + 1, k))) return null
    body = k + 1
  }
  let j = body
  while (j < to && PATH_CHAR_RE.test(value[j])) j++
  let end = j
  while (end > body && value[end - 1] === '.') end--
  if (!/[^/]/.test(value.slice(body, end))) return null
  const path = value.slice(start, end)
  LINE_RE.lastIndex = end
  const line = end < to ? LINE_RE.exec(value) : null
  const stop = line && end + line[0].length <= to ? end + line[0].length : end
  if (!closesAt(value, stop) || continuesAcrossSpace(value, path, stop)) return null
  return {
    kind: 'file', start, end: stop, text: value.slice(start, stop), path,
    line: stop > end && line ? Number(line[1]) : null,
  }
}

// Every reference and path in value[from, to), in order. The characters just
// outside the run still decide its boundaries, so a link never ends inside a
// token the next run continues.
export function findPlainLinks(value, from = 0, to = value.length, ctx = {}) {
  const found = []
  let min = from
  CANDIDATE_RE.lastIndex = from
  for (let match = CANDIDATE_RE.exec(value); match && match.index < to; match = CANDIDATE_RE.exec(value)) {
    const index = match.index
    const link = value[index] === '#' ? refAt(value, index, min, to, ctx ?? {}) : pathAt(value, index, to)
    if (!link) continue
    found.push(link)
    min = link.end
    CANDIDATE_RE.lastIndex = link.end
  }
  return found
}

function collect(ctx, link) {
  if (ctx && Array.isArray(ctx.found)) ctx.found.push(link)
}

// The plain run value[from, to), escaped, with its references as GitHub
// anchors and its paths as inert controls that carry the path (never an href).
export function linkedHtml(value, from, to, ctx) {
  let html = ''
  let cursor = from
  for (const link of findPlainLinks(value, from, to, ctx)) {
    html += esc(value.slice(cursor, link.start))
    html += link.kind === 'file'
      ? fileLinkHtml(link.path, link.text, link.text, Boolean(ctx && ctx.copyFiles === true))
      : textLinkHtml(link.url, link.text, link.kind)
    collect(ctx, link)
    cursor = link.end
  }
  return html + esc(value.slice(cursor, to))
}

// A web URL structured-text found, as its inline anchor.
export function webLinkHtml(url, ctx) {
  const safe = safeHttpUrl(url)
  if (safe) collect(ctx, { kind: 'web', url: safe })
  return textLinkHtml(url, url, 'web')
}

const GITHUB_REF_RE = /^\/([^/]+\/[^/]+)\/(pull|issues)\/([1-9]\d{0,9})\/?$/

// A github.com pull request or issue page, exactly, as a reference: the same
// target as "#284" or "owner/name#284". Anything more specific (its files, a
// comment) stays a web link of its own.
export function githubRef(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.host !== 'github.com' || parsed.search || parsed.hash) return null
  const match = GITHUB_REF_RE.exec(parsed.pathname)
  const key = match ? issueKey(match[1], Number(match[3])) : null
  if (!match || !key) return null
  return { kind: match[2] === 'pull' ? 'pr' : 'issue', repo: match[1], number: Number(match[3]), key }
}

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

// "host/path" for a chip: no scheme, no www., no query or fragment; a long one
// keeps its host and last segment.
export function webLabel(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return truncate(String(url), 40)
  }
  const host = parsed.host.replace(/^www\./, '')
  const path = parsed.pathname.replace(/\/+$/, '')
  if (`${host}${path}`.length <= 40) return `${host}${path}`
  const last = path.slice(path.lastIndexOf('/') + 1)
  return last ? `${host}/…/${truncate(last, 24)}` : truncate(host, 40)
}

// A file's name for a chip, with its line when the text named one.
export function fileLabel(path, line = null) {
  const trimmed = String(path).replace(/\/+$/, '')
  const name = trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed
  const label = String(path).endsWith('/') && name !== trimmed ? `${name}/` : name
  return Number.isSafeInteger(line) ? `${label}:${line}` : label
}
