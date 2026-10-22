// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { getItem, insertItem } from '../../src/store.js'
import { bootApp, click, freshDb, row, setViewport, settle, showInbox, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

function press(key: string) {
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', {
    key, bubbles: true, cancelable: true,
  }))
}

it('keeps phone-card E/X on the current item without reaching background rows', async () => {
  db = freshDb()
  const scope = { project: 'alpha', stream: 'main', agent: 'copilot', kind: 'question' as const }
  const resolveId = insertItem(db, { ...scope, title: 'Resolve this item' })
  const dismissId = insertItem(db, { ...scope, title: 'Dismiss this item' })
  const backgroundId = insertItem(db, { ...scope, title: 'Leave this background item alone' })
  setViewport(460)
  await bootApp(db)
  await showInbox()

  // One boot: retained document listeners from earlier boots consume legacy keys.
  for (const [key, id, status] of [
    ['e', resolveId, 'resolved'], ['x', dismissId, 'dismissed'],
  ] as const) {
    click(row(id))
    await settle()
    // jsdom cannot evaluate container queries; supply their rendered result.
    const card = row(id)!.querySelector<HTMLElement>('.nrow-card')!
    card.style.position = 'fixed'
    row(backgroundId)!.focus()
    press(key)
    await settle()
    expect(getItem(db, backgroundId)?.status).toBe('open')
    expect(row(backgroundId)?.classList.contains('staged')).toBe(false)

    expect(card.isConnected).toBe(true)
    card.focus()
    expect(document.activeElement).toBe(card)
    press(key)
    await vi.advanceTimersByTimeAsync(5_100)
    await settle()
    expect(getItem(db, id)?.status).toBe(status)
    expect(getItem(db, backgroundId)?.status).toBe('open')
  }
})
