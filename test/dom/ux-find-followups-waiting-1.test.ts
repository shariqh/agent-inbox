// @vitest-environment jsdom
// Find follow-ups: a query that waits on older history, and the Note editor.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { getItem, insertItem, resolveItem } from '../../src/store.js'
import {
  advanceClock, bootApp, buttonLabelled, click, findFor, freshDb, pollTick, settle, type, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
})

const ATLAS = { project: 'atlas', stream: 'main', agent: 'claude' } as const
const LEDGER = { project: 'ledger', stream: 'main', agent: 'copilot' } as const

const field = () => document.getElementById('findQuery') as HTMLInputElement
const findRows = () => [...document.querySelectorAll<HTMLElement>('#findList > .find-row')]
const findKeys = () => findRows().map((el) => el.dataset.findKey)
const findRowEl = (key: string) => document.querySelector<HTMLElement>(`#findList > .find-row[data-find-key="${key}"]`)
const mainOf = (key: string) => findRowEl(key)?.querySelector<HTMLButtonElement>(':scope > .find-row-main') ?? null
const chip = (name: string) => document.querySelector<HTMLButtonElement>(`#find [data-find-chip="${name}"]`)
const status = () => {
  const el = document.getElementById('findStatus')!
  return el.hidden ? '' : el.textContent ?? ''
}

async function openFindTab() {
  click(document.querySelector('.tab[data-tab="find"]'))
  await settle()
}

function seedWaiting(d: Database.Database) {
  const closed: string[] = []
  for (let i = 0; i < 55; i += 1) {
    advanceClock()
    closed.push(insertItem(d, { ...ATLAS, kind: 'note', title: `Old note ${i}` }))
  }
  for (const id of closed) {
    advanceClock()
    resolveItem(d, id)
  }
  advanceClock()
  const alpha = insertItem(d, { ...LEDGER, kind: 'note', title: 'Alpha open note' })
  advanceClock()
  const zebra = insertItem(d, { ...LEDGER, kind: 'note', title: 'Zebra open note' })
  return { alpha, zebra }
}

describe('a query that waits', () => {
  it('V1: the query\'s own results stay live when the window loses focus', async () => {
    db = freshDb()
    const ids = seedWaiting(db)
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await bootApp(db)
    await openFindTab()
    field().focus()
    await findFor('zebra')
    await pollTick()
    expect(findKeys()).toEqual([`item:${ids.zebra}`])
    const list = document.getElementById('findList')!
    expect(list.hasAttribute('data-updating')).toBe(false)
    // the person switches to another app; the poll keeps running
    focus.mockReturnValue(false)
    await pollTick()
    const away = { updating: list.dataset.updating ?? null, disabled: mainOf(`item:${ids.zebra}`)?.getAttribute('aria-disabled') ?? null, status: status() }
    // they come back and click the result at once, before the next tick
    focus.mockReturnValue(true)
    click(mainOf(`item:${ids.zebra}`))
    await settle()
    const opened = Boolean(findRowEl(`item:${ids.zebra}`)?.querySelector('.find-row-body'))
    expect({ away, opened }).toEqual({ away: { updating: null, disabled: null, status: '' }, opened: true })
  })

  it('a window that was hidden reads the query again as soon as it is shown, without waiting for a tick', async () => {
    db = freshDb()
    const ids = seedWaiting(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    await bootApp(db)
    await openFindTab()
    field().focus()
    await findFor('zebra')
    await pollTick()
    const list = document.getElementById('findList')!
    expect(findKeys()).toEqual([`item:${ids.zebra}`])
    // the window is hidden: the older history is let go, and the rows on screen wait
    visibility.mockReturnValue('hidden')
    await pollTick()
    expect(list.dataset.updating).toBe('true')
    // shown again: the query is read at once
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new window.Event('visibilitychange'))
    await settle()
    await vi.advanceTimersByTimeAsync(50)
    expect({ updating: list.dataset.updating ?? null, keys: findKeys() }).toEqual({ updating: null, keys: [`item:${ids.zebra}`] })
    click(mainOf(`item:${ids.zebra}`))
    await settle()
    expect(Boolean(findRowEl(`item:${ids.zebra}`)?.querySelector('.find-row-body'))).toBe(true)
  })

  it('V2: when the history read fails, the query is drawn over what is loaded, under the failure line', async () => {
    db = freshDb()
    const ids = seedWaiting(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await bootApp(db, {
      interceptFetch: async (input, init, next) => {
        if (String(input) === '/api/items/history') return new Response('nope', { status: 500 })
        return next()
      },
    })
    await openFindTab()
    field().focus()
    await findFor('zebra')
    await pollTick()
    expect(status()).toBe('Older history is unavailable right now.')
    // the query is drawn over what is loaded: the previous list's other row is gone, and the match is live
    const keys = findKeys()
    const active = field().getAttribute('aria-activedescendant')
    const list = document.getElementById('findList')!
    expect({ keys, active, updating: list.dataset.updating ?? null }).toEqual({ keys: [`item:${ids.zebra}`], active: expect.anything(), updating: null })
    click(mainOf(`item:${ids.zebra}`))
    await settle()
    expect(Boolean(findRowEl(`item:${ids.zebra}`)?.querySelector('.find-row-body'))).toBe(true)
  })

  it('V3: a press on Note inside an open row while the list is stale does nothing, then or later', async () => {
    db = freshDb()
    const ids = seedWaiting(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    let hold = false
    await bootApp(db, {
      interceptFetch: async (input, init, next) => {
        if (String(input) === '/api/items/history' && hold) await held
        return next()
      },
    })
    await openFindTab()
    click(mainOf(`item:${ids.zebra}`))
    await settle()
    hold = true
    field().focus()
    type(field(), 'zebra')
    await vi.advanceTimersByTimeAsync(200)
    expect(document.getElementById('findList')!.dataset.updating).toBe('true')
    const body = findRowEl(`item:${ids.zebra}`)!.querySelector('.find-row-body')!
    click(buttonLabelled('Note', body))
    await settle()
    const editorNow = Boolean(findRowEl(`item:${ids.zebra}`)?.querySelector('.note-editor'))
    release()
    await settle()
    await pollTick()
    const editorLater = Boolean(findRowEl(`item:${ids.zebra}`)?.querySelector('.note-editor'))
    expect({ editorNow, editorLater }).toEqual({ editorNow: false, editorLater: false })
  })
})

describe('the Note editor on Find', () => {
  it('V4: Cmd+Enter in a row listed only because its editor holds text keeps the row in view', async () => {
    db = freshDb()
    advanceClock()
    const kept = insertItem(db, { ...ATLAS, kind: 'note', title: 'Nightly backups' })
    advanceClock()
    insertItem(db, { ...LEDGER, kind: 'note', title: 'Zebra rollout' })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await bootApp(db)
    await openFindTab()
    const k = `item:${kept}`
    click(mainOf(k))
    await settle()
    click(buttonLabelled('Note', findRowEl(k)!))
    await settle()
    type(findRowEl(k)!.querySelector<HTMLTextAreaElement>('.note-editor textarea'), 'keep me')
    // a query that misses it: the row stays listed because its editor holds text
    field().focus()
    await findFor('zebra')
    expect(findKeys()).toContain(k)
    const input = findRowEl(k)!.querySelector<HTMLTextAreaElement>('.note-editor textarea')!
    input.focus()
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }))
    await settle()
    await vi.advanceTimersByTimeAsync(50)
    expect(getItem(db, kept)?.annotation).toBe('keep me')
    expect({
      listed: findKeys().includes(k),
      focus: document.activeElement === document.body ? 'body' : 'elsewhere',
    }).toEqual({ listed: true, focus: 'elsewhere' })
  })

  it('V5: the same with the Save button (click) for comparison', async () => {
    db = freshDb()
    advanceClock()
    const kept = insertItem(db, { ...ATLAS, kind: 'note', title: 'Nightly backups' })
    advanceClock()
    insertItem(db, { ...LEDGER, kind: 'note', title: 'Zebra rollout' })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await bootApp(db)
    await openFindTab()
    const k = `item:${kept}`
    click(mainOf(k))
    await settle()
    click(buttonLabelled('Note', findRowEl(k)!))
    await settle()
    type(findRowEl(k)!.querySelector<HTMLTextAreaElement>('.note-editor textarea'), 'keep me')
    field().focus()
    await findFor('zebra')
    click(buttonLabelled('Save', findRowEl(k)!.querySelector('.note-editor')!))
    await settle()
    await vi.advanceTimersByTimeAsync(50)
    expect(findKeys().includes(k)).toBe(true)
  })

  it('V6: Cmd+Enter under another chip (Plans) on a text-held row', async () => {
    db = freshDb()
    advanceClock()
    const kept = insertItem(db, { ...ATLAS, kind: 'note', title: 'Nightly backups' })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await bootApp(db)
    await openFindTab()
    const k = `item:${kept}`
    click(mainOf(k))
    await settle()
    click(buttonLabelled('Note', findRowEl(k)!))
    await settle()
    type(findRowEl(k)!.querySelector<HTMLTextAreaElement>('.note-editor textarea'), 'keep me')
    click(chip('plans'))
    await settle()
    expect(findKeys()).toContain(k)
    const input = findRowEl(k)!.querySelector<HTMLTextAreaElement>('.note-editor textarea')!
    input.focus()
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))
    await settle()
    await vi.advanceTimersByTimeAsync(50)
    expect({ listed: findKeys().includes(k), focusOnBody: document.activeElement === document.body }).toEqual({ listed: true, focusOnBody: false })
  })
})
