// Issue identity for the sub-issue graph (issue #103). Pure — no DOM, no
// network, no clock — so the viewer process uses it today and the browser can
// share it later, the way source.js's link join is shared. Sibling modules are
// imported RELATIVELY so the file resolves both in the browser and under Node.
//
// A key is `owner/name#number` with the repository LOWERCASED: GitHub compares
// slugs case-insensitively, and a number is never compared without its
// repository, so a/x#5 and b/y#5 never merge.
import { indexLinks, linkFor } from './source.js'

// GraphQL Int: the largest issue number GitHub can name
const ISSUE_NUMBER_MAX = 2147483647

export function issueKey(repo, number) {
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null
  if (repo.split('/').some((part) => part === '.' || part === '..')) return null
  if (!Number.isInteger(number) || number < 1 || number > ISSUE_NUMBER_MAX) return null
  return `${repo.toLowerCase()}#${number}`
}

// Every issue the entity's PR closes, as distinct keys — or null when the link
// carries no VALID record bound to its own fetched_at: written before PR1b
// recorded them, rewritten since by an older process (which moves fetched_at
// and so unbinds the record), or unreadable. Accepts the stored JSON text or an
// already parsed object. The PR tooltip lists them (PR3).
export function closingKeys(link) {
  let record = link.closing_refs
  if (typeof record === 'string') {
    try {
      record = JSON.parse(record)
    } catch {
      return null
    }
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null
  if (typeof record.fetched_at !== 'string' || record.fetched_at !== link.fetched_at) return null
  if (!Array.isArray(record.refs)) return null
  const keys = new Set()
  for (const ref of record.refs) {
    const key = ref && typeof ref === 'object' ? issueKey(ref.repo, ref.number) : null
    if (!key) return null
    keys.add(key)
  }
  return [...keys]
}

// Which issue an item, plan or row belongs to, and whether that is CERTAIN
// enough to draw relationships for (§4.2). In precedence order:
//   0. an explicit link an agent wrote (PR2): a plan's pin, or a row's link,
//      which is a row's only source. It outranks everything below, so a plan
//      maintained from a child's branch can still name its umbrella issue.
//   1. its PR's closing issue, only when the PR closes exactly ONE issue. A PR
//      that closes several is never guessed, and one that closes none says
//      nothing: either way the branch issue decides.
//   2. the branch-inferred or registered issue (`repo` + `issue_ref`).
// A PR row without a valid bound record still shows its first closing issue on
// the chip, as #30 always has, but that identity is not certain: the record
// that would prove it is the only one is missing.
export function issueKeyFor(entity, link) {
  if (entity) {
    const pin = issueKey(entity.issue_pin_repo, entity.issue_pin_number)
    if (pin) return { key: pin, source: 'pin', certain: true }
    const linked = issueKey(entity.issue_repo, entity.issue_number)
    if (linked) return { key: linked, source: 'link', certain: true }
  }
  if (link) {
    const refs = closingKeys(link)
    if (refs && refs.length === 1) return { key: refs[0], source: 'pr', certain: true }
    if (!refs && Number.isInteger(link.issue_number)) {
      const key = issueKey((entity && entity.repo) || link.repo, link.issue_number)
      if (key) return { key, source: 'pr', certain: false }
    }
  }
  const key = entity ? issueKey(entity.repo, entity.issue_ref) : null
  return key ? { key, source: 'branch', certain: true } : null
}

// The two key sets (§6). Only CERTAIN identities enter either one.
//   refresh: open items and active plans in projects that are not closed;
//   display: the refresh set, plus the same entities in closed projects (a
//            peek still shows what was last known, #32) and archived plans.
// Closed items are History and are never passed in. Each display key carries
// whether it refreshes and the newest updated_at among the entities linking it,
// which the node cap ranks by.
export function issueKeySets(entities, links) {
  const index = indexLinks(links)
  const refresh = new Set()
  const display = new Map()
  for (const entity of entities ?? []) {
    const identity = issueKeyFor(entity, linkFor(index, entity))
    if (!identity || !identity.certain) continue
    const refreshes = !entity.project_closed && !entity.archived
    if (refreshes) refresh.add(identity.key)
    const updatedAt = typeof entity.updated_at === 'string' ? entity.updated_at : ''
    const prev = display.get(identity.key)
    display.set(identity.key, {
      refresh: refreshes || (prev ? prev.refresh : false),
      updated_at: prev && prev.updated_at > updatedAt ? prev.updated_at : updatedAt,
    })
  }
  return { refresh, display }
}
