// @vitest-environment jsdom
// UX pass, slice 4, A11: keys on Find. Its own file, with one boot: jsdom keeps an earlier
// boot's document listeners for the whole file, and those would answer a key as Home.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { getItem, insertItem } from '../../src/store.js'
import { advanceClock, bootApp, buttonLabelled, click, freshDb, settle, unreachableReason, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
})

const ATLAS = { project: 'atlas', stream: 'main', agent: 'claude' } as const

function key(target: EventTarget, keyName: string) {
  target.dispatchEvent(new window.KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true }))
}

describe('A11 · keys', () => {
  it('ignores the printable shortcuts of other pages; E on a focused Resolve works inside an open row', async () => {
    db = freshDb()
    insertItem(db, { ...ATLAS, kind: 'question', title: 'An ask on Home' })
    advanceClock()
    const note = insertItem(db, { ...ATLAS, kind: 'note', title: 'A note' })
    await bootApp(db)
    click(document.querySelector('.tab[data-tab="find"]'))
    await settle()
    ;(document.getElementById('findQuery') as HTMLInputElement).blur()
    key(document.body, 't')
    await settle()
    expect(document.getElementById('lightbox')!.hidden, 't opens no Review queue on Find').toBe(true)
    const row = () => document.querySelector<HTMLElement>(`#findList > [data-find-key="item:${note}"]`)!
    const main = row().querySelector<HTMLButtonElement>('.find-row-main')!
    expect(unreachableReason(main)).toBeNull()
    click(main)
    await settle()
    const resolve = buttonLabelled('Resolve', row().querySelector('.find-row-body')!)!
    const order = () => [...document.querySelectorAll<HTMLElement>('#findList > .find-row')].map((el) => el.dataset['findKey'])
    const before = order()
    resolve.focus()
    key(resolve, 'e')
    await settle()
    expect(getItem(db, note)?.status).toBe('resolved')
    // resolved by the key, the row keeps its place, as it does for a press
    expect(order()).toEqual(before)
  })
})

