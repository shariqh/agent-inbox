// The sub-issue graph behind GET /api/issues (issue #103, design §4.5 and §6).
//
// PURE: a function of listIssueSnapshots() rows and the display key set alone,
// with no database, clock, network or I/O, so identical database contents give
// identical bytes. That is what lets /api/issues be a conditional snapshot. It
// stays out of the stdio MCP process (test/issue-graph.test.ts pins that).
//
// Reconciliation in one paragraph. Every display root's snapshot, fetched at
// t, is a set of OBSERVATIONS about who each issue's parent is: a pointer (the
// walk upwards says so), a membership (a parent's list holds the child) or an
// absence (a parent's COMPLETE list does not). The newest observation decides,
// pointers before absences before memberships at equal t; contradictory equals
// and cycles fail closed as `conflict`. Facts (title, state) and child counts
// are separate observations: the freshest wins and they never decide parentage.
import { issueKey } from '../public/issue-key.js'
import type { IssueKeySets } from '../public/issue-key.js'
import type { IssueFacts, IssueRelative, IssueSnapshotRow, IssueState, IssueStateReason } from './store.js'

/** One response's budget: a unit per node, plus one per root entry that has no node. */
export const MAX_GRAPH_NODES = 2_000
// GitHub's eight levels: the chain emitted above one root never exceeds them
const MAX_ANCESTORS = 8

export interface IssueGraphNode {
  key: string
  repo: string
  number: number
  title: string
  state: IssueState
  state_reason: IssueStateReason | null
  /** only where an observation carried them (rule 4) */
  children_total?: number
  children_completed?: number
  observed_at: string
  /** rule 3 or rule 5 decided this issue's parent away */
  conflict?: true
}

export interface IssueGraphEdge {
  kind: 'contains'
  from: string
  to: string
  /** index among the parent's children: GitHub's order, then the rest by key */
  position: number
  observed_at: string
}

export interface IssueGraphRoot {
  /** the requested key an entity links; see `aliases` for its node */
  key: string
  refresh: boolean
  fetched_at: string | null
  checked_at: string
  error: string | null
  failure: 'soft' | 'hard' | null
  children_omitted: number
}

export interface IssueGraph {
  version: 1
  nodes: IssueGraphNode[]
  edges: IssueGraphEdge[]
  roots: IssueGraphRoot[]
  aliases: Record<string, string>
  truncated: { roots: number; ancestors: number; children: number; edges: number }
}

// What one observation says an issue's parent is. Neither sentinel can be a
// key, which always holds a '/' and a '#'.
const NO_PARENT = ''
const UNKNOWN = '?'
// Rule 1's ranks at equal t: pointers, then absences, then memberships.
const POINTER = 0
const ABSENCE = 1
const MEMBERSHIP = 2
// Rule 7's sources at equal t: the issue's own root, a parent's list, a walk.
const OWN = 0
const LISTED = 1
const WALKED = 2

interface Claim { t: string; rank: number; parent: string }
interface ParentList { t: string; observer: string; complete: boolean; children: string[]; members: Set<string> }
interface Seen<T> { t: string; source: number; observer: string; value: T }
interface Counts { total: number; completed: number }
interface Decision { parent: string; t: string }
interface Root {
  key: string
  node: string
  row: IssueSnapshotRow
  refresh: boolean
  updatedAt: string
  hasNode: boolean
  ancestors: string[]
  children: string[]
}

// newest first; then the lower source (rule 7); then the observer's key, so a
// tie can never depend on input order
function fresher<T>(a: Seen<T>, b: Seen<T>): Seen<T> {
  if (a.t !== b.t) return a.t > b.t ? a : b
  if (a.source !== b.source) return a.source < b.source ? a : b
  return a.observer <= b.observer ? a : b
}

const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

export function buildIssueGraph(
  snapshots: IssueSnapshotRow[],
  keySets: IssueKeySets,
  opts: { maxUnits?: number } = {},
): IssueGraph {
  const maxUnits = Math.max(0, opts.maxUnits ?? MAX_GRAPH_NODES)

  // Rule 6. A hard failure of K at tF drops every observation about K made at
  // or before tF. Every cached row counts, displayed or not: a refusal only
  // ever removes data, and K's titles must not return because K stopped being
  // displayed while another issue's older list still names it.
  const failedAt = new Map<string, string>()
  for (const row of snapshots) {
    const key = issueKey(row.repo, row.number)
    if (key && row.failure === 'hard') failedAt.set(key, row.checked_at)
  }
  const suppressed = (key: string, t: string): boolean => {
    const tF = failedAt.get(key)
    return tF !== undefined && t <= tF
  }

  // Rule 9: only the display roots' own rows are read; any other row is inert.
  const rows: Array<{ key: string; row: IssueSnapshotRow }> = []
  for (const row of snapshots) {
    const key = issueKey(row.repo, row.number)
    if (key && keySets.display.has(key)) rows.push({ key, row })
  }
  rows.sort((a, b) => byKey(a.key, b.key))

  const claims = new Map<string, Claim[]>()
  const lists = new Map<string, ParentList[]>()
  const facts = new Map<string, Seen<IssueFacts>[]>()
  const counts = new Map<string, Seen<Counts>[]>()
  const aliasOf = new Map<string, string>()

  const fact = (key: string, t: string, source: number, observer: string, v: IssueRelative, withCounts: boolean) => {
    if (suppressed(key, t)) return
    const { repo, number, title, state, state_reason } = v
    push(facts, key, { t, source, observer, value: { repo, number, title, state, state_reason } })
    if (withCounts && v.children_total !== undefined && v.children_completed !== undefined) {
      push(counts, key, { t, source, observer, value: { total: v.children_total, completed: v.children_completed } })
    }
  }
  // A claim naming a parent GitHub has since refused is not dropped but made
  // UNKNOWN: it still outranks every older claim, so a refuted parent can never
  // come back from a display-only list nobody refreshes any more.
  const claim = (child: string, t: string, rank: number, parent: string) => {
    if (suppressed(child, t)) return
    const named = parent !== NO_PARENT && suppressed(parent, t) ? UNKNOWN : parent
    push(claims, child, { t, rank, parent: named })
  }

  for (const { key: observer, row } of rows) {
    const snap = row.snapshot
    const t = row.fetched_at
    if (!snap || !t) continue
    const root = issueKey(snap.issue.repo, snap.issue.number)
    if (!root) continue
    // Rule 8: GitHub followed a repository redirect; file under its answer.
    if (root !== observer) aliasOf.set(observer, root)
    fact(root, t, OWN, observer, snap.issue, false)
    // An unavailable hierarchy section yields no observations at all.
    if (snap.hierarchy.status !== 'ok') continue
    if (!suppressed(root, t)) {
      push(counts, root, { t, source: OWN, observer, value: { total: snap.hierarchy.total, completed: snap.hierarchy.completed } })
    }

    // Pointers up the walk, which stops at its first repeated issue. Its last
    // issue's parent is known only when the walk reached the top.
    const walked = new Set([root])
    let below = root
    let whole = true
    for (const [level, ancestor] of snap.ancestors.entries()) {
      const key = issueKey(ancestor.repo, ancestor.number)
      if (!key || walked.has(key)) {
        whole = false
        break
      }
      walked.add(key)
      claim(below, t, POINTER, key)
      // counts were requested for the immediate parent only (§5.6)
      fact(key, t, WALKED, observer, ancestor, level === 0)
      below = key
    }
    if (whole && snap.ancestors_end === 'top') claim(below, t, POINTER, NO_PARENT)

    // Memberships, in GitHub's order, without self-links or duplicates.
    const children: string[] = []
    const members = new Set<string>()
    for (const child of snap.hierarchy.children) {
      const key = issueKey(child.repo, child.number)
      if (!key || key === root || members.has(key)) continue
      members.add(key)
      children.push(key)
      claim(key, t, MEMBERSHIP, root)
      fact(key, t, LISTED, observer, child, true)
    }
    // the list itself: GitHub's order, and the absences of a complete one
    if (!suppressed(root, t)) push(lists, root, { t, observer, complete: !snap.hierarchy.truncated, children, members })
  }

  // Rules 1 to 3: each issue's parent.
  const accepted = new Map<string, Decision>()
  const conflicts = new Set<string>()
  for (const [child, list] of claims) {
    let best = list[0]!
    for (const c of list) if (c.t > best.t || (c.t === best.t && c.rank < best.rank)) best = c
    const { t, rank, parent } = best
    // Contradictory equals: claims of the deciding time and rank disagree.
    if (list.some((c) => c.t === t && c.rank === rank && c.parent !== parent)) {
      conflicts.add(child)
      continue
    }
    if (parent === NO_PARENT || parent === UNKNOWN) continue
    // Accepted unless an absence sorted before it names the same parent:
    // that parent's complete list, newer, or as new and outranking a membership.
    const refuted = (lists.get(parent) ?? []).some((l) =>
      l.complete && !l.members.has(child) && (l.t > t || (l.t === t && ABSENCE < rank)))
    if (!refuted) accepted.set(child, { parent, t })
  }

  // Rule 5: GitHub forbids cycles, so one means a stale observation. In each,
  // drop every decision of the oldest deciding t; mark the whole cycle.
  const walk = new Map<string, 'walking' | 'done'>()
  for (const start of [...accepted.keys()].sort(byKey)) {
    const path: string[] = []
    let at: string | undefined = start
    while (at !== undefined && accepted.has(at) && !walk.has(at)) {
      walk.set(at, 'walking')
      path.push(at)
      at = accepted.get(at)!.parent
    }
    if (at !== undefined && walk.get(at) === 'walking') {
      const cycle = path.slice(path.indexOf(at))
      const oldest = cycle.map((key) => accepted.get(key)!.t).sort()[0]!
      for (const key of cycle) conflicts.add(key)
      for (const key of cycle) if (accepted.get(key)!.t === oldest) accepted.delete(key)
    }
    for (const key of path) walk.set(key, 'done')
  }

  const factsOf = new Map<string, Seen<IssueFacts>>()
  for (const [key, seen] of facts) factsOf.set(key, seen.reduce(fresher))
  const countsOf = new Map<string, Seen<Counts>>()
  for (const [key, seen] of counts) countsOf.set(key, seen.reduce(fresher))

  // Rule 4: a parent's children take the order of its own freshest list, and
  // accepted children that list lacks follow by key.
  const childrenOf = new Map<string, string[]>()
  for (const [child, { parent }] of accepted) push(childrenOf, parent, child)
  const ordered = new Map<string, string[]>()
  for (const [parent, mine] of childrenOf) {
    const own = (lists.get(parent) ?? []).reduce<ParentList | undefined>(
      (best, l) => (!best || l.t > best.t || (l.t === best.t && l.observer < best.observer) ? l : best), undefined)
    const set = new Set(mine)
    const first = (own?.children ?? []).filter((key) => set.has(key))
    const listed = new Set(first)
    ordered.set(parent, [...first, ...mine.filter((key) => !listed.has(key)).sort(byKey)])
  }
  const positionOf = new Map<string, number>()
  for (const list of ordered.values()) list.forEach((key, index) => positionOf.set(key, index))

  // Every emitted issue needs facts; accepted relationships always carry them.
  const ancestorsOf = (key: string): string[] => {
    const chain: string[] = []
    const seen = new Set([key])
    let parent = accepted.get(key)?.parent
    while (parent !== undefined && chain.length < MAX_ANCESTORS && !seen.has(parent) && factsOf.has(parent)) {
      chain.push(parent)
      seen.add(parent)
      parent = accepted.get(parent)?.parent
    }
    return chain
  }

  // §6 step 1: rank the display roots that have a cached row.
  const stateRank = (key: string): number => {
    const state = factsOf.get(key)?.value.state
    return state === 'OPEN' ? 0 : state === 'CLOSED' ? 1 : 2
  }
  const roots: Root[] = rows.map(({ key, row }) => {
    const node = aliasOf.get(key) ?? key
    const display = keySets.display.get(key)!
    return {
      key, node, row,
      refresh: display.refresh,
      updatedAt: display.updated_at,
      hasNode: factsOf.has(node),
      ancestors: ancestorsOf(node),
      children: (ordered.get(node) ?? []).filter((child) => factsOf.has(child)),
    }
  })
  roots.sort((a, b) =>
    Number(!a.refresh) - Number(!b.refresh)
    || stateRank(a.node) - stateRank(b.node)
    || byKey(b.updatedAt, a.updatedAt)
    || byKey(a.key, b.key))

  // Step 2: keep whole roots, in rank order, while their units fit. The first
  // that does not fit is omitted with every lower one: the cut is a prefix.
  const kept = new Set<string>()
  const keptRoots: Root[] = []
  let used = 0
  for (const root of roots) {
    const units = (root.hasNode && kept.has(root.node) ? 0 : 1) + root.ancestors.filter((key) => !kept.has(key)).length
    if (used + units > maxUnits) break
    used += units
    if (root.hasNode) kept.add(root.node)
    for (const key of root.ancestors) kept.add(key)
    keptRoots.push(root)
  }

  // Step 3: children of the kept roots, round-robin in rank order, until the
  // budget is spent. A child already kept costs nothing.
  const cursors = keptRoots.map(() => 0)
  let remaining = maxUnits - used
  for (let progressed = true; progressed && remaining > 0;) {
    progressed = false
    keptRoots.forEach((root, index) => {
      if (remaining <= 0) return
      let cursor = cursors[index]!
      while (cursor < root.children.length && kept.has(root.children[cursor]!)) cursor++
      const child = root.children[cursor]
      if (child !== undefined) {
        kept.add(child)
        cursor++
        remaining--
        progressed = true
      }
      cursors[index] = cursor
    })
  }

  // Exact truncation. Each node the cap removed is counted once: an omitted
  // root's own node is that root (`roots`); otherwise an ancestor some omitted
  // root needed (`ancestors`); otherwise a child (`children`).
  const omittedRoots = roots.slice(keptRoots.length)
  const everyNode = new Set<string>()
  for (const root of roots) {
    if (root.hasNode) everyNode.add(root.node)
    for (const key of [...root.ancestors, ...root.children]) everyNode.add(key)
  }
  const omittedRootNodes = new Set(omittedRoots.filter((root) => root.hasNode).map((root) => root.node))
  const omittedAncestors = new Set(omittedRoots.flatMap((root) => root.ancestors))
  const truncated = { roots: omittedRoots.length, ancestors: 0, children: 0, edges: 0 }
  for (const key of everyNode) {
    if (kept.has(key) || omittedRootNodes.has(key)) continue
    if (omittedAncestors.has(key)) truncated.ancestors++
    else truncated.children++
  }
  const edgesWithin = (nodes: Set<string>): string[] =>
    [...nodes].filter((key) => nodes.has(accepted.get(key)?.parent ?? NO_PARENT))
  truncated.edges = edgesWithin(everyNode).length - edgesWithin(kept).length

  const nodes: IssueGraphNode[] = [...kept].sort(byKey).map((key) => {
    const seen = factsOf.get(key)!
    const tally = countsOf.get(key)?.value
    return {
      key,
      ...seen.value,
      ...(tally ? { children_total: tally.total, children_completed: tally.completed } : {}),
      observed_at: seen.t,
      ...(conflicts.has(key) ? { conflict: true as const } : {}),
    }
  })
  const edges: IssueGraphEdge[] = edgesWithin(kept)
    .map((key) => ({ kind: 'contains' as const, from: accepted.get(key)!.parent, to: key, position: positionOf.get(key)!, observed_at: accepted.get(key)!.t }))
    .sort((a, b) => byKey(a.from, b.from) || a.position - b.position)
  const aliases: Record<string, string> = {}
  const keptByKey = [...keptRoots].sort((a, b) => byKey(a.key, b.key))
  for (const root of keptByKey) if (root.node !== root.key) aliases[root.key] = root.node
  return {
    version: 1,
    nodes,
    edges,
    roots: keptByKey.map((root) => ({
      key: root.key,
      refresh: root.refresh,
      fetched_at: root.row.fetched_at,
      checked_at: root.row.checked_at,
      error: root.row.error,
      failure: root.row.failure,
      children_omitted: root.children.filter((key) => !kept.has(key)).length,
    })),
    aliases,
    truncated,
  }
}
