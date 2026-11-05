// @vitest-environment jsdom
// Dashboard 2.0 phase 5 (#307): command-center polish. The session cards'
// filters (#454), the Dashboard keys in the keyboard help, the session focus panel
// (read-only, updated in place, never pulling focus in a background window)
// and the ⌘K actions, which route through focusItem and the deep-link path.
// None of it reaches attention: PR and CI chips in the panel included.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, recordActivityCall, resolveItem, upsertActivity, upsertBoard, upsertSourceLink } from '../../src/store.js'
import {
  advanceClock, attachStylesheet, badgeCount, bootApp, click, freshDb, pollTick, row, searchFor, settle, tabCount, useDomTest,
} from './harness.js'

// jsdom dispatches only untrusted events, and an outside click closes the panel
// only on trusted input (as "Since you last looked" does): stub that one seam.
const trust = vi.hoisted(() => ({ on: true }))
vi.mock('../../public/ribbon.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../public/ribbon.js')>(),
  trustedInput: () => trust.on,
}))

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null; trust.on = true; vi.restoreAllMocks() })

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

const card = (session: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`#dashboard [data-session-card="session:${session}"]`)
const cardIds = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('#dashboard .ah-groups [data-session-card]')].map((el) => el.dataset.sessionCard!.slice('session:'.length))
// a card opens its panel from anywhere that is not a control
const openCard = (session: string): void => click(card(session)?.querySelector('.sc-doing'))
const panel = () => document.querySelector<HTMLElement>('#dashboard .dash-focus')
const signal = (name: string): string =>
  document.querySelector(`[data-dashboard-signal="${name}"] .dashboard-value`)?.textContent ?? ''

const pick = (filter: string): void => click(document.querySelector(`#dashboard [data-ah-filter="${filter}"]`))

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
    waiting: signal('waiting'),
    dock: [await dock.text(), await plans.text()],
  }
}

describe('quick filters on session cards (#307, #454)', () => {
  it('narrow only the cards, never the Now strip, the rail or attention', async () => {
    const d = open()
    work(d, 'a', 'Alpha work')
    work(d, 'b', 'Beta work', { project: 'beta', agent: 'claude-code' })
    work(d, 'c', 'More alpha', { agent: 'claude-code' })
    insertItem(d, { ...A, kind: 'question', title: 'Alpha ask', session: 'a' })
    insertItem(d, { ...A, project: 'beta', kind: 'question', title: 'Beta ask', session: 'b' })
    await bootApp(d)
    const before = await attentionSurfaces()
    const working = signal('agents')
    expect(cardIds().sort()).toEqual(['a', 'b', 'c'])

    pick('ask')
    expect(cardIds().sort()).toEqual(['a', 'b'])
    pick('working')
    expect(cardIds()).toEqual(['c'])
    await pollTick()
    expect(cardIds()).toEqual(['c'])
    expect(signal('agents')).toBe(working)
    expect(await attentionSurfaces()).toEqual(before)

    pick('parked')
    expect(cardIds()).toEqual([])
    expect(document.querySelector<HTMLElement>('.agents-home .ah-none')?.hidden).toBe(false)
    pick('all')
    expect(cardIds().sort()).toEqual(['a', 'b', 'c'])
    expect(document.querySelector<HTMLElement>('.agents-home .ah-none')?.hidden).toBe(true)
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
    expect(keys).toEqual(['J / K', 'Enter', '1-4', 'S', 'P', 'R', 'Esc'])
    expect(section!.textContent).toContain('session panel')
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

  it("opens with the session's asks, plan, outcomes and links, and Escape returns to the card", async () => {
    const d = open()
    const { ask } = seed(d)
    upsertSourceLink(d, {
      repo: REPO, branch: '307-polish', pr_number: 400, pr_state: 'OPEN', pr_title: 'Polish', checks: 'failing',
      pr_url: 'https://github.com/shariqh/agent-inbox/pull/400',
    })
    await bootApp(d)
    expect(panel()?.hidden).toBe(true)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)

    openCard('mine')
    const aside = panel()!
    expect(aside.hidden).toBe(false)
    expect(card('mine')!.classList.contains('sel')).toBe(true)
    expect(document.activeElement).toBe(aside.querySelector('#dashFocusTitle'))
    expect(aside.querySelector('.dash-focus-doing')?.textContent).toBe('Painting the panel')
    expect([...aside.querySelectorAll('.sp-ask-title')].map((el) => el.textContent)).toEqual(['Which panel width?'])
    // it answers its asks in place with the Inbox's own editor (#454 A.2), beside the session's composer (#411)
    const block = aside.querySelector(`[data-panel-ask="${ask}"]`)!
    expect(block.querySelector('.reply-input:not(.reply-context-input)')?.getAttribute('data-draft-focus-key')).toBe(`${ask}:answer`)
    expect([...aside.querySelectorAll('.dash-focus-message textarea')]).toHaveLength(1)
    expect([...block.querySelectorAll('[data-ask-action]')].map((el) => el.textContent)).toEqual(['Snooze 4h', 'Pin', 'Open in Inbox'])
    expect(aside.querySelector('.dash-focus-plan-title')?.textContent).toBe('Polish plan')
    expect([...aside.querySelectorAll('.dash-focus-outcome strong')].map((el) => el.textContent))
      .toEqual(['Earlier step', 'Filters'])
    expect(aside.querySelector('.dash-focus-source .src-chip.tone-bad')?.textContent).toContain('checks failing')
    expect([...aside.querySelectorAll('.card-links [data-link-kind]')].map((el) => el.getAttribute('href')))
      .toContain('https://example.com/panel-spec')

    keydown(aside.querySelector('#dashFocusTitle')!, 'Escape')
    expect(aside.hidden).toBe(true)
    expect(card('mine')!.classList.contains('sel')).toBe(false)
    // back to the card's first action: here its Answer
    expect(document.activeElement).toBe(card('mine')!.querySelector('[data-ah-action="review"]'))
  })

  it('lists every ask of the session and opens one in its Inbox card', async () => {
    const d = open()
    work(d, 'mine', 'Asking a lot')
    const ids: string[] = []
    for (let index = 0; index < 4; index += 1) {
      ids.push(insertItem(d, { ...A, kind: 'question', title: `Decision ${index}`, session: 'mine' }))
      advanceClock()
    }
    await bootApp(d)
    const past = ids[3]!
    openCard('mine')
    expect([...panel()!.querySelectorAll<HTMLElement>('[data-panel-ask]')].map((el) => el.dataset.panelAsk).sort()).toEqual([...ids].sort())
    expect(panel()!.querySelector('.sp-asks-count')?.textContent).toBe('4')
    click(panel()!.querySelector(`[data-panel-ask="${past}"] [data-ask-action="open"]`))
    await settle()
    expect(document.getElementById('needsYou')?.hidden).toBe(false)
    expect(location.hash).toBe(`#item/${past}`)
    expect(row(past)).not.toBeNull()
  })

  it('shows each subagent’s reported state, as text, in the panel and on the card (#460 review)', async () => {
    const d = open()
    work(d, 'mine', 'Coordinating', { children: [{ name: 'tester', doing: 'Running tests', state: '<b>blocked</b>' }, { name: 'docs', doing: 'Writing' }] })
    await bootApp(d)
    expect(card('mine')!.querySelector<HTMLElement>('.sc-kids')?.title).toBe('tester: Running tests (<b>blocked</b>)\ndocs: Writing')
    openCard('mine')
    const states = [...panel()!.querySelectorAll('.sp-children .sp-child-state')]
    expect(states.map((el) => el.textContent)).toEqual(['<b>blocked</b>'])
    expect(panel()!.querySelector('.sp-children b')).toBeNull()
  })

  it('opens the plan through the deep link', async () => {
    const d = open()
    const { board } = seed(d)
    await bootApp(d)
    openCard('mine')
    click(panel()!.querySelector('.dash-focus-plan-open'))
    await settle()
    expect(location.hash).toBe(`#item/${board}`)
    expect(document.getElementById('boards')?.hidden).toBe(false)
  })

  it("a card's Answer and its ask strip open its panel at the ask, and never the rail", async () => {
    const d = open()
    const { ask } = seed(d)
    await bootApp(d)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    expect(card('mine')!.querySelector('[data-ah-action="review"]')?.textContent).toBe('Answer')
    click(card('mine')!.querySelector('[data-ah-action="review"]'))
    expect(panel()!.hidden).toBe(false)
    expect(panel()!.dataset.session).toBe('mine')
    expect(document.activeElement).toBe(panel()!.querySelector(`[data-panel-ask="${ask}"]`))
    click(panel()!.querySelector('.dash-focus-close'))
    // the strip opens the panel at the ask too; it answers nothing on the card
    click(card('mine')!.querySelector('.sc-ask-title'))
    expect(panel()!.hidden).toBe(false)
    expect(document.activeElement).toBe(panel()!.querySelector(`[data-panel-ask="${ask}"]`))
    expect(card('mine')!.querySelector('.opt-pill, textarea')).toBeNull()
  })

  it('closing leaves no card selected, after a poll too (#462 review)', async () => {
    const d = open()
    seed(d)
    await bootApp(d)
    openCard('mine')
    work(d, 'mine', 'Still painting')
    await pollTick()
    expect(card('mine')!.classList.contains('sel')).toBe(true)
    click(panel()!.querySelector('.dash-focus-close'))
    expect(panel()!.hidden).toBe(true)
    expect(card('mine')!.classList.contains('sel')).toBe(false)
  })

  const press = (el: Element) => el.dispatchEvent(new Event('pointerdown', { bubbles: true }))

  it('closes on a trusted click outside it that is not a card, never on a press alone, moving no focus', async () => {
    const d = open()
    seed(d)
    await bootApp(d)
    attachStylesheet()
    openCard('mine')
    expect(getComputedStyle(panel()!).position).toBe('absolute')
    click(panel()!.querySelector('.dash-focus-doing'))
    openCard('theirs')
    expect(panel()!.dataset.session).toBe('theirs')
    expect(panel()!.hidden).toBe(false)
    const rail = document.querySelector('#dashboard .dashboard-activity')!
    press(rail)
    expect(panel()!.hidden).toBe(false)
    const focused = document.activeElement
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    click(rail)
    expect(panel()!.hidden).toBe(true)
    expect(focus).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(focused)
  })

  it('ignores a scripted click', async () => {
    const d = open()
    seed(d)
    await bootApp(d)
    attachStylesheet()
    openCard('mine')
    trust.on = false
    click(document.querySelector('#dashboard .dashboard-activity'))
    expect(panel()!.hidden).toBe(false)
  })

  it('never closes on an outside press or click while it is in flow (the compact layout)', async () => {
    const d = open()
    seed(d)
    await bootApp(d)
    openCard('mine')
    const real = window.getComputedStyle
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
      const style = real(el, pseudo)
      return el.classList?.contains('dash-focus') ? ({ ...style, position: 'static' } as CSSStyleDeclaration) : style
    })
    const rail = document.querySelector('#dashboard .dashboard-activity')!
    press(rail)
    click(rail)
    expect(panel()!.hidden).toBe(false)
  })

  it('is the Dashboard grid’s own, so no card or fold can hide it (#454)', async () => {
    const d = open()
    seed(d)
    await bootApp(d)
    expect(panel()!.parentElement?.classList.contains('dashboard-grid')).toBe(true)
    expect(panel()!.closest('.agents-home')).toBeNull()
    openCard('mine')
    expect(panel()?.hidden).toBe(false)
    expect(panel()?.closest('[hidden]')).toBeNull()
    expect(document.querySelector('[data-session-card="session:mine"]')?.classList.contains('sel')).toBe(true)
  })

  it('opens and closes without pulling focus in a background window', async () => {
    const d = open()
    seed(d)
    await bootApp(d)
    const button = card('mine')!.querySelector<HTMLButtonElement>('[data-ah-action]')!
    button.focus()
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    button.dispatchEvent(new FocusEvent('blur'))
    button.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')

    openCard('mine')
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
    openCard('mine')
    const aside = panel()!
    const asks = aside.querySelector('.dash-focus-asks')!
    const askNode = asks.firstElementChild
    // the ask's editor settles once after the open (its size, the keyboard hints), then holds still
    await pollTick()
    insertItem(d, { project: 'gamma', stream: 'main', agent: 'claude', kind: 'note', title: 'Settling' })
    await pollTick()
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

    // the session stops working: the panel stays on it (#454: every session has a card), its ask still open
    upsertActivity(d, { ...A, session: 'mine', doing: 'open', idle: true })
    await pollTick()
    expect(aside.hidden).toBe(false)
    expect(aside.querySelector('.sp-state')?.textContent).toBe('Needs you')
    expect(aside.querySelector('.dash-focus-doing')?.textContent).toBe('was: Polishing the panel')
    expect(aside.querySelector<HTMLElement>('.dash-focus-gone')?.hidden).toBe(true)
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
    openCard('mine')
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

  const firstOption = () => document.querySelector<HTMLElement>('#searchResults [role="option"]')

  it('keeps a plain search that starts with a command word a search, and Enter opens the best Open item', async () => {
    const d = open()
    const q = insertItem(d, { ...A, kind: 'question', title: 'Plan flow rollout' })
    upsertBoard(d, { ...A, title: 'Flow board', rows: [{ label: 'Flow', status: 'missing' }] })
    work(d, 'flowing', 'Flow work')
    await bootApp(d)
    for (const query of ['plan flow', 'session flow', 'jump flow']) {
      document.getElementById('search')!.focus()
      await searchFor(query)
      expect([...document.querySelectorAll('#searchResults .search-result-kind')].map((el) => el.textContent), query)
        .not.toContain('Open plan')
      expect([...document.querySelectorAll('#searchResults .search-result-kind')].map((el) => el.textContent), query)
        .not.toContain('Jump to session')
    }
    await searchFor('plan flow')
    expect(firstOption()?.dataset.searchTarget).toBe(q)
    document.getElementById('search')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await settle()
    expect(location.hash).toBe(`#item/${q}`)
    expect(document.getElementById('needsYou')?.hidden).toBe(false)
  })

  it('never puts a command suggestion above the best Open-item match', async () => {
    const d = open()
    const q = insertItem(d, { ...A, kind: 'question', title: 'Plan the release' })
    await bootApp(d)
    document.getElementById('search')!.focus()
    await searchFor('pl')
    expect(firstOption()?.dataset.searchTarget).toBe(q)
    const titles = [...document.querySelectorAll('#searchResults .search-result-main')].map((el) => el.textContent)
    expect(titles).toContain('Open plan…')
    expect(document.getElementById('search')!.getAttribute('aria-activedescendant')).toBe(firstOption()?.id)
  })

  it('"answer…" lands on the ask in its session panel from any tab, an ask-only card’s included (#454 A.2)', async () => {
    const d = open()
    work(d, 'mine', 'Asking')
    const ids: string[] = []
    for (let index = 0; index < 4; index += 1) {
      ids.push(insertItem(d, { ...A, kind: 'question', title: `Decision ${index}` }))
      advanceClock()
    }
    const own = insertItem(d, { ...A, kind: 'question', title: 'Ship it?', session: 'mine' })
    await bootApp(d)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    click(document.querySelector('.tab[data-tab="needsYou"]'))
    await settle()
    await choose('answer decision 3', 'Decision 3')
    expect(document.getElementById('dashboard')?.hidden).toBe(false)
    expect(panel()?.dataset.session).toBe(`ask:item:${ids[3]}`)
    expect(document.activeElement).toBe(panel()!.querySelector(`[data-panel-ask="${ids[3]}"]`))

    await choose('answer ', 'Ship it?')
    expect(panel()?.dataset.session).toBe('mine')
    // a landing spot, never an option or an editor
    expect(document.activeElement).toBe(panel()!.querySelector(`[data-panel-ask="${own}"]`))
  })

  it('"answer…" lands an @sessions approval on its live session’s card, clearing a lens that hides it (#462 review)', async () => {
    const d = open()
    work(d, 'mcp-1', 'Running the tests')
    insertItem(d, {
      project: '@sessions', stream: 'alpha · 307-polish', agent: 'copilot', kind: 'question', session: 'mcp-1', title: 'Allow shell: npm test',
      action_owner: 'approval', options: [{ label: 'Allow once' }, { label: 'Deny' }],
    })
    await bootApp(d)
    click(document.querySelector('#rail button.rail-tab[data-project="alpha"]'))
    await settle()
    await choose('answer allow', 'Allow shell: npm test')
    expect(panel()?.hidden).toBe(false)
    expect(panel()?.dataset.session).toBe('mcp-1')
    expect(panel()?.dataset.card).toBe('session:mcp-1')
    expect(panel()?.querySelector('.sp-state')?.textContent).toBe('Needs you')
    expect(document.querySelector('[data-session-card="ask:session:mcp-1"]')).toBeNull()
    expect(document.querySelector('#rail [data-project="__all__"]')?.getAttribute('aria-selected')).toBe('true')
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
    // shown, not merely unhidden: no ancestor hides it (#454, the Dashboard opens on Agents)
    expect(panel()?.closest('[hidden]')).toBeNull()
    expect(panel()?.dataset.session).toBe('theirs')
    expect(document.activeElement).toBe(panel()?.querySelector('#dashFocusTitle'))
  })
})
