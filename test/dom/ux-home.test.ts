// @vitest-environment jsdom
// UX pass, slice 2: one Home. The Inbox page folded into the Dashboard: the list
// of asks and the opened ask live on Home, the ask in front; the Needs you lane,
// the lane chips and the Inbox tab are gone.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { getItem, insertItem, listBoards, upsertActivity, upsertBoard } from '../../src/store.js'
import { installAgentsHome } from '../../public/agents-home.js'
import {
  advanceClock, answerInput, bootApp, click, freshDb, pollTick, row, sendButton, settle, showInbox, type, useDomTest,
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

const AGENT = { project: 'atlas', stream: 'main', agent: 'copilot' } as const

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

const sessionCard = (key: string) => [...document.querySelectorAll<HTMLElement>('#dashboard [data-session-card]')].find((el) => el.dataset.sessionCard === key) ?? null
const panel = () => document.querySelector<HTMLElement>('#dashboard .dash-focus')!
const shown = (id: string) => !document.getElementById(id)?.hidden
const openIds = () => [...document.querySelectorAll<HTMLElement>('#needsYouList .nrow[data-open="1"]')].map((el) => el.dataset.cardId)
const key = (target: Element, name: string) => {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

describe('the ask and the session panel (moved from the Needs you lane tests)', () => {
  it('an answered ask keeps its row and its open card, and closing it stays on Home', async () => {
    db = freshDb()
    const id = question(db, 'Answer me')
    question(db, 'Keep the list open')
    await bootApp(db)
    click(row(id))
    await settle()
    type(answerInput(id), 'Done')
    click(sendButton(id))
    await settle()
    expect(getItem(db, id)?.reply).toBe('Done')
    expect(row(id)?.dataset.open).toBe('1')
    expect(row(id)?.querySelector('.nrow-card')).not.toBeNull()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await settle()
    expect(shown('needsYou')).toBe(true)
    expect(shown('dashboard')).toBe(true)
  })

  it('offers Show on Agents › only where a session card holds the ask or its session is live', async () => {
    db = freshDb()
    live(db, 'here')
    idle(db, 'quiet', { project: 'harbor', stream: 'dev', agent: 'claude-code' })
    const own = question(db, 'Live one', { session: 'here' })
    const gone = question(db, 'Ended one', { session: 'gone' })
    const joined = blockedRow(db, 'Joined to the idle one', {}, { project: 'harbor', stream: 'dev', agent: 'claude-code' })
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
    expect(row(own)?.querySelector('.nrow-show-agents')?.getAttribute('title')).toBe('Open this ask in its session’s panel')
    click(row(own)!.querySelector('.nrow-show-agents'))
    await settle()
    expect(shown('dashboard')).toBe(true)
    expect(panel().dataset.session).toBe('here')
    expect(panel().querySelector(`[data-panel-ask="${own}"]`)).not.toBeNull()
  })

  it('a session that starts asking gains its chip, and its ask appears in the list on the next paint', async () => {
    db = freshDb()
    live(db, 'here')
    await bootApp(db)
    const card = () => sessionCard('session:here')!
    expect(card().querySelector<HTMLElement>('.sc-asking')?.hidden).toBe(true)
    const id = question(db, 'New ask', { session: 'here' })
    await pollTick()
    expect(card().querySelector<HTMLElement>('.sc-asking')?.hidden).toBe(false)
    expect(card().querySelector('.sc-asking')?.textContent).toBe('Asking you · 1')
    expect(row(id)).not.toBeNull()
    expect(card().querySelector('.sc-state')?.textContent).toBe('Working')
    expect(card().classList.contains('tone-working')).toBe(true)
    expect(card().textContent).not.toContain('New ask')
  })

  it('the "Asking you" chip opens that session’s first waiting ask in front, and opens no panel', async () => {
    db = freshDb()
    live(db, 'here')
    const other = question(db, 'Someone else’s')
    const first = question(db, 'Mine, first', { session: 'here' })
    question(db, 'Mine, second', { session: 'here' })
    await bootApp(db)
    click(row(other))
    await settle()
    click(sessionCard('session:here')!.querySelector('.sc-asking'))
    await settle()
    expect(openIds()).toEqual([first])
    expect(row(first)?.querySelector('.nrow-card')).not.toBeNull()
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
      launches: [{ id: '11111111-2222-4333-8444-000000000001', project: 'atlas', stream: 'main', status: 'parked', mode: 'ask', sessions: ['s1'], created_at: at, updated_at: at, parked_at: at }],
      attention: [{ kind: 'item', item: { id: 'ask-1', project: 'atlas', session: 's1', kind: 'question', title: 'Go on?', created_at: at }, liveness: 'parked' }] as never,
      nowMs: Date.now(),
    })
    const chipEl = host.querySelector<HTMLButtonElement>('.sc-asking')!
    expect(chipEl.textContent).toBe('Asking you · 1')
    chipEl.click()
    expect(showAsk).toHaveBeenCalledWith('ask-1')
    expect(launchAction).not.toHaveBeenCalled()
    host.remove()
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
})

describe('no lane, no chips (step 2)', () => {
  it('draws no Needs you lane and no lane chips; New session… is at the end of the Working lane’s head, its note after it', async () => {
    db = freshDb()
    await bootApp(db)
    expect(document.querySelector('.needs-you-lane')).toBeNull()
    expect(document.querySelector('.dash-chips')).toBeNull()
    expect(document.querySelector('.inspector-empty')).toBeNull()
    const head = document.querySelector('#dashboard .working-lane > .ah-lane-head')!
    const start = head.querySelector('.ah-new')
    expect(start).not.toBeNull()
    expect(head.lastElementChild).toBe(start)
    expect(head.nextElementSibling?.classList.contains('ah-note')).toBe(true)
    expect(document.querySelector('#dashboard .dashboard')?.firstElementChild?.classList.contains('dash-since')).toBe(true)
  })
})
