// @vitest-environment jsdom
// test/dom/closed-projects.test.ts
//
// Issue #32 — close / reopen a project — driven through the REAL viewer
// frontend against a REAL temp SQLite DB. The source-text half (which data each
// call site is handed) lives in test/shell.test.ts; this file is the behaviour:
// the × actually retires a tab, the badge actually drops, a peek actually does
// NOT reopen, and a new flag actually brings the project back.
//
// Read the blind-spot list in CLAUDE.md before adding a CSS assertion here:
// `@media` never matches in jsdom, so nothing about the narrow-width
// close/reopen rules can be verified from this file.
import { describe, it, expect, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, upsertBoard, upsertActivity, closedProjects } from '../../src/store.js'
import {
  advanceClock, badgeCount, bootApp, buttonLabelled, click, freshDb, pollTick, rowTitles,
  settle, tabCount, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

function open(): Database.Database {
  db = freshDb()
  return db
}

const q = (d: Database.Database, project: string, title: string, over: { session?: string } = {}) =>
  insertItem(d, { project, stream: 'main', agent: 'claude', kind: 'question', title, ...over })

/** The rail tab for a project, whether it sits in the open rail or in the fold. */
const railTab = (project: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`#rail button.rail-tab[data-project="${project}"]`)

/** Only the OPEN rail — a `.rail-row` that is not inside the closed fold. */
const openRailTab = (project: string): HTMLElement | null =>
  [...document.querySelectorAll<HTMLElement>(`#rail button.rail-tab[data-project="${project}"]`)]
    .find((el) => !el.closest('.closed-fold')) ?? null

const foldTab = (project: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`#rail .closed-fold button.rail-tab[data-project="${project}"]`)

/** The ×/↩ button that is a SIBLING of a project's tab (never a child of it). */
const rowAction = (project: string, cls: 'rail-close' | 'rail-reopen'): HTMLElement | null =>
  railTab(project)?.parentElement?.querySelector<HTMLElement>(`.${cls}`) ?? null

const foldSummary = () => document.querySelector<HTMLElement>('#rail .closed-fold > summary')
const banner = () => document.querySelector<HTMLElement>('.closed-banner')

describe('closing a project from the rail (issue #32)', () => {
  it('retires the tab into the fold and drops the project out of every count', async () => {
    const d = open()
    q(d, 'alpha', 'a-question')
    advanceClock()
    q(d, 'beta', 'b-question')

    const bridge = await bootApp(d)
    expect(badgeCount()).toBe(2)
    expect(tabCount('needsYou')).toBe('2')

    click(rowAction('beta', 'rail-close'))
    await settle()

    expect(closedProjects(d), 'the close must reach SQLite, not just the client').toEqual(['beta'])
    expect(bridge.posts.map((p) => p.url)).toContain('/api/projects/close')
    expect(JSON.parse(String(bridge.posts.at(-1)!.init!.body))).toEqual({ project: 'beta' })
    // the number leaves the badge, the title and the tab count together
    expect(badgeCount()).toBe(1)
    expect(document.title).toBe('(1) Agent Inbox')
    expect(tabCount('needsYou')).toBe('1')
    // …and the list
    expect(rowTitles()).toEqual(['a-question'])
    // the tab moved, it was not deleted
    expect(openRailTab('beta')).toBeNull()
    expect(foldTab('beta')).toBeTruthy()
    expect(openRailTab('alpha')).toBeTruthy()
  })

  it('relocates the suppressed number into the fold instead of destroying it, and never paints it red', async () => {
    const d = open()
    // a blocked board row always escalates in the open rail — the fold must not
    upsertBoard(d, {
      project: 'beta', stream: 'main', agent: 'claude', title: 'Rollout',
      rows: [{ label: 'deploy', status: 'blocked' }],
    })
    advanceClock()
    q(d, 'beta', 'b-question')

    await bootApp(d)
    expect(railTab('beta')?.querySelector('.rail-badge')?.classList.contains('escalated')).toBe(true)

    click(rowAction('beta', 'rail-close'))
    await settle()

    const badge = foldTab('beta')!.querySelector('.rail-badge')!
    expect(badge.textContent, 'the fold shows what the badge is no longer counting').toBe('2')
    expect(badge.classList.contains('escalated'), 'a suppressed project must not alarm').toBe(false)
    expect(foldSummary()?.textContent).toContain('Closed (1)')
    expect(document.querySelector('.closed-muted')?.textContent).toBe('2 muted')
    expect(foldSummary()?.title).toContain('not counted in the badge')
    expect(badgeCount()).toBe(0)
  })

  it('survives the 3s poll — closure is server state, not an optimistic client flag', async () => {
    const d = open()
    q(d, 'beta', 'b-question')
    await bootApp(d)

    click(rowAction('beta', 'rail-close'))
    await settle()
    await pollTick()

    expect(badgeCount()).toBe(0)
    expect(foldTab('beta')).toBeTruthy()
    expect(openRailTab('beta')).toBeNull()
  })

  it('cannot resurrect a closed project through the triage deck (tenet 3 names the deck)', async () => {
    const d = open()
    q(d, 'beta', 'b-question')
    await bootApp(d)

    click(rowAction('beta', 'rail-close'))
    await settle()
    click(buttonLabelled('Triage →'))
    await settle()

    expect(document.querySelector('.lb-clear')?.textContent).toContain('All clear')
  })

  it('leaves the Live footer strip alone — presence is not attention (§16)', async () => {
    const d = open()
    q(d, 'beta', 'b-question')
    upsertActivity(d, { session: 's1', project: 'beta', stream: 'main', agent: 'claude', doing: 'still working' })
    await bootApp(d)
    expect(document.getElementById('liveStripLabel')?.textContent).toBe('1 working')

    click(rowAction('beta', 'rail-close'))
    await settle()

    expect(document.getElementById('liveStripLabel')?.textContent, 'the strip is global, never closure-scoped').toBe('1 working')
    expect(document.querySelectorAll('#liveStripSessions .live-session')).toHaveLength(1)
  })
})

describe('peeking into a closed project (issue #32)', () => {
  async function closedBeta(): Promise<Database.Database> {
    const d = open()
    q(d, 'alpha', 'a-question')
    advanceClock()
    q(d, 'beta', 'b-question')
    await bootApp(d)
    click(rowAction('beta', 'rail-close'))
    await settle()
    return d
  }

  it('shows the project without reopening it — looking is not a mutation', async () => {
    const d = await closedBeta()

    click(foldTab('beta'))
    await settle()

    expect(rowTitles()).toEqual(['b-question'])
    expect(closedProjects(d), 'a peek must not reopen').toEqual(['beta'])
    expect(foldTab('beta'), 'the tab stays in the fold while peeked').toBeTruthy()
    // the peek does NOT resurrect the suppressed count
    expect(badgeCount()).toBe(1)
  })

  it('prints a banner naming the suppression, rather than leaving two numbers disagreeing', async () => {
    await closedBeta()
    click(foldTab('beta'))
    await settle()

    const text = banner()?.textContent ?? ''
    expect(text).toContain('beta is closed')
    expect(text).toContain('badge or triage deck')
    // agent-authored project name never becomes live markup
    expect(banner()?.querySelectorAll('img, script')).toHaveLength(0)
  })

  it('shows the banner on every tab, not only on Needs-you', async () => {
    await closedBeta()
    click(foldTab('beta'))
    await settle()
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()

    expect(banner()?.textContent).toContain('beta is closed')
  })

  it("the banner's Reopen button brings the project back into the rail and the badge", async () => {
    const d = await closedBeta()
    click(foldTab('beta'))
    await settle()

    click(buttonLabelled('Reopen', banner()!))
    await settle()

    expect(closedProjects(d)).toEqual([])
    expect(banner()).toBeNull()
    expect(openRailTab('beta')).toBeTruthy()
    expect(document.querySelector('#rail .closed-fold')).toBeNull()
    expect(badgeCount()).toBe(2)
  })

  it('the fold’s ↩ reopens without needing a peek first', async () => {
    const d = await closedBeta()

    click(rowAction('beta', 'rail-reopen'))
    await settle()

    expect(closedProjects(d)).toEqual([])
    expect(openRailTab('beta')).toBeTruthy()
    expect(badgeCount()).toBe(2)
  })

  it('a closed project the human has selected is NOT evicted by renderRail’s stale-filter reconciliation', async () => {
    await closedBeta()
    click(foldTab('beta'))
    await settle()
    // three more renders' worth of reconciliation
    await pollTick()

    expect(document.querySelector('#rail button.rail-tab[data-project="beta"]')?.getAttribute('aria-selected')).toBe('true')
    expect(rowTitles()).toEqual(['b-question'])
  })
})

describe('implicit reopen — nothing an agent raises stays muted (issue #32)', () => {
  it('a NEW question in a closed project brings it back into the rail and the badge', async () => {
    const d = open()
    q(d, 'alpha', 'a-question')
    advanceClock()
    q(d, 'beta', 'old-question')
    await bootApp(d)

    click(rowAction('beta', 'rail-close'))
    await settle()
    expect(badgeCount()).toBe(1)

    advanceClock() // the close stamped `now`; the new flag must land strictly after it
    q(d, 'beta', 'fresh-question')
    await pollTick()

    expect(closedProjects(d), 'reopen is DERIVED — nothing wrote a row').toEqual([])
    expect(openRailTab('beta')).toBeTruthy()
    expect(document.querySelector('#rail .closed-fold')).toBeNull()
    // BOTH beta questions come back, not just the new one
    expect(badgeCount()).toBe(3)
    expect(rowTitles().sort()).toEqual(['a-question', 'fresh-question', 'old-question'])
  })

  it('a live session alone does NOT reopen it — presence is not new content', async () => {
    const d = open()
    q(d, 'beta', 'b-question')
    await bootApp(d)

    click(rowAction('beta', 'rail-close'))
    await settle()

    advanceClock()
    upsertActivity(d, { session: 's9', project: 'beta', stream: 'main', agent: 'claude', doing: 'reading' })
    await pollTick()

    expect(closedProjects(d)).toEqual(['beta'])
    expect(foldTab('beta')).toBeTruthy()
    expect(badgeCount()).toBe(0)
  })
})

describe('the closed fold and keyboard reachability (issue #32)', () => {
  it('close/reopen buttons are siblings of the tab and stay out of the tab order (§13)', async () => {
    const d = open()
    q(d, 'beta', 'b-question')
    await bootApp(d)

    const close = rowAction('beta', 'rail-close')!
    expect(close.parentElement!.classList.contains('rail-row')).toBe(true)
    expect(railTab('beta')!.contains(close), 'a <button> may not contain interactive content').toBe(false)
    expect(close.tabIndex).toBe(-1)
    expect(close.getAttribute('aria-label')).toBe('Close project beta')
  })

  it('Delete on a focused rail tab is the keyboard path to closing it', async () => {
    const d = open()
    q(d, 'alpha', 'a-question')
    advanceClock()
    q(d, 'beta', 'b-question')
    await bootApp(d)

    railTab('beta')!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    await settle()

    expect(closedProjects(d)).toEqual(['beta'])
    expect(foldTab('beta')).toBeTruthy()
  })

  it('arrow-keys skip the rows sealed inside a collapsed fold instead of focusing nothing', async () => {
    const d = open()
    q(d, 'alpha', 'a-question')
    advanceClock()
    q(d, 'beta', 'b-question')
    await bootApp(d)

    click(rowAction('beta', 'rail-close'))
    await settle()
    // collapse it again: the fold's rows stay in the DOM but are display:none,
    // so arrow-keying into one makes focus vanish for the user
    const fold = document.querySelector<HTMLDetailsElement>('#rail .closed-fold')!
    fold.open = false
    expect(fold.matches('details:not([open])'), 'jsdom must reflect .open for the filter to be meaningful').toBe(true)

    railTab('alpha')!.focus()
    expect(document.activeElement).toBe(railTab('alpha'))
    // NOT bubbling: app.js also owns a document-level arrow-key router for the
    // Needs-you list, and this assertion is about wireTablist's own handler
    document.getElementById('rail')!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown' }))

    // alpha is the LAST open tab, so a correct list wraps back to All; an
    // unfiltered list would step into the invisible fold row instead
    expect(document.activeElement).toBe(railTab('__all__'))
    expect(document.activeElement).not.toBe(foldTab('beta'))
  })

  it('never offers to close the All pseudo-project', async () => {
    const d = open()
    q(d, 'beta', 'b-question')
    await bootApp(d)

    expect(railTab('__all__')).toBeTruthy()
    expect(rowAction('__all__', 'rail-close')).toBeNull()
  })

  it('the fold survives the poll rebuild once opened, like every other <details> the poll owns', async () => {
    const d = open()
    q(d, 'alpha', 'a-question')
    advanceClock()
    q(d, 'beta', 'b-question')
    await bootApp(d)

    click(rowAction('beta', 'rail-close'))
    await settle()
    const fold = document.querySelector<HTMLDetailsElement>('#rail .closed-fold')!
    expect(fold.open, 'closing a project opens the fold so the human sees where the tab went').toBe(true)

    await pollTick()
    expect(document.querySelector<HTMLDetailsElement>('#rail .closed-fold')!.open).toBe(true)
  })
})
