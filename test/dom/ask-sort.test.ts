// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import {
  advanceBoardRow, getBoard, insertItem, recordActivityCall, resolveItem, upsertActivity, upsertBoard,
} from '../../src/store.js'
import {
  advanceClock, answerInput, bootApp, click, freshDb, pollTick, row, rowTitles, settle, setViewport, type, useDomTest,
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

  it('leaves native select keyboard handling in control of sorting', async () => {
    const d = open()
    seedMixedQueue(d)
    await bootApp(d)
    const select = sortSelect()
    select.focus()

    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', ' ', 'Escape']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      select.dispatchEvent(event)
      expect(event.defaultPrevented, `${key} was intercepted by a queue shortcut`).toBe(false)
      expect(document.activeElement, `${key} moved focus away from the native select`).toBe(select)
    }

    select.value = 'newest'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(document.activeElement).toBe(sortSelect())
  })

  it('preserves the active sort control and compact header scroll after a safe polling render', async () => {
    const d = open()
    seedMixedQueue(d)
    setViewport('narrow')
    await bootApp(d)
    const before = sortSelect()
    const header = before.closest('.tab-header') as HTMLElement
    header.scrollLeft = 73
    before.focus()
    expect(document.activeElement).toBe(before)

    await pollTick()

    const after = sortSelect()
    expect(after).toBe(before)
    expect(document.contains(before)).toBe(true)
    expect(document.activeElement).toBe(after)
    expect(after.value).toBe('priority')
    expect(header.scrollLeft).toBe(73)
  })

  it('restores focused exact-time detail after a safe polling render', async () => {
    const d = open()
    const { oldId } = seedMixedQueue(d)
    await bootApp(d)
    const before = askedTime(oldId)
    before.focus()
    expect(document.activeElement).toBe(before)

    await pollTick()

    const after = askedTime(oldId)
    expect(after).not.toBe(before)
    expect(document.contains(before)).toBe(false)
    expect(document.activeElement).toBe(after)
    expect(after.dataset.exact).toBe(before.dataset.exact)
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

  it('keeps a shown draft mounted until sorting and arrivals can safely resume', async () => {
    const d = open()
    const ids: string[] = []
    for (let index = 0; index < 12; index += 1) {
      ids.push(insertItem(d, {
        ...AGENT,
        kind: 'question',
        title: `Question ${String(index + 1).padStart(2, '0')}`,
        detail: `Question ${index + 1}.`,
      }))
      advanceClock(60_000)
    }

    await bootApp(d)

    const showMore = Array.from(document.querySelectorAll<HTMLButtonElement>('#needsYouList .show-more'))
      .find((button) => button.textContent?.startsWith('Show 2 more'))
    expect(showMore).toBeTruthy()
    click(showMore!)
    await settle()

    click(row(ids[0]!))
    await settle()
    const input = answerInput(ids[0]!)!
    input.value = 'Keep this draft visible'
    input.dispatchEvent(new Event('input', { bubbles: true }))

    const select = sortSelect()
    select.value = 'newest'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()

    expect(row(ids[0]!)).toBeTruthy()
    expect(row(ids[0]!)!.dataset.open).toBe('1')
    expect(answerInput(ids[0]!)?.value).toBe('Keep this draft visible')
    expect(document.querySelectorAll('#needsYouList .nrow')).toHaveLength(12)

    insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Newest arrival',
      detail: 'Arrived after sorting.',
    })
    await pollTick()
    expect(rowTitles()).not.toContain('Newest arrival')
    type(answerInput(ids[0]!), '')
    await settle()

    expect(rowTitles()).toContain('Newest arrival')
    expect(row(ids[0]!)).toBeTruthy()
    expect(row(ids[0]!)!.dataset.open).toBe('1')
    expect(answerInput(ids[0]!)?.value).toBe('')
    expect(document.querySelectorAll('#needsYouList .nrow')).toHaveLength(13)
  })

  it('does not let stale draft autofocus override sort focus during a rebuild', async () => {
    const d = open()
    const id = insertItem(d, {
      ...AGENT,
      kind: 'question',
      title: 'Draft focus owner',
      detail: 'Only the pre-render focus owner may reclaim focus.',
    })

    await bootApp(d)
    click(row(id))
    await settle()
    const input = answerInput(id)!
    input.focus()
    input.value = 'Unfinished'
    input.dispatchEvent(new Event('input', { bubbles: true }))

    const select = sortSelect()
    select.focus()
    select.value = 'newest'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()

    expect(document.activeElement).toBe(select)
    expect(answerInput(id)?.value).toBe('Unfinished')
  })

  it('keeps a selected last-page row rendered after a newest arrival and reseeds a removed selection', async () => {
    const d = open()
    const ids: string[] = []
    for (let index = 0; index < 10; index += 1) {
      ids.push(insertItem(d, {
        ...AGENT,
        kind: 'question',
        title: `Selection ${String(index + 1).padStart(2, '0')}`,
      }))
      advanceClock(60_000)
    }
    await bootApp(d)
    await chooseSort('newest')

    click(row(ids[0]!))
    await settle()
    click(row(ids[0]!))
    await settle()
    const selected = document.querySelector<HTMLElement>('#needsYouList .nrow.selected')!
    const selectedId = selected.dataset.cardId!
    expect(selectedId).toBe(ids[0])
    document.getElementById('search')!.focus()

    insertItem(d, { ...AGENT, kind: 'question', title: 'Newest selection arrival' })
    await pollTick()

    expect(rowTitles()).toContain('Selection 01')
    expect(row(selectedId)).toBeTruthy()
    expect(document.querySelectorAll('#needsYouList .nrow')).toHaveLength(11)
    expect(row(selectedId)?.tabIndex).toBe(0)

    resolveItem(d, selectedId)
    await pollTick()

    expect(row(selectedId)).toBeNull()
    const tabbable = [...document.querySelectorAll<HTMLElement>('#needsYouList .nrow')]
      .filter((entry) => entry.tabIndex === 0)
    expect(tabbable).toHaveLength(1)
    expect(tabbable[0]?.classList.contains('selected')).toBe(true)
  })

  it('gives a focused sort select ownership of settings and pinned Live Escape shortcuts', async () => {
    const d = open()
    seedMixedQueue(d)
    upsertActivity(d, {
      session: 'active',
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      doing: 'Reviewing queue',
    })
    recordActivityCall(d, 'active')
    await bootApp(d)

    const strip = document.getElementById('liveStrip') as HTMLButtonElement
    click(strip)
    click(document.getElementById('livePin'))
    const drawer = document.getElementById('liveDrawer') as HTMLElement
    expect(drawer.hidden).toBe(false)

    const select = sortSelect()
    select.focus()
    const settings = new KeyboardEvent('keydown', {
      key: ',',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })
    select.dispatchEvent(settings)
    expect(settings.defaultPrevented).toBe(false)
    expect(document.getElementById('setup')?.hidden).toBe(true)

    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    select.dispatchEvent(escape)
    expect(escape.defaultPrevented).toBe(false)
    expect(drawer.hidden).toBe(false)
    expect(document.activeElement).toBe(select)
  })
})
