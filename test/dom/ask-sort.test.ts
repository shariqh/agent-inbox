// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { advanceBoardRow, getBoard, insertItem, upsertBoard } from '../../src/store.js'
import {
  advanceClock, answerInput, bootApp, click, freshDb, pollTick, row, rowTitles, settle, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const
const HOUR = 60 * 60_000

function open(): Database.Database {
  db = freshDb()
  return db
}

function sortSelect(): HTMLSelectElement {
  const select = document.querySelector<HTMLSelectElement>('#needsYouList .queue-sort select')
  if (!select) throw new Error('sort select not rendered')
  return select
}

async function chooseSort(value: 'priority' | 'newest' | 'oldest'): Promise<void> {
  const select = sortSelect()
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
  await settle()
}

function askedTime(id: string): HTMLTimeElement {
  const time = row(id)?.querySelector<HTMLTimeElement>('.nrow-asked')
  if (!time) throw new Error(`ask time not rendered for ${id}`)
  return time
}

function seedMixedQueue(d: Database.Database): { oldId: string; rowId: string; newId: string } {
  const oldId = insertItem(d, { ...AGENT, kind: 'question', title: 'old question' })
  advanceClock(2 * HOUR)
  upsertBoard(d, {
    ...AGENT,
    title: 'Launch',
    rows: [{ label: 'middle approval', status: 'blocked', note: 'ready' }],
  })
  const rowId = getBoard(d, 'alpha', 'Launch')!.rows[0]!.id
  advanceClock(HOUR)
  const newId = insertItem(d, { ...AGENT, kind: 'question', title: 'new question' })
  return { oldId, rowId, newId }
}

describe('current ask time and queue sorting (#64)', () => {
  it('renders semantic compact age with an exact local timestamp for questions and blocked rows', async () => {
    const d = open()
    const { oldId, rowId } = seedMixedQueue(d)
    await bootApp(d)

    expect(askedTime(oldId).textContent).toBe('Asked 3h ago')
    expect(askedTime(rowId).textContent).toBe('Asked 1h ago')
    for (const time of [askedTime(oldId), askedTime(rowId)]) {
      expect(time.dateTime).toMatch(/^\d{4}-/)
      expect(time.tabIndex).toBe(0)
      expect(time.dataset.exact).toBeTruthy()
      expect(time.getAttribute('aria-label')).toContain(time.dataset.exact!)
      time.focus()
      expect(document.activeElement).toBe(time)
    }
  })

  it('uses a newly advanced action timestamp immediately instead of the row creation time', async () => {
    const d = open()
    upsertBoard(d, {
      ...AGENT,
      title: 'Launch',
      rows: [{ label: 'Approve', status: 'blocked', note: 'first ask' }],
    })
    const original = getBoard(d, 'alpha', 'Launch')!
    advanceClock(2 * HOUR)
    expect(advanceBoardRow(d, {
      project: 'alpha',
      title: 'Launch',
      label: 'Approve',
      expectedBoardVersion: original.revision,
      expectedRevision: original.rows[0]!.revision,
      note: 'second ask',
      next_step: 'Approve the second ask.',
      action_owner: 'approval',
      impact: 'Unblocks launch.',
      options: [{ label: 'Approve', recommended: true }, { label: 'Hold' }],
    }).ok).toBe(true)
    const current = getBoard(d, 'alpha', 'Launch')!.rows[0]!

    await bootApp(d)

    const time = askedTime(current.id)
    expect(time.textContent).toBe('Asked moments ago')
    expect(time.dateTime).toBe(new Date(current.action_started_at).toISOString())
    expect(time.dateTime).not.toBe(new Date(current.created_at).toISOString())
  })

  it('defaults to current priority, exposes native accessible choices, and switches deterministically', async () => {
    const d = open()
    seedMixedQueue(d)
    await bootApp(d)

    const select = sortSelect()
    expect(select.value).toBe('priority')
    expect(select.getAttribute('aria-label')).toBe('Sort queue')
    expect([...select.options].map((option) => option.textContent))
      .toEqual(['Current priority', 'Asked newest', 'Asked oldest'])
    expect(rowTitles()).toEqual(['middle approval', 'old question', 'new question'])

    await chooseSort('newest')
    expect(rowTitles()).toEqual(['new question', 'middle approval', 'old question'])
    await chooseSort('oldest')
    expect(rowTitles()).toEqual(['old question', 'middle approval', 'new question'])
  })

  it('resets to current priority on a fresh app load', async () => {
    const d = open()
    seedMixedQueue(d)
    await bootApp(d)

    expect(sortSelect().value).toBe('priority')
    expect(rowTitles()).toEqual(['middle approval', 'old question', 'new question'])
  })

  it('places new arrivals by the selected sort only after a held press safely resumes', async () => {
    const d = open()
    const { oldId } = seedMixedQueue(d)
    await bootApp(d)
    await chooseSort('newest')
    advanceClock(HOUR)
    await vi.advanceTimersByTimeAsync(2800)
    const pressed = row(oldId)!
    pressed.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }))
    insertItem(d, { ...AGENT, kind: 'question', title: 'newest arrival' })

    await vi.advanceTimersByTimeAsync(300)
    expect(rowTitles()).not.toContain('newest arrival')
    expect(document.contains(pressed)).toBe(true)

    pressed.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true }))
    await pollTick()
    expect(rowTitles()[0]).toBe('newest arrival')
  })

  it('holds a sorted arrival behind a draft and applies it when the existing gate resumes', async () => {
    const d = open()
    const { oldId } = seedMixedQueue(d)
    await bootApp(d)
    await chooseSort('newest')
    click(row(oldId))
    await settle()
    const input = answerInput(oldId)!
    input.value = 'half-written answer'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    advanceClock(HOUR)
    insertItem(d, { ...AGENT, kind: 'question', title: 'draft-gated arrival' })

    await pollTick()
    expect(rowTitles()).not.toContain('draft-gated arrival')
    expect(document.activeElement === input || document.contains(input)).toBe(true)

    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(0)
    expect(rowTitles()[0]).toBe('draft-gated arrival')
  })
})
