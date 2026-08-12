// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem } from '../../src/store.js'
import { advanceClock, bootApp, freshDb, pollTick, row, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const

function press(key: string, target: EventTarget): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

describe('Review queue focus return', () => {
  it('restores a replaced queue-row opener by logical identity after polling', async () => {
    db = freshDb()
    const id = insertItem(db, { ...AGENT, kind: 'question', title: 'Return here' })
    await bootApp(db)

    const opener = row(id)!
    opener.focus()
    press('t', opener)
    const panel = document.querySelector<HTMLElement>('#lightbox .lb-panel')!
    expect(document.activeElement).toBe(panel)

    advanceClock()
    insertItem(db, { ...AGENT, kind: 'question', title: 'Polling arrival' })
    await pollTick()
    expect(opener.isConnected).toBe(false)

    press('Escape', panel)
    expect(document.getElementById('lightbox')?.hidden).toBe(true)
    expect(document.activeElement).toBe(row(id))
  })
})
