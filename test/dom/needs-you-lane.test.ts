// @vitest-environment jsdom
// Dashboard lanes PR 3 (docs/superpowers/specs/2026-11-13-dashboard-lanes-design.md
// §3.1, §3.2, §6, §8): the page head's lane chips and the Needs you lane. The
// lane holds every attention entry once, in sortRail order; a card opens its
// ask in the Inbox's detail panel and never answers; Esc or the card's close
// comes back. Session cards only count their asks ("Asking you · N").
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import {
  closeProject, endActivity, getItem, insertItem, listBoards, listItems, upsertActivity, upsertBoard,
} from '../../src/store.js'
import { attentionEntries, sortRail } from '../../public/attention.js'
import { installDashHead } from '../../public/dash-head.js'
import { installAgentsHome } from '../../public/agents-home.js'
import { NEEDS_YOU_EMPTY, installNeedsYouLane } from '../../public/needs-you-lane.js'
import {
  advanceClock, answerInput, badgeCount, bootApp, buttonLabelled, changedPollTick, click, collapseRow, freshDb,
  pollTick, row, rows, searchFor, sendButton, settle, setViewport, showInbox, type, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
beforeEach(() => {
  vi.stubGlobal('location', { hash: '', reload: vi.fn() })
})
afterEach(() => {
  db?.close()
  db = null
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const

function question(d: Database.Database, title: string, extra: Record<string, unknown> = {}): string {
  advanceClock()
  return insertItem(d, { ...AGENT, kind: 'question', title, ...extra })
}

function blockedRow(d: Database.Database, label: string, extra: Record<string, unknown> = {}, board: Record<string, unknown> = {}): string {
  advanceClock()
  upsertBoard(d, {
    ...AGENT, title: `Plan for ${label}`, ...board,
    rows: [{ label, status: 'blocked', note: `${label} is ready.`, next_step: `Do ${label}.`, action_owner: 'task', impact: 'Unblocks it.', ...extra }],
  })
  return listBoards(d).find((b) => b.title === `Plan for ${label}`)!.rows[0]!.id
}

const live = (d: Database.Database, session: string, extra: Record<string, unknown> = {}) =>
  upsertActivity(d, { ...AGENT, session, doing: 'Working on it', idle: false, ...extra })
const idle = (d: Database.Database, session: string, extra: Record<string, unknown> = {}) =>
  upsertActivity(d, { ...AGENT, session, doing: 'open', idle: true, ...extra })

const lane = () => document.querySelector<HTMLElement>('#dashboard .needs-you-lane')!
const laneCards = () => [...document.querySelectorAll<HTMLElement>('#dashboard .ny-card')]
const laneIds = () => laneCards().map((el) => el.dataset.nyAsk)
const laneCard = (id: string) => laneCards().find((el) => el.dataset.nyAsk === id) ?? null
const chip = (key: string) => document.querySelector<HTMLButtonElement>(`#dashboard .dash-chip[data-dash-chip="${key}"]`)!
const chipCount = (key: string) => chip(key).querySelector('.dash-chip-count')?.textContent
const sessionCard = (key: string) => [...document.querySelectorAll<HTMLElement>('#dashboard [data-session-card]')].find((el) => el.dataset.sessionCard === key) ?? null
const panel = () => document.querySelector<HTMLElement>('#dashboard .dash-focus')!
const shown = (id: string) => !document.getElementById(id)?.hidden
const key = (target: Element, name: string) => {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}
const idOf = (entry: { kind: string; item?: { id: string }; row?: { id: string } }) => (entry.kind === 'item' ? entry.item!.id : entry.row!.id)
// the order the lane must show: the attention set, in sortRail's order
function railOrder(d: Database.Database, closed: string[] = []): string[] {
  const sessions = (d.prepare('SELECT session FROM activity').all() as Array<{ session: string }>).map((r) => r.session)
  return sortRail(attentionEntries(listItems(d) as never, listBoards(d) as never, Date.now(), sessions, closed), Date.now()).map((entry) => idOf(entry as never))
}

describe('the Needs you lane holds every ask once (§3.2, §8)', () => {
  it('lists every attention entry once, in sortRail order, its count the badge with All projects; a lens narrows it', async () => {
    db = freshDb()
    live(db, 'here')
    // the parity fixtures sessions.test.ts holds for the cards, ported to the lane
    idle(db, 'quiet', { project: 'q', stream: 'dev', agent: 'claude-code' })
    question(db, 'From a live session', { session: 'here' })
    question(db, 'From an ended session', { session: 'gone', agent: 'claude-code' })
    question(db, 'From no session', { project: 'beta' })
    blockedRow(db, 'Stamped by the live one', {}, { session: 'here' })
    blockedRow(db, 'Joined to the idle one', {}, { project: 'q', stream: 'dev', agent: 'claude-code' })
    blockedRow(db, 'On no branch anyone is on', {}, { project: 'beta', stream: 'nobody', agent: 'claude-code' })
    question(db, 'Allow shell: npm test', { project: '@sessions', session: 'drv-1', action_owner: 'approval', options: [{ label: 'Allow once' }, { label: 'Deny' }] })
    const snoozed = question(db, 'Snoozed')
    const parked = question(db, 'Parked for later')
    question(db, 'In a closed project', { project: 'shut' })
    closeProject(db, 'shut')
    await bootApp(db)
    await showInbox()
    click(row(snoozed)!)
    await settle()
    click(row(snoozed)!.querySelector('.disposition-menu > summary'))
    click(buttonLabelled('Tomorrow', row(snoozed)!))
    await settle()
    click(row(parked)!)
    await settle()
    click(row(parked)!.querySelector('.disposition-menu > summary'))
    click(buttonLabelled('Pin for later', row(parked)!))
    await settle()
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()

    expect(badgeCount()).toBe(7)
    expect(laneIds()).toEqual(railOrder(db, ['shut']))
    expect(laneIds()).toHaveLength(badgeCount())
    expect(chipCount('needs')).toBe('7')
    // each once on the whole Dashboard; no session card shows an ask's title
    for (const id of laneIds()) expect(document.querySelectorAll(`#dashboard [data-ny-ask="${id}"]`)).toHaveLength(1)
    // every session's card or row, in Working, Quiet and the folds
    const cardParts = [...document.querySelectorAll('#dashboard [data-session-card] *')].map((el) => el.textContent)
    for (const title of ['From a live session', 'Stamped by the live one', 'Joined to the idle one', 'From an ended session']) expect(cardParts).not.toContain(title)
    expect(document.querySelector('#dashboard [data-session-card^="ask:"]')).toBeNull()
    // the asks no card holds say why
    // by the title's tooltip: a row with a next step leads with the step (card.js actionPresentation)
    const tag = (title: string) => laneCards().find((el) => el.querySelector<HTMLElement>('.ny-title')?.title === title)?.querySelector<HTMLElement>('.ny-session')
    expect(tag('From an ended session')?.textContent).toBe('session ended')
    expect(tag('From no session')?.textContent).toBe('no session')
    expect(tag('On no branch anyone is on')?.textContent).toBe('no session')
    expect(tag('Allow shell: npm test')?.textContent).toBe('session ended')
    for (const title of ['From a live session', 'Stamped by the live one', 'Joined to the idle one']) expect(tag(title)?.hidden, title).toBe(true)
    // the chips: the live card holds two, the idle one its joined row
    expect(sessionCard('session:here')?.querySelector('.sc-asking')?.textContent).toBe('Asking you · 2')
    expect(sessionCard('session:quiet')?.querySelector('.sc-asking')?.textContent).toBe('Asking you · 1')
    expect(document.querySelector<HTMLElement>('.ny-later')?.textContent).toBe('Later 2 ›')

    click(document.querySelector('#rail button.rail-tab[data-project="alpha"]'))
    await settle()
    expect(laneCards().map((el) => el.querySelector('.ny-project')?.textContent)).toEqual(['alpha', 'alpha', 'alpha'])
    expect(chipCount('needs')).toBe(String(laneCards().length))
    expect(badgeCount()).toBe(7)
  })

  it('a card shows project, agent kind, branch, age, the headline and its summary, names a blocked row’s plan and label, and holds no control', async () => {
    db = freshDb()
    const item = question(db, 'Which release?', { next_step: 'Pick one.', agent: 'claude-code', stream: 'feat/x' })
    const step = blockedRow(db, 'Rotate the token')
    question(db, 'Allow shell: npm test', { project: '@sessions', session: 'drv-1', action_owner: 'approval', options: [{ label: 'Allow once' }, { label: 'Deny' }] })
    advanceClock(5 * 60_000)
    await bootApp(db)
    const parts = (id: string) => ['.ny-project', '.ny-agent', '.ny-branch', '.ny-age', '.ny-title', '.ny-next', '.ny-plan']
      .map((cls) => { const el = laneCard(id)!.querySelector<HTMLElement>(cls)!; return el.hidden ? null : el.textContent })
    expect(parts(item)).toEqual(['alpha', 'Claude Code', 'feat/x', '5m', 'Pick one.', null, null])
    expect(parts(step)).toEqual(['alpha', 'Copilot', 'main', '5m', 'Do Rotate the token.', 'Rotate the token is ready.', 'Plan · Plan for Rotate the token · Rotate the token'])
    const approval = laneCards().find((el) => el.querySelector('.ny-title')?.textContent === 'Allow shell: npm test')!
    expect(approval.querySelector('.ny-title')?.classList.contains('mono')).toBe(true)
    for (const el of laneCards()) expect(el.querySelector('button, input, textarea, select, a, .row-answer, .options')).toBeNull()
    // no action card on the Dashboard: one per ask, under its Inbox row (DESIGN.md)
    expect(document.querySelector('#dashboard .nrow-card, #dashboard .reply-input')).toBeNull()
  })

  it('says the empty text and keeps the lane; Later shows only when N > 0; Review queue stays in both', async () => {
    db = freshDb()
    await bootApp(db)
    expect(lane()).not.toBeNull()
    expect(document.querySelector<HTMLElement>('.ny-empty')?.textContent).toBe(NEEDS_YOU_EMPTY)
    expect(NEEDS_YOU_EMPTY).toBe('Nothing in this view is waiting on you.')
    expect(document.querySelector<HTMLElement>('.ny-empty')?.hidden).toBe(false)
    expect(document.querySelector<HTMLElement>('.ny-later')?.hidden).toBe(true)
    expect(document.querySelector<HTMLElement>('.ny-review')?.hidden).toBe(false)
    expect(chipCount('needs')).toBe('0')

    const later = question(db, 'Pinned for later')
    await pollTick()
    expect(document.querySelector<HTMLElement>('.ny-empty')?.hidden).toBe(true)
    await showInbox()
    click(row(later)!)
    await settle()
    click(row(later)!.querySelector('.disposition-menu > summary'))
    click(buttonLabelled('Pin for later', row(later)!))
    await settle()
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()
    expect(document.querySelector<HTMLElement>('.ny-empty')?.hidden).toBe(false)
    const laterButton = document.querySelector<HTMLButtonElement>('#dashboard .needs-you-lane .ny-later')!
    expect([laterButton.hidden, laterButton.textContent]).toEqual([false, 'Later 1 ›'])
    click(laterButton)
    await settle()
    expect(shown('needsYou')).toBe(true)
    expect(document.querySelector<HTMLDetailsElement>('[data-deferred-fold="later"]')?.open).toBe(true)
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()
    click(document.querySelector('#dashboard .needs-you-lane .ny-review'))
    await settle()
    expect(document.querySelector<HTMLElement>('#lightbox')?.hidden).toBe(false)
    // the Agents card no longer has either
    expect(document.querySelector('.agents-home .ah-later, .agents-home .ah-review')).toBeNull()
  })

  it('does not call a session ended that a lens only hides', async () => {
    db = freshDb()
    live(db, 'elsewhere', { project: 'beta' })
    const id = question(db, 'Filed in alpha from beta', { session: 'elsewhere' })
    await bootApp(db)
    click(document.querySelector('#rail button.rail-tab[data-project="alpha"]'))
    await settle()
    expect(laneIds()).toEqual([id])
    expect(laneCard(id)?.querySelector<HTMLElement>('.ny-session')?.hidden).toBe(true)
    endActivity(db, 'elsewhere')
    await pollTick()
    expect(laneCard(id)?.querySelector('.ny-session')?.textContent).toBe('session ended')
  })
})

describe('a card leads with what the Inbox leads with (§3.2)', () => {
  // painted directly, so each shape of ask is one synthetic entry
  function paintLane(entries: unknown[], deps: Record<string, unknown> = {}) {
    const lane = installNeedsYouLane({ open: vi.fn(), ...deps })
    const el = lane.element()
    document.body.append(el)
    lane.paint({ entries: entries as never, later: 0, nowMs: Date.now() })
    return el
  }
  const at = () => new Date().toISOString()
  const itemEntry = (item: Record<string, unknown>) =>
    ({ kind: 'item', item: { id: 'i1', project: 'alpha', kind: 'question', status: 'open', created_at: at(), ...item }, liveness: 'parked' })
  const rowEntry = (r: Record<string, unknown>) =>
    ({ kind: 'row', board: { id: 'b1', project: 'alpha', title: 'Release plan', stream: 'main', agent: 'copilot' }, row: { id: 'r1', status: 'blocked', updated_at: at(), ...r }, liveness: 'parked' })
  const parts = (el: HTMLElement) => ['.ny-title', '.ny-next', '.ny-plan']
    .map((cls) => { const part = el.querySelector<HTMLElement>(cls)!; return part.hidden ? null : part.textContent })

  it('a plan row with a next step: the step, then its note; the plan line names the plan and the row', () => {
    const el = paintLane([rowEntry({ label: 'Lanes PR 2', note: 'The PR is green.', next_step: 'Merge PR 2.' })])
    expect(parts(el)).toEqual(['Merge PR 2.', 'The PR is green.', 'Plan · Release plan · Lanes PR 2'])
    expect(el.querySelector<HTMLElement>('.ny-title')!.title).toBe('Lanes PR 2')
    expect(el.querySelector('.ny-card')!.getAttribute('aria-label')).toBe('Merge PR 2. alpha · Copilot · main')
    el.remove()
  })

  it('a plan row with no next step: its label, then its note', () => {
    const el = paintLane([rowEntry({ label: 'Lanes PR 2', note: 'The PR is green.' })])
    expect(parts(el)).toEqual(['Lanes PR 2', 'The PR is green.', 'Plan · Release plan · Lanes PR 2'])
    el.remove()
  })

  it('a question with a next step leads with it, its detail under it; without one, its title', () => {
    let el = paintLane([itemEntry({ title: 'Which release?', detail: 'Two builds are ready.', next_step: 'Pick a build.' })])
    expect(parts(el)).toEqual(['Pick a build.', 'Two builds are ready.', null])
    expect(el.querySelector<HTMLElement>('.ny-title')!.title).toBe('Which release?')
    expect(el.querySelector('.ny-card')!.getAttribute('aria-label')!.startsWith('Pick a build.')).toBe(true)
    el.remove()
    el = paintLane([itemEntry({ title: 'Which release?', detail: 'Two builds are ready.' })])
    expect(parts(el)).toEqual(['Which release?', 'Two builds are ready.', null])
    el.remove()
  })

  it('shows the next step under a headline that is not the step', () => {
    // an outcome means the request is no longer the headline (card.js actionPresentation)
    const el = paintLane([itemEntry({ title: 'Which release?', detail: 'Two builds are ready.', next_step: 'Pick a build.', outcome: 'Shipped 2.' })])
    expect(parts(el)).toEqual(['Which release?', 'Pick a build.', null])
    el.remove()
  })

  it('an app approval’s tool line is mono only while it is the headline', () => {
    let el = paintLane([itemEntry({ project: '@sessions', title: 'Allow shell: npm test' })])
    expect(el.querySelector('.ny-title')!.classList.contains('mono')).toBe(true)
    el.remove()
    el = paintLane([itemEntry({ project: '@sessions', title: 'Allow shell: npm test', next_step: 'Approve or decline.' })])
    expect(el.querySelector('.ny-title')!.classList.contains('mono')).toBe(false)
    el.remove()
  })

  it('keeps text that looks like HTML as text', () => {
    const html = '<img src=x onerror="alert(1)"><b>bold</b>'
    const el = paintLane([rowEntry({ label: html, note: `<i>${html}</i>`, next_step: `<a href="x">${html}</a>` })])
    expect(parts(el)).toEqual([`<a href="x">${html}</a>`, `<i>${html}</i>`, `Plan · Release plan · ${html}`])
    expect(el.querySelector('.ny-title *, .ny-next *, .ny-plan *')).toBeNull()
    el.remove()
  })

  it('the Dashboard card’s headline is the Inbox row’s', async () => {
    db = freshDb()
    const step = blockedRow(db, 'Rotate the token')
    const item = question(db, 'Which release?', { next_step: 'Pick one.', detail: 'Two builds.' })
    await bootApp(db)
    const lane = [step, item].map((id) => laneCard(id)!.querySelector('.ny-title')!.textContent)
    await showInbox()
    expect(lane).toEqual([step, item].map((id) => row(id)!.querySelector('.nrow-title')!.textContent))
    expect(lane).toEqual(['Do Rotate the token.', 'Pick one.'])
  })
})

describe('the Draft tag (§3.2)', () => {
  it('shows "Draft" on a card while the Inbox holds an unsent answer for that ask', async () => {
    db = freshDb()
    const id = question(db, 'Half answered')
    const other = question(db, 'Untouched')
    await bootApp(db)
    const draftTag = (ask: string) => laneCard(ask)!.querySelector<HTMLElement>('.ny-draft')!
    expect(draftTag(id).hidden).toBe(true)
    await showInbox()
    click(row(id)!)
    await settle()
    type(answerInput(id), 'Not sure yet')
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()
    expect([draftTag(id).hidden, draftTag(id).textContent]).toEqual([false, 'Draft'])
    expect(draftTag(other).hidden).toBe(true)
    expect(laneCard(id)!.getAttribute('aria-label')).toMatch(/unsent draft/)
  })

  it('reads the draft through its dep, keyed by the ask’s id', () => {
    const hasDraft = vi.fn((id: string) => id === 'r1')
    const laneApi = installNeedsYouLane({ open: vi.fn(), hasDraft })
    const el = laneApi.element()
    document.body.append(el)
    const at = new Date().toISOString()
    laneApi.paint({
      entries: [
        { kind: 'row', board: { id: 'b1', project: 'alpha', title: 'Plan' }, row: { id: 'r1', label: 'Step', status: 'blocked', updated_at: at } },
        { kind: 'item', item: { id: 'i1', project: 'alpha', kind: 'question', status: 'open', title: 'Ask', created_at: at } },
      ] as never,
      later: 0,
      nowMs: Date.now(),
    })
    const tags = [...el.querySelectorAll<HTMLElement>('.ny-draft')].map((tag) => tag.hidden)
    expect(tags).toEqual([false, true])
    expect(hasDraft.mock.calls.map(([id]) => id).sort()).toEqual(['i1', 'r1'])
    el.remove()
  })
})

describe('the lane holds still under the human (§2 anti-goals, §8)', () => {
  it('a poll keeps a selection inside a card, and a click that ends a selection stays on the Dashboard', async () => {
    db = freshDb()
    const id = question(db, 'Copy this title')
    await bootApp(db)
    const title = laneCard(id)!.querySelector<HTMLElement>('.ny-title')!
    document.getSelection()!.selectAllChildren(title)
    await changedPollTick(db)
    expect(laneCard(id)!.querySelector('.ny-title')).toBe(title)
    expect(String(document.getSelection())).toBe('Copy this title')
    click(title)
    await settle()
    expect(shown('dashboard')).toBe(true)
  })

  it('a pointer press holds the lane, then the next poll paints it', async () => {
    db = freshDb()
    const id = question(db, 'Press me')
    await bootApp(db)
    await vi.advanceTimersByTimeAsync(2800)
    laneCard(id)!.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    // insertItem, not question(): advancing the clock would outlast the press
    insertItem(db, { ...AGENT, kind: 'question', title: 'Arrives during the press' })
    await vi.advanceTimersByTimeAsync(200)
    expect(laneCards()).toHaveLength(1)
    laneCard(id)!.dispatchEvent(new Event('pointerup', { bubbles: true }))
    await pollTick()
    expect(laneCards()).toHaveLength(2)
  })

  it('a card under the pointer keeps its place; the next paint after the pointer leaves takes sortRail order', async () => {
    db = freshDb()
    const older = question(db, 'Parked, older')
    const newer = question(db, 'Parked, newer')
    live(db, 'here')
    await bootApp(db)
    expect(laneIds()).toEqual([older, newer])
    lane().dispatchEvent(new Event('pointerenter'))
    const waiting = question(db, 'The agent waits on this', { session: 'here' })
    await pollTick()
    // sortRail puts the waiting ask first; under the pointer it is appended instead
    expect(laneIds()).toEqual([older, newer, waiting])
    lane().dispatchEvent(new Event('pointerleave'))
    await changedPollTick(db)
    expect(laneIds()).toEqual(railOrder(db))
    expect(laneIds()[0]).toBe(waiting)
  })

  it('holds the order while a card has keyboard focus, so the focused card never moves', async () => {
    db = freshDb()
    const older = question(db, 'Parked, older')
    const newer = question(db, 'Parked, newer')
    live(db, 'here')
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const focused = laneCard(newer)!
    focused.focus()
    const waiting = question(db, 'The agent waits on this', { session: 'here' })
    await pollTick()
    expect(laneIds()).toEqual([older, newer, waiting])
    expect(document.activeElement).toBe(focused)
    expect(chipCount('needs')).toBe('3')
  })
})

describe('a card opens its ask in the Inbox, and Esc comes back (§3.2)', () => {
  it('a click and Enter open the Inbox panel at that ask, an item and a plan row alike', async () => {
    db = freshDb()
    const item = question(db, 'Open me')
    const step = blockedRow(db, 'Open my row')
    await bootApp(db)
    click(laneCard(item)!.querySelector('.ny-title'))
    await settle()
    expect(shown('needsYou')).toBe(true)
    expect(row(item)?.dataset.open).toBe('1')
    expect(row(item)?.querySelector('.nrow-card')).not.toBeNull()

    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()
    laneCard(step)!.focus()
    expect(key(laneCard(step)!, 'Enter').defaultPrevented).toBe(true)
    await settle()
    expect(shown('needsYou')).toBe(true)
    expect(row(step)?.dataset.open).toBe('1')
    expect(row(step)?.querySelector('.nrow-card')).not.toBeNull()
  })

  it('opens a plan row the Inbox would page past its first ten', async () => {
    db = freshDb()
    advanceClock()
    upsertBoard(db, {
      ...AGENT, title: 'A long plan',
      rows: Array.from({ length: 12 }, (_, n) => ({ label: `Step ${n}`, status: 'blocked', next_step: `Do ${n}.`, action_owner: 'task', impact: 'It matters.' })),
    })
    const ids = listBoards(db)[0]!.rows.map((r) => r.id)
    await bootApp(db)
    await showInbox()
    const hidden = ids.filter((id) => row(id) === null)
    expect(hidden.length).toBeGreaterThan(0)
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()
    const last = hidden.at(-1)!
    click(laneCard(last))
    await settle()
    expect(row(last)?.dataset.open).toBe('1')
    expect(row(last)?.querySelector('.nrow-card')).not.toBeNull()
  })

  it('Esc and the close control return to the Dashboard, scrolled where it was, the lens kept, focus on the card', async () => {
    db = freshDb()
    const id = question(db, 'Take me back')
    const other = question(db, 'Another', { project: 'beta' })
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 420 })
    click(laneCard(id))
    await settle()
    expect(shown('needsYou')).toBe(true)
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 })
    await collapseRow(id)
    expect(shown('dashboard')).toBe(true)
    expect(scrollTo).toHaveBeenLastCalledWith(0, 420)
    expect(document.activeElement).toBe(laneCard(id))
    // the lens was All projects, and still is
    expect(laneIds().sort()).toEqual([id, other].sort())
    expect(document.querySelector('#needsYouList .nrow[data-open="1"]')).toBeNull()

    Object.defineProperty(window, 'scrollY', { configurable: true, value: 420 })
    click(laneCard(id))
    await settle()
    click(row(id)!.querySelector('.nrow-card-close'))
    await settle()
    expect(shown('dashboard')).toBe(true)
    expect(document.activeElement).toBe(laneCard(id))
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 })
  })

  it('an ask outside the restored lens (⌘K "answer…") returns focus to the lane’s heading', async () => {
    db = freshDb()
    question(db, 'Alpha ask')
    const beta = question(db, 'Beta ask', { project: 'beta' })
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    click(document.querySelector('#rail button.rail-tab[data-project="alpha"]'))
    await settle()
    document.getElementById('search')!.focus()
    await searchFor('answer beta')
    const option = [...document.querySelectorAll<HTMLElement>('#searchResults [role="option"]')]
      .find((el) => el.querySelector('.search-result-main')?.textContent === 'Beta ask')
    click(option!)
    await settle()
    expect(row(beta)?.dataset.open).toBe('1')
    await collapseRow(beta)
    expect(shown('dashboard')).toBe(true)
    expect(laneCard(beta)).toBeNull()
    expect(document.activeElement).toBe(document.getElementById('needsYouLaneTitle'))
  })

  it('answering leaves you in the Inbox', async () => {
    db = freshDb()
    const id = question(db, 'Answer me')
    question(db, 'Keep the Inbox open')
    await bootApp(db)
    click(laneCard(id))
    await settle()
    type(answerInput(id), 'Done')
    click(sendButton(id))
    await settle()
    expect(getItem(db, id)?.reply).toBe('Done')
    expect(shown('needsYou')).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await settle()
    expect(shown('needsYou')).toBe(true)
  })

  it('an ask opened from the Inbox, or closed by the narrow row toggle, never returns', async () => {
    db = freshDb()
    const id = question(db, 'Opened in the Inbox')
    await bootApp(db)
    await showInbox()
    click(row(id))
    await settle()
    await collapseRow(id)
    expect(shown('needsYou')).toBe(true)
    expect(rows()).toHaveLength(1)
  })

  it('a narrow window’s row toggle closes the card in the Inbox, and gives up the way back', async () => {
    setViewport('narrow')
    db = freshDb()
    const id = question(db, 'Narrow one')
    await bootApp(db)
    click(laneCard(id))
    await settle()
    expect(row(id)?.dataset.open).toBe('1')
    click(row(id))
    await settle()
    expect(shown('needsYou')).toBe(true)
    click(row(id))
    await settle()
    await collapseRow(id)
    expect(shown('needsYou')).toBe(true)
    setViewport('wide')
  })

  it('offers Show on Agents › only where a session card holds the ask or its session is live', async () => {
    db = freshDb()
    live(db, 'here')
    idle(db, 'quiet', { project: 'q', stream: 'dev', agent: 'claude-code' })
    const own = question(db, 'Live one', { session: 'here' })
    const gone = question(db, 'Ended one', { session: 'gone' })
    const joined = blockedRow(db, 'Joined to the idle one', {}, { project: 'q', stream: 'dev', agent: 'claude-code' })
    await bootApp(db)
    await showInbox()
    const show = async (id: string) => {
      click(row(id))
      await settle()
      return row(id)?.querySelector('.nrow-show-agents') ?? null
    }
    expect(await show(gone)).toBeNull()
    expect(row(gone)?.querySelector('.nrow-session')?.textContent).toBe('session ended')
    expect(await show(joined)).not.toBeNull()
    expect(await show(own)).not.toBeNull()
    click(row(own)!.querySelector('.nrow-show-agents'))
    await settle()
    expect(shown('dashboard')).toBe(true)
    expect(panel().dataset.session).toBe('here')
    expect(panel().querySelector(`[data-panel-ask="${own}"]`)).not.toBeNull()
  })
})

describe('session cards carry only a chip (§3.3, §3.4)', () => {
  it('a session that starts asking gains its chip, and its ask appears in the lane on the next paint', async () => {
    db = freshDb()
    live(db, 'here')
    await bootApp(db)
    const card = () => sessionCard('session:here')!
    expect(card().querySelector<HTMLElement>('.sc-asking')?.hidden).toBe(true)
    const id = question(db, 'New ask', { session: 'here' })
    await pollTick()
    expect(card().querySelector<HTMLElement>('.sc-asking')?.hidden).toBe(false)
    expect(card().querySelector('.sc-asking')?.textContent).toBe('Asking you · 1')
    expect(laneIds()).toEqual([id])
    expect(chipCount('needs')).toBe('1')
    expect(card().querySelector('.sc-state')?.textContent).toBe('Working')
    expect(card().classList.contains('tone-working')).toBe(true)
    expect(card().textContent).not.toContain('New ask')
  })

  it('the chip scrolls to and focuses that session’s first ask in the lane, and opens no panel', async () => {
    db = freshDb()
    live(db, 'here')
    question(db, 'Someone else’s')
    const first = question(db, 'Mine, first', { session: 'here' })
    question(db, 'Mine, second', { session: 'here' })
    await bootApp(db)
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
    click(sessionCard('session:here')!.querySelector('.sc-asking'))
    await settle()
    expect(document.activeElement).toBe(laneCard(first))
    expect(laneCard(first)?.tabIndex).toBe(0)
    expect(scroll).toHaveBeenCalled()
    expect(panel().hidden).toBe(true)
  })

  it('a launch card’s chip never runs a launch action', () => {
    const host = document.createElement('div')
    host.className = 'dashboard'
    const grid = document.createElement('div')
    grid.className = 'dashboard-grid'
    host.append(grid)
    document.body.append(host)
    const showAsk = vi.fn()
    const launchAction = vi.fn()
    const home = installAgentsHome({
      openSession: vi.fn(), showAsk, launchAction,
      launches: () => ({ granted: () => true, newSession: () => null, openNewSession: () => {} }),
    })
    grid.append(home.element())
    const at = new Date().toISOString()
    home.paint(host, {
      activity: [],
      launches: [{ id: '11111111-2222-4333-8444-000000000001', project: 'alpha', stream: 'main', status: 'parked', mode: 'ask', sessions: ['s1'], created_at: at, updated_at: at, parked_at: at }],
      attention: [{ kind: 'item', item: { id: 'ask-1', project: 'alpha', session: 's1', kind: 'question', title: 'Go on?', created_at: at }, liveness: 'parked' }] as never,
      nowMs: Date.now(),
    })
    const chipEl = host.querySelector<HTMLButtonElement>('.sc-asking')!
    expect(chipEl.textContent).toBe('Asking you · 1')
    chipEl.click()
    expect(showAsk).toHaveBeenCalledWith('ask-1')
    expect(launchAction).not.toHaveBeenCalled()
    host.remove()
  })
})

describe('the page head’s lane chips (§3.1)', () => {
  it('count Needs you, Working and Quiet, and 0 when empty', async () => {
    db = freshDb()
    live(db, 'w')
    idle(db, 'q1')
    idle(db, 'q2', { project: 'beta' })
    question(db, 'One')
    question(db, 'Two', { session: 'q1' })
    await bootApp(db)
    expect(['needs', 'working', 'quiet'].map(chipCount)).toEqual(['2', '1', '2'])
    expect(chip('needs').classList.contains('att')).toBe(true)
    expect(chip('working').getAttribute('aria-label')).toBe('Working: 1')
  })

  it('show 0 for an empty lane', async () => {
    db = freshDb()
    await bootApp(db)
    expect(['needs', 'working', 'quiet'].map(chipCount)).toEqual(['0', '0', '0'])
    expect(chip('needs').classList.contains('att')).toBe(false)
  })

  it('say "…" for a lane still being read, never a false 0', () => {
    const head = installDashHead({ onChip: vi.fn() })
    const el = head.element()
    head.paint({ needs: 3, working: null, quiet: null })
    const count = (k: string) => el.querySelector(`[data-dash-chip="${k}"] .dash-chip-count`)?.textContent
    expect([count('needs'), count('working'), count('quiet')]).toEqual(['3', '…', '…'])
    expect(el.querySelector('[data-dash-chip="working"]')?.getAttribute('aria-label')).toBe('Working: reading')
    const text = el.querySelector('[data-dash-chip="needs"] .dash-chip-count')!.firstChild
    head.paint({ needs: 3, working: 0, quiet: 2 })
    // an unchanged count is never rewritten
    expect(el.querySelector('[data-dash-chip="needs"] .dash-chip-count')!.firstChild).toBe(text)
    expect([count('working'), count('quiet')]).toEqual(['0', '2'])
  })

  it('a chip scrolls to and focuses its first card and never filters', async () => {
    db = freshDb()
    idle(db, 'q1', { project: 'beta' })
    live(db, 'w')
    const ask = question(db, 'First ask')
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
    const before = [...document.querySelectorAll<HTMLElement>('#dashboard [data-session-card]')].map((el) => el.dataset.sessionCard)
    click(chip('needs'))
    expect(document.activeElement).toBe(laneCard(ask))
    click(chip('working'))
    expect(document.activeElement).toBe(sessionCard('session:w'))
    click(chip('quiet'))
    expect(document.activeElement).toBe(sessionCard('session:q1'))
    // each chip scrolls to its own lane; a Working card or Quiet row deep in its lane is revealed too
    expect(scroll).toHaveBeenCalledTimes(5)
    expect(scroll.mock.contexts.filter((el) => el === sessionCard('session:w') || el === sessionCard('session:q1'))).toHaveLength(2)
    expect(scroll.mock.contexts.filter((el) => el === document.querySelector('#dashboard .working-lane') || el === document.querySelector('#dashboard .quiet-lane'))).toHaveLength(2)
    expect(document.querySelector('#dashboard [data-ah-filter]')).toBeNull()
    expect([...document.querySelectorAll<HTMLElement>('#dashboard [data-session-card]')].map((el) => el.dataset.sessionCard)).toEqual(before)
    expect(shown('dashboard')).toBe(true)
  })

  it('a key move in a session lane reveals the card it lands on', async () => {
    db = freshDb()
    live(db, 'w1')
    live(db, 'w2')
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const cards = [...document.querySelectorAll<HTMLElement>('#dashboard .working-lane [data-session-card]')]
    expect(cards).toHaveLength(2)
    cards[0]!.focus()
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
    key(cards[0]!, 'j')
    expect(document.activeElement).toBe(cards[1])
    expect(scroll.mock.contexts).toEqual([cards[1]])
    expect(scroll.mock.calls[0]![0]).toMatchObject({ block: 'nearest' })
    // at the lane's end nothing moves and nothing scrolls
    key(cards[1]!, 'j')
    expect(document.activeElement).toBe(cards[1])
    expect(scroll).toHaveBeenCalledTimes(1)
  })

  it('a Working or Quiet chip lands in its own lane, whose size it counts (PR 4)', async () => {
    db = freshDb()
    idle(db, 'q1', { project: 'beta' })
    live(db, 'w')
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    click(chip('quiet'))
    expect(document.activeElement).toBe(sessionCard('session:q1'))
    expect(sessionCard('session:q1')?.closest('.quiet-lane')).not.toBeNull()
    expect(chipCount('quiet')).toBe(String(document.querySelectorAll('#dashboard .quiet-lane .qt-rows [data-session-card]').length))
    click(chip('working'))
    expect(document.activeElement).toBe(sessionCard('session:w'))
    expect(sessionCard('session:w')?.closest('.working-lane')).not.toBeNull()
    expect(chipCount('working')).toBe(String(document.querySelectorAll('#dashboard .working-lane .ah-cards [data-session-card]').length))
  })

  it('an empty lane’s chip lands on its heading', async () => {
    db = freshDb()
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    click(chip('needs'))
    expect(document.activeElement).toBe(document.getElementById('needsYouLaneTitle'))
    click(chip('working'))
    expect(document.activeElement).toBe(document.getElementById('workingLaneTitle'))
    click(chip('quiet'))
    expect(document.activeElement).toBe(document.getElementById('quietLaneTitle'))
  })

  it('replaces the Now strip, and New session… sits at the head’s right end', async () => {
    db = freshDb()
    await bootApp(db)
    expect(document.querySelector('.dash-now, [data-dashboard-signal]')).toBeNull()
    expect(document.querySelector('#dashboard .dash-head .dash-head-actions .ah-new')).not.toBeNull()
    expect(document.querySelector('.agents-home .ah-new')).toBeNull()
    // the head first, then the lane above the grid
    const host = document.querySelector('#dashboard .dashboard')!
    expect(host.firstElementChild?.classList.contains('dash-head')).toBe(true)
    expect(lane().nextElementSibling?.classList.contains('dashboard-grid')).toBe(true)
  })
})

describe('the keyboard (§3.1)', () => {
  it('Tab reaches the chips, then the lane; J/K and the arrows move one roving stop; Enter opens; G I still opens the Inbox', async () => {
    db = freshDb()
    const a = question(db, 'First')
    const b = question(db, 'Second')
    const c = question(db, 'Third')
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const tabbable = [...document.querySelectorAll<HTMLElement>('#dashboard button, #dashboard [tabindex]')]
      .filter((el) => el.tabIndex >= 0 && !el.closest('[hidden]') && !(el as HTMLButtonElement).disabled)
    expect(tabbable.slice(0, 5).map((el) => el.dataset.dashChip ?? el.className)).toEqual(['needs', 'working', 'quiet', 'ny-review', 'ny-card'])
    expect(tabbable.filter((el) => el.classList.contains('ny-card'))).toHaveLength(1)
    expect(laneCards().map((el) => el.tabIndex)).toEqual([0, -1, -1])

    laneCard(a)!.focus()
    expect(key(laneCard(a)!, 'j').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(laneCard(b))
    key(laneCard(b)!, 'ArrowDown')
    expect(document.activeElement).toBe(laneCard(c))
    key(laneCard(c)!, 'ArrowRight')
    expect(document.activeElement).toBe(laneCard(c))
    key(laneCard(c)!, 'k')
    key(laneCard(b)!, 'ArrowUp')
    expect(document.activeElement).toBe(laneCard(a))
    key(laneCard(a)!, 'j')
    expect(laneCards().map((el) => el.tabIndex)).toEqual([-1, 0, -1])
    // the roving stop survives a poll
    await changedPollTick(db)
    expect(laneCards().map((el) => el.tabIndex)).toEqual([-1, 0, -1])
    expect(document.activeElement).toBe(laneCard(b))

    key(laneCard(b)!, 'g')
    key(laneCard(b)!, 'i')
    await settle()
    expect(shown('needsYou')).toBe(true)
    expect(document.querySelector('#needsYouList .nrow[data-open="1"]')).toBeNull()
  })
})
