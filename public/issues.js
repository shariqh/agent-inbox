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
// GitHub's dependency page, as the poller stores it (slice 2 §5.1)
const DEPENDENCY_PAGE = 50
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

// GitHub's "blocked by" edges (slice 2 §6.2, blocker → dependent), each pair
// once, and the issues on a cycle. A dependency is never the human's blocker:
// nothing here reaches attention (§10).
function blockingIndex() {
  const seen = new Set()
  const index = { blockersOf: new Map(), dependentsOf: new Map(), circular: new Set() }
  index.add = (edge) => {
    const pair = `${edge.from}\u0000${edge.to}`
    if (seen.has(pair)) return
    seen.add(pair)
    index.blockersOf.set(edge.to, [...(index.blockersOf.get(edge.to) ?? []), edge.from])
    index.dependentsOf.set(edge.from, [...(index.dependentsOf.get(edge.from) ?? []), edge.to])
    if (edge.cycle === true) index.circular.add(edge.from).add(edge.to)
  }
  return index
}

const byIssue = (a, b) => {
  const ra = a.repo.toLowerCase()
  const rb = b.repo.toLowerCase()
  return ra !== rb ? (ra < rb ? -1 : 1) : a.number - b.number
}

// What a list cannot show of the OPEN issues its section counts. GitHub's page
// holds the first 50 of ALL of them, closed included, so when the direction has
// more than 50 an unlisted open one may simply sit beyond it: "more on GitHub",
// never blamed on permissions. Only a complete page (total ≤ 50) proves the rest
// are hidden from this account. Closed ones draw nothing and are never counted.
function depMoreOf(listed, open, total) {
  if (open === null) return { notVisible: 0, onGitHub: 0 }
  const missing = Math.max(0, open - listed)
  return (total ?? open) > DEPENDENCY_PAGE ? { notVisible: 0, onGitHub: missing } : { notVisible: missing, onGitHub: 0 }
}

// §9.1's "Dependencies on GitHub" for a drawn relation. Only a section the
// issue's own root fetched and GitHub answered (`ok`) has lists; `unavailable`
// says so; `unknown`, a missing field and anything else draw nothing, never
// "no dependencies" (§9, degradation).
function dependenciesOf(root, node, { nodes, countsOf, blocking, activity }) {
  if (root.dependencies === 'unavailable') return { status: 'unavailable' }
  if (root.dependencies !== 'ok') return null
  const counts = countsOf.get(node.key) ?? {}
  const side = (keys, open, total) => {
    const list = (keys ?? []).map((key) => nodes.get(key)).filter((n) => n && n.state === 'OPEN').sort(byIssue)
    return { list: list.map((n) => ({ node: n, activity: activityOf(activity.get(n.key)) })), more: depMoreOf(list.length, open, total) }
  }
  const waitsOn = side(blocking.blockersOf.get(node.key), count(counts.blocked_by_open), count(counts.blocked_by_total))
  const unblocks = side(blocking.dependentsOf.get(node.key), count(counts.blocking_open), count(counts.blocking_total))
  // the node cap cut these open ones (§6.3, #275); they are counted once, not
  // as missing, each taken only from its own direction's lines
  const take = (left, sides) => {
    for (const more of sides) {
      for (const field of ['notVisible', 'onGitHub']) {
        const taken = Math.min(left, more[field])
        more[field] -= taken
        left -= taken
      }
    }
  }
  const open = record(root.dependencies_omitted_open) ? root.dependencies_omitted_open : null
  const cutWaits = open ? count(open.blocked_by) : null
  const cutUnblocks = open ? count(open.blocking) : null
  let notShown
  if (cutWaits !== null && cutUnblocks !== null) {
    notShown = cutWaits + cutUnblocks
    take(cutWaits, [waitsOn.more])
    take(cutUnblocks, [unblocks.more])
  } else {
    // an older viewer reports one count of every cut entry, closed included
    notShown = count(root.dependencies_omitted) ?? 0
    take(notShown, [unblocks.more, waitsOn.more])
  }
  return {
    status: 'ok', waitsOn: waitsOn.list, unblocks: unblocks.list, cycle: blocking.circular.has(node.key),
    more: { waitsOn: waitsOn.more, unblocks: unblocks.more, notShown },
  }
}

// The GitHub half of a plan's or row's "waits on": the open blockers of its
// certain issue, while that relation draws.
function githubWaits(rel) {
  if (!rel || !rel.dependencies || rel.dependencies.status !== 'ok') return []
  return rel.dependencies.waitsOn.map(({ node, activity }) => ({ node, activity, freshness: rel.freshness, fetchedAt: rel.fetchedAt }))
}

// §9.1: per plan, its issue's open blockers; per row, its waits_on steps that
// are neither done nor na (a label naming a removed row draws nothing, §4.2) beside its own
// issue's open blockers. A step whose issue is one of those blockers is ONE
// entry, labelled with both sources.
function waitsOf({ boards, archived, links }, relations, canonical) {
  const planWaits = new Map()
  const rowWaits = new Map()
  const certain = (entity) => {
    const identity = issueKeyFor(entity, linkFor(links ?? null, entity))
    return identity && identity.certain ? relations.get(identity.key) : null
  }
  for (const plan of [...(boards ?? []), ...(archived ?? [])]) {
    if (!record(plan)) continue
    const own = githubWaits(certain(plan)).map((g) => ({ step: null, ...g, sources: ['github'] }))
    if (own.length) planWaits.set(plan.id, own)
    const rows = (Array.isArray(plan.rows) ? plan.rows : []).filter(record)
    const byLabel = new Map(rows.map((r) => [r.label, r]))
    for (const r of rows) {
      const fromGitHub = githubWaits(relations.get(issueKey(r.issue_repo, r.issue_number)))
      const entries = []
      for (const label of Array.isArray(r.waits_on) ? r.waits_on : []) {
        const target = byLabel.get(label)
        // a step that is done, or will not happen (na), holds nothing up
        if (!target || target === r || target.status === 'done' || target.status === 'na') continue
        const key = issueKey(target.issue_repo, target.issue_number)
        const same = key ? fromGitHub.findIndex((g) => g.node.key === canonical(key)) : -1
        const github = same >= 0 ? fromGitHub.splice(same, 1)[0] : null
        entries.push({
          step: { id: target.id, label: target.label }, node: github ? github.node : null, activity: github ? github.activity : null,
          freshness: github ? github.freshness : null, fetchedAt: github ? github.fetchedAt : null,
          sources: github ? ['step', 'github'] : ['step'],
        })
      }
      entries.push(...fromGitHub.map((g) => ({ step: null, ...g, sources: ['github'] })))
      if (entries.length) rowWaits.set(r.id, entries)
    }
  }
  return { planWaits, rowWaits }
}

// One frame's relationships, keyed by the issue key an entity asked for: the
// roots of /api/issues (§4.7). A key with no entry draws today's plain chip.
export function buildIssueView(graph, { items, boards, archived, links, attention, nowMs = Date.now() } = {}) {
  const relations = new Map()
  if (!record(graph) || graph.version !== 1 || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)
    || !Array.isArray(graph.roots)) return { relations, ...waitsOf({ boards, archived, links }, relations, (key) => key) }
  const aliases = record(graph.aliases) ? graph.aliases : {}
  const canonical = (key) => (Object.hasOwn(aliases, key) && typeof aliases[key] === 'string' ? aliases[key] : key)
  const nodes = new Map()
  // a node's own dependency counts (slice 2 §6.2), kept beside its view
  const countsOf = new Map()
  for (const node of graph.nodes) {
    const view = nodeView(node)
    if (!view || nodes.has(view.key)) continue
    nodes.set(view.key, view)
    if (record(node.deps)) countsOf.set(view.key, node.deps)
  }
  const parentOf = new Map()
  const childrenOf = new Map()
  const blocking = blockingIndex()
  for (const edge of graph.edges) {
    if (!record(edge) || edge.from === edge.to || !nodes.has(edge.from) || !nodes.has(edge.to)) continue
    if (edge.kind === 'blocks') blocking.add(edge)
    if (edge.kind !== 'contains' || parentOf.has(edge.to)) continue
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
      node: null, trail: [], children: [], more: { notVisible: 0, onGitHub: 0, notShown: 0 }, dependencies: null,
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
      relation.dependencies = dependenciesOf(root, node, { nodes, countsOf, blocking, activity })
    }
    relations.set(root.key, relation)
  }
  return { relations, ...waitsOf({ boards, archived, links }, relations, canonical) }
}

// Slice 2 §7: opt-in grouping. Only fresh and stale relations take part; every
// other state, an uncertain identity, a root the node cap omitted and a missing
// graph leave a plan flat in its place (§7.4).
const groupable = (rel) => Boolean(rel && rel.node && (rel.freshness === 'fresh' || rel.freshness === 'stale'))
const parentNode = (rel) => (groupable(rel) ? rel.trail[rel.trail.length - 1] ?? null : null)

function relationOf(entity, view, links) {
  const relations = view && view.relations instanceof Map ? view.relations : null
  if (!relations || !record(entity)) return null
  const identity = issueKeyFor(entity, linkFor(links ?? null, entity))
  const rel = identity && identity.certain ? relations.get(identity.key) : null
  return groupable(rel) ? rel : null
}

// Active plans in today's order → the same plans, each exactly once, with every
// group of two or more plans of ONE project under one GitHub parent gathered at
// its first member's place (§7.1, §7.2). The umbrella, whose own issue is the
// parent, leads; then members in GitHub's child order; then today's order.
export function planGroups(plans, view, links) {
  // GitHub's child order is known only for a parent whose own list was fetched
  // and drawn; its children carry their place in it.
  const placeOf = new Map()
  for (const rel of view && view.relations instanceof Map ? view.relations.values() : []) {
    if (groupable(rel)) rel.children.forEach(({ node }, index) => placeOf.set(`${rel.node.key}\u0000${node.key}`, index))
  }
  const facts = plans.map((plan, index) => {
    const rel = typeof plan?.project === 'string' ? relationOf(plan, view, links) : null
    if (!rel) return { plan, index, rel: null }
    const parent = parentNode(rel)
    const scope = (key) => `${plan.project}\u0000${key}`
    const place = parent ? placeOf.get(`${parent.key}\u0000${rel.node.key}`) ?? Infinity : Infinity
    return { plan, index, rel, place, own: scope(rel.node.key), up: parent ? scope(parent.key) : null, parent }
  })
  // A plan is an umbrella where its own group lives, else a member of its
  // parent's. Groups that end up with no member or a single plan dissolve, and
  // a dissolved group frees its plans for their parent's, until nothing moves.
  const dead = new Set()
  let groups
  for (;;) {
    groups = new Map()
    const join = (key, role, fact) => {
      const group = groups.get(key) ?? { umbrellas: [], members: [] }
      group[role].push(fact)
      groups.set(key, group)
    }
    const hasMembers = new Set(facts.filter((f) => f.up && !dead.has(f.up)).map((f) => f.up))
    for (const fact of facts) {
      if (!fact.rel) continue
      if (!dead.has(fact.own) && hasMembers.has(fact.own)) join(fact.own, 'umbrellas', fact)
      else if (fact.up && !dead.has(fact.up)) join(fact.up, 'members', fact)
    }
    const dying = [...groups].filter(([, g]) => !g.members.length || g.umbrellas.length + g.members.length < 2)
    if (!dying.length) break
    for (const [key] of dying) dead.add(key)
  }
  const groupOf = new Map()
  const ordered = new Map()
  for (const [key, { umbrellas, members }] of groups) {
    const sorted = [...umbrellas, ...[...members].sort((a, b) => a.place - b.place || a.index - b.index)]
    const rels = sorted.map((f) => f.rel)
    const stamps = rels.map((rel) => rel.fetchedAt).filter((stamp) => typeof stamp === 'string').sort()
    const first = sorted[0].plan
    const group = {
      key, project: first.project, parent: members[0].parent, size: sorted.length,
      stale: rels.every((rel) => rel.freshness === 'stale'), fetchedAt: stamps[0] ?? null,
      against: text(first.repo) ?? text(linkFor(links ?? null, first)?.repo),
    }
    for (const fact of sorted) groupOf.set(fact.plan.id, group)
    ordered.set(group, sorted.map((f) => f.plan))
  }
  const out = []
  const placed = new Set()
  for (const plan of plans) {
    const group = groupOf.get(plan?.id)
    if (!group) out.push(plan)
    else if (!placed.has(group)) {
      placed.add(group)
      out.push(...ordered.get(group))
    }
  }
  return { plans: out, groupOf }
}

// Inside one plan (§7.1): the rows that start a run under a GitHub parent, when
// the plan's linked rows span two or more parents. Rows are never reordered.
export function rowParentRuns(rows, view) {
  const parents = rows.map((row) => parentNode(relationOf({ issue_repo: row?.issue_repo, issue_number: row?.issue_number }, view, null)))
  const runs = new Map()
  if (new Set(parents.filter(Boolean).map((node) => node.key)).size < 2) return runs
  parents.forEach((node, i) => {
    if (node && node.key !== parents[i - 1]?.key) runs.set(rows[i].id, node)
  })
  return runs
}
