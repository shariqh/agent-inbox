// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { getBoard, updateBoardRow, upsertBoard } from '../../src/store.js'
import {
  answerInput, bootApp, buttonLabelled, click, freshDb, row, sendButton, settle, type, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const

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
      title: 'Shared launch',
      rows: [
        { label: 'Approve launch', status: 'blocked', note: 'Choose now.' },
        { label: 'Agent progress', status: 'tracked', note: 'Original progress.' },
      ],
    })
    const original = getBoard(db, 'alpha', 'Shared launch')!
    const target = original.rows[0]!
    const unrelated = original.rows[1]!
    await bootApp(db)

    click(row(target.id))
    await settle()
    click(buttonLabelled('Review queue'))
    await settle()
    const lightbox = document.getElementById('lightbox')!
    type(lightbox.querySelector<HTMLInputElement>('.reply-input'), 'Retry this exact action')
    updateBoardRow(db, {
      ...AGENT,
      title: 'Shared launch',
      label: unrelated.label,
      expectedBoardVersion: original.revision,
      expectedRevision: unrelated.revision,
      note: 'New progress only.',
    })
    expect(getBoard(db, 'alpha', 'Shared launch')!.revision).toBe(original.revision + 1)
    click(buttonLabelled('Send', lightbox))
    await settle()

    const recovered = answerInput(target.id)
    expect(lightbox.hidden).toBe(true)
    expect(document.querySelector('.stale-drafts-fold')).toBeNull()
    expect(recovered?.value).toBe('Retry this exact action')
    expect(document.activeElement).toBe(recovered)

    click(buttonLabelled('Review queue'))
    expect(lightbox.hidden).toBe(true)
    expect(document.activeElement).toBe(recovered)

    click(sendButton(target.id))
    await settle()
    expect(getBoard(db, 'alpha', 'Shared launch')!.rows[0]!.annotation).toBe('Retry this exact action')
    click(buttonLabelled('Review queue'))
    expect(lightbox.hidden).toBe(false)
    expect(lightbox.querySelector('.lb-count')?.textContent).toBe('all clear')
  })
})
