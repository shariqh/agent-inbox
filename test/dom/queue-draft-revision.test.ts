// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { advanceBoardRow, getBoard, upsertBoard } from '../../src/store.js'
import {
  answerInput, bootApp, buttonLabelled, click, freshDb, pollTick, repaint, row,
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

function recoveryFold(): HTMLDetailsElement {
  const fold = document.querySelector<HTMLDetailsElement>('.stale-drafts-fold')
  if (!fold) throw new Error('draft recovery fold not rendered')
  return fold
}

describe('versioned board-row draft ownership', () => {
  it('never binds a deferred old-action draft to a newer action opened in Review queue', async () => {
    db = freshDb()
    upsertBoard(db, {
      ...AGENT,
      title: 'Review race',
      rows: [{
        label: 'Approve release',
        status: 'blocked',
        note: 'Old action',
        context: 'Old action context',
      }],
    })
    const original = getBoard(db, 'alpha', 'Review race')!
    const rowId = original.rows[0]!.id
    const bridge = await bootApp(db)

    click(row(rowId))
    await settle()
    type(answerInput(rowId), 'Draft that belongs only to v1')
    expect(advanceBoardRow(db, {
      project: 'alpha',
      title: 'Review race',
      label: 'Approve release',
      expectedBoardVersion: original.revision,
      expectedRevision: original.rows[0]!.revision,
      note: 'New action',
      next_step: 'Choose for v2.',
      action_owner: 'approval',
      impact: 'Unblocks v2.',
      context: 'New action context',
    }).ok).toBe(true)

    await pollTick()
    expect(answerInput(rowId)?.value).toBe('Draft that belongs only to v1')
    click(buttonLabelled('Review queue'))
    await settle()

    const lightbox = document.getElementById('lightbox')!
    expect(lightbox.hidden).toBe(true)
    expect(lightbox.querySelector<HTMLInputElement>('.reply-input')?.value).not.toBe('Draft that belongs only to v1')
    expect(recoveryFold().textContent).toContain('Draft that belongs only to v1')
    expect(recoveryFold().textContent).toContain('Old action context')
    expect(bridge.posts.filter((post) => post.url.includes('/annotate'))).toHaveLength(0)
  })

  it('never carries a draft across board_advance or a later status/content revision', async () => {
    db = freshDb()
    upsertBoard(db, {
      ...AGENT,
      title: 'Launch',
      rows: [{
        label: 'Approve release',
        status: 'blocked',
        note: 'Old action',
        context: 'Old action context',
      }],
    })
    const original = getBoard(db, 'alpha', 'Launch')!
    const rowId = original.rows[0]!.id
    const bridge = await bootApp(db)

    click(row(rowId))
    await settle()
    type(answerInput(rowId), 'Draft for old action')
    expect(advanceBoardRow(db, {
      project: 'alpha',
      title: 'Launch',
      label: 'Approve release',
      expectedBoardVersion: original.revision,
      expectedRevision: original.rows[0]!.revision,
      note: 'New action',
      next_step: 'Choose again.',
      action_owner: 'approval',
      impact: 'Unblocks release.',
      context: 'New action context',
    }).ok).toBe(true)

    await pollTick()
    sortBy('newest')
    await settle()
    expect(answerInput(rowId)?.value).toBe('Draft for old action')
    await repaint()

    expect(answerInput(rowId)?.value).toBe('')
    expect(recoveryFold().textContent).toContain('Draft for old action')
    expect(recoveryFold().textContent).toContain('Approve release')
    expect(recoveryFold().textContent).toContain('Old action context')
    click(sendButton(rowId))
    await settle()
    expect(bridge.posts.filter((post) => post.url.includes('/annotate'))).toHaveLength(0)
    click(buttonLabelled('Clear', recoveryFold()))
    await settle()
    expect(document.querySelector('.stale-drafts-fold')).toBeNull()

    type(answerInput(rowId), 'Draft for advanced action')
    const advanced = getBoard(db, 'alpha', 'Launch')!
    upsertBoard(db, {
      ...AGENT,
      title: 'Launch',
      expectedVersion: advanced.revision,
      rows: [{
        label: 'Approve release',
        revision: advanced.rows[0]!.revision,
        status: 'partial',
        note: 'Agent-owned follow-up',
        context: 'Revised status context',
      }],
    })

    await pollTick()
    sortBy('oldest')
    await settle()
    expect(answerInput(rowId)?.value).toBe('Draft for advanced action')
    await repaint()

    expect(row(rowId)).toBeNull()
    expect(recoveryFold().textContent).toContain('Draft for advanced action')
    expect(recoveryFold().textContent).toContain('New action context')
    click(buttonLabelled('Clear', recoveryFold()))
    await settle()
    expect(document.querySelector('.stale-drafts-fold')).toBeNull()
  })
})
