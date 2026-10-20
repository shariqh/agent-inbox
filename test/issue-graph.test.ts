// Issue #103, PR1a: the pure hierarchy reconciliation (§4.5) and the node cap
// (§6) behind GET /api/issues. Everything here is a pure function of
// listIssueSnapshots() rows and the display key set, so most cases build rows
// by hand; the revival case goes through the real store.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildIssueGraph, MAX_GRAPH_NODES } from '../src/issue-graph.js'
import type { IssueGraph } from '../src/issue-graph.js'
import { listIssueSnapshots, openDb, recordIssueFailure, upsertIssueSnapshot } from '../src/store.js'
import type { IssueSnapshot, IssueSnapshotRow } from '../src/store.js'
import { at, facts, keySets, row, snapshot } from './issue-fixtures.js'

const parentOf = (graph: IssueGraph, key: string): string | null =>
  graph.edges.find((edge) => edge.to === key)?.from ?? null
const childrenOf = (graph: IssueGraph, key: string): string[] =>
  graph.edges.filter((edge) => edge.from === key).sort((a, b) => a.position - b.position).map((edge) => edge.to)
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
      truncated: { roots: 0, ancestors: 0, children: 0, edges: 0 },
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
      error: null, failure: null, children_omitted: 0,
    })
    expect(graph.aliases).toEqual({})
    expect(graph.truncated).toEqual({ roots: 0, ancestors: 0, children: 0, edges: 0 })
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
    expect(graph.edges.filter((e) => e.from === P).map((e) => [e.to, e.position])).toEqual([
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
    expect(graph.truncated).toEqual({ roots: 1, ancestors: 2, children: 0, edges: 2 })
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
      key: K, refresh: true, fetched_at: null, checked_at: at(20), error: 'not-found', failure: 'hard', children_omitted: 0,
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
      dir = mkdtempSync(join(tmpdir(), 'issue-graph-'))
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
      { key: P, refresh: true, fetched_at: at(10), checked_at: at(40), error: 'rate-limit', failure: 'soft', children_omitted: 0 },
      { key: Q, refresh: false, fetched_at: null, checked_at: at(40), error: 'no-gh', failure: 'soft', children_omitted: 0 },
    ])
    expect(nodeKeys(graph)).toEqual([P])
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
    expect(graph.truncated).toEqual({ roots: 1, ancestors: 0, children: 0, edges: 0 })
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
    expect(graph.truncated).toEqual({ roots: 78, ancestors: 78 * 8, children: 0, edges: 78 * 8 })
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
    expect(graph.truncated).toEqual({ roots: 108, ancestors: 0, children: 0, edges: 108 })
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
    expect(graph.truncated).toEqual({ roots: 2, ancestors: 8, children: 0, edges: 8 })
  })

  it('fills children round-robin in rank order and reports exactly what it cut', () => {
    const rows = [
      row(P, snapshot(P, { children: ['o/r#11', 'o/r#12', 'o/r#13'] }), at(10)),
      row(Q, snapshot(Q, { children: ['o/r#21', 'o/r#22'] }), at(10)),
    ]
    const graph = build(rows, [P, Q], { updatedAt: { [P]: at(20), [Q]: at(10) } }, 5)
    expect(nodeKeys(graph)).toEqual([P, 'o/r#11', 'o/r#12', Q, 'o/r#21'].sort())
    expect(graph.roots.map((r) => [r.key, r.children_omitted])).toEqual([[P, 1], [Q, 1]])
    expect(graph.truncated).toEqual({ roots: 0, ancestors: 0, children: 2, edges: 2 })
    // positions stay GitHub's, gaps and all
    expect(graph.edges.map((e) => [e.to, e.position])).toEqual([['o/r#11', 0], ['o/r#12', 1], ['o/r#21', 0]])
  })

  it('never charges for a child that is already kept', () => {
    const rows = [
      row(P, snapshot(P, { children: [C, 'o/r#4'] }), at(10)),
      row(C, snapshot(C, { ancestors: [P] }), at(10)),
    ]
    // P and C cost 2; the one remaining unit goes to #4 because C is already there
    const graph = build(rows, [P, C], {}, 3)
    expect(nodeKeys(graph)).toEqual([P, C, 'o/r#4'])
    expect(graph.truncated).toEqual({ roots: 0, ancestors: 0, children: 0, edges: 0 })
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
    expect(graph.truncated).toEqual({ roots: 2, ancestors: 2, children: 0, edges: 2 })
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

describe('the issue graph stays out of the stdio MCP process', () => {
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

  it('no stdio entry reaches issue-graph or issue-key, directly or transitively', () => {
    // PR2's titled board_get summary is the planned, deliberate exception (§10, §11)
    for (const entry of ['src/mcp-server.ts', 'src/hook-cli.ts', 'src/watch-cli.ts']) {
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
