// @vitest-environment jsdom
// #454 amendment A.1–A.2 (PR 5), as the dashboard lanes design (§3.2, §6) left
// it: every attention entry shows once, in the Needs you lane; a session card
// holds at most one of them and only counts it; and the session panel's Asking
// you section answers a card's asks with the Inbox's own controls and writes,
// under the rail's draft rules.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import {
  annotateItem, closeProject, endActivity, getItem, insertItem, listBoards, recordActivityCall, resolveItem, touchActivity, upsertActivity, upsertBoard,
} from '../../src/store.js'
import type { ViewerBridge } from './harness.js'
import {
  advanceClock, answerInput, badgeCount, bootApp, buttonLabelled, click, freshDb, navigateToHash, pollTick, row,
  sendButton, settle, setViewport, showInbox, type, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
let reload: ReturnType<typeof vi.fn>
beforeEach(() => {
  reload = vi.fn()
  vi.stubGlobal('location', { hash: '', reload })
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

const panel = () => document.querySelector<HTMLElement>('#dashboard .dash-focus')!
const block = (id: string) => panel().querySelector<HTMLElement>(`[data-panel-ask="${id}"]`)
const editor = (id: string) => block(id)?.querySelector<HTMLTextAreaElement>('.reply-input:not(.reply-context-input)') ?? null
const askAction = (id: string, name: string) => block(id)?.querySelector<HTMLButtonElement>(`[data-ask-action="${name}"]`) ?? null
const card = (key: string) => [...document.querySelectorAll<HTMLElement>('#dashboard [data-session-card]')].find((el) => el.dataset.sessionCard === key) ?? null
// the page head's Needs you chip, which counts the lane (dashboard lanes design §3.1)
const needsYou = () => Number(document.querySelector('#dashboard [data-dash-chip="needs"] .dash-chip-count')?.textContent)
const laneCard = (id: string) => [...document.querySelectorAll<HTMLElement>('#dashboard .ny-card')].find((el) => el.dataset.nyAsk === id) ?? null
const body = (bridge: ViewerBridge, match: string): Record<string, unknown> =>
  JSON.parse(String(bridge.posts.find((post) => post.url.includes(match))?.init?.body ?? '{}'))
// the card's click opens its session panel, whose Asking you section holds the card's asks
async function answerOn(key: string): Promise<void> {
  click(card(key)?.querySelector('.sc-doing'))
  await settle()
}

describe('every ask in the Needs you lane (#454 A.1, lanes design §3.2)', () => {
  it('counts the attention set under Needs you in each lens, the badge with All projects, ended and session-less asks included', async () => {
    db = freshDb()
    live(db, 'here')
    question(db, 'From a live session', { session: 'here' })
    question(db, 'From an ended session', { session: 'gone', agent: 'claude-code' })
    question(db, 'From no session', { project: 'beta' })
    blockedRow(db, 'Rotate the token', {}, { project: 'beta', agent: 'claude-code' })
    const snoozed = question(db, 'Snoozed')
    question(db, 'In a closed project', { project: 'shut' })
    closeProject(db, 'shut')
    await bootApp(db)
    await showInbox()
    click(row(snoozed)!)
    await settle()
    click(row(snoozed)!.querySelector('.disposition-menu > summary'))
    click(buttonLabelled('Tomorrow', row(snoozed)!))
    await settle()
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()

    expect(badgeCount()).toBe(4)
    expect(needsYou()).toBe(4)
    const ended = [...document.querySelectorAll<HTMLElement>('#dashboard .ny-card')].find((el) => el.querySelector('.ny-title')?.textContent === 'From an ended session')!
    expect([ended.querySelector('.ny-session')?.textContent, ended.querySelector('.ny-agent')?.textContent])
      .toEqual(['session ended', 'Claude Code'])

    click(document.querySelector('#rail button.rail-tab[data-project="alpha"]'))
    await settle()
    expect(needsYou()).toBe(2)
    click(document.querySelector('#rail button.rail-tab[data-project="beta"]'))
    await settle()
    expect(needsYou()).toBe(2)
    click(document.querySelector('#rail [data-project="__all__"]'))
    await settle()
    const agents = document.getElementById('agentSelect') as HTMLSelectElement
    agents.value = 'claude-code'
    agents.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    expect(needsYou()).toBe(2)
  })

  it('shows an ended session’s ask in the lane with the switch off, reads nothing new, draws no card for it, and opens its Inbox card', async () => {
    db = freshDb()
    const id = question(db, 'Keep the Sessions line?', { session: 'gone', agent: 'claude-code' })
    const reads: string[] = []
    await bootApp(db, { interceptFetch: async (input, _init, next) => { reads.push(String(input)); return next() } })
    expect(reads.some((url) => url.includes('/api/launch'))).toBe(false)
    expect(document.querySelector('#dashboard [data-session-card]')).toBeNull()
    expect(laneCard(id)?.querySelector('.ny-session')?.textContent).toBe('session ended')
    click(laneCard(id))
    await settle()
    expect(document.getElementById('needsYou')?.hidden).toBe(false)
    expect(location.hash).toBe(`#item/${id}`)
    expect(row(id)?.dataset.open).toBe('1')
  })
})

describe('the session panel answers (#454 A.2)', () => {
  it('answers a question with the Inbox’s exact request, and an option with one click', async () => {
    db = freshDb()
    live(db, 'here')
    const fromPanel = question(db, 'Panel question', { session: 'here' })
    const fromInbox = question(db, 'Inbox question', { session: 'here' })
    const choice = question(db, 'Ship it?', { session: 'here', options: [{ label: 'Hold' }, { label: 'Ship', recommended: true }] })
    const bridge = await bootApp(db)
    await answerOn('session:here')
    expect(block(choice)?.querySelector('.opt-pill .rec-star')?.textContent).toBe('★')
    expect(block(fromPanel)?.querySelector('.sp-ask-waiting')?.textContent).toBe('the agent is waiting')
    type(editor(fromPanel), 'From the panel')
    click(buttonLabelled('Send', block(fromPanel)!))
    await settle()
    expect(getItem(db, fromPanel)?.reply).toBe('From the panel')
    expect(block(fromPanel)).toBeNull()
    click([...block(choice)!.querySelectorAll('.opt-pill')].find((el) => el.textContent?.includes('Ship')))
    await settle()
    expect(getItem(db, choice)?.reply).toBe('Ship')

    await showInbox()
    click(row(fromInbox))
    await settle()
    type(answerInput(fromInbox), 'From the Inbox')
    click(sendButton(fromInbox))
    await settle()
    const panelBody = body(bridge, `/api/items/${fromPanel}/reply`)
    const inboxBody = body(bridge, `/api/items/${fromInbox}/reply`)
    expect(Object.keys(panelBody).sort()).toEqual(Object.keys(inboxBody).sort())
    expect(panelBody['expect_answer']).toEqual(inboxBody['expect_answer'])
  })

  it('answers a blocked row with its revision pins and marks a task done, from the panel', async () => {
    db = freshDb()
    live(db, 'here')
    const approve = blockedRow(db, 'Approve', { action_owner: 'approval', options: [{ label: 'Approve', recommended: true }, { label: 'Hold' }] }, { session: 'here' })
    const task = blockedRow(db, 'Paddle account', {}, { session: 'here' })
    const bridge = await bootApp(db)
    await answerOn('session:here')
    const board = listBoards(db).find((b) => b.rows[0]!.id === approve)!
    click([...block(approve)!.querySelectorAll('.opt-pill')].find((el) => el.textContent?.includes('Approve')))
    await settle()
    expect(body(bridge, `/rows/${approve}/annotate`)).toMatchObject({
      text: 'Approve', kind: 'answer', expected_revision: board.rows[0]!.revision, expected_board_version: board.revision,
    })
    click(block(task)!.querySelector('.handled-btn'))
    await settle()
    expect(listBoards(db).find((b) => b.rows[0]!.id === task)!.rows[0]!.handled_at).toBeTruthy()
    // answered, not yet picked up: dimmed below, and never counted
    expect([...panel().querySelectorAll<HTMLElement>('.sp-answered')].map((el) => el.dataset.panelAnswered).sort()).toEqual([approve, task].sort())
    expect(panel().querySelector('.sp-answered')?.textContent).toContain('not picked up yet')
    expect(needsYou()).toBe(0)
  })

  it('offers More… (Clarify, Decline, I’ll take a while), Snooze and Pin, each through the Inbox’s writes', async () => {
    db = freshDb()
    live(db, 'here')
    const clarify = question(db, 'Clarify me', { session: 'here' })
    const decline = question(db, 'Decline me', { session: 'here' })
    const wait = question(db, 'Wait on me', { session: 'here', action_owner: 'decision', options: [{ label: 'A' }, { label: 'B' }] })
    const snooze = question(db, 'Snooze me', { session: 'here' })
    const pin = question(db, 'Pin me', { session: 'here' })
    await bootApp(db)
    await answerOn('session:here')
    const more = (id: string) => [...block(id)!.querySelectorAll('summary')].find((el) => el.textContent === 'More…')!
    click(more(clarify))
    click(buttonLabelled('Needs clarification', block(clarify)!))
    await settle()
    expect(getItem(db, clarify)?.reply_kind).toBe('clarify')
    click(more(decline))
    click(buttonLabelled('Decline', block(decline)!))
    await settle()
    expect(getItem(db, decline)?.reply_kind).toBe('decline')
    click(more(wait))
    expect([...block(wait)!.querySelectorAll('summary')].map((el) => el.textContent)).toContain('I’ll take a while')
    click(buttonLabelled('Stop waiting', block(wait)!))
    await settle()
    expect(getItem(db, wait)?.watch_stopped_at).toBeTruthy()

    click(askAction(snooze, 'snooze'))
    await settle()
    expect(getItem(db, snooze)?.snoozed_until).toBeTruthy()
    expect(block(snooze)).toBeNull()
    click(askAction(pin, 'pin'))
    await settle()
    expect(getItem(db, pin)?.pinned_at).toBeTruthy()
    expect(block(pin)).toBeNull()
  })
})

describe('the panel’s draft rules (#454 A.2)', () => {
  it('pauses only the panel’s asks for a draft; a poll leaves them alone and a forced paint rebuilds them', async () => {
    db = freshDb()
    live(db, 'here')
    const id = question(db, 'Which day?', { session: 'here' })
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await answerOn('session:here')
    const input = editor(id)!
    input.focus()
    type(input, 'Thursday, after the backup')
    question(db, 'New arrival', { session: 'here' })
    await pollTick()
    expect(card('session:here')?.querySelector('.sc-asking')?.textContent).toBe('Asking you · 2')
    expect(editor(id)).toBe(input)
    expect(document.activeElement).toBe(input)
    expect(panel().querySelectorAll('[data-panel-ask]')).toHaveLength(1)
    // the rest of the Dashboard keeps moving: the count is current
    expect(needsYou()).toBe(2)
    expect(badgeCount()).toBe(2)
    expect(document.getElementById('pauseHint')?.textContent).toContain('paused')

    // a frame the human asks for rebuilds it, keeping the draft and the focus
    const range = document.querySelector<HTMLSelectElement>('.dashboard-range')!
    range.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    expect(panel().querySelectorAll('[data-panel-ask]')).toHaveLength(2)
    expect(editor(id)).not.toBe(input)
    expect(editor(id)?.value).toBe('Thursday, after the backup')
    expect(document.activeElement).toBe(editor(id))
  })

  // #462 review: the hold is the panel's, not its card's: a card's id moves under an open panel
  it('keeps the editor being typed in when its session ends and its card goes', async () => {
    db = freshDb()
    live(db, 'here')
    const id = question(db, 'Which day?', { session: 'here' })
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await answerOn('session:here')
    const input = editor(id)!
    input.focus()
    type(input, 'Thursday')
    endActivity(db, 'here')
    await pollTick()
    expect(card('session:here')).toBeNull()
    // the ask is in the lane, "session ended"; the panel holds the editor and says its session left
    expect(laneCard(id)?.querySelector('.ny-session')?.textContent).toBe('session ended')
    expect(editor(id)).toBe(input)
    expect(document.activeElement).toBe(input)
    expect(panel().querySelector<HTMLElement>('.dash-focus-gone')?.hidden).toBe(false)
  })

  it('keeps the drafted panel through its session leaving and coming back, rebuilding nothing', async () => {
    db = freshDb()
    live(db, 'gone')
    const id = question(db, 'Keep the Sessions line?', { session: 'gone' })
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await answerOn('session:gone')
    const input = editor(id)!
    input.focus()
    type(input, 'Keep it')
    endActivity(db, 'gone')
    await pollTick()
    expect(card('session:gone')).toBeNull()
    upsertActivity(db, { ...AGENT, session: 'gone', doing: 'Back at it', idle: false })
    await pollTick()
    expect(card('session:gone')).not.toBeNull()
    expect(editor(id)).toBe(input)
    expect(document.activeElement).toBe(input)
    expect(panel().hidden).toBe(false)
    expect(panel().dataset.session).toBe('gone')
    expect(panel().querySelector<HTMLElement>('.dash-focus-gone')?.hidden).toBe(true)
    expect(card('session:gone')?.classList.contains('sel')).toBe(true)
  })

  // #462 re-check: two working sessions on one branch trade an unstamped plan's row on every call
  async function tradedRow(d: Database.Database) {
    const id = blockedRow(d, 'Run the soak')
    for (const session of ['w1', 'w2']) {
      advanceClock()
      live(d, session, { receives_messages: true })
      recordActivityCall(d, session)
    }
    await bootApp(d)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    // the newest call links the plan: w2
    expect(card('session:w2')?.querySelector<HTMLElement>('.sc-asking')?.hidden).toBe(false)
    await answerOn('session:w2')
    type(editor(id), 'Started it')
    return id
  }
  const call = async (d: Database.Database, session: string) => {
    advanceClock()
    recordActivityCall(d, session)
    await pollTick()
  }

  it('stays on its own card while the row it drafts on moves between working sessions', async () => {
    db = freshDb()
    const id = await tradedRow(db)
    const input = editor(id)!
    input.focus()
    for (const session of ['w1', 'w2', 'w1']) {
      await call(db, session)
      expect(panel().dataset.session, session).toBe('w2')
      expect(editor(id)).toBe(input)
    }
    expect(card('session:w1')?.querySelector<HTMLElement>('.sc-asking')?.hidden).toBe(false)
    expect(card('session:w2')?.classList.contains('sel')).toBe(true)
    expect(card('session:w1')?.classList.contains('sel')).toBe(false)
  })

  it('never moves a message being written to another session when a drafted row leaves the card', async () => {
    db = freshDb()
    await tradedRow(db)
    const composer = panel().querySelector<HTMLTextAreaElement>('.dash-focus-message textarea')!
    composer.focus()
    type(composer, 'For w2 only')
    expect(document.activeElement).toBe(composer)
    await call(db, 'w1')
    expect(panel().dataset.session).toBe('w2')
    expect(composer.isConnected).toBe(true)
    expect(document.activeElement).toBe(composer)
    expect(composer.closest<HTMLElement>('.msg-composer')?.dataset.msgSession).toBe('w2')
  })

  it('restores focus after a rebuild only while the document has it', async () => {
    db = freshDb()
    live(db, 'here')
    const id = question(db, 'Keep my place', { session: 'here' })
    await bootApp(db)
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await answerOn('session:here')
    askAction(id, 'snooze')!.focus()
    question(db, 'Arrival', { session: 'here' })
    await pollTick()
    expect(panel().querySelectorAll('[data-panel-ask]')).toHaveLength(2)
    expect(document.activeElement).toBe(askAction(id, 'snooze'))

    // a background window remembers focus in the panel: the poll leaves it and moves nothing
    focus.mockReturnValue(false)
    const held = askAction(id, 'snooze')!
    const calls = vi.spyOn(HTMLElement.prototype, 'focus')
    question(db, 'Arrival while away', { session: 'here' })
    await pollTick()
    expect(calls).not.toHaveBeenCalled()
    expect(held.isConnected).toBe(true)
    expect(needsYou()).toBe(3)
  })

  it('keeps a draft when the panel closes, through durable storage and the viewer-restart hold', async () => {
    db = freshDb()
    live(db, 'here')
    const id = question(db, 'Release approval', { session: 'here' })
    let boot = 'original-viewer'
    await bootApp(db, {
      interceptFetch: async (_input, _init, next) => {
        const response = await next()
        response.headers.set('x-inbox-boot', boot)
        return response
      },
    })
    await answerOn('session:here')
    type(editor(id), 'Approve after the backup')
    await vi.advanceTimersByTimeAsync(300)
    const saved = JSON.parse(localStorage.getItem('agent-inbox-drafts-v1') ?? '{}') as { entries?: Record<string, { draft: { text?: string } }> }
    expect(Object.values(saved.entries ?? {}).map((entry) => entry.draft.text)).toContain('Approve after the backup')

    click(panel().querySelector('.dash-focus-close'))
    expect(panel().hidden).toBe(true)
    boot = 'restarted-viewer'
    await pollTick()
    expect(reload).not.toHaveBeenCalled()
    await answerOn('session:here')
    expect(editor(id)?.value).toBe('Approve after the backup')

    // the agent closes it: the draft goes to the unsent responses, never lost
    resolveItem(db, id, 'Approved in chat.')
    await pollTick()
    const range = document.querySelector<HTMLSelectElement>('.dashboard-range')!
    range.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    expect(block(id)).toBeNull()
    expect(document.querySelector('#needsYouList .stale-drafts-fold')?.textContent).toContain('Approve after the backup')
  })

  it('a deferral with a draft takes it to the Inbox card (keepDraftInView)', async () => {
    db = freshDb()
    live(db, 'here')
    const id = question(db, 'Snooze with a draft', { session: 'here' })
    await bootApp(db)
    await answerOn('session:here')
    type(editor(id), 'keep this')
    click(askAction(id, 'snooze'))
    await settle()
    expect(getItem(db, id)?.snoozed_until).toBeTruthy()
    expect(document.getElementById('needsYou')?.hidden).toBe(false)
    expect(answerInput(id)?.value).toBe('keep this')
  })

  it('a notification hash still lands on the Inbox card, not the panel', async () => {
    db = freshDb()
    live(db, 'here')
    const id = question(db, 'From a notification', { session: 'here' })
    await bootApp(db)
    navigateToHash(`#item/${id}`)
    await settle()
    expect(document.getElementById('needsYou')?.hidden).toBe(false)
    expect(row(id)?.getAttribute('aria-expanded')).toBe('true')
    expect(panel().hidden).toBe(true)
  })
})

// #454 PR 6: the rail retired; the session cards and their panel carry its abilities (A.2, A.3)
const key = (target: Element, name: string) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
// the Working lane's cards (dashboard lanes design §3.3)
const cardEls = () => [...document.querySelectorAll<HTMLElement>('#dashboard .working-lane .ah-groups [data-session-card]')]

describe('the Dashboard without the rail (#454 PR 6)', () => {
  it('has no rail: the Working and Quiet lanes span the grid, and the Needs you lane’s header holds Later and Review queue', async () => {
    db = freshDb()
    question(db, 'Asked here')
    const later = question(db, 'Pinned for later')
    await bootApp(db)
    await showInbox()
    click(row(later)!)
    await settle()
    click(row(later)!.querySelector('.disposition-menu > summary'))
    click(buttonLabelled('Pin for later', row(later)!))
    await settle()
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()
    expect(document.querySelector('#dashRail, .dash-rail, [data-rail-card]')).toBeNull()
    const laterButton = document.querySelector<HTMLButtonElement>('#dashboard .needs-you-lane .ny-later')!
    expect([laterButton.hidden, laterButton.textContent]).toEqual([false, 'Later 1 ›'])
    click(laterButton)
    await settle()
    expect(document.getElementById('needsYou')?.hidden).toBe(false)
    expect(document.querySelector<HTMLDetailsElement>('[data-deferred-fold="later"]')?.open).toBe(true)

    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()
    click(document.querySelector('#dashboard .needs-you-lane .ny-review'))
    await settle()
    expect(document.querySelector<HTMLElement>('#lightbox')?.hidden).toBe(false)
  })

  it('moves between cards with J/K and the arrows, one tabbable, and Enter opens the panel listing the card’s ask', async () => {
    db = freshDb()
    live(db, 'two', { doing: 'Second' })
    live(db, 'one', { doing: 'First' })
    const ask = question(db, 'Pick one', { session: 'one' })
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    // the newest call first: an ask never moves a card (lanes design §3.3)
    const [first, second] = cardEls()
    expect(first).toBe(card('session:one'))
    expect(cardEls().map((el) => el.tabIndex)).toEqual([0, -1])
    first!.focus()
    key(first!, 'j')
    expect(document.activeElement).toBe(second)
    expect(cardEls().map((el) => el.tabIndex)).toEqual([-1, 0])
    key(second!, 'ArrowUp')
    expect(document.activeElement).toBe(first)
    key(first!, 'Enter')
    expect(panel().hidden).toBe(false)
    expect(block(ask)).not.toBeNull()
    expect(document.activeElement).toBe(document.getElementById('dashFocusTitle'))
    // never on the card's own controls (its first, Open, the lanes' main action)
    const control = card('session:one')!.querySelector<HTMLElement>('[data-ah-action]')!
    expect(control.textContent).toBe('Open')
    control.focus()
    key(control, 'j')
    expect(document.activeElement).toBe(control)
  })

  it('answers from the keyboard in the panel: 1–4 choose, S snoozes, P pins, R goes to the answer; typing keeps its keys', async () => {
    db = freshDb()
    live(db, 'here')
    const choose = question(db, 'Choose', { session: 'here', options: [{ label: 'Alpha' }, { label: 'Beta' }] })
    const snooze = question(db, 'Snooze me', { session: 'here' })
    const pin = question(db, 'Pin me', { session: 'here' })
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await answerOn('session:here')
    // the card's click lands on the panel's title; the keys act on the ask block that has focus
    block(choose)!.focus()
    key(block(choose)!, 'r')
    expect(document.activeElement).toBe(editor(choose))
    expect(key(editor(choose)!, '2')).toBe(true)
    expect(getItem(db, choose)?.reply).toBeNull()
    key(block(choose)!, '2')
    await settle()
    expect(getItem(db, choose)?.reply).toBe('Beta')
    key(block(snooze)!, 's')
    await settle()
    expect(getItem(db, snooze)?.snoozed_until).toBeTruthy()
    key(block(pin)!, 'p')
    await settle()
    expect(getItem(db, pin)?.pinned_at).toBeTruthy()
  })

  it('offers Compare in the panel: options alone first, then each over its tradeoff', async () => {
    db = freshDb()
    live(db, 'here')
    const id = question(db, 'Which way?', { session: 'here', options: [{ label: 'Wait', recommended: true, detail: 'Safer.' }, { label: 'Merge', detail: 'Faster.' }] })
    await bootApp(db)
    await answerOn('session:here')
    const options = () => block(id)!.querySelector<HTMLElement>('.options')!
    expect(options().classList.contains('comparing')).toBe(false)
    click(buttonLabelled('Compare options', block(id)!))
    await settle()
    expect(options().classList.contains('comparing')).toBe(true)
    expect([...block(id)!.querySelectorAll('.opt-detail')].map((el) => el.textContent)).toEqual(['Safer.', 'Faster.'])
    expect(buttonLabelled('Hide option details', block(id)!)).not.toBeNull()
    // the Inbox keeps its own default: details shown
    await showInbox()
    click(row(id))
    await settle()
    expect(row(id)!.querySelector('.options')?.classList.contains('comparing')).toBe(true)
  })

  it('opens the panel under its card’s row in a narrow window, and goes back to the split on close', async () => {
    setViewport(760)
    db = freshDb()
    live(db, 'one', { doing: 'First' })
    const ask = question(db, 'Pick one', { session: 'one' })
    await bootApp(db)
    await answerOn('session:one')
    const host = card('session:one')!.parentElement!
    expect(panel().parentElement).toBe(host)
    expect(panel().previousElementSibling?.matches('[data-session-card]')).toBe(true)
    expect(block(ask)).not.toBeNull()
    // a poll keeps it there, and the cards keep their order around it
    question(db, 'Another', { session: 'one' })
    await pollTick()
    expect(panel().parentElement).toBe(host)
    click(panel().querySelector('.dash-focus-close'))
    expect(panel().parentElement?.classList.contains('dash-split')).toBe(true)
    setViewport('wide')
  })

  // #463 review: under 1280px the panel sits in a group's or fold's card grid; whatever
  // takes that grid away must leave the panel connected, in sight, and able to open again
  describe('a narrow window’s panel is never cut off with its card’s group or row (#463 review)', () => {
    const inSight = () => {
      expect(panel().isConnected).toBe(true)
      expect(panel().parentElement?.closest('[hidden], details:not([open])')).toBeNull()
    }
    const opensAgain = async (key: string) => {
      click(card(key)?.querySelector('.sc-doing'))
      await settle()
      expect(panel().hidden).toBe(false)
      expect(panel().dataset.card).toBe(key)
      inSight()
    }
    async function twoGroups(d: Database.Database) {
      live(d, 'one', { project: 'beta', doing: 'Alone in beta' })
      recordActivityCall(d, 'one')
      upsertActivity(d, { ...AGENT, session: 'two', doing: 'open', idle: true })
      question(d, 'Pick one', { session: 'two' })
      setViewport(760)
      await bootApp(d)
      click(card('session:one')?.querySelector('.sc-doing'))
      await settle()
      expect(panel().parentElement).toBe(card('session:one')!.parentElement)
    }
    afterEach(() => setViewport('wide'))

    it('when its session stops working and moves from Working to Quiet (lanes design §3.3)', async () => {
      db = freshDb()
      await twoGroups(db)
      upsertActivity(db, { ...AGENT, project: 'beta', session: 'one', doing: 'open', idle: true })
      await pollTick()
      expect(card('session:one')?.closest('.quiet-lane')).not.toBeNull()
      expect(document.querySelector('.working-lane .ah-group')).toBeNull()
      inSight()
      await opensAgain('session:two')
    })

    it('when its Quiet row’s session starts working, leaving Quiet empty (lanes design §3.4)', async () => {
      db = freshDb()
      await twoGroups(db)
      click(card('session:two')?.querySelector('.sc-doing'))
      await settle()
      expect(panel().parentElement?.classList.contains('qt-rows')).toBe(true)
      live(db, 'two', { doing: 'Back at it' })
      recordActivityCall(db, 'two')
      await pollTick()
      expect(card('session:two')?.closest('.working-lane')).not.toBeNull()
      expect(panel().dataset.card).toBe('session:two')
      inSight()
      await opensAgain('session:one')
    })

    it('when a poll takes its card’s group away', async () => {
      db = freshDb()
      await twoGroups(db)
      endActivity(db, 'one')
      await pollTick()
      expect(card('session:one')).toBeNull()
      inSight()
      expect(panel().querySelector<HTMLElement>('.dash-focus-gone')?.hidden).toBe(false)
      await opensAgain('session:two')
    })

    // #463 re-check: the move keeps the focus and caret it held, and paint() sends nothing to the heading
    it('keeps the answer being typed, caret and all, when its Quiet row moves to Working', async () => {
      db = freshDb()
      upsertActivity(db, { ...AGENT, project: 'beta', session: 'one', doing: 'open', idle: true })
      const ask = question(db, 'Which day?', { project: 'beta', session: 'one' })
      live(db, 'two', { doing: 'Asking in alpha' })
      question(db, 'Pick one', { session: 'two' })
      setViewport(760)
      await bootApp(db)
      vi.spyOn(document, 'hasFocus').mockReturnValue(true)
      await answerOn('session:one')
      expect(panel().parentElement?.classList.contains('qt-rows')).toBe(true)
      const input = editor(ask)!
      input.focus()
      type(input, 'Thursday after the backup')
      input.setSelectionRange(3, 8)
      // the session starts working: its row leaves Quiet, which is left empty
      upsertActivity(db, { ...AGENT, project: 'beta', session: 'one', doing: 'Back at it', idle: false })
      recordActivityCall(db, 'one')
      await pollTick()
      expect(card('session:one')?.closest('.working-lane')).not.toBeNull()
      inSight()
      expect(document.activeElement).toBe(input)
      expect([input.selectionStart, input.selectionEnd]).toEqual([3, 8])
      expect(document.activeElement).not.toBe(document.getElementById('quietLaneTitle'))
    })

    it('when the fold it opened in closes', async () => {
      db = freshDb()
      live(db, 'old', { doing: 'Long gone', receives_messages: true })
      recordActivityCall(db, 'old')
      live(db, 'old', { doing: 'open', idle: true, receives_messages: true })
      advanceClock(9 * 60 * 60 * 1000)
      live(db, 'two', { doing: 'Asking' })
      recordActivityCall(db, 'two')
      touchActivity(db, 'old')
      setViewport(760)
      await bootApp(db)
      const fold = document.querySelector<HTMLDetailsElement>('.agents-home [data-ah-fold="dormant"]')!
      fold.open = true
      fold.dispatchEvent(new Event('toggle'))
      vi.spyOn(document, 'hasFocus').mockReturnValue(true)
      click(card('session:old')?.querySelector('.sc-doing'))
      await settle()
      expect(fold.contains(panel())).toBe(true)
      const message = panel().querySelector<HTMLTextAreaElement>('.dash-focus-message textarea')!
      message.focus()
      type(message, 'hello there')
      message.setSelectionRange(5, 5)
      fold.open = false
      fold.dispatchEvent(new Event('toggle'))
      expect(fold.contains(panel())).toBe(false)
      inSight()
      expect(document.activeElement).toBe(message)
      expect([message.selectionStart, message.selectionEnd]).toEqual([5, 5])
      await opensAgain('session:two')
    })
  })

  it('names the ask’s session on the Inbox row, and Show on Agents opens a live one’s panel', async () => {
    db = freshDb()
    live(db, 'here', { stream: 'feat/x' })
    const own = question(db, 'Live one', { session: 'here' })
    const gone = question(db, 'Ended one', { session: 'gone' })
    const none = question(db, 'No session')
    await bootApp(db)
    await showInbox()
    expect(row(own)?.querySelector('.nrow-session')?.textContent).toBe('live · feat/x')
    expect(row(gone)?.querySelector('.nrow-session')?.textContent).toBe('session ended')
    expect(row(none)?.querySelector('.nrow-session')).toBeNull()
    // a session that has ended has no card to show it on (lanes design §6)
    click(row(gone))
    await settle()
    expect(buttonLabelled('Show on Agents ›', row(gone)!)).toBeNull()
    click(row(own))
    await settle()
    click(buttonLabelled('Show on Agents ›', row(own)!))
    await settle()
    expect(document.getElementById('dashboard')?.hidden).toBe(false)
    expect(panel().dataset.session).toBe('here')
    expect(block(own)).not.toBeNull()
  })

  // ported from the rail (#303, review of #389)
  it('holds the panel through a pointer press, then refreshes it', async () => {
    db = freshDb()
    live(db, 'here')
    const id = question(db, 'Press me', { session: 'here', options: [{ label: 'Yes' }, { label: 'No' }] })
    await bootApp(db)
    await answerOn('session:here')
    const pressed = [...block(id)!.querySelectorAll('.opt-pill')][0]!
    await vi.advanceTimersByTimeAsync(2800)
    pressed.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    insertItem(db, { ...AGENT, kind: 'question', title: 'Arrives during the press', session: 'here' })
    await vi.advanceTimersByTimeAsync(200)
    expect(pressed.isConnected).toBe(true)
    expect(panel().querySelectorAll('[data-panel-ask]')).toHaveLength(1)
    pressed.dispatchEvent(new Event('pointerup', { bubbles: true }))
    await pollTick()
    expect(panel().querySelectorAll('[data-panel-ask]')).toHaveLength(2)
  })

  it('holds the panel when a row drafted in the Inbox moves into it, so a poll never switches tabs or moves focus', async () => {
    db = freshDb()
    live(db, 'here')
    question(db, 'Already here', { session: 'here' })
    const task = blockedRow(db, 'Paddle account')
    await bootApp(db)
    await showInbox()
    click(row(task))
    await settle()
    type(answerInput(task), 'Done, see the receipt')
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()
    await answerOn('session:here')
    const before = document.activeElement
    advanceClock()
    const board = listBoards(db).find((b) => b.title === 'Plan for Paddle account')!
    upsertBoard(db, {
      ...AGENT, title: board.title, expectedVersion: board.revision, session: 'here',
      rows: [{ label: 'Paddle account', revision: board.rows[0]!.revision, status: 'blocked', note: 'The agent rewrote this.' }],
    })
    await pollTick()
    await settle()
    expect(document.getElementById('dashboard')?.hidden).toBe(false)
    expect(document.getElementById('needsYou')?.hidden).toBe(true)
    expect(document.activeElement).toBe(before)
  })

  it('offers Pin on a question that carries a Note, and shows a draft edited in the Review queue once it closes', async () => {
    db = freshDb()
    live(db, 'here')
    const id = question(db, 'Annotated question', { session: 'here' })
    annotateItem(db, id, 'Feedback, not an answer')
    await bootApp(db)
    await answerOn('session:here')
    expect(askAction(id, 'pin')).not.toBeNull()
    type(editor(id), 'foo')
    click(document.querySelector('#dashboard .ny-review'))
    await settle()
    type(document.querySelector<HTMLTextAreaElement>('#lightbox .reply-input:not(.reply-context-input)'), 'foobar')
    click(document.querySelector('#lightbox .lb-close'))
    await settle()
    expect(editor(id)?.value).toBe('foobar')
  })
})

