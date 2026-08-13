// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { getBoard, insertItem, updateBoardRow, upsertBoard } from '../../src/store.js'
import {
  advanceClock, answerInput, bootApp, buttonLabelled, click, freshDb, row, searchFor,
  sendButton, settle, type, useDomTest,
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

describe('draft recovery visibility from Review queue', () => {
  it('closes triage and focuses recovery after a removed-row CAS refusal', async () => {
    db = freshDb()
    upsertBoard(db, {
      ...AGENT,
      title: 'Removed approval',
      rows: [{ label: 'Approve launch', status: 'blocked', note: 'Choose now.' }],
    })
    const original = getBoard(db, 'alpha', 'Removed approval')!
    await bootApp(db)

    click(buttonLabelled('Review queue'))
    await settle()
    const lightbox = document.getElementById('lightbox')!
    type(lightbox.querySelector<HTMLInputElement>('.reply-input'), 'Preserve triage response')
    upsertBoard(db, {
      ...AGENT,
      title: 'Removed approval',
      expectedVersion: original.revision,
      rows: [],
    })
    click(buttonLabelled('Send', lightbox))
    await settle()

    const fold = document.querySelector<HTMLDetailsElement>('.stale-drafts-fold')!
    expect(lightbox.hidden).toBe(true)
    expect(document.getElementById('needsYou')?.hidden).toBe(false)
    expect(fold?.textContent).toContain('Preserve triage response')
    expect(document.activeElement).toBe(fold?.querySelector('summary'))
    expect(lightbox.querySelector('.lb-count')?.textContent).not.toBe('all clear')

    click(buttonLabelled('Review queue'))
    expect(lightbox.hidden).toBe(true)
    expect(document.activeElement).toBe(fold?.querySelector('summary'))
    click(buttonLabelled('Clear', fold))
    await settle()
    expect(document.querySelector('.stale-drafts-fold')).toBeNull()
  })

  it('focuses same-revision inline recovery after an unrelated board-version race', async () => {
    db = freshDb()
    upsertBoard(db, {
      ...AGENT,
      title: 'Removed earlier',
      rows: [{ label: 'Old removed action', status: 'blocked', note: 'This will disappear.' }],
    })
    upsertBoard(db, {
      ...AGENT,
      title: 'Shared launch',
      rows: [
        { label: 'Approve launch', status: 'blocked', note: 'Choose now.' },
        { label: 'Agent progress', status: 'tracked', note: 'Original progress.' },
      ],
    })
    const original = getBoard(db, 'alpha', 'Shared launch')!
    const target = original.rows[0]!
    const unrelated = original.rows[1]!
    const questionIds: string[] = []
    for (let i = 0; i < 11; i++) {
      advanceClock()
      questionIds.push(insertItem(db, {
        ...AGENT,
        kind: 'question',
        title: `Newer question ${i}`,
        detail: 'Push the target beyond the first page.',
      }))
    }
    insertItem(db, {
      project: 'beta',
      stream: 'main',
      agent: 'claude',
      kind: 'question',
      title: 'Beta lens',
    })
    await bootApp(db)

    const removed = getBoard(db, 'alpha', 'Removed earlier')!
    sortBy('oldest')
    await settle()
    click(row(removed.rows[0]!.id))
    await settle()
    type(answerInput(removed.rows[0]!.id), 'Unrelated removed recovery')
    upsertBoard(db, {
      ...AGENT,
      title: 'Removed earlier',
      expectedVersion: removed.revision,
      rows: [],
    })
    click(sendButton(removed.rows[0]!.id))
    await settle()
    expect(document.querySelector('.stale-drafts-fold')?.textContent).toContain('Unrelated removed recovery')

    click(row(questionIds[0]!))
    await settle()
    sortBy('newest')
    await settle()
    expect(row(target.id)).toBeNull()
    click(document.querySelector('#needsYouList .show-more'))
    await settle()
    expect(row(target.id)).not.toBeNull()
    click(row(target.id))
    await settle()
    const lightbox = document.getElementById('lightbox')!
    type(answerInput(target.id), 'Retry this exact action')
    updateBoardRow(db, {
      ...AGENT,
      title: 'Shared launch',
      label: unrelated.label,
      expectedBoardVersion: original.revision,
      expectedRevision: unrelated.revision,
      note: 'New progress only.',
    })
    expect(getBoard(db, 'alpha', 'Shared launch')!.revision).toBe(original.revision + 1)
    const staleSend = sendButton(target.id)!
    click(row(target.id))
    await searchFor('Beta lens')
    staleSend.click()
    await settle()

    const recovered = answerInput(target.id)
    expect(lightbox.hidden).toBe(true)
    expect(document.querySelector('.stale-drafts-fold')?.textContent).toContain('Unrelated removed recovery')
    expect(row(target.id)?.dataset.open).toBe('1')
    expect(recovered?.value).toBe('Retry this exact action')
    expect(document.activeElement).toBe(recovered)

    click(buttonLabelled('Review queue'))
    expect(lightbox.hidden).toBe(true)
    expect(document.activeElement).toBe(recovered)

    click(sendButton(target.id))
    await settle()
    expect(getBoard(db, 'alpha', 'Shared launch')!.rows[0]!.annotation).toBe('Retry this exact action')
    click(buttonLabelled('Review queue'))
    expect(lightbox.hidden).toBe(true)
    click(buttonLabelled('Clear', document.querySelector('.stale-drafts-fold')!))
    await settle()
    click(buttonLabelled('Review queue'))
    expect(lightbox.hidden).toBe(false)
  })
})
