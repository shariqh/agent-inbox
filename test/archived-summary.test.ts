// Issue #299: the viewer's poll carries archived plans in brief: every plan with
// its fields and progress, only the rows its surfaces read without the complete
// list, and what it leaves out of the outcome lists. The complete list stays a
// separate conditional representation, read only while a surface needs it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import {
  archiveBoard, getBoard, insertItem, listArchivedSummary, listBoards, listSourceLinks, openDb, updateBoardRow,
  upsertBoard, upsertSourceLink,
} from '../src/store.js'
import type { BoardWithRows, NewBoardRow } from '../src/store.js'
import { createViewer } from '../src/viewer.js'
import { buildIssueGraph } from '../src/issue-graph.js'
import { buildIssueView } from '../public/issues.js'
import type { IssueViewPlan } from '../public/issues.js'
import { indexLinks } from '../public/source.js'
import { at, keySets, row as snapshotRow, snapshot } from './issue-fixtures.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

const BASE = Date.parse('2026-10-24T00:00:00.000Z')
const REPO = 'shariqh/agent-inbox'
// The Dashboard lists four recent outcomes, and the viewer carries as many.
const RECENT = 4
// What the brief keeps of a row: its identity and content times, which
// public/issues.js reads, and for one of its project's newest outcomes, the
// outcome and the stamps public/relay.js orders it by.
const ROW_IDENTITY = ['id', 'label', 'status', 'issue_repo', 'issue_number', 'created_at', 'updated_at'].sort()
const ROW_OUTCOME = [
  ...ROW_IDENTITY, 'outcome', 'outcome_at', 'annotation_seen_at', 'handled_seen_at', 'annotated_at', 'handled_at',
].sort()

let db: Database.Database
let clock = 0

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  clock = 0
  vi.setSystemTime(BASE)
  db = openDb(join(scratchDir('archived-summary-'), 'inbox.db'))
})

afterEach(() => {
  if (db.open) db.close()
  removeScratchDirs()
  vi.useRealTimers()
})

function tick(): string {
  clock += 1000
  vi.setSystemTime(BASE + clock)
  return new Date(BASE + clock).toISOString()
}

const input = (project: string, title: string) => ({ project, stream: 'main', agent: `${project}-bot`, title, repo: REPO })

// An archived plan: rows written first, each outcome at its own time, then archived.
function archived(
  project: string, title: string, rows: NewBoardRow[], outcomes: string[] = [],
  extra: Partial<Parameters<typeof upsertBoard>[1]> = {},
): BoardWithRows {
  tick()
  upsertBoard(db, { ...input(project, title), ...extra, rows: [...rows, { label: 'Open step', status: 'tracked' }] })
  for (const label of outcomes) {
    tick()
    updateBoardRow(db, {
      ...input(project, title), expectedBoardVersion: getBoard(db, project, title)!.revision,
      label, status: 'done', outcome: `${label} shipped.`,
    })
  }
  tick()
  const board = getBoard(db, project, title)!
  expect(archiveBoard(db, board.id, board.revision)).toBe(true)
  return listBoards(db, { status: 'archived' }).find((plan) => plan.id === board.id)!
}

const pick = (row: object, keys: string[]) =>
  Object.fromEntries(keys.map((key) => [key, (row as Record<string, unknown>)[key]]))

describe('listArchivedSummary (issue #299)', () => {
  it('keeps every archived plan in the complete list’s order, with every plan field and progress over all its rows', () => {
    archived('alpha', 'Older', [{ label: 'Build', status: 'done' }, { label: 'Skip', status: 'na' }])
    archived('beta', 'Middle', [{ label: 'Half', status: 'partial' }, { label: 'Ask', status: 'blocked', note: 'Wait.', next_step: 'Decide.', action_owner: 'task', impact: 'Ships.' }])
    archived('alpha', 'Newest', [{ label: 'Done', status: 'done', context: 'Long background '.repeat(40) }])
    tick()
    upsertBoard(db, { ...input('alpha', 'Still active'), rows: [{ label: 'Work', status: 'tracked' }] })

    const complete = listBoards(db, { status: 'archived' })
    const { plans } = listArchivedSummary(db, RECENT)
    expect(plans.map((plan) => plan.id)).toEqual(complete.map((plan) => plan.id))
    for (const [index, plan] of plans.entries()) {
      const { rows: _rows, progress, ...fields } = complete[index]!
      const { rows: _brief, progress: briefProgress, omitted: _omitted, ...briefFields } = plan
      expect(briefFields).toEqual(fields)
      expect(briefProgress).toEqual(progress)
    }
    // without a row worth carrying, a plan carries none of its rows or background
    expect(JSON.stringify(plans)).not.toContain('Long background')
    expect(plans.flatMap((plan) => plan.rows)).toEqual([])
  })

  it('carries the rows that link an issue, each with only the fields its surfaces read, exactly as the complete list has them', () => {
    // alpha's newest outcomes are another plan's, so this plan's own outcome is omitted
    const complete = archived('alpha', 'Linked', [
      { label: 'Plain', status: 'done', context: 'Not carried.' },
      { label: 'Child', status: 'done', issue: { repo: REPO, number: 118 }, context: 'Carried without this.', outcome: 'Old news.' },
      { label: 'Another', status: 'partial', issue: { repo: REPO, number: 119 } },
    ])
    archived('alpha', 'Newer', [], ['N1', 'N2', 'N3', 'N4'])
    const plan = listArchivedSummary(db, RECENT).plans.find((candidate) => candidate.id === complete.id)!
    expect(plan.rows.map((row) => row.label)).toEqual(['Child', 'Another'])
    for (const row of plan.rows) {
      expect(Object.keys(row).sort()).toEqual(ROW_IDENTITY)
      expect(row).toEqual(pick(complete.rows.find((full) => full.id === row.id)!, ROW_IDENTITY))
    }
    expect(JSON.stringify(plan)).not.toContain('Old news.')
    expect(plan.omitted).toEqual({ outcomes: 1, latest: complete.rows.find((row) => row.label === 'Child')!.outcome_at })
  })

  it('carries each project’s newest outcomes, and counts the rest with the newest stamp among them', () => {
    // alpha: six outcomes over two plans, so the oldest two are omitted
    const older = archived('alpha', 'First', [], ['A1', 'A2', 'A3'])
    const newer = archived('alpha', 'Second', [], ['A4', 'A5', 'A6'])
    // beta: two outcomes, both carried whatever alpha holds
    archived('beta', 'Third', [], ['B1', 'B2'])
    const { plans } = listArchivedSummary(db, RECENT)
    const byId = new Map(plans.map((plan) => [plan.id, plan]))
    const carried = (id: string) => byId.get(id)!.rows.map((row) => row.label)
    expect(carried(newer.id)).toEqual(['A4', 'A5', 'A6'])
    expect(carried(older.id)).toEqual(['A3'])
    expect(byId.get(older.id)!.omitted).toEqual({
      outcomes: 2, latest: older.rows.find((row) => row.label === 'A2')!.outcome_at,
    })
    expect(byId.get(newer.id)!.omitted).toEqual({ outcomes: 0, latest: null })
    const beta = plans.find((plan) => plan.project === 'beta')!
    expect(beta.rows.map((row) => [row.label, 'outcome' in row && row.outcome])).toEqual([['B1', 'B1 shipped.'], ['B2', 'B2 shipped.']])
    expect(beta.omitted).toEqual({ outcomes: 0, latest: null })
    // each with the outcome and the stamps it is ordered by, exactly as the complete list has them
    const complete = listBoards(db, { status: 'archived' }).flatMap((plan) => plan.rows)
    for (const row of plans.flatMap((plan) => plan.rows)) {
      expect(Object.keys(row).sort()).toEqual(ROW_OUTCOME)
      expect(row).toEqual(pick(complete.find((full) => full.id === row.id)!, ROW_OUTCOME))
    }
  })

  // public/issues.js says "Done here" for the issues archived plans name, by
  // the plan's pin, branch issue or PR, or a row's own link.
  it('gives issue relations the same Agent Inbox activity as the complete list', () => {
    const key = (n: number) => `${REPO}#${n}`
    archived('alpha', 'Pinned', [], [], { issuePin: { repo: REPO, number: 118 } })
    archived('alpha', 'Rows', [{ label: 'Child', status: 'done', issue: { repo: REPO, number: 119 } }])
    archived('alpha', 'Branch', [], [], { stream: '120-work', issueRef: 120 })
    archived('beta', 'Closed by PR', [], [], { stream: '121-work' })
    upsertSourceLink(db, {
      repo: REPO, branch: '121-work', pr_number: 7, pr_state: 'MERGED', closing_refs: [{ repo: REPO, number: 121 }],
    })
    const graph = buildIssueGraph(
      [snapshotRow(key(117), snapshot(key(117), { children: [118, 119, 120, 121, 122].map(key) }), at(0))],
      keySets([key(117)]),
    )
    const links = indexLinks(listSourceLinks(db))
    const view = (plans: IssueViewPlan[]) => buildIssueView(graph, { archived: plans, links, nowMs: Date.parse(at(1)) })
    const brief = view(listArchivedSummary(db, RECENT).plans as IssueViewPlan[])
    const complete = view(listBoards(db, { status: 'archived' }) as IssueViewPlan[])
    expect(brief.relations).toEqual(complete.relations)
    expect(brief.planWaits).toEqual(complete.planWaits)
    const labels = complete.relations.get(key(117))!.children.map((child) => [child.node.number, child.activity.label])
    expect(labels).toEqual([[118, 'Done here'], [119, 'Done here'], [120, 'Done here'], [121, 'Done here'], [122, 'None here']])
  })

  it('carries every outcome tied with the last one it keeps', () => {
    // one upsert stamps every outcome it writes at the same instant
    tick()
    upsertBoard(db, {
      ...input('alpha', 'Tied'),
      rows: [
        ...['T1', 'T2', 'T3', 'T4', 'T5'].map((label) => ({ label, status: 'done' as const, outcome: `${label} shipped.` })),
        { label: 'Open step', status: 'tracked' },
      ],
    })
    const tied = getBoard(db, 'alpha', 'Tied')!
    archiveBoard(db, tied.id, tied.revision)
    const [plan] = listArchivedSummary(db, RECENT).plans
    expect(plan!.rows.map((row) => row.label)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5'])
    expect(plan!.omitted).toEqual({ outcomes: 0, latest: null })
    expect(listArchivedSummary(db, 0).plans[0]!.omitted.outcomes).toBe(5)
  })
})

describe('GET /api/boards/archived/summary (issue #299)', () => {
  it('serves the brief as its own conditional representation, apart from the complete list', async () => {
    const app = createViewer(db)
    archived('alpha', 'Shipped', [{ label: 'Child', status: 'done', issue: { repo: REPO, number: 118 } }], ['A1'])
    const first = await app.request('/api/boards/archived/summary')
    expect(first.status).toBe(200)
    expect(first.headers.get('cache-control')).toBe('no-store')
    const etag = first.headers.get('etag')!
    expect(await first.json()).toEqual(JSON.parse(JSON.stringify(listArchivedSummary(db, RECENT))))
    const again = await app.request('/api/boards/archived/summary', { headers: { 'If-None-Match': etag } })
    expect(again.status).toBe(304)
    // neither representation can revalidate the other
    const complete = await app.request('/api/boards/archived')
    expect(complete.headers.get('etag')).not.toBe(etag)
    expect((await app.request('/api/boards/archived', { headers: { 'If-None-Match': etag } })).status).toBe(200)

    // an item write leaves it alone; an archived plan changes it
    tick()
    insertItem(db, { project: 'alpha', stream: 'main', agent: 'alpha-bot', kind: 'question', title: 'Unrelated' })
    expect((await app.request('/api/boards/archived/summary', { headers: { 'If-None-Match': etag } })).status).toBe(304)
    archived('beta', 'Later', [], ['B1'])
    const changed = await app.request('/api/boards/archived/summary', { headers: { 'If-None-Match': etag } })
    expect(changed.status).toBe(200)
    expect(((await changed.json()) as { plans: unknown[] }).plans).toHaveLength(2)
  })
})
