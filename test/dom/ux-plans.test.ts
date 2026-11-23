// @vitest-environment jsdom
// UX pass, slice 3: Plans as bars (design-v2). A plan is one line; its card
// stays the same <details>; the page sorts plans into Needs you, Moving and a
// Stalled fold; a plan is drawn closed, brief or full; Archive all clears the
// fold; Home's lane draws the same bar.
//
// The test DOM finds and focuses elements inside a closed <details> and ignores
// CSS, while a real browser does not: every "the person can reach it" below is
// asserted as openness (`closest('[hidden], details:not([open])') === null`).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'
import {
  annotateBoardRow, archiveBoard, getBoard, getBoardByTitle, pinBoardRow, snoozeBoardRow, unarchiveBoard, upsertActivity,
  upsertBoard,
} from '../../src/store.js'
import {
  advanceClock, bootApp, buttonLabelled, changedPollTick, click, freshDb, navigateToHash, pollTick, reach, repaint, row,
  searchFor, settle, showInbox, type, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
  vi.restoreAllMocks()
})

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const
const DAY = 24 * 60 * 60 * 1000
type Rows = Parameters<typeof upsertBoard>[1]['rows']

function plan(d: Database.Database, title: string, rows: Rows, extra: Partial<Parameters<typeof upsertBoard>[1]> = {}) {
  advanceClock()
  upsertBoard(d, { ...AGENT, title, rows, ...extra })
  return getBoard(d, AGENT.project, title)!
}
/** An agent's next write to a plan. */
function rewrite(d: Database.Database, title: string, rows: Rows): void {
  const before = getBoard(d, AGENT.project, title)!
  const revision = (label: string) => before.rows.find((r) => r.label === label)?.revision
  advanceClock()
  upsertBoard(d, { ...AGENT, title, rows: rows.map((r) => ({ ...r, revision: revision(r.label) })), expectedVersion: before.revision })
}
const tracked = (label = 'Track'): Rows[number] => ({ label, status: 'tracked' })
const asks = (label = 'Choose'): Rows[number] => ({ label, status: 'blocked', note: 'Choose now.' })

async function showPlans(): Promise<void> {
  click(document.querySelector('.tab[data-tab="boards"]'))
  await settle()
}
const card = (id: string) => document.querySelector<HTMLDetailsElement>(`#boards [data-card-id="${id}"]`)
const summary = (id: string) => card(id)!.querySelector<HTMLElement>(':scope > summary')!
const stepRow = (rowId: string) => document.querySelector<HTMLElement>(`#boards tr.board-row[data-row-id="${rowId}"]`)
const panelRow = (rowId: string) => document.querySelector<HTMLElement>(`#boards tr.row-panel-row[data-row-id="${rowId}"]`)
/** Seen by a person: nothing above it is hidden or a closed <details> (a summary shows while its own is closed). */
const shown = (el: Element | null | undefined): boolean => {
  if (!el) return false
  const from = el.matches('details > summary') ? el.parentElement!.parentElement : el
  return !from || from.closest('[hidden], details:not([open])') === null
}
const boardsChildren = () => [...document.querySelector('#boards .boards')!.children] as HTMLElement[]
const activePlanIds = () => boardsChildren().filter((el) => el.matches('[data-card-id]')).map((el) => el.dataset['cardId'])
/** What a sighted person reads: the text without the words kept for a screen reader. */
const visibleText = (el: Element | null | undefined): string | undefined => {
  if (!el) return undefined
  const copy = el.cloneNode(true) as Element
  for (const hidden of copy.querySelectorAll('.visually-hidden')) hidden.remove()
  return copy.textContent ?? undefined
}
const sectionHeads = () => [...document.querySelectorAll<HTMLElement>('#boards .plan-section-head')].map((el) => visibleText(el))
const stalledFold = () => document.querySelector<HTMLDetailsElement>('#boards .stalled-fold')
const archiveAll = () => document.getElementById('plans-archive-stalled') as HTMLButtonElement | null
const notice = () => document.querySelector<HTMLElement>('#boards .plans-notice')
const archivePosts = (bridge: { posts: Array<{ url: string; init: RequestInit | undefined }> }) =>
  bridge.posts.filter((p) => /\/api\/boards\/[^/]+\/archive$/.test(p.url))
/** The two presses of Archive all: arm, wait out the double-click guard, confirm. */
async function armAndConfirm(): Promise<void> {
  click(archiveAll())
  await vi.advanceTimersByTimeAsync(500)
  click(archiveAll())
}
/** What a browser does for Enter or Space on a focused summary: the key, then a click unless the key was taken. */
function pressOn(el: HTMLElement, key: 'Enter' | ' '): void {
  el.focus()
  const down = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  if (el.dispatchEvent(down)) el.click()
}
/** A plan the caller ages past a week with advanceClock(8 * DAY) before boot. */
const oldPlan = plan
function twoQuietPlans(d: Database.Database) {
  const a = oldPlan(d, 'Quiet A', [tracked('A step')])
  const b = oldPlan(d, 'Quiet B', [tracked('B step')])
  advanceClock(8 * DAY)
  return { a, b }
}

describe('a plan is one line (D1, D2)', () => {
  it('draws the project dot, the title, the bar with its words, "3 of 7" hidden from speech and a chevron; nothing else', async () => {
    db = freshDb()
    const b = plan(db, 'Staging environment', [
      { label: 'Provision', status: 'done' }, { label: 'Domain', status: 'done' }, { label: 'Pipeline', status: 'done' },
      asks('Choose the database'), { label: 'Deploy', status: 'partial' }, tracked('Smoke test'), { label: 'Hand over', status: 'missing' },
      { label: 'Skip', status: 'na' },
    ])
    await bootApp(db)
    await showPlans()
    const line = summary(b.id)
    expect([...line.children].map((el) => el.className)).toEqual(['proj-dot', 'board-title', 'plan-bar', 'plan-count', 'plan-chevron'])
    expect(line.querySelector('.board-title')?.textContent).toBe('Staging environment')
    const bar = line.querySelector<HTMLElement>('.plan-bar')!
    expect(bar.getAttribute('role')).toBe('img')
    expect(bar.getAttribute('aria-label')).toBe('3 of 7 steps done, 1 needs you, 1 in progress')
    expect([...bar.children].map((seg) => (seg as HTMLElement).dataset['state']))
      .toEqual(['done', 'done', 'done', 'needs', 'progress', 'todo', 'todo'])
    const count = line.querySelector('.plan-count')!
    expect(count.textContent).toBe('3 of 7')
    expect(count.getAttribute('aria-hidden')).toBe('true')
    expect(line.querySelector('button, a, input, select, textarea')).toBeNull()
    // the meta line is the full plan's alone
    const meta = card(b.id)!.querySelector<HTMLElement>(':scope > .board-meta')!
    expect(card(b.id)!.dataset['form']).toBe('brief')
    expect(shown(meta)).toBe(false)
    click(summary(b.id))
    await settle()
    const full = card(b.id)!.querySelector<HTMLElement>(':scope > .board-meta')!
    expect(card(b.id)!.dataset['form']).toBe('full')
    expect(shown(full)).toBe(true)
    expect(full.textContent).toContain(`#${b.id.slice(0, 6)}`)
    expect(full.textContent).toContain('alpha · main · copilot')
    expect(full.textContent).toContain('50% weighted')
    expect(full.querySelector('button.hidden-hint')?.textContent).toBe('3 done hidden — show')
  })

  it('a plan with no counted step has an empty track that says so', async () => {
    db = freshDb()
    const b = plan(db, 'Nothing yet', [{ label: 'Skip', status: 'na' }])
    await bootApp(db)
    await showPlans()
    const bar = summary(b.id).querySelector<HTMLElement>('.plan-bar')!
    expect(bar.children).toHaveLength(0)
    expect(bar.getAttribute('aria-label')).toBe('No steps to count')
  })
})

describe('sections (D3)', () => {
  it('puts Needs you first with its count in the header line, then Moving, then the Stalled fold; plans are the list’s own children', async () => {
    db = freshDb()
    const stalled = oldPlan(db, 'Quiet plan', [tracked()])
    advanceClock(8 * DAY)
    const m1 = plan(db, 'Moving one', [tracked()])
    const n1 = plan(db, 'Needs one', [asks()])
    const m2 = plan(db, 'Moving two', [{ label: 'Build', status: 'partial' }])
    await bootApp(db)
    await showPlans()
    const kids = boardsChildren()
    expect(kids[0]!.matches('.tab-header')).toBe(true)
    // the first heading sits in the header's line, beside View
    expect(visibleText(kids[0]!.querySelector('.plans-head > .plan-section-head'))).toBe('Needs you 1')
    expect(kids[0]!.querySelector('.plans-head > #plans-view-toggle')).not.toBeNull()
    expect(kids.slice(1).map((el) => el.dataset['cardId'] ?? el.className)).toEqual([
      n1.id, 'plan-section-head', m2.id, m1.id, 'stalled-fold',
    ])
    expect(sectionHeads()).toEqual(['Needs you 1', 'Moving'])
    // no wrapper, no <section> and no id between the list and a plan; the fold has no id
    for (const id of [n1.id, m1.id, m2.id]) expect(card(id)!.parentElement!.matches('#boards .boards')).toBe(true)
    expect(card(stalled.id)!.parentElement).toBe(stalledFold())
    expect(stalledFold()!.parentElement!.matches('#boards .boards')).toBe(true)
    expect(stalledFold()!.id).toBe('')
    expect(document.querySelector('#boards .boards section, #boards .boards [data-card-id] ~ [id]:not(button)')).toBeNull()
  })

  it('has no sections while Group by parent issue is on', async () => {
    db = freshDb()
    localStorage.setItem('agent-inbox-group-plans', 'true')
    oldPlan(db, 'Quiet plan', [tracked()])
    advanceClock(8 * DAY)
    plan(db, 'Moving one', [tracked()])
    plan(db, 'Needs one', [asks()])
    await bootApp(db)
    await showPlans()
    expect(sectionHeads()).toEqual([])
    expect(stalledFold()).toBeNull()
    expect(activePlanIds()).toHaveLength(3)
  })
})

describe('forms (D5)', () => {
  it('draws a Needs-you plan nobody touched brief: its waiting step, no chips or actions, and no "All N steps" button', async () => {
    db = freshDb()
    const b = plan(db, 'Release', [{ label: 'Tag', status: 'done' }, asks('Approve'), tracked('Publish'), { label: 'Notes', status: 'partial' }])
    const [, ask, publish, notes] = b.rows
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await showPlans()
    const el = card(b.id)!
    expect(el.open).toBe(true)
    expect(el.dataset['form']).toBe('brief')
    expect(shown(stepRow(ask!.id))).toBe(true)
    expect(shown(stepRow(publish!.id))).toBe(false)
    expect(shown(stepRow(notes!.id))).toBe(false)
    expect(el.querySelector('.plan-all-steps')).toBeNull()
    expect(el.querySelector('[id^="plan-all-"]')).toBeNull()
    expect(el.textContent).not.toMatch(/All \d+ steps/)
    for (const part of el.querySelectorAll('.board-meta, .board-source, .board-issues, .actions')) expect(shown(part)).toBe(false)
    summary(b.id).focus()
    click(summary(b.id))
    await settle()
    expect(card(b.id)!.dataset['form']).toBe('full')
    expect(document.activeElement).toBe(summary(b.id))
    expect(shown(stepRow(publish!.id))).toBe(true)
    expect(shown(buttonLabelled('Plan flow', card(b.id)!))).toBe(true)
  })

  it('a summary click opens a collapsed plan in full and collapses a full one, by mouse, Enter and Space', async () => {
    db = freshDb()
    const moving = plan(db, 'Moving', [tracked()])
    const waiting = plan(db, 'Waiting', [asks()])
    await bootApp(db)
    await showPlans()
    expect(card(moving.id)!.dataset['form']).toBe('closed')
    expect(card(moving.id)!.open).toBe(false)
    click(summary(moving.id))
    await settle()
    expect(card(moving.id)!.dataset['form']).toBe('full')
    expect(card(moving.id)!.open).toBe(true)
    click(summary(moving.id))
    await settle()
    expect(card(moving.id)!.open).toBe(false)
    pressOn(summary(moving.id), 'Enter')
    await settle()
    expect(card(moving.id)!.dataset['form']).toBe('full')
    pressOn(summary(moving.id), ' ')
    await settle()
    expect(card(moving.id)!.dataset['form']).toBe('closed')
    // a plan waiting on the person: brief → click → full → click → brief again, never closed
    expect(card(waiting.id)!.dataset['form']).toBe('brief')
    pressOn(summary(waiting.id), ' ')
    await settle()
    expect(card(waiting.id)!.dataset['form']).toBe('full')
    pressOn(summary(waiting.id), 'Enter')
    await settle()
    expect(card(waiting.id)!.dataset['form']).toBe('brief')
    expect(card(waiting.id)!.open).toBe(true)
    expect(shown(stepRow(waiting.rows[0]!.id))).toBe(true)
    click(summary(waiting.id))
    await settle()
    click(summary(waiting.id))
    await settle()
    expect(card(waiting.id)!.dataset['form']).toBe('brief')
    expect(shown(stepRow(waiting.rows[0]!.id))).toBe(true)
  })

  it('a plan with a step in hand collapses to brief, not closed; once the step is let go it collapses to closed', async () => {
    db = freshDb()
    const b = plan(db, 'Docs', [tracked('One'), tracked('Two')])
    await bootApp(db)
    await showPlans()
    click(summary(b.id))
    await settle()
    click(stepRow(b.rows[0]!.id)!.querySelector('.row-expand'))
    await settle()
    // collapsing closes the open step and lets it go: nothing is in hand, so the plan closes
    click(summary(b.id))
    await settle()
    expect(card(b.id)!.dataset['form']).toBe('closed')
    // a typed, unsent answer is in hand: collapsing leaves the plan brief with that step shown
    click(summary(b.id))
    await settle()
    click(stepRow(b.rows[1]!.id)!.querySelector('.row-expand'))
    await settle()
    type(panelRow(b.rows[1]!.id)!.querySelector<HTMLTextAreaElement>('.reply-input'), 'Half an answer')
    click(summary(b.id))
    await settle()
    expect(card(b.id)!.dataset['form']).toBe('brief')
    expect(card(b.id)!.open).toBe(true)
    expect(shown(stepRow(b.rows[1]!.id))).toBe(true)
    expect(shown(stepRow(b.rows[0]!.id))).toBe(false)
    expect(panelRow(b.rows[1]!.id)).toBeNull()
    // typed text counts as kept (RT-4)
    expect(card(b.id)!.querySelector('.plan-all-steps')).toBeNull()
  })

  it('never saves a default open: a brief plan whose ask resolves elsewhere is closed, in Moving', async () => {
    db = freshDb()
    const b = plan(db, 'Waiting', [asks()])
    await bootApp(db)
    await showPlans()
    expect(card(b.id)!.dataset['form']).toBe('brief')
    expect(annotateBoardRow(db, b.rows[0]!.id, 'Go ahead.')).toBe(true)
    await pollTick()
    expect(card(b.id)!.dataset['section']).toBe('moving')
    expect(card(b.id)!.dataset['form']).toBe('closed')
    expect(card(b.id)!.open).toBe(false)
  })

  it('keeps the person’s choice across repaints and a change of section', async () => {
    db = freshDb()
    const b = plan(db, 'Moving', [tracked()])
    await bootApp(db)
    await showPlans()
    click(summary(b.id))
    await settle()
    await repaint()
    expect(card(b.id)!.dataset['form']).toBe('full')
    // a new ask moves it to Needs you; the choice holds
    rewrite(db, 'Moving', [tracked(), asks()])
    await pollTick()
    expect(card(b.id)!.dataset['section']).toBe('needs')
    expect(card(b.id)!.dataset['form']).toBe('full')
    click(summary(b.id))
    await settle()
    await changedPollTick(db)
    expect(card(b.id)!.dataset['section']).toBe('needs')
    // collapsed, and a plan in Needs you never collapses past brief
    expect(card(b.id)!.dataset['form']).toBe('brief')
  })

  it('six Needs-you plans of 11 steps show no meta line, chips, relations or actions at rest', async () => {
    db = freshDb()
    const ids: string[] = []
    for (let i = 0; i < 6; i++) {
      const rows: Rows = Array.from({ length: 10 }, (_, n) => ({ label: `Step ${n}`, status: n < 4 ? 'done' : 'tracked' }))
      rows.push(asks(`Choose ${i}`))
      ids.push(plan(db, `Plan ${i}`, rows, { repo: 'shariqh/agent-inbox', issuePin: { repo: 'shariqh/agent-inbox', number: 100 + i } }).id)
    }
    await bootApp(db)
    await showPlans()
    expect(sectionHeads()).toEqual(['Needs you 6'])
    for (const id of ids) {
      expect(card(id)!.dataset['form']).toBe('brief')
      const parts = [...card(id)!.querySelectorAll('.board-meta, .board-source, .board-issues, .actions')]
      expect(parts.length).toBeGreaterThanOrEqual(2)
      for (const part of parts) expect(shown(part), part.className).toBe(false)
      expect([...card(id)!.querySelectorAll('tr.board-row')].filter(shown)).toHaveLength(1)
    }
  })
})

describe('holding a plan in place under the hand (D5)', () => {
  it('keeps a plan answered from Plans in Needs you, in its place, until the person leaves; a new ask still moves a plan up', async () => {
    db = freshDb()
    const older = plan(db, 'Older ask', [asks('Pick a date')])
    const moving = plan(db, 'Moving', [tracked()])
    const newer = plan(db, 'Newer ask', [asks('Pick a name')])
    await bootApp(db)
    await showPlans()
    expect(activePlanIds()).toEqual([newer.id, older.id, moving.id])
    const rowId = older.rows[0]!.id
    click(buttonLabelled('Answer', stepRow(rowId)!))
    await settle()
    type(panelRow(rowId)!.querySelector<HTMLTextAreaElement>('.reply-input'), 'Thursday.')
    click(buttonLabelled('Send', panelRow(rowId)!))
    await settle()
    expect(getBoard(db, 'alpha', 'Older ask')!.rows[0]!.annotation).toBe('Thursday.')
    expect(activePlanIds()).toEqual([newer.id, older.id, moving.id])
    expect(card(older.id)!.dataset['section']).toBe('needs')
    // the count is the plans still asking
    expect(sectionHeads()[0]).toBe('Needs you 1')
    await changedPollTick(db)
    await changedPollTick(db)
    expect(activePlanIds()).toEqual([newer.id, older.id, moving.id])
    // a plan that gains an ask during the visit still moves into Needs you
    rewrite(db, 'Moving', [tracked(), asks('Late ask')])
    await pollTick()
    expect(card(moving.id)!.dataset['section']).toBe('needs')
    expect(activePlanIds()).toEqual([newer.id, older.id, moving.id])
    // leaving Plans ends the hold
    await showInbox()
    await showPlans()
    expect(card(older.id)!.dataset['section']).toBe('moving')
  })
})

describe('step marks (D4)', () => {
  it('marks each state, says why a blocked step does not need you, and tints only the step that does', async () => {
    db = freshDb()
    localStorage.setItem('agent-inbox-hide-completed', 'false')
    plan(db, 'Marks', [
      { label: 'Done', status: 'done' }, { label: 'Going', status: 'partial' }, asks('Waits'), asks('Answered'),
      asks('Snoozed'), asks('Pinned'), { label: 'Missing', status: 'missing' }, tracked('Tracked'),
    ])
    const rowOf = (label: string) => getBoard(db!, 'alpha', 'Marks')!.rows.find((r) => r.label === label)!
    expect(annotateBoardRow(db, rowOf('Answered').id, 'Yes.')).toBe(true)
    const until = new Date(Date.now() + DAY).toISOString()
    expect(snoozeBoardRow(db, rowOf('Snoozed').id, until)).toBe(true)
    const board = getBoard(db, 'alpha', 'Marks')!
    expect(pinBoardRow(db, rowOf('Pinned').id, true, rowOf('Pinned').revision, board.revision)).toBe(true)
    await bootApp(db)
    await showPlans()
    const mark = (label: string) => {
      const el = stepRow(rowOf(label).id)!.querySelector<HTMLElement>('.row-glyph .step-mark')!
      return [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title') === el.getAttribute('aria-label')]
    }
    expect(mark('Done')).toEqual(['✓', 'Done', true])
    expect(mark('Going')).toEqual(['◐', 'In progress', true])
    expect(mark('Waits')).toEqual(['●', 'Needs you', true])
    expect(mark('Answered')).toEqual(['◯', 'Answered, waiting for the agent · not yet delivered', true])
    expect(mark('Snoozed')).toEqual(['◯', `Set aside until ${new Date(until).toLocaleString()}`, true])
    expect(mark('Pinned')).toEqual(['◯', 'Pinned for later', true])
    expect(mark('Missing')).toEqual(['×', 'Missing', true])
    expect(mark('Tracked')).toEqual(['○', 'To do', true])
    const tinted = [...document.querySelectorAll<HTMLElement>('#boards tr.needs-answer')].map((tr) => tr.dataset['rowId'])
    expect(tinted).toEqual([rowOf('Waits').id])
  })

  it('an archived plan’s blocked step takes the to-do mark and nothing needs you', async () => {
    db = freshDb()
    const b = plan(db, 'Shelved', [asks('Waits'), tracked()])
    expect(archiveBoard(db, b.id, b.revision)).toBe(true)
    await bootApp(db)
    await showPlans()
    click(document.querySelector('#boards .archived-fold > summary'))
    await settle()
    await pollTick()
    const archived = card(b.id)!
    expect(archived.classList.contains('archived')).toBe(true)
    const mark = archived.querySelector<HTMLElement>(`tr[data-row-id="${b.rows[0]!.id}"] .step-mark`)!
    expect([mark.textContent, mark.getAttribute('aria-label')]).toEqual(['○', 'To do'])
    expect(archived.querySelector('tr.needs-answer')).toBeNull()
    expect(archived.querySelector('.plan-bar')?.getAttribute('aria-label')).toBe('0 of 2 steps done')
  })
})

describe('the Stalled fold (D6)', () => {
  it('folds plans a week without a step, closed by default, says how many, and keeps out what is still in motion', async () => {
    db = freshDb()
    const quiet = oldPlan(db, 'Quiet', [tracked()])
    const noted = oldPlan(db, 'Noted', [tracked('Has a note')])
    const live = oldPlan(db, 'Live', [tracked()], { session: 'live-session' })
    expect(annotateBoardRow(db, noted.rows[0]!.id, 'Remember the docs.')).toBe(true)
    advanceClock(8 * DAY)
    upsertActivity(db, { session: 'live-session', project: 'alpha', stream: 'main', agent: 'copilot', doing: 'open', idle: true, claim: false })
    await bootApp(db)
    await showPlans()
    const fold = stalledFold()!
    expect(fold.open).toBe(false)
    expect(fold.querySelector('summary')?.id).toBe('plans-stalled-summary')
    expect(fold.querySelector('summary h3')?.textContent).toBe('Stalled')
    expect(fold.querySelector('summary .stalled-count')?.textContent).toBe('1 plan, a week without a step')
    expect([...fold.querySelectorAll<HTMLElement>('[data-card-id]')].map((el) => el.dataset['cardId'])).toEqual([quiet.id])
    // the undelivered note and the live session keep theirs Moving
    expect(card(noted.id)!.dataset['section']).toBe('moving')
    expect(card(live.id)!.dataset['section']).toBe('moving')
  })

  it('says "plans" for more than one and opens for a deep link, staying open across polls', async () => {
    db = freshDb()
    const first = oldPlan(db, 'First quiet', [tracked()])
    oldPlan(db, 'Second quiet', [tracked()])
    advanceClock(8 * DAY)
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await showPlans()
    expect(stalledFold()!.querySelector('.stalled-count')?.textContent).toBe('2 plans, a week without a step')
    navigateToHash(`#item/${first.id}`)
    await settle()
    expect(stalledFold()!.open).toBe(true)
    expect(card(first.id)!.open).toBe(true)
    expect(document.activeElement).toBe(summary(first.id))
    await changedPollTick(db)
    expect(stalledFold()!.open).toBe(true)
    expect(card(first.id)!.dataset['form']).toBe('full')
  })
})

describe('Archive all (D6)', () => {
  function twoQuiet(d: Database.Database) {
    const a = oldPlan(d, 'Quiet A', [tracked('A step')])
    const b = oldPlan(d, 'Quiet B', [tracked('B step')])
    advanceClock(8 * DAY)
    return { a, b }
  }
  async function openFold(): Promise<void> {
    click(stalledFold()!.querySelector('summary'))
    await settle()
    expect(stalledFold()!.open).toBe(true)
  }

  it('arms in place without replacing the button, keeps its label across a repaint, and disarms after 4 seconds', async () => {
    db = freshDb()
    twoQuiet(db)
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await showPlans()
    await openFold()
    const button = archiveAll()!
    expect(button.textContent).toBe('Archive all 2 plans')
    button.focus()
    click(button)
    expect(archiveAll()).toBe(button)
    expect(button.textContent).toBe('Really archive 2 plans?')
    await changedPollTick(db)
    expect(archiveAll()!.textContent).toBe('Really archive 2 plans?')
    expect(document.activeElement).toBe(archiveAll())
    await vi.advanceTimersByTimeAsync(4000)
    expect(archiveAll()!.textContent).toBe('Archive all 2 plans')
  })

  it('posts each listed plan once at the revision drawn, ignores clicks while it runs, and reports what changed', async () => {
    db = freshDb()
    const { a, b } = twoQuiet(db)
    let release: () => void = () => {}
    const parked = new Promise<void>((resolve) => { release = resolve })
    let first = true
    const bridge = await bootApp(db, {
      interceptFetch: async (input, init, next) => {
        if (init?.method === 'POST' && /\/archive$/.test(String(input)) && first) {
          first = false
          await parked
        }
        return next()
      },
    })
    await showPlans()
    await openFold()
    await armAndConfirm()
    await vi.advanceTimersByTimeAsync(0)
    expect(archiveAll()!.textContent).toBe('Archiving 2 plans…')
    expect(archiveAll()!.getAttribute('aria-disabled')).toBe('true')
    // a second click while it runs posts nothing
    click(archiveAll())
    await vi.advanceTimersByTimeAsync(0)
    expect(archivePosts(bridge)).toHaveLength(1)
    // mid-loop, an agent gives Quiet A (still to be posted) an ask: a new revision
    const drawnRevision = getBoard(db, 'alpha', 'Quiet A')!.revision
    rewrite(db, 'Quiet A', [tracked('A step'), asks('A late ask')])
    await pollTick()
    release()
    await settle()
    const posts = archivePosts(bridge)
    expect(posts.map((p) => p.url)).toEqual([`/api/boards/${b.id}/archive`, `/api/boards/${a.id}/archive`])
    expect(JSON.parse(String(posts[1]!.init?.body))).toEqual({ expected_version: drawnRevision })
    expect(getBoard(db, 'alpha', 'Quiet A')!.status).toBe('active')
    expect(card(a.id)!.dataset['section']).toBe('needs')
    expect(notice()?.textContent).toContain('Archived 1 of 2 plans. 1 had changed since you looked and was left as it is.')
    expect(archiveAll()).toBeNull()
  })

  it('keeps a plan holding unsent text, says so, keeps the notice across polls until Dismiss, and never lingers an archived plan', async () => {
    db = freshDb()
    const { a, b } = twoQuiet(db)
    // an un-archived complete plan, quiet for a week: it would linger as "completed — archived"
    advanceClock()
    upsertBoard(db, { ...AGENT, title: 'Complete', rows: [{ label: 'All done', status: 'done' }] })
    const complete = getBoardByTitle(db, 'alpha', 'Complete')!
    expect(complete.status).toBe('archived')
    expect(unarchiveBoard(db, complete.id, complete.revision)).toBe(true)
    advanceClock(8 * DAY)
    const bridge = await bootApp(db)
    await showPlans()
    await openFold()
    expect(stalledFold()!.querySelector('.stalled-count')?.textContent).toBe('3 plans, a week without a step')
    // open Quiet A and type in its step
    click(summary(a.id))
    await settle()
    const stepId = a.rows[0]!.id
    click(stepRow(stepId)!.querySelector('.row-expand'))
    await settle()
    type(panelRow(stepId)!.querySelector<HTMLTextAreaElement>('.reply-input'), 'Not yet sent')
    await armAndConfirm()
    await settle()
    // newest first, as the fold drew them; Quiet A holds unsent text and is not posted
    expect(archivePosts(bridge).map((p) => p.url)).toEqual([`/api/boards/${complete.id}/archive`, `/api/boards/${b.id}/archive`])
    expect(notice()?.getAttribute('role')).toBe('status')
    expect(notice()?.textContent).toContain('Archived 2 of 3 plans. 1 has text you have not sent and was kept.')
    expect(card(a.id)).not.toBeNull()
    expect(getBoard(db, 'alpha', 'Quiet A')!.status).toBe('active')
    // nothing it archived lingers as "completed — archived"
    expect(document.querySelectorAll('#boards .board.lingering')).toHaveLength(0)
    await changedPollTick(db)
    await changedPollTick(db)
    expect(notice()?.textContent).toContain('Archived 2 of 3 plans.')
    click(buttonLabelled('Dismiss', notice()!))
    expect(notice()).toBeNull()
    await changedPollTick(db)
    expect(notice()).toBeNull()
  })

  it('moves focus to the Archived plans summary when the fold empties', async () => {
    db = freshDb()
    twoQuiet(db)
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await showPlans()
    await openFold()
    archiveAll()!.focus()
    await armAndConfirm()
    await settle()
    expect(stalledFold()).toBeNull()
    expect(notice()?.textContent).toBe('Archived 2 plans. Dismiss')
    expect(document.activeElement?.id).toBe('plans-archived-summary')
    expect(document.activeElement?.textContent).toBe('Archived plans (2)')
  })
})

describe('the header (D7)', () => {
  it('rests with the first heading and View; View shows the tools, and focus on them survives a changed poll', async () => {
    db = freshDb()
    plan(db, 'Waiting', [asks()])
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await showPlans()
    expect(document.getElementById('pageKicker')?.textContent ?? '').toBe('')
    const tools = () => document.getElementById('plansTools')!
    const view = () => document.getElementById('plans-view-toggle')!
    expect(tools().hidden).toBe(true)
    expect(view().getAttribute('aria-expanded')).toBe('false')
    expect(view().getAttribute('aria-controls')).toBe('plansTools')
    view().focus()
    click(view())
    expect(tools().hidden).toBe(false)
    expect(view().getAttribute('aria-expanded')).toBe('true')
    await changedPollTick(db)
    expect(document.activeElement).toBe(view())
    expect(tools().hidden).toBe(false)
    const hideDone = () => document.getElementById('plans-hide-done')!
    hideDone().focus()
    await changedPollTick(db)
    expect(document.activeElement).toBe(hideDone())
  })

  it('unchecking Group by parent issue with View closed leaves View open and focus on the switch', async () => {
    db = freshDb()
    localStorage.setItem('agent-inbox-group-plans', 'true')
    plan(db, 'Waiting', [asks()])
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await showPlans()
    // grouping forces the tools open
    expect(document.getElementById('plansTools')!.hidden).toBe(false)
    const toggle = () => document.getElementById('group-plans-switch') as HTMLInputElement
    toggle().focus()
    click(toggle())
    await settle()
    expect(toggle().checked).toBe(false)
    expect(document.getElementById('plansTools')!.hidden).toBe(false)
    expect(document.getElementById('plans-view-toggle')!.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(toggle())
  })
})

describe('paging (D8)', () => {
  it('shows 12 Moving plans, then Show N more; a deep link past the page lands drawn and open', async () => {
    db = freshDb()
    const ids: string[] = []
    for (let i = 0; i < 14; i++) ids.unshift(plan(db, `Moving ${i}`, [tracked()]).id)
    plan(db, 'Waiting', [asks()])
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await showPlans()
    expect(activePlanIds().filter((id) => ids.includes(id!))).toEqual(ids.slice(0, 12))
    const more = document.querySelector<HTMLButtonElement>('#boards .boards > .show-more')!
    expect(more.textContent).toBe('Show 2 more (2 hidden)')
    navigateToHash(`#item/${ids[13]}`)
    await settle()
    expect(card(ids[13]!)!.open).toBe(true)
    expect(document.activeElement).toBe(summary(ids[13]!))
    navigateToHash('')
    await showInbox()
    await showPlans()
    click(document.querySelector('#boards .boards > .show-more'))
    await settle()
    expect(activePlanIds().filter((id) => ids.includes(id!))).toEqual(ids)
  })
})

describe('ways in land on a visible step (D5, D9)', () => {
  it('a search hit on a step of a closed plan inside the Stalled fold', async () => {
    db = freshDb()
    const b = oldPlan(db, 'Quiet', [tracked('Auckland deployment lane')])
    advanceClock(8 * DAY)
    await bootApp(db)
    await showPlans()
    expect(stalledFold()!.open).toBe(false)
    await searchFor('Auckland')
    click(document.querySelector(`[data-search-target="${b.id}"]`) ?? [...document.querySelectorAll<HTMLElement>('#searchResults [role="option"]')][0])
    await settle()
    expect(shown(stepRow(b.rows[0]!.id))).toBe(true)
    expect(shown(panelRow(b.rows[0]!.id))).toBe(true)
    await changedPollTick(db)
    expect(shown(stepRow(b.rows[0]!.id))).toBe(true)
  })

  it('a search hit on a step of a Moving plan past the page', async () => {
    db = freshDb()
    const target = plan(db, 'Far plan', [tracked('Wellington lane')])
    for (let i = 0; i < 13; i++) plan(db, `Moving ${i}`, [tracked()])
    await bootApp(db)
    await showPlans()
    expect(card(target.id)).toBeNull()
    await searchFor('Wellington')
    click(document.querySelector(`[data-search-target="${target.id}"]`) ?? [...document.querySelectorAll<HTMLElement>('#searchResults [role="option"]')][0])
    await settle()
    expect(shown(stepRow(target.rows[0]!.id))).toBe(true)
    expect(shown(panelRow(target.rows[0]!.id))).toBe(true)
  })

  it('Plan flow’s "Open in Plans" on a done step with Hide completed on', async () => {
    db = freshDb()
    const b = plan(db, 'Shipped', [{ label: 'Ship it', status: 'done', note: 'Shipped on Monday.' }, tracked('Announce')])
    await bootApp(db)
    await showPlans()
    click(summary(b.id))
    await settle()
    click(buttonLabelled('Plan flow', card(b.id)!))
    await settle()
    const mission = document.getElementById('missionbox')!
    const node = [...mission.querySelectorAll<HTMLElement>('.mission-node')].find((n) => n.textContent?.includes('Ship it'))!
    click(node)
    await settle()
    click(mission.querySelector('.mission-detail-board'))
    await settle()
    const doneRow = b.rows[0]!.id
    expect(shown(stepRow(doneRow))).toBe(true)
    expect(shown(panelRow(doneRow))).toBe(true)
    expect(panelRow(doneRow)!.textContent).toContain('Shipped on Monday.')
  })

  it('Home’s "Plan" button opens the plan and its step wherever the plan sits, leaving the lens as it was', async () => {
    db = freshDb()
    localStorage.setItem('agent-inbox-group-plans', 'true')
    // a visit before these asks: "Updates" can be turned on
    localStorage.setItem('agent-inbox-last-visit', new Date(Date.now() - DAY).toISOString())
    const target = plan(db, 'Oldest ask', [tracked(), { label: 'Decide', status: 'blocked', note: 'Pick.', action_owner: 'decision', next_step: 'Pick one.' }])
    for (let i = 0; i < 6; i++) plan(db, `Ask ${i}`, [asks(`Ask ${i}`)])
    upsertBoard(db, { project: 'beta', stream: 'main', agent: 'copilot', title: 'Beta plan', rows: [tracked()] })
    await bootApp(db)
    // the person's lens: project alpha, Decisions only
    click(document.querySelector('#rail button.rail-tab[data-project="alpha"]'))
    await settle()
    await showInbox()
    click(document.querySelector('.queue-tools-toggle'))
    click(document.querySelector('[data-action-filter="decision"]'))
    await settle()
    expect(document.querySelector('[data-action-filter="decision"]')?.classList.contains('active')).toBe(true)
    click(document.querySelector('[data-changed-filter]'))
    await settle()
    expect(document.querySelector('[data-changed-filter]')?.classList.contains('active')).toBe(true)
    const stepId = target.rows[1]!.id
    click(row(stepId)!.querySelector('.nrow-glyph'))
    await settle()
    await vi.advanceTimersByTimeAsync(50)
    expect(document.querySelector<HTMLElement>('.tab[aria-selected="true"]')?.dataset['tab']).toBe('boards')
    expect(shown(stepRow(stepId))).toBe(true)
    expect(shown(panelRow(stepId))).toBe(true)
    expect(card(target.id)!.dataset['form']).toBe('full')
    // the lens is as the person left it
    expect(document.querySelector('#rail button.rail-tab[data-project="alpha"]')?.getAttribute('aria-selected')).toBe('true')
    await showInbox()
    expect(document.querySelector('[data-action-filter="decision"]')?.classList.contains('active')).toBe(true)
    expect(document.querySelector('[data-changed-filter]')?.classList.contains('active')).toBe(true)
  })

  it('a restored draft on a step of a closed Moving plan', async () => {
    db = freshDb()
    const b = plan(db, 'Docs', [{ label: 'Write notes', status: 'partial', note: 'Drafting.' }, tracked()])
    const step = b.rows[0]!
    localStorage.setItem('agent-inbox-drafts-v1', JSON.stringify({ v: 1, entries: {
      [`row:${step.id}`]: { savedAt: Date.now(), draft: {
        type: 'row', rowId: step.id, boardId: b.id, boardRevision: b.revision, revision: step.revision,
        text: 'Mention the migration.', kind: 'answer', boardTitle: b.title, label: step.label, context: '', blocked: false,
      } },
    } }))
    await bootApp(db)
    await showPlans()
    const input = panelRow(step.id)?.querySelector<HTMLTextAreaElement>('.reply-input')
    expect(input?.value).toBe('Mention the migration.')
    expect(shown(input)).toBe(true)
    expect(card(b.id)!.dataset['section']).toBe('moving')
    expect(card(b.id)!.dataset['form']).toBe('full')
  })

  it('"Use this text" on a step whose plan the person collapsed opens the plan and the step', async () => {
    db = freshDb()
    const b = plan(db, 'Release', [{ label: 'Install test', status: 'blocked', note: 'Ready.', next_step: 'Do the install test.', action_owner: 'task' }, tracked()])
    const rowId = b.rows[0]!.id
    await bootApp(db)
    await showPlans()
    click(summary(b.id))
    await settle()
    click(summary(b.id))
    await settle()
    expect(card(b.id)!.dataset['form']).toBe('brief')
    await showInbox()
    click(row(rowId))
    await settle()
    type(row(rowId)!.querySelector<HTMLTextAreaElement>('.nrow-card .reply-input:not(.reply-context-input)'), 'Half an answer')
    rewrite(db, 'Release', [{ label: 'Install test', status: 'done', note: 'Done by hand.' }, tracked()])
    click(buttonLabelled('Send', row(rowId)!))
    await settle()
    const fold = document.querySelector<HTMLDetailsElement>('#needsYouList .stale-drafts-fold')!
    click(buttonLabelled('Use this text', fold))
    await settle()
    const input = panelRow(rowId)?.querySelector<HTMLTextAreaElement>('.reply-input')
    expect(input?.value).toBe('Half an answer')
    expect(shown(input)).toBe(true)
    expect(card(b.id)!.dataset['form']).toBe('full')
  })
})

describe('Home’s Plans in progress lane (D10)', () => {
  it('keeps the row’s text and draws the plan’s steps in order, as runs past ten', async () => {
    db = freshDb()
    const rows: Rows = [
      { label: 'One', status: 'done' }, { label: 'Two', status: 'done' }, asks('Three'),
      ...Array.from({ length: 8 }, (_, n) => tracked(`Later ${n}`)),
    ]
    const b = plan(db, 'Long plan', rows)
    await bootApp(db)
    const laneRow = document.querySelector<HTMLElement>(`[data-pl-plan="${b.id}"]`)!
    expect(laneRow.querySelector('.pl-count')?.textContent).toBe('2/11')
    expect(laneRow.querySelector('.pl-waiting')?.textContent).toBe('1 needs you')
    const bar = laneRow.querySelector<HTMLElement>('.pl-bar')!
    expect(bar.getAttribute('aria-hidden')).toBe('true')
    expect(bar.classList.contains('runs')).toBe(true)
    expect([...bar.children].map((seg) => [(seg as HTMLElement).dataset['state'], (seg as HTMLElement).style.flexGrow]))
      .toEqual([['done', '2'], ['needs', ''], ['todo', '8']])
  })
})

describe('review fixes: focus and ways in', () => {
  it('a passive focus restore never records a closed plan as opened (CFK-1)', async () => {
    db = freshDb()
    const b = plan(db, 'Waiting', [tracked('First'), asks()])
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await showPlans()
    expect(card(b.id)!.dataset['form']).toBe('brief')
    const answer = buttonLabelled('Answer', stepRow(b.rows[1]!.id)!)!
    answer.focus()
    expect(document.activeElement).toBe(answer)
    // answered from another surface: this poll is not the person's write on Plans
    expect(annotateBoardRow(db, b.rows[1]!.id, 'Go ahead.')).toBe(true)
    await pollTick()
    expect(card(b.id)!.dataset['section']).toBe('moving')
    expect(card(b.id)!.open).toBe(false)
    expect(document.activeElement).toBe(summary(b.id))
    await changedPollTick(db)
    expect(card(b.id)!.dataset['form']).toBe('closed')
  })

  it('Dismiss keeps focus across a poll that rebuilds the notice (CFK-4)', async () => {
    db = freshDb()
    const { a } = twoQuietPlans(db)
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await showPlans()
    click(stalledFold()!.querySelector('summary'))
    await settle()
    click(summary(a.id))
    await settle()
    click(stepRow(a.rows[0]!.id)!.querySelector('.row-expand'))
    await settle()
    type(panelRow(a.rows[0]!.id)!.querySelector<HTMLTextAreaElement>('.reply-input'), 'Not yet sent')
    await armAndConfirm()
    await settle()
    type(panelRow(a.rows[0]!.id)!.querySelector<HTMLTextAreaElement>('.reply-input'), '')
    await vi.advanceTimersByTimeAsync(30_000)
    await changedPollTick(db)
    const dismiss = buttonLabelled('Dismiss', notice()!)!
    expect(dismiss.id).toBe('plans-notice-dismiss')
    dismiss.focus()
    plan(db, 'Fresh plan', [tracked()])
    await pollTick()
    expect(buttonLabelled('Dismiss', notice()!)).not.toBe(dismiss)
    expect(document.activeElement).toBe(document.getElementById('plans-notice-dismiss'))
  })

  describe('a poll that removes the Stalled fold while focus is on it (CFK-7a)', () => {
    for (const control of ['plans-stalled-summary', 'plans-archive-stalled'] as const) {
      it(`${control}: focus goes to the View button`, async () => {
        db = freshDb()
        const q = oldPlan(db, 'Quiet', [tracked()])
        advanceClock(8 * DAY)
        await bootApp(db)
        vi.spyOn(document, 'hasFocus').mockReturnValue(true)
        await showPlans()
        click(stalledFold()!.querySelector('summary'))
        await settle()
        document.getElementById(control)!.focus()
        rewrite(db, 'Quiet', [tracked(), asks('Late ask')])
        await pollTick()
        expect(stalledFold()).toBeNull()
        expect(card(q.id)!.dataset['section']).toBe('needs')
        expect(document.activeElement?.id).toBe('plans-view-toggle')
      })
    }

    it('focus goes to the Archived plans summary when there is one', async () => {
      db = freshDb()
      const shelved = plan(db, 'Shelved', [tracked()])
      expect(archiveBoard(db, shelved.id, shelved.revision)).toBe(true)
      oldPlan(db, 'Quiet', [tracked()])
      advanceClock(8 * DAY)
      await bootApp(db)
      vi.spyOn(document, 'hasFocus').mockReturnValue(true)
      await showPlans()
      document.getElementById('plans-stalled-summary')!.focus()
      rewrite(db, 'Quiet', [tracked(), asks('Late ask')])
      await pollTick()
      expect(stalledFold()).toBeNull()
      expect(document.activeElement?.id).toBe('plans-archived-summary')
    })
  })

  describe('Moving’s Show more (CFK-7b)', () => {
    async function fourteenMoving() {
      db = freshDb()
      const ids: string[] = []
      for (let i = 0; i < 14; i++) ids.unshift(plan(db, `Moving ${i}`, [tracked()]).id)
      await bootApp(db)
      vi.spyOn(document, 'hasFocus').mockReturnValue(true)
      await showPlans()
      return ids
    }
    it('has a stable id, and a changed poll keeps focus on it', async () => {
      await fourteenMoving()
      const more = document.getElementById('plans-moving-more')!
      expect(more.className).toBe('show-more')
      more.focus()
      plan(db!, 'Fresh', [tracked()])
      await pollTick()
      expect(document.activeElement).toBe(document.getElementById('plans-moving-more'))
    })
    it('pressed, with the pager gone, focus lands on the first plan it revealed', async () => {
      const ids = await fourteenMoving()
      const more = document.getElementById('plans-moving-more')!
      more.focus()
      click(more)
      await settle()
      expect(document.getElementById('plans-moving-more')).toBeNull()
      expect(card(ids[12]!)).not.toBeNull()
      expect(document.activeElement).toBe(summary(ids[12]!))
    })
  })

  it('a search hit on a plan’s agent opens the plan in full so the highlight shows (CFK-5, RT-5)', async () => {
    db = freshDb()
    const b = plan(db, 'Waiting', [tracked('First'), asks()], { agent: 'zanzibar-bot' })
    plan(db, 'Other', [tracked()])
    await bootApp(db)
    await showPlans()
    expect(card(b.id)!.dataset['form']).toBe('brief')
    await searchFor('zanzibar')
    click(document.querySelector(`[data-search-target="${b.id}"]`) ?? document.querySelector('#searchResults [role="option"]'))
    await settle()
    await vi.advanceTimersByTimeAsync(50)
    expect(card(b.id)!.dataset['form']).toBe('full')
    const mark = card(b.id)!.querySelector('.search-jump-highlight')
    expect(mark, 'no highlight was drawn').not.toBeNull()
    expect(shown(mark)).toBe(true)
  })

  it('"Use this text" into a step of a plan in a Stalled fold the person closed opens the fold and the plan (SDA-2)', async () => {
    db = freshDb()
    const b = oldPlan(db, 'Quiet', [{ label: 'Write it up', status: 'tracked' }])
    const step = b.rows[0]!
    advanceClock(8 * DAY)
    localStorage.setItem('agent-inbox-drafts-v1', JSON.stringify({ v: 1, entries: {
      [`row-recovery:${step.id}:${step.revision}`]: { savedAt: Date.now(), draft: {
        type: 'row-recovery', rowId: step.id, revision: step.revision, actionVersion: 0,
        text: 'Kept words', kind: 'answer', boardTitle: b.title, label: step.label, context: '',
        setAside: false, choice: false, reason: '',
      } },
    } }))
    await bootApp(db)
    await showPlans()
    // a kept line draws the fold open at rest; the person closes it by hand
    expect(stalledFold()!.open).toBe(true)
    click(stalledFold()!.querySelector('summary'))
    await settle()
    expect(stalledFold()!.open).toBe(false)
    await showInbox()
    click(buttonLabelled('Use this text', document.querySelector('#needsYouList .stale-drafts-fold')!))
    await settle()
    const input = panelRow(step.id)?.querySelector<HTMLTextAreaElement>('.reply-input')
    expect(input?.value).toContain('Kept words')
    expect(shown(input)).toBe(true)
    expect(stalledFold()!.open).toBe(true)
    await changedPollTick(db)
    expect(shown(panelRow(step.id)?.querySelector('.reply-input'))).toBe(true)
  })
})

describe('review fixes: Archive all', () => {
  const quietUp = async (d: Database.Database) => {
    const { a, b } = twoQuietPlans(d)
    const bridge = await bootApp(d)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await showPlans()
    click(stalledFold()!.querySelector('summary'))
    await settle()
    return { a, b, bridge }
  }
  /** Open a plan's only step and send a note from its panel, as the person does. */
  async function sendNote(d: Database.Database, planId: string, stepId: string, text: string): Promise<void> {
    click(summary(planId))
    await settle()
    click(stepRow(stepId)!.querySelector('.row-expand'))
    await settle()
    type(panelRow(stepId)!.querySelector<HTMLTextAreaElement>('.reply-input'), text)
    click(buttonLabelled('Send', panelRow(stepId)!))
    await settle()
    expect(getBoard(d, 'alpha', planId === '' ? '' : getBoardTitle(d, planId))!.rows[0]!.annotation).toBe(text)
  }
  const getBoardTitle = (d: Database.Database, id: string) => (d.prepare('SELECT title FROM boards WHERE id = ?').get(id) as { title: string }).title

  it('never archives a plan with a note no agent has picked up, though the hold keeps it drawn in the fold (CFK-2, SDA-1)', async () => {
    db = freshDb()
    const { a, b, bridge } = await quietUp(db)
    await sendNote(db, a.id, a.rows[0]!.id, 'Please also cover Windows.')
    // drawn where it was; the fold's own line still counts what is drawn
    expect(card(a.id)!.dataset['section']).toBe('stalled')
    expect(stalledFold()!.querySelector('.stalled-count')?.textContent).toBe('2 plans, a week without a step')
    // the button counts only plans that are stalled on their own
    expect(archiveAll()!.textContent).toBe('Archive all 1 plan')
    click(archiveAll())
    expect(archiveAll()!.textContent).toBe('Really archive 1 plan?')
    await vi.advanceTimersByTimeAsync(500)
    click(archiveAll())
    await settle()
    expect(archivePosts(bridge).map((p) => p.url)).toEqual([`/api/boards/${b.id}/archive`])
    expect(getBoard(db, 'alpha', 'Quiet A')!.status).toBe('active')
    expect(notice()?.textContent).toBe('Archived 1 plan. Dismiss')
  })

  it('draws no Archive all when only a hold keeps plans in the fold (CFK-2)', async () => {
    db = freshDb()
    const a = oldPlan(db, 'Quiet A', [tracked('A step')])
    advanceClock(8 * DAY)
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await showPlans()
    click(stalledFold()!.querySelector('summary'))
    await settle()
    expect(archiveAll()!.textContent).toBe('Archive all 1 plan')
    await sendNote(db, a.id, a.rows[0]!.id, 'Remember the docs.')
    expect(card(a.id)!.dataset['section']).toBe('stalled')
    expect(archiveAll()).toBeNull()
  })

  it('checks each armed plan again at the confirm and counts one that has stopped qualifying as changed (CFK-2)', async () => {
    db = freshDb()
    const { a, b, bridge } = await quietUp(db)
    click(archiveAll())
    expect(archiveAll()!.textContent).toBe('Really archive 2 plans?')
    // inside the 4 seconds, the person sends a note on Quiet A: held in the fold, no longer stalled
    click(summary(a.id))
    await settle()
    click(stepRow(a.rows[0]!.id)!.querySelector('.row-expand'))
    await settle()
    type(panelRow(a.rows[0]!.id)!.querySelector<HTMLTextAreaElement>('.reply-input'), 'Remember the docs.')
    click(buttonLabelled('Send', panelRow(a.rows[0]!.id)!))
    await settle()
    expect(card(a.id)!.dataset['section']).toBe('stalled')
    expect(archiveAll()!.textContent).toBe('Really archive 2 plans?')
    await vi.advanceTimersByTimeAsync(500)
    click(archiveAll())
    await settle()
    expect(archivePosts(bridge).map((p) => p.url)).toEqual([`/api/boards/${b.id}/archive`])
    expect(notice()?.textContent).toContain('Archived 1 of 2 plans. 1 had changed since you looked and was left as it is.')
  })

  it('keeps a plan whose step holds a kept recovery line, and says so with the unsent ones (SDA-4)', async () => {
    db = freshDb()
    const kept = oldPlan(db, 'Quiet kept', [tracked('Write it up')])
    const other = oldPlan(db, 'Quiet other', [tracked('Other step')])
    advanceClock(8 * DAY)
    const step = kept.rows[0]!
    localStorage.setItem('agent-inbox-drafts-v1', JSON.stringify({ v: 1, entries: {
      [`row-recovery:${step.id}:${step.revision}`]: { savedAt: Date.now(), draft: {
        type: 'row-recovery', rowId: step.id, revision: step.revision, actionVersion: 0,
        text: 'Kept words', kind: 'answer', boardTitle: kept.title, label: step.label, context: '',
        setAside: false, choice: false, reason: '',
      } },
    } }))
    const bridge = await bootApp(db)
    await showPlans()
    expect(stalledFold()!.open).toBe(true)
    await armAndConfirm()
    await settle()
    expect(archivePosts(bridge).map((p) => p.url)).toEqual([`/api/boards/${other.id}/archive`])
    expect(notice()?.textContent).toContain('Archived 1 of 2 plans. 1 has text you have not sent and was kept.')
  })

  it('one gesture never arms and confirms: a second click within 400 ms, or with a click count above 1, is ignored (SDA-3)', async () => {
    db = freshDb()
    const { bridge } = await quietUp(db)
    click(archiveAll())
    click(archiveAll())
    await vi.advanceTimersByTimeAsync(0)
    expect(archiveAll()!.textContent).toBe('Really archive 2 plans?')
    expect(archivePosts(bridge)).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(500)
    archiveAll()!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 2 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(archiveAll()!.textContent).toBe('Really archive 2 plans?')
    expect(archivePosts(bridge)).toHaveLength(0)
    archiveAll()!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
    await settle()
    expect(archivePosts(bridge)).toHaveLength(2)
  })

  it('keeps the notice while Archive all is armed and replaces it when the confirm press starts (CFK-3)', async () => {
    db = freshDb()
    const c = oldPlan(db, 'Quiet C', [tracked('C step')])
    const { a } = twoQuietPlans(db)
    void c
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await showPlans()
    click(stalledFold()!.querySelector('summary'))
    await settle()
    click(summary(a.id))
    await settle()
    click(stepRow(a.rows[0]!.id)!.querySelector('.row-expand'))
    await settle()
    type(panelRow(a.rows[0]!.id)!.querySelector<HTMLTextAreaElement>('.reply-input'), 'Not yet sent')
    await armAndConfirm()
    await settle()
    expect(notice()?.textContent).toContain('1 has text you have not sent and was kept.')
    type(panelRow(a.rows[0]!.id)!.querySelector<HTMLTextAreaElement>('.reply-input'), '')
    const before = notice()
    click(archiveAll())
    expect(archiveAll()!.textContent).toBe('Really archive 1 plan?')
    expect(notice()).toBe(before)
    await vi.advanceTimersByTimeAsync(500)
    click(archiveAll())
    expect(notice()).toBeNull()
    await settle()
    expect(notice()?.textContent).toBe('Archived 1 plan. Dismiss')
  })

  it('leaves focus where the person put it while the plans are archived (CFK-6)', async () => {
    db = freshDb()
    twoQuietPlans(db)
    let release: () => void = () => {}
    const parked = new Promise<void>((resolve) => { release = resolve })
    let first = true
    await bootApp(db, {
      interceptFetch: async (input, init, next) => {
        if (init?.method === 'POST' && /\/archive$/.test(String(input)) && first) {
          first = false
          await parked
        }
        return next()
      },
    })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await showPlans()
    click(stalledFold()!.querySelector('summary'))
    await settle()
    archiveAll()!.focus()
    await armAndConfirm()
    await vi.advanceTimersByTimeAsync(0)
    // the person goes to the search box while the plans are being archived
    const search = document.getElementById('search') as HTMLInputElement
    search.focus()
    release()
    await settle()
    expect(stalledFold()).toBeNull()
    expect(document.activeElement).toBe(search)
  })

  for (const complete of [false, true]) {
    it(`a plan it archived can be opened under Archived plans and un-archived${complete ? ' (a complete plan the person had un-archived)' : ''} (RT-2)`, async () => {
      db = freshDb()
      const ids: string[] = []
      if (complete) {
        advanceClock()
        upsertBoard(db, { ...AGENT, title: 'Complete', rows: [{ label: 'All done', status: 'done' }] })
        const done = getBoardByTitle(db, 'alpha', 'Complete')!
        expect(unarchiveBoard(db, done.id, done.revision)).toBe(true)
        ids.push(done.id)
        advanceClock(8 * DAY)
      } else {
        const { a, b } = twoQuietPlans(db)
        ids.push(a.id, b.id)
      }
      await bootApp(db)
      vi.spyOn(document, 'hasFocus').mockReturnValue(true)
      await showPlans()
      click(stalledFold()!.querySelector('summary'))
      await settle()
      await armAndConfirm()
      await settle()
      const fold = () => document.querySelector<HTMLDetailsElement>('#boards .archived-fold')!
      click(fold().querySelector('summary'))
      await settle()
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(3000)
        await settle()
      }
      expect(fold().open).toBe(true)
      expect([...fold().querySelectorAll<HTMLElement>('[data-card-id]')].map((el) => el.dataset['cardId']).sort(), fold().textContent ?? '').toEqual([...ids].sort())
      click(summary(ids[0]!))
      await settle()
      expect(buttonLabelled('Un-archive', card(ids[0]!)!)).not.toBeNull()
    })
  }
})

describe('review fixes: held steps, paging, View, keys, count', () => {
  it('a step the person answered stays on screen, with its mark, when they close its panel (RT-1)', async () => {
    db = freshDb()
    const b = plan(db, 'Release', [tracked('Prepare'), asks('Approve')])
    const ask = b.rows[1]!.id
    await bootApp(db)
    await showPlans()
    expect(card(b.id)!.dataset['form']).toBe('brief')
    click(buttonLabelled('Answer', stepRow(ask)!))
    await settle()
    type(panelRow(ask)!.querySelector<HTMLTextAreaElement>('.reply-input'), 'Approved.')
    click(buttonLabelled('Send', panelRow(ask)!))
    await settle()
    expect(card(b.id)!.dataset['section']).toBe('needs')
    expect(shown(stepRow(ask))).toBe(true)
    click(stepRow(ask)!.querySelector('.row-expand'))
    await settle()
    expect(panelRow(ask)).toBeNull()
    expect(shown(stepRow(ask))).toBe(true)
    expect(stepRow(ask)!.querySelector('.step-mark')).not.toBeNull()
    await changedPollTick(db)
    expect(shown(stepRow(ask))).toBe(true)
    // a step never touched stays out of the brief form
    expect(shown(stepRow(b.rows[0]!.id))).toBe(false)
    // leaving Plans ends the visit
    await showInbox()
    await showPlans()
    expect(shown(stepRow(ask))).toBe(false)
  })

  it('in grouped mode the first page of 5 also holds a plan with a kept step (SDA-5)', async () => {
    db = freshDb()
    localStorage.setItem('agent-inbox-group-plans', 'true')
    const kept = plan(db, 'Oldest docs', [{ label: 'Write notes', status: 'partial', note: 'Drafting.' }, tracked()])
    const step = kept.rows[0]!
    for (let i = 0; i < 6; i++) plan(db, `Other ${i}`, [tracked()])
    localStorage.setItem('agent-inbox-drafts-v1', JSON.stringify({ v: 1, entries: {
      [`row:${step.id}`]: { savedAt: Date.now(), draft: {
        type: 'row', rowId: step.id, boardId: kept.id, boardRevision: kept.revision, revision: step.revision,
        text: 'Mention the migration.', kind: 'answer', boardTitle: kept.title, label: step.label, context: '', blocked: false,
      } },
    } }))
    await bootApp(db)
    await showPlans()
    expect(activePlanIds()).toHaveLength(6)
    expect(activePlanIds()).toContain(kept.id)
    expect(panelRow(step.id)?.querySelector<HTMLTextAreaElement>('.reply-input')?.value).toBe('Mention the migration.')
    expect(document.querySelector('#boards .boards > .show-more')?.textContent).toBe('Show 1 more (1 hidden)')
  })

  it('View does nothing and says so while Group by parent issue forces the tools open (CFK-8, RT-7a)', async () => {
    db = freshDb()
    localStorage.setItem('agent-inbox-group-plans', 'true')
    plan(db, 'Waiting', [asks()])
    await bootApp(db)
    await showPlans()
    const view = () => document.getElementById('plans-view-toggle')!
    expect(view().getAttribute('aria-disabled')).toBe('true')
    expect(view().title).toBe('Shown while grouping is on')
    click(view())
    expect(document.getElementById('plansTools')!.hidden).toBe(false)
    expect(view().getAttribute('aria-expanded')).toBe('true')
    // switching grouping off gives View back, open
    click(document.getElementById('group-plans-switch'))
    await settle()
    expect(view().hasAttribute('aria-disabled')).toBe(false)
    expect(view().title).toBe('')
    click(view())
    expect(document.getElementById('plansTools')!.hidden).toBe(true)
  })

  it('the count after Needs you has a noun for a screen reader and the same visible text (CPA-7)', async () => {
    db = freshDb()
    plan(db, 'One', [asks('A')])
    await bootApp(db)
    await showPlans()
    const head = document.querySelector<HTMLElement>('#boards .plan-section-head')!
    expect(visibleText(head)).toBe('Needs you 1')
    expect(head.querySelector('.visually-hidden')?.textContent).toBe(' plan')
    expect(head.textContent).toBe('Needs you 1 plan')
    plan(db, 'Two', [asks('B')])
    await changedPollTick(db)
    expect(document.querySelector('#boards .plan-section-head .visually-hidden')?.textContent).toBe(' plans')
  })
})

describe('rules the first review found unprotected (RT-4)', () => {
  it('closing a plan by its summary closes its open steps (D5)', async () => {
    db = freshDb()
    const b = plan(db, 'Docs', [tracked('One'), tracked('Two')])
    const step = b.rows[0]!.id
    await bootApp(db)
    await showPlans()
    click(summary(b.id))
    await settle()
    click(stepRow(step)!.querySelector('.row-expand'))
    await settle()
    expect(panelRow(step)).not.toBeNull()
    click(summary(b.id))
    await settle()
    expect(card(b.id)!.open).toBe(false)
    click(summary(b.id))
    await settle()
    expect(card(b.id)!.dataset['form']).toBe('full')
    expect(panelRow(step)).toBeNull()
    expect(stepRow(step)!.querySelector('.row-expand')?.textContent).toBe('▸')
  })

  it('closing the Stalled fold by hand closes its open steps (D6)', async () => {
    db = freshDb()
    const { a } = twoQuietPlans(db)
    const step = a.rows[0]!.id
    await bootApp(db)
    await showPlans()
    click(stalledFold()!.querySelector('summary'))
    await settle()
    click(summary(a.id))
    await settle()
    click(stepRow(step)!.querySelector('.row-expand'))
    await settle()
    expect(panelRow(step)).not.toBeNull()
    click(stalledFold()!.querySelector('summary'))
    await settle()
    expect(stalledFold()!.open).toBe(false)
    click(stalledFold()!.querySelector('summary'))
    await settle()
    expect(stalledFold()!.open).toBe(true)
    expect(panelRow(step)).toBeNull()
  })

  it('Moving’s first page always holds a plan with a step in hand, past the 12 (D8)', async () => {
    db = freshDb()
    const kept = plan(db, 'Oldest docs', [{ label: 'Write notes', status: 'partial', note: 'Drafting.' }, tracked()])
    const step = kept.rows[0]!
    for (let i = 0; i < 13; i++) plan(db, `Moving ${i}`, [tracked()])
    localStorage.setItem('agent-inbox-drafts-v1', JSON.stringify({ v: 1, entries: {
      [`row:${step.id}`]: { savedAt: Date.now(), draft: {
        type: 'row', rowId: step.id, boardId: kept.id, boardRevision: kept.revision, revision: step.revision,
        text: 'Mention the migration.', kind: 'answer', boardTitle: kept.title, label: step.label, context: '', blocked: false,
      } },
    } }))
    await bootApp(db)
    await showPlans()
    expect(activePlanIds()).toHaveLength(13)
    expect(activePlanIds()).toContain(kept.id)
    expect(shown(panelRow(step.id)?.querySelector('.reply-input'))).toBe(true)
    expect(document.getElementById('plans-moving-more')?.textContent).toBe('Show 1 more (1 hidden)')
  })

  it('an armed Archive all disarms when the lens changes (D6)', async () => {
    db = freshDb()
    twoQuietPlans(db)
    upsertBoard(db, { project: 'beta', stream: 'main', agent: 'copilot', title: 'Beta quiet', rows: [tracked()] })
    // the beta plan is as old as the others
    db.prepare("UPDATE boards SET updated_at = (SELECT updated_at FROM boards WHERE title = 'Quiet A') WHERE title = 'Beta quiet'").run()
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await showPlans()
    click(stalledFold()!.querySelector('summary'))
    await settle()
    expect(archiveAll()!.textContent).toBe('Archive all 3 plans')
    click(archiveAll())
    expect(archiveAll()!.textContent).toBe('Really archive 3 plans?')
    click(document.querySelector('#rail button.rail-tab[data-project="alpha"]'))
    await settle()
    expect(archiveAll()!.textContent).toBe('Archive all 2 plans')
  })
})

describe('the single plan’s Archive (item 20)', () => {
  const archiveButton = (id: string) => buttonLabelled('Archive', card(id)!) ?? buttonLabelled('Really archive?', card(id)!)
  async function armed() {
    db = freshDb()
    const b = plan(db, 'Docs', [tracked('One')])
    plan(db, 'Other', [tracked('Two')])
    const bridge = await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await showPlans()
    click(summary(b.id))
    await settle()
    return { b, bridge }
  }

  it('stays armed when a changed poll rebuilds the list, and the second click archives that plan once', async () => {
    const { b, bridge } = await armed()
    const first = archiveButton(b.id)!
    first.focus()
    click(first)
    expect(first.textContent).toBe('Really archive?')
    expect(first.classList.contains('confirm')).toBe(true)
    await changedPollTick(db!)
    const rebuilt = archiveButton(b.id)!
    expect(rebuilt).not.toBe(first)
    expect(rebuilt.textContent).toBe('Really archive?')
    expect(rebuilt.classList.contains('confirm')).toBe(true)
    expect(document.activeElement).toBe(rebuilt)
    click(archiveButton(b.id))
    await settle()
    expect(archivePosts(bridge).map((p) => p.url)).toEqual([`/api/boards/${b.id}/archive`])
    expect(getBoardByTitle(db!, 'alpha', 'Docs')!.status).toBe('archived')
  })

  it('disarms by itself after 4 seconds, in place, and arming only one plan at a time', async () => {
    const { b } = await armed()
    const other = getBoard(db!, 'alpha', 'Other')!
    click(archiveButton(b.id))
    const button = archiveButton(b.id)!
    await vi.advanceTimersByTimeAsync(3900)
    expect(archiveButton(b.id)!.textContent).toBe('Really archive?')
    await vi.advanceTimersByTimeAsync(200)
    expect(archiveButton(b.id)!.textContent).toBe('Archive')
    expect(archiveButton(b.id)!.classList.contains('confirm')).toBe(false)
    expect(document.contains(button) ? button.textContent : 'Archive').toBe('Archive')
    // a rebuilt list after that draws it unarmed
    plan(db!, 'Fresh', [tracked()])
    await pollTick()
    expect(archiveButton(b.id)!.textContent).toBe('Archive')
    // arming another plan's button disarms the first
    click(summary(other.id))
    await settle()
    click(archiveButton(b.id))
    click(archiveButton(other.id))
    expect(archiveButton(b.id)!.textContent).toBe('Archive')
    expect(archiveButton(other.id)!.textContent).toBe('Really archive?')
  })

  it('a new visit to Plans starts disarmed', async () => {
    const { b } = await armed()
    click(archiveButton(b.id))
    await showInbox()
    await showPlans()
    click(summary(b.id))
    await settle()
    expect(archiveButton(b.id)!.textContent).toBe('Archive')
  })
})

describe('the harness enforces reachability on Plans (RT-3)', () => {
  it('click() refuses a control behind the hidden attribute or a closed plan, allows a closed plan’s own summary, and reach() opens what a person would', async () => {
    db = freshDb()
    const brief = plan(db, 'Waiting', [tracked('One'), asks('Choose')])
    const closed = plan(db, 'Moving', [tracked()])
    await bootApp(db)
    await showPlans()
    expect(card(brief.id)!.dataset['form']).toBe('brief')
    // the brief plan's actions are hidden, the closed plan's whole body is behind its closed <details>
    expect(() => click(buttonLabelled('Plan flow', card(brief.id)!))).toThrow(/not reachable.*hidden attribute/)
    expect(() => click(stepRow(closed.rows[0]!.id)!.querySelector('.row-expand'))).toThrow(/not reachable.*closed/)
    expect(() => click(document.getElementById('group-plans-switch'))).toThrow(/not reachable.*plansTools/)
    expect(() => click(summary(closed.id))).not.toThrow()
    await settle()
    // reach() presses what a person would: the plan's summary, then View
    click(await reach(() => buttonLabelled('Plan flow', card(brief.id)!)))
    expect(card(brief.id)!.dataset['form']).toBe('full')
    click(await reach(() => document.getElementById('group-plans-switch')))
    expect(document.getElementById('plansTools')!.hidden).toBe(false)
    // a control outside Plans is not policed
    expect(() => click(document.querySelector('.tab[data-tab="dashboard"]'))).not.toThrow()
  })
})

describe('the stylesheet (CSS)', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'style.css'), 'utf8')
  const slice = css.slice(css.indexOf('/* UX pass, slice 3: Plans as bars.'))
  it('colours the four states from existing tokens, the Working card’s included', () => {
    expect(slice).toMatch(/\[data-state="done"\][^{]*\{[^}]*background: var\(--app-border-strong\)/)
    expect(slice).toMatch(/\[data-state="progress"\][^{]*\{[^}]*background: var\(--app-text\)/)
    expect(slice).toMatch(/\[data-state="needs"\][^{]*\{[^}]*min-width: 3px;[^}]*background: var\(--app-attention\)/)
    expect(slice).toMatch(/\[data-state="todo"\][^{]*\{[^}]*background: var\(--app-border\)/)
    expect(slice).toMatch(/\.sc-bar \[data-seg="done"\] \{ background: var\(--app-border-strong\)/)
  })
  it('never hides the number cell (a hidden cell shifts every cell a column left under 1280 px)', () => {
    expect(css).not.toMatch(/\.row-num[^{]*\{[^}]*display:\s*none/)
    expect(slice).toMatch(/\.board-table\.matrix \.row-num \{ width: 0; padding: 0; overflow: hidden; font-size: 0; \}/)
  })
  it('adds no second @media and no CSS order', () => {
    expect((css.match(/@media\s*\(max-width/g) ?? [])).toHaveLength(1)
    expect(slice).not.toMatch(/@media\s*\(/)
    expect(slice).not.toMatch(/(^|[\s;{])order:/)
  })
  it('tints no step row on Plans: the bold label marks the step that needs you, and a blocked step that does not is reset', () => {
    expect(css).toMatch(/tr:has\(\.blocked\) \.row-label\s*\{[^}]*font-weight:/)
    expect(slice).toMatch(/#boards \.board-table td \{[^}]*background: none;/)
    expect(slice).toMatch(/#boards \.board-table tr:has\(\.blocked\) \.row-label \{ color: inherit; font-weight: 500; \}/)
    expect(slice).toMatch(/#boards \.board-table tr\.needs-answer \.row-label \{[^}]*font-weight: 650;/)
  })
  it('draws a plan on a card only when it is expanded, and turns the chevron from the form', () => {
    expect(slice).toMatch(/#boards \.board\[data-form="full"\] \{[^}]*background: var\(--app-elevated\);/)
    expect(slice).toMatch(/#boards \.board\[data-form="full"\] > \.plan-line \.plan-chevron \{ transform: rotate\(45deg\); \}/)
    expect(slice).not.toMatch(/#boards \.board\[open\] \{[^}]*margin:/)
  })
})

