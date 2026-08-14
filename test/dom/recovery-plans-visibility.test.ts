// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, resolveItem } from '../../src/store.js'
import {
  advanceClock, answerInput, bootApp, buttonLabelled, click, freshDb, pollTick, row,
  settle, type, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const

describe('draft recovery visibility from Plans', () => {
  it('navigates to and focuses recovery when a forced render finds a removed item draft', async () => {
    db = freshDb()
    const id = insertItem(db, { ...AGENT, kind: 'question', title: 'Removed from Plans' })
    await bootApp(db)

    click(row(id))
    await settle()
    type(answerInput(id), 'Do not hide this answer')
    click(document.querySelector('.tab[data-tab="boards"]'))
    expect(document.getElementById('boards')?.hidden).toBe(false)

    resolveItem(db, id)
    await pollTick()
    click(document.querySelector('#rail button[data-project="alpha"]'))
    await settle()

    const fold = document.querySelector<HTMLDetailsElement>('.stale-drafts-fold')!
    expect(document.getElementById('needsYou')?.hidden).toBe(false)
    expect(document.getElementById('boards')?.hidden).toBe(true)
    expect(fold?.open).toBe(true)
    expect(fold?.textContent).toContain('Do not hide this answer')
    expect(document.activeElement).toBe(fold?.querySelector('summary'))
    expect(document.getElementById('pauseHint')?.textContent).toBe('')

    click(buttonLabelled('Clear', fold))
    await settle()
    expect(document.querySelector('.stale-drafts-fold')).toBeNull()
    advanceClock()
    const arrival = insertItem(db, { ...AGENT, kind: 'question', title: 'Polling resumes' })
    await pollTick()
    expect(row(arrival)).not.toBeNull()
  })
})
