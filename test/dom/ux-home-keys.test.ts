// @vitest-environment jsdom
// UX pass, slice 2: one Home. The keys act on the ask in front once the one
// before it leaves the list. Its own file: jsdom keeps every earlier boot's
// document listeners in one file, and an earlier page's handler claims E
// (preventDefault) before this page's sees it, so only a file's first test can
// press it.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { getItem, insertItem } from '../../src/store.js'
import { advanceClock, bootApp, click, freshDb, row, settle, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
  vi.restoreAllMocks()
})

const AGENT = { project: 'atlas', stream: 'main', agent: 'copilot' } as const
const openIds = () => [...document.querySelectorAll<HTMLElement>('#needsYouList .nrow[data-open="1"]')].map((el) => el.dataset['cardId'])
const front = () => document.body.classList.contains('ask-front')
const press = (key: string) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))

describe('the ask in front after a resolve', () => {
  it('brings the next waiting ask forward with the selection and the keys on it; resolving the last clears the class', async () => {
    db = freshDb()
    advanceClock()
    const first = insertItem(db, { ...AGENT, kind: 'question', title: 'First ask' })
    advanceClock()
    const second = insertItem(db, { ...AGENT, kind: 'question', title: 'Second ask' })
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    expect(openIds()).toEqual([first])
    // the first click on the ask that came to the front opens it as the person's: focus into its card
    click(row(first))
    await settle()
    expect(row(first)?.querySelector('.nrow-card')?.contains(document.activeElement)).toBe(true)
    press('e')
    await settle()
    expect(getItem(db, first)?.status).toBe('resolved')
    expect(openIds()).toEqual([second])
    expect(row(second)?.classList.contains('selected')).toBe(true)
    expect(document.activeElement, 'a keyboard user lands on the ask now in front').toBe(row(second))
    expect(front()).toBe(true)
    press('e')
    await settle()
    expect(getItem(db, second)?.status).toBe('resolved')
    expect(openIds()).toEqual([])
    expect(front()).toBe(false)
  })
})
