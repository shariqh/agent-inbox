// @vitest-environment jsdom
// Issue #612: a hand-off's card has Acknowledge, not Dismiss, but the row's ✕ and
// the x key still dismiss it, as for any item (the design lets dismissItem close
// one). Only Acknowledge records the outcome "Acknowledged".
//
// ONE boot on purpose: a second bootApp() in a file leaves another keydown
// listener attached, so a key press would run in several app.js instances at
// once (docs/architecture/testing.md, DOM harness; row-dismiss.test.ts).
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, listItems } from '../../src/store.js'
import { advanceClock, bootApp, freshDb, row, settle, showInbox, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

describe('dismissing a hand-off from its row', () => {
  it('x stages the dismiss on the selected hand-off, and after the undo window it is dismissed with no outcome', async () => {
    const d = freshDb()
    db = d
    advanceClock()
    const id = insertItem(d, { project: 'alpha', stream: 'main', agent: 'copilot', kind: 'done', title: 'Draft is ready', next_step: 'Review the draft.' })
    await bootApp(d)
    await showInbox()
    expect(row(id)!.querySelector('.nrow-dismiss'), 'the row keeps its ✕').not.toBeNull()
    expect(row(id)!.classList.contains('selected')).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }))
    await settle()
    expect(row(id)!.className).toContain('staged')
    await vi.advanceTimersByTimeAsync(5000)
    await settle()
    expect(listItems(d).find((item) => item.id === id)).toMatchObject({ status: 'dismissed', outcome: '' })
    expect(row(id)).toBeNull()
  })
})
