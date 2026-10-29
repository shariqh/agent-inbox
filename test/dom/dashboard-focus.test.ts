// @vitest-environment jsdom
// Dashboard 2.0 phase 5 (#307): command-center polish. The lanes' quick
// filters, the Dashboard keys in the keyboard help, the session focus panel
// (read-only, updated in place, never pulling focus in a background window)
// and the ⌘K actions, which route through focusItem and the deep-link path.
// None of it reaches attention: PR and CI chips in the panel included.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, recordActivityCall, resolveItem, upsertActivity, upsertBoard, upsertSourceLink } from '../../src/store.js'
import {
  advanceClock, badgeCount, bootApp, click, freshDb, pollTick, row, searchFor, settle, tabCount, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null; vi.restoreAllMocks() })

const REPO = 'shariqh/agent-inbox'
const A = { project: 'alpha', stream: '307-polish', agent: 'copilot' } as const
const route = (input: RequestInfo | URL): string => String(input).split('?')[0]!

function open(): Database.Database {
  db = freshDb()
  return db
}

function work(d: Database.Database, session: string, what: string, extra: Record<string, unknown> = {}): void {
  upsertActivity(d, { ...A, session, doing: what, idle: false, ...extra })
  recordActivityCall(d, session)
  upsertActivity(d, { ...A, session, doing: what, idle: false, ...extra })
}

const lane = (session: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`#dashboard .dash-lane[data-lane="${session}"]`)
const laneIds = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('#dashboard .dash-lane')].map((el) => el.dataset.lane!)
const openButton = (session: string) => lane(session)?.querySelector<HTMLButtonElement>('.dash-lane-open') ?? null
const panel = () => document.querySelector<HTMLElement>('#dashboard .dash-focus')
const railIds = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('#dashRail [data-rail-card]')].map((card) => card.dataset.railCard!)
const signal = (name: string): string =>
  document.querySelector(`[data-dashboard-signal="${name}"] .dashboard-value`)?.textContent ?? ''

function pick(name: 'project' | 'agent', value: string): void {
  const select = document.querySelector<HTMLSelectElement>(`#dashboard [data-lane-filter="${name}"]`)!
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

function keydown(target: Element, key: string): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

/** Everything attention is counted from, read off the page and the dock's own route. */
async function attentionSurfaces() {
  const dock = await fetch('/api/items?scope=attention')
  const plans = await fetch('/api/boards?scope=attention')
  return {
    title: document.title,
    badge: badgeCount(),
    tabs: ['needsYou', 'notes', 'boards', 'done'].map(tabCount),
    rail: railIds(),
    waiting: signal('waiting'),
    dock: [await dock.text(), await plans.text()],
  }
}

describe('quick filters on lanes (#307)', () => {
  it('narrow only the lanes, never the Now strip, the rail or attention', async () => {
    const d = open()
    work(d, 'a', 'Alpha work')
    work(d, 'b', 'Beta work', { project: 'beta', agent: 'claude-code' })
    work(d, 'c', 'More alpha', { agent: 'claude-code' })
    insertItem(d, { ...A, kind: 'question', title: 'Alpha ask', session: 'a' })
    insertItem(d, { ...A, project: 'beta', kind: 'question', title: 'Beta ask', session: 'b' })
    await bootApp(d)
    const before = await attentionSurfaces()
    const working = signal('agents')
    expect(laneIds().sort()).toEqual(['a', 'b', 'c'])

    pick('project', 'alpha')
    expect(laneIds().sort()).toEqual(['a', 'c'])
    pick('agent', 'claude-code')
    expect(laneIds()).toEqual(['c'])
    await pollTick()
    expect(laneIds()).toEqual(['c'])
    expect(signal('agents')).toBe(working)
    expect(await attentionSurfaces()).toEqual(before)

    pick('agent', 'copilot')
    expect(laneIds()).toEqual(['a'])
    pick('project', 'beta')
    expect(laneIds()).toEqual([])
    expect(document.querySelector<HTMLElement>('.dash-lanes-none')?.hidden).toBe(false)
    pick('project', '')
    pick('agent', '')
    expect(laneIds().sort()).toEqual(['a', 'b', 'c'])
    expect(document.querySelector<HTMLElement>('.dash-lanes-none')?.hidden).toBe(true)
  })
})

describe('keyboard help (#307)', () => {
  it('lists the Dashboard keys', async () => {
    const d = open()
    await bootApp(d)
    click(document.getElementById('keyboardHelp'))
    const section = [...document.querySelectorAll('#keyboardbox .keyboard-groups section')]
      .find((el) => el.querySelector('h3')?.textContent === 'Dashboard')
    expect(section).toBeTruthy()
    const keys = [...section!.querySelectorAll('kbd')].map((kbd) => kbd.textContent)
    expect(keys).toEqual(['J / K', '1-4', 'S', 'P', 'Enter', 'Esc'])
    expect(section!.textContent).toContain('session focus panel')
  })
})

describe('the session focus panel (#307)', () => {
  function seed(d: Database.Database): { ask: string; board: string } {
    const board = upsertBoard(d, {
      ...A, repo: REPO, title: 'Polish plan', session: 'mine',
      rows: [{ label: 'Filters', status: 'done', outcome: 'Shipped the filters' }, { label: 'Panel', status: 'partial' }],
    }).boardId
    work(d, 'mine', 'Painting the panel', { detail: 'jsdom first' })
    work(d, 'theirs', 'Elsewhere', { project: 'beta' })
    const ask = insertItem(d, {
      ...A, repo: REPO, kind: 'question', title: 'Which panel width?', session: 'mine',
      detail: 'Spec at https://example.com/panel-spec and see #301.',
    })
    const done = insertItem(d, { ...A, kind: 'note', title: 'Earlier step', session: 'mine' })
    advanceClock()
    resolveItem(d, done, 'Recorded the lane model')
    return { ask, board }
  }

  it("opens with the session's asks, plan, outcomes and links, and Escape returns to the lane", async () => {
    const d = open()
    const { ask } = seed(d)
    upsertSourceLink(d, {
      repo: REPO, branch: '307-polish', pr_number: 400, pr_state: 'OPEN', pr_title: 'Polish', checks: 'failing',
      pr_url: 'https://github.com/shariqh/agent-inbox/pull/400',
    })
    await bootApp(d)
    expect(panel()?.hidden).toBe(true)

    const button = openButton('mine')!
    button.focus()
    click(button)
    const aside = panel()!
    expect(aside.hidden).toBe(false)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(aside.querySelector('#dashFocusTitle'))
    expect(aside.querySelector('.dash-focus-doing')?.textContent).toBe('Painting the panel')
    expect([...aside.querySelectorAll('.dash-focus-ask-title')].map((el) => el.textContent)).toEqual(['Which panel width?'])
    // read-only: it jumps to the rail, it never draws an editor or an option
    expect(aside.querySelector('textarea, .opt-pill')).toBeNull()
    expect(aside.querySelector(`[data-focus-ask="item:${ask}"]`)?.textContent).toBe('Answer in rail')
    expect(aside.querySelector('.dash-focus-plan-title')?.textContent).toBe('Polish plan')
    expect([...aside.querySelectorAll('.dash-focus-outcome strong')].map((el) => el.textContent))
      .toEqual(['Earlier step', 'Filters'])
    expect(aside.querySelector('.dash-focus-source .src-chip.tone-bad')?.textContent).toContain('checks failing')
    expect([...aside.querySelectorAll('.card-links [data-link-kind]')].map((el) => el.getAttribute('href')))
      .toContain('https://example.com/panel-spec')

    keydown(aside.querySelector('#dashFocusTitle')!, 'Escape')
    expect(aside.hidden).toBe(true)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(openButton('mine'))
  })

  it('jumps from an ask to its rail card, and from the plan through the deep link', async () => {
    const d = open()
    const { ask, board } = seed(d)
    await bootApp(d)
    click(openButton('mine'))
    click(panel()!.querySelector(`[data-focus-ask="item:${ask}"]`))
    expect(document.activeElement).toBe(document.querySelector(`#dashRail [data-rail-card="${ask}"]`))
    // the panel sits over the rail: it closed before the jump
    expect(panel()!.hidden).toBe(true)

    click(openButton('mine'))
    click(panel()!.querySelector('.dash-focus-plan-open'))
    await settle()
    expect(location.hash).toBe(`#item/${board}`)
    expect(document.getElementById('boards')?.hidden).toBe(false)
  })

  it('opens and closes without pulling focus in a background window', async () => {
    const d = open()
    seed(d)
    await bootApp(d)
    const button = openButton('mine')!
    button.focus()
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    button.dispatchEvent(new FocusEvent('blur'))
    button.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')

    click(button)
    expect(panel()!.hidden).toBe(false)
    work(d, 'mine', 'Still painting')
    await pollTick()
    expect(panel()!.querySelector('.dash-focus-doing')?.textContent).toBe('Still painting')
    click(panel()!.querySelector('.dash-focus-close'))
    expect(panel()!.hidden).toBe(true)
    expect(focus).not.toHaveBeenCalled()
  })

  it('updates in place across polls and writes nothing when nothing changed', async () => {
    const d = open()
    seed(d)
    await bootApp(d)
    click(openButton('mine'))
    const aside = panel()!
    const asks = aside.querySelector('.dash-focus-asks')!
    const askNode = asks.firstElementChild
    const mutations: MutationRecord[] = []
    const observer = new MutationObserver((records) => mutations.push(...records))
    observer.observe(aside, { subtree: true, childList: true, characterData: true, attributes: true })
    await pollTick()
    insertItem(d, { project: 'gamma', stream: 'main', agent: 'claude', kind: 'note', title: 'Unrelated' })
    await pollTick()
    observer.disconnect()
    expect(mutations).toEqual([])

    advanceClock()
    work(d, 'mine', 'Polishing the panel')
    await pollTick()
    expect(panel()).toBe(aside)
    expect(aside.querySelector('.dash-focus-asks')).toBe(asks)
    expect(asks.firstElementChild).toBe(askNode)
    expect(aside.querySelector('.dash-focus-doing')?.textContent).toBe('Polishing the panel')

    // the session stops working: the panel says so and keeps its close button
    upsertActivity(d, { ...A, session: 'mine', doing: 'open', idle: true })
    await pollTick()
    expect(aside.hidden).toBe(false)
    expect(aside.querySelector<HTMLElement>('.dash-focus-gone')?.hidden).toBe(false)
  })
})

describe('PR and CI chips stay ambient (#307)', () => {
  it('leave the badge, tabs, rail and dock exactly as they are', async () => {
    const d = open()
    work(d, 'mine', 'Fixing CI')
    insertItem(d, { ...A, repo: REPO, kind: 'question', title: 'Retry the flaky job?', session: 'mine' })
    upsertSourceLink(d, {
      repo: REPO, branch: '307-polish', pr_number: 401, pr_state: 'OPEN', checks: 'failing', review_decision: 'CHANGES_REQUESTED',
      pr_url: 'https://github.com/shariqh/agent-inbox/pull/401',
    })
    let links = false
    await bootApp(d, {
      interceptFetch: async (input, _init, next) =>
        (!links && route(input) === '/api/links' ? new Response('<!doctype html>', { status: 404 }) : next()),
    })
    click(openButton('mine'))
    expect(panel()!.querySelector('.dash-focus-source .src-chip')).toBeNull()
    const without = await attentionSurfaces()

    links = true
    await pollTick()
    await settle()
    expect(panel()!.querySelector('.dash-focus-source .src-chip.tone-bad')).not.toBeNull()
    expect(await attentionSurfaces()).toEqual(without)
  })
})

describe('⌘K actions (#307)', () => {
  async function choose(query: string, title: string): Promise<void> {
    document.getElementById('search')!.focus()
    await searchFor(query)
    const option = [...document.querySelectorAll<HTMLElement>('#searchResults [role="option"]')]
      .find((el) => el.querySelector('.search-result-main')?.textContent === title)
    expect(option, `${query} → ${title}`).toBeTruthy()
    click(option)
    await settle()
  }

  it('"answer…" opens an ask past the rail in its Inbox card through the deep link', async () => {
    const d = open()
    const ids: string[] = []
    for (let index = 0; index < 4; index += 1) {
      ids.push(insertItem(d, { ...A, kind: 'question', title: `Decision ${index}` }))
      advanceClock()
    }
    await bootApp(d)
    expect(railIds()).not.toContain(ids[3])
    await choose('answer decision 3', 'Decision 3')
    expect(location.hash).toBe(`#item/${ids[3]}`)
    expect(document.getElementById('needsYou')?.hidden).toBe(false)
    expect(row(ids[3]!)?.querySelector('.nrow-card')).not.toBeNull()
  })

  it('"answer…" jumps to the rail card on the Dashboard without opening an editor', async () => {
    const d = open()
    const id = insertItem(d, { ...A, kind: 'question', title: 'Ship it?' })
    await bootApp(d)
    await choose('answer ', 'Ship it?')
    const card = document.querySelector(`#dashRail [data-rail-card="${id}"]`)
    expect(document.activeElement).toBe(card)
    expect(card?.classList.contains('expanded')).toBe(false)
  })

  it('"open plan…" lands on the plan through the deep link, and a prefix fills in the command', async () => {
    const d = open()
    const board = upsertBoard(d, { ...A, title: 'Release plan', rows: [{ label: 'Tag', status: 'missing' }] }).boardId
    await bootApp(d)
    await choose('pla', 'Open plan…')
    expect((document.getElementById('search') as HTMLInputElement).value).toBe('open plan ')
    await choose('open plan release', 'Release plan')
    expect(location.hash).toBe(`#item/${board}`)
    expect(document.getElementById('boards')?.hidden).toBe(false)
  })

  it('"jump to session…" opens that session on the Dashboard', async () => {
    const d = open()
    work(d, 'mine', 'Painting the panel')
    work(d, 'theirs', 'Reviewing', { project: 'beta' })
    await bootApp(d)
    click(document.querySelector('.tab[data-tab="needsYou"]'))
    await settle()
    await choose('jump to session review', 'Reviewing')
    expect(document.getElementById('dashboard')?.hidden).toBe(false)
    expect(panel()?.hidden).toBe(false)
    expect(panel()?.dataset.session).toBe('theirs')
    expect(document.activeElement).toBe(panel()?.querySelector('#dashFocusTitle'))
  })
})
