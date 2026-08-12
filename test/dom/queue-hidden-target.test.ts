// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, listItems, resolveItem } from '../../src/store.js'
import {
  bootApp, click, freshDb, navigateToHash, pollTick, row, settle, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const
const HOUR = 60 * 60_000

function press(key: string): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

describe('hidden queue shortcut targeting', () => {
  it('never targets an inspector hidden by another tab or a closed deferred fold', async () => {
    db = freshDb()
    const stale = insertItem(db, { ...AGENT, kind: 'question', title: 'Stale inspector' })
    vi.setSystemTime(Date.now() + 73 * HOUR)
    const current = insertItem(db, { ...AGENT, kind: 'question', title: 'Current inspector' })
    await bootApp(db)

    click(row(current))
    await settle()
    click(document.querySelector('#tabs [data-tab="boards"]'))
    await pollTick()
    press('e')
    await settle()
    expect(listItems(db).find((item) => item.id === current)?.status).toBe('open')

    click(document.querySelector('#tabs [data-tab="needsYou"]'))
    resolveItem(db, current)
    await pollTick()
    navigateToHash(`#item/${stale}`)
    await settle()
    const fold = row(stale)!.closest<HTMLDetailsElement>('.stale-fold')!
    expect(fold.open).toBe(true)
    expect(row(stale)?.dataset.open).toBe('1')

    fold.open = false
    fold.dispatchEvent(new Event('toggle'))
    press('e')
    await settle()
    expect(listItems(db).find((item) => item.id === stale)?.status).toBe('open')
  })
})
