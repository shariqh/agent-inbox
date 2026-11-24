// @vitest-environment jsdom
// Find follow-ups: a refused Save says so in the row.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem } from '../../src/store.js'
import {
  advanceClock, bootApp, buttonLabelled, click, expectConsoleError, freshDb, settle, type, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
})

const ATLAS = { project: 'atlas', stream: 'main', agent: 'claude' } as const
const findRowEl = (key: string) => document.querySelector<HTMLElement>(`#findList > .find-row[data-find-key="${key}"]`)
const mainOf = (key: string) => findRowEl(key)?.querySelector<HTMLButtonElement>(':scope > .find-row-main') ?? null

describe('a refused Save on Find', () => {
  it('V10: a refused Save on a Find row says so on Find', async () => {
    db = freshDb()
    advanceClock()
    const id = insertItem(db, { ...ATLAS, kind: 'note', title: 'Nightly backups' })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await bootApp(db, {
      interceptFetch: async (input, init, next) => {
        if (String(input).endsWith('/annotate')) return new Response(JSON.stringify({ ok: false, reason: 'closed' }), { status: 409, headers: { 'content-type': 'application/json' } })
        return next()
      },
    })
    expectConsoleError(/./)
    click(document.querySelector('.tab[data-tab="find"]'))
    await settle()
    const k = `item:${id}`
    click(mainOf(k))
    await settle()
    click(buttonLabelled('Note', findRowEl(k)!))
    await settle()
    type(findRowEl(k)!.querySelector<HTMLTextAreaElement>('.note-editor textarea'), 'refused note')
    click(buttonLabelled('Save', findRowEl(k)!.querySelector('.note-editor')!))
    await settle()
    await vi.advanceTimersByTimeAsync(50)
    const findText = document.getElementById('find')!.textContent ?? ''
    const said = /not saved|not confirmed|unsent/i.test(findText)
    expect({ rowOpen: Boolean(findRowEl(k)?.querySelector('.find-row-body')), said }).toEqual({ rowOpen: true, said: true })
  })
})
