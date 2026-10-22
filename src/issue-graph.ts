// The sub-issue graph behind GET /api/issues (issue #103, design §4.5 and §6).
//
// PURE: a function of listIssueSnapshots() rows and the display key set alone,
// with no database, clock, network or I/O, so identical database contents give
// identical bytes. That is what lets /api/issues be a conditional snapshot.
// Being pure is also what lets the stdio MCP process use it for a titled
// board_get's issue_rel (#103 PR2) without reaching the network
// (test/issue-graph.test.ts and test/prstate.test.ts pin that).
//
// Reconciliation in one paragraph. Every display root's snapshot, fetched at
// t, is a set of OBSERVATIONS about who each issue's parent is: a pointer (the
// walk upwards says so), a membership (a parent's list holds the child) or an
// absence (a parent's COMPLETE list does not). The newest observation decides,
// pointers before absences before memberships at equal t; contradictory equals
// and cycles fail closed as `conflict`. Facts (title, state) and child counts
// are separate observations: the freshest wins and they never decide parentage.
//
// GitHub dependencies (slice 2, 2026-10-21 design §6) in one more. Every
// observation is about a pair "A blocks B": B's own dependency section listing
// A in `blocked_by`, or A's listing B in `blocking`, says it holds; a COMPLETE
// list of either end that omits the other says it no longer does. The newest
// decides and a negative wins at equal t, because a missing "waits on" degrades
// to today's view while a false one misleads. A cycle is GitHub's data, kept
// and marked, never decided away.
import { issueKey } from '../public/issue-key.js'
import type { IssueKeySets } from '../public/issue-key.js'
import type {
  IssueDependencies, IssueDependencyList, IssueFacts, IssueRelative, IssueSnapshotRow, IssueState, IssueStateReason,
} from './store.js'

/** One response's budget: a unit per node, plus one per root entry that has no node. */
export const MAX_GRAPH_NODES = 2_000
// GitHub's eight levels: the chain emitted above one root never exceeds them
const MAX_ANCESTORS = 8

/** Slice 2: GitHub's counts from this issue's own bound, ok dependency section, never from other lists. */
export interface IssueDependencyCounts {
  blocked_by_open: number
  blocked_by_total: number
  blocking_open: number
  blocking_total: number
}

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
  /** slice 2: only when this issue's own section is bound and ok */
  deps?: IssueDependencyCounts
  observed_at: string
  /** rule 3 or rule 5 decided this issue's parent away */
  conflict?: true
}

/** Sub-issue containment, from the parent to its child. */
export interface IssueContainsEdge {
  kind: 'contains'
  from: string
  to: string
  /** index among the parent's children: GitHub's order, then the rest by key */
  position: number
  observed_at: string
}

/** Slice 2: GitHub's "blocked by", from the blocker to the issue that waits on it. Never sequencing by position. */
export interface IssueBlocksEdge {
  kind: 'blocks'
  from: string
  to: string
  observed_at: string
  /** both ends share a strongly connected component: a circular dependency on GitHub */
  cycle?: true
}

export type IssueGraphEdge = IssueContainsEdge | IssueBlocksEdge

export interface IssueGraphRoot {
  /** the requested key an entity links; see `aliases` for its node */
  key: string
  refresh: boolean
  fetched_at: string | null
  checked_at: string
  error: string | null
  failure: 'soft' | 'hard' | null
  /**
   * Whether this root's own snapshot could read its parent and sub-issues (§5.7);
   * null when there is no readable snapshot. Additive within version 1.
   */
  hierarchy: 'ok' | 'unavailable' | null
  /**
   * Slice 2: this root's own dependency section. `unknown` is a readable
   * snapshot whose section is missing or unbound (an older viewer refreshed it
   * since); null, no readable snapshot. Additive within version 1.
   */
  dependencies: 'ok' | 'unavailable' | 'unknown' | null
  children_omitted: number
  /** slice 2: this root's blocks edges (each a "waits on" or "unblocks" entry) the cap cut */
  dependencies_omitted: number
}

export interface IssueGraph {
  version: 1
  nodes: IssueGraphNode[]
  edges: IssueGraphEdge[]
  roots: IssueGraphRoot[]
  aliases: Record<string, string>
  /** `edges` counts both kinds; `dependencies`, neighbour nodes counted nowhere else (slice 2) */
  truncated: { roots: number; ancestors: number; children: number; dependencies: number; edges: number }
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
// Slice 2: one direction of a root's own dependency section, as observations
interface DependencySide { listed: Set<string>; complete: boolean }
interface DependencySection { t: string; blockedBy: DependencySide; blocking: DependencySide }
const NO_SECTIONS: readonly DependencySection[] = []
/** An accepted "from blocks to" pair, decided at `t`, its newest positive. */
interface Pair { from: string; to: string; t: string }
interface Root {
  key: string
  node: string
  row: IssueSnapshotRow
  refresh: boolean
  updatedAt: string
  hasNode: boolean
  ancestors: string[]
  children: string[]
  /** slice 2: its blockers, then its dependents, each by key */
  neighbours: string[]
  /** the same entries as their pairs, in the same order */
  blocks: Pair[]
}

// Whether an observation replaces the held one: newer, then the lower source
// (rule 7), then the lower observer key, so a tie can never depend on input
// order; of exact equals the first is kept. Applied as each one arrives.
function replaces<T>(held: Seen<T>, t: string, source: number, observer: string): boolean {
  if (held.t !== t) return t > held.t
  if (held.source !== source) return source < held.source
  return observer < held.observer
}

const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
// blocks edges in their output order: by blocker, then by dependent
const byEnds = (a: Pair, b: Pair): number => byKey(a.from, b.from) || byKey(a.to, b.to)

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

// §6 step 3 and slice 2's fills: rounds across `lists` in rank order, each
// giving every list its next entry not yet `done`, until `spent` or nothing is left.
function roundRobin<T>(lists: T[][], done: (entry: T) => boolean, take: (entry: T) => void, spent: () => boolean): void {
  const cursors = lists.map(() => 0)
  for (let progressed = true; progressed && !spent();) {
    progressed = false
    lists.forEach((list, index) => {
      if (spent()) return
      let cursor = cursors[index]!
      while (cursor < list.length && done(list[cursor]!)) cursor++
      const entry = list[cursor]
      if (entry !== undefined) {
        take(entry)
        cursor++
        progressed = true
      }
      cursors[index] = cursor
    })
  }
}

// Strongly connected components of the accepted blocks edges (Tarjan),
// iterative so a long chain cannot overflow the stack, and linear. Two keys
// share a component exactly when each reaches the other, so every edge between
// them lies on a cycle. A local copy of store.ts's waitsOnComponents: this
// module must stay pure and import no value but issueKey (§6.4).
function components(next: Map<string, string[]>): Map<string, number> {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const component = new Map<string, number>()
  const stack: string[] = []
  let visited = 0
  let found = 0
  const visit = (key: string): void => {
    index.set(key, visited)
    low.set(key, visited++)
    stack.push(key)
  }
  for (const start of next.keys()) {
    if (index.has(start)) continue
    visit(start)
    const frames = [{ key: start, edge: 0 }]
    while (frames.length) {
      const frame = frames[frames.length - 1]!
      const targets = next.get(frame.key) ?? []
      if (frame.edge < targets.length) {
        const to = targets[frame.edge++]!
        if (!index.has(to)) {
          visit(to)
          frames.push({ key: to, edge: 0 })
        } else if (!component.has(to)) {
          // still on the stack: part of the component being built
          low.set(frame.key, Math.min(low.get(frame.key)!, index.get(to)!))
        }
        continue
      }
      frames.pop()
      const parent = frames[frames.length - 1]
      if (parent) low.set(parent.key, Math.min(low.get(parent.key)!, low.get(frame.key)!))
      if (low.get(frame.key) !== index.get(frame.key)) continue
      let member: string
      do {
        member = stack.pop()!
        component.set(member, found)
      } while (member !== frame.key)
      found++
    }
  }
  return component
}

export function buildIssueGraph(
  snapshots: IssueSnapshotRow[],
  keySets: IssueKeySets,
  opts: { maxUnits?: number } = {},
): IssueGraph {
  const maxUnits = Math.max(0, opts.maxUnits ?? MAX_GRAPH_NODES)
  // Slice 2 §6.3: every edge of one response, both kinds, within twice its
  // node budget. A node has at most one parent edge, so containment always fits.
  const maxEdges = 2 * maxUnits
  // issueKey is pure, and a hub names the same issues again and again, in
  // every list that holds them: each repository and number is checked once.
  const keys = new Map<string, Map<number, string | null>>()
  const keyOf = (repo: string, number: number): string | null => {
    let byNumber = keys.get(repo)
    if (!byNumber) keys.set(repo, (byNumber = new Map()))
    let key = byNumber.get(number)
    if (key === undefined) byNumber.set(number, (key = issueKey(repo, number)))
    return key
  }

  // Rule 6. A hard failure of K at tF drops every observation about K made at
  // or before tF. Every cached row counts, displayed or not: a refusal only
  // ever removes data, and K's titles must not return because K stopped being
  // displayed while another issue's older list still names it.
  const failedAt = new Map<string, string>()
  for (const row of snapshots) {
    const key = keyOf(row.repo, row.number)
    if (key && row.failure === 'hard') failedAt.set(key, row.checked_at)
  }
  const suppressed = (key: string, t: string): boolean => {
    const tF = failedAt.get(key)
    return tF !== undefined && t <= tF
  }

  // Rule 9: only the display roots' own rows are read; any other row is inert.
  const rows: Array<{ key: string; row: IssueSnapshotRow }> = []
  for (const row of snapshots) {
    const key = keyOf(row.repo, row.number)
    if (key && keySets.display.has(key)) rows.push({ key, row })
  }
  rows.sort((a, b) => byKey(a.key, b.key))

  const claims = new Map<string, Claim[]>()
  const lists = new Map<string, ParentList[]>()
  // Facts and counts keep only the freshest observation of each issue (rule 7)
  const factsOf = new Map<string, Seen<IssueFacts>>()
  const countsOf = new Map<string, Seen<Counts>>()
  const aliasOf = new Map<string, string>()
  // slice 2: each canonical issue's own bound, ok dependency sections, and their counts
  const sections = new Map<string, DependencySection[]>()
  const dependencyCountsOf = new Map<string, Seen<IssueDependencyCounts>>()
  const offer = <T>(best: Map<string, Seen<T>>, key: string, t: string, source: number, observer: string, value: () => T) => {
    const held = best.get(key)
    if (!held || replaces(held, t, source, observer)) best.set(key, { t, source, observer, value: value() })
  }

  const fact = (key: string, t: string, source: number, observer: string, v: IssueRelative, withCounts: boolean) => {
    if (suppressed(key, t)) return
    offer(factsOf, key, t, source, observer, () => {
      const { repo, number, title, state, state_reason } = v
      return { repo, number, title, state, state_reason }
    })
    const { children_total: total, children_completed: completed } = v
    if (withCounts && total !== undefined && completed !== undefined) offer(countsOf, key, t, source, observer, () => ({ total, completed }))
  }
  // A claim naming a parent GitHub has since refused is not dropped but made
  // UNKNOWN: it still outranks every older claim, so a refuted parent can never
  // come back from a display-only list nobody refreshes any more.
  const claim = (child: string, t: string, rank: number, parent: string) => {
    if (suppressed(child, t)) return
    const named = parent !== NO_PARENT && suppressed(parent, t) ? UNKNOWN : parent
    push(claims, child, { t, rank, parent: named })
  }
  // Slice 2 §6.1. A listed issue's facts are a LISTED source (rule 7); the
  // root listing itself says nothing. Pairs are decided once every row is read.
  const section = (root: string, t: string, observer: string, deps: Extract<IssueDependencies, { status: 'ok' }>) => {
    const side = (list: IssueDependencyList): DependencySide => {
      const listed = new Set<string>()
      for (const issue of list.list) {
        const key = keyOf(issue.repo, issue.number)
        if (!key || key === root || listed.has(key)) continue
        listed.add(key)
        fact(key, t, LISTED, observer, issue, false)
      }
      return { listed, complete: !list.truncated }
    }
    const blockedBy = side(deps.blocked_by)
    const blocking = side(deps.blocking)
    // as with a parent's own list, a refused root's own section says nothing
    if (suppressed(root, t)) return
    push(sections, root, { t, blockedBy, blocking })
    const { blocked_by: by, blocking: to } = deps
    offer(dependencyCountsOf, root, t, OWN, observer, () => ({
      blocked_by_open: by.open, blocked_by_total: by.total, blocking_open: to.open, blocking_total: to.total,
    }))
  }

  for (const { key: observer, row } of rows) {
    const snap = row.snapshot
    const t = row.fetched_at
    if (!snap || !t) continue
    const root = keyOf(snap.issue.repo, snap.issue.number)
    if (!root) continue
    // Rule 8: GitHub followed a repository redirect; file under its answer.
    if (root !== observer) aliasOf.set(observer, root)
    fact(root, t, OWN, observer, snap.issue, false)
    // The dependency section is a section of its own, read whatever the
    // hierarchy's status. listIssueSnapshots returns it only while it is bound
    // to this row's fetched_at; missing, unbound or unavailable, it says nothing.
    if (row.dependencies?.status === 'ok') section(root, t, observer, row.dependencies)
    // An unavailable hierarchy section yields no observations at all.
    if (snap.hierarchy.status !== 'ok') continue
    const { total, completed } = snap.hierarchy
    if (!suppressed(root, t)) offer(countsOf, root, t, OWN, observer, () => ({ total, completed }))

    // Pointers up the walk, which stops at its first repeated issue. Its last
    // issue's parent is known only when the walk reached the top.
    const walked = new Set([root])
    let below = root
    let whole = true
    for (const [level, ancestor] of snap.ancestors.entries()) {
      const key = keyOf(ancestor.repo, ancestor.number)
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
      const key = keyOf(child.repo, child.number)
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

  // Slice 2 §6.1: each pair "from blocks to", by its two ends. Its positives,
  // newest first: the dependent's own blocked_by naming the blocker, or the
  // blocker's own blocking naming the dependent.
  const positive = new Map<string, Map<string, string>>()
  const assert = (from: string, to: string, t: string) => {
    let newest = positive.get(from)
    if (!newest) positive.set(from, (newest = new Map()))
    const held = newest.get(to)
    if (held === undefined || t > held) newest.set(to, t)
  }
  for (const [root, seen] of sections) {
    for (const { t, blockedBy, blocking } of seen) {
      for (const from of blockedBy.listed) assert(from, root, t)
      for (const to of blocking.listed) assert(root, to, t)
    }
  }
  // Each pair is decided on its own, so no order is needed here; only what is
  // emitted is sorted, below.
  const blocks: Pair[] = []
  const next = new Map<string, string[]>()
  const blockersOf = new Map<string, Pair[]>()
  const dependentsOf = new Map<string, Pair[]>()
  for (const [from, newest] of positive) {
    const blockerSections = sections.get(from) ?? NO_SECTIONS
    for (const [to, t] of newest) {
      // Rule 6, both ends: nothing said at or before either end's hard failure
      // counts. Only the newest positive needs the test: an older one never survives it.
      if (suppressed(from, t) || suppressed(to, t)) continue
      // Its negatives: a COMPLETE list of either end that omits the other (a
      // truncated one says nothing about what it lacks). The newest
      // observation decides, and at equal t a negative wins. '' is none.
      let negative = ''
      for (const own of sections.get(to) ?? NO_SECTIONS) {
        if (own.blockedBy.complete && !own.blockedBy.listed.has(from) && own.t > negative) negative = own.t
      }
      for (const own of blockerSections) {
        if (own.blocking.complete && !own.blocking.listed.has(to) && own.t > negative) negative = own.t
      }
      if (negative >= t) continue
      const pair = { from, to, t }
      blocks.push(pair)
      push(next, from, to)
      push(blockersOf, to, pair)
      push(dependentsOf, from, pair)
    }
  }
  // A cycle is GitHub's data: every edge inside a strongly connected component keeps it.
  const component = components(next)
  const circular = (pair: Pair): boolean => component.get(pair.from) === component.get(pair.to)

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
    // slice 2: its blockers, then its dependents, by key, as §6.3 fills them
    const blockers = (blockersOf.get(node) ?? []).filter((pair) => factsOf.has(pair.from)).sort((a, b) => byKey(a.from, b.from))
    const dependents = (dependentsOf.get(node) ?? []).filter((pair) => factsOf.has(pair.to)).sort((a, b) => byKey(a.to, b.to))
    return {
      key, node, row,
      refresh: display.refresh,
      updatedAt: display.updated_at,
      hasNode: factsOf.has(node),
      ancestors: ancestorsOf(node),
      children: (ordered.get(node) ?? []).filter((child) => factsOf.has(child)),
      neighbours: [...blockers.map((pair) => pair.from), ...dependents.map((pair) => pair.to)],
      blocks: [...blockers, ...dependents],
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
  let remaining = maxUnits - used
  const keep = (key: string) => {
    kept.add(key)
    remaining--
  }
  const nodesSpent = () => remaining <= 0
  roundRobin(keptRoots.map((root) => root.children), (key) => kept.has(key), keep, nodesSpent)
  // Slice 2 §6.3, step 4: then their dependency neighbours, the same way, each
  // root's blockers before its dependents, by key.
  roundRobin(keptRoots.map((root) => root.neighbours), (key) => kept.has(key), keep, nodesSpent)

  // Exact truncation. Each node the cap removed is counted once: an omitted
  // root's own node is that root (`roots`); otherwise an ancestor some omitted
  // root needed (`ancestors`); otherwise a child (`children`); otherwise a
  // dependency neighbour (`dependencies`).
  const omittedRoots = roots.slice(keptRoots.length)
  const everyNode = new Set<string>()
  const childNodes = new Set<string>()
  for (const root of roots) {
    if (root.hasNode) everyNode.add(root.node)
    for (const key of root.ancestors) everyNode.add(key)
    for (const key of root.children) {
      everyNode.add(key)
      childNodes.add(key)
    }
    for (const key of root.neighbours) everyNode.add(key)
  }
  const omittedRootNodes = new Set(omittedRoots.filter((root) => root.hasNode).map((root) => root.node))
  const omittedAncestors = new Set(omittedRoots.flatMap((root) => root.ancestors))
  const truncated = { roots: omittedRoots.length, ancestors: 0, children: 0, dependencies: 0, edges: 0 }
  for (const key of everyNode) {
    if (kept.has(key) || omittedRootNodes.has(key)) continue
    if (omittedAncestors.has(key)) truncated.ancestors++
    else if (childNodes.has(key)) truncated.children++
    else truncated.dependencies++
  }
  const edgesWithin = (nodes: Set<string>): string[] =>
    [...nodes].filter((key) => nodes.has(accepted.get(key)?.parent ?? NO_PARENT))
  const containedKeys = edgesWithin(kept)
  truncated.edges = edgesWithin(everyNode).length - containedKeys.length

  // Slice 2 §6.3: a blocks edge only between two emitted nodes, in what the
  // edge budget leaves after containment: round-robin across the kept roots in
  // rank order (each root's blockers, then its dependents, by key), then any
  // other edge between emitted nodes, by key. Every one cut is counted.
  const emitted = new Set<Pair>()
  let edgeBudget = maxEdges - containedKeys.length
  const between = (pair: Pair) => kept.has(pair.from) && kept.has(pair.to)
  const emit = (pair: Pair) => {
    emitted.add(pair)
    edgeBudget--
  }
  const edgesSpent = () => edgeBudget <= 0
  const done = (pair: Pair) => emitted.has(pair)
  roundRobin(keptRoots.map((root) => root.blocks.filter(between)), done, emit, edgesSpent)
  // only what the round-robin left needs an order of its own
  if (!edgesSpent()) roundRobin([blocks.filter((pair) => !emitted.has(pair) && between(pair)).sort(byEnds)], done, emit, edgesSpent)
  truncated.edges += blocks.length - emitted.size

  const nodes: IssueGraphNode[] = [...kept].sort(byKey).map((key) => {
    const seen = factsOf.get(key)!
    const tally = countsOf.get(key)?.value
    const dependencies = dependencyCountsOf.get(key)?.value
    return {
      key,
      ...seen.value,
      ...(tally ? { children_total: tally.total, children_completed: tally.completed } : {}),
      ...(dependencies ? { deps: dependencies } : {}),
      observed_at: seen.t,
      ...(conflicts.has(key) ? { conflict: true as const } : {}),
    }
  })
  const contained: IssueContainsEdge[] = containedKeys
    .map((key) => ({ kind: 'contains' as const, from: accepted.get(key)!.parent, to: key, position: positionOf.get(key)!, observed_at: accepted.get(key)!.t }))
    .sort((a, b) => byKey(a.from, b.from) || a.position - b.position)
  const blocking: IssueBlocksEdge[] = [...emitted].sort(byEnds).map((pair) => ({
    kind: 'blocks' as const, from: pair.from, to: pair.to, observed_at: pair.t, ...(circular(pair) ? { cycle: true as const } : {}),
  }))
  const aliases: Record<string, string> = {}
  const keptByKey = [...keptRoots].sort((a, b) => byKey(a.key, b.key))
  for (const root of keptByKey) if (root.node !== root.key) aliases[root.key] = root.node
  return {
    version: 1,
    nodes,
    edges: [...contained, ...blocking],
    roots: keptByKey.map((root) => ({
      key: root.key,
      refresh: root.refresh,
      fetched_at: root.row.fetched_at,
      checked_at: root.row.checked_at,
      error: root.row.error,
      failure: root.row.failure,
      hierarchy: root.row.snapshot?.hierarchy.status ?? null,
      dependencies: root.row.snapshot ? root.row.dependencies?.status ?? 'unknown' : null,
      children_omitted: root.children.filter((key) => !kept.has(key)).length,
      dependencies_omitted: root.blocks.filter((pair) => !emitted.has(pair)).length,
    })),
    aliases,
    truncated,
  }
}

// ── issue_rel: the agent's short summary (issue #103 PR2, §10) ──────────────

// The ages §5.8 renders by: dimmed after 30 minutes, hidden after 7 days.
const REL_STALE_MS = 30 * 60_000
const REL_HIDDEN_MS = 7 * 24 * 60 * 60_000
// slice 2 §6.4: GitHub's own limit per dependency type
const REL_WAITS_ON_MAX = 50

/** What a titled board_get says about one linked issue: keys and counts, never titles. */
export interface IssueRel {
  key: string
  parent?: string
  children?: { total: number; done: number }
  /**
   * Slice 2 §6.4: the keys of this issue's OPEN blockers on GitHub ("blocked
   * by") that reconciled to an edge, sorted, at most 50. Read-only GitHub data,
   * not a row's own writable `waits_on` step labels, and never a reason for
   * `blocked`. With `unblocks`, present only while this issue's own dependency
   * section is bound, ok and at most 7 days old: absent means unknown, never none.
   */
  waits_on_issues?: string[]
  /** slice 2: how many OPEN issues this one blocks on GitHub */
  unblocks?: number
  /** the latest applied attempt, whatever its outcome */
  checked_at: string
  /** no successful fetch in the last 30 minutes */
  stale: boolean
  /** no parent or sub-issues to draw: a hard failure, an unavailable hierarchy or a snapshot over 7 days old */
  unavailable: boolean
}

// The relationships the viewer would draw for each key, read off the same
// reconciled graph. A key with no cached answer gets no entry: a soft failure
// before any success knows nothing. `nowMs` is passed in to keep this pure.
// A summary is no response, so it reads the whole graph: a node cap could
// otherwise shorten waits_on_issues into a list that looks complete.
export function issueRelations(snapshots: IssueSnapshotRow[], keys: Iterable<string>, nowMs: number): Map<string, IssueRel> {
  const display = new Map<string, { refresh: boolean; updated_at: string }>()
  for (const key of keys) display.set(key, { refresh: true, updated_at: '' })
  const graph = buildIssueGraph(snapshots, { refresh: new Set(display.keys()), display }, { maxUnits: Infinity })
  const nodes = new Map(graph.nodes.map((node) => [node.key, node]))
  const parents = new Map<string, string>()
  const blockersOf = new Map<string, string[]>()
  const dependentsOf = new Map<string, string[]>()
  for (const edge of graph.edges) {
    if (edge.kind === 'contains') parents.set(edge.to, edge.from)
    else {
      push(blockersOf, edge.to, edge.from)
      push(dependentsOf, edge.from, edge.to)
    }
  }
  const open = (key: string) => nodes.get(key)?.state === 'OPEN'
  const out = new Map<string, IssueRel>()
  for (const root of graph.roots) {
    if (root.fetched_at === null && root.failure !== 'hard') continue
    const age = root.fetched_at === null ? Infinity : nowMs - Date.parse(root.fetched_at)
    const node = nodes.get(graph.aliases[root.key] ?? root.key)
    // the root's own hierarchy status, which the viewer's chips read too
    const unavailable = !node || age > REL_HIDDEN_MS || root.hierarchy !== 'ok'
    let parent: string | undefined
    let children: IssueRel['children']
    if (node && !unavailable) {
      parent = parents.get(node.key)
      if (node.children_total !== undefined && node.children_completed !== undefined) {
        children = { total: node.children_total, done: node.children_completed }
      }
    }
    // A separate section with its own status: only this issue's own answer,
    // bound, ok and at most 7 days old, says anything about its dependencies.
    let waitsOn: string[] | undefined
    let unblocks: number | undefined
    if (node && root.dependencies === 'ok' && age <= REL_HIDDEN_MS) {
      waitsOn = (blockersOf.get(node.key) ?? []).filter(open).sort(byKey).slice(0, REL_WAITS_ON_MAX)
      unblocks = (dependentsOf.get(node.key) ?? []).filter(open).length
    }
    out.set(root.key, {
      key: root.key,
      ...(parent !== undefined ? { parent } : {}),
      ...(children ? { children } : {}),
      ...(waitsOn ? { waits_on_issues: waitsOn } : {}),
      ...(unblocks !== undefined ? { unblocks } : {}),
      checked_at: root.checked_at,
      stale: !(age <= REL_STALE_MS),
      unavailable,
    })
  }
  return out
}
