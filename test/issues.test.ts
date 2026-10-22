// Issue #103, PR3: the browser's sub-issue view model (design §7). Pure: a
// function of one /api/issues body, the local entities and the attention set
// the render already computed. The graphs here come from the real pure builder
// over fixture rows, so every case is a body the viewer could actually serve.
import { describe, expect, it } from 'vitest'
import { buildIssueView, HIDDEN_AFTER_MS, planGroups, rowParentRuns, STALE_AFTER_MS } from '../public/issues.js'
import type { IssueRelation, IssueViewItem, IssueViewPlan, IssueViewRow, IssueWaitEntry } from '../public/issues.js'
import { indexLinks, issueRelationsHtml } from '../public/source.js'
import type { CachedLink } from '../public/source.js'
import { buildIssueGraph, issueRelations } from '../src/issue-graph.js'
import type { IssueSnapshotRow } from '../src/store.js'
import { at, deps, depsOf, facts, keySets, row, snapshot } from './issue-fixtures.js'
import type { DepsOpts } from './issue-fixtures.js'

const REPO = 'shariqh/agent-inbox'
const K = (n: number): string => `${REPO}#${n}`
const T = Date.parse(at(0))
const FAMILY = [118, 119, 120, 121, 122, 123, 124, 125, 126, 127]
// GitHub's order is not number order: the view must keep it.
const GITHUB_ORDER = [121, 118, 119, 120, 122, 123, 124, 125, 126, 127]

function graphOf(rows: IssueSnapshotRow[], opts: { maxUnits?: number } = {}) {
  return buildIssueGraph(rows, keySets(rows.map((r) => `${r.repo}#${r.number}`)), opts)
}

/** #117 with its ten children in GitHub's order (#118 closed as completed, #119 not planned), and #120 below it. */
function family(fetchedAt = at(0)) {
  const children = GITHUB_ORDER.map((n) => facts(K(n), n === 118
    ? { state: 'CLOSED', state_reason: 'COMPLETED' }
    : n === 119 ? { state: 'CLOSED', state_reason: 'NOT_PLANNED' } : {}))
  return [
    row(K(117), snapshot(K(117), { issue: { title: 'Integrate Agent Inbox with Agent Host Protocol' }, children, completed: 1 }), fetchedAt),
    row(K(120), snapshot(K(120), {
      ancestors: [facts(K(117), { title: 'Integrate Agent Inbox with Agent Host Protocol', children_total: 10, children_completed: 1 })],
    }), fetchedAt),
  ]
}

const relation = (view: ReturnType<typeof buildIssueView>, key: string): IssueRelation => {
  const found = view.relations.get(key)
  if (!found) throw new Error(`no relation for ${key}`)
  return found
}

describe('breadcrumbs, child order and progress (§7.1, §7.2)', () => {
  it('gives a child its exact parent and a parent its children in GitHub order, with progress', () => {
    const view = buildIssueView(graphOf(family()), { nowMs: T + 3 * 60_000 })
    const child = relation(view, K(120))
    expect(child.freshness).toBe('fresh')
    expect(child.node?.key).toBe(K(120))
    expect(child.trail.map((n) => n.key)).toEqual([K(117)])
    expect(child.trail[0]).toMatchObject({ title: 'Integrate Agent Inbox with Agent Host Protocol', total: 10, completed: 1 })

    const parent = relation(view, K(117))
    expect(parent.trail).toEqual([])
    expect(parent.node).toMatchObject({ total: 10, completed: 1 })
    expect(parent.children.map((c) => c.node.number)).toEqual(GITHUB_ORDER)
    const marks = Object.fromEntries(parent.children.map((c) => [c.node.number, c.node.mark]))
    expect(marks).toMatchObject({ 118: 'completed', 119: 'not planned', 120: 'open' })
    expect(parent.more).toEqual({ notVisible: 0, onGitHub: 0, notShown: 0 })
  })

  it('walks a deep trail top first and stops at eight levels', () => {
    const ancestors = Array.from({ length: 8 }, (_, i) => K(200 + i)) // [0] is the immediate parent
    const view = buildIssueView(graphOf([row(K(199), snapshot(K(199), { ancestors, end: 'limit' }), at(0))]), { nowMs: T })
    const trail = relation(view, K(199)).trail.map((n) => n.key)
    expect(trail).toEqual([...ancestors].reverse())
    expect(trail).toHaveLength(8)
  })

  it('marks every closed state and keeps a reopened issue open', () => {
    const states = [
      [301, { state: 'CLOSED', state_reason: 'DUPLICATE' }, 'duplicate'],
      [302, { state: 'CLOSED', state_reason: null }, 'closed'],
      [303, { state: 'OPEN', state_reason: 'REOPENED' }, 'open'],
    ] as const
    const view = buildIssueView(graphOf([row(K(300), snapshot(K(300), {
      children: states.map(([n, extra]) => facts(K(n), { ...extra })),
    }), at(0))]), { nowMs: T })
    expect(relation(view, K(300)).children.map((c) => c.node.mark)).toEqual(states.map(([, , mark]) => mark))
  })

  it('counts the children it cannot list: hidden from the account, beyond the page, and cut by the node cap', () => {
    const listed = [K(401), K(402)]
    const hidden = buildIssueView(graphOf([row(K(400), snapshot(K(400), { children: listed, total: 5, completed: 0 }), at(0))]), { nowMs: T })
    expect(relation(hidden, K(400)).more).toEqual({ notVisible: 3, onGitHub: 0, notShown: 0 })

    const many = Array.from({ length: 100 }, (_, i) => K(1000 + i))
    const beyond = buildIssueView(graphOf([row(K(999), snapshot(K(999), { children: many, total: 104, completed: 0, truncated: true }), at(0))]), { nowMs: T })
    expect(relation(beyond, K(999)).more).toEqual({ notVisible: 0, onGitHub: 4, notShown: 0 })

    // a budget of 3 units keeps the root and two of its five children
    const capped = buildIssueView(graphOf([row(K(500), snapshot(K(500), {
      children: [K(501), K(502), K(503), K(504), K(505)],
    }), at(0))], { maxUnits: 3 }), { nowMs: T })
    const rel = relation(capped, K(500))
    expect(rel.children.map((c) => c.node.key)).toEqual([K(501), K(502)])
    expect(rel.more).toEqual({ notVisible: 0, onGitHub: 0, notShown: 3 })
  })

  it('files a redirected repository under the key the entity asked for', () => {
    const requested = 'twitter/bootstrap#2'
    const view = buildIssueView(graphOf([
      row(requested, snapshot('twbs/bootstrap#2', { ancestors: [facts('twbs/bootstrap#1')] }), at(0)),
    ]), { nowMs: T })
    const rel = relation(view, requested)
    expect(rel.node?.key).toBe('twbs/bootstrap#2')
    expect(rel.node?.repo).toBe('twbs/bootstrap')
    expect(rel.trail.map((n) => n.key)).toEqual(['twbs/bootstrap#1'])
  })
})

describe('freshness and unavailable states (§5.8)', () => {
  const at120 = (nowMs: number, extra: Parameters<typeof row>[3] = {}) =>
    buildIssueView(graphOf([row(K(120), snapshot(K(120), { ancestors: [K(117)] }), at(0), extra)]), { nowMs }).relations.get(K(120))

  it('is fresh for 30 minutes, stale until 7 days, then hidden', () => {
    expect(STALE_AFTER_MS).toBe(30 * 60_000)
    expect(HIDDEN_AFTER_MS).toBe(7 * 24 * 60 * 60_000)
    expect(at120(T)?.freshness).toBe('fresh')
    expect(at120(T + STALE_AFTER_MS)?.freshness).toBe('fresh')
    expect(at120(T + STALE_AFTER_MS + 1)?.freshness).toBe('stale')
    expect(at120(T + HIDDEN_AFTER_MS)?.freshness).toBe('stale')
    const hidden = at120(T + HIDDEN_AFTER_MS + 1)!
    expect(hidden.freshness).toBe('hidden')
    // hidden keeps nothing to draw: no node, trail or children, only its age
    expect(hidden).toMatchObject({ node: null, trail: [], children: [], fetchedAt: at(0) })
  })

  it('ages a soft failure from its last success and carries the reason', () => {
    const rel = at120(T + 2 * 60 * 60_000, { error: 'auth', checkedAt: at(90) })!
    expect(rel).toMatchObject({ freshness: 'stale', error: 'auth', fetchedAt: at(0) })
    expect(rel.trail.map((n) => n.key)).toEqual([K(117)])
  })

  it('says unavailable after a hard failure, with no node, title or trail', () => {
    for (const error of ['not-found', 'forbidden', 'moved'] as const) {
      const view = buildIssueView(graphOf([row(K(130), null, null, { error, checkedAt: at(1) })]), { nowMs: T })
      expect(relation(view, K(130))).toEqual({
        key: K(130), freshness: 'unavailable', error, fetchedAt: null, node: null, trail: [], children: [],
        more: { notVisible: 0, onGitHub: 0, notShown: 0 }, dependencies: null,
      })
    }
  })

  it('knows nothing from a soft failure before any success, or from a root the node cap omitted', () => {
    const soft = buildIssueView(graphOf([row(K(131), null, null, { error: 'offline', checkedAt: at(1) })]), { nowMs: T })
    expect(soft.relations.has(K(131))).toBe(false)
    const capped = buildIssueView(graphOf(family(), { maxUnits: 1 }), { nowMs: T })
    expect([...capped.relations.keys()]).toEqual([K(117)])
  })

  // Review round 1. GitHub returned the issue but failed on its parent or
  // sub-issues (§5.7), so nothing is known about its relationships: draw it
  // like an expired one, even where another issue's list still names a parent.
  it('draws nothing for an issue GitHub returned without its hierarchy, however old', () => {
    const rows = (nowMs: number) => buildIssueView(graphOf([
      row(K(117), snapshot(K(117), { children: [K(120)] }), at(0)),
      row(K(120), snapshot(K(120), { unavailable: true }), at(0), { error: 'offline', checkedAt: at(5) }),
    ]), { nowMs }).relations.get(K(120))
    for (const nowMs of [T, T + 2 * 60 * 60_000, T + HIDDEN_AFTER_MS + 1]) {
      expect(rows(nowMs)).toEqual({
        key: K(120), freshness: 'no-hierarchy', error: 'offline', fetchedAt: at(0), node: null, trail: [], children: [],
        more: { notVisible: 0, onGitHub: 0, notShown: 0 }, dependencies: null,
      })
    }
    // a cached answer this build cannot read (another version's, say) knows nothing
    const unreadable = { ...row(K(120), null, null), fetched_at: at(0) }
    const graph = graphOf([row(K(117), snapshot(K(117), { children: [K(120)] }), at(0)), unreadable])
    expect(graph.roots.find((r) => r.key === K(120))?.hierarchy).toBeNull()
    expect(buildIssueView(graph, { nowMs: T }).relations.has(K(120))).toBe(false)
  })

  it('agrees with the agent\'s issue_rel on whether there are relationships to draw', () => {
    const parent = row(K(117), snapshot(K(117), { children: [K(120)] }), at(0))
    const cases: Array<[string, IssueSnapshotRow, number, boolean]> = [
      ['fresh', row(K(120), snapshot(K(120), { ancestors: [K(117)] }), at(0)), T, true],
      ['stale', row(K(120), snapshot(K(120), { ancestors: [K(117)] }), at(0), { error: 'auth', checkedAt: at(90) }), T + 2 * 60 * 60_000, true],
      ['expired', row(K(120), snapshot(K(120), { ancestors: [K(117)] }), at(0)), T + HIDDEN_AFTER_MS + 1, false],
      ['no hierarchy', row(K(120), snapshot(K(120), { unavailable: true }), at(0)), T, false],
      ['unreadable', { ...row(K(120), null, null), fetched_at: at(0) }, T, false],
      ['hard failure', row(K(120), null, null, { error: 'forbidden', checkedAt: at(1) }), T, false],
      ['soft failure before any success', row(K(120), null, null, { error: 'offline', checkedAt: at(1) }), T, false],
    ]
    for (const [label, child, nowMs, draws] of cases) {
      const keys = [K(117), K(120)]
      const agent = issueRelations([parent, child], keys, nowMs).get(K(120))
      const view = buildIssueView(buildIssueGraph([parent, child], keySets(keys)), { nowMs }).relations.get(K(120))
      expect(Boolean(agent && !agent.unavailable), `${label}: issue_rel`).toBe(draws)
      expect(Boolean(view?.node && (view.freshness === 'fresh' || view.freshness === 'stale')), `${label}: view`).toBe(draws)
    }
  })

  it('treats a missing or malformed graph as no graph', () => {
    for (const graph of [null, undefined, 'nope', [], { version: 2, nodes: [], edges: [], roots: [], aliases: {} }]) {
      expect(buildIssueView(graph, { nowMs: T }).relations.size).toBe(0)
    }
    // a node whose parts disagree with its key, or whose repository is not a
    // slug, is dropped rather than drawn
    const graph = graphOf(family())
    const forged = {
      ...graph,
      nodes: graph.nodes.map((n) => (n.key === K(117) ? { ...n, repo: 'javascript:alert(1)' } : n)),
    }
    expect(relation(buildIssueView(forged, { nowMs: T }), K(120)).trail).toEqual([])
  })
})

describe('Agent Inbox activity (§7.3)', () => {
  const SCOPE = { project: 'agent-inbox', agent: 'claude-code' }
  const stamp = (minute: number) => at(minute)
  const item = (id: string, issue: number, extra: Partial<IssueViewItem> = {}): IssueViewItem & { created_at: string } => ({
    id, ...SCOPE, kind: 'question', title: `Item ${id}`, status: 'open', repo: REPO, stream: `${issue}-x`,
    issue_ref: issue, created_at: stamp(1), updated_at: stamp(1), ...extra,
  })
  const plan = (id: string, rows: IssueViewRow[], extra: Partial<IssueViewPlan> = {}): IssueViewPlan => ({
    id, ...SCOPE, title: `Plan ${id}`, status: 'active', repo: REPO, stream: 'main', issue_ref: null,
    updated_at: stamp(1), rows, ...extra,
  })
  const linked = (id: string, issue: number, extra: Partial<IssueViewRow> = {}): IssueViewRow => ({
    id, label: `Row ${id}`, status: 'tracked', issue_repo: REPO, issue_number: issue, updated_at: stamp(1), ...extra,
  })
  const labels = (view: ReturnType<typeof buildIssueView>) =>
    Object.fromEntries(relation(view, K(117)).children.map((c) => [c.node.number, c.activity]))

  it('reads the attention set, then local work, then finished work, and says when nothing links a child', () => {
    const question = item('q118', 118, { updated_at: stamp(2) })
    const blocked = linked('r126', 126, { status: 'blocked' })
    const unlinked: IssueViewRow = { id: 'r-unlinked', label: 'Needs a decision', status: 'blocked', updated_at: stamp(1) }
    const pinned = plan('p127', [unlinked], { issue_pin_repo: REPO, issue_pin_number: 127 })
    const active = plan('p-main', [
      linked('r119-new', 119, { updated_at: stamp(5) }),
      linked('r122', 122, { status: 'done' }),
      linked('r123', 123, { status: 'na' }),
      blocked,
    ])
    const archived = plan('p-old', [linked('r124', 124, { status: 'tracked' })], {
      status: 'archived', issue_pin_repo: REPO, issue_pin_number: 125,
    })
    const pinPlan = plan('p121', [], { issue_pin_repo: REPO, issue_pin_number: 121, title: 'AHP adapter', updated_at: stamp(3) })
    const items = [
      question,
      item('q119-old', 119, { updated_at: stamp(4) }),
      item('closed-120', 120, { status: 'resolved' }), // History links nothing
    ]
    const attention = [
      { kind: 'item' as const, item: question, liveness: 'waiting' as const },
      { kind: 'row' as const, row: blocked, board: active },
      { kind: 'row' as const, row: unlinked, board: pinned },
    ]
    const view = buildIssueView(graphOf(family()), {
      items, boards: [active, pinned, pinPlan], archived: [archived], attention, nowMs: T,
    })
    const by = labels(view)
    expect(by[118]).toEqual({ kind: 'waiting', label: 'Waiting on you', target: { id: 'q118' } })
    expect(by[126]).toEqual({ kind: 'waiting', label: 'Waiting on you', target: { id: 'p-main', rowId: 'r126' } })
    // a blocked row with no link of its own waits under its plan's pinned issue
    expect(by[127]).toEqual({ kind: 'waiting', label: 'Waiting on you', target: { id: 'p127', rowId: 'r-unlinked' } })
    // the most recently updated of an open item, an active plan or a not-done row
    expect(by[119]).toEqual({ kind: 'active', label: 'Active · claude-code · Row r119-new', target: { id: 'p-main', rowId: 'r119-new' } })
    expect(by[121]).toEqual({ kind: 'active', label: 'Active · claude-code · AHP adapter', target: { id: 'p121' } })
    expect(by[122]).toEqual({ kind: 'done', label: 'Done here', target: { id: 'p-main', rowId: 'r122' } })
    expect(by[123]).toMatchObject({ kind: 'done', label: 'Done here' })
    // an archived plan and its rows are finished work here, whatever the row says
    expect(by[124]).toMatchObject({ kind: 'done', target: { id: 'p-old', rowId: 'r124' } })
    expect(by[125]).toMatchObject({ kind: 'done', target: { id: 'p-old' } })
    expect(by[120]).toEqual({ kind: 'none', label: 'None here', target: null })
  })

  it('counts only certain links, and maps a redirected link to its canonical child', () => {
    // a PR row with no bound closing record names #119 for display only
    const legacy: CachedLink = {
      repo: REPO, branch: 'feature', head_repo: REPO, provider: 'github', pr_number: 9, pr_url: null, pr_title: null,
      pr_state: 'OPEN', pr_head_sha: null, pr_draft: false, review_decision: null, checks: null, issue_number: 119,
      issue_url: null, issue_title: null, preview_url: null, preview_environment: null, preview_deployment_id: null,
      preview_updated_at: null, preview_error: null, tldr: null, fetched_at: at(0), checked_at: at(0), error: null, revision: 1,
    }
    const rows = [
      row('twbs/bootstrap#1', snapshot('twbs/bootstrap#1', { children: ['twbs/bootstrap#2'] }), at(0)),
      row('twitter/bootstrap#2', snapshot('twbs/bootstrap#2', { ancestors: ['twbs/bootstrap#1'] }), at(0)),
      ...family(),
    ]
    const view = buildIssueView(graphOf(rows), {
      items: [
        { ...item('legacy', 0), stream: 'feature', issue_ref: null },
        { ...item('old-name', 2), repo: 'twitter/bootstrap', stream: '2-x' },
      ],
      links: indexLinks([legacy]),
      nowMs: T,
    })
    expect(labels(view)[119]).toMatchObject({ kind: 'none' })
    expect(relation(view, 'twbs/bootstrap#1').children[0]?.activity).toMatchObject({ kind: 'active', target: { id: 'old-name' } })
  })

  it('never writes to what it reads', () => {
    const deepFreeze = <T>(value: T): T => {
      if (value && typeof value === 'object') {
        for (const child of Object.values(value)) deepFreeze(child)
        Object.freeze(value)
      }
      return value
    }
    const question = item('q120', 120)
    const input = deepFreeze({
      graph: graphOf(family()),
      items: [question],
      attention: [{ kind: 'item' as const, item: question, liveness: 'waiting' as const }],
    })
    const view = buildIssueView(input.graph, { items: input.items, attention: input.attention, nowMs: T })
    expect(labels(view)[120]).toMatchObject({ kind: 'waiting' })
  })
})

// Slice 2 §7: opt-in grouping of active plans under their GitHub parent. Keys
// and order only; the DOM half is test/dom/plan-grouping.test.ts.
describe('plan grouping keys (slice 2 §7)', () => {
  const plan = (id: string, pin: number | null, extra: Partial<IssueViewPlan> = {}): IssueViewPlan => ({
    id, project: 'agent-inbox', agent: 'copilot', title: `Plan ${id}`, status: 'active', repo: REPO, stream: 'main',
    issue_ref: null, ...(pin === null ? {} : { issue_pin_repo: REPO, issue_pin_number: pin }), rows: [], ...extra,
  })
  const parent117 = facts(K(117), { title: 'Umbrella', children_total: 10, children_completed: 1 })
  /** #117 listing its children in GitHub's order, and each listed child cached under it. */
  const cached = (kids: number[], fetchedAt = at(0)) => [
    family(fetchedAt)[0]!,
    ...kids.map((n) => row(K(n), snapshot(K(n), { ancestors: [parent117] }), fetchedAt)),
  ]
  const view = (rows: IssueSnapshotRow[], nowMs = T, opts: { maxUnits?: number } = {}) =>
    buildIssueView(graphOf(rows, opts), { nowMs })
  const ids = (plans: readonly IssueViewPlan[]) => plans.map((p) => p.id)

  it('gathers the umbrella, then members in GitHub child order, at the first member\'s place', () => {
    // today's order puts #120 before #121; GitHub lists #121 first
    const plans = [plan('a', null), plan('p120', 120), plan('x', null), plan('umb', 117), plan('p121', 121)]
    const out = planGroups(plans, view(cached([120, 121])), null)
    expect(ids(out.plans)).toEqual(['a', 'umb', 'p121', 'p120', 'x'])
    const group = out.groupOf.get('umb')!
    expect(group).toMatchObject({ project: 'agent-inbox', size: 3, stale: false })
    expect(group.parent).toMatchObject({ key: K(117), title: 'Integrate Agent Inbox with Agent Host Protocol', total: 10, completed: 1 })
    expect(out.groupOf.get('p120')).toBe(group)
    expect(out.groupOf.get('p121')).toBe(group)
    expect(out.groupOf.has('a')).toBe(false)
    expect(out.groupOf.has('x')).toBe(false)
  })

  it('needs two members: a plan alone under its parent, or an umbrella alone, stays flat', () => {
    const alone = planGroups([plan('a', null), plan('p120', 120)], view(cached([120])), null)
    expect(ids(alone.plans)).toEqual(['a', 'p120'])
    expect(alone.groupOf.size).toBe(0)
    const umbrellaOnly = planGroups([plan('umb', 117), plan('a', null)], view(cached([120])), null)
    expect(umbrellaOnly.groupOf.size).toBe(0)
    // the umbrella and one child are two members
    const pair = planGroups([plan('p120', 120), plan('a', null), plan('umb', 117)], view(cached([120])), null)
    expect(ids(pair.plans)).toEqual(['umb', 'p120', 'a'])
    expect(pair.groupOf.get('umb')?.size).toBe(2)
  })

  it('never merges plans from different Agent Inbox projects under one parent', () => {
    const other = { project: 'oris' }
    const split = planGroups([plan('p120', 120), plan('p121', 121, other)], view(cached([120, 121])), null)
    expect(split.groupOf.size).toBe(0)
    const both = planGroups([
      plan('p120', 120), plan('o120', 120, other), plan('p121', 121), plan('o121', 121, other),
    ], view(cached([120, 121])), null)
    expect(ids(both.plans)).toEqual(['p121', 'p120', 'o121', 'o120'])
    const mine = both.groupOf.get('p120')!
    const theirs = both.groupOf.get('o120')!
    expect(mine).not.toBe(theirs)
    expect(mine.key).not.toBe(theirs.key)
    expect([mine.project, theirs.project]).toEqual(['agent-inbox', 'oris'])
  })

  it('keeps today\'s order for members GitHub did not order', () => {
    // #117 itself is not cached, so no list says where its children sit
    const rows = [120, 121, 122].map((n) => row(K(n), snapshot(K(n), { ancestors: [parent117] }), at(0)))
    const out = planGroups([plan('p122', 122), plan('p120', 120), plan('p121', 121)], view(rows), null)
    expect(ids(out.plans)).toEqual(['p122', 'p120', 'p121'])
    expect(out.groupOf.get('p122')?.size).toBe(3)
  })

  it('groups stale relations and says so; leaves every other state flat in its place', () => {
    const plans = [plan('p120', 120), plan('a', null), plan('p121', 121)]
    const stale = planGroups(plans, view(cached([120, 121]), T + 2 * STALE_AFTER_MS), null)
    expect(ids(stale.plans)).toEqual(['p121', 'p120', 'a'])
    expect(stale.groupOf.get('p120')).toMatchObject({ stale: true, fetchedAt: at(0) })

    const flat = (rows: IssueSnapshotRow[] | null, nowMs = T, links: Map<string, CachedLink> | null = null,
      list: IssueViewPlan[] = plans, opts: { maxUnits?: number } = {}) => {
      const out = planGroups(list, rows ? view(rows, nowMs, opts) : buildIssueView(null), links)
      expect(ids(out.plans)).toEqual(ids(list))
      expect(out.groupOf.size).toBe(0)
    }
    // hidden: no successful fetch for over 7 days
    flat(cached([120, 121]), T + HIDDEN_AFTER_MS + 1)
    // unavailable: a hard failure on one member leaves the other alone
    flat([family()[0]!, row(K(120), null, null, { error: 'not-found' }), row(K(121), snapshot(K(121), { ancestors: [parent117] }), at(0))])
    // no-hierarchy: GitHub returned the issue but not its parent
    flat([family()[0]!, row(K(120), snapshot(K(120), { unavailable: true }), at(0)), row(K(121), snapshot(K(121), { ancestors: [parent117] }), at(0))])
    // omitted by the node cap
    flat(cached([120, 121]), T, null, plans, { maxUnits: 1 })
    // /api/issues failed or never answered
    flat(null)
    // uncertain: a PR row with no bound closing record
    const legacy: CachedLink = {
      repo: REPO, branch: '120-x', head_repo: REPO, provider: 'github', pr_number: 9, pr_url: null, pr_title: null,
      pr_state: 'OPEN', pr_head_sha: null, pr_draft: false, review_decision: null, checks: null, issue_number: 120,
      issue_url: null, issue_title: null, preview_url: null, preview_environment: null, preview_deployment_id: null,
      preview_updated_at: null, preview_error: null, tldr: null, fetched_at: at(0), checked_at: at(0), error: null, revision: 1,
    }
    flat(cached([120, 121]), T, indexLinks([legacy]), [plan('pr120', null, { stream: '120-x' }), plan('p121', 121)])
  })

  // Departure 3: a plan is the umbrella of its own group before it is a member
  // of its parent's; a group left with no member dissolves and frees its plans.
  it('settles three nesting levels: a dissolved group\'s umbrella joins its parent\'s group', () => {
    // #100 > (#117, #118); #117 > #120; #120 > #130
    const f = (n: number) => facts(K(n), { title: `Issue ${n}` })
    const rows = [
      row(K(100), snapshot(K(100), { children: [f(117), f(118)] }), at(0)),
      row(K(117), snapshot(K(117), { ancestors: [f(100)], children: [f(120)] }), at(0)),
      row(K(118), snapshot(K(118), { ancestors: [f(100)] }), at(0)),
      row(K(120), snapshot(K(120), { ancestors: [f(117), f(100)], children: [f(130)] }), at(0)),
      row(K(130), snapshot(K(130), { ancestors: [f(120), f(117), f(100)] }), at(0)),
    ]
    const plans = [plan('p130', 130), plan('p118', 118), plan('flat', null), plan('p120', 120), plan('p117', 117), plan('p100', 100)]
    const out = planGroups(plans, view(rows), null)
    // #117's group would hold only p117 (p120 leads #120's), so it dissolves and p117 joins #100's
    expect(ids(out.plans)).toEqual(['p120', 'p130', 'p100', 'p117', 'p118', 'flat'])
    const top = out.groupOf.get('p100')!
    expect(top.parent.key).toBe(K(100))
    expect(top.size).toBe(3)
    expect(out.groupOf.get('p117')).toBe(top)
    expect(out.groupOf.get('p118')).toBe(top)
    const low = out.groupOf.get('p120')!
    expect(low.parent.key).toBe(K(120))
    expect(out.groupOf.get('p130')).toBe(low)
    expect(out.groupOf.has('flat')).toBe(false)

    // without p130, #120's group has no member and dissolves too: p120 rejoins
    // #117's, which now holds two plans, so p117 leads it and #100 keeps only p118 and p100
    const fewer = planGroups(plans.filter((p) => p.id !== 'p130'), view(rows), null)
    expect(ids(fewer.plans)).toEqual(['p100', 'p118', 'flat', 'p117', 'p120'])
    expect(fewer.groupOf.get('p120')?.parent.key).toBe(K(117))
    expect(fewer.groupOf.get('p118')?.parent.key).toBe(K(100))
    expect(fewer.groupOf.get('p100')?.size).toBe(2)
  })

  it('reads the freshness itself, not just whether a node is present', () => {
    const fresh = view(cached([120, 121]))
    for (const freshness of ['hidden', 'no-hierarchy', 'unavailable'] as const) {
      const forged = { ...fresh, relations: new Map([...fresh.relations].map(([key, rel]) => [key, { ...rel, freshness }])) }
      expect(planGroups([plan('p120', 120), plan('p121', 121)], forged, null).groupOf.size).toBe(0)
    }
  })

  it('never hides or duplicates a plan, and never writes to what it reads', () => {
    const plans = Object.freeze([plan('umb', 117), plan('p120', 120), plan('p121', 121), plan('a', null), plan('p120b', 120)].map((p) => Object.freeze(p)))
    const out = planGroups(plans, view(cached([120, 121])), null)
    expect([...ids(out.plans)].sort()).toEqual([...ids(plans)].sort())
    expect(new Set(ids(out.plans)).size).toBe(plans.length)
  })

  it('marks runs of linked rows only when they span two parents', () => {
    const rows = [
      ...cached([120, 121]),
      row(K(130), snapshot(K(130), { ancestors: [facts(K(116), { title: 'Other parent' })] }), at(0)),
    ]
    const linked = (id: string, n: number | null): IssueViewRow => (n === null
      ? { id, label: id, status: 'tracked' }
      : { id, label: id, status: 'tracked', issue_repo: REPO, issue_number: n })
    const runs = rowParentRuns([linked('r1', 120), linked('r2', 121), linked('r3', null), linked('r4', 130), linked('r5', 120)], view(rows))
    expect([...runs].map(([id, node]) => [id, node.key])).toEqual([['r1', K(117)], ['r4', K(116)], ['r5', K(117)]])
    expect(rowParentRuns([linked('r1', 120), linked('r2', null), linked('r3', 121)], view(rows)).size).toBe(0)
    expect(rowParentRuns([linked('r1', 120), linked('r4', 130)], buildIssueView(null)).size).toBe(0)
  })
})

// Slice 2 PR D (§9.1): GitHub dependencies in the view. A relation that draws
// relationships also carries its issue's open blockers ("waits on") and open
// dependents ("unblocks"); plans and rows get the chips' entries, with a row's
// agent-declared waits_on steps beside its issue's blockers.
describe('GitHub dependencies in the view (slice 2 PR D)', () => {
  const nowMs = T + 3 * 60_000
  const depRow = (n: number, d: DepsOpts, extra: { fetchedAt?: string; error?: 'offline' | 'not-found' } = {}) =>
    row(K(n), snapshot(K(n)), extra.fetchedAt ?? at(0), {
      dependencies: deps(d), ...(extra.error ? { error: extra.error, checkedAt: at(100) } : {}),
    })
  const deps121 = (): DepsOpts => ({
    blockedBy: [K(119), facts(K(118), { state: 'CLOSED', state_reason: 'COMPLETED' }), 'Other/Repo#5'],
    blocking: [K(122), facts(K(123), { state: 'CLOSED', state_reason: 'COMPLETED' })],
  })
  const depsOfRel = (view: ReturnType<typeof buildIssueView>, key: string) => {
    const found = relation(view, key).dependencies
    if (!found || found.status !== 'ok') throw new Error(`no dependencies for ${key}`)
    return found
  }

  it('lists the open blockers and dependents by repository and number, with activity, and drops closed ones', () => {
    const view = buildIssueView(graphOf([depRow(121, deps121())]), { nowMs })
    const found = depsOfRel(view, K(121))
    expect(found.waitsOn.map((d) => d.node.key)).toEqual(['other/repo#5', K(119)])
    expect(found.unblocks.map((d) => d.node.key)).toEqual([K(122)])
    expect(found.waitsOn.map((d) => d.activity.label)).toEqual(['None here', 'None here'])
    expect(found.cycle).toBe(false)
    expect(found.more).toEqual({ waitsOn: { notVisible: 0, onGitHub: 0 }, unblocks: { notVisible: 0, onGitHub: 0 }, notShown: 0 })
  })

  it('ages with the relationships: stale keeps the lists, expired and unavailable draw none', () => {
    const stale = buildIssueView(graphOf([depRow(121, deps121(), { error: 'offline' })]), { nowMs: T + 60 * 60_000 })
    expect(relation(stale, K(121)).freshness).toBe('stale')
    expect(depsOfRel(stale, K(121)).waitsOn).toHaveLength(2)
    const hidden = buildIssueView(graphOf([depRow(121, deps121())]), { nowMs: T + HIDDEN_AFTER_MS + 1 })
    expect(relation(hidden, K(121)).dependencies).toBeNull()
    const hard = buildIssueView(graphOf([depRow(121, deps121(), { error: 'not-found' })]), { nowMs })
    expect(relation(hard, K(121)).freshness).toBe('unavailable')
    expect(relation(hard, K(121)).dependencies).toBeNull()
  })

  it('draws no list for an unknown section, and says unavailable only when GitHub said so', () => {
    const unknown = buildIssueView(graphOf([row(K(121), snapshot(K(121)), at(0))]), { nowMs })
    expect(relation(unknown, K(121)).dependencies).toBeNull()
    const refused = buildIssueView(graphOf([row(K(121), snapshot(K(121)), at(0), { dependencies: { status: 'unavailable' } })]), { nowMs })
    expect(relation(refused, K(121)).dependencies).toEqual({ status: 'unavailable' })
  })

  it('marks a cycle that touches the issue, and only then', () => {
    const pairs = depsOf([[K(120), K(121)], [K(121), K(120)], [K(121), K(122)]])
    const rows = [120, 121, 122].map((n) => row(K(n), snapshot(K(n)), at(0), { dependencies: pairs(K(n)) }))
    const view = buildIssueView(graphOf(rows), { nowMs })
    expect(depsOfRel(view, K(120)).cycle).toBe(true)
    expect(depsOfRel(view, K(121)).cycle).toBe(true)
    expect(depsOfRel(view, K(122)).cycle).toBe(false)
    expect(depsOfRel(view, K(122)).waitsOn.map((d) => d.node.key)).toEqual([K(121)])
  })

  it('counts the open ones it cannot show: hidden from the account, beyond the page, and cut by the node cap', () => {
    const hiddenFrom = buildIssueView(graphOf([depRow(121, {
      blockedBy: [K(119), K(120), facts(K(118), { state: 'CLOSED' })], blockedByCounts: { open: 5, total: 7 },
    })]), { nowMs })
    expect(depsOfRel(hiddenFrom, K(121)).more.waitsOn).toEqual({ notVisible: 3, onGitHub: 0 })

    const page = Array.from({ length: 50 }, (_, i) => K(500 + i))
    const beyond = buildIssueView(graphOf([depRow(121, {
      blocking: page, blockingTruncated: true, blockingCounts: { open: 60, total: 80 },
    })]), { nowMs })
    expect(depsOfRel(beyond, K(121)).unblocks).toHaveLength(50)
    expect(depsOfRel(beyond, K(121)).more.unblocks).toEqual({ notVisible: 0, onGitHub: 10 })
    // the cap cut four of the page: they are "not shown", not also "more on GitHub"
    const cutPage = { ...graphOf([depRow(121, { blocking: page, blockingTruncated: true, blockingCounts: { open: 60, total: 80 } })]) }
    const kept = { ...cutPage, edges: cutPage.edges.filter((e) => !(e.kind === 'blocks' && [K(500), K(501), K(502), K(503)].includes(e.to))),
      roots: cutPage.roots.map((r) => ({ ...r, dependencies_omitted: 4, dependencies_omitted_open: 4 })) }
    expect(depsOfRel(buildIssueView(kept, { nowMs }), K(121)).more).toEqual({
      waitsOn: { notVisible: 0, onGitHub: 0 }, unblocks: { notVisible: 0, onGitHub: 10 }, notShown: 4,
    })

    // a page of 50 that mixes open and closed: the open ones it lacks may sit
    // beyond it, so they are never blamed on permissions (review of #274, F1)
    const mixed = (n: number) => [
      ...Array.from({ length: 5 }, (_, i) => K(n + i)),
      ...Array.from({ length: 45 }, (_, i) => facts(K(n + 100 + i), { state: 'CLOSED' })),
    ]
    const both = buildIssueView(graphOf([depRow(121, {
      blockedBy: mixed(600), blockedByTruncated: true, blockedByCounts: { open: 20, total: 80 },
      blocking: mixed(800), blockingTruncated: true, blockingCounts: { open: 9, total: 51 },
    })]), { nowMs })
    expect(depsOfRel(both, K(121)).waitsOn).toHaveLength(5)
    expect(depsOfRel(both, K(121)).more).toEqual({
      waitsOn: { notVisible: 0, onGitHub: 15 }, unblocks: { notVisible: 0, onGitHub: 4 }, notShown: 0,
    })
    // a complete page (total ≤ 50) lists everything this account can see
    const complete = buildIssueView(graphOf([depRow(121, {
      blockedBy: mixed(600), blockedByCounts: { open: 8, total: 50 },
      blocking: [K(130), facts(K(131), { state: 'CLOSED' })], blockingCounts: { open: 4, total: 6 },
    })]), { nowMs })
    expect(depsOfRel(complete, K(121)).more).toEqual({
      waitsOn: { notVisible: 3, onGitHub: 0 }, unblocks: { notVisible: 3, onGitHub: 0 }, notShown: 0,
    })

    // the node cap: two dependents were cut, and the root says so
    const graph = graphOf([depRow(121, { blockedBy: [K(119)], blocking: [K(122), K(123), K(124)] })])
    const cut = {
      ...graph,
      edges: graph.edges.filter((e) => !(e.kind === 'blocks' && (e.to === K(123) || e.to === K(124)))),
      roots: graph.roots.map((r) => ({ ...r, dependencies_omitted: 2, dependencies_omitted_open: 2 })),
    }
    const capped = depsOfRel(buildIssueView(cut, { nowMs }), K(121))
    expect(capped.unblocks.map((d) => d.node.key)).toEqual([K(122)])
    expect(capped.more).toEqual({ waitsOn: { notVisible: 0, onGitHub: 0 }, unblocks: { notVisible: 0, onGitHub: 0 }, notShown: 2 })
  })

  it('says "+N not shown" for the OPEN dependencies the node cap cut, never the closed ones (#275)', () => {
    // #121 waits on #116..#119 (#116 and #118 closed) and unblocks #130 (closed)
    // and #131; two more open blockers are hidden from this account. Three units
    // keep #121, #116 and #117: the cap cuts #118, #119, #130 and #131, two open.
    const closed = (n: number) => facts(K(n), { state: 'CLOSED' })
    const graph = graphOf([depRow(121, { blockedBy: [closed(116), K(117), closed(118), K(119)], blockedByCounts: { open: 4, total: 6 }, blocking: [closed(130), K(131)] })], { maxUnits: 3 })
    expect(graph.roots[0]).toMatchObject({ dependencies_omitted: 4, dependencies_omitted_open: 2 })
    const view = buildIssueView(graph, { nowMs })
    const found = depsOfRel(view, K(121))
    expect(found.waitsOn.map((d) => d.node.key)).toEqual([K(117)])
    expect(found.unblocks).toEqual([])
    expect(found.more).toEqual({ waitsOn: { notVisible: 2, onGitHub: 0 }, unblocks: { notVisible: 0, onGitHub: 0 }, notShown: 2 })
    // the three kinds of "+N" never count an open one twice: listed + every line = the open total
    const lines = (m: { notVisible: number; onGitHub: number }) => m.notVisible + m.onGitHub
    expect(found.waitsOn.length + found.unblocks.length + lines(found.more.waitsOn) + lines(found.more.unblocks) + found.more.notShown).toBe(5)
    const plan = { repo: REPO, stream: 'main', issue_pin_repo: REPO, issue_pin_number: 121, project: 'agent-inbox' }
    const html = issueRelationsHtml(new Map(), plan, nowMs, { issues: view })
    expect(html).toContain('+2 not shown')
    expect(html).toContain('+2 not visible to your GitHub account')
    expect(html).not.toContain('+4 not shown')
    // an older viewer's graph has only the count of every cut entry
    const older = { ...graph, roots: graph.roots.map(({ dependencies_omitted_open: _open, ...r }) => r) }
    expect(depsOfRel(buildIssueView(older, { nowMs }), K(121)).more.notShown).toBe(4)
  })

  describe('plan and row entries', () => {
    const step = (id: string, label: string, status: string, link: number | null, waits: string[] = []): IssueViewRow => ({
      id, label, status, waits_on: waits, ...(link === null ? {} : { issue_repo: REPO, issue_number: link }),
    })
    const rows = [
      step('rb', 'Build', 'done', 119),
      step('rs', 'Sign', 'tracked', 120),
      step('rp', 'Ship', 'partial', 121, ['Build', 'Gone', 'Sign']),
      step('rd', 'Doc', 'tracked', null, ['Sign']),
      step('rx', 'Extra', 'tracked', null, ['Build']),
      step('rn', 'Skipped', 'na', null),
      step('ry', 'Later', 'tracked', null, ['Doc', 'Skipped']),
    ]
    const shipPlan: IssueViewPlan = {
      id: 'p', project: 'agent-inbox', agent: 'copilot', title: 'Release', status: 'active', repo: REPO, stream: 'main',
      issue_ref: null, issue_pin_repo: REPO, issue_pin_number: 121, rows,
    }
    // #121 waits on #119 (still open on GitHub), #120 and #122; #118 is closed
    const graph = () => graphOf([depRow(121, { blockedBy: [K(119), K(120), K(122), facts(K(118), { state: 'CLOSED' })] })])
    const brief = (entries: readonly IssueWaitEntry[] | undefined) =>
      (entries ?? []).map((e) => [e.step?.label ?? null, e.node?.key ?? null, e.sources.join('+')])

    it('merges a step and its GitHub issue into one entry, ignores done and dangling steps, and keeps GitHub-only blockers', () => {
      const view = buildIssueView(graph(), { boards: [shipPlan], nowMs })
      expect(brief(view.rowWaits.get('rp'))).toEqual([
        ['Sign', K(120), 'step+github'],
        [null, K(119), 'github'],
        [null, K(122), 'github'],
      ])
      expect(brief(view.rowWaits.get('rd'))).toEqual([['Sign', null, 'step']])
      // its only step is done; a step that will not happen (na) holds nothing up either
      expect(view.rowWaits.has('rx')).toBe(false)
      expect(brief(view.rowWaits.get('ry'))).toEqual([['Doc', null, 'step']])
      expect(view.rowWaits.has('rs')).toBe(false)
      expect(brief(view.planWaits.get('p'))).toEqual([[null, K(119), 'github'], [null, K(120), 'github'], [null, K(122), 'github']])
      expect(view.rowWaits.get('rp')?.every((e) => e.node === null || e.freshness === 'fresh')).toBe(true)
    })

    it('keeps the steps without a graph, and drops the GitHub half whenever it would not draw', () => {
      const steps = [['Sign', null, 'step']]
      for (const [graphBody, at_] of [[null, nowMs], [graph(), T + HIDDEN_AFTER_MS + 1]] as const) {
        const view = buildIssueView(graphBody, { boards: [shipPlan], nowMs: at_ })
        expect(brief(view.rowWaits.get('rp'))).toEqual(steps)
        expect(view.planWaits.has('p')).toBe(false)
      }
      const unknown = buildIssueView(graphOf([row(K(121), snapshot(K(121)), at(0))]), { boards: [shipPlan], nowMs })
      expect(brief(unknown.rowWaits.get('rp'))).toEqual(steps)
      // an archived plan's rows draw as its card does
      const archived = buildIssueView(graph(), { archived: [{ ...shipPlan, status: 'archived' }], nowMs })
      expect(brief(archived.rowWaits.get('rd'))).toEqual([['Sign', null, 'step']])
    })

    it('reads a stale relationship as stale, and never makes an uncertain plan identity wait', () => {
      const stale = buildIssueView(graphOf([depRow(121, { blockedBy: [K(122)] }, { error: 'offline' })]), { boards: [shipPlan], nowMs: T + 60 * 60_000 })
      expect(stale.planWaits.get('p')?.map((e) => e.freshness)).toEqual(['stale'])
      const guessed = { ...shipPlan, issue_pin_repo: null, issue_pin_number: null, stream: '121-x', issue_ref: 121 }
      // a branch guess is certain enough for chips, but a PR that closes several issues is not
      const view = buildIssueView(graph(), { boards: [guessed], nowMs })
      expect(brief(view.planWaits.get('p')).map(([, key]) => key)).toEqual([K(119), K(120), K(122)])
      const unsure = { ...guessed, stream: 'feature', issue_ref: null }
      const links = indexLinks([{ repo: REPO, branch: 'feature', head_repo: REPO, issue_number: 121 } as CachedLink])
      expect(buildIssueView(graph(), { boards: [unsure], links, nowMs }).planWaits.has('p')).toBe(false)
    })
  })
})

// The pure view must never feed attention (§10).
it('dependencies change no relation field slice 1 draws', () => {
  const parent117 = facts(K(117), { title: 'Integrate Agent Inbox with Agent Host Protocol', children_total: 10, children_completed: 1 })
  const rows = [family()[0]!, ...[120, 121].map((n) => row(K(n), snapshot(K(n), { ancestors: [parent117] }), at(0)))]
  const section = depsOf([[K(121), K(120)], [K(120), K(121)], ['other/repo#5', K(120)], [K(120), K(122)], ['other/repo#6', K(117)]])
  const nowMs = T + 3 * 60_000
  const before = buildIssueView(graphOf(rows), { nowMs })
  const after = buildIssueView(graphOf(rows.map((r) => ({ ...r, dependencies: section(`${r.repo}#${r.number}`) }))), { nowMs })
  const strip = (view: ReturnType<typeof buildIssueView>) => [...view.relations].map(([key, { dependencies: _d, ...rest }]) => [key, rest])
  expect(strip(after)).toEqual(strip(before))
  expect([...before.relations.values()].every((r) => r.dependencies === null)).toBe(true)
})
