// @vitest-environment jsdom
// Issue #303, Dashboard 2.0 phase 1: the Needs you rail. The top three asks of
// the one attention set, answered on the Dashboard with the Inbox's own controls
// and writes. Every write ends in reloadAndPaint(), a draft in the rail pauses
// the rail alone, drafts join recovery, durable storage and the viewer-restart
// hold, a background window keeps its focus, and the press guard holds.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import {
  getItem, insertItem, listBoards, resolveItem, upsertActivity, upsertBoard,
} from '../../src/store.js'
import type { ViewerBridge } from './harness.js'
import {
  advanceClock, answerInput, badgeCount, bootApp, buttonLabelled, changedPollTick, click, freshDb, pollTick, row,
  rows, sendButton, settle, showInbox, tabCount, type, useDomTest,
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

function blockedRow(d: Database.Database, label: string, extra: Record<string, unknown> = {}): string {
  advanceClock()
  upsertBoard(d, {
    ...AGENT,
    title: `Plan for ${label}`,
    rows: [{
      label, status: 'blocked', note: `${label} is ready.`, next_step: `Do ${label}.`, action_owner: 'task',
      impact: 'Unblocks the release.', ...extra,
    }],
  })
  return listBoards(d).find((board) => board.title === `Plan for ${label}`)!.rows[0]!.id
}

const railIds = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('#dashRail [data-rail-card]')].map((card) => card.dataset.railCard!)
const railCard = (id: string) => document.querySelector<HTMLElement>(`#dashRail [data-rail-card="${id}"]`)
const railEditor = (id: string) => railCard(id)?.querySelector<HTMLTextAreaElement>('.reply-input:not(.reply-context-input)') ?? null
const railAction = (id: string, action: string) => railCard(id)?.querySelector<HTMLButtonElement>(`[data-rail-action="${action}"]`) ?? null
const pill = (id: string, label: string) => [...railCard(id)?.querySelectorAll<HTMLButtonElement>('.opt-pill') ?? []]
  .find((button) => button.textContent?.includes(label)) ?? null
const signal = (name: string): string =>
  document.querySelector(`[data-dashboard-signal="${name}"] .dashboard-value`)?.textContent ?? ''
const body = (bridge: ViewerBridge, match: string): Record<string, unknown> =>
  JSON.parse(String(bridge.posts.find((post) => post.url.includes(match))?.init?.body ?? '{}'))
const key = (target: Element, name: string) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))

// An unrelated Inbox draft: the poll's editable gate refuses every frame while it
// stands, so only reloadAndPaint() (forceRender) can show a write's result.
async function holdTheGate(id: string): Promise<void> {
  await showInbox()
  click(row(id))
  await settle()
  type(answerInput(id), 'still typing elsewhere')
  click(document.querySelector('.tab[data-tab="dashboard"]'))
  await settle()
}

describe('the Needs you rail (#303)', () => {
  it('draws the top three asks, agent-waiting first, with one owner for the count', async () => {
    db = freshDb()
    const parked = question(db, 'Parked question')
    const task = blockedRow(db, 'Paddle account')
    const waiting = question(db, 'Live agent question', { session: 'live' })
    question(db, 'Fourth question')
    const snoozed = question(db, 'Snoozed question')
    upsertActivity(db, { ...AGENT, session: 'live', doing: 'Waiting on you', idle: false })
    await bootApp(db)
    await showInbox()
    click(row(snoozed))
    await settle()
    click(row(snoozed)!.querySelector('.disposition-menu > summary'))
    click(buttonLabelled('Tomorrow', row(snoozed)!))
    await settle()
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()

    expect(railIds()).toEqual([waiting, task, parked])
    expect(railCard(waiting)?.querySelector('.dash-rail-waiting')?.textContent).toBe('agent waiting')
    expect(railCard(parked)?.querySelector('.dash-rail-waiting')).toBeNull()
    expect(document.querySelector('.dash-rail-more')?.textContent).toBe('+1 more · 1 in Later')
    // The Needs you signal owns the number; the rail head and Review queue carry none.
    expect(signal('waiting')).toBe('4')
    expect(document.querySelector('#dashRailTitle')?.textContent).toBe('Needs you')
    expect(document.querySelector('.dash-rail-review')?.textContent).toBe('Open Review queue')
    for (const action of ['snooze', 'pin', 'open']) {
      const icon = railAction(parked, action)!
      expect(icon.title, action).not.toBe('')
      expect(icon.getAttribute('aria-label')).toBe(icon.title)
      expect(icon.textContent?.trim()).not.toBe('')
    }
    expect(railCard(task)?.querySelector('.handled-btn')?.textContent).toBe('I’ve done my part')
    expect(document.querySelector('.dashboard-ownership')).toBeNull()
  })

  it('keeps the badge, tabs, Needs you and the dock projection identical with the rail present', async () => {
    db = freshDb()
    question(db, 'First', { options: [{ label: 'Yes', recommended: true }, { label: 'No' }] })
    blockedRow(db, 'Approve', { action_owner: 'approval', options: [{ label: 'Approve', recommended: true }, { label: 'Hold' }] })
    question(db, 'Third')
    question(db, 'Fourth')
    await bootApp(db)
    const dock = await (await fetch('/api/items?scope=attention')).text()
    const onDashboard = { title: document.title, badge: badgeCount(), tabs: ['needsYou', 'notes', 'boards', 'done'].map(tabCount) }
    const rail = railIds()
    expect(rail).toHaveLength(3)
    expect(rail.length + Number(document.querySelector('.dash-rail-more')?.textContent?.match(/\+(\d+)/)?.[1] ?? 0))
      .toBe(onDashboard.badge)
    await showInbox()
    expect({ title: document.title, badge: badgeCount(), tabs: ['needsYou', 'notes', 'boards', 'done'].map(tabCount) })
      .toEqual(onDashboard)
    const inbox = rows().map((el) => el.dataset.cardId)
    expect(inbox).toHaveLength(onDashboard.badge)
    for (const id of rail) expect(inbox).toContain(id)
    expect(await (await fetch('/api/items?scope=attention')).text()).toBe(dock)
    expect(document.querySelector('#dashRail .reply-input')?.closest('[data-rail-card]')).not.toBeNull()
  })

  it('answers a question with one click and paints the result through reloadAndPaint()', async () => {
    db = freshDb()
    const drafted = question(db, 'Drafted elsewhere')
    const id = question(db, 'Ship it?', { options: [{ label: 'Hold' }, { label: 'Ship', recommended: true }] })
    const bridge = await bootApp(db)
    await holdTheGate(drafted)
    // ★ marks the recommended option and it comes first.
    const pills = [...railCard(id)!.querySelectorAll('.opt-pill')]
    expect(pills[0]?.querySelector('.rec-star')?.textContent).toBe('★')
    click(pill(id, 'Ship'))
    await settle()
    expect(getItem(db, id)?.reply).toBe('Ship')
    expect(railIds()).toEqual([drafted])
    expect(body(bridge, `/api/items/${id}/reply`)['text']).toBe('Ship')
  })

  it('marks a task done, snoozes and pins from the rail, each painting at once', async () => {
    db = freshDb()
    const drafted = question(db, 'Drafted elsewhere')
    const task = blockedRow(db, 'Paddle account')
    const snooze = question(db, 'Snooze me')
    const pin = question(db, 'Pin me')
    await bootApp(db)
    await holdTheGate(drafted)
    expect(railIds()).toEqual([task, drafted, snooze])

    click(railCard(task)!.querySelector('.handled-btn'))
    await settle()
    expect(listBoards(db)[0]!.rows[0]!.handled_at).toBeTruthy()
    expect(railIds()).toEqual([drafted, snooze, pin])

    click(railAction(snooze, 'snooze'))
    await settle()
    expect(getItem(db, snooze)?.snoozed_until).toBeTruthy()
    expect(railIds()).toEqual([drafted, pin])
    expect(document.querySelector('.dash-rail-more')?.textContent).toBe('1 in Later')

    click(railAction(pin, 'pin'))
    await settle()
    expect(getItem(db, pin)?.pinned_at).toBeTruthy()
    expect(railIds()).toEqual([drafted])
    expect(document.querySelector('.dash-rail-more')?.textContent).toBe('2 in Later')
  })

  it('pauses only the rail for a draft typed in it, while the rest of the Dashboard keeps refreshing', async () => {
    db = freshDb()
    const id = question(db, 'Which day?')
    await bootApp(db)
    click(railAction(id, 'expand'))
    expect(railCard(id)?.classList.contains('expanded')).toBe(true)
    expect(document.activeElement).toBe(railEditor(id))
    const editor = railEditor(id)!
    type(editor, 'Thursday, after the backup')
    question(db, 'New arrival')
    await pollTick()
    expect(railEditor(id)).toBe(editor)
    expect(editor.value).toBe('Thursday, after the backup')
    expect(document.activeElement).toBe(editor)
    expect(railIds()).toEqual([id])
    expect(signal('waiting')).toBe('2')
    expect(badgeCount()).toBe(2)
    expect(document.getElementById('pauseHint')?.textContent).toContain('paused')

    type(railEditor(id), '')
    await pollTick()
    expect(railIds()).toHaveLength(2)
  })

  it('sends a written answer from the rail with the same expect_answer as the Inbox editor', async () => {
    db = freshDb()
    const fromRail = question(db, 'Rail question')
    const fromInbox = question(db, 'Inbox question')
    const bridge = await bootApp(db)
    click(railAction(fromRail, 'expand'))
    type(railEditor(fromRail), 'From the rail')
    click(buttonLabelled('Send', railCard(fromRail)!))
    await settle()
    expect(getItem(db, fromRail)?.reply).toBe('From the rail')
    expect(railIds()).toEqual([fromInbox])

    await showInbox()
    click(row(fromInbox))
    await settle()
    type(answerInput(fromInbox), 'From the Inbox')
    click(sendButton(fromInbox))
    await settle()
    const rail = body(bridge, `/api/items/${fromRail}/reply`)
    const inbox = body(bridge, `/api/items/${fromInbox}/reply`)
    expect(rail['expect_answer']).toEqual({ replied_at: null, reply_source: null, reply_kind: null, reply: null })
    expect(rail['expect_answer']).toEqual(inbox['expect_answer'])
    expect(Object.keys(rail).sort()).toEqual(Object.keys(inbox).sort())
  })

  it('keeps a rail draft through the viewer-restart hold, durable storage and draft recovery', async () => {
    db = freshDb()
    const id = question(db, 'Release approval')
    let boot = 'original-viewer'
    await bootApp(db, {
      interceptFetch: async (_input, _init, next) => {
        const response = await next()
        response.headers.set('x-inbox-boot', boot)
        return response
      },
    })
    click(railAction(id, 'expand'))
    type(railEditor(id), 'Approve after the backup')
    await vi.advanceTimersByTimeAsync(300)
    const saved = JSON.parse(localStorage.getItem('agent-inbox-drafts-v1') ?? '{}') as { entries?: Record<string, { draft: { text?: string } }> }
    expect(Object.values(saved.entries ?? {}).map((entry) => entry.draft.text)).toContain('Approve after the backup')

    boot = 'restarted-viewer'
    question(db, 'Arrives after the restart')
    await pollTick()
    expect(reload).not.toHaveBeenCalled()
    expect(badgeCount()).toBe(2)
    expect(railEditor(id)?.value).toBe('Approve after the backup')

    // The agent closes the question: the next frame the human asks for moves the
    // draft to the unsent responses rather than dropping it.
    resolveItem(db, id, 'Approved in chat.')
    await pollTick()
    expect(railEditor(id)?.value).toBe('Approve after the backup')
    const range = document.querySelector<HTMLSelectElement>('.dashboard-range')!
    range.value = String(7 * 24 * 60 * 60 * 1000)
    range.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    expect(railCard(id)).toBeNull()
    expect(document.querySelector('#needsYouList .stale-drafts-fold')?.textContent).toContain('Approve after the backup')
    expect(reload).not.toHaveBeenCalled()
  })

  it('restores a focused rail control across a poll while the viewer owns focus', async () => {
    db = freshDb()
    const id = question(db, 'Keep my place')
    await bootApp(db)
    const snooze = railAction(id, 'snooze')!
    snooze.focus()
    await changedPollTick(db)
    question(db, 'Arrival')
    await pollTick()
    expect(railIds()).toHaveLength(2)
    expect(document.activeElement).toBe(railAction(id, 'snooze'))
  })

  it('keeps a background window\'s remembered focus and never pulls focus', async () => {
    db = freshDb()
    const id = question(db, 'Keep my place')
    await bootApp(db)
    const snooze = railAction(id, 'snooze')!
    snooze.focus()
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    question(db, 'Arrival while away')
    await pollTick()
    expect(focus).not.toHaveBeenCalled()
    expect(snooze.isConnected).toBe(true)
    expect(document.activeElement).toBe(snooze)
    expect(signal('waiting')).toBe('2')
    expect(badgeCount()).toBe(2)
  })

  it('holds the rail through a pointer press, then refreshes it', async () => {
    db = freshDb()
    const id = question(db, 'Press me', { options: [{ label: 'Yes' }, { label: 'No' }] })
    await bootApp(db)
    const pressed = pill(id, 'Yes')!
    await vi.advanceTimersByTimeAsync(2800)
    pressed.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    // Not question(): moving the clock would outlast the press guard's grace.
    insertItem(db, { ...AGENT, kind: 'question', title: 'Arrives during the press' })
    await vi.advanceTimersByTimeAsync(200)
    expect(pressed.isConnected).toBe(true)
    expect(railIds()).toEqual([id])
    expect(document.getElementById('pauseHint')?.textContent).toBe('')
    pressed.dispatchEvent(new Event('pointerup', { bubbles: true }))
    await pollTick()
    expect(railIds()).toHaveLength(2)
  })

  it('works from the keyboard: J/K move, 1–4 choose, S snoozes, P pins, Enter expands', async () => {
    db = freshDb()
    const first = question(db, 'First', { options: [{ label: 'Alpha' }, { label: 'Beta' }] })
    const second = question(db, 'Second')
    const third = question(db, 'Third')
    await bootApp(db)
    expect(railIds()).toEqual([first, second, third])
    railCard(first)!.focus()
    key(railCard(first)!, 'j')
    expect(document.activeElement).toBe(railCard(second))
    expect(railCard(second)?.tabIndex).toBe(0)
    key(railCard(second)!, 'k')
    expect(document.activeElement).toBe(railCard(first))

    key(railCard(first)!, 'Enter')
    expect(railCard(first)?.classList.contains('expanded')).toBe(true)
    expect(document.activeElement).toBe(railEditor(first))
    // While typing, the keys belong to the editor.
    expect(key(railEditor(first)!, '2')).toBe(true)
    expect(getItem(db, first)?.reply).toBeNull()

    railCard(first)!.focus()
    key(railCard(first)!, '2')
    await settle()
    expect(getItem(db, first)?.reply).toBe('Beta')

    key(railCard(second)!, 's')
    await settle()
    expect(getItem(db, second)?.snoozed_until).toBeTruthy()
    key(railCard(third)!, 'p')
    await settle()
    expect(getItem(db, third)?.pinned_at).toBeTruthy()
    expect(railIds()).toEqual([])
    expect(document.querySelector('#dashRail .dash-rail-empty')?.textContent).toBe('Nothing needs you now')
  })

  it('opens an ask in the Inbox, and its draft follows a deferral there', async () => {
    db = freshDb()
    const task = blockedRow(db, 'Paddle account')
    const id = question(db, 'Snooze with a draft')
    await bootApp(db)
    click(railAction(task, 'open'))
    await settle()
    expect(document.getElementById('needsYou')?.hidden).toBe(false)
    expect(row(task)?.getAttribute('aria-expanded')).toBe('true')

    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()
    click(railAction(id, 'expand'))
    type(railEditor(id), 'keep this')
    click(railAction(id, 'snooze'))
    await settle()
    expect(getItem(db, id)?.snoozed_until).toBeTruthy()
    expect(document.getElementById('needsYou')?.hidden).toBe(false)
    expect(answerInput(id)?.value).toBe('keep this')
  })
})
