// @vitest-environment jsdom
// Issue #407: an unsent response held the Review queue back without a word,
// whatever it was for. Now the queue is held only for a response whose target
// the deck shows, the Inbox header says why, and its control takes the human
// to the response. A response for a closed, gone or since-changed target stays
// listed and the queue opens.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { advanceBoardRow, getBoard, insertItem, resolveItem, updateBoardRow, upsertBoard } from '../../src/store.js'
import {
  advanceClock, answerInput, bootApp, buttonLabelled, changedPollTick, click, freshDb, pollTick, settle, type, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const
const KEY = 'agent-inbox-drafts-v1'
const ACTION_CHANGED = 'Not sent because this action changed.'
const QUESTION_CHANGED = 'Not sent because this question changed.'
const QUESTION_CLOSED = 'Not sent because this question is closed or no longer available.'

function seed(entries: Record<string, Record<string, unknown>>): void {
  const now = Date.now()
  localStorage.setItem(KEY, JSON.stringify({
    v: 1,
    entries: Object.fromEntries(Object.entries(entries).map(([key, draft]) => [key, { savedAt: now - 1000, draft }])),
  }))
}

function plan(d: Database.Database) {
  upsertBoard(d, {
    ...AGENT,
    title: 'Launch plan',
    rows: [{
      label: 'Approve launch', status: 'blocked', note: 'Choose now.', next_step: 'Approve it.',
      action_owner: 'approval', impact: 'Ships.', options: [{ label: 'Approve', recommended: true }, { label: 'Hold' }],
    }],
  })
  return getBoard(d, 'alpha', 'Launch plan')!
}

// The row's agent moved it on to a new ask: the old answer is for an action
// the deck no longer shows.
function moveAction(d: Database.Database): void {
  const board = getBoard(d, 'alpha', 'Launch plan')!
  expect(advanceBoardRow(d, {
    project: 'alpha', title: 'Launch plan', label: 'Approve launch',
    expectedBoardVersion: board.revision, expectedRevision: board.rows[0]!.revision,
    note: 'Replacement action', next_step: 'Choose the replacement.', action_owner: 'approval', impact: 'Continues.',
    options: [{ label: 'Go', recommended: true }, { label: 'Wait' }],
  }).ok).toBe(true)
}

function rowRecovery(rowId: string, revision: number, actionVersion: number, text: string) {
  return {
    [`row-recovery:${rowId}:${revision}`]: {
      type: 'row-recovery', rowId, revision, actionVersion, text, kind: 'answer',
      boardTitle: 'Launch plan', label: 'Approve launch', context: '', setAside: false, reason: ACTION_CHANGED,
    },
  }
}

function itemRecovery(itemId: string, text: string, reason: string) {
  return {
    [`item-recovery:page:${itemId}`]: {
      type: 'item-recovery', itemId, title: 'Release day?', text, context: '', kind: 'answer', intent: null, reason,
    },
  }
}

// jsdom keeps every boot's document listeners in one file, so an earlier
// page would answer `t` too: only a file's first test presses it.
const lightbox = () => document.getElementById('lightbox')!
const fold = () => document.querySelector<HTMLDetailsElement>('.stale-drafts-fold')
const holdText = () => document.querySelector('.triage-hold-text')?.textContent ?? null

function pressT(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true, cancelable: true }))
}

async function closeDeck(): Promise<void> {
  click(lightbox().querySelector('.lb-close'))
  await settle()
}

describe('Review queue and unsent responses (#407)', () => {
  it('opens past a response for an action that has since changed, from every door, and keeps it listed', async () => {
    db = freshDb()
    const before = plan(db).rows[0]!
    moveAction(db)
    const after = getBoard(db, 'alpha', 'Launch plan')!.rows[0]!
    expect(after.action_version).not.toBe(before.action_version)
    seed(rowRecovery(before.id, before.revision, before.action_version, 'Approve the old ask.'))
    await bootApp(db)

    // the Dashboard's rail button
    click(document.querySelector('.dash-rail-review'))
    await settle()
    expect(lightbox().hidden).toBe(false)
    expect(lightbox().textContent).toContain('Approve launch')
    await closeDeck()

    // the Inbox toolbar's button
    click(document.querySelector('.tab[data-tab="needsYou"]'))
    await settle()
    expect(fold()?.textContent).toContain('Approve the old ask.')
    click(buttonLabelled('Review queue'))
    await settle()
    expect(lightbox().hidden).toBe(false)
    await closeDeck()

    // and `t`
    pressT()
    await settle()
    expect(lightbox().hidden).toBe(false)
    await closeDeck()

    expect(holdText()).toBe('')
    expect(fold()?.textContent).toContain('Approve the old ask.')
  })

  it('opens past a response for a closed question', async () => {
    db = freshDb()
    const closed = insertItem(db, { ...AGENT, kind: 'question', title: 'Release day?' })
    resolveItem(db, closed)
    advanceClock()
    insertItem(db, { ...AGENT, kind: 'question', title: 'Other ask' })
    seed(itemRecovery(closed, 'Friday.', QUESTION_CLOSED))
    await bootApp(db)

    click(document.querySelector('.dash-rail-review'))
    await settle()
    expect(lightbox().hidden).toBe(false)
    expect(lightbox().textContent).toContain('Other ask')
    await closeDeck()
    expect(fold()?.textContent).toContain('Friday.')
  })

  it('holds the queue for a response whose question is in the deck, says why, and shows it', async () => {
    db = freshDb()
    const id = insertItem(db, { ...AGENT, kind: 'question', title: 'Release day?' })
    seed(itemRecovery(id, 'Friday.', QUESTION_CHANGED))
    await bootApp(db)

    const railButton = document.querySelector<HTMLButtonElement>('.dash-rail-review')!
    railButton.focus()
    click(railButton)
    await settle()
    expect(lightbox().hidden).toBe(true)
    expect(document.querySelector('.tab[data-tab="needsYou"]')?.getAttribute('aria-selected')).toBe('true')
    expect(holdText()).toBe('Finish or clear the 1 unsent response first.')
    expect(document.querySelector('.triage-hold-text')?.getAttribute('role')).toBe('status')
    const show = buttonLabelled('Show it')!
    expect(document.activeElement).toBe(show)

    click(show)
    await settle()
    const line = fold()!.querySelector<HTMLElement>('.stale-draft-line')!
    expect(line.textContent).toContain('Friday.')
    expect(document.activeElement).toBe(line)

    // the Inbox button is held too
    click(buttonLabelled('Review queue'))
    await settle()
    expect(lightbox().hidden).toBe(true)
    expect(holdText()).toBe('Finish or clear the 1 unsent response first.')

    // Clear discards it, the hold line goes, and the queue opens
    click(buttonLabelled('Clear', fold()!))
    await settle()
    expect(fold()).toBeNull()
    expect(holdText()).toBe('')
    await vi.advanceTimersByTimeAsync(300) // the debounced save (#279)
    expect(localStorage.getItem(KEY) ?? '').not.toContain('Friday.')
    click(buttonLabelled('Review queue'))
    await settle()
    expect(lightbox().hidden).toBe(false)
  })

  it('holds the queue for a response to the row\'s current action, and shows it in its editor', async () => {
    db = freshDb()
    const r = plan(db).rows[0]!
    advanceClock()
    insertItem(db, { ...AGENT, kind: 'question', title: 'Other ask' })
    seed({
      ...rowRecovery(r.id, r.revision, r.action_version, 'Approve as written.'),
      ...rowRecovery('gone-row', 1, 1, 'For a removed row.'),
    })
    await bootApp(db)
    click(document.querySelector('.tab[data-tab="needsYou"]'))
    await settle()

    click(buttonLabelled('Review queue'))
    await settle()
    expect(lightbox().hidden).toBe(true)
    // only the row in the deck holds it; the removed row's response does not count
    expect(holdText()).toBe('Finish or clear the 1 unsent response first.')
    click(buttonLabelled('Show it'))
    await settle()
    expect(document.activeElement).toBe(answerInput(r.id))
    expect(answerInput(r.id)?.value).toBe('Approve as written.')
  })

  it('holds for a row recovery on the same action after an unrelated edit of the row', async () => {
    db = freshDb()
    const board = plan(db)
    const r = board.rows[0]!
    updateBoardRow(db, {
      ...AGENT, title: 'Launch plan', label: r.label,
      expectedBoardVersion: board.revision, expectedRevision: r.revision, note: 'Choose now, please.',
    })
    const edited = getBoard(db, 'alpha', 'Launch plan')!.rows[0]!
    expect(edited.revision).not.toBe(r.revision)
    expect(edited.action_version).toBe(r.action_version)
    // same action, older revision: the deck asks the very question it answers
    seed(rowRecovery(r.id, r.revision, r.action_version, 'Approve the same ask.'))
    await bootApp(db)

    click(document.querySelector('.dash-rail-review'))
    await settle()
    expect(lightbox().hidden).toBe(true)
    expect(holdText()).toBe('Finish or clear the 1 unsent response first.')
    click(buttonLabelled('Show it'))
    await settle()
    expect(document.activeElement?.closest('.stale-drafts-fold')).not.toBeNull()
    expect(document.activeElement?.textContent).toContain('Approve the same ask.')
  })

  it('holds for an unconfirmed Note on a question in the deck, but not on a closed one', async () => {
    db = freshDb()
    const open = insertItem(db, { ...AGENT, kind: 'question', title: 'Release day?' })
    advanceClock()
    const closed = insertItem(db, { ...AGENT, kind: 'question', title: 'Old ask' })
    resolveItem(db, closed)
    const note = (itemId: string, text: string) => ({
      [`note:${itemId}`]: { type: 'note', itemId, title: 'Release day?', text, error: 'Not saved.', pending: false },
    })
    seed({ ...note(open, 'Check the calendar.'), ...note(closed, 'Stale thought.') })
    await bootApp(db)
    click(document.querySelector('.tab[data-tab="needsYou"]'))
    await settle()
    expect(fold()?.querySelectorAll('.stale-draft-line')).toHaveLength(2)
    click(buttonLabelled('Review queue'))
    await settle()
    expect(lightbox().hidden).toBe(true)
    expect(holdText()).toBe('Finish or clear the 1 unsent response first.')
  })

  it('ends a stale hold line on a poll whose repaint a draft holds back', async () => {
    db = freshDb()
    const r = plan(db).rows[0]!
    seed(rowRecovery(r.id, r.revision, r.action_version, 'Approve as written.'))
    await bootApp(db)
    click(document.querySelector('.tab[data-tab="needsYou"]'))
    await settle()
    click(buttonLabelled('Review queue'))
    await settle()
    expect(holdText()).toBe('Finish or clear the 1 unsent response first.')
    click(buttonLabelled('Show it'))
    await settle()
    // typing turns the recovery into a live draft, which holds the list back
    type(answerInput(r.id), 'Approve as written, today.')
    await changedPollTick(db)
    expect(holdText()).toBe('')
    expect(answerInput(r.id)?.value).toBe('Approve as written, today.')
    click(buttonLabelled('Review queue'))
    await settle()
    expect(lightbox().hidden).toBe(false)
  })

  it('names two held responses, and keeps focus in the list as each is cleared', async () => {
    db = freshDb()
    const first = insertItem(db, { ...AGENT, kind: 'question', title: 'Release day?' })
    advanceClock()
    const second = insertItem(db, { ...AGENT, kind: 'question', title: 'Release time?' })
    seed({ ...itemRecovery(first, 'Friday.', QUESTION_CHANGED), ...itemRecovery(second, 'Noon.', QUESTION_CHANGED) })
    await bootApp(db)
    click(document.querySelector('.tab[data-tab="needsYou"]'))
    await settle()
    const toolbar = buttonLabelled('Review queue')!
    toolbar.focus()
    click(toolbar)
    await settle()
    expect(holdText()).toBe('Finish or clear the 2 unsent responses first.')
    expect(document.activeElement?.textContent).toBe('Show them')

    click(buttonLabelled('Show them'))
    await settle()
    const lines = () => [...fold()!.querySelectorAll<HTMLElement>('.stale-draft-line')]
    expect(document.activeElement).toBe(lines()[0])
    const firstClear = buttonLabelled('Clear', lines()[0]!)!
    firstClear.focus()
    click(firstClear)
    await settle()
    expect(lines()).toHaveLength(1)
    expect(document.activeElement).toBe(lines()[0])
    expect(holdText()).toBe('Finish or clear the 1 unsent response first.')
    const lastClear = buttonLabelled('Clear', lines()[0]!)!
    lastClear.focus()
    click(lastClear)
    await settle()
    expect(fold()).toBeNull()
    expect(document.activeElement).toBe(document.querySelector('.triage-btn'))
    expect(holdText()).toBe('')
  })

  it('moves focus off Show when a poll ends the hold', async () => {
    db = freshDb()
    const id = insertItem(db, { ...AGENT, kind: 'question', title: 'Release day?' })
    seed(itemRecovery(id, 'Friday.', QUESTION_CHANGED))
    await bootApp(db)
    click(document.querySelector('.tab[data-tab="needsYou"]'))
    await settle()
    const toolbar = buttonLabelled('Review queue')!
    toolbar.focus()
    click(toolbar)
    await settle()
    expect(document.activeElement?.textContent).toBe('Show it')
    // the question closes: the response stays listed but no longer holds the queue
    resolveItem(db, id)
    await pollTick()
    expect(holdText()).toBe('')
    expect(document.activeElement).toBe(fold()!.querySelector('summary'))
  })

  it('explains Retry and Clear in the unsent responses', async () => {
    db = freshDb()
    const id = insertItem(db, { ...AGENT, kind: 'question', title: 'Release day?' })
    seed({
      ...itemRecovery(id, 'Friday.', QUESTION_CHANGED),
      ...rowRecovery('gone-row', 1, 1, 'For a removed row.'),
    })
    await bootApp(db)
    click(document.querySelector('.tab[data-tab="needsYou"]'))
    await settle()
    expect(fold()?.querySelector('.stale-drafts-help')?.textContent)
      .toBe('Retry sends a response again; Clear discards it for good.')

    click(buttonLabelled('Clear', fold()!.querySelector<HTMLElement>(`.stale-draft-line[data-recovery-line*="${id}"]`)!))
    await settle()
    // a row response has no Retry, so only Clear is explained
    expect(fold()?.querySelector('.stale-drafts-help')?.textContent).toBe('Clear discards a response for good.')
  })
})
