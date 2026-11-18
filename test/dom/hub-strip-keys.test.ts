// @vitest-environment jsdom
// test/dom/hub-strip-keys.test.ts — #617 PR 3c fix round: while another Mac's Inbox is on top, this
// Mac's own page underneath does nothing except through the strip. In its own file because the DOM
// harness keeps every boot's document listeners for the whole file (docs/architecture/testing.md),
// and this test needs the page's real key handler alone.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { getItem, insertItem } from '../../src/store.js'
import { bootApp, click, freshDb, row, settle, showInbox, useDomTest } from './harness.js'

const ID = '0123abcd'
const hub = { id: ID, label: 'MBP', origin: 'https://mbp.example.ts.net', machine: 'MBP', state: 'online', reason: null }
const view = (showing: string | null) => ({ available: true, keychain: true, hub, problem: null, showing })

function connectBridge(start: ReturnType<typeof view>) {
  let current = start
  const listeners = new Set<() => void>()
  const api = {
    view: vi.fn(async () => current),
    connect: vi.fn(async () => ({ ok: false, reason: 'failed' })),
    forget: vi.fn(async () => ({ ok: true })),
    show: vi.fn(async (id: string | null) => {
      current = view(id)
      for (const listener of [...listeners]) listener()
      return { ok: true, showing: id }
    }),
    onChange: (callback: () => void) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
  }
  return Object.assign(api, {
    set(next: ReturnType<typeof view>) {
      current = next
      for (const listener of [...listeners]) listener()
    },
  })
}
const strip = () => document.getElementById('hubStrip')
const pressKey = (key: string) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))

describe('this Mac’s hidden page while the other Mac’s Inbox is on top', () => {
  useDomTest()
  let db: Database.Database | null = null
  afterEach(() => {
    db?.close()
    db = null
    Reflect.deleteProperty(window, 'agentInboxConnect')
    Reflect.deleteProperty(window, 'agentInboxDesk')
  })

  // reproduced in the real app: with the other Mac's Inbox on top, j then e resolved a question on This Mac's hidden page
  it('while the other Mac’s Inbox is on top, this Mac’s own keys do nothing to its hidden page; once it goes, they work', async () => {
    const api = connectBridge(view(null))
    Object.defineProperty(window, 'agentInboxConnect', { configurable: true, value: api })
    Object.defineProperty(window, 'agentInboxDesk', { configurable: true, value: { connection: async () => ({ mode: 'local' }), onConnection: () => () => {} } })
    db = freshDb()
    const id = insertItem(db, { project: 'alpha', agent: 'claude', stream: 'main', kind: 'question', title: 'Ship it?', detail: 'One ask.' })
    await bootApp(db)
    await showInbox()
    click(row(id))
    await settle()
    expect(row(id)?.classList.contains('selected')).toBe(true)
    api.set(view(ID))
    await settle()
    expect(strip()).not.toBeNull()
    expect(document.querySelector('.app-shell')!.hasAttribute('inert')).toBe(true)
    // focus falls to the page's body, as after a click on the strip's words
    ;(document.activeElement as HTMLElement | null)?.blur()
    for (const key of ['j', 'e', 'x', '1', 'k', 'e']) {
      pressKey(key)
      await settle()
    }
    expect(row(id)).not.toBeNull()
    expect(getItem(db, id)?.status).toBe('open')
    // This Mac by keyboard: Tab lands on it, and pressing it brings This Mac back
    pressKey('Tab')
    expect(document.activeElement).toBe(strip()!.querySelector('button'))
    ;(document.activeElement as HTMLButtonElement).click()
    await settle()
    expect(strip()).toBeNull()
    expect(document.querySelector('.app-shell')!.hasAttribute('inert')).toBe(false)
    // the page's own keys work again: the same e now resolves the selected question
    expect(row(id)?.classList.contains('selected')).toBe(true)
    pressKey('e')
    await settle()
    expect(getItem(db, id)?.status).not.toBe('open')
  })
})
