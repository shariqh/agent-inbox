// @vitest-environment jsdom
// Find follow-ups: saving a Note on a row listed only for its unsent text.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem } from '../../src/store.js'
import { advanceClock, bootApp, buttonLabelled, click, findFor, freshDb, noteEditor, settle, type, useDomTest } from './harness.js'

useDomTest()
let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })
const ATLAS = { project: 'atlas', stream: 'main', agent: 'claude' } as const
const findKeys = () => [...document.querySelectorAll<HTMLElement>('#findList > .find-row')].map((el) => el.dataset.findKey)
const findRowEl = (key: string) => document.querySelector<HTMLElement>(`#findList > .find-row[data-find-key="${key}"]`)

async function setup() {
  db = freshDb()
  advanceClock()
  const note = insertItem(db, { ...ATLAS, kind: 'note', title: 'Nightly backups' })
  advanceClock()
  insertItem(db, { ...ATLAS, kind: 'note', title: 'Zebra crossing' })
  await bootApp(db)
  click(document.querySelector('.tab[data-tab="find"]'))
  await settle()
  const k = `item:${note}`
  click(findRowEl(k)!.querySelector(':scope > .find-row-main'))
  await settle()
  click(buttonLabelled('Note', findRowEl(k)!.querySelector('.find-row-body')!))
  await settle()
  type(noteEditor(findRowEl(k)), 'half a thought')
  await findFor('zebra')
  expect(findKeys()).toContain(k)
  return k
}

describe('save of a row listed only for its text', () => {
  it('K1: the Save button keeps it in place', async () => {
    const k = await setup()
    click(buttonLabelled('Save', findRowEl(k)!.querySelector('.note-editor')!))
    await settle()
    expect(findKeys()).toContain(k)
  })
  it('K2: Cmd+Enter in the editor keeps it in place too', async () => {
    const k = await setup()
    const editor = noteEditor(findRowEl(k))!
    editor.focus()
    editor.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }))
    await settle()
    expect(findKeys()).toContain(k)
  })
})
