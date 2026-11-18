// @vitest-environment jsdom
// test/dom/hub-strip-deck-keys.test.ts — #617 PR 3c: while another Mac's Inbox is on top, a key
// aimed at the strip's own button must not reach this Mac's hidden page either. The page's key
// handler skips keys aimed at a button, except while the triage deck is open: there a digit pressed
// on This Mac answered a hidden question. In its own file because the DOM harness keeps every
// boot's document listeners for the whole file (docs/architecture/testing.md).
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { getItem, insertItem } from '../../src/store.js'
import { bootApp, click, freshDb, settle, showInbox, useDomTest } from './harness.js'

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
const keyOn = (target: EventTarget, key: string) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

describe('keys aimed at the strip itself while the other Mac’s Inbox is on top', () => {
  useDomTest()
  let db: Database.Database | null = null
  afterEach(() => {
    db?.close()
    db = null
    Reflect.deleteProperty(window, 'agentInboxConnect')
    Reflect.deleteProperty(window, 'agentInboxDesk')
  })

  it('with the triage deck open, a digit pressed on This Mac answers nothing on the hidden page; once the strip goes, it answers', async () => {
    const api = connectBridge(view(null))
    Object.defineProperty(window, 'agentInboxConnect', { configurable: true, value: api })
    Object.defineProperty(window, 'agentInboxDesk', { configurable: true, value: { connection: async () => ({ mode: 'local' }), onConnection: () => () => {} } })
    db = freshDb()
    const id = insertItem(db, {
      project: 'alpha', agent: 'claude', stream: 'main', kind: 'question', title: 'Ship it?', detail: 'One ask.',
      options: [{ label: 'Tuesday' }, { label: 'Thursday' }],
    })
    await bootApp(db)
    await showInbox()
    click(document.querySelector('.triage-btn'))
    await settle()
    api.set(view(ID))
    await settle()
    const button = strip()!.querySelector('button')!
    button.focus()
    expect(document.activeElement).toBe(button)
    for (const key of ['1', 'j', 'k', '2']) {
      keyOn(button, key)
      await settle()
    }
    await settle()
    expect(getItem(db, id)?.reply ?? null).toBeNull()
    expect(getItem(db, id)?.status).toBe('open')
    // Enter and Space on the button are left to the browser: they are what presses it
    expect(keyOn(button, 'Enter').defaultPrevented).toBe(false)
    expect(keyOn(button, ' ').defaultPrevented).toBe(false)
    button.click()
    await settle()
    expect(strip()).toBeNull()
    // the same digit now reaches the deck, so the nulls above were the strip's doing
    keyOn(document.body, '1')
    await settle()
    await settle()
    expect(getItem(db, id)?.reply).toBe('Tuesday')
  })
})
