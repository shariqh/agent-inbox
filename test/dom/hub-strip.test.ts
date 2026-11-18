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

let uninstall: (() => void) | null = null
// the strip's own timers, run by hand: the back-off after a read that did not answer
let timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
const runTimers = async () => {
  const due = timers.filter((t) => !t.cleared)
  timers = []
  for (const t of due) t.fn()
  await flush()
}
function install(api: ReturnType<typeof connectBridge> | null, desk: unknown = localDesk()) {
  const handle = installHubStrip({
    connect: () => api as never,
    desk: () => desk as never,
    documentRef: document,
    setTimeout: (fn: () => void, ms: number) => { const t = { fn, ms, cleared: false }; timers.push(t); return t },
    clearTimeout: (t: unknown) => { if (t) (t as { cleared: boolean }).cleared = true },
  })
  uninstall = handle ? handle.stop : null
  return handle
}
// what the preload answers for any failed call (electron/setup-preload.cjs, connectCall)
const OFF = { available: false }

describe('the strip that says whose Inbox is on screen', () => {
  beforeEach(() => {
    document.body.innerHTML = '<main><p>This Mac’s page</p><button id="hidden-control">Resolve</button></main><aside id="already-inert" inert></aside>'
    timers = []
  })
  afterEach(() => {
    uninstall?.()
    uninstall = null
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
    // one word per state, the same in Settings and on the other Mac's page
    ['retrying', 'connecting', 'Connecting…'],
    ['retrying', 'stopped', 'Reconnecting…'],
    ['retrying', null, 'Reconnecting…'],
    ['retrying', 'unreachable', 'Reconnecting…'],
    ['retrying', 'not_running', 'Reconnecting…'],
    ['retrying', 'bad_certificate', 'Reconnecting…'],
    ['refused', 'refused', 'Not connected'],
    ['refused', 'node_changed', 'Not connected'],
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
    // a read that fails (the preload answers { available: false }) changes nothing: the strip and its button stay
    api.view.mockResolvedValue(OFF as View)
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

  it('a read that does not answer changes nothing on screen, and the strip reads again, backing off, until one does', async () => {
    const api = connectBridge(view(ID, hub('online')))
    install(api)
    await flush()
    api.view.mockResolvedValue(OFF as View)
    api.set(view(ID))
    await flush()
    expect(strip()?.querySelector('.hub-strip-state')?.textContent).toBe('Online')
    const delays: number[] = []
    for (let i = 0; i < 7; i += 1) {
      expect(timers.filter((t) => !t.cleared)).toHaveLength(1)
      delays.push(timers[0]!.ms)
      await runTimers()
      expect(strip()).not.toBeNull()
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 15000, 30000, 30000])
    // a rejected read is the same
    api.view.mockRejectedValue(new Error('gone'))
    await runTimers()
    expect(strip()).not.toBeNull()
    // a real answer paints, and the reading stops
    api.view.mockResolvedValue(view(ID, hub('retrying', 'unreachable')))
    await runTimers()
    expect(strip()?.querySelector('.hub-strip-state')?.textContent).toBe('Reconnecting…')
    expect(timers.filter((t) => !t.cleared)).toHaveLength(0)
  })

  it('paints the newest answer when two reads cross', async () => {
    const api = connectBridge(view(null))
    const answers: Array<(value: View) => void> = []
    api.view.mockImplementation(() => new Promise((resolve) => answers.push(resolve)))
    install(api)
    await flush()
    api.set(view(ID))
    await flush()
    expect(answers).toHaveLength(2)
    answers[1]!(view(ID))
    await flush()
    answers[0]!(view(null))
    await flush()
    expect(strip()).not.toBeNull()
  })

  it('is the first thing on the page', async () => {
    install(connectBridge(view(ID)))
    await flush()
    expect(document.body.firstElementChild).toBe(strip())
    back()!.focus()
    expect(document.activeElement).toBe(back())
  })

  // #617 PR 3c fix round: this Mac's page is hidden under the other Mac's view, and acts only through the strip
  it('makes everything else on the page inert while it shows, and gives it back as it was when it goes', async () => {
    const api = connectBridge(view(ID))
    install(api)
    await flush()
    const others = [...document.body.children].filter((el) => el !== strip())
    expect(others.length).toBe(2)
    for (const el of others) expect(el.hasAttribute('inert'), el.outerHTML).toBe(true)
    expect(strip()!.hasAttribute('inert')).toBe(false)
    // a part of the page added while it shows is inert too
    const late = document.createElement('div')
    document.body.appendChild(late)
    await flush()
    expect(late.hasAttribute('inert')).toBe(true)
    api.set(view(null))
    await flush()
    expect(document.querySelector('main')!.hasAttribute('inert')).toBe(false)
    expect(late.hasAttribute('inert')).toBe(false)
    // what was inert before stays inert
    expect(document.getElementById('already-inert')!.hasAttribute('inert')).toBe(true)
  })

  it('stops every key before the page’s own handlers, wherever it is aimed, and leaves its own button the browser’s action', async () => {
    const seen: string[] = []
    const pageKeys = (event: KeyboardEvent) => seen.push(`${event.type} ${event.key}`)
    document.addEventListener('keydown', pageKeys, true)
    document.addEventListener('keydown', pageKeys)
    try {
      const api = connectBridge(view(ID))
      install(api)
      await flush()
      for (const key of ['e', 'x', '1', 'j', 'Enter', ' ']) {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
        document.body.dispatchEvent(event)
        expect(event.defaultPrevented, key).toBe(true)
        document.getElementById('hidden-control')!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      }
      expect(seen).toEqual([])
      // Tab from anywhere outside lands on This Mac, never on a hidden control
      const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      document.body.dispatchEvent(tab)
      expect(tab.defaultPrevented).toBe(true)
      expect(document.activeElement).toBe(back())
      // a key aimed at the strip's own button reaches no page handler either (with the triage deck open
      // the page acts on a digit whatever has focus), but keeps the browser's action: Enter presses it
      for (const key of ['Enter', ' ', '1', 'j']) {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
        back()!.dispatchEvent(event)
        expect(event.defaultPrevented, key).toBe(false)
      }
      expect(seen).toEqual([])
      // gone: the page has its keys again
      api.set(view(null))
      await flush()
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true, cancelable: true }))
      expect(seen).toEqual(['keydown e', 'keydown e'])
    } finally {
      document.removeEventListener('keydown', pageKeys, true)
      document.removeEventListener('keydown', pageKeys)
    }
  })

  it('gives way with its status word, never the name, in a narrow window (style.css)', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'style.css'), 'utf8')
    const rule = (selector: string) => {
      const at = css.indexOf(`\n${selector} {`)
      return at < 0 ? '' : css.slice(at, css.indexOf('}', at))
    }
    const title = rule('.hub-strip-title')
    const word = rule('.hub-strip-state')
    const shrink = (body: string) => Number(/flex-shrink: (\d+);/.exec(body)?.[1] ?? NaN)
    expect(shrink(word)).toBeGreaterThan(shrink(title) * 100)
    for (const body of [title, word]) {
      expect(body).toMatch(/min-width: 0;/)
      expect(body).toMatch(/overflow: hidden;/)
      expect(body).toMatch(/text-overflow: ellipsis;/)
    }
    expect(rule('.hub-strip-back')).toMatch(/flex: none;/)
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
    expect(strip()?.querySelector('.hub-strip-state')?.textContent).toBe('Not connected')
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
