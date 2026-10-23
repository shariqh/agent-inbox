// @vitest-environment jsdom
// Issue #279: unsent drafts survive a reload, a window close and an app restart.
// They are kept in this profile's localStorage and nowhere else. A draft whose
// target is unchanged comes back in its editor; one whose target changed goes
// to the unsent responses with an honest reason. Nothing is ever sent for the
// human. A boot in this file is a fresh page against the same localStorage,
// which is what a reload, a closed and reopened window and an app restart are.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import {
  advanceBoardRow, annotateItem, answerItem, archiveBoard, closeProject, getBoard, getItem, insertItem, markReplySeen,
  pinItem, replyItem, resolveItem, upsertBoard,
} from '../../src/store.js'
import type { BootOptions, ViewerBridge } from './harness.js'
import {
  advanceClock, answerInput, badgeCount, bootApp, buttonLabelled, click, expectConsoleError, freshDb, pollTick,
  row, sendButton, settle, showInbox, type, useDomTest,
} from './harness.js'

useDomTest()

// A page that goes away takes its listeners with it. jsdom keeps every boot's on
// one window, and an earlier page's leaving save would then write its drafts
// into a later test's storage, so this file removes a closed page's listeners.
const PAGE_EVENTS = new Set(['pagehide', 'beforeunload', 'visibilitychange'])
const pageListeners: Array<[EventTarget, string, EventListenerOrEventListenerObject]> = []
beforeEach(() => {
  for (const target of [window, document] as EventTarget[]) {
    const add = target.addEventListener.bind(target)
    vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
      if (PAGE_EVENTS.has(type) && listener) pageListeners.push([target, type, listener])
      add(type, listener, options)
    })
  }
})

function closePage(): void {
  for (const [target, type, listener] of pageListeners.splice(0)) target.removeEventListener(type, listener)
}

let db: Database.Database | null = null
afterEach(async () => {
  await vi.advanceTimersByTimeAsync(300)
  closePage()
  db?.close()
  db = null
})

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const
const KEY = 'agent-inbox-drafts-v1'
const DAY = 24 * 60 * 60 * 1000
const PAUSED = 'paused — updating when you\'re done'
const QUESTION_CHANGED = 'Not sent because this question changed.'
const QUESTION_CLOSED = 'Not sent because this question is closed or no longer available.'
const ACTION_CHANGED = 'Not sent because this action changed.'
const SET_ASIDE = 'Kept from before you set this aside.'
const UNCONFIRMED = 'Note save was not confirmed'
const PROJECT_CLOSED = 'Kept because this project is closed.'
const SEND_UNCONFIRMED_QUESTION = 'Your send was not confirmed, and this question has changed since.'
const SEND_UNCONFIRMED_ACTION = 'Your send was not confirmed, and this action has changed since.'

interface Stored { savedAt: number; draft: Record<string, unknown> }
// A stored question draft's pin for a question nobody has answered yet.
const UNANSWERED = { at: null, source: null, kind: null, text: null }

function stored(): Record<string, Stored> {
  const raw = localStorage.getItem(KEY)
  return raw ? (JSON.parse(raw) as { entries: Record<string, Stored> }).entries : {}
}

function storedTexts(): string[] {
  return Object.values(stored()).map((entry) => String(entry.draft['text']))
}

function seed(entries: Record<string, Stored>): void {
  localStorage.setItem(KEY, JSON.stringify({ v: 1, entries }))
}

// The debounced write lands within 300 ms of a change.
async function saved(): Promise<void> {
  await vi.advanceTimersByTimeAsync(300)
}

// A page that goes away: its unload handlers run, then none of it runs again.
// (vi.clearAllTimers() also rewinds the fake clock, so the time is kept.)
async function reopen(d: Database.Database, opts?: BootOptions): Promise<ViewerBridge> {
  window.dispatchEvent(new Event('pagehide'))
  closePage()
  const now = Date.now()
  vi.clearAllTimers()
  vi.setSystemTime(now)
  vi.resetModules()
  return bootApp(d, opts)
}

const recovery = () => document.querySelector<HTMLDetailsElement>('#needsYouList .stale-drafts-fold')
const contextInput = (id: string) => row(id)?.querySelector<HTMLTextAreaElement>('.nrow-card .reply-context-input') ?? null
const panelInput = (rowId: string) => document.querySelector<HTMLTextAreaElement>(
  `#boards [data-row-id="${rowId}"] + .row-panel-row .reply-input`,
)

function question(d: Database.Database, title = 'Release day?'): string {
  advanceClock()
  return insertItem(d, { ...AGENT, kind: 'question', title, options: [{ label: 'Tuesday' }, { label: 'Thursday' }] })
}

function plan(d: Database.Database, title = 'Launch plan') {
  upsertBoard(d, {
    ...AGENT,
    title,
    rows: [
      { label: 'Approve launch', status: 'blocked', note: 'Choose now.', next_step: 'Approve it.', action_owner: 'approval', impact: 'Ships.' },
      { label: 'Write notes', status: 'partial', note: 'Drafting.' },
    ],
  })
  return getBoard(d, 'alpha', title)!
}

function moveAction(d: Database.Database, title = 'Launch plan'): void {
  const board = getBoard(d, 'alpha', title)!
  expect(advanceBoardRow(d, {
    project: 'alpha',
    title,
    label: 'Approve launch',
    expectedBoardVersion: board.revision,
    expectedRevision: board.rows[0]!.revision,
    note: 'Replacement action',
    next_step: 'Choose the replacement.',
    action_owner: 'approval',
    impact: 'Continues.',
  }).ok).toBe(true)
}

// The first reply POST for this question commits, but its answer never arrives.
function loseFirstReply(id: string): BootOptions {
  let lose = true
  return {
    interceptFetch: async (input, init, next) => {
      const response = await next()
      if (lose && init?.method === 'POST' && String(input).includes(`/items/${id}/reply`)) {
        lose = false
        throw new Error('lost reply response')
      }
      return response
    },
  }
}

// The agent picks the inbox answer up, then records another from chat.
function agentAnswers(d: Database.Database, id: string, text: string): void {
  const item = getItem(d, id)!
  expect(markReplySeen(d, id, item.replied_at, item.response_revision)).toBe(true)
  expect(answerItem(d, id, text).ok).toBe(true)
}

const body = (post: { init?: RequestInit } | undefined) => JSON.parse(String(post?.init?.body)) as Record<string, unknown>

async function pickOption(id: string, label: string): Promise<void> {
  await showInbox()
  if (!row(id)?.querySelector('.nrow-card')) click(row(id))
  await settle()
  click(buttonLabelled(label, row(id)!))
  await settle()
}

async function draftAnswer(id: string, text: string, context = ''): Promise<void> {
  await showInbox()
  if (!row(id)?.querySelector('.nrow-card')) click(row(id))
  await settle()
  type(answerInput(id), text)
  if (context) type(contextInput(id), context)
}

describe('a draft comes back where it was', () => {
  it('puts a question answer and its context back in its editor after a reload, sending nothing', async () => {
    db = freshDb()
    const id = question(db)
    await bootApp(db)
    await draftAnswer(id, 'Ship on Tuesday.', 'Only if CI is green.')

    const bridge = await reopen(db)
    await pollTick()
    await pollTick()
    expect(bridge.posts).toHaveLength(0)
    expect(getItem(db, id)?.reply).toBeNull()
    await showInbox()
    expect(row(id)?.getAttribute('aria-expanded'), 'the restored draft reopens its card').toBe('true')
    expect(answerInput(id)?.value).toBe('Ship on Tuesday.')
    expect(contextInput(id)?.value).toBe('Only if CI is green.')
    expect(recovery()).toBeNull()
  })

  it('puts plan-row text back: a blocked row in its card, a row note in its Plans panel', async () => {
    db = freshDb()
    const board = plan(db)
    const [blocked, partial] = [board.rows[0]!, board.rows[1]!]
    await bootApp(db)
    await draftAnswer(blocked.id, 'Approved for Thursday.')
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    click(document.querySelector(`#boards tr.board-row[data-row-id="${partial.id}"] .row-expand`))
    await settle()
    type(panelInput(partial.id), 'Mention the migration.')

    const bridge = await reopen(db)
    await pollTick()
    expect(bridge.posts).toHaveLength(0)
    await showInbox()
    expect(answerInput(blocked.id)?.value).toBe('Approved for Thursday.')
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    expect(panelInput(partial.id)?.value).toBe('Mention the migration.')
    expect(recovery()).toBeNull()
  })

  it('reopens the Plans panel of a finished row whose note was unsent, with finished rows hidden', async () => {
    db = freshDb()
    upsertBoard(db, {
      ...AGENT,
      title: 'Shipped plan',
      rows: [{ label: 'Ship', status: 'done', note: 'Shipped.' }, { label: 'Next', status: 'partial', note: 'Going.' }],
    })
    const rowId = getBoard(db, 'alpha', 'Shipped plan')!.rows[0]!.id
    await bootApp(db)
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    click(document.querySelector('#boards .hidden-hint'))
    await settle()
    click(document.querySelector(`#boards tr.board-row[data-row-id="${rowId}"] .row-expand`))
    await settle()
    type(panelInput(rowId), 'A note on a finished step.')

    await reopen(db)
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    expect(panelInput(rowId)?.value).toBe('A note on a finished step.')
  })

  it('brings back a refused or unconfirmed Note attempt for review, never resending it', async () => {
    db = freshDb()
    const id = insertItem(db, { ...AGENT, kind: 'note', title: 'Agent update' })
    const first = await bootApp(db)
    click(document.querySelector('.tab[data-tab="notes"]'))
    await settle()
    click(document.querySelector(`#notes [data-card-id="${id}"] > summary`))
    await settle()
    vi.spyOn(window, 'prompt').mockReturnValue('Keep the rollback.')
    first.failPostsWith(500)
    expectConsoleError(/annotate failed: HTTP 500/)
    click(buttonLabelled('Note', document.querySelector(`#notes [data-card-id="${id}"]`)!))
    await settle()
    expect(recovery()?.textContent).toContain(UNCONFIRMED)

    const bridge = await reopen(db)
    await pollTick()
    expect(bridge.posts).toHaveLength(0)
    expect(recovery()?.textContent).toContain(UNCONFIRMED)
    expect(recovery()?.textContent).toContain('Keep the rollback.')
    expect(buttonLabelled('Retry', recovery()!)?.disabled).toBe(false)
    expect(getItem(db, id)?.annotation).toBeNull()
  })

  it('keeps a Note still saving at unload as unconfirmed, and drops one the server already holds', async () => {
    db = freshDb()
    const held = insertItem(db, { ...AGENT, kind: 'note', title: 'Held update' })
    advanceClock()
    const landed = insertItem(db, { ...AGENT, kind: 'note', title: 'Landed update' })
    await bootApp(db, {
      interceptFetch: async (input, init, next) => {
        if (init?.method === 'POST' && String(input).includes(`/items/${held}/annotate`)) return new Promise(() => {})
        if (init?.method === 'POST' && String(input).includes(`/items/${landed}/annotate`)) {
          await next()
          return new Promise(() => {})
        }
        return next()
      },
    })
    click(document.querySelector('.tab[data-tab="notes"]'))
    await settle()
    const prompt = vi.spyOn(window, 'prompt')
    for (const [id, text] of [[held, 'Held feedback.'], [landed, 'Landed feedback.']] as const) {
      click(document.querySelector(`#notes [data-card-id="${id}"] > summary`))
      await settle()
      prompt.mockReturnValue(text)
      click(buttonLabelled('Note', document.querySelector(`#notes [data-card-id="${id}"]`)!))
      await settle()
    }
    expect(getItem(db, landed)?.annotation).toBe('Landed feedback.')

    const bridge = await reopen(db)
    await pollTick()
    expect(bridge.posts).toHaveLength(0)
    expect(recovery()?.textContent).toContain(UNCONFIRMED)
    expect(recovery()?.textContent).toContain('Held feedback.')
    expect(recovery()?.textContent).not.toContain('Landed feedback.')
    await saved()
    expect(storedTexts()).toEqual(['Held feedback.'])
  })

  it('keeps the unsent responses list, and its Retry replays the exact intent from the closed window', async () => {
    db = freshDb()
    const id = question(db)
    const first = await bootApp(db)
    await showInbox()
    click(row(id))
    await settle()
    first.failPostsWith(500)
    expectConsoleError(/reply failed: HTTP 500/)
    click(buttonLabelled('Tuesday', row(id)!))
    await settle()
    const lost = JSON.parse(String(first.posts.at(-1)?.init?.body)) as Record<string, unknown>
    expect(recovery()?.textContent).toContain('answer: Tuesday')

    sessionStorage.clear() // a new window gets a new reply identity
    const bridge = await reopen(db)
    await pollTick()
    expect(bridge.posts).toHaveLength(0)
    click(buttonLabelled('Retry', recovery()!))
    await settle()
    expect(bridge.posts).toHaveLength(1)
    const retried = JSON.parse(String(bridge.posts[0]!.init?.body)) as Record<string, unknown>
    expect(retried).toMatchObject({
      text: 'Tuesday',
      intent_client_id: lost['intent_client_id'],
      intent_sequence: lost['intent_sequence'],
      intent_action_id: lost['intent_action_id'],
    })
    expect(getItem(db, id)?.reply).toBe('Tuesday')
    expect(recovery()).toBeNull()
    await saved()
    expect(stored()).toEqual({})
  })

  it('keeps a restored unsent response whose Retry is refused', async () => {
    db = freshDb()
    const id = question(db)
    const first = await bootApp(db)
    await showInbox()
    click(row(id))
    await settle()
    first.failPostsWith(500)
    expectConsoleError(/reply failed: HTTP 500/)
    click(buttonLabelled('Tuesday', row(id)!))
    await settle()
    resolveItem(db, id)

    const bridge = await reopen(db)
    await pollTick()
    click(buttonLabelled('Retry', recovery()!))
    await settle()
    expect(bridge.posts).toHaveLength(1)
    expect(getItem(db, id)?.reply).toBeNull()
    expect(recovery()?.textContent).toContain('answer: Tuesday')
    await saved()
    expect(storedTexts()).toEqual(['Tuesday'])
  })

  it('keeps a question draft in its editor after the human adds a Note to that question', async () => {
    db = freshDb()
    const id = question(db)
    await bootApp(db)
    await draftAnswer(id, 'Still my answer.')
    window.dispatchEvent(new Event('pagehide'))
    expect(annotateItem(db, id, 'My own note on it.')).toBe(true)

    await reopen(db)
    await showInbox()
    expect(answerInput(id)?.value).toBe('Still my answer.')
    expect(recovery()).toBeNull()
  })

  it('reuses an ambiguous send\'s intent when the restored draft is sent again', async () => {
    db = freshDb()
    const id = question(db)
    const first = await bootApp(db)
    await draftAnswer(id, 'Exact reply.')
    first.failPostsWith(500)
    expectConsoleError(/reply failed: HTTP 500/)
    click(sendButton(id))
    await settle()
    const lost = JSON.parse(String(first.posts.at(-1)?.init?.body)) as Record<string, unknown>
    expect(answerInput(id)?.value).toBe('Exact reply.')

    sessionStorage.clear()
    const bridge = await reopen(db)
    await showInbox()
    expect(answerInput(id)?.value).toBe('Exact reply.')
    click(sendButton(id))
    await settle()
    const sent = JSON.parse(String(bridge.posts[0]!.init?.body)) as Record<string, unknown>
    expect(sent['intent_client_id']).toBe(lost['intent_client_id'])
    expect(sent['intent_action_id']).toBe(lost['intent_action_id'])
    expect(getItem(db, id)?.reply).toBe('Exact reply.')
  })
})

describe('a draft whose target changed goes to the unsent responses', () => {
  it.each([
    ['answered in another window', (d: Database.Database, id: string) => {
      replyItem(d, id, 'Another answer', undefined, 'answer', { clientId: 'other-window', sequence: 1, actionId: 'other' })
    }, QUESTION_CHANGED],
    ['answered in chat', (d: Database.Database, id: string) => { answerItem(d, id, 'Chat answer') }, QUESTION_CHANGED],
    ['closed', (d: Database.Database, id: string) => { resolveItem(d, id) }, QUESTION_CLOSED],
  ] as const)('a question %s', async (_label, change, reason) => {
    db = freshDb()
    const id = question(db)
    await bootApp(db)
    await draftAnswer(id, 'My unsent answer.', 'My context.')
    window.dispatchEvent(new Event('pagehide'))
    change(db, id)

    const bridge = await reopen(db)
    await pollTick()
    expect(bridge.posts).toHaveLength(0)
    const fold = recovery()!
    expect(fold.textContent).toContain(reason)
    expect(fold.textContent).toContain('My unsent answer.')
    expect(fold.textContent).toContain('My context.')
    await showInbox()
    expect(answerInput(id)?.value ?? '').not.toContain('My unsent answer.')
    await saved()
    expect(Object.keys(stored()).filter((key) => key.startsWith('reply:'))).toEqual([])
    expect(storedTexts()).toEqual(['My unsent answer.'])
  })

  it.each([
    ['its action moved', (d: Database.Database) => moveAction(d)],
    ['its plan was archived', (d: Database.Database) => {
      const board = getBoard(d, 'alpha', 'Launch plan')!
      expect(archiveBoard(d, board.id, board.revision)).toBe(true)
    }],
    ['it was removed', (d: Database.Database) => {
      const board = getBoard(d, 'alpha', 'Launch plan')!
      upsertBoard(d, { ...AGENT, title: 'Launch plan', expectedVersion: board.revision, rows: [] })
    }],
  ] as const)('a plan row when %s', async (_label, change) => {
    db = freshDb()
    const board = plan(db)
    const rowId = board.rows[0]!.id
    await bootApp(db)
    await draftAnswer(rowId, 'Approve the original action.')
    window.dispatchEvent(new Event('pagehide'))
    change(db)

    const bridge = await reopen(db)
    await pollTick()
    expect(bridge.posts).toHaveLength(0)
    const fold = recovery()!
    expect(fold.textContent).toContain(ACTION_CHANGED)
    expect(fold.textContent).toContain('Approve the original action.')
    expect(fold.textContent).not.toContain(SET_ASIDE)
    await saved()
    expect(Object.keys(stored())).toEqual([`row-recovery:${rowId}:${board.rows[0]!.revision}`])
  })

  it.each([
    ['a typed answer', 'Ship Tuesday.', async (id: string) => {
      await draftAnswer(id, 'Ship Tuesday.')
      click(sendButton(id))
    }],
    ['an option pick', 'Tuesday', async (id: string) => {
      await showInbox()
      click(row(id))
      await settle()
      click(buttonLabelled('Tuesday', row(id)!))
    }],
  ] as const)('says %s whose send was not confirmed is not confirmed, and Retry sends it afresh', async (_label, text, send) => {
    db = freshDb()
    const id = question(db)
    const first = await bootApp(db, loseFirstReply(id))
    expectConsoleError(/lost reply response/)
    await send(id)
    await settle()
    const lost = body(first.posts.at(-1))
    expect(getItem(db, id)?.reply, 'the send committed; only its answer was lost').toBe(text)
    window.dispatchEvent(new Event('pagehide'))
    // While the app is closed the agent picks the answer up and records another in chat.
    agentAnswers(db, id, 'Chat answer')

    const bridge = await reopen(db)
    await pollTick()
    expect(bridge.posts).toHaveLength(0)
    const fold = recovery()!
    expect(fold.textContent).toContain(SEND_UNCONFIRMED_QUESTION)
    expect(fold.textContent).not.toContain('Not sent')
    click(buttonLabelled('Retry', fold))
    await settle()
    expect(body(bridge.posts[0])['intent_action_id']).not.toBe(lost['intent_action_id'])
    expect(getItem(db, id)).toMatchObject({ reply: text, reply_source: 'inbox' })
    expect(recovery()).toBeNull()
    await saved()
    expect(stored()).toEqual({})
  })

  it('says a plan-row send still in flight at unload was not confirmed once its action moved', async () => {
    db = freshDb()
    const board = plan(db)
    const rowId = board.rows[0]!.id
    await bootApp(db, {
      interceptFetch: async (input, init, next) => {
        if (init?.method === 'POST' && String(input).includes(`/rows/${rowId}/annotate`)) {
          await next()
          return new Promise(() => {})
        }
        return next()
      },
    })
    await draftAnswer(rowId, 'Approved for Thursday.')
    click(sendButton(rowId))
    await settle()
    expect(getBoard(db, 'alpha', 'Launch plan')!.rows[0]!.annotation).toBe('Approved for Thursday.')
    window.dispatchEvent(new Event('pagehide'))
    moveAction(db)

    await reopen(db)
    await pollTick()
    const fold = recovery()!
    expect(fold.textContent).toContain(SEND_UNCONFIRMED_ACTION)
    expect(fold.textContent).toContain('Approved for Thursday.')
    expect(fold.textContent).not.toContain(ACTION_CHANGED)
  })

  it('keeps #272\'s set-aside reason only where the human set the ask aside', async () => {
    db = freshDb()
    const board = plan(db)
    const rowId = board.rows[0]!.id
    await bootApp(db)
    await draftAnswer(rowId, 'Half an answer')
    click(buttonLabelled('Not now · 4h', row(rowId)!))
    await settle()

    const bridge = await reopen(db)
    await pollTick()
    expect(bridge.posts).toHaveLength(0)
    expect(recovery()?.textContent).toContain('answer: Half an answer')
    await showInbox()
    const later = document.querySelector<HTMLDetailsElement>('#needsYouList .later-section')!
    later.open = true
    click(row(rowId))
    await settle()
    const warnings = [...row(rowId)!.querySelectorAll('.stale-draft')].map((el) => el.textContent)
    expect(warnings).toEqual([`${SET_ASIDE} Preserved answer: Half an answer`])
  })
})

describe('the stored copy follows the draft', () => {
  it('is deleted when the send succeeds', async () => {
    db = freshDb()
    const id = question(db)
    await bootApp(db)
    await draftAnswer(id, 'Ship it.')
    await saved()
    expect(Object.keys(stored())).toEqual([`reply:${id}`])
    click(sendButton(id))
    await settle()
    expect(getItem(db, id)?.reply).toBe('Ship it.')
    await saved()
    expect(stored()).toEqual({})
  })

  it('is dropped at the next load when a send still in flight at unload had landed', async () => {
    db = freshDb()
    const id = question(db)
    const other = question(db, 'Still unsent')
    await bootApp(db, {
      interceptFetch: async (input, init, next) => {
        if (init?.method === 'POST' && String(input).includes(`/items/${id}/reply`)) {
          await next()
          return new Promise(() => {})
        }
        return next()
      },
    })
    await draftAnswer(other, 'Not sent yet.')
    await draftAnswer(id, 'Landed answer.')
    click(sendButton(id))
    await settle()
    expect(getItem(db, id)?.reply).toBe('Landed answer.')

    const bridge = await reopen(db)
    await pollTick()
    expect(bridge.posts).toHaveLength(0)
    expect(recovery()).toBeNull()
    await showInbox()
    expect(answerInput(other)?.value).toBe('Not sent yet.')
    await saved()
    expect(Object.keys(stored())).toEqual([`reply:${other}`])
  })

  it('is kept, as an unsent response, when the send is refused', async () => {
    db = freshDb()
    const id = question(db)
    await bootApp(db)
    await draftAnswer(id, 'Too late?')
    resolveItem(db, id)
    click(sendButton(id))
    await settle()
    await saved()
    expect(Object.keys(stored())).toEqual([expect.stringMatching(/^item-recovery:/)])
    expect(storedTexts()).toEqual(['Too late?'])

    await reopen(db)
    await pollTick()
    expect(recovery()?.textContent).toContain('Too late?')
  })

  it('is kept when a plan-row send is refused because its action moved', async () => {
    db = freshDb()
    const board = plan(db)
    const rowId = board.rows[0]!.id
    await bootApp(db)
    await draftAnswer(rowId, 'Approve it.')
    moveAction(db)
    click(sendButton(rowId))
    await settle()
    await saved()
    expect(Object.keys(stored())).toEqual([`row-recovery:${rowId}:${board.rows[0]!.revision}`])
  })

  it('is deleted when the human empties the editor or clears the unsent response', async () => {
    db = freshDb()
    const id = question(db)
    const other = question(db, 'Second question')
    await bootApp(db)
    await draftAnswer(id, 'Never mind.')
    await saved()
    expect(Object.keys(stored())).toEqual([`reply:${id}`])
    type(answerInput(id), '')
    await saved()
    expect(stored()).toEqual({})

    await draftAnswer(other, 'Too late again.')
    resolveItem(db, other)
    click(sendButton(other))
    await settle()
    await saved()
    expect(storedTexts()).toEqual(['Too late again.'])
    click(buttonLabelled('Clear', recovery()!))
    await settle()
    await saved()
    expect(stored()).toEqual({})
  })
})

describe('bounds', () => {
  it('drops a draft thirty days after it was last written', async () => {
    db = freshDb()
    const id = question(db)
    await bootApp(db)
    await draftAnswer(id, 'Old thought.')
    window.dispatchEvent(new Event('pagehide'))

    advanceClock(30 * DAY)
    await reopen(db)
    await showInbox()
    expect(answerInput(id)?.value).toBe('Old thought.')

    advanceClock(1)
    window.dispatchEvent(new Event('pagehide'))
    advanceClock(DAY)
    await reopen(db)
    await showInbox()
    expect(answerInput(id)).toBeNull()
    expect(recovery()).toBeNull()
    const other = question(db, 'Fresh question')
    await pollTick()
    await draftAnswer(other, 'Fresh thought.')
    await saved()
    expect(Object.keys(stored())).toEqual([`reply:${other}`])
  })

  it('lets drafts stamped in the future by a clock set back be edited, kept and deleted', async () => {
    db = freshDb()
    const id = question(db)
    const other = question(db, 'Second question')
    await bootApp(db)
    await draftAnswer(other, 'Other, before the clock moved.')
    await draftAnswer(id, 'Before the clock moved.')
    await saved()
    vi.setSystemTime(Date.now() - 60 * 60_000)

    await reopen(db)
    await draftAnswer(id, 'After the clock moved back.')
    await saved()
    expect(storedTexts().sort()).toEqual(['After the clock moved back.', 'Other, before the clock moved.'])
    for (const entry of Object.values(stored())) expect(entry.savedAt).toBeLessThanOrEqual(Date.now())
    // The other draft was never edited here; the write above re-stamped it, and
    // this window's delete of it still lands.
    await draftAnswer(other, 'Other, before the clock moved.')
    click(sendButton(other))
    await settle()
    expect(getItem(db, other)?.reply).toBe('Other, before the clock moved.')
    await saved()
    expect(storedTexts()).toEqual(['After the clock moved back.'])

    await reopen(db)
    await showInbox()
    expect(answerInput(id)?.value).toBe('After the clock moved back.')
    click(sendButton(id))
    await settle()
    expect(getItem(db, id)?.reply).toBe('After the clock moved back.')
    await saved()
    expect(stored()).toEqual({})
  })

  it('keeps at most 100 entries, evicting the oldest', async () => {
    db = freshDb()
    const entries: Record<string, Stored> = {}
    for (let index = 0; index < 100; index += 1) {
      entries[`row-recovery:gone-${index}:1`] = {
        savedAt: Date.now() - 1000 + index,
        draft: {
          type: 'row-recovery', rowId: `gone-${index}`, revision: 1, actionVersion: 1, text: `Old ${index}`,
          kind: 'answer', boardTitle: 'Gone', label: 'Gone', context: '', setAside: false, reason: '',
        },
      }
    }
    seed(entries)
    const id = question(db)
    await bootApp(db)
    await draftAnswer(id, 'Newest thought.')
    await saved()
    const keys = Object.keys(stored())
    expect(keys).toHaveLength(100)
    expect(keys).toContain(`reply:${id}`)
    expect(keys).not.toContain('row-recovery:gone-0:1')
    expect(keys).toContain('row-recovery:gone-1:1')
  })

  it('keeps working in memory when the browser refuses the write', async () => {
    db = freshDb()
    const id = question(db)
    await bootApp(db)
    const setItem = Storage.prototype.setItem
    const refuse = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === KEY) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      setItem.call(this, key, value)
    })
    await draftAnswer(id, 'Still here.')
    await saved()
    window.dispatchEvent(new Event('pagehide'))
    expect(refuse).toHaveBeenCalled()
    expect(answerInput(id)?.value).toBe('Still here.')
    expect(document.getElementById('status')?.textContent).toBe('')
    click(sendButton(id))
    await settle()
    expect(getItem(db, id)?.reply).toBe('Still here.')
  })
})

// One rule decides every reuse of a saved reply intent: an unsent response's
// Retry, an editor's Send after a lost answer, and every intent a restart
// brings back. Delivered when the server holds exactly that answer; a fresh
// send once the answer moved since the intent's send; the exact replay otherwise.
describe('a saved reply intent is reused by one rule', () => {
  it('sends an unsent response afresh in the same window once the agent answered in chat', async () => {
    db = freshDb()
    const id = question(db)
    const bridge = await bootApp(db, loseFirstReply(id))
    expectConsoleError(/lost reply response/)
    await pickOption(id, 'Tuesday')
    const lost = body(bridge.posts.at(-1))
    agentAnswers(db, id, 'Thursday')
    await pollTick()

    click(buttonLabelled('Retry', recovery()!))
    await settle()
    expect(body(bridge.posts.at(-1))['intent_action_id']).not.toBe(lost['intent_action_id'])
    expect(getItem(db, id)).toMatchObject({ reply: 'Tuesday', reply_source: 'inbox' })
    expect(recovery()).toBeNull()
  })

  it('sends a draft afresh from its editor once the agent answered in chat after a lost answer', async () => {
    db = freshDb()
    const id = question(db)
    const bridge = await bootApp(db, loseFirstReply(id))
    expectConsoleError(/lost reply response/)
    await draftAnswer(id, 'Ship Tuesday.')
    click(sendButton(id))
    await settle()
    const lost = body(bridge.posts.at(-1))
    agentAnswers(db, id, 'Chat answer')
    await pollTick()
    expect(answerInput(id)?.value, 'the paused editor still holds the draft').toBe('Ship Tuesday.')

    click(sendButton(id))
    await settle()
    expect(body(bridge.posts.at(-1))['intent_action_id']).not.toBe(lost['intent_action_id'])
    expect(getItem(db, id)).toMatchObject({ reply: 'Ship Tuesday.', reply_source: 'inbox' })
  })

  it('keeps a failed Retry on its own fresh intent, so a restart still sends the answer', async () => {
    db = freshDb()
    const id = question(db)
    const first = await bootApp(db, loseFirstReply(id))
    expectConsoleError(/lost reply response/)
    await pickOption(id, 'Tuesday')
    const lost = body(first.posts.at(-1))
    agentAnswers(db, id, 'Thursday')
    await pollTick()
    first.failPostsWith(500)
    expectConsoleError(/reply failed: HTTP 500/)
    click(buttonLabelled('Retry', recovery()!))
    await settle()
    expect(body(first.posts.at(-1))['intent_action_id'], 'the answer moved, so even this Retry is fresh')
      .not.toBe(lost['intent_action_id'])
    expect(recovery()?.textContent).toContain('answer: Tuesday')

    const bridge = await reopen(db)
    await pollTick()
    click(buttonLabelled('Retry', recovery()!))
    await settle()
    expect(body(bridge.posts[0])['intent_action_id']).not.toBe(lost['intent_action_id'])
    expect(getItem(db, id)).toMatchObject({ reply: 'Tuesday', reply_source: 'inbox' })
    expect(recovery()).toBeNull()
    await saved()
    expect(stored()).toEqual({})
  })

  it.each(['an unsent response\'s Retry', 'an editor\'s Send'] as const)(
    'retires %s without sending when the server already holds exactly that answer',
    async (path) => {
      db = freshDb()
      const id = question(db)
      const bridge = await bootApp(db, loseFirstReply(id))
      expectConsoleError(/lost reply response/)
      const text = path === 'an editor\'s Send' ? 'Ship Tuesday.' : 'Tuesday'
      if (path === 'an editor\'s Send') {
        await draftAnswer(id, text)
        click(sendButton(id))
        await settle()
      } else {
        await pickOption(id, text)
      }
      expect(getItem(db, id)?.reply, 'the lost send committed').toBe(text)
      await pollTick()
      const posts = bridge.posts.length

      click(path === 'an editor\'s Send' ? sendButton(id) : buttonLabelled('Retry', recovery()!))
      await settle()
      expect(bridge.posts, 'nothing is sent again').toHaveLength(posts)
      expect(recovery()).toBeNull()
      expect(answerInput(id)).toBeNull()
      await saved()
      expect(stored()).toEqual({})
    },
  )

  it('keeps an intent\'s pin when its replay is lost while the answer moves', async () => {
    db = freshDb()
    const id = question(db)
    let replies = 0
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    await bootApp(db, {
      interceptFetch: async (input, init, next) => {
        if (init?.method !== 'POST' || !String(input).includes(`/items/${id}/reply`)) return next()
        replies += 1
        // the pick never reaches the server; its Retry lands, but that answer is lost
        if (replies === 1) throw new Error('lost reply request')
        const response = await next()
        if (replies === 2) {
          await held
          throw new Error('lost reply response')
        }
        return response
      },
    })
    expectConsoleError(/lost reply (request|response)/)
    await pickOption(id, 'Tuesday')
    click(buttonLabelled('Retry', recovery()!))
    await vi.advanceTimersByTimeAsync(0)
    expect(getItem(db, id)?.reply, 'the exact replay landed').toBe('Tuesday')
    agentAnswers(db, id, 'Thursday')
    await pollTick()
    release()
    await settle()
    expect(recovery()?.textContent).toContain('answer: Tuesday')

    await reopen(db)
    await pollTick()
    expect(recovery()?.textContent, 'the pin is still the answer the intent was claimed against')
      .toContain(SEND_UNCONFIRMED_QUESTION)
    click(buttonLabelled('Retry', recovery()!))
    await settle()
    expect(getItem(db, id)).toMatchObject({ reply: 'Tuesday', reply_source: 'inbox' })
    expect(recovery()).toBeNull()
  })

  it('tells two answers written in the same millisecond apart by their text', async () => {
    db = freshDb()
    const id = question(db)
    expect(answerItem(db, id, 'Earlier').ok).toBe(true)
    const pinnedAt = getItem(db, id)!.replied_at!
    const bridge = await bootApp(db, loseFirstReply(id))
    expectConsoleError(/lost reply response/)
    await draftAnswer(id, 'Mine.')
    click(sendButton(id))
    await settle()
    const lost = body(bridge.posts.at(-1))
    // The agent's next chat answer lands in the millisecond of the one this send was made against.
    vi.setSystemTime(new Date(pinnedAt))
    agentAnswers(db, id, 'Later')
    expect(getItem(db, id)?.replied_at).toBe(pinnedAt)
    await pollTick()

    click(sendButton(id))
    await settle()
    expect(body(bridge.posts.at(-1))['intent_action_id']).not.toBe(lost['intent_action_id'])
    expect(getItem(db, id)).toMatchObject({ reply: 'Mine.', reply_source: 'inbox' })
  })

  it('keeps an entry whose fresh Retry was clicked twice and then refused', async () => {
    db = freshDb()
    const id = question(db)
    let replies = 0
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const bridge = await bootApp(db, {
      interceptFetch: async (input, init, next) => {
        if (init?.method !== 'POST' || !String(input).includes(`/items/${id}/reply`)) return next()
        replies += 1
        if (replies === 2) await held
        const response = await next()
        if (replies === 1) throw new Error('lost reply response')
        return response
      },
    })
    expectConsoleError(/lost reply response/)
    await pickOption(id, 'Tuesday')
    agentAnswers(db, id, 'Thursday')
    await pollTick()

    const retry = buttonLabelled('Retry', recovery()!)
    click(retry)
    click(retry)
    await vi.advanceTimersByTimeAsync(0)
    resolveItem(db, id)
    release()
    await settle()
    expect(bridge.posts, 'the second click sent nothing').toHaveLength(2)
    expect(recovery()?.textContent, 'the refused send keeps its text').toContain('answer: Tuesday')
    await saved()
    expect(storedTexts()).toEqual(['Tuesday'])
  })

  it('replays the exact intent while the answer is unchanged', async () => {
    db = freshDb()
    const id = question(db)
    const bridge = await bootApp(db)
    bridge.failPostsWith(500)
    expectConsoleError(/reply failed: HTTP 500/)
    await pickOption(id, 'Tuesday')
    const failed = body(bridge.posts.at(-1))
    bridge.failPostsWith(null)

    click(buttonLabelled('Retry', recovery()!))
    await settle()
    expect(body(bridge.posts.at(-1))).toMatchObject({
      intent_client_id: failed['intent_client_id'],
      intent_action_id: failed['intent_action_id'],
    })
    expect(getItem(db, id)?.reply).toBe('Tuesday')
    expect(recovery()).toBeNull()
  })
})

// Issue #322: the rule reads the last poll, so within one poll of another writer
// it can still replay a send the server already applied. The server answers that
// replay from its record without writing, and says so with the answer that
// stands: the human's text is kept whenever that answer is not theirs.
describe('a replay the server answered from its record (#322)', () => {
  const REPLACED = 'Your send went through, but this question\'s answer has changed since.'

  function answerInWindowB(d: Database.Database, id: string): void {
    expect(replyItem(d, id, 'Later Y', undefined, 'answer', { clientId: 'window-b', sequence: 1, actionId: 'b-1' }).ok).toBe(true)
  }

  // The first reply POST fails in this window, and its request reaches the
  // server only afterwards, when the test lands it.
  function lateFirstReply(id: string): { opts: BootOptions; land: () => Promise<void> } {
    let late: (() => Promise<Response>) | null = null
    return {
      opts: {
        interceptFetch: async (input, init, next) => {
          if (late === null && init?.method === 'POST' && String(input).includes(`/items/${id}/reply`)) {
            late = next
            throw new Error('lost reply request')
          }
          return next()
        },
      },
      land: async () => { await late?.() },
    }
  }

  // Only `ok`, as a server from before #322 answers.
  function olderServer(id: string): BootOptions {
    const lose = loseFirstReply(id).interceptFetch!
    return {
      interceptFetch: async (input, init, next) => {
        const response = await lose(input, init, next)
        if (init?.method !== 'POST' || !String(input).includes(`/items/${id}/reply`)) return response
        const { ok } = await response.json() as { ok: boolean }
        return new Response(JSON.stringify({ ok }), { headers: { 'content-type': 'application/json' } })
      },
    }
  }

  // A typed answer whose send landed though its answer was lost, sent again with
  // no poll since: the rule still sees the answer the send was made against, so
  // it replays the landed send's intent, and the server writes nothing.
  async function replayEditorSend(
    opts: (id: string) => BootOptions,
    change?: (d: Database.Database, id: string) => void,
  ): Promise<{ id: string; bridge: ViewerBridge }> {
    db = freshDb()
    const id = question(db)
    const bridge = await bootApp(db, opts(id))
    expectConsoleError(/lost reply response/)
    await draftAnswer(id, 'Ship Tuesday.')
    click(sendButton(id))
    await settle()
    const lost = body(bridge.posts.at(-1))
    expect(getItem(db, id)?.reply, 'the send landed; only its answer was lost').toBe('Ship Tuesday.')
    change?.(db, id)
    const before = getItem(db, id)
    click(sendButton(id))
    await settle()
    expect(body(bridge.posts.at(-1))['intent_action_id'], 'the exact replay').toBe(lost['intent_action_id'])
    expect(getItem(db, id), 'which wrote nothing').toEqual(before)
    return { id, bridge }
  }

  it.each([
    ['a reply from another window', answerInWindowB],
    ['a chat answer', (d: Database.Database, id: string) => agentAnswers(d, id, 'Thursday, said in chat')],
  ] as const)('keeps an editor\'s text as an unsent response when its replay finds %s', async (_label, change) => {
    const { id } = await replayEditorSend(loseFirstReply, change)
    const fold = recovery()!
    expect(fold.textContent).toContain(REPLACED)
    expect(fold.textContent).toContain('answer: Ship Tuesday.')
    expect(answerInput(id)?.value ?? '').not.toBe('Ship Tuesday.')
    expect(document.activeElement, 'focus follows the text out of the editor').toBe(fold.querySelector('summary'))
    await saved()
    expect(storedTexts()).toEqual(['Ship Tuesday.'])

    // the reason comes back with it, and nothing is sent for the human
    const bridge = await reopen(db!)
    await pollTick()
    expect(bridge.posts).toHaveLength(0)
    expect(recovery()?.textContent).toContain(REPLACED)
  })

  it('keeps an unsent response when its Retry replays a send that landed before a newer reply', async () => {
    db = freshDb()
    const id = question(db)
    const late = lateFirstReply(id)
    const bridge = await bootApp(db, late.opts)
    expectConsoleError(/lost reply request/)
    await pickOption(id, 'Tuesday')
    const lost = body(bridge.posts.at(-1))
    expect(recovery()?.textContent).toContain('answer: Tuesday')
    await late.land()
    expect(getItem(db, id)?.reply, 'the request reached the server after all').toBe('Tuesday')
    answerInWindowB(db, id)
    const before = getItem(db, id)

    click(buttonLabelled('Retry', recovery()!))
    await settle()
    expect(body(bridge.posts.at(-1))['intent_action_id'], 'the exact replay').toBe(lost['intent_action_id'])
    expect(getItem(db, id), 'which wrote nothing').toEqual(before)
    const fold = recovery()!
    expect(fold.textContent).toContain(REPLACED)
    expect(fold.textContent).toContain('answer: Tuesday')
    await saved()
    expect(storedTexts()).toEqual(['Tuesday'])
  })

  it('keeps the newer text of an editor typed in while the replay was in flight', async () => {
    db = freshDb()
    const id = question(db)
    let replies = 0
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    await bootApp(db, {
      interceptFetch: async (input, init, next) => {
        if (init?.method !== 'POST' || !String(input).includes(`/items/${id}/reply`)) return next()
        replies += 1
        const response = await (replies === 2 ? held.then(next) : next())
        if (replies === 1) throw new Error('lost reply response')
        return response
      },
    })
    expectConsoleError(/lost reply response/)
    await draftAnswer(id, 'Ship Tuesday.')
    click(sendButton(id))
    await settle()
    answerInWindowB(db, id)
    click(sendButton(id))
    await vi.advanceTimersByTimeAsync(0)
    type(answerInput(id), 'Ship Thursday instead.')
    release()
    await settle()
    expect(getItem(db, id)?.reply).toBe('Later Y')
    const fold = recovery()!
    expect(fold.textContent, 'the newer text is the human\'s').toContain('Ship Thursday instead.')
    expect(fold.textContent).not.toContain('Ship Tuesday.')
  })

  it('spends the replayed intent: the kept response\'s Retry is a fresh send', async () => {
    const { id, bridge } = await replayEditorSend(loseFirstReply, answerInWindowB)
    const replayed = body(bridge.posts.at(-1))
    click(buttonLabelled('Retry', recovery()!))
    await settle()
    expect(body(bridge.posts.at(-1))['intent_action_id']).not.toBe(replayed['intent_action_id'])
    expect(getItem(db!, id)).toMatchObject({ reply: 'Ship Tuesday.', reply_source: 'inbox' })
    expect(recovery()).toBeNull()
  })

  it.each(['an editor\'s Send', 'an unsent response\'s Retry'] as const)(
    'retires %s whose replay finds its own answer still standing',
    async (path) => {
      if (path === 'an editor\'s Send') {
        const { id } = await replayEditorSend(loseFirstReply)
        expect(getItem(db!, id)?.reply).toBe('Ship Tuesday.')
      } else {
        db = freshDb()
        const id = question(db)
        const late = lateFirstReply(id)
        const bridge = await bootApp(db, late.opts)
        expectConsoleError(/lost reply request/)
        await pickOption(id, 'Tuesday')
        const lost = body(bridge.posts.at(-1))
        await late.land()
        click(buttonLabelled('Retry', recovery()!))
        await settle()
        expect(bridge.posts, 'the Retry replayed the landed send').toHaveLength(2)
        expect(body(bridge.posts.at(-1))['intent_action_id']).toBe(lost['intent_action_id'])
        expect(getItem(db, id)?.reply).toBe('Tuesday')
      }
      expect(recovery()).toBeNull()
      await saved()
      expect(stored()).toEqual({})
    },
  )

  it('retires the text as before when an older server says only ok', async () => {
    await replayEditorSend(olderServer, answerInWindowB)
    expect(recovery()).toBeNull()
    await saved()
    expect(stored()).toEqual({})
  })
})

describe('two windows on one profile', () => {
  it('never deletes a copy another window wrote later, or an entry it never loaded', async () => {
    db = freshDb()
    const id = question(db)
    await bootApp(db)
    await draftAnswer(id, 'This window.')
    await saved()
    const mine = stored()[`reply:${id}`]!
    // Another window on the profile writes the same question later, and a Note.
    seed({
      [`reply:${id}`]: { savedAt: mine.savedAt + 1, draft: { ...mine.draft, text: 'The other window.' } },
      'note:elsewhere': {
        savedAt: mine.savedAt + 1,
        draft: { type: 'note', itemId: 'elsewhere', title: 'Elsewhere', text: 'Theirs.', error: 'Not saved.', pending: false },
      },
    })
    click(sendButton(id))
    await settle()
    expect(getItem(db, id)?.reply).toBe('This window.')
    await saved()
    expect(storedTexts().sort()).toEqual(['The other window.', 'Theirs.'])
  })

  it('writes its on-screen draft back as the page goes away when another window sent that draft', async () => {
    db = freshDb()
    const id = question(db)
    await bootApp(db)
    await draftAnswer(id, 'B: ship Thursday.')
    await saved()
    const mine = stored()[`reply:${id}`]!
    // Window A saves its own answer later, so it wins; then A sends it, which
    // deletes the stored copy, and the question is answered.
    seed({ [`reply:${id}`]: { savedAt: mine.savedAt + 1, draft: { ...mine.draft, text: 'A: ship Tuesday.' } } })
    seed({})
    replyItem(db, id, 'A: ship Tuesday.', undefined, 'answer', { clientId: 'window-a', sequence: 1, actionId: 'a-send' })
    await pollTick()
    expect(answerInput(id)?.value, 'this window still shows its draft').toBe('B: ship Thursday.')
    expect(stored(), 'routine saves leave the other window\'s delete alone').toEqual({})

    window.dispatchEvent(new Event('pagehide'))
    expect(storedTexts()).toEqual(['B: ship Thursday.'])
    await reopen(db)
    await pollTick()
    expect(recovery()?.textContent).toContain(QUESTION_CHANGED)
    expect(recovery()?.textContent).toContain('B: ship Thursday.')
  })

  it('lets the later edit of the same draft win', async () => {
    db = freshDb()
    const id = question(db)
    await bootApp(db)
    seed({
      [`reply:${id}`]: {
        savedAt: Date.now() - 5000,
        draft: { type: 'reply', itemId: id, title: 'Release day?', text: 'Older, elsewhere.', context: '', answer: UNANSWERED, intent: null },
      },
    })
    await draftAnswer(id, 'Newer, here.')
    await saved()
    expect(storedTexts()).toEqual(['Newer, here.'])
  })

  it('shows one unsent response when two windows each kept the same one', async () => {
    db = freshDb()
    const id = question(db)
    resolveItem(db, id)
    const kept = {
      type: 'item-recovery', itemId: id, title: 'Release day?', text: 'Same words.', context: '', kind: 'answer',
      intent: null, reason: QUESTION_CLOSED,
    }
    seed({
      'item-recovery:window-a:item': { savedAt: Date.now() - 2000, draft: kept },
      'item-recovery:window-b:item': { savedAt: Date.now() - 1000, draft: kept },
    })
    await bootApp(db)
    await pollTick()
    expect(recovery()?.querySelectorAll('.stale-draft-line')).toHaveLength(1)
    expect(storedTexts()).toEqual(['Same words.'])
  })
})

describe('a draft in a project the human closed', () => {
  it.each(['question', 'plan row'] as const)('keeps a %s draft as an unsent response that does not pause the list', async (kind) => {
    db = freshDb()
    const BETA = { ...AGENT, project: 'beta' }
    let id: string
    if (kind === 'question') {
      advanceClock()
      id = insertItem(db, { ...BETA, kind: 'question', title: 'Beta question' })
    } else {
      upsertBoard(db, {
        ...BETA,
        title: 'Beta plan',
        rows: [{ label: 'Approve beta', status: 'blocked', note: 'Choose.', next_step: 'Approve it.', action_owner: 'approval', impact: 'Ships.' }],
      })
      id = getBoard(db, 'beta', 'Beta plan')!.rows[0]!.id
    }
    await bootApp(db)
    await draftAnswer(id, 'Beta draft.')
    window.dispatchEvent(new Event('pagehide'))
    closeProject(db, 'beta')

    const bridge = await reopen(db)
    await pollTick()
    expect(bridge.posts).toHaveLength(0)
    expect(recovery()?.textContent).toContain(PROJECT_CLOSED)
    expect(recovery()?.textContent).toContain('Beta draft.')
    const arrival = question(db, 'Arrived after the relaunch')
    await pollTick()
    expect(row(arrival), 'the queue keeps updating').not.toBeNull()
    expect(document.getElementById('pauseHint')?.textContent).toBe('')
  })
})

describe('a restored draft behaves like a typed one', () => {
  function restoredDrafts(d: Database.Database): { pinned: string; open: string } {
    const pinned = question(d, 'Pinned question')
    expect(pinItem(d, pinned, true)).toBe(true)
    const open = question(d, 'Open question')
    const draft = (itemId: string, text: string) => ({
      type: 'reply', itemId, title: 'Q', text, context: '', answer: UNANSWERED, intent: null,
    })
    seed({
      [`reply:${pinned}`]: { savedAt: Date.now() - 2000, draft: draft(pinned, 'Pinned draft.') },
      [`reply:${open}`]: { savedAt: Date.now() - 1000, draft: draft(open, 'Open draft.') },
    })
    return { pinned, open }
  }

  it('pauses the editable rebuild, keeps ambient counts live and never sits in a closed fold', async () => {
    db = freshDb()
    const { pinned, open } = restoredDrafts(db)
    const bridge = await bootApp(db)
    await showInbox()
    expect(row(open)?.getAttribute('aria-expanded')).toBe('true')
    expect(answerInput(open)?.value).toBe('Open draft.')
    const later = document.querySelector<HTMLDetailsElement>('#needsYouList .later-section')!
    expect(later.open, 'the Later section holding a restored draft is open').toBe(true)
    expect(later.contains(row(pinned))).toBe(true)

    const badge = badgeCount()
    const arrival = question(db, 'Arrived while paused')
    await pollTick()
    expect(row(arrival), 'the editable list is paused').toBeNull()
    expect(document.getElementById('pauseHint')?.textContent).toBe(PAUSED)
    expect(badgeCount()).toBe(badge + 1)
    expect(bridge.posts).toHaveLength(0)
  })

  it.each([true, false])('moves no focus while restoring (window focused: %s)', async (focused) => {
    db = freshDb()
    const id = question(db)
    const gone = question(db, 'Closed meanwhile')
    seed({
      [`reply:${id}`]: {
        savedAt: Date.now(),
        draft: { type: 'reply', itemId: id, title: 'Q', text: 'In place.', context: '', answer: UNANSWERED, intent: null },
      },
      [`reply:${gone}`]: {
        savedAt: Date.now(),
        draft: { type: 'reply', itemId: gone, title: 'Q', text: 'To recovery.', context: '', answer: UNANSWERED, intent: null },
      },
    })
    resolveItem(db, gone)
    vi.spyOn(document, 'hasFocus').mockReturnValue(focused)
    const bridge = await bootApp(db, { holdFetch: true })
    const search = document.getElementById('search') as HTMLInputElement
    search.focus()
    bridge.releaseFetch()
    await settle()
    await pollTick()
    expect(recovery()?.textContent).toContain('To recovery.')
    expect(document.activeElement).toBe(search)
  })
})
