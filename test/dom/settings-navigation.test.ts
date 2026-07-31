// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { upsertBoard } from '../../src/store.js'
import { bootApp, click, freshDb, settle, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
  delete (window as unknown as Record<string, unknown>).agentInboxSetup
})

function panelIsOpen(id: string): boolean {
  return !(document.getElementById(id)?.hidden ?? true)
}

describe('native settings navigation', () => {
  it('toggles from Cmd+, and the app menu, closes on Escape, and yields to content navigation', async () => {
    db = freshDb()
    upsertBoard(db, {
      project: 'alpha',
      stream: 'main',
      agent: 'copilot',
      title: 'release board',
      rows: [{ label: 'ship', status: 'tracked' }],
    })
    let toggleFromAppMenu = () => {}
    Object.defineProperty(window, 'agentInboxSetup', {
      configurable: true,
      value: {
        available: async () => false,
        onToggleSettings(toggle: () => void) { toggleFromAppMenu = toggle },
      },
    })
    await bootApp(db, {
      viewer: {
        setupInfoPath: '/nonexistent/setup-info.json',
        stamp: async () => null as never,
      },
    })
    await settle()

    const shortcut = () => {
      const event = new KeyboardEvent('keydown', {
        key: ',',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      })
      document.dispatchEvent(event)
      return event
    }

    expect(shortcut().defaultPrevented).toBe(true)
    expect(panelIsOpen('setup')).toBe(true)
    expect(document.getElementById('gear')?.getAttribute('aria-pressed')).toBe('true')
    shortcut()
    expect(panelIsOpen('needsYou')).toBe(true)

    toggleFromAppMenu()
    expect(panelIsOpen('setup')).toBe(true)
    toggleFromAppMenu()
    expect(panelIsOpen('needsYou')).toBe(true)

    click(document.getElementById('gear'))
    click(document.querySelector('#tabs [data-tab="boards"]'))
    expect(panelIsOpen('boards')).toBe(true)
    expect(panelIsOpen('setup')).toBe(false)

    click(document.getElementById('gear'))
    click(document.querySelector('#rail [data-project="alpha"]'))
    expect(panelIsOpen('boards')).toBe(true)
    expect(panelIsOpen('setup')).toBe(false)

    click(document.getElementById('gear'))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(panelIsOpen('boards')).toBe(true)
    expect(document.activeElement).toBe(document.getElementById('gear'))
  })
})
