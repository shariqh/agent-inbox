// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, snoozeItem } from '../../src/store.js'
import { bootApp, freshDb, row, settle, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const
const HOUR = 60 * 60_000

function open(): Database.Database {
  db = freshDb()
  return db
}

function tabbableQueueRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('#needsYouList .nrow')]
    .filter((entry) => entry.tabIndex === 0)
}

describe('Needs-you roving tab stop', () => {
  it('keeps closed-fold rows untabbable and reconciles j/k focus as folds open', async () => {
    const d = open()
    const staleId = insertItem(d, { ...AGENT, kind: 'question', title: 'Stale folded row' })
    vi.setSystemTime(Date.now() + 73 * HOUR)
    const snoozedId = insertItem(d, { ...AGENT, kind: 'question', title: 'Snoozed folded row' })
    snoozeItem(d, snoozedId, new Date(Date.now() + 4 * HOUR).toISOString())
    await bootApp(d)

    const snoozed = document.querySelector<HTMLDetailsElement>('.snoozed-fold')!
    const stale = [...document.querySelectorAll<HTMLDetailsElement>('.stale-fold')]
      .find((fold) => !fold.classList.contains('snoozed-fold'))!
    expect(snoozed.open).toBe(false)
    expect(stale.open).toBe(false)
    expect(row(snoozedId)?.tabIndex).toBe(-1)
    expect(row(staleId)?.tabIndex).toBe(-1)
    expect(tabbableQueueRows()).toHaveLength(0)

    snoozed.open = true
    snoozed.dispatchEvent(new Event('toggle'))
    expect(tabbableQueueRows()).toEqual([row(snoozedId)])

    stale.open = true
    stale.dispatchEvent(new Event('toggle'))
    expect(tabbableQueueRows()).toEqual([row(snoozedId)])

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(row(staleId))
    expect(tabbableQueueRows()).toEqual([row(staleId)])

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(row(snoozedId))
    expect(tabbableQueueRows()).toEqual([row(snoozedId)])
  })

  it('rebuilds one roving tab stop when an empty search is cleared', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'Visible after clearing search' })
    await bootApp(d)
    expect(tabbableQueueRows()).toEqual([row(id)])

    const search = document.getElementById('search') as HTMLInputElement
    search.value = 'no matching queue row'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(150)
    await settle()
    expect(document.querySelectorAll('#needsYouList .nrow')).toHaveLength(0)
    expect(tabbableQueueRows()).toHaveLength(0)

    search.value = ''
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(150)
    await settle()

    expect(row(id)).toBeTruthy()
    expect(tabbableQueueRows()).toEqual([row(id)])
    expect(row(id)?.classList.contains('selected')).toBe(true)
  })
})
