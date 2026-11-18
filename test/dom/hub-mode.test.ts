// @vitest-environment jsdom
// test/dom/hub-mode.test.ts — #617 PR 3c: the page when it is the one another Mac shows.
//
// The hub serves the same public/ code, and it runs inside the hub view on the connecting Mac,
// where `agentInboxDesk.connection()` answers `{ mode: 'hub', label, state, version }` and none of
// the app's other bridges exist. The hub's remote entry refuses /api/setup, /api/owner, every
// /api/launches… route and /api/chats/copilot/:id, so the page must call none of them there, and
// draws none of the Settings blocks that need them. With no `agentInboxDesk` at all (a browser, an
// older app) the page is exactly as before: the snapshot below was taken from the page as it was
// before this change, and must not move.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem } from '../../src/store.js'
import { remoteRouteAllowed } from '../../src/viewer-remote.js'
import { bootApp, click, expectConsoleError, freshDb, pollTick, settle, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
  Reflect.deleteProperty(window, 'agentInboxDesk')
})

type DeskState = 'online' | 'retrying' | 'refused'
interface DeskAnswer { mode: 'hub'; label: string; state: DeskState; version: string | null }

/** The hub view's bridge, as electron/remote-preload.cjs exposes it. */
function hubDesk(label = 'MBP', state: DeskState = 'online') {
  let current: DeskAnswer = { mode: 'hub', label, state, version: '2.13.0' }
  const listeners = new Set<(value: DeskAnswer) => void>()
  const desk = {
    available: vi.fn(async () => ({ open: false })),
    connection: vi.fn(async () => ({ ...current })),
    onConnection: vi.fn((callback: (value: DeskAnswer) => void) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    }),
    retry: vi.fn(async () => ({ ok: false })),
  }
  Object.defineProperty(window, 'agentInboxDesk', { configurable: true, value: desk })
  return Object.assign(desk, {
    set(next: Partial<DeskAnswer>) {
      current = { ...current, ...next }
      for (const listener of [...listeners]) listener({ ...current })
    },
    /** a change message carrying anything at all */
    emit(value: unknown) {
      for (const listener of [...listeners]) listener(value as DeskAnswer)
    },
  })
}

const brandLine = () => document.querySelector('.brand-copy small')?.textContent
const settingsBody = () => document.querySelector('#setup .setup-body')
const reconnecting = () => document.getElementById('hubReconnecting')
const visible = (el: Element | null) => el !== null && !(el as HTMLElement).hidden

// What the remote entry refuses (src/viewer-remote.ts, design §3.6), by path.
const REFUSED = /^\/api\/(?:setup|owner|launches|launch-|chats\/copilot\/)/

function recorder() {
  const requests: string[] = []
  return {
    requests,
    interceptFetch: async (input: RequestInfo | URL, init: RequestInit | undefined, next: () => Promise<Response>) => {
      const url = new URL(String(input), 'http://127.0.0.1')
      requests.push(`${init?.method ?? 'GET'} ${url.pathname}`)
      return next()
    },
  }
}

function seed() {
  db = freshDb()
  insertItem(db, { project: 'alpha', agent: 'claude', stream: 'main', kind: 'question', title: 'Ship it?', detail: 'One ask.' })
  return db
}

// Opens Settings, the Chats tab and Settings again, then two polls: a full page start.
async function walk() {
  click(document.getElementById('gear'))
  await settle()
  click(document.getElementById('gear'))
  await settle()
  click(document.querySelector('.tab[data-tab="chats"]'))
  await settle()
  click(document.getElementById('gear'))
  await settle()
  await pollTick()
  await pollTick()
}

// The scratch database and home folders and the item ids differ from run to run, and Settings'
// build line names the checkout's commit, or is not drawn at all in a copy with no .git: dropped.
const steady = (html: string) => html
  .replace(/<p class="setup-hint">Running from the checkout[^<]*<\/p>/g, '')
  .replace(/\/(?:private|var|tmp|Users)\/[^\s"<]*/g, '<path>')
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')

describe('the page with no agentInboxDesk (a browser, an older app)', () => {
  it('is exactly the page it was before #617 PR 3c', async () => {
    const { requests, interceptFetch } = recorder()
    await bootApp(seed(), { interceptFetch })
    expect(steady(document.body.innerHTML)).toMatchSnapshot('boot')
    click(document.getElementById('gear'))
    await settle()
    expect(steady(document.body.innerHTML)).toMatchSnapshot('settings')
    expect([...new Set(requests)].sort()).toMatchSnapshot('requests')
  })
})

describe('the page shown from another Mac (hub mode)', () => {
  it('names the other Mac’s Inbox in the sidebar, as text', async () => {
    hubDesk('<b>MBP</b>')
    await bootApp(seed())
    expect(brandLine()).toBe('<b>MBP</b>’s Inbox')
    expect(document.querySelector('.brand-copy b')).toBeNull()
  })

  it('follows a new label from onConnection, and says “Another Mac” for an empty one', async () => {
    const desk = hubDesk('MBP')
    await bootApp(seed())
    desk.set({ label: 'Studio' })
    await settle()
    expect(brandLine()).toBe('Studio’s Inbox')
    desk.set({ label: '' })
    await settle()
    expect(brandLine()).toBe('Another Mac’s Inbox')
  })

  it('draws none of the Settings blocks that need this app or a refused route, and one line in their place', async () => {
    hubDesk('MBP')
    await bootApp(seed())
    click(document.getElementById('gear'))
    await settle()
    const body = settingsBody()!
    for (const id of ['link-settings', 'terminal-settings', 'launch-settings', 'updates-settings', 'connect-settings']) {
      expect(document.getElementById(id), id).toBeNull()
    }
    // Setup: the build line, the agents and runtimes blocks, the setup menu, the manual commands, the database path
    expect(body.querySelector('pre, .setup-menu, .copy-btn')).toBeNull()
    expect(body.textContent).not.toMatch(/Everything lands in|Advanced ·/)
    const note = document.getElementById('hub-settings-note')
    expect(note?.textContent).toBe('Settings for this Inbox are changed on MBP itself.')
    expect(body.lastElementChild).toBe(note)
    // the page's own preferences (theme, sort, motion and the rest) stay
    expect(body.querySelectorAll('.setup-block').length).toBeGreaterThan(0)
  })

  it('calls no route the remote entry refuses, through a full page start', async () => {
    hubDesk('MBP')
    const { requests, interceptFetch } = recorder()
    await bootApp(seed(), { interceptFetch })
    await walk()
    expect(requests.length).toBeGreaterThan(5)
    expect(requests.filter((request) => REFUSED.test(request.split(' ')[1]!))).toEqual([])
    // and, stronger, every request is one the remote entry serves
    expect(requests.filter((request) => {
      const [method, path] = request.split(' ') as [string, string]
      return !remoteRouteAllowed(method, path)
    })).toEqual([])
  })

  it('says “Reconnecting to <label>…” while retrying, and drops it once online again', async () => {
    const desk = hubDesk('MBP')
    await bootApp(seed())
    expect(visible(reconnecting())).toBe(false)
    desk.set({ state: 'retrying' })
    await settle()
    expect(visible(reconnecting())).toBe(true)
    expect(reconnecting()?.textContent).toBe('Reconnecting to MBP…')
    desk.set({ state: 'online' })
    await settle()
    expect(visible(reconnecting())).toBe(false)
  })

  it('shows the line at start when the hub is already retrying', async () => {
    hubDesk('MBP', 'retrying')
    await bootApp(seed())
    expect(reconnecting()?.textContent).toBe('Reconnecting to MBP…')
    expect(visible(reconnecting())).toBe(true)
  })

  it('leaves the error state by itself: requests refused while retrying, then answered again', async () => {
    const desk = hubDesk('MBP')
    let refusing = false
    await bootApp(seed(), {
      interceptFetch: async (input, _init, next) => (refusing && String(input).startsWith('/api/') ? new Response('Forbidden', { status: 403 }) : next()),
    })
    expect(document.querySelector('.brand-copy small')?.textContent).toBe('MBP’s Inbox')
    expectConsoleError(/HTTP 403/)
    // the header is held back while retrying, so the hub answers bare 403s
    desk.set({ state: 'retrying' })
    refusing = true
    await pollTick()
    await settle()
    expect(reconnecting()?.textContent).toBe('Reconnecting to MBP…')
    // the line says what is happening; the page's own “disconnected” is not shown beside it
    expect(document.body.classList.contains('hub-reconnecting')).toBe(true)
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'style.css'), 'utf8')
    expect(css).toContain('\nbody.hub-reconnecting #status { display: none; }\n')
    // back online: the next poll paints, and nothing of the outage is left
    refusing = false
    desk.set({ state: 'online' })
    await pollTick()
    await settle()
    expect(visible(reconnecting())).toBe(false)
    expect(document.body.classList.contains('hub-reconnecting')).toBe(false)
    expect(document.getElementById('status')?.textContent).toBe('')
  })

  it('stays in hub mode when the bridge answers null (main refused): the label is not needed to restrict the page', async () => {
    const desk = hubDesk('MBP')
    desk.connection.mockResolvedValue(null as unknown as DeskAnswer)
    const { requests, interceptFetch } = recorder()
    await bootApp(seed(), { interceptFetch })
    await walk()
    expect(requests.filter((request) => REFUSED.test(request.split(' ')[1]!))).toEqual([])
    expect(brandLine()).toBe('Another Mac’s Inbox')
  })
})

describe('the sidebar line while the mode is not known yet', () => {
  it('is blank until the desk answers, then names the other Mac’s Inbox', async () => {
    const desk = hubDesk('MBP')
    let answer!: (value: DeskAnswer) => void
    desk.connection.mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    await bootApp(seed())
    expect(brandLine()).toBe('')
    answer({ mode: 'hub', label: 'MBP', state: 'online', version: null })
    await settle()
    expect(brandLine()).toBe('MBP’s Inbox')
  })

  it('is blank until the desk answers, then “Local workspace” again in this app’s own window', async () => {
    let answer!: (value: unknown) => void
    Object.defineProperty(window, 'agentInboxDesk', {
      configurable: true,
      value: { connection: () => new Promise((resolve) => { answer = resolve }), onConnection: () => () => {} },
    })
    await bootApp(seed())
    expect(brandLine()).toBe('')
    answer({ mode: 'local' })
    await settle()
    expect(brandLine()).toBe('Local workspace')
  })
})

describe('hub mode never turns back', () => {
  it('a later { mode: "local" } changes nothing: the line stays and no refused route is called', async () => {
    const desk = hubDesk('MBP')
    const { requests, interceptFetch } = recorder()
    await bootApp(seed(), { interceptFetch })
    desk.emit({ mode: 'local' })
    await settle()
    expect(brandLine()).toBe('MBP’s Inbox')
    await walk()
    expect(requests.filter((request) => REFUSED.test(request.split(' ')[1]!))).toEqual([])
    expect(document.getElementById('hub-settings-note')?.textContent).toBe('Settings for this Inbox are changed on MBP itself.')
  })
})

describe('the page in this app’s own window (mode local)', () => {
  it('keeps the sidebar line and draws no hub line', async () => {
    Object.defineProperty(window, 'agentInboxDesk', {
      configurable: true,
      value: { available: async () => ({ open: false }), connection: async () => ({ mode: 'local' }), onConnection: () => () => {} },
    })
    await bootApp(seed())
    click(document.getElementById('gear'))
    await settle()
    expect(brandLine()).toBe('Local workspace')
    expect(document.getElementById('hub-settings-note')).toBeNull()
    expect(reconnecting()).toBeNull()
    expect(document.getElementById('link-settings')).not.toBeNull()
  })
})
