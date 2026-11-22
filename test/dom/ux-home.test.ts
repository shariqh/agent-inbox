// @vitest-environment jsdom
// UX pass, slice 2: one Home. The Inbox page folded into the Dashboard: the list
// of asks and the opened ask live on Home, the ask in front; the Needs you lane,
// the lane chips and the Inbox tab are gone.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getItem, insertItem, listBoards, recordActivityCall, replyItem, resolveItem, snoozeItem, upsertActivity, upsertBoard } from '../../src/store.js'
import { installAgentsHome } from '../../public/agents-home.js'
import {
  advanceClock, answerInput, bootApp, buttonLabelled, changedPollTick, click, collapseRow, freshDb, navigateToHash, pollTick, row, rows,
  searchFor, sendButton, settle, setViewport, showInbox, T0, tabCount, type, useDomTest,
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

describe('the list’s header is quiet (step 3)', () => {
  const header = () => document.querySelector<HTMLElement>('#needsYouList .tab-header')!
  const tools = () => header().querySelector<HTMLElement>('.queue-tools')!
  const toggle = () => header().querySelector<HTMLButtonElement>('.queue-tools-toggle')!
  const count = () => header().querySelector<HTMLElement>('.queue-count')!
  const visible = (el: Element | null) => Boolean(el) && !el!.closest('[hidden]')

  it('rests on its heading, its count and Filter; the toggle shows and hides the tools', async () => {
    db = freshDb()
    question(db, 'One')
    await bootApp(db)
    const head = header().querySelector('.queue-head')!
    expect([...head.children].map((el) => el.tagName + (el.id ? `#${el.id}` : `.${el.className}`)))
      .toEqual(['H2#needsYouTitle', 'B.queue-count', 'BUTTON.queue-tools-toggle'])
    expect(document.getElementById('needsYouTitle')?.textContent).toBe('Needs you')
    expect(document.getElementById('needsYou')?.getAttribute('aria-labelledby')).toBe('needsYouTitle')
    expect([toggle().textContent, toggle().getAttribute('aria-controls'), toggle().getAttribute('aria-expanded')])
      .toEqual(['Filter', 'queueTools', 'false'])
    expect(tools().id).toBe('queueTools')
    expect(tools().hidden).toBe(true)
    // the hold line stays outside the wrapper, always in the document
    expect(header().querySelector(':scope > .triage-hold')).not.toBeNull()
    expect(tools().querySelector('.triage-hold')).toBeNull()
    click(toggle())
    expect(tools().hidden).toBe(false)
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    await pollTick()
    expect(tools().hidden, 'a poll keeps the open tools open').toBe(false)
    click(toggle())
    expect(tools().hidden).toBe(true)
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
  })

  it('shows the tools whatever the toggle says while a filter or a non-default sort is in force', async () => {
    db = freshDb()
    question(db, 'One')
    await bootApp(db)
    click(toggle())
    click(header().querySelector('[data-action-filter="decision"]'))
    await settle()
    click(toggle())
    expect(tools().hidden, 'an active filter is never out of sight').toBe(false)
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    click(header().querySelector('[data-action-filter="all"]'))
    await settle()
    // back to rest by the toggle, never under the hand on a filter
    expect(tools().hidden).toBe(false)
    click(toggle())
    expect(tools().hidden).toBe(true)
    const sort = header().querySelector<HTMLSelectElement>('.queue-sort select')!
    sort.value = 'newest'
    sort.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    click(toggle())
    expect(tools().hidden, 'a non-default sort is never out of sight').toBe(false)
    sort.value = 'priority'
    sort.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    click(toggle())
    expect(tools().hidden).toBe(true)
  })

  it('counts the asks that still wait under the lens and the filters, hidden at zero', async () => {
    db = freshDb()
    question(db, 'Alpha decision')
    blockedRow(db, 'Alpha task')
    question(db, 'Harbor decision', { project: 'harbor' })
    const answered = question(db, 'Answered already')
    await bootApp(db)
    click(row(answered))
    await settle()
    type(answerInput(answered), 'Yes')
    click(sendButton(answered))
    await settle()
    expect([count().hidden, count().textContent]).toEqual([false, '3'])
    click(document.querySelector('#rail button.rail-tab[data-project="atlas"]'))
    await settle()
    expect(count().textContent).toBe('2')
    click(header().querySelector('[data-action-filter="task"]'))
    await settle()
    expect(count().textContent).toBe('1')
    click(document.querySelector('#rail button.rail-tab[data-project="harbor"]'))
    await settle()
    expect([count().hidden, count().textContent]).toEqual([true, ''])
  })

  // jsdom keeps every earlier boot's document listeners in one file, so these press no `t`
  it('shows the tools before the Review queue’s way back focuses its button', async () => {
    db = freshDb()
    question(db, 'One')
    await bootApp(db)
    click(toggle())
    const button = header().querySelector<HTMLButtonElement>('.triage-btn')!
    button.focus()
    click(button)
    await settle()
    const lightbox = document.getElementById('lightbox')!
    expect(lightbox.hidden).toBe(false)
    // the tools go out of sight while the deck is open; its close still lands on a shown button
    click(toggle())
    expect(tools().hidden).toBe(true)
    click(lightbox.querySelector('.lb-close'))
    await settle()
    expect(document.activeElement).toBe(button)
    expect(visible(document.activeElement), 'a hidden control is never a focus target').toBe(true)
  })

  it('the hold line focuses a control that is not hidden', async () => {
    db = freshDb()
    const id = question(db, 'Release day?')
    localStorage.setItem('agent-inbox-drafts-v1', JSON.stringify({ v: 1, entries: {
      [`item-recovery:page:${id}`]: { savedAt: Date.now() - 1000, draft: {
        type: 'item-recovery', itemId: id, title: 'Release day?', text: 'Friday.', context: '', kind: 'answer', intent: null,
        reason: 'Not sent because this question changed.',
      } },
    } }))
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    expect(tools().hidden).toBe(true)
    click(header().querySelector('.triage-btn'))
    await settle()
    expect(document.getElementById('lightbox')!.hidden).toBe(true)
    expect(document.activeElement).toBe(buttonLabelled('Show it'))
    expect(visible(document.activeElement)).toBe(true)
    expect(tools().hidden, 'the Review queue the person asked for is in view').toBe(false)
  })

  it('says "Nothing needs you" when nothing waits', async () => {
    db = freshDb()
    await bootApp(db)
    expect(document.querySelector('#needsYouList .calm-head')?.textContent).toBe('Nothing needs you')
    expect(count().hidden).toBe(true)
  })
})

describe('one Home (step 1)', () => {
  it('names the tabs Home, Plans, Notes, History, Chats; Home carries the count; the page is Home with no kicker', async () => {
    db = freshDb()
    question(db, 'One')
    question(db, 'Two', { project: 'harbor' })
    await bootApp(db)
    expect([...document.querySelectorAll('#tabs .tab:not([hidden]) .tab-name')].map((el) => el.textContent))
      .toEqual(['Home', 'Plans', 'Notes', 'History', 'Chats'])
    expect(document.querySelector('[data-tab="needsYou"]')).toBeNull()
    expect(tabCount('dashboard')).toBe('2')
    // filter-blind: a lens narrows the list, never Home's count
    click(document.querySelector('#rail button.rail-tab[data-project="harbor"]'))
    await settle()
    expect(rows()).toHaveLength(1)
    expect(tabCount('dashboard')).toBe('2')
    expect(document.getElementById('pageTitle')?.textContent).toBe('Home')
    expect(document.getElementById('pageKicker')?.hidden).toBe(true)
    expect(document.getElementById('pageKicker')?.textContent).toBe('')
  })

  it('shows the list and the lanes together on Home, the list first; hides both on Plans and under Settings', async () => {
    db = freshDb()
    await bootApp(db)
    const list = document.getElementById('needsYou')!
    const lanes = document.getElementById('dashboard')!
    expect([list.hidden, lanes.hidden]).toEqual([false, false])
    expect(list.compareDocumentPosition(lanes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(list.getAttribute('role')).toBe('region')
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    expect([list.hidden, lanes.hidden]).toEqual([true, true])
    expect(document.getElementById('pageTitle')?.textContent).toBe('Plans')
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()
    expect([list.hidden, lanes.hidden]).toEqual([false, false])
    click(document.getElementById('gear'))
    await settle()
    expect(document.getElementById('setup')?.hidden).toBe(false)
    expect([list.hidden, lanes.hidden]).toEqual([true, true])
  })

  it('lands a deep link, a search result and G I on Home with the ask open (G I: the first row focused), from Plans too', async () => {
    db = freshDb()
    question(db, 'First ask')
    const second = question(db, 'Second ask about the harbor')
    const third = question(db, 'Third ask')
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)

    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    navigateToHash(`#item/${second}`)
    await settle()
    expect(document.querySelector('.tab[data-tab="dashboard"]')?.getAttribute('aria-selected')).toBe('true')
    expect(openIds()).toEqual([second])
    expect(row(second)?.querySelector('.nrow-card')).not.toBeNull()

    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    await searchFor('Third ask')
    click(document.querySelector(`#searchResults [role="option"][data-search-target="${third}"]`))
    await settle()
    expect(document.querySelector('.tab[data-tab="dashboard"]')?.getAttribute('aria-selected')).toBe('true')
    expect(openIds()).toEqual([third])

    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    ;(document.activeElement as HTMLElement | null)?.blur()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true, cancelable: true }))
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true, cancelable: true }))
    await settle()
    expect(document.querySelector('.tab[data-tab="dashboard"]')?.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(rows()[0])
  })
})

describe('the ask in front (step 4)', () => {
  const front = () => document.body.classList.contains('ask-front')

  it('opens the first waiting ask at the first paint with data on a wide window, moving no focus and scrolling nothing', async () => {
    db = freshDb()
    const first = question(db, 'First ask')
    question(db, 'Second ask')
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
    const scrollTo = vi.spyOn(window, 'scrollTo')
    const bridge = await bootApp(db)
    expect(openIds()).toEqual([first])
    expect(rows()[0]?.dataset.cardId).toBe(first)
    expect(row(first)?.querySelector('.nrow-card')).not.toBeNull()
    expect(front()).toBe(true)
    expect(document.activeElement).toBe(document.body)
    expect(scroll).not.toHaveBeenCalled()
    expect(scrollTo).not.toHaveBeenCalled()
    expect(bridge.posts.filter((post) => !post.url.includes('/api/mesh'))).toEqual([])
    // the keyboard's row is the ask in front
    expect(row(first)?.classList.contains('selected')).toBe(true)
  })

  it('opens nothing when only answered asks or asks in a closed fold are listed', async () => {
    db = freshDb()
    const answered = question(db, 'Answered')
    replyItem(db, answered, 'Yes')
    const snoozed = question(db, 'Snoozed')
    snoozeItem(db, snoozed, new Date(T0 + 24 * 60 * 60_000).toISOString())
    await bootApp(db)
    expect(row(answered)).not.toBeNull()
    expect(row(snoozed)?.closest('details:not([open])')).not.toBeNull()
    expect(openIds()).toEqual([])
    expect(front()).toBe(false)
    await changedPollTick(db)
    expect(openIds()).toEqual([])
  })

  it('opens nothing by itself on a narrow window, and never sets the class', async () => {
    setViewport('narrow')
    db = freshDb()
    const id = question(db, 'Narrow ask')
    await bootApp(db)
    expect(openIds()).toEqual([])
    expect(front()).toBe(false)
    await changedPollTick(db)
    expect(openIds()).toEqual([])
    click(row(id))
    await settle()
    expect(openIds()).toEqual([id])
    expect(front(), 'the inline card is not the ask in front').toBe(false)
    setViewport('wide')
  })

  it('stays closed after ✕ or Esc across later polls; a click on a row opens it again; Plans and back brings it forward', async () => {
    db = freshDb()
    const first = question(db, 'First ask')
    const second = question(db, 'Second ask')
    await bootApp(db)
    expect(openIds()).toEqual([first])
    click(row(first)!.querySelector('.nrow-card-close'))
    await settle()
    expect(openIds()).toEqual([])
    expect(front()).toBe(false)
    await changedPollTick(db)
    await changedPollTick(db)
    expect(openIds(), 'the person closed the front').toEqual([])
    click(row(second))
    await settle()
    expect(openIds()).toEqual([second])
    await collapseRow(second)
    expect(openIds()).toEqual([])
    await changedPollTick(db)
    expect(openIds()).toEqual([])
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()
    expect(openIds()).toEqual([first])
    expect(front()).toBe(true)
  })

  it('brings a new ask to the front when nothing was waiting', async () => {
    db = freshDb()
    await bootApp(db)
    expect(openIds()).toEqual([])
    const id = question(db, 'Arrives later')
    await pollTick()
    expect(openIds()).toEqual([id])
    expect(front()).toBe(true)
  })

  // the resolve-by-key case lives in ux-home-keys.test.ts: jsdom keeps every earlier boot's
  // document listeners in one file, so only a file's first test can press E
  it('opens nothing by itself while a frame is held by a press', async () => {
    db = freshDb()
    await bootApp(db)
    question(db, 'Arrived under a press')
    await vi.advanceTimersByTimeAsync(3000 - ((Date.now() - T0) % 3000) - 100)
    document.getElementById('needsYouTitle')!.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(200)
    expect(openIds()).toEqual([])
    window.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true }))
    await pollTick()
    expect(openIds()).toHaveLength(1)
  })

  it('opens nothing by itself while a session composer holds the frame', async () => {
    db = freshDb()
    upsertActivity(db, { ...AGENT, session: 'mcp-a', doing: 'Working', idle: false, receives_messages: true })
    recordActivityCall(db, 'mcp-a')
    await bootApp(db)
    const card = sessionCard('session:mcp-a')!
    click(card.querySelector('[data-ah-action="message"]'))
    await settle()
    const box = panel().querySelector<HTMLTextAreaElement>('.msg-composer textarea')!
    box.focus()
    type(box, 'Half a thought')
    question(db, 'Arrives while typing')
    await pollTick()
    expect(openIds()).toEqual([])
    expect(document.activeElement).toBe(box)
  })

  it('keeps one thing in front on a wide window: a session panel closes the ask, an ask closes the panel', async () => {
    db = freshDb()
    live(db, 'here')
    const id = question(db, 'Ask in front')
    await bootApp(db)
    expect(openIds()).toEqual([id])
    click(sessionCard('session:here')!.querySelector('.sc-doing'))
    await settle()
    expect(panel().hidden).toBe(false)
    expect(openIds()).toEqual([])
    expect(front()).toBe(false)
    await changedPollTick(db)
    expect(openIds(), 'nothing comes to the front while the panel is open').toEqual([])
    click(row(id))
    await settle()
    expect(openIds()).toEqual([id])
    expect(panel().hidden).toBe(true)
    expect(front()).toBe(true)
  })

  it('keeps both inline on a narrow window', async () => {
    setViewport('narrow')
    db = freshDb()
    live(db, 'here')
    const id = question(db, 'Inline ask')
    await bootApp(db)
    click(row(id))
    await settle()
    click(sessionCard('session:here')!.querySelector('.sc-doing'))
    await settle()
    expect(panel().hidden).toBe(false)
    expect(openIds()).toEqual([id])
    setViewport('wide')
  })

  it('resolving an ask in front from elsewhere leaves it out, and the next comes forward', async () => {
    db = freshDb()
    const first = question(db, 'First ask')
    const second = question(db, 'Second ask')
    await bootApp(db)
    expect(openIds()).toEqual([first])
    resolveItem(db, first)
    await pollTick()
    expect(openIds()).toEqual([second])
    expect(document.activeElement, 'no focus was in the list, so none moves').toBe(document.body)
  })
})

describe('the stylesheet (step 4)', () => {
  const css = readFileSync(resolve(process.cwd(), 'public/style.css'), 'utf8')
  it('keeps the ask-front rules before the one responsive @media block', () => {
    const media = css.indexOf('@media (max-width: 1279px)')
    expect(media).toBeGreaterThan(-1)
    for (const rule of [
      'body.ask-front #needsYouList, body.ask-front #dashboard { padding-right: calc(var(--inspector-width) + 28px); }',
      'body.ask-front :is(.plans-lane, .dashboard-outcomes, .dashboard-activity) { display: none; }',
      'body.ask-front .inspector-resizer { display: block; }',
    ]) {
      const at = css.indexOf(rule)
      expect(at, rule).toBeGreaterThan(-1)
      expect(at, rule).toBeLessThan(media)
    }
    expect(css.slice(media)).not.toContain('ask-front')
    expect(css).toMatch(/\n\.inspector-resizer \{ display: none; \}/)
    expect(css).not.toMatch(/#needsYou(List)?\s*\{[^}]*min-height/)
  })
})
