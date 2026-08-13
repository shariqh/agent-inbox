// @vitest-environment jsdom
// test/dom/row-dismiss.test.ts
//
// An affordance that lies is worse than no affordance — the owner's original
// complaint about the Needs-you list. Every row rendered a ✕ titled
// "Dismiss (x)", but its handler was `if (m.kind === 'item') stageDismiss(m.id)`:
// on a blocked board row the button was there, hoverable, focusable, keyboard-
// advertised, and did NOTHING. Board rows deliberately have no line-level
// dismiss path: their expanded card owns snooze, clarification, decline, answer
// and task-done controls. The honest thing is still to omit the ambiguous ✕ on
// BOTH input paths.
//
// ONE boot on purpose: jsdom's document outlives the module registry, so every
// extra bootApp() in a file leaves another keydown listener attached and a key
// press would run in several app.js instances at once (CLAUDE.md, DOM harness).
import { describe, it, expect, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, listBoards, upsertBoard } from '../../src/store.js'
import { advanceClock, bootApp, freshDb, row, rowTitles, settle, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'claude' } as const

function press(key: string): void {
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }))
}

describe('the ✕ on a Needs-you row (issue #36, the half that is in scope)', () => {
  it('is absent on a blocked board row and inert to the x key — while an item keeps both', async () => {
    const d = freshDb()
    db = d
    upsertBoard(d, { ...AGENT, title: 'PR #429', rows: [{ label: 'Merge', status: 'blocked', note: 'ready when you are' }] })
    const rowId = listBoards(d)[0]!.rows[0]!.id
    advanceClock()
    const itemId = insertItem(d, { ...AGENT, kind: 'question', title: 'which storage?' })

    await bootApp(d)
    // a blocked row sorts ahead of an asking question, so 'j' lands on it first
    expect(rowTitles()).toEqual(['Merge', 'which storage?'])

    // the pointer affordance
    expect(row(itemId)?.querySelector('.nrow-dismiss'), 'an item genuinely has a dismiss path').not.toBeNull()
    expect(row(rowId)?.querySelector('.nrow-dismiss'), 'a board row has none — drawing ✕ was the lie').toBeNull()

    // Roving focus seeds the first operable row; 'x' on that row does nothing…
    expect(row(rowId)?.classList.contains('selected')).toBe(true)
    press('x')
    await settle()
    expect(rowTitles(), 'the row must survive a key it was never told about').toEqual(['Merge', 'which storage?'])
    expect(row(rowId)?.className).not.toContain('staged')

    // …and this is a deliberate no-op, not a dead handler: the very next 'x',
    // on the item below it, stages a real dismissal.
    press('j')
    expect(row(itemId)?.classList.contains('selected')).toBe(true)
    press('x')
    await settle()
    expect(row(itemId)?.className).toContain('staged')
  })
})
