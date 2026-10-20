// @vitest-environment jsdom
// Issue #103, PR3: breadcrumbs and child progress in the real viewer. The cache
// is seeded through store.ts exactly as the poller writes it, and the graph
// reaches the page through the real /api/issues route and the poll's eighth read.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { getBoard, insertItem, listIssueSnapshots, resolveItem, upsertBoard, upsertIssueSnapshot } from '../../src/store.js'
import { issueRelations } from '../../src/issue-graph.js'
import { facts, snapshot } from '../issue-fixtures.js'
import type { SnapshotOpts } from '../issue-fixtures.js'
import {
  advanceClock, answerInput, bootApp, buttonLabelled, click, freshDb, pollTick, row, settle, showInbox, type, useDomTest,
} from './harness.js'

useDomTest()
let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const REPO = 'shariqh/agent-inbox'
const K = (n: number): string => `${REPO}#${n}`
const SCOPE = { project: 'agent-inbox', agent: 'copilot' }
const UMBRELLA = 'Integrate Agent Inbox with Agent Host Protocol'
const PLAIN_120 = '<a href="https://github.com/shariqh/agent-inbox/issues/120" target="_blank" rel="noopener noreferrer" class="src-chip tone-issue" title="issue #120" tabindex="-1">#120</a>'
const route = (input: RequestInfo | URL): string => String(input).split('?')[0]!

/** Cache one issue as the poller would after a successful refresh, now. */
function cache(d: Database.Database, n: number, opts: SnapshotOpts = {}): void {
  upsertIssueSnapshot(d, { repo: REPO, number: n, snapshot: snapshot(K(n), opts), startedAt: new Date().toISOString() })
}

const parent117 = (extra = {}) => facts(K(117), { title: UMBRELLA, children_total: 10, children_completed: 1, ...extra })

/** The #117 family: a question on #120's branch, an umbrella plan pinned to #117, and a plan whose row links #119. */
function seed(d: Database.Database) {
  const question = insertItem(d, { ...SCOPE, stream: '120-ahp-input', kind: 'question', title: 'Which input requests come first?', repo: REPO, issue_ref: 120 })
  upsertBoard(d, {
    ...SCOPE, stream: '117-ahp', title: 'AHP integration', repo: REPO, issueRef: 117,
    issuePin: { repo: REPO, number: 117 }, rows: [{ label: 'Track the family', status: 'tracked' }],
  })
  upsertBoard(d, {
    ...SCOPE, stream: 'adapter', title: 'Adapter work', repo: REPO,
    rows: [{ label: 'Build the adapter', status: 'partial', issue: { repo: REPO, number: 119 } }],
  })
  const children = [118, 119, 120, 121, 122, 123, 124, 125, 126, 127].map((n) => facts(K(n), n === 118
    ? { state: 'CLOSED', state_reason: 'COMPLETED', title: 'Support multiple Agent Hosts' }
    : { title: `Sub-issue ${n}` }))
  cache(d, 117, { issue: { title: UMBRELLA }, children, completed: 1 })
  cache(d, 119, { issue: { title: 'Build the AHP adapter' }, ancestors: [parent117()] })
  cache(d, 120, { issue: { title: 'Import unresolved AHP input requests' }, ancestors: [parent117()] })
  const umbrella = getBoard(d, 'agent-inbox', 'AHP integration')!
  const adapter = getBoard(d, 'agent-inbox', 'Adapter work')!
  return { question, umbrella, adapter, adapterRow: adapter.rows[0]! }
}

type Mode = 'graph' | '404' | 'offline' | 'malformed'
async function boot(d: Database.Database): Promise<{ set(mode: Mode): void }> {
  let mode: Mode = 'graph'
  await bootApp(d, {
    interceptFetch: async (input, _init, next) => {
      if (route(input) === '/api/issues') {
        if (mode === '404') return new Response('<!doctype html><title>Not found</title>', { status: 404 })
        if (mode === 'offline') throw new TypeError('issues offline')
        if (mode === 'malformed') return new Response(JSON.stringify({ version: 2, nodes: 'none' }), { headers: { 'content-type': 'application/json' } })
      }
      return next()
    },
  })
  return { set(next) { mode = next } }
}

async function showTab(tab: string): Promise<void> {
  click(document.querySelector(`.tab[data-tab="${tab}"]`))
  await settle()
}

const boardCard = (id: string): HTMLElement => document.querySelector<HTMLElement>(`#boards [data-card-id="${id}"]`)!
const chipKeys = (scope: ParentNode): string[] =>
  [...scope.querySelectorAll<HTMLElement>('[data-issue-key]')].map((el) => el.dataset.issueKey!)
/** The children-list entry of one sub-issue. */
const childEntry = (scope: ParentNode, key: string): HTMLElement | undefined =>
  [...scope.querySelectorAll<HTMLElement>('.src-child')].find((el) => el.querySelector(`[data-issue-key="${key}"]`))

describe('breadcrumbs and child progress (#103 PR3)', () => {
  it('draws a child\'s exact parent, a parent\'s children in GitHub order, and their Agent Inbox activity', async () => {
    db = freshDb()
    const { question, umbrella, adapter, adapterRow } = seed(db)
    const history = insertItem(db, { ...SCOPE, stream: '120-old', kind: 'note', title: 'Earlier note', repo: REPO, issue_ref: 120 })
    resolveItem(db, history)
    await boot(db)
    await showInbox()

    const src = row(question)!.querySelector('.nrow-src')!
    expect(chipKeys(src)).toEqual([K(117), K(120)])
    expect(src.textContent).toBe('#117›#120')
    expect(src.querySelector('a[data-issue-key]')?.getAttribute('title'))
      .toBe(`Parent: #117 ${UMBRELLA} (1 of 10 done) · checked just now`)

    await showTab('boards')
    const plan = boardCard(umbrella.id)
    // the pin names the plan's issue, and that issue is a parent with progress
    expect(plan.querySelector('.board-source')?.textContent).toContain('#117 · 1/10')
    const issues = plan.querySelector('.board-issues')!
    expect(issues.textContent).toContain('Sub-issues on GitHub · 1 of 10 done')
    expect([...issues.querySelectorAll('.src-child [data-issue-key]')].map((el) => el.textContent))
      .toEqual(['#118', '#119', '#120', '#121', '#122', '#123', '#124', '#125', '#126', '#127'])
    const activity = (n: number) => childEntry(issues, K(n))?.querySelector('.src-activity')?.textContent
    expect(activity(119)).toBe('Active · copilot · Build the adapter')
    expect(activity(120)).toBe('Waiting on you')
    expect(activity(121)).toBe('None here')

    // a linked row names its own issue beside its note, under its parent
    const matrixRow = boardCard(adapter.id).querySelector(`.board-row[data-row-id="${adapterRow.id}"]`)!
    expect(chipKeys(matrixRow.querySelector('.row-note')!)).toEqual([K(117), K(119)])

    // History keeps today's plain chip
    await showTab('done')
    expect(document.querySelector('#done')?.textContent).toContain('Earlier note')
    expect(chipKeys(document.getElementById('done')!)).toEqual([])
  })

  it.each(['404', 'offline', 'malformed'] as const)('renders every surface exactly as today when /api/issues is %s', async (failure) => {
    db = freshDb()
    const { question, umbrella } = seed(db)
    const viewer = await boot(db)
    viewer.set(failure)
    await pollTick()
    await showInbox()
    expect(document.getElementById('status')?.textContent).toBe('')
    expect(row(question)!.querySelector('.nrow-src')!.innerHTML).toBe(PLAIN_120)
    await showTab('boards')
    expect(chipKeys(document.getElementById('boards')!)).toEqual([])
    expect(boardCard(umbrella.id).querySelector('.board-issues')).toBeNull()
    // the explicit pin and row link still name their issue (§4.2), as a plain chip
    expect(boardCard(umbrella.id).querySelector('.board-source')?.textContent).toBe('#117')
    expect(document.querySelector('#boards .row-src')?.innerHTML).toBe(
      '<a href="https://github.com/shariqh/agent-inbox/issues/119" target="_blank" rel="noopener noreferrer" class="src-chip tone-issue" title="issue #119" tabindex="-1">#119</a>')

    // and draws again the moment the graph is back
    viewer.set('graph')
    await pollTick()
    expect(chipKeys(boardCard(umbrella.id).querySelector('.board-source')!)).toEqual([K(117)])
  })
})

describe('an issue GitHub returned without its hierarchy (#103 PR3, review round 1)', () => {
  it('draws the plain chip and one unavailable line, as the agent\'s issue_rel reports it', async () => {
    db = freshDb()
    const question = insertItem(db, { ...SCOPE, stream: '120-ahp-input', kind: 'question', title: 'Which input requests come first?', repo: REPO, issue_ref: 120 })
    // #117's own list still names #120, but #120's parent and sub-issues failed to load
    cache(db, 117, { issue: { title: UMBRELLA }, children: [facts(K(120), { title: 'Import unresolved AHP input requests' })] })
    cache(db, 120, { issue: { title: 'Import unresolved AHP input requests' }, unavailable: true })
    await boot(db)
    await showInbox()
    expect(row(question)!.querySelector('.nrow-src')!.innerHTML).toBe(PLAIN_120)
    click(row(question))
    await settle()
    const block = row(question)!.querySelector('.nrow-card .card-source')!
    expect(block.textContent).toContain('Relationships unavailable — GitHub returned this issue but not its parent or sub-issues')
    expect(block.textContent).not.toMatch(/checked|as of|#117|Import unresolved/)
    expect(chipKeys(row(question)!)).toEqual([])

    const rel = issueRelations(listIssueSnapshots(db), [K(117), K(120)], Date.now()).get(K(120))
    expect(rel).toMatchObject({ key: K(120), unavailable: true })
    expect(rel).not.toHaveProperty('parent')
  })
})

describe('a poll that changes relationships (#103 PR3, criterion 6)', () => {
  it('keeps a draft, its focus and the expanded row, then shows the new parent once the draft is gone', async () => {
    db = freshDb()
    const { question } = seed(db)
    await boot(db)
    await showInbox()
    click(row(question))
    await settle()
    const input = answerInput(question)!
    input.focus()
    type(input, 'Half-typed answer')

    advanceClock(60_000)
    cache(db, 120, { issue: { title: 'Import unresolved AHP input requests' }, ancestors: [facts(K(116), { title: 'Moved parent', children_total: 2, children_completed: 0 })] })
    await pollTick()
    // the editor is the same element: the poll did not rebuild under the draft
    expect(answerInput(question)).toBe(input)
    expect(input.value).toBe('Half-typed answer')
    expect(document.activeElement).toBe(input)
    expect(row(question)?.getAttribute('aria-expanded')).toBe('true')
    expect(chipKeys(row(question)!.querySelector('.nrow-src')!)).toEqual([K(117), K(120)])

    type(answerInput(question), '')
    await settle()
    expect(chipKeys(row(question)!.querySelector('.nrow-src')!)).toEqual([K(116), K(120)])
    expect(row(question)?.getAttribute('aria-expanded')).toBe('true')
  })

  it('restores the focused control and an expanded plan row across the rebuild', async () => {
    db = freshDb()
    const { question, adapter, adapterRow } = seed(db)
    await boot(db)
    await showInbox()
    click(row(question))
    await settle()
    buttonLabelled('Send', row(question)!)!.focus()
    advanceClock(60_000)
    cache(db, 120, { issue: { title: 'Renamed on GitHub' }, ancestors: [parent117({ children_completed: 2 })] })
    await pollTick()
    expect(document.activeElement).toBe(buttonLabelled('Send', row(question)!))
    expect(row(question)!.querySelector('.nrow-src a[data-issue-key]')?.getAttribute('title')).toContain('(2 of 10 done)')

    await showTab('boards')
    click(boardCard(adapter.id).querySelector(`.board-row[data-row-id="${adapterRow.id}"]`))
    await settle()
    expect(document.querySelector(`.row-panel-row[data-row-id="${adapterRow.id}"]`)).not.toBeNull()
    advanceClock(60_000)
    cache(db, 119, { issue: { title: 'Build the AHP adapter' }, ancestors: [facts(K(116), { title: 'Moved parent' })] })
    await pollTick()
    expect(document.querySelector(`.row-panel-row[data-row-id="${adapterRow.id}"]`)).not.toBeNull()
    expect(chipKeys(boardCard(adapter.id).querySelector('.row-note')!)).toEqual([K(116), K(119)])
  })

  it('does not toggle a plan row when its issue chip is clicked', async () => {
    db = freshDb()
    const { adapter, adapterRow } = seed(db)
    await boot(db)
    await showTab('boards')
    const chip = boardCard(adapter.id).querySelector(`.board-row[data-row-id="${adapterRow.id}"] .row-src a`)!
    chip.addEventListener('click', (event) => event.preventDefault()) // jsdom cannot open a new tab
    click(chip)
    await settle()
    expect(document.querySelector(`.row-panel-row[data-row-id="${adapterRow.id}"]`)).toBeNull()
  })
})

describe('navigation from Agent Inbox activity (#103 PR3, criterion 7)', () => {
  it('opens the exact plan and row, and the exact item', async () => {
    db = freshDb()
    const { question, umbrella, adapter, adapterRow } = seed(db)
    await boot(db)
    await showTab('boards')
    const activityFor = (n: number) =>
      childEntry(boardCard(umbrella.id).querySelector('.board-issues')!, K(n))?.querySelector('button.src-activity')

    click(activityFor(119))
    await settle()
    expect(document.querySelector('.tab[data-tab="boards"]')?.getAttribute('aria-selected')).toBe('true')
    expect(location.hash).toBe(`#item/${adapter.id}`)
    expect(document.querySelector(`.row-panel-row[data-row-id="${adapterRow.id}"]`)?.closest('[data-card-id]')?.getAttribute('data-card-id'))
      .toBe(adapter.id)

    await showTab('boards')
    click(activityFor(120))
    await settle()
    expect(document.querySelector('.tab[data-tab="needsYou"]')?.getAttribute('aria-selected')).toBe('true')
    expect(row(question)?.getAttribute('aria-expanded')).toBe('true')
  })
})
