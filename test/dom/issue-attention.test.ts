// @vitest-environment jsdom
// Issue #103, PR3, criterion 5: relationship data is ambient. The badge, the
// title, every tab count, Needs you and the dock's ?scope=attention projection
// are identical with and without a graph, and no attention module names an
// issue field. Activity labels READ the attention set; nothing here feeds it.
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'
import { insertItem, upsertBoard, upsertIssueSnapshot } from '../../src/store.js'
import type { IssueFacts } from '../../src/store.js'
import { facts, snapshot } from '../issue-fixtures.js'
import type { SnapshotOpts } from '../issue-fixtures.js'
import { advanceClock, badgeCount, bootApp, click, freshDb, pollTick, rows, settle, showInbox, tabCount, useDomTest } from './harness.js'

useDomTest()
let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REPO = 'shariqh/agent-inbox'
const K = (n: number): string => `${REPO}#${n}`
const SCOPE = { project: 'agent-inbox', agent: 'copilot' }
const route = (input: RequestInfo | URL): string => String(input).split('?')[0]!

function cache(d: Database.Database, n: number, opts: SnapshotOpts = {}): void {
  upsertIssueSnapshot(d, { repo: REPO, number: n, snapshot: snapshot(K(n), opts), startedAt: new Date().toISOString() })
}

/** Everything the human's attention is counted from, read off the page and the dock's own route. */
async function attentionSurfaces() {
  const dock = await fetch('/api/items?scope=attention')
  return {
    title: document.title,
    badge: badgeCount(),
    tabs: ['needsYou', 'notes', 'boards', 'done'].map(tabCount),
    needsYou: rows().map((el) => [el.dataset.cardId, el.querySelector('.nrow-owner')?.textContent]),
    dock: { etag: dock.headers.get('etag'), body: await dock.text() },
  }
}

describe('attention with and without relationship data (#103 PR3)', () => {
  it('keeps the badge, title, tab counts, Needs you and the dock projection identical', async () => {
    db = freshDb()
    insertItem(db, { ...SCOPE, stream: '120-input', kind: 'question', title: 'Which input first?', repo: REPO, issue_ref: 120 })
    insertItem(db, { ...SCOPE, stream: 'main', kind: 'question', title: 'Unlinked question' })
    insertItem(db, { ...SCOPE, stream: '118-hosts', kind: 'note', title: 'Hosts note', repo: REPO, issue_ref: 118 })
    upsertBoard(db, {
      ...SCOPE, stream: 'adapter', title: 'Adapter work', repo: REPO, issuePin: { repo: REPO, number: 117 },
      rows: [
        { label: 'Waits on the adapter', status: 'partial', issue: { repo: REPO, number: 119 } },
        {
          label: 'Approve the AHP contract', status: 'blocked', issue: { repo: REPO, number: 119 },
          note: 'The contract is drafted.', next_step: 'Approve the contract.', action_owner: 'approval',
          impact: 'Unblocks the adapter.', options: [{ label: 'Approve', recommended: true }, { label: 'Hold' }],
        },
      ],
    })
    let graph = true
    await bootApp(db, {
      interceptFetch: async (input, _init, next) =>
        (!graph && route(input) === '/api/issues' ? new Response('<!doctype html>', { status: 404 }) : next()),
    })
    await showInbox()
    const before = await attentionSurfaces()

    const parent = facts(K(117), { title: 'Umbrella', children_total: 3, children_completed: 1 })
    cache(db, 117, { children: [K(118), K(119), K(120)], completed: 1 })
    for (const n of [118, 119, 120]) cache(db, n, { ancestors: [parent] })
    await pollTick()
    await settle()
    expect(document.querySelectorAll('#needsYouList [data-issue-key]').length).toBeGreaterThan(0)
    const withGraph = await attentionSurfaces()

    graph = false
    await pollTick()
    await settle()
    expect(document.querySelectorAll('[data-issue-key]')).toHaveLength(0)
    const withoutGraph = await attentionSurfaces()

    expect(before.badge).toBe(3)
    expect(withGraph).toEqual(before)
    expect(withoutGraph).toEqual(before)
  })

  // Slice 2 §10: grouping reorders Plans and feeds nothing to attention.
  it('keeps every attention surface identical with plan grouping on and off', async () => {
    db = freshDb()
    insertItem(db, { ...SCOPE, stream: '120-input', kind: 'question', title: 'Which input first?', repo: REPO, issue_ref: 120 })
    const blocked = (label: string) => ({
      label, status: 'blocked' as const, note: 'Ready.', next_step: 'Approve it.', action_owner: 'approval' as const,
      impact: 'Unblocks the family.', options: [{ label: 'Approve', recommended: true }, { label: 'Hold' }],
    })
    upsertBoard(db, { ...SCOPE, stream: 'main', title: 'Umbrella', repo: REPO, issuePin: { repo: REPO, number: 117 }, rows: [blocked('Approve the family')] })
    upsertBoard(db, { ...SCOPE, stream: 'main', title: 'Flat plan', repo: REPO, rows: [blocked('Approve the flat plan')] })
    upsertBoard(db, { ...SCOPE, stream: 'main', title: 'Child 120', repo: REPO, issuePin: { repo: REPO, number: 120 }, rows: [blocked('Approve the child')] })
    const parent = facts(K(117), { title: 'Umbrella', children_total: 2, children_completed: 0 })
    cache(db, 117, { children: [K(120), K(121)] })
    cache(db, 120, { ancestors: [parent] })
    await bootApp(db)
    await showInbox()
    const off = await attentionSurfaces()

    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    click(document.querySelector('#boards .tab-header input[role="switch"]'))
    await settle()
    expect(document.querySelectorAll('#boards .plan-group-head')).toHaveLength(1)
    await pollTick()
    await showInbox()
    const on = await attentionSurfaces()

    expect(off.badge).toBe(4)
    expect(on).toEqual(off)
  })

  // Slice 2 PR B (§10): GitHub dependencies reach /api/issues and feed nothing here.
  it('keeps every attention surface identical with and without GitHub dependencies', async () => {
    db = freshDb()
    insertItem(db, { ...SCOPE, stream: '121-input', kind: 'question', title: 'Which input first?', repo: REPO, issue_ref: 121 })
    upsertBoard(db, {
      ...SCOPE, stream: 'adapter', title: 'Adapter work', repo: REPO, issuePin: { repo: REPO, number: 117 },
      rows: [
        { label: 'Waits on the adapter', status: 'partial', issue: { repo: REPO, number: 121 } },
        {
          label: 'Approve the AHP contract', status: 'blocked', issue: { repo: REPO, number: 119 },
          note: 'The contract is drafted.', next_step: 'Approve the contract.', action_owner: 'approval',
          impact: 'Unblocks the adapter.', options: [{ label: 'Approve', recommended: true }, { label: 'Hold' }],
        },
      ],
    })
    const parent = facts(K(117), { title: 'Umbrella', children_total: 3, children_completed: 0 })
    cache(db, 117, { children: [K(119), K(120), K(121)] })
    for (const n of [119, 120, 121]) cache(db, n, { ancestors: [parent] })
    await bootApp(db)
    await showInbox()
    const before = await attentionSurfaces()

    // the same issues refreshed with GitHub's dependencies: #119 and #120 block #121, open
    advanceClock(60_000)
    const list = (issues: IssueFacts[]) => ({ open: issues.length, total: issues.length, truncated: false, list: issues })
    const refresh = (n: number, blockedBy: number[], blocking: number[]) => upsertIssueSnapshot(db!, {
      repo: REPO, number: n, startedAt: new Date().toISOString(), snapshot: snapshot(K(n), { ancestors: [parent] }),
      dependencies: { status: 'ok', blocked_by: list(blockedBy.map((b) => facts(K(b)))), blocking: list(blocking.map((b) => facts(K(b)))) },
    })
    refresh(121, [119, 120], [])
    refresh(119, [], [121])
    await pollTick()
    await settle()
    const graph = await (await fetch('/api/issues')).json() as { edges: Array<{ kind: string }> }
    expect(graph.edges.filter((edge) => edge.kind === 'blocks')).toHaveLength(2)
    const withDependencies = await attentionSurfaces()

    expect(before.badge).toBe(2)
    expect(withDependencies).toEqual(before)
  })

  it('pins the attention modules: none of them names an issue field, a dependency field, waits_on or plan grouping', () => {
    for (const file of ['public/attention.js', 'public/relay.js', 'electron/reply-watch.cjs']) {
      const code = readFileSync(join(ROOT, file), 'utf8').split('\n').filter((line) => {
        const t = line.trim()
        return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
      }).join('\n')
      expect(code, `${file} reads relationship data`).not.toMatch(/issue|sub-?issue|children_|relation|waits_?on|\bblocks\b|\bdeps\b|dependenc|unblock/i)
      expect(code, `${file} reads plan grouping`).not.toMatch(/planGroups|rowParentRuns|groupOf|groupByParent|group-plans|plan-group|parent/i)
    }
  })
})
