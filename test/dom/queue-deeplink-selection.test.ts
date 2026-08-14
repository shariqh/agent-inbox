// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, listItems, snoozeItem } from '../../src/store.js'
import {
  advanceClock, bootApp, click, freshDb, navigateToHash, pollTick, row, settle, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const
const HOUR = 60 * 60_000

function press(key: string): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

describe('Needs-you deep-link selection ownership', () => {
  it('syncs regular, stale, and snoozed targets before polling restores focus', async () => {
    db = freshDb()
    const stale = insertItem(db, { ...AGENT, kind: 'question', title: 'Stale target' })
    vi.setSystemTime(Date.now() + 73 * HOUR)
    const snoozed = insertItem(db, { ...AGENT, kind: 'question', title: 'Snoozed target' })
    snoozeItem(db, snoozed, new Date(Date.now() + 4 * HOUR).toISOString())
    advanceClock()
    const first = insertItem(db, { ...AGENT, kind: 'question', title: 'Prior selection' })
    advanceClock()
    const linked = insertItem(db, { ...AGENT, kind: 'question', title: 'Linked selection' })
    await bootApp(db)

    click(row(first))
    await settle()
    click(row(first))
    await settle()
    expect(row(first)?.classList.contains('selected')).toBe(true)

    navigateToHash(`#item/${linked}`)
    await settle()
    await pollTick()
    expect(row(linked)?.classList.contains('selected')).toBe(true)
    expect(row(linked)?.tabIndex).toBe(0)
    expect(document.activeElement).toBe(row(linked))
    press('e')
    await settle()
    expect(listItems(db).find((item) => item.id === linked)?.status).toBe('resolved')
    expect(listItems(db).find((item) => item.id === first)?.status).toBe('open')

    navigateToHash(`#item/${stale}`)
    await settle()
    await pollTick()
    expect(row(stale)?.closest<HTMLDetailsElement>('.stale-fold')?.open).toBe(true)
    expect(row(stale)?.classList.contains('selected')).toBe(true)
    expect(row(stale)?.tabIndex).toBe(0)

    navigateToHash(`#item/${snoozed}`)
    await settle()
    await pollTick()
    expect(row(snoozed)?.closest<HTMLDetailsElement>('.snoozed-fold')?.open).toBe(true)
    expect(row(snoozed)?.classList.contains('selected')).toBe(true)
    expect(row(snoozed)?.tabIndex).toBe(0)
  })
})
