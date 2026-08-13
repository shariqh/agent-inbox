// test/dom/harness.ts
// The one place that knows how to boot the real viewer frontend inside jsdom.
//
// Deliberately NOT named *.test.ts — vitest's include glob is `test/**/*.test.ts`,
// so this file is imported, never collected.
//
// How it works, and why:
//  - `public/app.js` is imported UNMODIFIED, top-level side effects and all. The
//    browser's absolute `/x.js` specifiers are rewritten onto `<repo>/public/x.js`
//    by the `resolve.alias` entry in vitest.config.ts, so `public/` keeps a ZERO-line
//    diff and the browser/Electron keep resolving `/x.js` from their own root.
//    jsdom cannot execute `<script type="module">` at all (that conclusion in the
//    older test comments was correct) — importing the module graph directly is the
//    way in.
//  - Data comes from a REAL temp SQLite DB through the REAL Hono app: `globalThis.fetch`
//    is bridged onto `createViewer(db).request()`. No port is opened, no store is mocked.
//  - Fake timers turn the 3s poll into `await pollTick()`.
//
// READ THE BLIND-SPOT LIST in CLAUDE.md ("DOM harness — what it can and cannot see")
// before trusting a passing assertion. In particular: `@media` never matches,
// `var()` is never resolved, and window/document listeners accumulate across boots
// within one file.
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'
import { openDb } from '../../src/store.js'
import { createViewer } from '../../src/viewer.js'
import type { ViewerOpts } from '../../src/viewer.js'

// NOT `new URL('../../public/x', import.meta.url)`. The rest of test/ uses that form
// happily, but those files run in the NODE environment (ssr transform mode). A jsdom
// file runs in WEB transform mode, where Vite's asset plugin rewrites the literal
// `new URL(…, import.meta.url)` pattern into `http://localhost:3000/@fs/…` — and
// readFileSync then dies with "The URL must be of scheme file". Resolve through
// node:path instead; `import.meta.url` itself is still a plain file: URL.
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public')
const readPublic = (name: string): string => readFileSync(join(PUBLIC_DIR, name), 'utf8')

// ── fixtures ────────────────────────────────────────────────────────────────

/** A real, empty, throwaway SQLite DB. Seed it through `src/store.ts` exports only. */
export function freshDb(): Database.Database {
  return openDb(join(mkdtempSync(join(tmpdir(), 'inbox-dom-')), 'inbox.db'))
}

/**
 * The frozen wall clock every DOM test starts at.
 *
 * `vi.useFakeTimers()` fakes `Date`, so EVERY row seeded inside a test shares one
 * `created_at` unless the clock is moved. That silently breaks anything that depends
 * on ordering (`listItems`' `ORDER BY created_at DESC`, `buildDeck`'s sort,
 * `sortNeedsYou`'s age tiebreak) and, worse, `seenWatermark` — whose whole job is
 * comparing stamps. Call `advanceClock()` between fixture writes.
 */
export const T0 = Date.parse('2026-07-20T10:00:00.000Z')

/** Move the frozen clock forward. Use it BETWEEN fixture writes so stamps differ. */
export function advanceClock(ms = 1000): void {
  vi.setSystemTime(Date.now() + ms)
}

// ── the viewer bridge ───────────────────────────────────────────────────────

export interface PostRecord {
  url: string
  init: RequestInit | undefined
}

export interface ViewerBridge {
  /** Every POST the app made, in order — url + the exact init it passed to fetch(). */
  posts: PostRecord[]
  /** Make every subsequent POST return this HTTP status instead of hitting the app. */
  failPostsWith(status: number | null): void
  /**
   * Let a parked payload through. Only meaningful after `bootApp(db, { holdFetch: true })`;
   * a no-op otherwise. Call it in the test, not in teardown — the point of holding is
   * to prove the app RECOVERS when the data finally lands, not merely that it survives.
   */
  releaseFetch(): void
}

export interface BootOptions {
  /**
   * Boot with the first payload STILL IN FLIGHT — every fetch parks until
   * `bridge.releaseFetch()`.
   *
   * This is the only way to reach the window between "the shell is interactive" and
   * "`lastData` exists". app.js calls `load()` at module top level and does NOT await
   * it, so every listener `initSearch`/`initTabs`/`initKeys` wired a moment earlier is
   * already live while the payload is in the air — and a handler that renders in that
   * window has no data to render. Fake timers cannot model it on their own:
   * `advanceTimersByTime*` flushes microtasks first, so the load always wins the race.
   */
  holdFetch?: boolean
  /**
   * Options for the real `createViewer(db, …)` behind the bridge.
   *
   * Only `#40`'s build stamp uses it today, and it must: the default probe SPAWNS
   * GIT, and a real child process does not resolve inside `advanceTimersByTimeAsync`.
   * Inject a plain object and `/api/setup` is deterministic.
   */
  viewer?: ViewerOpts
}

/**
 * Bridge `globalThis.fetch` onto the real Hono app. `.request()` returns a real
 * Response and preserves the `x-inbox-boot` header, so nothing listens on a port.
 * The bridge is `async` on purpose: Hono types `.request()` as
 * `Response | Promise<Response>`, which is not assignable to `fetch` directly.
 */
export function mountViewer(db: Database.Database, { holdFetch = false, viewer }: BootOptions = {}): ViewerBridge {
  const app = createViewer(db, viewer)
  const posts: PostRecord[] = []
  let failStatus: number | null = null
  let release: (() => void) | null = null
  let parked: Promise<void> | null = holdFetch ? new Promise<void>((r) => { release = r }) : null
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (init?.method === 'POST') {
      posts.push({ url, init })
      if (failStatus !== null) return new Response('boom', { status: failStatus })
    }
    if (parked) await parked
    return await app.request(url, init)
  }
  return {
    posts,
    failPostsWith(status: number | null) { failStatus = status },
    releaseFetch() { release?.(); release = null; parked = null },
  }
}

// ── the four jsdom gaps ─────────────────────────────────────────────────────
// Without every one of these, app.js throws inside render() and load()'s catch
// swallows it — which presents as "nothing rendered", not as an error.

interface MediaStub {
  media: string
  matches: boolean
  listeners: Array<(e: { matches: boolean; media: string }) => void>
  addEventListener(type: string, fn: (e: { matches: boolean; media: string }) => void): void
  removeEventListener(type: string, fn: (e: { matches: boolean; media: string }) => void): void
}

const mediaStubs = new Map<string, MediaStub>()

function mediaMatches(query: string): boolean {
  if (/prefers-color-scheme:\s*dark/.test(query)) return false // the harness is always the light theme
  const max = /max-width:\s*(\d+)px/.exec(query)
  if (max?.[1]) return window.innerWidth <= Number(max[1])
  const min = /min-width:\s*(\d+)px/.exec(query)
  if (min?.[1]) return window.innerWidth >= Number(min[1])
  return false
}

// The CSSOM `CSS.escape` algorithm. jsdom exposes no `CSS` namespace at all, and
// app.js calls CSS.escape in six places (incl. setRailMatch, which runs on every
// render) — a missing one presents as a completely blank page.
function cssEscape(value: unknown): string {
  const str = String(value)
  let out = ''
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    if (c === 0) { out += '�'; continue }
    const digit = c >= 0x30 && c <= 0x39
    if ((c >= 0x01 && c <= 0x1f) || c === 0x7f
      || (i === 0 && digit)
      || (i === 1 && digit && str.charCodeAt(0) === 0x2d)) {
      out += `\\${c.toString(16)} `
      continue
    }
    if (i === 0 && c === 0x2d && str.length === 1) { out += `\\${str[i]}`; continue }
    if (c >= 0x80 || c === 0x2d || c === 0x5f || digit
      || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) {
      out += str[i]
      continue
    }
    out += `\\${str[i]}`
  }
  return out
}

function installStubs(): void {
  // 1 · uFuzzy — a vendored IIFE browser global. The file is `var uFuzzy = …`, so a
  //     bare `new Function(src)` does NOT attach it; the trailing `return` does.
  //     app.js evaluates `new window.uFuzzy(...)` at module top level, so this must
  //     exist BEFORE the import or the import itself throws.
  const src = readPublic('ufuzzy.iife.min.js')
  const ctor: unknown = new Function(`${src}; return uFuzzy`)()
  ;(window as unknown as Record<string, unknown>)['uFuzzy'] = ctor

  // 2 · matchMedia — jsdom has none. app.js uses it for themeName() (every render,
  //     via pcolor) and initResponsive(). The stub object per query is STABLE so
  //     setViewport() can mutate `matches` and fire the listener initResponsive
  //     registered, instead of swapping in a new object the listener isn't on.
  window.matchMedia = ((query: string) => {
    let stub = mediaStubs.get(query)
    if (!stub) {
      stub = {
        media: query,
        matches: mediaMatches(query),
        listeners: [],
        addEventListener(_type, fn) { this.listeners.push(fn) },
        removeEventListener(_type, fn) {
          const i = this.listeners.indexOf(fn)
          if (i >= 0) this.listeners.splice(i, 1)
        },
      }
      mediaStubs.set(query, stub)
    }
    stub.matches = mediaMatches(query)
    return stub
  }) as unknown as typeof window.matchMedia

  // 3 · scrollIntoView — jsdom does not implement it; focusItem calls it inside rAF.
  Element.prototype.scrollIntoView = function scrollIntoView() { /* layout is out of scope */ }

  // 4 · CSS.escape
  ;(globalThis as unknown as Record<string, unknown>)['CSS'] = { escape: cssEscape }
}

/**
 * Change the viewport BEFORE `bootApp()`.
 *
 * `layout` is read at app.js module top level and `initResponsive` registers its
 * `change` listener on ONE media-query object. Calling this after boot mutates the
 * same stub and fires that listener, but the top-level `layoutMode(window.innerWidth)`
 * read has already happened — so pre-boot is the only ordering that tests what you think.
 */
export function setViewport(mode: 'narrow' | 'wide'): void {
  const width = mode === 'narrow' ? 720 : 1400
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true })
  for (const stub of mediaStubs.values()) {
    const next = mediaMatches(stub.media)
    if (next === stub.matches) continue
    stub.matches = next
    for (const fn of [...stub.listeners]) fn({ matches: next, media: stub.media })
  }
}

// ── mounting ────────────────────────────────────────────────────────────────

function mountShell(): void {
  const html = readPublic('index.html')
  const body = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'))
  // The <script> tags come along with the slice and parse into real (inert) elements.
  // They must go, or every "no injected <script> anywhere" assertion starts at 2.
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, '')
}

// A non-literal specifier is REQUIRED: a literal `import('/app.js')` fails
// `npm run typecheck` with TS2307 (tsc resolves it as a path, vite does not).
const APP_MODULE = '/app.js'

/**
 * Bridge fetch → install the four stubs → mount the shell → import app.js.
 *
 * That order is load-bearing (uFuzzy is constructed at module top level, and
 * every init function queries the shell), so it lives here rather than in tests.
 */
export async function bootApp(db: Database.Database, opts: BootOptions = {}): Promise<ViewerBridge> {
  const bridge = mountViewer(db, opts)
  installStubs()
  mountShell()
  await import(/* @vite-ignore */ APP_MODULE)
  await settle()
  return bridge
}

// ── lifecycle ───────────────────────────────────────────────────────────────

const consoleErrors: string[] = []
const allowedErrors: RegExp[] = []

/**
 * Allowlist a console.error this test provokes ON PURPOSE (e.g. a forced HTTP 500),
 * and assert it actually happened. Anything not allowlisted fails the test in afterEach.
 *
 * This guard is load-bearing, not cosmetic: `load()`'s catch swallows every throw out
 * of `render()`, so without it a broken render presents as "nothing rendered".
 */
export function expectConsoleError(pattern: RegExp): void {
  allowedErrors.push(pattern)
}

/**
 * Install the per-test lifecycle. Call it once at the top of a DOM test file.
 *
 * beforeEach: reset the hash, reset the module registry (MANDATORY — without it the
 * second test in a file re-uses the first test's already-evaluated app.js and finds
 * zero rows), clear browser storage, spy on console.error, freeze the clock at T0.
 * afterEach: drain in-flight work, restore real timers (which is what kills app.js's
 * module-level `setInterval(load, 3000)`), then assert the console.error contract.
 */
export function useDomTest(): void {
  beforeEach(() => {
    // jsdom's window/location live for the whole FILE, not the test: a hash left by
    // an earlier test would deep-link the next boot before its own assertions run.
    location.hash = ''
    mediaStubs.clear()
    Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true, writable: true })
    vi.resetModules()
    localStorage.clear()
    sessionStorage.clear()
    consoleErrors.length = 0
    allowedErrors.length = 0
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : String(a))).join(' '))
    })
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'setImmediate',
        'clearImmediate',
        'Date',
        'requestAnimationFrame',
        'cancelAnimationFrame',
      ],
    })
    vi.setSystemTime(T0)
  })

  afterEach(async () => {
    // let anything already in flight settle against THIS test's fetch bridge rather
    // than resolving into the next test's DOM
    await vi.advanceTimersByTimeAsync(0)
    vi.useRealTimers()
    vi.restoreAllMocks()
    const unexpected = consoleErrors.filter((e) => !allowedErrors.some((re) => re.test(e)))
    expect(unexpected, 'unexpected console.error — load() swallows render() throws, so this is the only signal').toEqual([])
    for (const re of allowedErrors) {
      expect(consoleErrors.some((e) => re.test(e)), `expected a console.error matching ${re}, got: ${JSON.stringify(consoleErrors)}`).toBe(true)
    }
  })
}

/** Flush microtasks first, then timers and one jsdom rAF frame within 20ms. */
export async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
  const startedAt = Date.now()
  vi.advanceTimersToNextFrame()
  await vi.advanceTimersByTimeAsync(Math.max(0, 20 - (Date.now() - startedAt)))
}

/**
 * Run one 3s poll cycle.
 *
 * NOTE: a successful poll ends with `#status` cleared, so anything asserting on
 * `#status` (e.g. `write failed (500)`) must read it after `settle()` only.
 */
export async function pollTick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(3000)
}

// ── stale-node-safe DOM accessors ───────────────────────────────────────────
// render() rebuilds every `.nrow` from scratch, so NEVER store an Element across
// an `await`. These re-query on every call; `click()` refuses a detached node.

export function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('#needsYouList .nrow[data-card-id]')]
}

export function row(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#needsYouList .nrow[data-card-id="${cssEscape(id)}"]`)
}

export function rowTitles(): string[] {
  return rows().map((el) => el.querySelector('.nrow-title')?.textContent ?? '')
}

/** The visible number beside a tab label ('' when the count badge is hidden). */
export function tabCount(tab: string): string {
  const el = document.querySelector<HTMLElement>(`.tab[data-tab="${tab}"] .tab-count`)
  if (!el || el.hidden) return ''
  return el.textContent ?? ''
}

/** The document-title badge as a number — 0 when the title carries no badge. */
export function badgeCount(): number {
  const m = /^\((\d+)\)\s/.exec(document.title)
  return m?.[1] ? Number(m[1]) : 0
}

/** The open accordion card's free-text answer input (NOT the context input beside it). */
export function answerInput(id?: string): HTMLInputElement | null {
  const scope = id ? `.nrow[data-card-id="${cssEscape(id)}"] ` : ''
  return document.querySelector<HTMLInputElement>(`${scope}.nrow-card .reply-input:not(.reply-context-input)`)
}

/** The open accordion card's Send button — `btn('Send', …)` carries no class of its own. */
export function sendButton(id?: string): HTMLButtonElement | null {
  const scope = id ? `.nrow[data-card-id="${cssEscape(id)}"] ` : ''
  return [...document.querySelectorAll<HTMLButtonElement>(`${scope}.nrow-card .reply-row button`)]
    .find((b) => b.textContent === 'Send') ?? null
}

/** Find a button anywhere in the document by its exact label. */
export function buttonLabelled(label: string, scope: ParentNode = document): HTMLButtonElement | null {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label) ?? null
}

/** Click a node, refusing one that a re-render has already replaced. */
export function click(el: Element | null | undefined): void {
  if (!el) throw new Error('click(): nothing to click — the selector matched nothing')
  if (!document.contains(el)) throw new Error('click(): stale node — re-query after every render/await')
  ;(el as HTMLElement).click()
}

/** Set an input's value and fire the bubbling `input` event app.js listens for. */
export function type(el: HTMLInputElement | null | undefined, value: string): void {
  if (!el) throw new Error('type(): nothing to type into — the selector matched nothing')
  if (!document.contains(el)) throw new Error('type(): stale node — re-query after every render/await')
  el.value = value
  el.dispatchEvent(new window.Event('input', { bubbles: true }))
}

/** Type into #search and advance past initSearch()'s 120ms debounce. */
export async function searchFor(query: string): Promise<void> {
  const input = document.getElementById('search') as HTMLInputElement | null
  type(input, query)
  await vi.advanceTimersByTimeAsync(200)
}

/** Drive the real hashchange → applyFocusHash → focusItem path. */
export function navigateToHash(hash: string): void {
  location.hash = hash
  window.dispatchEvent(new window.HashChangeEvent('hashchange'))
}

/**
 * Attach public/style.css as a real <style> (a <link> never loads in jsdom).
 *
 * Only literal lengths and keywords are trustworthy afterwards — see the blind-spot
 * list in CLAUDE.md.
 */
export function attachStylesheet(): void {
  const css = readPublic('style.css')
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
}
