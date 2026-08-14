// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { archiveBoard, getBoard, insertItem, upsertBoard } from '../../src/store.js'
import {
  advanceClock, bootApp, buttonLabelled, click, freshDb, navigateToHash, pollTick,
  settle, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const ALPHA = { project: 'alpha', stream: 'main', agent: 'copilot' } as const

function addBoard(title: string, archived = false): string {
  upsertBoard(db!, { ...ALPHA, title, rows: [{ label: 'Track', status: 'tracked' }] })
  const board = getBoard(db!, 'alpha', title)!
  if (archived) expect(archiveBoard(db!, board.id, board.revision)).toBe(true)
  return board.id
}

async function excludeAlpha(): Promise<void> {
  click(document.querySelector('#rail button[data-project="beta"]'))
  await settle()
}

function card(id: string): HTMLDetailsElement | null {
  return document.querySelector<HTMLDetailsElement>(`[data-card-id="${id}"]`)
}

function expectFocusedSummary(id: string): void {
  const target = card(id)
  expect(target).not.toBeNull()
  expect(target?.open).toBe(true)
  expect(document.activeElement).toBe(target?.querySelector(':scope > summary'))
}

describe('deep links across paginated tabs', () => {
  it('marks the deep-linked note and normal page read without marking the skipped prefix', async () => {
    db = freshDb()
    const targetId = insertItem(db, { ...ALPHA, kind: 'note', title: 'Deep note target' })
    advanceClock()
    const skippedId = insertItem(db, { ...ALPHA, kind: 'note', title: 'Skipped newer note' })
    const normalPageIds: string[] = []
    for (let i = 0; i < 5; i++) {
      advanceClock()
      normalPageIds.push(insertItem(db, { ...ALPHA, kind: 'note', title: `Normal page ${i}` }))
    }
    await bootApp(db)

    navigateToHash(`#item/${targetId}`)
    await settle()

    const seenIds = JSON.parse(localStorage.getItem('agent-inbox-notes-seen-ids') ?? '[]') as string[]
    expect(seenIds).toEqual(expect.arrayContaining([...normalPageIds, targetId]))
    expect(seenIds).not.toContain(skippedId)
  })

  it('includes and focuses Notes, History, active Plans, and archived Plans beyond their caps', async () => {
    db = freshDb()
    const noteId = insertItem(db, { ...ALPHA, kind: 'note', title: 'Old note target' })
    for (let i = 0; i < 6; i++) {
      advanceClock()
      insertItem(db, { ...ALPHA, kind: 'note', title: `Newer note ${i}` })
    }
    advanceClock()
    const doneId = insertItem(db, { ...ALPHA, kind: 'done', title: 'Old history target' })
    for (let i = 0; i < 6; i++) {
      advanceClock()
      insertItem(db, { ...ALPHA, kind: 'done', title: `Newer history ${i}` })
    }
    advanceClock()
    const activeBoardId = addBoard('Old active target')
    for (let i = 0; i < 6; i++) {
      advanceClock()
      addBoard(`Newer active ${i}`)
    }
    advanceClock()
    const archivedBoardId = addBoard('Old archived target', true)
    for (let i = 0; i < 6; i++) {
      advanceClock()
      addBoard(`Newer archived ${i}`, true)
    }
    advanceClock()
    insertItem(db, {
      project: 'beta',
      stream: 'main',
      agent: 'claude',
      kind: 'question',
      title: 'Beta lens',
    })
    await bootApp(db)

    await excludeAlpha()
    navigateToHash(`#item/${noteId}`)
    await settle()
    expect(document.getElementById('notes')?.hidden).toBe(false)
    expectFocusedSummary(noteId)

    await excludeAlpha()
    navigateToHash(`#item/${doneId}`)
    await settle()
    expect(document.getElementById('done')?.hidden).toBe(false)
    expectFocusedSummary(doneId)

    await excludeAlpha()
    navigateToHash(`#item/${activeBoardId}`)
    await settle()
    expect(document.getElementById('boards')?.hidden).toBe(false)
    expectFocusedSummary(activeBoardId)

    await excludeAlpha()
    navigateToHash(`#item/${archivedBoardId}`)
    await settle()
    expect(document.getElementById('boards')?.hidden).toBe(false)
    expect(card(archivedBoardId)?.closest<HTMLDetailsElement>('.archived-fold')?.open).toBe(true)
    expectFocusedSummary(archivedBoardId)
  })

  it('restores focused non-Inbox targets across polls without stealing focus after the user moves', async () => {
    db = freshDb()
    const noteId = insertItem(db, {
      ...ALPHA,
      kind: 'note',
      title: 'Note focus target',
      context: 'Nested background',
    })
    for (let i = 0; i < 6; i++) {
      advanceClock()
      insertItem(db, { ...ALPHA, kind: 'note', title: `Newer focus note ${i}` })
    }
    advanceClock()
    const doneId = insertItem(db, { ...ALPHA, kind: 'done', title: 'History focus target' })
    advanceClock()
    const activeBoardId = addBoard('Active focus target')
    advanceClock()
    const archivedBoardId = addBoard('Archived focus target', true)
    await bootApp(db)

    for (const id of [noteId, doneId, activeBoardId, archivedBoardId]) {
      navigateToHash(`#item/${id}`)
      await settle()
      const before = document.activeElement
      expectFocusedSummary(id)

      await pollTick()

      expect(before?.isConnected).toBe(false)
      expectFocusedSummary(id)
    }

    navigateToHash(`#item/${noteId}`)
    await settle()
    const background = card(noteId)?.querySelector<HTMLElement>('.card-context > summary')!
    background.focus()
    await pollTick()
    expect(document.activeElement).toBe(card(noteId)?.querySelector('.card-context > summary'))

    const resolve = [...card(noteId)!.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Resolve')!
    resolve.focus()
    await pollTick()
    expect(document.activeElement).toBe(
      [...card(noteId)!.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Resolve'),
    )

    const search = document.getElementById('search')!
    search.focus()
    await pollTick()
    expect(document.activeElement).toBe(search)
  })

  it('keeps identical Plan controls bound to their stable row when rows reorder', async () => {
    db = freshDb()
    upsertBoard(db, {
      ...ALPHA,
      title: 'Reordered controls',
      rows: [
        { label: 'First approval', status: 'blocked', note: 'Choose.' },
        { label: 'Second approval', status: 'blocked', note: 'Choose.' },
      ],
    })
    const original = getBoard(db, 'alpha', 'Reordered controls')!
    const first = original.rows[0]!
    const second = original.rows[1]!
    await bootApp(db)
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()

    const openRowPanel = async (id: string): Promise<void> => {
      const rowEl = document.querySelector(`.board-row[data-row-id="${id}"]`)!
      click(buttonLabelled('Answer', rowEl))
      await settle()
    }
    await openRowPanel(first.id)
    await openRowPanel(second.id)

    let secondRow = document.querySelector(`.board-row[data-row-id="${second.id}"]`)!
    const secondPanel = secondRow.nextElementSibling!
    const secondSend = buttonLabelled('Send', secondPanel)!
    secondSend.focus()
    expect(document.activeElement).toBe(secondSend)

    upsertBoard(db, {
      ...ALPHA,
      title: 'Reordered controls',
      expectedVersion: original.revision,
      rows: [
        { label: second.label, revision: second.revision, status: second.status, note: second.note },
        { label: first.label, revision: first.revision, status: first.status, note: first.note },
      ],
    })
    await pollTick()

    secondRow = document.querySelector(`.board-row[data-row-id="${second.id}"]`)!
    expect(document.activeElement).toBe(buttonLabelled('Send', secondRow.nextElementSibling!))
  })

  it('reveals and persists a newly archived paged Plan before restoring its focused control', async () => {
    db = freshDb()
    const targetId = addBoard('Old active focus target')
    for (let i = 0; i < 6; i++) {
      advanceClock()
      addBoard(`Newer active ${i}`)
    }
    for (let i = 0; i < 6; i++) {
      advanceClock()
      addBoard(`Newer archived ${i}`, true)
    }
    await bootApp(db)
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    click(document.querySelector('#boards .show-more'))
    await settle()

    const target = card(targetId)!
    const planFlow = buttonLabelled('Plan flow', target)!
    planFlow.focus()
    const current = getBoard(db, 'alpha', 'Old active focus target')!
    expect(archiveBoard(db, current.id, current.revision)).toBe(true)
    await pollTick()

    let archivedTarget = card(targetId)!
    let fold = archivedTarget.closest<HTMLDetailsElement>('.archived-fold')!
    expect(fold.open).toBe(true)
    expect(document.activeElement).toBe(buttonLabelled('Plan flow', archivedTarget))

    await pollTick()

    archivedTarget = card(targetId)!
    fold = archivedTarget.closest<HTMLDetailsElement>('.archived-fold')!
    expect(fold.open).toBe(true)
    expect(document.activeElement).toBe(buttonLabelled('Plan flow', archivedTarget))
  })
})
