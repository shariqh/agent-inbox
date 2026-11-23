// @vitest-environment jsdom
// Plans as bars: the cases a second, targeted check of the fix round found. Each one is a
// scenario a person can reach; the first check's cases live in ux-plans.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { getBoard, getBoardByTitle, upsertBoard } from '../../src/store.js'
import {
  advanceClock, bootApp, buttonLabelled, changedPollTick, click, freshDb, pollTick, reach, settle, showInbox, type, useDomTest,
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
function plan(d: Database.Database, title: string, rows: Rows) {
  advanceClock()
  upsertBoard(d, { ...AGENT, title, rows })
  return getBoard(d, AGENT.project, title)!
}
function rewrite(d: Database.Database, title: string, rows: Rows, ms = 1000): void {
  const before = getBoardByTitle(d, AGENT.project, title)!
  const revision = (label: string) => before.rows.find((r) => r.label === label)?.revision
  advanceClock(ms)
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
const shown = (el: Element | null | undefined): boolean => {
  if (!el) return false
  const from = el.matches('details > summary') ? el.parentElement!.parentElement : el
  return !from || from.closest('[hidden], details:not([open])') === null
}
const stalledFold = () => document.querySelector<HTMLDetailsElement>('#boards .stalled-fold')
const archiveAll = () => document.getElementById('plans-archive-stalled') as HTMLButtonElement | null
const singleArchive = (id: string) => buttonLabelled('Archive', card(id)!) ?? buttonLabelled('Really archive?', card(id)!)
const archivePosts = (bridge: { posts: Array<{ url: string }> }) => bridge.posts.filter((p) => /\/api\/boards\/[^/]+\/archive$/.test(p.url))
const heldKey = (el: Element, key: string): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key, repeat: true, bubbles: true, cancelable: true })
  el.dispatchEvent(event)
  return event
}

describe('a step keeps its place when its panel closes', () => {
  it('also for a step left open from an earlier visit to Plans', async () => {
    db = freshDb()
    const b = plan(db, 'Release', [tracked('Prepare'), asks('Approve')])
    const ask = b.rows[1]!.id
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await showPlans()
    click(buttonLabelled('Answer', stepRow(ask)!))
    await settle()
    type(panelRow(ask)!.querySelector<HTMLTextAreaElement>('.reply-input'), 'Approved.')
    click(buttonLabelled('Send', panelRow(ask)!))
    await settle()
    // a look at Home, then back: a new visit, and the step's panel is still open
    await showInbox()
    await showPlans()
    expect(shown(stepRow(ask))).toBe(true)
    expect(shown(panelRow(ask))).toBe(true)
    const expand = stepRow(ask)!.querySelector<HTMLButtonElement>('.row-expand')!
    expand.focus()
    click(expand)
    await settle()
    expect(shown(stepRow(ask)), 'the row the person just pressed vanished').toBe(true)
    expect(panelRow(ask)).toBeNull()
  })
})

describe('focus when the Stalled fold is redrawn closed', () => {
  it('moves from Archive all to the Stalled line, never into the closed fold', async () => {
    db = freshDb()
    const a = plan(db, 'Quiet A', [tracked('A step')])
    plan(db, 'Quiet B', [tracked('B step')])
    const step = a.rows[0]!
    advanceClock(8 * DAY)
    // a kept recovery line on A: the fold rests open with no choice recorded
    localStorage.setItem('agent-inbox-drafts-v1', JSON.stringify({ v: 1, entries: {
      [`row-recovery:${step.id}:${step.revision}`]: { savedAt: Date.now(), draft: {
        type: 'row-recovery', rowId: step.id, revision: step.revision, actionVersion: 0,
        text: 'Kept words', kind: 'answer', boardTitle: a.title, label: step.label, context: '',
        setAside: false, choice: false, reason: '',
      } },
    } }))
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await showPlans()
    expect(stalledFold()!.open).toBe(true)
    const archive = archiveAll()!
    expect(shown(archive)).toBe(true)
    archive.focus()
    // A's agent adds an ask: A leaves the fold, and nothing in the fold is kept now
    rewrite(db, 'Quiet A', [tracked('A step'), asks('Late ask')])
    await pollTick()
    await changedPollTick(db)
    expect(card(a.id)!.dataset['section']).not.toBe('stalled')
    expect(stalledFold()!.open).toBe(false)
    expect(document.activeElement?.id).toBe('plans-stalled-summary')
  })
})

describe('the single Archive button', () => {
  it('shows Archive again when its plan changes after arming, and one more press only arms', async () => {
    db = freshDb()
    const b = plan(db, 'Docs', [tracked('One')])
    plan(db, 'Other', [tracked('Two')])
    const bridge = await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await showPlans()
    click(summary(b.id))
    await settle()
    click(singleArchive(b.id))
    expect(singleArchive(b.id)!.textContent).toBe('Really archive?')
    // inside the 4 seconds its agent adds an ask the person has not seen
    rewrite(db, 'Docs', [tracked('One'), asks('New question')], 1)
    await pollTick()
    expect(card(b.id)!.dataset['section']).toBe('needs')
    expect(singleArchive(b.id)!.textContent).toBe('Archive')
    click(singleArchive(b.id))
    await settle()
    expect(singleArchive(b.id)!.textContent).toBe('Really archive?')
    expect(archivePosts(bridge)).toHaveLength(0)
    expect(getBoardByTitle(db, 'alpha', 'Docs')!.status).toBe('active')
  })

  it('and Archive all are never armed together', async () => {
    db = freshDb()
    const a = plan(db, 'Quiet A', [tracked('A step')])
    plan(db, 'Quiet B', [tracked('B step')])
    advanceClock(8 * DAY)
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await showPlans()
    click(stalledFold()!.querySelector('summary'))
    await settle()
    click(summary(a.id))
    await settle()
    click(singleArchive(a.id))
    expect(singleArchive(a.id)!.textContent).toBe('Really archive?')
    await vi.advanceTimersByTimeAsync(100)
    click(archiveAll())
    expect(archiveAll()!.textContent).toBe('Really archive 2 plans?')
    expect(singleArchive(a.id)!.textContent).toBe('Archive')
    await vi.advanceTimersByTimeAsync(100)
    click(singleArchive(a.id))
    expect(singleArchive(a.id)!.textContent).toBe('Really archive?')
    expect(archiveAll()!.textContent).toBe('Archive all 2 plans')
  })

  it('and Archive all ignore a held key: only a fresh press activates them', async () => {
    db = freshDb()
    const a = plan(db, 'Quiet A', [tracked('A step')])
    advanceClock(8 * DAY)
    await bootApp(db)
    await showPlans()
    click(stalledFold()!.querySelector('summary'))
    await settle()
    click(summary(a.id))
    await settle()
    expect(heldKey(archiveAll()!, 'Enter').defaultPrevented).toBe(true)
    expect(heldKey(singleArchive(a.id)!, 'Enter').defaultPrevented).toBe(true)
    const fresh = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    archiveAll()!.dispatchEvent(fresh)
    expect(fresh.defaultPrevented).toBe(false)
  })
})

describe('a plan Archive all archived and the person un-archived', () => {
  it('lingers as completed when its agent finishes it later', async () => {
    db = freshDb()
    const a = plan(db, 'Quiet A', [tracked('A step')])
    advanceClock(8 * DAY)
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await showPlans()
    click(stalledFold()!.querySelector('summary'))
    await settle()
    click(archiveAll())
    await vi.advanceTimersByTimeAsync(500)
    click(archiveAll())
    await settle()
    expect(getBoardByTitle(db, 'alpha', 'Quiet A')!.status).toBe('archived')
    // the person takes it back from Archived plans
    click(document.getElementById('plans-archived-summary'))
    await settle()
    await pollTick()
    await settle()
    click(await reach(() => buttonLabelled('Un-archive', card(a.id)!)))
    await settle()
    expect(getBoardByTitle(db, 'alpha', 'Quiet A')!.status).toBe('active')
    expect(document.querySelector(`#boards .boards > [data-card-id="${a.id}"]`)).not.toBeNull()
    // its agent finishes it: the store archives a complete plan, and it lingers on the page
    rewrite(db, 'Quiet A', [{ label: 'A step', status: 'done' }])
    expect(getBoardByTitle(db, 'alpha', 'Quiet A')!.status).toBe('archived')
    await changedPollTick(db)
    await settle()
    expect(document.querySelectorAll('#boards .board.lingering')).toHaveLength(1)
  })
})
