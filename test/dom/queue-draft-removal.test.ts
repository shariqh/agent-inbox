// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { getBoard, insertItem, resolveItem, upsertBoard } from '../../src/store.js'
import {
  advanceClock, answerInput, bootApp, buttonLabelled, click, expectConsoleError, freshDb,
  pollTick, row, rowTitles, searchFor, sendButton, settle, type, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const

function sortBy(value: 'newest' | 'oldest'): void {
  const select = document.querySelector<HTMLSelectElement>('#needsYouList .queue-sort select')!
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

function recoveryFold(): HTMLDetailsElement {
  const fold = document.querySelector<HTMLDetailsElement>('.stale-drafts-fold')
  if (!fold) throw new Error('draft recovery fold not rendered')
  return fold
}

describe('draft owner removal recovery', () => {
  it('keeps item and row editors through sorting, then surfaces refused drafts without freezing polls', async () => {
    db = freshDb()
    const itemId = insertItem(db, { ...AGENT, kind: 'question', title: 'Removed question' })
    advanceClock()
    upsertBoard(db, {
      ...AGENT,
      title: 'Removed plan',
      rows: [{ label: 'Removed row', status: 'blocked', note: 'Needs an answer' }],
    })
    const board = getBoard(db, 'alpha', 'Removed plan')!
    const rowId = board.rows[0]!.id
    expectConsoleError(/HTTP 500/)
    const bridge = await bootApp(db)

    click(row(itemId))
    await settle()
    type(answerInput(itemId), 'Preserve item answer')
    resolveItem(db, itemId)
    await pollTick()
    sortBy('newest')
    await settle()

    expect(answerInput(itemId)?.value).toBe('Preserve item answer')
    expect(document.getElementById('pauseHint')?.textContent).toContain('paused')
    bridge.failPostsWith(500)
    click(sendButton(itemId))
    await settle()

    expect(answerInput(itemId)?.value).toBe('Preserve item answer')
    expect(row(itemId)?.querySelector('.write-error')?.textContent).toContain('nothing was lost')
    bridge.failPostsWith(null)
    type(answerInput(itemId), '')
    await settle()
    expect(document.getElementById('pauseHint')?.textContent).toBe('')

    advanceClock()
    insertItem(db, { ...AGENT, kind: 'question', title: 'Arrival after item refusal' })
    await pollTick()
    expect(rowTitles()).toContain('Arrival after item refusal')

    advanceClock()
    const recoveredItem = insertItem(db, {
      ...AGENT,
      kind: 'question',
      title: 'Forced removed question',
    })
    await pollTick()
    click(row(recoveredItem))
    await settle()
    type(answerInput(recoveredItem), 'Recover item from forced render')
    resolveItem(db, recoveredItem)
    await pollTick()
    await searchFor('Forced removed question')

    expect(recoveryFold().open).toBe(true)
    expect(recoveryFold().textContent).toContain('Forced removed question')
    expect(recoveryFold().textContent).toContain('Recover item from forced render')
    expect(document.getElementById('pauseHint')?.textContent).toBe('')
    click(buttonLabelled('Clear', recoveryFold()))
    await settle()
    await searchFor('')

    click(row(rowId))
    await settle()
    type(answerInput(rowId), 'Preserve row answer')
    upsertBoard(db, {
      ...AGENT,
      title: 'Removed plan',
      expectedVersion: board.revision,
      rows: [],
    })
    await pollTick()
    sortBy('oldest')
    await settle()

    expect(answerInput(rowId)?.value).toBe('Preserve row answer')
    click(sendButton(rowId))
    await settle()
    expect(recoveryFold().open).toBe(true)
    expect(recoveryFold().textContent).toContain('Removed plan')
    expect(recoveryFold().textContent).toContain('Removed row')
    expect(recoveryFold().textContent).toContain('Preserve row answer')
    expect(document.getElementById('pauseHint')?.textContent).toBe('')

    advanceClock()
    insertItem(db, { ...AGENT, kind: 'question', title: 'Arrival after row refusal' })
    await pollTick()
    expect(rowTitles()).toContain('Arrival after row refusal')
    click(buttonLabelled('Clear', recoveryFold()))
    await settle()
    expect(document.querySelector('.stale-drafts-fold')).toBeNull()
  })
})
