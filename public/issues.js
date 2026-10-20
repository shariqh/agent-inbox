// The sub-issue view model (issue #103, PR3; design §7). Pure — no DOM and no
// network — so app.js builds it once per frame from the /api/issues body, the
// local entities and the attention set the render already computed, and
// public/source.js draws it. Sibling modules are imported RELATIVELY so the
// file resolves in the browser (/issues.js → /issue-key.js) and under vitest.
//
// It READS attention and never feeds it: nothing here reaches attention.js, a
// badge, a count or a notification (§9). It builds no URL and no HTML either;
// source.js does both, through its one anchor path.
import { issueKey, issueKeyFor } from './issue-key.js'
import { linkFor } from './source.js'

// §5.8: relationships dim after 30 minutes and hide after 7 days without a
// successful fetch, the ages a titled board_get reports too (issue-graph.ts).
export const STALE_AFTER_MS = 30 * 60_000
export const HIDDEN_AFTER_MS = 7 * 24 * 60 * 60_000
// GitHub's eight hierarchy levels, and its 100-sub-issue page (§2.5)
const TRAIL_MAX = 8
const CHILD_PAGE = 100
const MARKS = new Map([['COMPLETED', 'completed'], ['NOT_PLANNED', 'not planned'], ['DUPLICATE', 'duplicate']])

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null)
const text = (value) => (typeof value === 'string' ? value : null)

// One issue as the view draws it. A node whose parts disagree with its key, or
// that is not a valid slug and number, is dropped, never coerced (§5.7).
function nodeView(node) {
  if (!record(node) || typeof node.key !== 'string' || issueKey(node.repo, node.number) !== node.key) return null
  if (typeof node.title !== 'string' || (node.state !== 'OPEN' && node.state !== 'CLOSED')) return null
  const mark = node.state === 'OPEN' ? 'open' : MARKS.get(node.state_reason) ?? 'closed'
  const view = { key: node.key, repo: node.repo, number: node.number, title: node.title, state: node.state, mark }
  const total = count(node.children_total)
  const completed = count(node.children_completed)
  return total !== null && completed !== null && completed <= total ? { ...view, total, completed } : view
}

function freshness(root, nowMs) {
  if (root.failure === 'hard') return 'unavailable'
  const fetched = Date.parse(text(root.fetched_at) ?? '')
  // a soft failure before any success knows nothing: today's chip
  if (!Number.isFinite(fetched)) return null
  // GitHub returned the issue but not its parent or sub-issues (§5.7), so no
  // relationship is known, whatever another issue's list says; null means this
  // build cannot read the cached answer. issue_rel calls both unavailable. An
  // absent status (a viewer older than the field) draws as before.
  if (root.hierarchy === 'unavailable') return 'no-hierarchy'
  if (root.hierarchy === null) return null
  const age = nowMs - fetched
  return age > HIDDEN_AFTER_MS ? 'hidden' : age > STALE_AFTER_MS ? 'stale' : 'fresh'
}

// The ancestors above `key`, top first, as far as the graph emitted them.
function trailOf(key, parentOf, nodes) {
  const trail = []
  const seen = new Set([key])
  for (let at = parentOf.get(key); at !== undefined && trail.length < TRAIL_MAX && !seen.has(at); at = parentOf.get(at)) {
    seen.add(at)
    trail.unshift(nodes.get(at))
  }
  return trail
}

// What the list cannot show: children GitHub counts but did not list to this
// account, children beyond its page, and children the node cap cut (§6).
function moreOf(node, listed, notShown) {
  const known = listed + notShown
  const total = node.total ?? known
  return {
    notVisible: Math.max(0, Math.min(total, CHILD_PAGE) - known),
    onGitHub: Math.max(0, total - CHILD_PAGE),
    notShown,
  }
}

const stamp = (...entities) => entities.map((e) => text(e?.updated_at) || text(e?.created_at)).find(Boolean) ?? ''

// Newest first, then the target, so a tie never depends on input order.
function newer(a, b) {
  if (!a) return b
  if (a.at !== b.at) return a.at > b.at ? a : b
  return a.order <= b.order ? a : b
}

function entry(target, agent, title, ...entities) {
  return { target, agent: text(agent), title: text(title), at: stamp(...entities), order: `${target.id}\u0000${target.rowId ?? ''}` }
}

// Which local work names each issue (§7.3), by canonical key: open items,
// plans whose certain issue it is, and rows that link it. Closed items are
// History, and an uncertain identity draws no relationship.
function activityIndex({ items, boards, archived, links, attention }, canonical) {
  const slots = new Map()
  const note = (key, slot, found) => {
    if (!key) return
    const at = canonical(key)
    const held = slots.get(at) ?? { waiting: null, active: null, done: null }
    held[slot] = newer(held[slot], found)
    slots.set(at, held)
  }
  const certain = (entity) => {
    const identity = issueKeyFor(entity, linkFor(links ?? null, entity))
    return identity && identity.certain ? identity.key : null
  }
  const linked = (row) => issueKey(row?.issue_repo, row?.issue_number)
  for (const item of items ?? []) {
    if (!record(item) || (item.status && item.status !== 'open')) continue
    note(certain(item), 'active', entry({ id: item.id }, item.agent, item.title, item))
  }
  for (const [plans, finished] of [[boards, false], [archived, true]]) {
    for (const plan of plans ?? []) {
      if (!record(plan)) continue
      note(certain(plan), finished ? 'done' : 'active', entry({ id: plan.id }, plan.agent, plan.title, plan))
      for (const row of Array.isArray(plan.rows) ? plan.rows : []) {
        const done = finished || row.status === 'done' || row.status === 'na'
        note(linked(row), done ? 'done' : 'active', entry({ id: plan.id, rowId: row.id }, plan.agent, row.label, row, plan))
      }
    }
  }
  // A row with no link of its own waits under its plan's issue, where it is drawn.
  for (const found of attention ?? []) {
    if (found?.kind === 'item' && record(found.item)) {
      note(certain(found.item), 'waiting', entry({ id: found.item.id }, null, null, found.item))
    } else if (found?.kind === 'row' && record(found.row) && record(found.board)) {
      note(linked(found.row) ?? certain(found.board), 'waiting',
        entry({ id: found.board.id, rowId: found.row.id }, null, null, found.row, found.board))
    }
  }
  return slots
}

function activityOf(slots) {
  if (slots?.waiting) return { kind: 'waiting', label: 'Waiting on you', target: slots.waiting.target }
  if (slots?.active) {
    const { agent, title, target } = slots.active
    return { kind: 'active', label: ['Active', agent, title].filter(Boolean).join(' · '), target }
  }
  if (slots?.done) return { kind: 'done', label: 'Done here', target: slots.done.target }
  return { kind: 'none', label: 'None here', target: null }
}

// One frame's relationships, keyed by the issue key an entity asked for: the
// roots of /api/issues (§4.7). A key with no entry draws today's plain chip.
export function buildIssueView(graph, { items, boards, archived, links, attention, nowMs = Date.now() } = {}) {
  const relations = new Map()
  if (!record(graph) || graph.version !== 1 || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)
    || !Array.isArray(graph.roots)) return { relations }
  const aliases = record(graph.aliases) ? graph.aliases : {}
  const canonical = (key) => (Object.hasOwn(aliases, key) && typeof aliases[key] === 'string' ? aliases[key] : key)
  const nodes = new Map()
  for (const node of graph.nodes) {
    const view = nodeView(node)
    if (view && !nodes.has(view.key)) nodes.set(view.key, view)
  }
  const parentOf = new Map()
  const childrenOf = new Map()
  for (const edge of graph.edges) {
    if (!record(edge) || edge.kind !== 'contains' || edge.from === edge.to || parentOf.has(edge.to)
      || !nodes.has(edge.from) || !nodes.has(edge.to)) continue
    parentOf.set(edge.to, edge.from)
    childrenOf.set(edge.from, [...(childrenOf.get(edge.from) ?? []), { key: edge.to, position: count(edge.position) ?? Infinity }])
  }
  const activity = activityIndex({ items, boards, archived, links, attention }, canonical)
  for (const root of graph.roots) {
    if (!record(root) || typeof root.key !== 'string' || relations.has(root.key)) continue
    const state = freshness(root, nowMs)
    if (!state) continue
    const relation = {
      key: root.key, freshness: state, error: text(root.error), fetchedAt: text(root.fetched_at),
      node: null, trail: [], children: [], more: { notVisible: 0, onGitHub: 0, notShown: 0 },
    }
    if (state === 'fresh' || state === 'stale') {
      const node = nodes.get(canonical(root.key))
      // nothing reconciled to draw (its facts were refused elsewhere): today's chip
      if (!node) continue
      relation.node = node
      relation.trail = trailOf(node.key, parentOf, nodes)
      relation.children = (childrenOf.get(node.key) ?? [])
        .sort((a, b) => a.position - b.position || (a.key < b.key ? -1 : 1))
        .map(({ key }) => ({ node: nodes.get(key), activity: activityOf(activity.get(key)) }))
      relation.more = moreOf(node, relation.children.length, count(root.children_omitted) ?? 0)
    }
    relations.set(root.key, relation)
  }
  return { relations }
}
