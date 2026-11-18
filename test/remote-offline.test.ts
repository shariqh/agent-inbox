// The hub view's offline page (#617, PR 3b; design §3.3 "When the hub cannot be reached"):
// electron/remote-offline.html, its script and its stylesheet, shipped with the app and shown in
// the hub view when the hub cannot be reached or refuses this Mac. It gets its words only through
// `agentInboxDesk`, sets the hub's label as text, has a strict Content-Security-Policy, loads
// nothing remote and follows the system's light and dark colours. Run here in jsdom with a fake
// bridge.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// jsdom ships no types here; the one constructor this file uses, typed by hand
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: { runScripts: 'outside-only'; url: string }) => { window: unknown }
}

const ELECTRON = join(import.meta.dirname, '..', 'electron')
const html = readFileSync(join(ELECTRON, 'remote-offline.html'), 'utf8')
const script = readFileSync(join(ELECTRON, 'remote-offline.js'), 'utf8')
const css = readFileSync(join(ELECTRON, 'remote-offline.css'), 'utf8')

type Connection = { mode: 'hub'; label: string; state: 'online' | 'retrying' | 'refused'; version: string | null } | null

const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)) }

function page(first: Connection, options: { desk?: boolean } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'file:///Applications/Agent%20Inbox.app/electron/remote-offline.html' })
  const window = dom.window as unknown as Window & { eval(code: string): unknown; agentInboxDesk?: unknown }
  let listener: ((value: Connection) => void) | null = null
  const desk = {
    available: vi.fn(async () => ({ open: false })),
    connection: vi.fn(async () => first),
    onConnection: vi.fn((callback: (value: Connection) => void) => { listener = callback; return () => {} }),
    retry: vi.fn(async () => ({ ok: true })),
  }
  if (options.desk !== false) window.agentInboxDesk = desk
  window.eval(script)
  const $ = (id: string) => window.document.getElementById(id)!
  return { window, desk, $, change: (value: Connection) => listener?.(value) }
}

const hub = (state: 'online' | 'retrying' | 'refused', label = 'studio'): Connection => ({ mode: 'hub', label, state, version: '2.12.0' })

describe('remote-offline.html', () => {
  it('says the hub cannot be reached, with Retry, and Retry asks the bridge', async () => {
    const p = page(hub('retrying'))
    await settle()
    expect(p.$('title').textContent).toBe('Can’t reach studio')
    expect(p.$('retry').hidden).toBe(false)
    ;(p.$('retry') as HTMLButtonElement).click()
    expect(p.desk.retry).toHaveBeenCalledTimes(1)
  })

  it('says the hub no longer accepts this Mac when refused, with the plain way back and no Retry', async () => {
    const p = page(hub('refused'))
    await settle()
    expect(p.$('title').textContent).toBe('studio no longer accepts this Mac')
    expect(p.$('detail').textContent).toContain('pair this Mac again in Settings on This Mac')
    expect(p.$('retry').hidden).toBe(true)
  })

  it('follows each change the bridge reports', async () => {
    const p = page(hub('retrying'))
    await settle()
    p.change(hub('refused', 'desk'))
    expect(p.$('title').textContent).toBe('desk no longer accepts this Mac')
    p.change(hub('retrying', 'desk'))
    expect(p.$('title').textContent).toBe('Can’t reach desk')
  })

  it('sets the label as text: markup in it stays text', async () => {
    const p = page(hub('retrying', '<img src=x onerror=alert(1)>'))
    await settle()
    expect(p.$('title').textContent).toBe('Can’t reach <img src=x onerror=alert(1)>')
    expect(p.window.document.querySelectorAll('img')).toHaveLength(0)
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/)
  })

  it('still says something with no bridge or no answer', async () => {
    const none = page(null, { desk: false })
    await settle()
    expect(none.$('title').textContent).toBe('Can’t reach the other Mac')
    const empty = page(null)
    await settle()
    expect(empty.$('title').textContent).toBe('Can’t reach the other Mac')
  })

  it('has a strict Content-Security-Policy and no inline script or style', () => {
    const p = page(hub('retrying'))
    const doc = p.window.document
    const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? ''
    expect(csp.split(';').map((part) => part.trim()).filter(Boolean)).toEqual([
      "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'none'", "connect-src 'none'", "font-src 'none'",
      "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
    ])
    expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')).toBe(doc.head.firstElementChild?.nextElementSibling ?? null)
    for (const node of doc.querySelectorAll('script')) expect(node.textContent?.trim()).toBe('')
    expect(doc.querySelectorAll('style')).toHaveLength(0)
    expect(html).not.toMatch(/\son[a-z]+=/i)
    expect(html).not.toMatch(/style=/i)
  })

  it('loads nothing remote: every resource is a file beside it', () => {
    const p = page(hub('retrying'))
    const doc = p.window.document
    const sources = [...doc.querySelectorAll('[src], [href]')].map((node) => node.getAttribute('src') ?? node.getAttribute('href'))
    expect(sources.sort()).toEqual(['remote-offline.css', 'remote-offline.js'])
    expect(css).not.toMatch(/url\(|@import/)
    expect(script).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|EventSource|import\(|sendBeacon/)
  })

  it('uses only agentInboxDesk, and follows light and dark only through prefers-color-scheme', () => {
    expect([...new Set(script.match(/agentInbox[A-Za-z]*/g))]).toEqual(['agentInboxDesk'])
    expect(script).not.toMatch(/\brequire\(|ipcRenderer|process\./)
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)/)
    expect(css).not.toMatch(/data-theme|var\(--theme/)
  })
})
