// Issue #103, PR1a: the pure hierarchy reconciliation (§4.5) and the node cap
// (§6) behind GET /api/issues. Everything here is a pure function of
// listIssueSnapshots() rows and the display key set, so most cases build rows
// by hand; the revival case goes through the real store.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { buildIssueGraph, issueRelations, MAX_GRAPH_NODES } from '../src/issue-graph.js'
import type { IssueBlocksEdge, IssueContainsEdge, IssueGraph } from '../src/issue-graph.js'
import { parseIssueBatch } from '../src/issue-poller.js'
import { listIssueSnapshots, openDb, recordIssueFailure, upsertIssueSnapshot } from '../src/store.js'
import type { IssueDependencies, IssueSnapshot, IssueSnapshotRow } from '../src/store.js'
import { at, deps, depsOf, facts, keySets, row, snapshot } from './issue-fixtures.js'
import type { SnapshotOpts } from './issue-fixtures.js'
import { scratchDir } from './scratch.js'

const contains = (graph: IssueGraph): IssueContainsEdge[] =>
  graph.edges.filter((edge): edge is IssueContainsEdge => edge.kind === 'contains')
const parentOf = (graph: IssueGraph, key: string): string | null =>
  contains(graph).find((edge) => edge.to === key)?.from ?? null
const childrenOf = (graph: IssueGraph, key: string): string[] =>
  contains(graph).filter((edge) => edge.from === key).sort((a, b) => a.position - b.position).map((edge) => edge.to)
const node = (graph: IssueGraph, key: string) => graph.nodes.find((n) => n.key === key)
const nodeKeys = (graph: IssueGraph): string[] => graph.nodes.map((n) => n.key)
const rootKeys = (graph: IssueGraph): string[] => graph.roots.map((r) => r.key)
const build = (rows: IssueSnapshotRow[], display: string[], opts: Parameters<typeof keySets>[1] = {}, maxUnits?: number) =>
  buildIssueGraph(rows, keySets(display, opts), maxUnits === undefined ? {} : { maxUnits })

// Single letters for the worked examples: P and Q are parents, C the child.
const P = 'o/r#1'
const Q = 'o/r#2'
const C = 'o/r#3'
const A = 'o/r#11'
const B = 'o/r#12'
const D = 'o/r#13'

/** C's own row when C has never been fetched successfully: a root whose facts come only from others. */
const unfetched = (key: string) => row(key, null, null, { error: 'offline', checkedAt: at(1) })

/**
 * A snapshot that says only "my parent is `parent`": its walk stops there
 * (`limit`) and its own list is truncated. A COMPLETE list would also be an
 * absence for every issue it lacks, and rule 2 would refute the older pointer
 * of a cycle before rule 5 ever saw one.
 */
const pointsTo = (key: string, parent: string) =>
  snapshot(key, { ancestors: [parent], end: 'limit', truncated: true, total: 150 })

describe('the v1 graph shape (§4.7)', () => {
  it('is empty, but complete, when nothing is cached', () => {
    expect(build([], [P, C])).toEqual({
      version: 1, nodes: [], edges: [], roots: [], aliases: {},
      truncated: { roots: 0, ancestors: 0, children: 0, dependencies: 0, edges: 0 },
    })
  })

  it('reconciles the live #117 family: GitHub order, counts and freshness', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/issue-117-family.json', import.meta.url), 'utf8')) as {
      fetched_at: string
      rows: Array<{ repo: string; number: number; snapshot: IssueSnapshot }>
    }
    const rows = fixture.rows.map((r) => row(`${r.repo}#${r.number}`, r.snapshot, fixture.fetched_at))
    const graph = build(rows, rows.map((r) => `${r.repo}#${r.number}`))
    const family = Array.from({ length: 10 }, (_, i) => `shariqh/agent-inbox#${118 + i}`)
    expect(nodeKeys(graph)).toEqual(['shariqh/agent-inbox#117', ...family])
    expect(childrenOf(graph, 'shariqh/agent-inbox#117')).toEqual(family)
    expect(graph.edges[2]).toEqual({
      kind: 'contains', from: 'shariqh/agent-inbox#117', to: 'shariqh/agent-inbox#120',
      position: 2, observed_at: fixture.fetched_at,
    })
    expect(node(graph, 'shariqh/agent-inbox#117')).toEqual({
      key: 'shariqh/agent-inbox#117', repo: 'shariqh/agent-inbox', number: 117,
      title: 'Integrate Agent Inbox with Agent Host Protocol', state: 'OPEN', state_reason: null,
      children_total: 10, children_completed: 0, observed_at: fixture.fetched_at,
    })
    // #127 is nobody's root: it is known only from #117's list, which carries its counts
    expect(node(graph, 'shariqh/agent-inbox#127')).toMatchObject({ children_total: 0, children_completed: 0 })
    expect(graph.roots).toHaveLength(10)
    expect(graph.roots[0]).toEqual({
      key: 'shariqh/agent-inbox#117', refresh: true, fetched_at: fixture.fetched_at, checked_at: fixture.fetched_at,
      error: null, failure: null, hierarchy: 'ok', dependencies: 'unknown', children_omitted: 0, dependencies_omitted: 0, dependencies_omitted_open: { blocked_by: 0, blocking: 0 },
    })
    expect(graph.aliases).toEqual({})
    expect(graph.truncated).toEqual({ roots: 0, ancestors: 0, children: 0, dependencies: 0, edges: 0 })
  })
})

describe('the §4.5 worked examples, row by row', () => {
  it('t20 P’s complete list omits C · t10 P lists C → unknown: C left P', () => {
    // Two snapshots of P exist only through a repository redirect: the old name was fetched at t10.
    const oldP = snapshot('old/r#1', { issue: { repo: 'o/r' }, children: [C] })
    const graph = build([row('old/r#1', oldP, at(10)), row(P, snapshot(P), at(20)), unfetched(C)], ['old/r#1', P, C])
    expect(graph.aliases).toEqual({ 'old/r#1': P })
    expect(node(graph, C)).toMatchObject({ title: `Title of ${C}` })
    expect(parentOf(graph, C)).toBeNull()
    expect(node(graph, C)?.conflict).toBeUndefined()
  })

  it('t20 C points to Q · t10 P lists C → Q: C moved', () => {
    const graph = build([row(C, snapshot(C, { ancestors: [Q] }), at(20)), row(P, snapshot(P, { children: [C] }), at(10))], [C, P])
    expect(parentOf(graph, C)).toBe(Q)
    expect(childrenOf(graph, P)).toEqual([])
    // P's own count still says 1: the UI reports it as not visible
    expect(node(graph, P)).toMatchObject({ children_total: 1 })
  })

  it('t20 C points to none · t10 P lists C → none: C was detached', () => {
    const graph = build([row(C, snapshot(C), at(20)), row(P, snapshot(P, { children: [C] }), at(10))], [C, P])
    expect(parentOf(graph, C)).toBeNull()
    expect(childrenOf(graph, P)).toEqual([])
  })

  it('t20 P lists C · t10 C points to none → P: C was added after its own last refresh', () => {
    const graph = build([row(P, snapshot(P, { children: [C] }), at(20)), row(C, snapshot(C), at(10))], [P, C])
    expect(parentOf(graph, C)).toBe(P)
    expect(graph.edges).toEqual([{ kind: 'contains', from: P, to: C, position: 0, observed_at: at(20) }])
  })

  it('t20 P lists C and Q lists C (one batch), nothing from C → unknown, conflict', () => {
    const graph = build([
      row(P, snapshot(P, { children: [C] }), at(20)), row(Q, snapshot(Q, { children: [C] }), at(20)), unfetched(C),
    ], [P, Q, C])
    expect(parentOf(graph, C)).toBeNull()
    expect(node(graph, C)).toMatchObject({ conflict: true })
    expect(node(graph, P)?.conflict).toBeUndefined()
  })

  it('t20 C points to P and P’s complete list omits C (one batch) → P: a pointer outranks an absence', () => {
    const graph = build([row(C, snapshot(C, { ancestors: [P] }), at(20)), row(P, snapshot(P), at(20))], [C, P])
    expect(parentOf(graph, C)).toBe(P)
  })

  it('t30 B points to A · t20 A points to B → a cycle: the older decision is dropped, both conflict', () => {
    const graph = build([row(B, pointsTo(B, A), at(30)), row(A, pointsTo(A, B), at(20))], [A, B])
    expect(parentOf(graph, B)).toBe(A)
    expect(parentOf(graph, A)).toBeNull()
    expect(node(graph, A)).toMatchObject({ conflict: true })
    expect(node(graph, B)).toMatchObject({ conflict: true })
  })
})

describe('reconciliation rules', () => {
  it('rule 1: at equal time a pointer outranks a membership naming another parent', () => {
    const graph = build([
      row(C, snapshot(C, { ancestors: [Q] }), at(20)), row(P, snapshot(P, { children: [C] }), at(20)),
    ], [C, P])
    expect(parentOf(graph, C)).toBe(Q)
    expect(node(graph, C)?.conflict).toBeUndefined()
  })

  it('rule 2: an older claim never returns once a newer absence refuted it', () => {
    // t30 P omits C (complete); t20 Q's list omits C too; t10 Q listed C under the old name
    const oldQ = snapshot('old/r#2', { issue: { repo: 'o/r' }, children: [C] })
    const graph = build([
      row('old/r#2', oldQ, at(10)), row(Q, snapshot(Q), at(20)), row(P, snapshot(P), at(30)), unfetched(C),
    ], ['old/r#2', Q, P, C])
    expect(parentOf(graph, C)).toBeNull()
  })

  it('rule 3 also covers two pointers of one batch that disagree', () => {
    // C's own walk says P; R's walk, in the same batch, passes through C and says Q
    const R = 'o/r#4'
    const graph = build([
      row(C, snapshot(C, { ancestors: [P] }), at(20)),
      row(R, snapshot(R, { ancestors: [C, Q] }), at(20)),
    ], [C, R])
    expect(parentOf(graph, C)).toBeNull()
    expect(node(graph, C)).toMatchObject({ conflict: true })
    expect(parentOf(graph, R)).toBe(C)
  })

  it('cycles of three, including a tie for the oldest decision', () => {
    const three = (tA: number, tB: number, tC: number) => build([
      row(A, pointsTo(A, B), at(tA)), row(B, pointsTo(B, D), at(tB)), row(D, pointsTo(D, A), at(tC)),
    ], [A, B, D])
    const plain = three(10, 20, 30)
    expect([parentOf(plain, A), parentOf(plain, B), parentOf(plain, D)]).toEqual([null, D, A])
    const tie = three(10, 10, 20)
    expect([parentOf(tie, A), parentOf(tie, B), parentOf(tie, D)]).toEqual([null, null, A])
    for (const graph of [plain, tie]) {
      for (const key of [A, B, D]) expect(node(graph, key), key).toMatchObject({ conflict: true })
    }
  })

  it('a parent’s newer complete list refutes a stale pointer before it can close a cycle', () => {
    // as the t30/t20 example, but B's own list is complete and lacks A
    const graph = build([
      row(B, snapshot(B, { ancestors: [A], end: 'limit' }), at(30)), row(A, pointsTo(A, B), at(20)),
    ], [A, B])
    expect([parentOf(graph, A), parentOf(graph, B)]).toEqual([null, A])
    expect(graph.nodes.some((n) => n.conflict)).toBe(false)
  })

  it('a two-issue cycle decided in one batch drops both decisions', () => {
    const graph = build([row(A, pointsTo(A, B), at(10)), row(B, pointsTo(B, A), at(10))], [A, B])
    expect(graph.edges).toEqual([])
    expect(graph.nodes.map((n) => n.conflict)).toEqual([true, true])
  })

  it('rule 4: children keep GitHub’s order from the parent’s freshest list, then the others by key', () => {
    const graph = build([
      row(P, snapshot(P, { children: ['o/r#9', 'o/r#5'] }), at(10)),
      row('o/r#7', snapshot('o/r#7', { ancestors: [P] }), at(20)),
      row('o/r#30', snapshot('o/r#30', { ancestors: [P] }), at(20)),
    ], [P, 'o/r#7', 'o/r#30'])
    expect(childrenOf(graph, P)).toEqual(['o/r#9', 'o/r#5', 'o/r#30', 'o/r#7'])
    expect(contains(graph).filter((e) => e.from === P).map((e) => [e.to, e.position])).toEqual([
      ['o/r#9', 0], ['o/r#5', 1], ['o/r#30', 2], ['o/r#7', 3],
    ])
  })

  it('rule 4 / AC9: counts only on the root, its immediate parent and its children', () => {
    const graph = build([row('o/r#10', snapshot('o/r#10', {
      // the store refuses counts above the parent; the builder ignores them too
      ancestors: [facts('o/r#5', { children_total: 3, children_completed: 1 }), facts('o/r#1', { children_total: 9, children_completed: 9 })],
      children: [facts('o/r#20', { children_total: 2, children_completed: 0 })],
    }), at(10))], ['o/r#10'])
    expect(node(graph, 'o/r#10')).toMatchObject({ children_total: 1, children_completed: 0 })
    expect(node(graph, 'o/r#5')).toMatchObject({ children_total: 3, children_completed: 1 })
    expect(node(graph, 'o/r#20')).toMatchObject({ children_total: 2, children_completed: 0 })
    const higher = node(graph, 'o/r#1')!
    expect('children_total' in higher || 'children_completed' in higher).toBe(false)
    expect(childrenOf(graph, 'o/r#1')).toEqual(['o/r#5'])
  })

  it('rule 4: the freshest observation that carries counts wins, independently of facts', () => {
    const graph = build([
      // t20: P is only an ancestor two levels up, so this walk has P's title but no counts
      row('o/r#30', snapshot('o/r#30', { ancestors: ['o/r#20', facts(P, { title: 'Renamed' })] }), at(20)),
      row('o/r#20', snapshot('o/r#20', { ancestors: [facts(P, { children_total: 4, children_completed: 2 })] }), at(10)),
    ], ['o/r#30', 'o/r#20'])
    expect(node(graph, P)).toMatchObject({ title: 'Renamed', children_total: 4, children_completed: 2, observed_at: at(20) })
  })

  it('rule 7: the freshest facts win; at equal time the issue’s own root beats a list, which beats a walk', () => {
    const X = 'o/r#50'
    const rows = (own: boolean, list: boolean) => [
      ...(own ? [row(X, snapshot(X, { issue: { title: 'own' } }), at(10))] : []),
      ...(list ? [row(P, snapshot(P, { children: [facts(X, { title: 'list' })] }), at(10))] : []),
      row(C, snapshot(C, { ancestors: [facts(X, { title: 'walk' })] }), at(10)),
    ]
    const titles = (own: boolean, list: boolean) => node(build(rows(own, list), [X, P, C]), X)?.title
    expect([titles(true, true), titles(false, true), titles(false, false)]).toEqual(['own', 'list', 'walk'])
    const fresher = build([
      row(X, snapshot(X, { issue: { title: 'own, older', state: 'OPEN' } }), at(10)),
      row(C, snapshot(C, { ancestors: [facts(X, { title: 'walk, newer', state: 'CLOSED', state_reason: 'COMPLETED' })] }), at(20)),
    ], [X, C])
    expect(node(fresher, X)).toMatchObject({ title: 'walk, newer', state: 'CLOSED', state_reason: 'COMPLETED', observed_at: at(20) })
  })

  it('a truncated list is no evidence of absence', () => {
    const oldP = snapshot('old/r#1', { issue: { repo: 'o/r' }, children: [C] })
    const graph = build([
      row('old/r#1', oldP, at(10)), row(P, snapshot(P, { children: ['o/r#4'], truncated: true, total: 150 }), at(20)),
    ], ['old/r#1', P])
    expect(childrenOf(graph, P)).toEqual(['o/r#4', C])
  })

  it('an unavailable hierarchy yields no observations, only the root’s own facts', () => {
    const graph = build([
      row(C, { ...snapshot(C, { ancestors: [P] }), hierarchy: { status: 'unavailable' } }, at(10)),
    ], [C])
    expect(nodeKeys(graph)).toEqual([C])
    expect(graph.edges).toEqual([])
    expect('children_total' in node(graph, C)!).toBe(false)
  })

  it('drops self-links and collapses duplicate children', () => {
    // P's walk names P itself, so no pointer speaks for P: a kept self-link would decide P's parent
    const graph = build([row(P, snapshot(P, { ancestors: [P], children: [P, C, C] }), at(10))], [P])
    expect(graph.edges).toEqual([{ kind: 'contains', from: P, to: C, position: 0, observed_at: at(10) }])
    expect(graph.nodes.some((n) => n.conflict)).toBe(false)
  })

  it('an ancestor walk stops at its first repeated issue and asserts nothing about the last one kept', () => {
    // R's walk A → B → A: B's parent is unknown to R, so Q's older list still decides it
    const R = 'o/r#4'
    const graph = build([
      row(R, snapshot(R, { ancestors: [A, B, A] }), at(20)),
      row(Q, snapshot(Q, { children: [B] }), at(10)),
    ], [R, Q])
    expect([parentOf(graph, R), parentOf(graph, A), parentOf(graph, B)]).toEqual([A, B, Q])
    expect(graph.nodes.some((n) => n.conflict)).toBe(false)
  })

  it('the emitted ancestor chain stops after eight levels', () => {
    const chain = Array.from({ length: 8 }, (_, i) => `o/r#${101 + i}`)
    const graph = build([
      row('o/r#100', snapshot('o/r#100', { ancestors: chain, end: 'limit' }), at(10)),
      // #108's own walk adds two more levels above the first root's eighth
      row('o/r#108', snapshot('o/r#108', { ancestors: ['o/r#109', 'o/r#110'] }), at(10)),
    ], ['o/r#100', 'o/r#108'], { displayOnly: ['o/r#108'] }, 9)
    // the first root needs 1 + 8 units, not 11; #108's root then needs two more, which do not fit
    expect(rootKeys(graph)).toEqual(['o/r#100'])
    expect(nodeKeys(graph)).toEqual(['o/r#100', ...chain].sort())
    expect(graph.truncated).toEqual({ roots: 1, ancestors: 2, children: 0, dependencies: 0, edges: 2 })
  })

  it('keeps a/x#5 and b/y#5 apart everywhere', () => {
    const graph = build([
      row('a/x#5', snapshot('a/x#5', { ancestors: ['a/x#1'] }), at(10)),
      row('b/y#5', snapshot('b/y#5', { ancestors: ['b/y#1'], children: ['a/x#5'] }), at(5)),
    ], ['a/x#5', 'b/y#5'])
    expect(nodeKeys(graph)).toEqual(['a/x#1', 'a/x#5', 'b/y#1', 'b/y#5'])
    expect(parentOf(graph, 'a/x#5')).toBe('a/x#1')
    expect(parentOf(graph, 'b/y#5')).toBe('b/y#1')
    expect(childrenOf(graph, 'b/y#5')).toEqual([])
  })
})

describe('hard failures (rule 6)', () => {
  const K = 'o/r#7'

  it('suppress the issue everywhere at once: no node, no title, no edge', () => {
    const graph = build([
      row(P, snapshot(P, { children: [facts(K, { title: 'Private title' }), C] }), at(10)),
      row(K, null, null, { error: 'not-found', checkedAt: at(20) }),
    ], [P, K])
    expect(node(graph, K)).toBeUndefined()
    expect(JSON.stringify(graph)).not.toContain('Private title')
    expect(childrenOf(graph, P)).toEqual([C])
    expect(graph.roots.find((r) => r.key === K)).toEqual({
      key: K, refresh: true, fetched_at: null, checked_at: at(20), error: 'not-found', failure: 'hard', hierarchy: null, dependencies: null, children_omitted: 0, dependencies_omitted: 0, dependencies_omitted_open: { blocked_by: 0, blocking: 0 },
    })
    expect(node(graph, P)).toMatchObject({ children_total: 2 })
  })

  it('also when the failed issue is nobody’s root any more', () => {
    const graph = build([
      row(P, snapshot(P, { children: [K] }), at(10)),
      row(K, null, null, { error: 'forbidden', checkedAt: at(20) }),
    ], [P])
    expect(nodeKeys(graph)).toEqual([P])
  })

  it('a stale claim never returns when the newer one named a failed parent', () => {
    // C pointed to K at t10; K is gone since t20. Q's display-only list from t5 must not take C back.
    const graph = build([
      row(C, snapshot(C, { ancestors: [K] }), at(10)),
      row(K, null, null, { error: 'not-found', checkedAt: at(20) }),
      row(Q, snapshot(Q, { children: [C] }), at(5)),
    ], [C, K, Q], { displayOnly: [Q] })
    expect(parentOf(graph, C)).toBeNull()
    expect(childrenOf(graph, Q)).toEqual([])
  })

  it('count again when observed after the failure', () => {
    const graph = build([
      row(P, snapshot(P, { children: [facts(K, { title: 'Visible again' })] }), at(25)),
      row(K, null, null, { error: 'forbidden', checkedAt: at(20) }),
    ], [P, K])
    expect(node(graph, K)).toMatchObject({ title: 'Visible again', observed_at: at(25) })
    expect(parentOf(graph, K)).toBe(P)
    expect(graph.roots.find((r) => r.key === K)).toMatchObject({ failure: 'hard' })
  })

  describe('through the real store', () => {
    let dir: string | undefined
    afterEach(() => {
      vi.useRealTimers()
      if (dir) rmSync(dir, { recursive: true, force: true })
      dir = undefined
    })

    it('suppress at once and revive with the next success', () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.parse(at(60)))
      dir = scratchDir('issue-graph-')
      const db = openDb(join(dir, 'inbox.db'))
      try {
        const sets = keySets([P, K])
        upsertIssueSnapshot(db, { repo: 'o/r', number: 1, snapshot: snapshot(P, { children: [K] }), startedAt: at(10) })
        upsertIssueSnapshot(db, { repo: 'o/r', number: 7, snapshot: snapshot(K, { ancestors: [P] }), startedAt: at(10) })
        expect(childrenOf(buildIssueGraph(listIssueSnapshots(db), sets), P)).toEqual([K])
        recordIssueFailure(db, { repo: 'o/r', number: 7, error: 'not-found', startedAt: at(20) })
        const failed = buildIssueGraph(listIssueSnapshots(db), sets)
        expect(nodeKeys(failed)).toEqual([P])
        recordIssueFailure(db, { repo: 'o/r', number: 7, error: 'offline', startedAt: at(25) })
        expect(nodeKeys(buildIssueGraph(listIssueSnapshots(db), sets))).toEqual([P])
        upsertIssueSnapshot(db, { repo: 'o/r', number: 7, snapshot: snapshot(K, { ancestors: [P] }), startedAt: at(30) })
        const revived = buildIssueGraph(listIssueSnapshots(db), sets)
        expect(childrenOf(revived, P)).toEqual([K])
        expect(revived.roots.find((r) => r.key === K)).toMatchObject({ failure: null, fetched_at: at(30) })
      } finally {
        db.close()
      }
    })
  })
})

describe('identity and scope', () => {
  it('files a redirected repository under GitHub’s canonical key and aliases the requested one', () => {
    const redirected = snapshot('twitter/bootstrap#2', { issue: { repo: 'twbs/bootstrap' } })
    const graph = build([row('twitter/bootstrap#2', redirected, at(10))], ['twitter/bootstrap#2'])
    expect(graph.aliases).toEqual({ 'twitter/bootstrap#2': 'twbs/bootstrap#2' })
    expect(rootKeys(graph)).toEqual(['twitter/bootstrap#2'])
    expect(graph.nodes).toEqual([expect.objectContaining({ key: 'twbs/bootstrap#2', repo: 'twbs/bootstrap', number: 2 })])
  })

  it('keys by lowercased repository but keeps GitHub’s casing for display, with no alias', () => {
    const graph = build([row('TWBS/Bootstrap#2', snapshot('TWBS/Bootstrap#2'), at(10))], ['twbs/bootstrap#2'])
    expect(graph.aliases).toEqual({})
    expect(rootKeys(graph)).toEqual(['twbs/bootstrap#2'])
    expect(graph.nodes[0]).toMatchObject({ key: 'twbs/bootstrap#2', repo: 'TWBS/Bootstrap' })
  })

  it('reads only snapshots of display roots: any other cached row is inert', () => {
    const Z = 'o/r#9'
    const graph = build([
      row(P, snapshot(P), at(10)),
      row(Z, snapshot(Z, { children: [P] }), at(20)),
    ], [P])
    expect(nodeKeys(graph)).toEqual([P])
    expect(rootKeys(graph)).toEqual([P])
  })

  it('reports soft failures with their age, and roots never fetched not at all', () => {
    const graph = build([
      row(P, snapshot(P), at(10), { error: 'rate-limit', checkedAt: at(40) }),
      row(Q, null, null, { error: 'no-gh', checkedAt: at(40) }),
    ], [P, Q, C], { displayOnly: [Q] })
    expect(graph.roots).toEqual([
      { key: P, refresh: true, fetched_at: at(10), checked_at: at(40), error: 'rate-limit', failure: 'soft', hierarchy: 'ok', dependencies: 'unknown', children_omitted: 0, dependencies_omitted: 0, dependencies_omitted_open: { blocked_by: 0, blocking: 0 } },
      { key: Q, refresh: false, fetched_at: null, checked_at: at(40), error: 'no-gh', failure: 'soft', hierarchy: null, dependencies: null, children_omitted: 0, dependencies_omitted: 0, dependencies_omitted_open: { blocked_by: 0, blocking: 0 } },
    ])
    expect(nodeKeys(graph)).toEqual([P])
  })

  // #103 PR3 review: GitHub can return an issue but fail on its parent or
  // sub-issues (§5.7). The root says so, so the browser can draw no
  // relationship for it, exactly as issue_rel already reports it unavailable.
  it('reports whether each root\'s own hierarchy could be read', () => {
    const graph = build([
      row(P, snapshot(P, { children: [C] }), at(10)),
      row(C, snapshot(C, { unavailable: true }), at(10)),
      row(Q, null, null, { error: 'not-found', checkedAt: at(10) }),
    ], [P, C, Q])
    expect(graph.roots.map((r) => [r.key, r.hierarchy])).toEqual([[P, 'ok'], [Q, null], [C, 'unavailable']])
    // the facts still count: C stays P's child in P's own list
    expect(childrenOf(graph, P)).toEqual([C])
  })

  it('is byte-identical however its inputs are ordered', () => {
    const rows = [
      row(P, snapshot(P, { children: [C, 'o/r#4'] }), at(10)),
      row(C, snapshot(C, { ancestors: [P, 'o/r#7'] }), at(20)),
      row('twitter/bootstrap#2', snapshot('twitter/bootstrap#2', { issue: { repo: 'twbs/bootstrap' } }), at(5)),
      row(Q, null, null, { error: 'moved', checkedAt: at(3) }),
    ]
    const display = [P, C, Q, 'twitter/bootstrap#2']
    const first = JSON.stringify(build(rows, display, {}, 4))
    expect(JSON.stringify(build([...rows].reverse(), [...display].reverse(), {}, 4))).toBe(first)
    expect(JSON.stringify(build(rows, display, {}, 4))).toBe(first)
  })
})

describe('the node cap (§6)', () => {
  const single = (n: number, repo = 'o/r') => row(`${repo}#${n}`, snapshot(`${repo}#${n}`), at(10))
  const keysOf = (rows: IssueSnapshotRow[]) => rows.map((r) => `${r.repo}#${r.number}`)

  it('is 2,000 units, and the 2,001st single-node root is cut', () => {
    expect(MAX_GRAPH_NODES).toBe(2000)
    const rows = Array.from({ length: 2001 }, (_, i) => single(i + 1))
    const graph = build(rows, keysOf(rows))
    const ranked = keysOf(rows).sort()
    expect(graph.nodes).toHaveLength(2000)
    expect(rootKeys(graph)).toEqual(ranked.slice(0, 2000))
    expect(rootKeys(graph)).not.toContain(ranked[2000])
    expect(graph.truncated).toEqual({ roots: 1, ancestors: 0, children: 0, dependencies: 0, edges: 0 })
  })

  it('always fits 222 roots with distinct eight-level chains, and cuts whole chains only', () => {
    const rows = Array.from({ length: 300 }, (_, i) => {
      const repo = `chain/n${String(i).padStart(3, '0')}`
      const ancestors = Array.from({ length: 8 }, (_, level) => `${repo}#${level + 2}`)
      return row(`${repo}#1`, snapshot(`${repo}#1`, { ancestors, end: 'limit' }), at(10))
    })
    const graph = build(rows, keysOf(rows))
    expect(graph.roots).toHaveLength(222)
    expect(graph.nodes).toHaveLength(222 * 9)
    expect(graph.edges).toHaveLength(222 * 8)
    for (const root of graph.roots) {
      const repo = root.key.split('#')[0]!
      expect(graph.nodes.filter((n) => n.key.startsWith(`${repo}#`)), repo).toHaveLength(9)
    }
    expect(graph.truncated).toEqual({ roots: 78, ancestors: 78 * 8, children: 0, dependencies: 0, edges: 78 * 8 })
  })

  it('charges a shared ancestor once', () => {
    const chain = Array.from({ length: 8 }, (_, level) => `shared/c#${level + 1}`)
    const rows = Array.from({ length: 2100 }, (_, i) => {
      const key = `leaf/l#${i + 1}`
      return row(key, snapshot(key, { ancestors: chain, end: 'limit' }), at(10))
    })
    const graph = build(rows, keysOf(rows))
    // the first root pays 9 units, every later one only its own node
    expect(graph.roots).toHaveLength(1992)
    expect(graph.nodes).toHaveLength(2000)
    expect(graph.truncated).toEqual({ roots: 108, ancestors: 0, children: 0, dependencies: 0, edges: 108 })
  })

  it('ranks roots by refresh, then open/closed/unavailable, then local activity, then key', () => {
    const rows = [
      row('o/r#1', snapshot('o/r#1'), at(10)),
      row('o/r#2', snapshot('o/r#2', { issue: { state: 'CLOSED', state_reason: 'COMPLETED' } }), at(10)),
      row('o/r#3', null, null, { error: 'not-found', checkedAt: at(10) }),
      row('o/r#4', snapshot('o/r#4'), at(10)),
      row('o/r#5', snapshot('o/r#5'), at(10)),
      row('o/r#6', snapshot('o/r#6'), at(10)),
    ]
    const display = keysOf(rows)
    const opts = {
      displayOnly: ['o/r#1'],
      updatedAt: { 'o/r#1': at(50), 'o/r#2': at(50), 'o/r#3': at(50), 'o/r#4': at(20), 'o/r#5': at(30), 'o/r#6': at(30) },
    }
    // open first, by newest activity then key; then closed; then unavailable; the display-only root last of all
    const ranking = ['o/r#5', 'o/r#6', 'o/r#4', 'o/r#2', 'o/r#3', 'o/r#1']
    for (let units = 0; units <= ranking.length; units++) {
      const graph = build(rows, display, opts, units)
      expect([...rootKeys(graph)].sort(), `${units} units`).toEqual(ranking.slice(0, units).sort())
      expect(graph.truncated.roots).toBe(ranking.length - units)
    }
  })

  it('cuts a prefix of the ranking: a root that does not fit takes every lower root with it', () => {
    const chain = Array.from({ length: 8 }, (_, level) => `o/r#${level + 20}`)
    const rows = [
      row('o/r#1', snapshot('o/r#1'), at(10)),
      row('o/r#2', snapshot('o/r#2', { ancestors: chain, end: 'limit' }), at(10)),
      row('o/r#3', snapshot('o/r#3'), at(10)),
    ]
    const graph = build(rows, keysOf(rows), {}, 5)
    expect(rootKeys(graph)).toEqual(['o/r#1'])
    expect(nodeKeys(graph)).toEqual(['o/r#1'])
    expect(graph.truncated).toEqual({ roots: 2, ancestors: 8, children: 0, dependencies: 0, edges: 8 })
  })

  it('fills children round-robin in rank order and reports exactly what it cut', () => {
    const rows = [
      row(P, snapshot(P, { children: ['o/r#11', 'o/r#12', 'o/r#13'] }), at(10)),
      row(Q, snapshot(Q, { children: ['o/r#21', 'o/r#22'] }), at(10)),
    ]
    const graph = build(rows, [P, Q], { updatedAt: { [P]: at(20), [Q]: at(10) } }, 5)
    expect(nodeKeys(graph)).toEqual([P, 'o/r#11', 'o/r#12', Q, 'o/r#21'].sort())
    expect(graph.roots.map((r) => [r.key, r.children_omitted])).toEqual([[P, 1], [Q, 1]])
    expect(graph.truncated).toEqual({ roots: 0, ancestors: 0, children: 2, dependencies: 0, edges: 2 })
    // positions stay GitHub's, gaps and all
    expect(contains(graph).map((e) => [e.to, e.position])).toEqual([['o/r#11', 0], ['o/r#12', 1], ['o/r#21', 0]])
  })

  it('never charges for a child that is already kept', () => {
    const rows = [
      row(P, snapshot(P, { children: [C, 'o/r#4'] }), at(10)),
      row(C, snapshot(C, { ancestors: [P] }), at(10)),
    ]
    // P and C cost 2; the one remaining unit goes to #4 because C is already there
    const graph = build(rows, [P, C], {}, 3)
    expect(nodeKeys(graph)).toEqual([P, C, 'o/r#4'])
    expect(graph.truncated).toEqual({ roots: 0, ancestors: 0, children: 0, dependencies: 0, edges: 0 })
  })

  it('counts every omitted node once: an omitted root’s node is the root, then ancestors, then children', () => {
    // r1 (kept) lists x and y; r2 (omitted) is y itself, under ancestor z; r3 (omitted) has ancestor w
    const r1 = 'o/r#1'
    const x = 'o/r#2'
    const y = 'o/r#3'
    const z = 'o/r#4'
    const r3 = 'o/r#5'
    const w = 'o/r#6'
    const rows = [
      row(r1, snapshot(r1, { children: [x, y] }), at(10)),
      row(y, snapshot(y, { ancestors: [z] }), at(20)),
      row(r3, snapshot(r3, { ancestors: [w] }), at(10)),
    ]
    const graph = build(rows, [r1, y, r3], { updatedAt: { [r1]: at(30), [y]: at(20), [r3]: at(10) } }, 2)
    expect(nodeKeys(graph)).toEqual([r1, x])
    // y moved under z at t20, so r1 keeps only x; y is an omitted root, w and z omitted ancestors
    expect(graph.roots).toEqual([expect.objectContaining({ key: r1, children_omitted: 0 })])
    expect(graph.truncated).toEqual({ roots: 2, ancestors: 2, children: 0, dependencies: 0, edges: 2 })
  })

  it('charges a root with no node one unit for its entry', () => {
    const rows = [
      row('o/r#1', null, null, { error: 'not-found', checkedAt: at(10) }),
      row('o/r#2', null, null, { error: 'offline', checkedAt: at(10) }),
      row('o/r#3', snapshot('o/r#3'), at(10)),
    ]
    const graph = build(rows, keysOf(rows), {}, 2)
    // open #3 first, then the two without facts by key
    expect(rootKeys(graph)).toEqual(['o/r#1', 'o/r#3'])
    expect(graph.truncated.roots).toBe(1)
  })
})

// ── slice 2: GitHub dependencies (design 2026-10-21, §6) ────────────────────
//
// Observations are about a pair "A blocks B": A's `blocking` list and B's
// `blocked_by` list say so, and a COMPLETE list that omits the other end says
// it no longer holds. The newest decides, a negative at equal time.

const N = (n: number): string => `shariqh/agent-inbox#${n}`
const blocksEdges = (graph: IssueGraph): IssueBlocksEdge[] =>
  graph.edges.filter((edge): edge is IssueBlocksEdge => edge.kind === 'blocks')
const pairs = (graph: IssueGraph): string[] => blocksEdges(graph).map((edge) => `${edge.from} → ${edge.to}`)
const rootOf = (graph: IssueGraph, key: string) => graph.roots.find((r) => r.key === key)
/** A display root fetched at `t` whose dependency section reads as `section` (null: unknown). */
const withDeps = (key: string, t: string, section: IssueDependencies | null, opts: SnapshotOpts = {}) =>
  row(key, snapshot(key, opts), t, { dependencies: section })

describe('the §6.1 worked examples: "#119 blocks #121", row by row (slice 2)', () => {
  const B = N(119) // the blocker
  const D = N(121) // its dependent

  it('t20 #121 lists #119 in blocked_by → an edge', () => {
    const graph = build([withDeps(D, at(20), deps({ blockedBy: [B] }))], [D])
    expect(blocksEdges(graph)).toEqual([{ kind: 'blocks', from: B, to: D, observed_at: at(20) }])
    // the blocker is known from that list alone, which carries its facts
    expect(nodeKeys(graph)).toEqual([B, D])
    expect(node(graph, B)).toMatchObject({ title: `Title of ${B}`, observed_at: at(20) })
  })

  it('t20 #121’s complete blocked_by omits #119 · t10 #119 lists #121 in blocking → no edge: removed since', () => {
    const graph = build([withDeps(D, at(20), deps()), withDeps(B, at(10), deps({ blocking: [D] }))], [D, B])
    expect(pairs(graph)).toEqual([])
    expect(nodeKeys(graph)).toEqual([B, D])
  })

  it('t20 #119 lists #121 · t20 #121’s complete list omits #119 → no edge: a negative wins at equal t', () => {
    expect(pairs(build([withDeps(B, at(20), deps({ blocking: [D] })), withDeps(D, at(20), deps())], [B, D]))).toEqual([])
    // …whichever end holds the positive
    expect(pairs(build([withDeps(D, at(20), deps({ blockedBy: [B] })), withDeps(B, at(20), deps())], [B, D]))).toEqual([])
  })

  it('t20 #121’s list is truncated and omits #119 · t10 #119 lists #121 → an edge: a truncated list is no evidence of absence', () => {
    const graph = build([
      withDeps(D, at(20), deps({ blockedBy: [N(120)], blockedByTruncated: true })),
      withDeps(B, at(10), deps({ blocking: [D] })),
    ], [D, B])
    expect(blocksEdges(graph)).toEqual([
      { kind: 'blocks', from: B, to: D, observed_at: at(10) },
      { kind: 'blocks', from: N(120), to: D, observed_at: at(20) },
    ])
    // …whichever end's list is truncated
    const mirrored = build([
      withDeps(B, at(20), deps({ blocking: [N(122)], blockingTruncated: true })),
      withDeps(D, at(10), deps({ blockedBy: [B] })),
    ], [B, D])
    expect(blocksEdges(mirrored)).toEqual([
      { kind: 'blocks', from: B, to: D, observed_at: at(10) },
      { kind: 'blocks', from: B, to: N(122), observed_at: at(20) },
    ])
  })

  it('t20 #121’s section is unbound (a v1.4 refresh) · t10 #119 lists #121 → an edge, as of t10', () => {
    const graph = build([withDeps(D, at(20), null), withDeps(B, at(10), deps({ blocking: [D] }))], [D, B])
    expect(blocksEdges(graph)).toEqual([{ kind: 'blocks', from: B, to: D, observed_at: at(10) }])
    expect(rootOf(graph, D)?.dependencies).toBe('unknown')
  })

  it('#119 hard-failed at t15 · t10 #121 lists #119 → no edge; #119 unavailable', () => {
    const graph = build([
      withDeps(D, at(10), deps({ blockedBy: [facts(B, { title: 'Private title' })] })),
      row(B, null, null, { error: 'not-found', checkedAt: at(15) }),
    ], [D, B])
    expect(pairs(graph)).toEqual([])
    expect(node(graph, B)).toBeUndefined()
    expect(JSON.stringify(graph)).not.toContain('Private title')
    expect(rootOf(graph, B)).toMatchObject({ failure: 'hard', dependencies: null })
    expect(graph.truncated.edges).toBe(0)
  })
})

describe('dependency reconciliation (slice 2 §6.1)', () => {
  const B = N(119)
  const D = N(121)

  it('reconciles the live #117 family: #119 blocks seven siblings and #120 blocks #121, both directions agreeing', () => {
    // the live slice-2 answer for #117–#126, its sub-issues moved onto hN as today's document asks
    const body = JSON.parse(readFileSync(new URL('./fixtures/issue-relations-10-deps.json', import.meta.url), 'utf8')) as {
      data: Record<string, { issue?: Record<string, unknown> | null } | null>
    }
    for (const alias of Object.keys(body.data).filter((a) => /^r\d+$/.test(a))) {
      const { subIssuesSummary, subIssues, ...rest } = body.data[alias]!.issue!
      body.data[alias]!.issue = rest
      body.data[`h${alias.slice(1)}`] = { issue: { subIssuesSummary, subIssues } }
    }
    const keys = Array.from({ length: 10 }, (_, i) => ({ repo: 'shariqh/agent-inbox', number: 117 + i }))
    const { outcomes } = parseIssueBatch(JSON.stringify(body), keys)
    const rows = outcomes.map((outcome, i) => {
      if (!('snapshot' in outcome)) throw new Error(`#${keys[i]!.number} did not parse`)
      return row(N(keys[i]!.number), outcome.snapshot, at(10), { dependencies: outcome.dependencies })
    })
    const graph = build(rows, keys.map((k) => N(k.number)))
    expect(pairs(graph)).toEqual([
      ...[118, 120, 121, 122, 123, 124, 125].map((n) => `${B} → ${N(n)}`),
      `${N(120)} → ${D}`,
    ])
    expect(blocksEdges(graph).every((edge) => edge.observed_at === at(10) && !('cycle' in edge))).toBe(true)
    expect(node(graph, D)?.deps).toEqual({ blocked_by_open: 2, blocked_by_total: 2, blocking_open: 0, blocking_total: 0 })
    expect(node(graph, B)?.deps).toEqual({ blocked_by_open: 0, blocked_by_total: 0, blocking_open: 7, blocking_total: 7 })
    expect(graph.roots.every((r) => r.dependencies === 'ok' && r.dependencies_omitted === 0)).toBe(true)
    // the hierarchy is exactly what it was without dependencies
    const bare = build(rows.map((r) => ({ ...r, dependencies: null })), keys.map((k) => N(k.number)))
    expect(contains(graph)).toEqual(contains(bare))
    expect(graph.nodes.map(({ deps: _deps, ...rest }) => rest)).toEqual(bare.nodes)
  })

  it('the newest observation decides, whichever end made it', () => {
    const notAnyMore = withDeps(B, at(20), deps())
    expect(pairs(build([withDeps(D, at(10), deps({ blockedBy: [B] })), notAnyMore], [D, B]))).toEqual([])
    expect(blocksEdges(build([withDeps(D, at(30), deps({ blockedBy: [B] })), notAnyMore], [D, B])))
      .toEqual([{ kind: 'blocks', from: B, to: D, observed_at: at(30) }])
  })

  it('an unavailable section is no observation at all', () => {
    const graph = build([withDeps(D, at(20), { status: 'unavailable' }), withDeps(B, at(10), deps({ blocking: [D] }))], [D, B])
    expect(blocksEdges(graph)).toEqual([{ kind: 'blocks', from: B, to: D, observed_at: at(10) }])
    expect(rootOf(graph, D)?.dependencies).toBe('unavailable')
  })

  it('reads an issue’s dependencies even when GitHub could not return its hierarchy', () => {
    const graph = build([withDeps(D, at(10), deps({ blockedBy: [B] }), { unavailable: true })], [D])
    expect(pairs(graph)).toEqual([`${B} → ${D}`])
    expect(rootOf(graph, D)).toMatchObject({ hierarchy: 'unavailable', dependencies: 'ok' })
  })

  it('files a redirected root’s observations under its canonical key (S1 rule 8)', () => {
    const OLD = 'old/name#121'
    const redirected = (section: IssueDependencies) =>
      row(OLD, snapshot(OLD, { issue: { repo: 'shariqh/agent-inbox' } }), at(20), { dependencies: section })
    const agree = build([redirected(deps({ blockedBy: [B] })), withDeps(B, at(10), deps({ blocking: [D] }))], [OLD, B])
    expect(agree.aliases).toEqual({ [OLD]: D })
    expect(blocksEdges(agree)).toEqual([{ kind: 'blocks', from: B, to: D, observed_at: at(20) }])
    expect(nodeKeys(agree)).toEqual([B, D])
    expect(rootOf(agree, OLD)?.dependencies).toBe('ok')
    // the redirected root's newer complete list refutes #119's older claim about the canonical key
    expect(pairs(build([redirected(deps()), withDeps(B, at(10), deps({ blocking: [D] }))], [OLD, B]))).toEqual([])
  })

  it('drops a pair whose either end failed at or after the observation, and counts it again when observed after (S1 rule 6)', () => {
    // the dependent failed: #119's older list naming #121 says nothing any more, title included
    const failed = build([
      withDeps(B, at(10), deps({ blocking: [facts(D, { title: 'Private title' })] })),
      row(D, null, null, { error: 'forbidden', checkedAt: at(15) }),
    ], [B, D])
    expect(pairs(failed)).toEqual([])
    expect(failed.truncated.edges).toBe(0)
    expect(nodeKeys(failed)).toEqual([B])
    expect(JSON.stringify(failed)).not.toContain('Private title')
    // a failure at the very time of the observation drops it too
    expect(pairs(build([
      withDeps(B, at(15), deps({ blocking: [D] })), row(D, null, null, { error: 'not-found', checkedAt: at(15) }),
    ], [B, D]))).toEqual([])
    // every cached failure counts, displayed or not
    expect(pairs(build([
      withDeps(B, at(10), deps({ blocking: [D] })), row(D, null, null, { error: 'moved', checkedAt: at(15) }),
    ], [B]))).toEqual([])
    // an observation newer than the failure counts normally
    const after = build([
      withDeps(B, at(25), deps({ blocking: [facts(D, { title: 'Visible again' })] })),
      row(D, null, null, { error: 'not-found', checkedAt: at(20) }),
    ], [B, D])
    expect(blocksEdges(after)).toEqual([{ kind: 'blocks', from: B, to: D, observed_at: at(25) }])
    expect(node(after, D)).toMatchObject({ title: 'Visible again' })
    // a newer observation brings a failed end's facts back, but never a pair seen at or before
    // its failure, whichever end failed
    const revived = (failed: string, observer: string, section: IssueDependencies) => build([
      withDeps(observer, at(15), section),
      row(failed, null, null, { error: 'not-found', checkedAt: at(15) }),
      row(N(117), snapshot(N(117), { children: [failed] }), at(20)),
    ], [observer, failed, N(117)])
    for (const graph of [revived(B, D, deps({ blockedBy: [B] })), revived(D, B, deps({ blocking: [D] }))]) {
      expect(nodeKeys(graph)).toEqual([N(117), B, D])
      expect(pairs(graph)).toEqual([])
      expect(graph.truncated.edges).toBe(0)
    }
  })

  // Review of #271, F1: a requested key GitHub redirected keeps a section after
  // its canonical issue is refused. Rule 6 drops that section, so nothing is
  // known of its dependencies, though the issues it lists keep their facts.
  it('says nothing from a section rule 6 dropped: the root reports unknown, with no counts and no issue_rel fields', () => {
    const listed = facts('b/s#1', { title: 'Listed by a refused root' })
    const rows = (section: IssueDependencies) => [
      // the plan links the old name, which GitHub answered as a/r#1 at t10
      row('old/r#1', snapshot('a/r#1'), at(10), { dependencies: section }),
      // a/r#1 itself was refused at t15, and a fresher list keeps a node for it
      row('a/r#1', null, null, { error: 'not-found', checkedAt: at(15) }),
      row('b/s#2', snapshot('b/s#2', { children: ['a/r#1'] }), at(20)),
      row('b/s#1', null, null, { error: 'offline', checkedAt: at(5) }),
    ]
    const keys = ['old/r#1', 'b/s#2', 'b/s#1']
    for (const section of [deps({ blockedBy: [listed] }), { status: 'unavailable' } as const]) {
      const graph = build(rows(section), keys)
      expect(rootOf(graph, 'old/r#1')?.dependencies, section.status).toBe('unknown')
      expect(node(graph, 'a/r#1'), section.status).toMatchObject({ observed_at: at(20) })
      expect(node(graph, 'a/r#1'), section.status).not.toHaveProperty('deps')
      expect(pairs(graph), section.status).toEqual([])
      const rel = issueRelations(rows(section), keys, Date.parse(at(30))).get('old/r#1')
      expect(rel, section.status).not.toHaveProperty('waits_on_issues')
      expect(rel, section.status).not.toHaveProperty('unblocks')
    }
    // the issue the dropped list names is no refused issue: its facts stand, as a refused parent's children's do
    expect(node(build(rows(deps({ blockedBy: [listed] })), keys), 'b/s#1')).toMatchObject({ title: 'Listed by a refused root', observed_at: at(10) })
  })

  it('takes an issue’s counts from its freshest own section, however its rows sort', () => {
    // a/r#1 is cached under its own key (older) and under an old name GitHub redirects (newer)
    const graph = build([
      row('a/r#1', snapshot('a/r#1'), at(10), { dependencies: deps({ blockedByCounts: { open: 1, total: 1 } }) }),
      row('old/r#1', snapshot('a/r#1'), at(20), { dependencies: deps({ blockedByCounts: { open: 3, total: 4 } }) }),
    ], ['a/r#1', 'old/r#1'])
    expect(node(graph, 'a/r#1')?.deps).toEqual({ blocked_by_open: 3, blocked_by_total: 4, blocking_open: 0, blocking_total: 0 })
  })

  it('drops self-pairs', () => {
    const graph = build([withDeps(D, at(10), deps({ blockedBy: [D, B], blocking: [D] }))], [D])
    expect(blocksEdges(graph)).toEqual([{ kind: 'blocks', from: B, to: D, observed_at: at(10) }])
  })

  it('keeps circular dependencies as data: every edge inside a strongly connected component carries cycle', () => {
    const [A1, A2, A3, A4, A5] = [N(201), N(202), N(203), N(204), N(205)]
    // A1 ⇄ A2 and A2 → A3 → A4 → A2 share one component; A4 → A5 leaves it
    const section = depsOf([[A1, A2], [A2, A1], [A2, A3], [A3, A4], [A4, A2], [A4, A5]])
    const keys = [A1, A2, A3, A4, A5]
    const graph = build(keys.map((key) => withDeps(key, at(10), section(key))), keys)
    expect(blocksEdges(graph).map((edge) => [edge.from, edge.to, edge.cycle ?? false])).toEqual([
      [A1, A2, true], [A2, A1, true], [A2, A3, true], [A3, A4, true], [A4, A2, true], [A4, A5, false],
    ])
    // a cycle decides nothing else
    expect(graph.nodes.some((n) => n.conflict)).toBe(false)
  })

  it('marks no cycle where an issue is reached twice: a diamond is not circular', () => {
    const [X, Y, Z] = [N(301), N(302), N(303)]
    const section = depsOf([[X, Y], [X, Z], [Z, Y]])
    const keys = [X, Y, Z]
    const graph = build(keys.map((key) => withDeps(key, at(10), section(key))), keys)
    expect(pairs(graph)).toEqual([`${X} → ${Y}`, `${X} → ${Z}`, `${Z} → ${Y}`])
    expect(blocksEdges(graph).some((edge) => 'cycle' in edge)).toBe(false)
  })

  it('finds components without recursion: a 30,000-issue ring is one cycle, a 30,000-issue chain none', () => {
    const LENGTH = 30_000
    const keyOf = (i: number) => `ring/r#${i + 1}`
    const graphOf = (ring: boolean) => {
      const keys = Array.from({ length: LENGTH }, (_, i) => keyOf(i))
      const rows = keys.map((key, i) => withDeps(key, at(10), deps({
        blockedBy: i > 0 ? [keyOf(i - 1)] : ring ? [keyOf(LENGTH - 1)] : [],
        blocking: i < LENGTH - 1 ? [keyOf(i + 1)] : ring ? [keyOf(0)] : [],
      })))
      return build(rows, keys)
    }
    const ring = blocksEdges(graphOf(true))
    const chain = blocksEdges(graphOf(false))
    expect(ring.length).toBeGreaterThan(100)
    expect(ring.every((edge) => edge.cycle === true)).toBe(true)
    expect(chain.length).toBeGreaterThan(100)
    expect(chain.some((edge) => 'cycle' in edge)).toBe(false)
  })

  it('reads facts from dependency lists as listed facts: the freshest wins, and an issue’s own root at equal t (S1 rule 7)', () => {
    // #121 lists #150, and its key sorts first: only the source, not the observer, can let #150's own root win a tie
    const X = N(150)
    const titleAt = (listedAt: string) => node(build([
      row(X, snapshot(X, { issue: { title: 'own', state: 'OPEN' } }), at(10)),
      withDeps(D, listedAt, deps({ blocking: [facts(X, { title: 'listed', state: 'CLOSED', state_reason: 'COMPLETED' })] })),
    ], [X, D]), X)
    expect(titleAt(at(20))).toMatchObject({ title: 'listed', state: 'CLOSED', observed_at: at(20) })
    expect(titleAt(at(10))).toMatchObject({ title: 'own', state: 'OPEN', observed_at: at(10) })
  })

  it('carries counts only from an issue’s own bound, ok section, never inferred from other lists', () => {
    const graph = build([
      // #121 counts four blockers, three open, of which the token sees two
      withDeps(D, at(10), deps({ blockedBy: [B, N(120)], blockedByCounts: { open: 3, total: 4 }, blocking: [N(122)] })),
      withDeps(N(130), at(10), { status: 'unavailable' }),
      withDeps(N(131), at(10), null),
      row(N(132), null, null, { error: 'offline', checkedAt: at(10) }),
    ], [D, N(130), N(131), N(132)])
    expect(node(graph, D)?.deps).toEqual({ blocked_by_open: 3, blocked_by_total: 4, blocking_open: 1, blocking_total: 1 })
    for (const key of [B, N(120), N(122), N(130), N(131)]) expect(node(graph, key), key).not.toHaveProperty('deps')
    expect(graph.roots.map((r) => [r.key, r.dependencies])).toEqual([
      [D, 'ok'], [N(130), 'unavailable'], [N(131), 'unknown'], [N(132), null],
    ])
  })

  it('reads only display roots’ sections: any other cached row is inert', () => {
    const graph = build([withDeps(D, at(10), null), withDeps(N(140), at(20), deps({ blocking: [D] }))], [D])
    expect(pairs(graph)).toEqual([])
    expect(nodeKeys(graph)).toEqual([D])
  })

  it('is byte-identical however its inputs are ordered', () => {
    const section = depsOf([[B, D], [N(120), D], [D, N(122)], [N(122), N(120)], [N(120), N(122)]])
    const keys = [B, N(120), D, N(122)]
    const rows = keys.map((key, i) => withDeps(key, at(10 + i), section(key), { children: i === 0 ? [N(150)] : [] }))
    const first = JSON.stringify(build(rows, keys, {}, 4))
    expect(JSON.stringify(build([...rows].reverse(), [...keys].reverse(), {}, 4))).toBe(first)
    expect(JSON.parse(first).edges.some((edge: { kind: string }) => edge.kind === 'blocks')).toBe(true)
  })
})

describe('the node cap with dependency neighbours (slice 2 §6.3)', () => {
  it('fills children first, then dependency neighbours round-robin in rank order: blockers before dependents, by key', () => {
    const [P, Q] = [N(1), N(2)]
    const rows = [
      withDeps(P, at(10), deps({ blockedBy: [N(12), N(11)], blocking: [N(13)] }), { children: [N(31), N(32)] }),
      withDeps(Q, at(10), deps({ blockedBy: [N(21)], blocking: [N(23), N(22)] })),
    ]
    const ranked = { updatedAt: { [P]: at(20), [Q]: at(10) } }
    // two roots, two children, then four neighbours: P's two blockers, Q's blocker and its first dependent
    const graph = build(rows, [P, Q], ranked, 8)
    expect(nodeKeys(graph)).toEqual([P, N(11), N(12), Q, N(21), N(22), N(31), N(32)].sort())
    expect(pairs(graph)).toEqual([`${N(11)} → ${P}`, `${N(12)} → ${P}`, `${Q} → ${N(22)}`, `${N(21)} → ${Q}`])
    expect(graph.roots.map((r) => [r.key, r.children_omitted, r.dependencies_omitted])).toEqual([[P, 0, 1], [Q, 0, 1]])
    expect(graph.truncated).toEqual({ roots: 0, ancestors: 0, children: 0, dependencies: 2, edges: 2 })
    // children come first: one unit after them goes to P's first blocker
    const tight = build(rows, [P, Q], ranked, 5)
    expect(nodeKeys(tight)).toEqual([P, N(11), Q, N(31), N(32)].sort())
    expect(tight.roots.map((r) => [r.key, r.children_omitted, r.dependencies_omitted])).toEqual([[P, 0, 2], [Q, 0, 3]])
    expect(tight.truncated).toEqual({ roots: 0, ancestors: 0, children: 0, dependencies: 5, edges: 5 })
  })

  it('emits a blocks edge only when both of its nodes are emitted', () => {
    // R2 is cut as a root (its chain does not fit) but kept as R1's blocker; its own blocker Z and parent A are not
    const [R1, R2, A, Z] = [N(1), N(2), N(3), N(4)]
    const graph = build([
      withDeps(R1, at(10), deps({ blockedBy: [R2] })),
      withDeps(R2, at(10), deps({ blockedBy: [Z], blocking: [R1] }), { ancestors: [A] }),
    ], [R1, R2], { updatedAt: { [R1]: at(20), [R2]: at(10) } }, 2)
    expect(rootKeys(graph)).toEqual([R1])
    expect(nodeKeys(graph)).toEqual([R1, R2])
    expect(graph.edges).toEqual([{ kind: 'blocks', from: R2, to: R1, observed_at: at(10) }])
    expect(graph.roots[0]).toMatchObject({ dependencies_omitted: 0 })
    expect(graph.truncated).toEqual({ roots: 1, ancestors: 1, children: 0, dependencies: 1, edges: 2 })
  })

  it('then emits any other edge between two emitted nodes, by key, though no kept root owns it', () => {
    // R2 is cut as a root but kept as R1's blocker, as is X: X → R2 belongs to no kept root
    const [R1, R2, X] = [N(1), N(2), N(3)]
    const graph = build([
      withDeps(R1, at(10), deps({ blockedBy: [R2, X] })),
      withDeps(R2, at(10), deps({ blockedBy: [X], blocking: [R1] }), { ancestors: [N(4), N(5)] }),
    ], [R1, R2], { updatedAt: { [R1]: at(20), [R2]: at(10) } }, 3)
    expect(rootKeys(graph)).toEqual([R1])
    expect(nodeKeys(graph)).toEqual([R1, R2, X])
    expect(pairs(graph)).toEqual([`${R2} → ${R1}`, `${X} → ${R1}`, `${X} → ${R2}`])
    // only R2's chain is cut: two nodes and their two contains edges
    expect(graph.truncated).toEqual({ roots: 1, ancestors: 2, children: 0, dependencies: 0, edges: 2 })
  })

  it('caps edges at twice the node budget, round-robin in rank order, and counts every omitted one', () => {
    const keys = [N(1), N(2), N(3), N(4), N(5)]
    const [A, B, C, D, E] = keys as [string, string, string, string, string]
    // every issue blocks every other: one component, 20 edges among 5 nodes
    const section = depsOf(keys.flatMap((from) => keys.filter((to) => to !== from).map((to): [string, string] => [from, to])))
    const updatedAt = Object.fromEntries(keys.map((key, i) => [key, at(50 - i)]))
    const graph = build(keys.map((key) => withDeps(key, at(10), section(key))), keys, { updatedAt }, 5)
    expect(graph.nodes).toHaveLength(5)
    // round one takes each root's first blocker; round two its next, until 2 × 5
    expect(pairs(graph).sort()).toEqual([
      `${B} → ${A}`, `${A} → ${B}`, `${A} → ${C}`, `${A} → ${D}`, `${A} → ${E}`,
      `${C} → ${A}`, `${C} → ${B}`, `${B} → ${C}`, `${B} → ${D}`, `${B} → ${E}`,
    ].sort())
    expect(blocksEdges(graph).every((edge) => edge.cycle === true)).toBe(true)
    expect(graph.roots.map((r) => [r.key, r.dependencies_omitted])).toEqual([[A, 2], [B, 2], [C, 4], [D, 6], [E, 6]])
    expect(graph.truncated).toEqual({ roots: 0, ancestors: 0, children: 0, dependencies: 0, edges: 10 })
  })

  it('counts contains edges against the same budget: a response never holds more than twice its node budget in edges', () => {
    // four roots that all block each other (12 edges), the first with one child: 5 units, so 10 edges
    const keys = [N(1), N(2), N(3), N(4)]
    const section = depsOf(keys.flatMap((from) => keys.filter((to) => to !== from).map((to): [string, string] => [from, to])))
    const updatedAt = Object.fromEntries(keys.map((key, i) => [key, at(40 - i)]))
    const graph = build(keys.map((key, i) => withDeps(key, at(10), section(key), { children: i === 0 ? [N(31)] : [] })), keys, { updatedAt }, 5)
    expect(nodeKeys(graph)).toEqual([...keys, N(31)].sort())
    expect(contains(graph)).toHaveLength(1)
    expect(blocksEdges(graph)).toHaveLength(9)
    expect(graph.truncated).toEqual({ roots: 0, ancestors: 0, children: 0, dependencies: 0, edges: 3 })
    // each omitted edge joins two roots
    expect(graph.roots.reduce((sum, r) => sum + r.dependencies_omitted, 0)).toBe(6)
  })

  it('fits 2,000 nodes and 4,000 edges at the real cap, fast and byte-identical', () => {
    // 100 roots, each blocked by 50 of 1,900 other issues: 2,000 nodes and 5,000 edges
    const POOL = 1_900
    const rows = Array.from({ length: 100 }, (_, r) => withDeps(`root/r#${r + 1}`, at(10), deps({
      blockedBy: Array.from({ length: 50 }, (_, j) => `pool/p#${((r * 19 + j) % POOL) + 1}`),
    })))
    const keys = rows.map((r) => `${r.repo}#${r.number}`)
    const started = performance.now()
    const graph = build(rows, keys)
    const elapsed = performance.now() - started
    expect(graph.nodes).toHaveLength(MAX_GRAPH_NODES)
    expect(blocksEdges(graph)).toHaveLength(2 * MAX_GRAPH_NODES)
    // forty rounds of one blocker each: every root keeps its first forty
    expect(graph.roots.every((r) => r.dependencies_omitted === 10)).toBe(true)
    expect(graph.truncated).toEqual({ roots: 0, ancestors: 0, children: 0, dependencies: 0, edges: 1_000 })
    expect(elapsed).toBeLessThan(2_000)
    expect(JSON.stringify(build([...rows].reverse(), [...keys].reverse()))).toBe(JSON.stringify(graph))
  })
})

describe('the open neighbours the cap cut (#275)', () => {
  // P outranks Q. P lists #11 (open), #12 and #13 as blockers and #15 as a
  // dependent, the last three closed as P saw them at t10; Q, fetched at t20,
  // lists #13 as OPEN, the freshest fact about it. Three units keep P, Q and
  // P's first blocker, so the cap cuts #12, #13 and #15 from P and #13 from Q.
  const [P, Q] = [N(1), N(2)]
  const closed = (key: string) => facts(key, { state: 'CLOSED' })
  const rows = [
    withDeps(P, at(10), deps({ blockedBy: [N(11), closed(N(12)), closed(N(13))], blocking: [closed(N(15))] })),
    withDeps(Q, at(20), deps({ blockedBy: [N(13)] })),
  ]
  const keys = [P, Q]
  const ranked = { updatedAt: { [P]: at(20), [Q]: at(10) } }
  const omitted = (graph: IssueGraph) => graph.roots.map((r) => [r.key, r.dependencies_omitted, r.dependencies_omitted_open.blocked_by, r.dependencies_omitted_open.blocking])

  it('counts only the cut neighbours whose freshest state is OPEN, beside every cut entry', () => {
    const graph = build(rows, keys, ranked, 3)
    expect(nodeKeys(graph)).toEqual([P, Q, N(11)].sort())
    expect(pairs(graph)).toEqual([`${N(11)} → ${P}`])
    // #13 is open: Q's fresher list outranks P's older one, as node facts do
    expect(omitted(graph)).toEqual([[P, 3, 1, 0], [Q, 1, 1, 0]])
    // nothing cut, nothing open cut
    expect(omitted(build(rows, keys, ranked))).toEqual([[P, 0, 0, 0], [Q, 0, 0, 0]])
  })

  it('splits the open ones by direction: blockers as blocked_by, dependents as blocking', () => {
    // one unit after P: its first blocker; the other blocker and both dependents are cut
    const graph = build([withDeps(P, at(10), deps({ blockedBy: [N(11), N(12)], blocking: [N(21), closed(N(22)), N(23)] }))], [P], {}, 2)
    expect(omitted(graph)).toEqual([[P, 4, 1, 2]])
  })

  it('never counts a cut issue as open when its state is not OPEN', () => {
    // a state the build does not know (a newer GitHub value, say) is not open
    const odd = facts(N(12), { state: 'MERGED' as unknown as 'OPEN' })
    const graph = build([withDeps(P, at(10), deps({ blockedBy: [N(11), odd] }))], [P], {}, 2)
    expect(omitted(graph)).toEqual([[P, 1, 0, 0]])
  })

  it('counts nothing for an issue refused after it was listed: rule 6 drops the entry itself', () => {
    const refused = row(N(12), null, null, { error: 'not-found', checkedAt: at(20) })
    // rule 6 reads every cached hard failure, displayed or not
    const graph = build([withDeps(P, at(10), deps({ blockedBy: [N(11), N(12), N(13)] })), refused], [P], {}, 2)
    expect(nodeKeys(graph)).toEqual([P, N(11)].sort())
    expect(omitted(graph)).toEqual([[P, 1, 1, 0]])
  })

  it('stays byte-identical however its inputs are ordered, capped and uncapped', () => {
    for (const cap of [3, undefined]) {
      const first = JSON.stringify(build(rows, keys, ranked, cap))
      expect(JSON.stringify(build([...rows].reverse(), [...keys].reverse(), ranked, cap))).toBe(first)
    }
  })
})

describe('issue_rel: waits_on_issues and unblocks (slice 2 §6.4)', () => {
  const NOW = Date.parse(at(60))
  const T = N(121)
  const iso = (ms: number) => new Date(ms).toISOString()
  const WEEK = 7 * 24 * 60 * 60_000

  it('lists the open blockers that reconciled to an edge, sorted, and counts open dependents', () => {
    const closed = { state: 'CLOSED' as const, state_reason: 'COMPLETED' as const }
    const rel = issueRelations([
      withDeps(T, at(50), deps({
        blockedBy: [N(120), N(119), N(122), facts(N(118), closed)],
        blocking: [N(130), N(131), facts(N(132), closed)],
      })),
      // #122's own newer list says it no longer blocks #121; #131 closed since #121's list
      withDeps(N(122), at(55), deps()),
      row(N(131), snapshot(N(131), { issue: closed }), at(55)),
    ], [T, N(122), N(131)], NOW)
    expect(rel.get(T)).toEqual({
      key: T, children: { total: 0, done: 0 }, waits_on_issues: [N(119), N(120)], unblocks: 1,
      checked_at: at(50), stale: false, unavailable: false,
    })
    // known and empty is said so; unknown is not
    expect(rel.get(N(122))).toMatchObject({ waits_on_issues: [], unblocks: 0 })
    expect(rel.get(N(131))).not.toHaveProperty('waits_on_issues')
    expect(rel.get(N(131))).not.toHaveProperty('unblocks')
  })

  it.each([
    ['missing or unbound', null],
    ['unavailable', { status: 'unavailable' } as const],
  ])('omits both when the issue’s own section is %s, whatever other lists say', (_label, section) => {
    const rel = issueRelations([
      withDeps(T, at(50), section),
      withDeps(N(119), at(50), deps({ blocking: [T] })),
    ], [T, N(119)], NOW)
    expect(rel.get(T)).toEqual({ key: T, children: { total: 0, done: 0 }, checked_at: at(50), stale: false, unavailable: false })
    expect(rel.get(N(119))).toMatchObject({ waits_on_issues: [], unblocks: 1 })
  })

  it('omits both once the section is older than 7 days, and without a readable snapshot', () => {
    const at7 = issueRelations([withDeps(T, iso(NOW - WEEK), deps({ blockedBy: [N(119)] }))], [T], NOW).get(T)
    expect(at7).toMatchObject({ waits_on_issues: [N(119)], unblocks: 0, stale: true, unavailable: false })
    const older = issueRelations([withDeps(T, iso(NOW - WEEK - 1), deps({ blockedBy: [N(119)] }))], [T], NOW).get(T)
    expect(older).toEqual({ key: T, checked_at: iso(NOW - WEEK - 1), stale: true, unavailable: true })
    const failed = issueRelations([row(T, null, null, { error: 'not-found', checkedAt: at(50) })], [T], NOW).get(T)
    expect(failed).toEqual({ key: T, checked_at: at(50), stale: true, unavailable: true })
  })

  it('keeps them when only the hierarchy is unavailable: the two sections are separate', () => {
    const rel = issueRelations([withDeps(T, at(50), deps({ blockedBy: [N(119)] }), { unavailable: true })], [T], NOW).get(T)
    expect(rel).toEqual({ key: T, waits_on_issues: [N(119)], unblocks: 0, checked_at: at(50), stale: false, unavailable: true })
  })

  it('reads the whole reconciled graph: a response’s node cap never shortens the list', () => {
    // 1,996 linked issues fill the response budget; #121's 50 blockers would not fit in it
    const own = Array.from({ length: 50 }, (_, i) => `a/b#${i + 100}`)
    const others = Array.from({ length: 1_995 }, (_, i) => `z/z#${i + 1}`)
    const rows = [withDeps(T, at(50), deps({ blockedBy: own })), ...others.map((key) => row(key, snapshot(key), at(50)))]
    expect(build(rows, [T, ...others]).nodes.length).toBe(MAX_GRAPH_NODES)
    const rel = issueRelations(rows, [T, ...others], NOW)
    expect(rel.get(T)?.waits_on_issues).toEqual(own)
    expect(rel.size).toBe(1_996)
  })

  it('lists at most 50 blockers, the first by key, and only keys, never titles', () => {
    const own = Array.from({ length: 50 }, (_, i) => facts(`a/b#${i + 100}`, { title: `Secret ${i}` }))
    const others = Array.from({ length: 5 }, (_, i) => `a/a#${i + 1}`)
    const rel = issueRelations([
      withDeps(T, at(40), deps({ blockedBy: own })),
      ...others.map((key) => withDeps(key, at(50), deps({ blocking: [T] }))),
    ], [T, ...others], NOW).get(T)!
    expect(rel.waits_on_issues).toHaveLength(50)
    expect(rel.waits_on_issues).toEqual([...others, ...own.map((f) => `a/b#${f.number}`)].sort().slice(0, 50))
    expect(JSON.stringify(rel)).not.toMatch(/Secret|Title of/)
  })
})

describe('the issue graph enters the stdio MCP process only as pure modules', () => {
  const REPO = new URL('..', import.meta.url).pathname
  const read = (path: string) => readFileSync(join(REPO, path), 'utf8')
  const SPEC = /(?:from\s+|import\(\s*|require\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g

  // the transitive LOCAL import graph of an entry, as repo-relative paths
  function closure(entry: string): Set<string> {
    const seen = new Set<string>()
    const queue = [entry]
    while (queue.length) {
      const file = queue.pop()!
      if (seen.has(file)) continue
      seen.add(file)
      const dir = file.slice(0, file.lastIndexOf('/'))
      for (const match of read(file).matchAll(SPEC)) {
        const target = join(dir, match[1]!).replace(/\\/g, '/')
        const ts = target.replace(/\.js$/, '.ts')
        const resolved = ts.startsWith('src/') && readdirSync(join(REPO, 'src')).includes(ts.slice(4)) ? ts : target
        queue.push(resolved)
      }
    }
    return seen
  }

  it('only the MCP server reaches issue-graph and issue-key, for the titled board_get summary (§10, §11)', () => {
    const mcp = closure('src/mcp-server.ts')
    expect(mcp.has('src/issue-graph.ts')).toBe(true)
    expect(mcp.has('public/issue-key.js')).toBe(true)
    // …and nothing of the viewer process comes with them
    expect([...mcp].filter((f) => /viewer|poller|prstate/.test(f))).toEqual([])
    for (const entry of ['src/hook-cli.ts', 'src/watch-cli.ts']) {
      const graph = closure(entry)
      expect(graph.has('src/store.ts'), entry).toBe(true)
      expect([...graph].filter((f) => /issue-graph|issue-key|viewer/.test(f)), entry).toEqual([])
    }
  })

  it('the viewer process reaches both through its /api/issues route', () => {
    const graph = closure('src/viewer-server.ts')
    expect(graph.has('src/issue-graph.ts')).toBe(true)
    expect(graph.has('public/issue-key.js')).toBe(true)
  })

  it('both modules are pure: no Node built-in, no subprocess, no network, no clock', () => {
    for (const file of ['src/issue-graph.ts', 'public/issue-key.js']) {
      const code = read(file)
      expect(code, file).not.toMatch(/from\s+['"]node:|child_process|fetch\(|Date\.now|new Date\(/)
    }
    const imports = [...read('src/issue-graph.ts').matchAll(/^import .* from '([^']+)'$/gm)].map((m) => m[0])
    expect(imports.filter((line) => !line.startsWith('import type'))).toEqual([
      "import { issueKey } from '../public/issue-key.js'",
    ])
  })
})
