// @vitest-environment jsdom
// UX pass, slice 2: one Home. The list of asks and the lanes share a page, so a key
// pressed in the lanes or the session panel must never reach across to the list's
// selected ask (before, the list was on a hidden page and had no row to act on).
// Its own file, and one test: jsdom keeps every earlier boot's document listeners
// in one file, so only a file's first test can press these keys.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { getItem, insertItem, recordActivityCall, upsertActivity } from '../../src/store.js'
import { advanceClock, bootApp, click, freshDb, row, settle, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => {
  db?.close()
  db = null
  vi.restoreAllMocks()
})

const AGENT = { project: 'atlas', stream: 'main', agent: 'copilot' } as const
const openIds = () => [...document.querySelectorAll<HTMLElement>('#needsYouList .nrow[data-open="1"]')].map((el) => el.dataset['cardId'])
const selected = () => document.querySelector<HTMLElement>('#needsYouList .nrow.selected')?.dataset['cardId'] ?? null
const press = (key: string) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))

describe('keys in the lanes and the session panel', () => {
  it('never answer, resolve, dismiss, move, open or close the list’s ask; the panel’s own ask still takes its digits', async () => {
    db = freshDb()
    for (const session of ['here', 'other']) {
      upsertActivity(db, { ...AGENT, session, doing: 'Working on it', idle: false })
      recordActivityCall(db, session)
    }
    advanceClock()
    const listAsk = insertItem(db, { ...AGENT, kind: 'question', title: 'The list’s ask', session: 'other', options: [{ label: 'Ship it' }, { label: 'Hold' }] })
    advanceClock()
    const panelAsk = insertItem(db, { ...AGENT, kind: 'question', title: 'The panel’s ask', session: 'here', options: [{ label: 'Yes' }, { label: 'No' }] })
    const bridge = await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    expect(openIds()).toEqual([listAsk])
    expect(selected()).toBe(listAsk)

    // the session's panel: the ask in front closes, the list keeps its selected row
    const card = [...document.querySelectorAll<HTMLElement>('#dashboard [data-session-card]')].find((el) => el.dataset['sessionCard'] === 'session:here')!
    click(card.querySelector('[data-ah-action]'))
    await settle()
    const panel = document.querySelector<HTMLElement>('#dashboard .dash-focus')!
    expect(panel.hidden).toBe(false)
    expect(panel.contains(document.activeElement)).toBe(true)
    expect(selected()).toBe(listAsk)
    const block = panel.querySelector<HTMLElement>(`[data-panel-ask="${panelAsk}"]`)!
    expect(block).not.toBeNull()

    // on the panel's heading: no ask is the key's target
    for (const key of ['1', 'e', 'x', 'j', 'Enter']) {
      press(key)
      await settle()
    }
    expect(getItem(db, listAsk)?.reply ?? null, 'a digit in the panel answered the list’s ask').toBeNull()
    expect(getItem(db, listAsk)?.status).toBe('open')
    expect(row(listAsk)?.classList.contains('staged'), 'X in the panel staged a dismiss of the list’s ask').toBe(false)
    expect(openIds(), 'Enter in the panel opened the list’s ask').toEqual([])
    expect(panel.hidden).toBe(false)
    expect(panel.contains(document.activeElement), 'J in the panel moved focus to the list').toBe(true)
    expect(bridge.posts.filter((post) => /\/api\/items\//.test(post.url))).toEqual([])

    // on a lane's heading (where G L lands): the same
    const heading = document.getElementById('workingLaneTitle')!
    heading.focus()
    for (const key of ['2', 'e', 'x', 'k', 'Enter']) {
      press(key)
      await settle()
    }
    expect(getItem(db, listAsk)?.reply ?? null).toBeNull()
    expect(getItem(db, listAsk)?.status).toBe('open')
    expect(openIds()).toEqual([])
    expect(document.activeElement).toBe(heading)
    expect(bridge.posts.filter((post) => /\/api\/items\//.test(post.url))).toEqual([])

    // inside the panel's own ask: E and X still do not reach the list, and a digit answers THIS ask
    block.tabIndex = -1
    block.focus()
    press('e')
    press('x')
    await settle()
    expect(getItem(db, listAsk)?.status).toBe('open')
    expect(getItem(db, panelAsk)?.status).toBe('open')
    press('1')
    await settle()
    expect(getItem(db, panelAsk)?.reply).toBe('Yes')
    expect(getItem(db, listAsk)?.reply ?? null).toBeNull()

    // with the ask in front again and focus in the lanes, Esc leaves it alone: no close, no focus
    // move, no scroll up to the list
    click(panel.querySelector('.dash-focus-close'))
    await settle()
    expect(openIds()).toEqual([listAsk])
    heading.focus()
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
    press('Escape')
    await settle()
    await vi.advanceTimersByTimeAsync(50)
    expect(openIds(), 'Esc in the lanes closed the ask in front').toEqual([listAsk])
    expect(document.activeElement).toBe(heading)
    expect(scroll).not.toHaveBeenCalled()
  })
})
