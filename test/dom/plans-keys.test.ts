// @vitest-environment jsdom
// UX pass, slice 3: on Plans there are no rows to move through and no ask to close, so J, K
// and the arrow keys scroll the page and Escape leaves Home's open ask alone. This file boots
// the app once: every boot adds a key listener to the shared document, which a second boot in
// one file would hear as well.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { getBoard, upsertBoard } from '../../src/store.js'
import { advanceClock, bootApp, click, freshDb, row, settle, showInbox, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
  vi.restoreAllMocks()
})

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const

describe('keys on Plans (CFK-9)', () => {
  it('leaves the arrows, J and K to the page and Escape to Plans, while Home keeps them', async () => {
    db = freshDb()
    advanceClock()
    upsertBoard(db, { ...AGENT, title: 'Waiting', rows: [{ label: 'Pick one', status: 'blocked', note: 'Choose now.' }] })
    const a = getBoard(db, 'alpha', 'Waiting')!
    await bootApp(db)
    await showInbox()
    const press = (key: string): KeyboardEvent => {
      const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      document.body.dispatchEvent(e)
      return e
    }
    // on Home the keys still act
    expect(press('ArrowDown').defaultPrevented).toBe(true)
    click(row(a.rows[0]!.id))
    await settle()
    expect(row(a.rows[0]!.id)!.querySelector('.nrow-card')).not.toBeNull()
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    for (const key of ['ArrowDown', 'ArrowUp', 'j', 'k']) expect(press(key).defaultPrevented, key).toBe(false)
    expect(press('Escape').defaultPrevented).toBe(false)
    await showInbox()
    expect(row(a.rows[0]!.id)!.querySelector('.nrow-card')).not.toBeNull()
  })
})
