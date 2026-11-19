// @vitest-environment jsdom
// test/dom/settings-from-hub.test.ts — #617: Settings… chosen while another Mac's Inbox is on top.
// Settings is on This Mac's page, so main brings that page forward and says the hub was on top
// (electron/hub-view.cjs, openSettings). The page then opens Settings rather than toggling them, and
// closing them shows the other Mac's Inbox again. Reported from a real pair of Macs: the shortcut
// sometimes left the other Mac's Inbox for good. In its own file because the DOM harness keeps every
// boot's document listeners for the whole file (docs/architecture/testing.md).
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { upsertBoard } from '../../src/store.js'
import { bootApp, click, freshDb, settle, useDomTest } from './harness.js'

const ID = '0123abcd'
type Hub = { id: string; label: string; origin: string; machine: string; state: string; reason: null }
const hub: Hub = { id: ID, label: 'MBP', origin: 'https://mbp.example.ts.net', machine: 'MBP', state: 'online', reason: null }
const view = (showing: string | null, stored: Hub | null = hub) => ({ available: true, keychain: true, hub: stored, problem: null, showing })

function connectBridge(start: ReturnType<typeof view>) {
  let current = start
  const listeners = new Set<() => void>()
  const tell = () => { for (const listener of [...listeners]) listener() }
  const api = {
    view: vi.fn(async () => current),
    connect: vi.fn(async () => ({ ok: false, reason: 'failed' })),
    forget: vi.fn(async () => ({ ok: true })),
    setDeskCommand: vi.fn(async () => ({ ok: false, reason: 'cancelled' })),
    show: vi.fn(async (id: string | null) => {
      current = view(id, current.hub)
      tell()
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
      tell()
    },
  })
}

const settingsOpen = () => !(document.getElementById('setup')?.hidden ?? true)
const strip = () => document.getElementById('hubStrip')
const key = (name: string, init: KeyboardEventInit = {}) =>
  document.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }))

describe('Settings… chosen while another Mac’s Inbox is on top', () => {
  useDomTest()
  let db: Database.Database | null = null
  afterEach(() => {
    db?.close()
    db = null
    Reflect.deleteProperty(window, 'agentInboxConnect')
    Reflect.deleteProperty(window, 'agentInboxDesk')
    Reflect.deleteProperty(window, 'agentInboxSetup')
    Reflect.deleteProperty(window, 'agentInboxUpdates')
  })

  it('opens Settings rather than toggling them, and closing them shows that Inbox again', async () => {
    const api = connectBridge(view(null))
    let toggleFromAppMenu: (fromHub?: unknown) => void = () => {}
    let updatesFromAppMenu: (fromHub?: unknown) => void = () => {}
    Object.defineProperty(window, 'agentInboxConnect', { configurable: true, value: api })
    Object.defineProperty(window, 'agentInboxDesk', { configurable: true, value: { connection: async () => ({ mode: 'local' }), onConnection: () => () => {} } })
    Object.defineProperty(window, 'agentInboxSetup', {
      configurable: true,
      value: { available: async () => false, onToggleSettings(toggle: (fromHub?: unknown) => void) { toggleFromAppMenu = toggle } },
    })
    // no update section is drawn (available: false); the bridge only hands over Check for Updates…
    Object.defineProperty(window, 'agentInboxUpdates', {
      configurable: true,
      value: { available: false, onOpenUpdates(open: (fromHub?: unknown) => void) { updatesFromAppMenu = open; return () => {} } },
    })
    db = freshDb()
    upsertBoard(db, { project: 'alpha', stream: 'main', agent: 'copilot', title: 'release board', rows: [{ label: 'ship', status: 'tracked' }] })
    await bootApp(db, { viewer: { setupInfoPath: '/nonexistent/setup-info.json', stamp: async () => null as never } })
    await settle()

    // Chromium ignores focus() on an inert element, and jsdom does not: record whether Settings
    // were still under the strip's cover each time they were given the keyboard
    const focusedFree: boolean[] = []
    const realFocus = HTMLElement.prototype.focus
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, ...args: unknown[]) {
      if (this.id === 'setup') focusedFree.push(this.closest('[inert]') === null)
      return realFocus.apply(this, args as never)
    })
    const scrolled = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})

    // what main does for Settings… while the hub is on top: This Mac comes forward, then the page is told
    const settingsFromTheHub = async () => {
      api.set(view(ID))
      await settle()
      expect(strip()).not.toBeNull()
      // main's order: show(null) tells the page, which asks view() again, and the toggle message
      // arrives before that answer, while the strip still covers the page
      api.set(view(null))
      toggleFromAppMenu(true)
      expect(strip()).not.toBeNull()
      await settle()
      expect(strip()).toBeNull()
    }

    // 1. Settings were closed: they open, and nothing is shown yet
    await settingsFromTheHub()
    expect(settingsOpen()).toBe(true)
    expect(api.show).not.toHaveBeenCalled()
    // they get the keyboard once the page is no longer covered, not before
    expect(focusedFree.at(-1)).toBe(true)
    expect(document.activeElement).toBe(document.getElementById('setup'))
    // once: a later answer from main does not take the keyboard back from what the person is on
    document.getElementById('gear')!.focus()
    const focusesBefore = focusedFree.length
    api.set(view(null))
    await settle()
    expect(focusedFree).toHaveLength(focusesBefore)
    expect(document.activeElement).toBe(document.getElementById('gear'))

    // 2. the shortcut closes them and the other Mac's Inbox is on top again
    key(',', { metaKey: true })
    await settle()
    expect(settingsOpen()).toBe(false)
    expect(api.show.mock.calls).toEqual([[ID]])
    expect(strip()).not.toBeNull()

    // 3. Settings left open underneath: Settings… from the hub shows them, it never closes them
    api.set(view(null))
    await settle()
    click(document.getElementById('gear'))
    expect(settingsOpen()).toBe(true)
    // (the window was scrolled down in them: it stays where it is)
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 240 })
    await settingsFromTheHub()
    expect(settingsOpen()).toBe(true)
    await settingsFromTheHub()
    expect(settingsOpen()).toBe(true)
    expect(scrolled).not.toHaveBeenCalled()
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 })
    // Escape closes them and goes back too
    key('Escape')
    await settle()
    expect(settingsOpen()).toBe(false)
    expect(api.show.mock.calls).toEqual([[ID], [ID]])

    // 4. the gear closes them and goes back
    await settingsFromTheHub()
    click(document.getElementById('gear'))
    await settle()
    expect(settingsOpen()).toBe(false)
    expect(api.show.mock.calls).toEqual([[ID], [ID], [ID]])

    // 5. Settings opened on This Mac itself close onto This Mac
    api.set(view(null))
    await settle()
    click(document.getElementById('gear'))
    click(document.getElementById('gear'))
    toggleFromAppMenu()
    toggleFromAppMenu(false)
    key(',', { metaKey: true })
    key(',', { metaKey: true })
    await settle()
    expect(settingsOpen()).toBe(false)
    expect(api.show).toHaveBeenCalledTimes(3)

    // 6. going somewhere else on This Mac's page is a choice to stay on This Mac
    await settingsFromTheHub()
    click(document.querySelector('#tabs [data-tab="boards"]'))
    await settle()
    expect(settingsOpen()).toBe(false)
    click(document.getElementById('gear'))
    click(document.getElementById('gear'))
    await settle()
    expect(api.show).toHaveBeenCalledTimes(3)

    // 6b. so is choosing a project in the sidebar
    await settingsFromTheHub()
    click(document.querySelector('#rail [data-project="alpha"]'))
    await settle()
    expect(settingsOpen()).toBe(false)
    expect(api.show).toHaveBeenCalledTimes(3)

    // 7. the other Mac's Inbox came back on top by another way (the View menu), then This Mac was
    //    chosen on the strip: Settings still open there close onto This Mac
    await settingsFromTheHub()
    api.set(view(ID))
    await settle()
    api.set(view(null))
    await settle()
    expect(settingsOpen()).toBe(true)
    click(document.getElementById('gear'))
    await settle()
    expect(settingsOpen()).toBe(false)
    expect(api.show).toHaveBeenCalledTimes(3)

    // 8. the other Mac was disconnected in Settings: there is nothing to go back to
    await settingsFromTheHub()
    api.set(view(null, null))
    await settle()
    key(',', { metaKey: true })
    await settle()
    expect(settingsOpen()).toBe(false)
    expect(api.show).toHaveBeenCalledTimes(3)

    // 9. main not answering leaves This Mac on screen, and nothing throws
    api.set(view(null))
    await settle()
    await settingsFromTheHub()
    api.view.mockImplementationOnce(async () => ({ available: false }) as never)
    key('Escape')
    await settle()
    expect(settingsOpen()).toBe(false)
    expect(api.show).toHaveBeenCalledTimes(3)

    // 10. a held shortcut acts once: every repeat is cancelled, wherever it is aimed, so neither the
    //     page nor the Settings… menu item closes what the first press opened
    api.set(view(null))
    await settle()
    await settingsFromTheHub()
    expect(settingsOpen()).toBe(true)
    for (const target of [document.body, document.getElementById('gear')!]) {
      const held = new KeyboardEvent('keydown', { key: ',', metaKey: true, repeat: true, bubbles: true, cancelable: true })
      target.dispatchEvent(held)
      expect(held.defaultPrevented).toBe(true)
    }
    await settle()
    expect(settingsOpen()).toBe(true)
    expect(api.show).toHaveBeenCalledTimes(3)
    // the first press on a button is still left to the menu item, as before
    const first = new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true, cancelable: true })
    document.getElementById('gear')!.dispatchEvent(first)
    expect(first.defaultPrevented).toBe(false)
    // Settings opened from the hub take the keyboard, so the next key is theirs
    expect(document.activeElement).toBe(document.getElementById('setup'))
    key('Escape')
    await settle()
    expect(api.show).toHaveBeenCalledTimes(4)

    // 11. Check for Updates… from the hub is the same trip: closing Settings goes back
    await settingsFromTheHub()
    key('Escape')
    await settle()
    expect(api.show).toHaveBeenCalledTimes(5)
    api.set(view(ID))
    await settle()
    api.set(view(null))
    await settle()
    updatesFromAppMenu(true)
    await settle()
    expect(settingsOpen()).toBe(true)
    key(',', { metaKey: true })
    await settle()
    expect(settingsOpen()).toBe(false)
    expect(api.show).toHaveBeenCalledTimes(6)
    // and from This Mac itself it stays on This Mac
    api.set(view(null))
    await settle()
    updatesFromAppMenu()
    updatesFromAppMenu(false)
    await settle()
    expect(settingsOpen()).toBe(true)
    key('Escape')
    await settle()
    expect(api.show).toHaveBeenCalledTimes(6)
  })
})
