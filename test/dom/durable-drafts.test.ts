// @vitest-environment jsdom
// Issue #279: unsent drafts survive a reload, a window close and an app restart.
// They are kept in this profile's localStorage and nowhere else. A draft whose
// target is unchanged comes back in its editor; one whose target changed goes
// to the unsent responses with an honest reason. Nothing is ever sent for the
// human. A boot in this file is a fresh page against the same localStorage,
// which is what a reload, a closed and reopened window and an app restart are.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import {
  advanceBoardRow, answerItem, archiveBoard, getBoard, getItem, insertItem, pinItem, replyItem, resolveItem,
  upsertBoard,
} from '../../src/store.js'
import type { BootOptions, ViewerBridge } from './harness.js'
import {
  advanceClock, answerInput, badgeCount, bootApp, buttonLabelled, click, expectConsoleError, freshDb, pollTick,
  row, sendButton, settle, showInbox, type, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(async () => {
  // Earlier boots stay registered for `pagehide` (the harness cannot remove a
  // listener), so every page in this file ends with its drafts already saved.
  await vi.advanceTimersByTimeAsync(300)
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

interface Stored { savedAt: number; draft: Record<string, unknown> }

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

  it('lets the later edit of the same draft win', async () => {
    db = freshDb()
    const id = question(db)
    await bootApp(db)
    seed({
      [`reply:${id}`]: {
        savedAt: Date.now() - 5000,
        draft: { type: 'reply', itemId: id, title: 'Release day?', text: 'Older, elsewhere.', context: '', responseRevision: 0, intent: null },
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

describe('a restored draft behaves like a typed one', () => {
  function restoredDrafts(d: Database.Database): { pinned: string; open: string } {
    const pinned = question(d, 'Pinned question')
    expect(pinItem(d, pinned, true)).toBe(true)
    const open = question(d, 'Open question')
    const draft = (itemId: string, text: string) => ({
      type: 'reply', itemId, title: 'Q', text, context: '', responseRevision: getItem(d, itemId)!.response_revision, intent: null,
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
        draft: { type: 'reply', itemId: id, title: 'Q', text: 'In place.', context: '', responseRevision: 0, intent: null },
      },
      [`reply:${gone}`]: {
        savedAt: Date.now(),
        draft: { type: 'reply', itemId: gone, title: 'Q', text: 'To recovery.', context: '', responseRevision: 0, intent: null },
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
