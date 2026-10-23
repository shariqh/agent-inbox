// The Links strip's model (issue #300): every link an open card's text shows,
// the item's own PR and issue first, then the rest in order of first
// appearance, one chip per target. Pure: no DOM, no network, no clock.
//
// It reads the fields through renderStructuredText itself, collecting what
// that renders, so the strip lists exactly the links the card shows: nothing
// from a fenced block or quarantined markup, and every bare #N resolved
// against the same repository the inline text uses. Nothing here reaches the
// attention predicate, a badge or a count.
import { issueKey } from './issue-key.js'
import { fileLabel, githubRef, webLabel } from './links.js'
import { issueRef, linkFor, repoFilePath, safeHttpUrl } from './source.js'
import { renderStructuredText } from './structured-text.js'

// The agent-written fields of an item or a plan row, in card order. The
// human's own words (a reply, an annotation) are not read.
function linkSources(entity) {
  const isRow = typeof entity.label === 'string'
  const options = Array.isArray(entity.options) ? entity.options : []
  return [
    isRow ? entity.label : entity.title,
    entity.next_step,
    isRow ? entity.note : entity.detail,
    entity.impact,
    entity.next_after,
    entity.outcome,
    ...options.flatMap((option) => (option && typeof option === 'object' ? [option.label, option.detail] : [])),
    entity.context,
  ].filter((text) => typeof text === 'string' && text !== '')
}

const KIND_WORD = { pr: 'Pull request', issue: 'Issue' }
const sameRepo = (a, b) => typeof b === 'string' && a.toLowerCase() === b.toLowerCase()

// A reference is one target whatever spelled it: #284, PR #284 and its
// github.com URL share a key. `#N` beside the card's own repository,
// owner/name#N anywhere else.
function refLink(kind, repo, number, url, against, extra = {}) {
  const key = issueKey(repo, number)
  const name = `${repo}#${number}`
  return {
    kind,
    key: key ? `gh:${key}` : `web:${url}`,
    url,
    label: sameRepo(repo, against) ? `#${number}` : name,
    title: `${KIND_WORD[kind]} ${name}${extra.subject ? ` — ${extra.subject}` : ''}`,
    own: extra.own === true,
  }
}

// The PR and issue the card's origin chips name (#30, #103): the plan's for
// a plan row, whose own issue link replaces the plan's issue.
function ownLinks(entity, identity, index) {
  const link = linkFor(index, identity)
  const against = identity.repo
  const own = []
  if (link && Number.isSafeInteger(link.pr_number) && link.pr_number > 0) {
    const url = safeHttpUrl(link.pr_url) || safeHttpUrl(`https://github.com/${link.repo}/pull/${link.pr_number}`)
    if (url) own.push(refLink('pr', link.repo, link.pr_number, url, against, { own: true, subject: link.pr_title }))
  }
  const issue = issueRef(identity, link, entity === identity ? null : entity)
  if (issue && issue.url) {
    own.push(issue.repo
      ? refLink('issue', issue.repo, issue.num, issue.url, against, { own: true, subject: issue.title })
      : { kind: 'issue', key: `web:${issue.url}`, url: issue.url, label: `#${issue.num}`, title: `Issue #${issue.num}`, own: true })
  }
  return own
}

function stripLink(found, against) {
  if (found.kind === 'file') {
    // a repo-relative file (#324) keys by the full path it names in its
    // folder, so it shares one chip with the same file written out in full
    const rooted = typeof found.root === 'string'
    return {
      kind: 'file', key: `file:${rooted ? repoFilePath(found.root, found.path) : found.path}`, path: found.path,
      ...(rooted ? { root: found.root } : {}), line: found.line,
      label: fileLabel(found.path, found.line), title: found.title ?? found.text, own: false,
    }
  }
  if (found.kind === 'web') {
    const ref = githubRef(found.url)
    if (ref) return refLink(ref.kind, ref.repo, ref.number, found.url, against)
    return { kind: 'web', key: `web:${found.url}`, url: found.url, label: webLabel(found.url), title: found.url, own: false }
  }
  return refLink(found.kind, found.repo, found.number, found.url, against)
}

// [] when the text links nothing beyond the card's own PR and issue: its
// origin chips already show those, right above where the strip would be.
// Repo-relative paths (#324) resolve against the folder the item, or the plan
// a row belongs to, recorded: `identity.repo_root`.
export function cardLinks(entity, identity, index) {
  if (!entity || !identity) return []
  const against = typeof identity.repo === 'string' ? identity.repo : null
  const root = typeof identity.repo_root === 'string' ? identity.repo_root : null
  const found = []
  for (const text of linkSources(entity)) renderStructuredText(text, { repo: against, root, found })
  const byKey = new Map()
  for (const link of [...ownLinks(entity, identity, index), ...found.map((one) => stripLink(one, against))]) {
    const seen = byKey.get(link.key)
    if (!seen) byKey.set(link.key, link)
    // "#290" first, "PR #290" later: one chip, and it is a PR
    else if (!seen.own && seen.kind === 'issue' && link.kind === 'pr') byKey.set(link.key, { ...seen, kind: 'pr', url: link.url, title: link.title })
  }
  const links = [...byKey.values()]
  return links.some((link) => !link.own) ? links : []
}
