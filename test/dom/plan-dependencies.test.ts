// @vitest-environment jsdom
// Slice 2 PR D (§9.1): "waits on" chips, "Dependencies on GitHub" and the row
// detail's "Waits on" in the real viewer. GitHub dependencies are seeded
// through store.ts exactly as the poller writes them; waits_on through
// upsertBoard, as an agent's board_upsert does.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { getBoard, upsertBoard, upsertIssueSnapshot } from '../../src/store.js'
import type { IssueRelative } from '../../src/store.js'
import { deps, facts, snapshot } from '../issue-fixtures.js'
import { advanceClock, bootApp, click, freshDb, pollTick, settle, type, useDomTest } from './harness.js'

useDomTest()
let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const REPO = 'shariqh/agent-inbox'
const K = (n: number): string => `${REPO}#${n}`
const SCOPE = { project: 'agent-inbox', agent: 'copilot' }
const route = (input: RequestInfo | URL): string => String(input).split('?')[0]!

function cacheDeps(d: Database.Database, n: number, blockedBy: IssueRelative[], blocking: IssueRelative[] = []): void {
  upsertIssueSnapshot(d, {
    repo: REPO, number: n, startedAt: new Date().toISOString(),
    snapshot: snapshot(K(n), { issue: { title: `Issue ${n}` } }),
    dependencies: deps({ blockedBy, blocking }),
  })
}

const open = (n: number) => facts(K(n), { title: `Issue ${n}` })

/** A release plan pinned to #121: Ship waits on the steps Build (done) and Sign; Doc waits on Sign. */
function seed(d: Database.Database) {
  upsertBoard(d, {
    ...SCOPE, stream: 'release', title: 'Release', repo: REPO, issuePin: { repo: REPO, number: 121 },
    rows: [
      { label: 'Build', status: 'done', issue: { repo: REPO, number: 119 } },
      { label: 'Sign', status: 'tracked', issue: { repo: REPO, number: 120 } },
      { label: 'Ship', status: 'partial', issue: { repo: REPO, number: 121 }, waits_on: ['Build', 'Sign'] },
      { label: 'Doc', status: 'tracked', waits_on: ['Sign'] },
    ],
  })
  // #121 waits on #119 (still open on GitHub) and #120, not the closed #118, and unblocks #130
  cacheDeps(d, 121, [open(119), open(120), facts(K(118), { state: 'CLOSED', state_reason: 'COMPLETED', title: 'Closed blocker' })], [open(130)])
  const plan = getBoard(d, 'agent-inbox', 'Release')!
  const id = (label: string) => plan.rows.find((r) => r.label === label)!.id
  return { plan, id }
}

type Mode = 'graph' | '404'
async function boot(d: Database.Database): Promise<{ set(mode: Mode): void }> {
  let mode: Mode = 'graph'
  await bootApp(d, {
    interceptFetch: async (input, _init, next) => {
      if (route(input) === '/api/issues' && mode === '404') return new Response('<!doctype html><title>Not found</title>', { status: 404 })
      return next()
    },
  })
  return { set(next) { mode = next } }
}

async function showPlans(): Promise<void> {
  click(document.querySelector('.tab[data-tab="boards"]'))
  await settle()
}

const card = (id: string): HTMLElement => document.querySelector<HTMLElement>(`#boards [data-card-id="${id}"]`)!
const matrixRow = (planId: string, rowId: string): HTMLElement => card(planId).querySelector<HTMLElement>(`.board-row[data-row-id="${rowId}"]`)!
const waitsChip = (scope: ParentNode): HTMLElement | null => scope.querySelector<HTMLElement>('[data-waits-on]')

describe('dependency chips and blocks in Plans (slice 2 PR D)', () => {
  it('draws the plan and row chips, the GitHub section and the row detail, open dependencies only', async () => {
    db = freshDb()
    const { plan, id } = seed(db)
    await boot(db)
    await showPlans()

    // the plan's own issue waits on #119 and #120, beside its issue chip
    const planChip = waitsChip(card(plan.id).querySelector('.board-source')!)!
    expect(planChip.textContent).toBe('waits on 2')
    expect(planChip.previousElementSibling?.getAttribute('data-issue-key')).toBe(K(121))

    // Ship: the step Sign and its issue #120 are one entry; Build is done, but #119 is open on GitHub
    const ship = waitsChip(matrixRow(plan.id, id('Ship')).querySelector('.row-note')!)!
    expect(ship.textContent).toBe('waits on 2')
    expect(ship.getAttribute('tabindex')).toBe('-1')
    expect(ship.title).toBe('Waits on:\nstep Sign (#120 Issue 120) — step in this plan · GitHub\n#119 Issue 119 — GitHub\nchecked just now')
    expect(ship.previousElementSibling?.getAttribute('data-issue-key')).toBe(K(121))
    expect(waitsChip(matrixRow(plan.id, id('Doc')))?.textContent).toBe('waits on step Sign')
    // Build is done, so hidden; were it shown, it would wait on nothing
    expect(waitsChip(matrixRow(plan.id, id('Sign')))).toBeNull()

    // "Dependencies on GitHub" below the sub-issues, with Agent Inbox activity
    const section = card(plan.id).querySelector('.board-issues .src-deps')!
    expect(section.querySelector('.src-children-head')?.textContent).toBe('Dependencies on GitHub')
    const list = (name: string) => section.querySelector(`ul[aria-label="${name}"]`)!
    const entries = (name: string) => [...list(name).querySelectorAll('li')].map((li) => li.textContent)
    expect(entries('Waits on')).toEqual(['●#119Issue 119Done here', '●#120Issue 120Active · copilot · Sign'])
    expect(entries('Unblocks')).toEqual(['●#130Issue 130None here'])
    expect(section.textContent).not.toMatch(/Closed blocker|Circular|blocked/i)

    // the row detail lists both kinds, each with its source
    click(matrixRow(plan.id, id('Ship')))
    await settle()
    const detail = document.querySelector(`.row-panel-row[data-row-id="${id('Ship')}"] .src-waits`)!
    expect([...detail.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'step Sign●#120Issue 120step in this plan · GitHub',
      '●#119Issue 119GitHub',
    ])
  })

  it('keeps the steps and drops every GitHub part when /api/issues is gone, then draws them again', async () => {
    db = freshDb()
    const { plan, id } = seed(db)
    const viewer = await boot(db)
    viewer.set('404')
    await pollTick()
    await showPlans()
    expect(document.getElementById('status')?.textContent).toBe('')
    expect(waitsChip(card(plan.id).querySelector('.board-source')!)).toBeNull()
    expect(card(plan.id).querySelector('.board-issues')).toBeNull()
    expect(waitsChip(matrixRow(plan.id, id('Ship')))?.textContent).toBe('waits on step Sign')
    expect(waitsChip(matrixRow(plan.id, id('Doc')))?.textContent).toBe('waits on step Sign')

    viewer.set('graph')
    await pollTick()
    expect(waitsChip(matrixRow(plan.id, id('Ship')))?.textContent).toBe('waits on 2')
  })

  it('dims chips once the answer is stale, and hides the GitHub half after seven days', async () => {
    db = freshDb()
    const { plan, id } = seed(db)
    await boot(db)
    await showPlans()
    advanceClock(45 * 60_000)
    await pollTick()
    const stale = waitsChip(matrixRow(plan.id, id('Ship')))!
    expect(stale.className).toBe('src-chip tone-stale')
    expect(stale.title).toContain('as of 45m ago')
    expect(card(plan.id).querySelector('.board-issues .src-deps')?.textContent).toContain('Waits on')

    advanceClock(8 * 24 * 60 * 60_000)
    await pollTick()
    expect(waitsChip(matrixRow(plan.id, id('Ship')))?.textContent).toBe('waits on step Sign')
    expect(waitsChip(card(plan.id).querySelector('.board-source')!)).toBeNull()
    expect(card(plan.id).querySelector('.src-deps')).toBeNull()
  })

  it('keeps a draft, its focus and the expanded row through a poll that changes dependencies', async () => {
    db = freshDb()
    const { plan, id } = seed(db)
    await boot(db)
    await showPlans()
    click(matrixRow(plan.id, id('Doc')))
    await settle()
    const panel = () => document.querySelector(`.row-panel-row[data-row-id="${id('Doc')}"]`)
    const input = panel()!.querySelector<HTMLTextAreaElement>('textarea')!
    input.focus()
    type(input, 'Half-typed note')

    advanceClock(60_000)
    cacheDeps(db, 121, [open(119), open(120), open(122)], [open(130)])
    await pollTick()
    expect(panel()!.querySelector('textarea')).toBe(input)
    expect(input.value).toBe('Half-typed note')
    expect(document.activeElement).toBe(input)
    expect(waitsChip(matrixRow(plan.id, id('Ship')))?.textContent).toBe('waits on 2')

    type(input, '')
    await settle()
    expect(waitsChip(matrixRow(plan.id, id('Ship')))?.textContent).toBe('waits on 3')
    expect(panel()).not.toBeNull()
  })
})
