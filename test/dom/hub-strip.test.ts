// @vitest-environment jsdom
// test/dom/hub-strip.test.ts — #617 PR 3c: the strip this Mac's own page draws while another Mac's
// Inbox is on screen. The hub's page controls every pixel of its view and chooses its own label, so
// what says whose Inbox is on screen is drawn here, in the top inset electron/hub-view.cjs leaves
// free, never by the hub's page. Values are synthetic: `mbp.example.ts.net`, `MBP`.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import hubViewModule from '../../electron/hub-view.cjs'
import { HUB_STRIP_HEIGHT, installHubStrip } from '../../public/hub-strip.js'
import { bootApp, freshDb, settle, useDomTest } from './harness.js'

const ID = '0123abcd'
const ORIGIN = 'https://mbp.example.ts.net'

type State = 'online' | 'retrying' | 'refused' | null
interface Hub { id: string; label: string; origin: string; machine: string | null; state: State; reason: string | null }
interface View { available: boolean; keychain?: boolean; hub?: Hub | null; problem?: string | null; showing?: string | null }

const hub = (state: State = 'online', reason: string | null = null, extra: Partial<Hub> = {}): Hub =>
  ({ id: ID, label: 'MBP', origin: ORIGIN, machine: 'MBP', state, reason, ...extra })
const view = (showing: string | null, h: Hub | null = hub()): View => ({ available: true, keychain: true, hub: h, problem: null, showing })

function connectBridge(start: View) {
  let current: View = structuredClone(start)
  const listeners = new Set<() => void>()
  const api = {
    view: vi.fn(async (): Promise<View> => structuredClone(current)),
    connect: vi.fn(async () => ({ ok: false, reason: 'failed' })),
    forget: vi.fn(async () => ({ ok: true })),
    show: vi.fn(async (id: string | null): Promise<Record<string, unknown>> => ({ ok: true, showing: id })),
    onChange: vi.fn((callback: () => void) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    }),
  }
  return Object.assign(api, {
    set(next: View) {
      current = structuredClone(next)
      for (const listener of [...listeners]) listener()
    },
  })
}
const localDesk = () => ({ connection: async () => ({ mode: 'local' }), onConnection: () => () => {}, available: async () => ({ open: false }) })

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}
const strip = () => document.getElementById('hubStrip')
const back = () => strip()?.querySelector<HTMLButtonElement>('button') ?? null

function install(api: ReturnType<typeof connectBridge> | null, desk: unknown = localDesk()) {
  return installHubStrip({ connect: () => api as never, desk: () => desk as never, documentRef: document })
}

describe('the strip that says whose Inbox is on screen', () => {
  beforeEach(() => {
    document.body.innerHTML = '<main><p>This Mac’s page</p></main>'
  })
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('is exactly as tall as the inset electron/hub-view.cjs leaves above the hub’s view', () => {
    expect(HUB_STRIP_HEIGHT).toBe(hubViewModule.HUB_STRIP_HEIGHT)
  })

  it('is fixed to the top of the window, above the page underneath (style.css, which jsdom does not lay out)', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'style.css'), 'utf8')
    const at = css.indexOf('\n.hub-strip {')
    expect(at).toBeGreaterThan(0)
    const body = css.slice(at, css.indexOf('}', at))
    expect(body).toMatch(/position: fixed;/)
    expect(body).toMatch(/top: 0;/)
    expect(body).toMatch(/left: 0;/)
    expect(body).toMatch(/right: 0;/)
    expect(body).toMatch(/box-sizing: border-box;/)
    expect(body).not.toMatch(/height:/)
  })

  it('is not drawn while This Mac is on screen, and the page is left exactly as it was', async () => {
    const before = document.body.innerHTML
    const api = connectBridge(view(null))
    install(api)
    await flush()
    expect(strip()).toBeNull()
    expect(document.body.innerHTML).toBe(before)
    expect(document.body.className).toBe('')
  })

  it('is drawn while the other Mac’s Inbox is on screen: whose, its status, and This Mac', async () => {
    install(connectBridge(view(ID)))
    await flush()
    expect(strip()).not.toBeNull()
    expect(strip()?.querySelector('.hub-strip-title')?.textContent).toBe('Showing MBP’s Inbox')
    expect(strip()?.querySelector('.hub-strip-state')?.textContent).toBe('Online')
    expect(back()?.textContent).toBe('This Mac')
    expect(back()?.type).toBe('button')
    expect(strip()?.style.height).toBe(`${HUB_STRIP_HEIGHT}px`)
    expect(strip()?.getAttribute('aria-label')).toBe('Whose Inbox is on screen')
  })

  it.each<[State, string | null, string]>([
    ['online', null, 'Online'],
    ['retrying', 'connecting', 'Reconnecting…'],
    ['retrying', 'stopped', 'Reconnecting…'],
    ['retrying', null, 'Reconnecting…'],
    ['retrying', 'unreachable', 'Can’t reach it'],
    ['retrying', 'not_running', 'Can’t reach it'],
    ['retrying', 'bad_certificate', 'Can’t reach it'],
    ['refused', 'refused', 'No longer paired'],
    ['refused', 'node_changed', 'No longer paired'],
    [null, null, 'Checking…'],
  ])('says %s (%s) as “%s”', async (state, reason, word) => {
    install(connectBridge(view(ID, hub(state, reason))))
    await flush()
    expect(strip()?.querySelector('.hub-strip-state')?.textContent).toBe(word)
  })

  it('sets the label as text', async () => {
    const label = '<img src=x onerror="globalThis.pwned=1">'
    install(connectBridge(view(ID, hub('online', null, { label }))))
    await flush()
    expect(strip()?.querySelector('.hub-strip-title')?.textContent).toBe(`Showing ${label}’s Inbox`)
    expect(strip()?.querySelector('img')).toBeNull()
    expect((globalThis as Record<string, unknown>).pwned).toBeUndefined()
  })

  it('This Mac asks main to put This Mac on top, and the strip goes when main says so', async () => {
    const api = connectBridge(view(ID))
    api.show.mockImplementation(async (id) => {
      api.set(view(id))
      return { ok: true, showing: id }
    })
    install(api)
    await flush()
    back()!.click()
    await flush()
    expect(api.show).toHaveBeenCalledWith(null)
    expect(strip()).toBeNull()
  })

  it('This Mac always works: while the other Mac can’t be reached, pressed twice, and when a read fails', async () => {
    const api = connectBridge(view(ID, hub('retrying', 'unreachable')))
    install(api)
    await flush()
    expect(back()?.disabled).toBe(false)
    back()!.click()
    back()!.click()
    await flush()
    expect(api.show).toHaveBeenCalledTimes(2)
    expect(api.show).toHaveBeenNthCalledWith(1, null)
    expect(api.show).toHaveBeenNthCalledWith(2, null)
    // a read that fails changes nothing about what is on top: the strip and its button stay
    api.view.mockRejectedValue(new Error('gone'))
    api.set(view(ID))
    await flush()
    expect(back()?.disabled).toBe(false)
    back()!.click()
    await flush()
    expect(api.show).toHaveBeenCalledTimes(3)
    // and a show that throws leaves the button working
    api.show.mockRejectedValue(new Error('gone'))
    back()!.click()
    await flush()
    expect(back()?.disabled).toBe(false)
  })

  it('is the first thing on the page, so it is the first stop for the keyboard', async () => {
    install(connectBridge(view(ID)))
    await flush()
    expect(document.body.firstElementChild).toBe(strip())
    const focusable = document.body.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    expect(focusable).toBe(back())
    back()!.focus()
    expect(document.activeElement).toBe(back())
  })

  it('draws once however often main says something changed, and follows each change', async () => {
    const api = connectBridge(view(null))
    install(api)
    await flush()
    api.set(view(ID))
    api.set(view(ID, hub('retrying', 'unreachable')))
    api.set(view(ID))
    await flush()
    expect(document.querySelectorAll('#hubStrip').length).toBe(1)
    expect(strip()?.querySelectorAll('button').length).toBe(1)
    api.set(view(ID, hub('refused', 'refused')))
    await flush()
    expect(strip()?.querySelector('.hub-strip-state')?.textContent).toBe('No longer paired')
    api.set(view(null))
    await flush()
    expect(strip()).toBeNull()
    expect(api.onChange).toHaveBeenCalledTimes(1)
  })

  it('is not drawn for an id that is not the stored Mac', async () => {
    install(connectBridge(view('feedc0de')))
    await flush()
    expect(strip()).toBeNull()
  })

  it.each([
    ['without agentInboxConnect', null, localDesk()],
    ['on the hub’s page', 'bridge', { connection: async () => ({ mode: 'hub', label: 'MBP', state: 'online', version: null }) }],
    ['without agentInboxDesk', 'bridge', null],
  ])('is never drawn %s', async (_name, bridge, desk) => {
    const api = connectBridge(view(ID))
    install(bridge === null ? null : api, desk)
    await flush()
    expect(strip()).toBeNull()
    if (bridge !== null) expect(api.view).not.toHaveBeenCalled()
  })
})

describe('the strip in the app', () => {
  useDomTest()
  let db: Database.Database | null = null
  afterEach(() => {
    db?.close()
    db = null
    Reflect.deleteProperty(window, 'agentInboxConnect')
    Reflect.deleteProperty(window, 'agentInboxDesk')
  })

  it('is drawn by this Mac’s page once another Mac’s Inbox is on screen, and goes with This Mac', async () => {
    const api = connectBridge(view(null))
    api.show.mockImplementation(async (id) => {
      api.set(view(id))
      return { ok: true, showing: id }
    })
    Object.defineProperty(window, 'agentInboxConnect', { configurable: true, value: api })
    Object.defineProperty(window, 'agentInboxDesk', { configurable: true, value: localDesk() })
    db = freshDb()
    await bootApp(db)
    expect(strip()).toBeNull()
    api.set(view(ID))
    await settle()
    expect(strip()?.querySelector('.hub-strip-title')?.textContent).toBe('Showing MBP’s Inbox')
    expect(document.body.firstElementChild).toBe(strip())
    strip()!.querySelector('button')!.click()
    await settle()
    expect(api.show).toHaveBeenCalledWith(null)
    expect(strip()).toBeNull()
  })
})
