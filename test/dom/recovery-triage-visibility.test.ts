// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { getBoard, upsertBoard } from '../../src/store.js'
import {
  bootApp, buttonLabelled, click, freshDb, settle, type, useDomTest,
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
})
