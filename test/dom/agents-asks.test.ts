// @vitest-environment jsdom
// #454 amendment A.1–A.2 (PR 5): every ask in the Agents view. Every attention
// entry is on exactly one session card, an ask whose session no card shows on
// an ask-only card, and the session panel's Asking you section answers it with
// the Inbox's own controls and writes, under the rail's draft rules.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { closeProject, getItem, insertItem, listBoards, resolveItem, upsertActivity, upsertBoard } from '../../src/store.js'
import type { ViewerBridge } from './harness.js'
import {
  advanceClock, answerInput, badgeCount, bootApp, buttonLabelled, click, freshDb, navigateToHash, pollTick, row,
  sendButton, settle, showInbox, type, useDomTest,
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
const needsYou = () => Number(document.querySelector('.agents-home [data-ah-filter="ask"] .ah-filter-count')?.textContent)
const body = (bridge: ViewerBridge, match: string): Record<string, unknown> =>
  JSON.parse(String(bridge.posts.find((post) => post.url.includes(match))?.init?.body ?? '{}'))
async function answerOn(key: string): Promise<void> {
  click(card(key)?.querySelector('[data-ah-action="review"]'))
  await settle()
}

describe('every ask on a card (#454 A.1)', () => {
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
    const ended = card('ask:session:gone')!
    expect([ended.querySelector('.sc-state')?.textContent, ended.querySelector('.sc-chips')?.textContent, ended.querySelector('.sc-when')?.textContent])
      .toEqual(['Session ended', 'Claude Code', 'last heard just now'])

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

  it('draws ask-only cards with the switch off and reads nothing new: Open in Inbox and Answer, no composer or actions', async () => {
    db = freshDb()
    const id = question(db, 'Keep the Sessions line?', { session: 'gone', agent: 'claude-code' })
    const reads: string[] = []
    await bootApp(db, { interceptFetch: async (input, _init, next) => { reads.push(String(input)); return next() } })
    expect(reads.some((url) => url.includes('/api/launch'))).toBe(false)
    const ended = card('ask:session:gone')!
    expect(ended.classList.contains('sc-ask-only')).toBe(true)
    expect([...ended.querySelectorAll('[data-ah-action]')].map((el) => el.textContent)).toEqual(['Open in Inbox', 'Answer'])
    await answerOn('ask:session:gone')
    expect(panel().hidden).toBe(false)
    expect(block(id)).not.toBeNull()
    expect(panel().querySelector<HTMLElement>('.dash-focus-message')?.hidden).toBe(true)
    expect(panel().querySelector<HTMLElement>('.sp-actions')?.hidden).toBe(true)
    click(card('ask:session:gone')?.querySelector('[data-ah-action="inbox"]'))
    await settle()
    expect(document.getElementById('needsYou')?.hidden).toBe(false)
    expect(location.hash).toBe(`#item/${id}`)
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
    expect(card('session:here')?.querySelector('[data-ah-action="review"]')?.textContent).toBe('Answer · draft')
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
    expect(card('session:here')?.querySelector('[data-ah-action="review"]')?.textContent).toBe('Answer · draft')
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
