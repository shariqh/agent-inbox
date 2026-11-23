// @vitest-environment jsdom
// Find follow-ups: a failed read, focus and the waiting list.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, resolveItem, upsertBoard } from '../../src/store.js'
import {
  advanceClock, bootApp, buttonLabelled, click, findFor, freshDb, pollTick, settle, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
})

const ATLAS = { project: 'atlas', stream: 'main', agent: 'claude' } as const
const LEDGER = { project: 'ledger', stream: 'main', agent: 'copilot' } as const

const field = () => document.getElementById('findQuery') as HTMLInputElement
const findRows = () => [...document.querySelectorAll<HTMLElement>('#findList > .find-row')]
const findKeys = () => findRows().map((el) => el.dataset.findKey)
const findRowEl = (key: string) => document.querySelector<HTMLElement>(`#findList > .find-row[data-find-key="${key}"]`)
const mainOf = (key: string) => findRowEl(key)?.querySelector<HTMLButtonElement>(':scope > .find-row-main') ?? null
const chip = (name: string) => document.querySelector<HTMLButtonElement>(`#find [data-find-chip="${name}"]`)
const foot = () => document.getElementById('findFoot')!

async function openFindTab() {
  click(document.querySelector('.tab[data-tab="find"]'))
  await settle()
}

function seedWaiting(d: Database.Database) {
  const closed: string[] = []
  for (let i = 0; i < 55; i += 1) {
    advanceClock()
    closed.push(insertItem(d, { ...ATLAS, kind: 'note', title: `Old note ${i}` }))
  }
  for (const id of closed) {
    advanceClock()
    resolveItem(d, id)
  }
  advanceClock()
  const alpha = insertItem(d, { ...LEDGER, kind: 'note', title: 'Alpha open note' })
  advanceClock()
  const zebra = insertItem(d, { ...LEDGER, kind: 'note', title: 'Zebra open note' })
  return { alpha, zebra }
}

describe('a failed read and the waiting list', () => {
  it('V2b: after a failed read nothing of the previous list is left to press, and clearing the query opens nothing', async () => {
    db = freshDb()
    const ids = seedWaiting(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await bootApp(db, {
      interceptFetch: async (input, init, next) => {
        if (String(input) === '/api/items/history') return new Response('nope', { status: 500 })
        return next()
      },
    })
    await openFindTab()
    field().focus()
    await findFor('zebra')
    await pollTick()
    // the previous list's row is no longer there to press: the query was drawn over what is loaded
    expect(mainOf(`item:${ids.alpha}`)).toBeNull()
    const nowOpen = Boolean(findRowEl(`item:${ids.alpha}`)?.querySelector('.find-row-body'))
    field().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await settle()
    const afterClear = Boolean(findRowEl(`item:${ids.alpha}`)?.querySelector('.find-row-body'))
    expect({ nowOpen, afterClear }).toEqual({ nowOpen: false, afterClear: false })
  })

  it('V7: the busy mark ends when the chip changes to one that does not wait', async () => {
    db = freshDb()
    seedWaiting(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    let hold = false
    const held = new Promise<void>(() => {})
    await bootApp(db, {
      interceptFetch: async (input, init, next) => {
        if (String(input) === '/api/items/history' && hold) await held
        return next()
      },
    })
    upsertBoard(db, { ...LEDGER, title: 'Zebra plan', rows: [{ label: 'One', status: 'done' }] })
    await pollTick()
    await openFindTab()
    hold = true
    field().focus()
    await findFor('zebra')
    const list = document.getElementById('findList')!
    expect(list.dataset.updating).toBe('true')
    field().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await settle()
    expect({
      updating: list.hasAttribute('data-updating'),
      busy: list.hasAttribute('aria-busy'),
      disabled: findRows().some((el) => el.querySelector('.find-row-main')?.hasAttribute('aria-disabled')),
      keys: findKeys().length,
    }).toEqual({ updating: false, busy: false, disabled: false, keys: 2 })
  })

  it('V8: the foot button keeps its node and focus when "Show 5 more" becomes "Show 20 more", and its press reveals', async () => {
    db = freshDb()
    for (let i = 0; i < 25; i += 1) {
      advanceClock()
      insertItem(db, { ...ATLAS, kind: 'note', title: `Note ${i}` })
    }
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await bootApp(db)
    await openFindTab()
    const more = buttonLabelled('Show 5 more', foot())!
    more.focus()
    for (let i = 0; i < 20; i += 1) {
      advanceClock()
      insertItem(db, { ...LEDGER, kind: 'note', title: `Late ${i}` })
    }
    await pollTick()
    expect(foot().querySelector('button')).toBe(more)
    expect(more.textContent).toBe('Show 20 more')
    expect(document.activeElement).toBe(more)
    click(more)
    await settle()
    expect(findRows()).toHaveLength(40)
    expect(document.activeElement?.classList.contains('find-row-main')).toBe(true)
  })

  it('V9: a poll that re-sorts a focused plan row does not take focus from the field', async () => {
    db = freshDb()
    advanceClock()
    upsertBoard(db, { ...ATLAS, title: 'Older plan', rows: [{ label: 'One', status: 'partial' }] })
    advanceClock()
    upsertBoard(db, { ...ATLAS, title: 'Newer plan', rows: [{ label: 'One', status: 'partial' }] })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await bootApp(db)
    await openFindTab()
    click(chip('plans'))
    await settle()
    field().focus()
    advanceClock()
    upsertBoard(db, { ...ATLAS, title: 'Older plan', expectedVersion: 1, rows: [{ label: 'One', status: 'partial', revision: 1 }, { label: 'Two', status: 'done' }] })
    await pollTick()
    expect(document.activeElement).toBe(field())
    // and a chip keeps it too
    chip('plans')!.focus()
    advanceClock()
    upsertBoard(db, { ...ATLAS, title: 'Newer plan', expectedVersion: 1, rows: [{ label: 'One', status: 'partial', revision: 1 }, { label: 'Two', status: 'done' }] })
    await pollTick()
    expect(document.activeElement).toBe(chip('plans'))
  })
})
