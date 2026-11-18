// @vitest-environment jsdom
// Dashboard 2.0 phase 5 (#307): command-center polish. The Working and Quiet
// lanes that replaced the session cards' filters (#454, dashboard lanes design
// §3.3, §3.4), the Dashboard keys in the keyboard help, the session focus panel
// (read-only, updated in place, never pulling focus in a background window)
// and the ⌘K actions, which route through focusItem and the deep-link path.
// None of it reaches attention: PR and CI chips in the panel included.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { endActivity, insertItem, recordActivityCall, resolveItem, setActivityPlace, upsertActivity, upsertBoard, upsertSourceLink } from '../../src/store.js'
import {
  advanceClock, attachStylesheet, badgeCount, bootApp, click, freshDb, pollTick, row, searchFor, setViewport, settle, tabCount, type,
  useDomTest,
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
const cardIds = (lane: 'working' | 'quiet'): string[] =>
  [...document.querySelectorAll<HTMLElement>(lane === 'working' ? '#dashboard .working-lane .ah-groups [data-session-card]' : '#dashboard .quiet-lane .qt-rows [data-session-card]')]
    .map((el) => el.dataset.sessionCard!.slice('session:'.length))
// a card opens its panel from anywhere that is not a control
const openCard = (session: string): void => click(card(session)?.querySelector('.sc-doing'))
const panel = () => document.querySelector<HTMLElement>('#dashboard .dash-focus')
// the page head's lane chips (dashboard lanes design §3.1)
const chip = (key: 'needs' | 'working' | 'quiet'): string =>
  document.querySelector(`#dashboard [data-dash-chip="${key}"] .dash-chip-count`)?.textContent ?? ''
const laneCard = (id: string) => [...document.querySelectorAll<HTMLElement>('#dashboard .ny-card')].find((el) => el.dataset.nyAsk === id) ?? null

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
    waiting: chip('needs'),
    dock: [await dock.text(), await plans.text()],
  }
}

describe('the Working and Quiet lanes split the cards (#307, #454, dashboard lanes design §3.3, §3.4)', () => {
  it('a session that stops moves to Quiet, never moving the Needs you lane, the rail or attention', async () => {
    const d = open()
    work(d, 'a', 'Alpha work')
    work(d, 'b', 'Beta work', { project: 'beta', agent: 'claude-code' })
    work(d, 'c', 'More alpha', { agent: 'claude-code' })
    insertItem(d, { ...A, kind: 'question', title: 'Alpha ask', session: 'a' })
    insertItem(d, { ...A, project: 'beta', kind: 'question', title: 'Beta ask', session: 'b' })
    await bootApp(d)
    const before = await attentionSurfaces()
    expect([cardIds('working').sort(), cardIds('quiet')]).toEqual([['a', 'b', 'c'], []])
    expect([chip('working'), chip('quiet')]).toEqual(['3', '0'])

    upsertActivity(d, { ...A, project: 'beta', agent: 'claude-code', session: 'b', doing: 'open', idle: true })
    await pollTick()
    expect([cardIds('working').sort(), cardIds('quiet')]).toEqual([['a', 'c'], ['b']])
    expect([chip('working'), chip('quiet')]).toEqual(['2', '1'])
    // its ask still shows once, in Needs you; the row only counts it
    expect(document.querySelectorAll('#dashboard .ny-card')).toHaveLength(2)
    expect(card('b')?.querySelector('.sc-asking')?.textContent).toBe('Asking you · 1')
    expect(await attentionSurfaces()).toEqual(before)
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
    // back to the card's first action: here Open, the Working lane's main action (dashboard lanes design §3.3)
    expect(document.activeElement).toBe(card('mine')!.querySelector('[data-ah-action="open"]'))
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

  it("a card's Asking you chip goes to its ask in Needs you, Enter opens its panel, and the card answers nothing", async () => {
    const d = open()
    const { ask } = seed(d)
    await bootApp(d)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    expect(card('mine')!.querySelector('.sc-asking')?.textContent).toBe('Asking you · 1')
    expect(card('mine')!.querySelector('[data-ah-action="review"]')).toBeNull()
    click(card('mine')!.querySelector('.sc-asking'))
    expect(panel()!.hidden).toBe(true)
    expect(document.activeElement).toBe(laneCard(ask))
    card('mine')!.focus()
    keydown(card('mine')!, 'Enter')
    expect(panel()!.hidden).toBe(false)
    expect(panel()!.dataset.session).toBe('mine')
    expect(document.activeElement).toBe(panel()!.querySelector('#dashFocusTitle'))
    expect(panel()!.querySelector(`[data-panel-ask="${ask}"]`)).not.toBeNull()
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
    expect(getComputedStyle(panel()!).position).toBe('sticky')
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

  it('is the Dashboard split’s own, so no card or fold can hide it (#454, §3.6)', async () => {
    const d = open()
    seed(d)
    await bootApp(d)
    const split = panel()!.parentElement!
    expect(split.classList.contains('dash-split')).toBe(true)
    expect(split.parentElement?.classList.contains('dashboard-grid')).toBe(true)
    expect(panel()!.previousElementSibling?.classList.contains('agents-home')).toBe(true)
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
    expect(aside.querySelector('.sp-state')?.textContent).toBe('Quiet')
    expect(aside.querySelector('[data-panel-ask]')).not.toBeNull()
    expect(aside.querySelector('.dash-focus-doing')?.textContent).toBe('Last reported: Polishing the panel · just now')
    expect(aside.querySelector<HTMLElement>('.dash-focus-gone')?.hidden).toBe(true)
  })
})

// Dashboard lanes design §3.6 (PR 5): at 1280px and wider an open panel sits
// beside the lanes in .dash-split.open, covering nothing; below 1280px it opens
// inline under its card or row, as before. jsdom cannot lay out, so the columns
// are pinned in test/editorial-shell.test.ts; here, where the panel is, which
// class the split carries, focus, and what a poll keeps.
describe('the session panel as a split (§3.6)', () => {
  afterEach(() => setViewport('wide'))
  const split = () => document.querySelector<HTMLElement>('#dashboard .dash-split')!
  const home = () => document.querySelector<HTMLElement>('#dashboard .agents-home')!
  const isOpen = () => split().classList.contains('open')
  // a session that takes messages has a composer, so a draft to keep
  const MSG = { receives_messages: true }
  function seed(d: Database.Database): void {
    work(d, 'mine', 'Painting the panel', MSG)
    work(d, 'theirs', 'Elsewhere', { project: 'beta' })
    upsertActivity(d, { ...A, session: 'idle', doing: 'open', idle: true })
  }

  it('opens beside the lanes at 1280px and wider: the lanes and the panel are siblings in the split', async () => {
    const d = open()
    seed(d)
    await bootApp(d)
    attachStylesheet()
    expect(isOpen()).toBe(false)
    expect(getComputedStyle(split()).display).toBe('contents')
    openCard('mine')
    expect(isOpen()).toBe(true)
    expect(panel()!.parentElement).toBe(split())
    expect(home().parentElement).toBe(split())
    expect(panel()!.previousElementSibling).toBe(home())
    // in the split's own column, never a sheet over the cards
    expect(getComputedStyle(split()).display).toBe('grid')
    expect(getComputedStyle(panel()!).position).toBe('sticky')
    expect(getComputedStyle(panel()!).position).not.toBe('absolute')
    // a Quiet row opens it the same way
    click(card('idle')?.querySelector('.sc-doing'))
    expect([panel()!.dataset.session, panel()!.parentElement === split(), isOpen()]).toEqual(['idle', true, true])
  })

  it('with it closed the split is gone, by ×, Esc, a second click and a trusted outside click', async () => {
    const d = open()
    seed(d)
    await bootApp(d)
    attachStylesheet()
    const closedBy = (close: () => void) => {
      openCard('mine')
      expect(isOpen()).toBe(true)
      close()
      expect([panel()!.hidden, isOpen(), panel()!.parentElement === split()]).toEqual([true, false, true])
    }
    closedBy(() => click(panel()!.querySelector('.dash-focus-close')))
    closedBy(() => keydown(panel()!.querySelector('#dashFocusTitle')!, 'Escape'))
    closedBy(() => openCard('mine'))
    closedBy(() => click(document.querySelector('#dashboard .dashboard-activity')))
  })

  it('switching sessions keeps the split, and its class is never rewritten', async () => {
    const d = open()
    seed(d)
    await bootApp(d)
    openCard('mine')
    const observer = new MutationObserver(() => {})
    observer.observe(split(), { attributes: true })
    openCard('theirs')
    const records = observer.takeRecords()
    observer.disconnect()
    expect(records).toEqual([])
    expect([panel()!.dataset.session, panel()!.parentElement === split(), isOpen()]).toEqual(['theirs', true, true])
  })

  it('open, switch, ×, and Esc leave focus where the base branch left it', async () => {
    const d = open()
    seed(d)
    await bootApp(d)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    openCard('mine')
    expect(document.activeElement).toBe(document.getElementById('dashFocusTitle'))
    openCard('theirs')
    expect(document.activeElement).toBe(document.getElementById('dashFocusTitle'))
    click(panel()!.querySelector('.dash-focus-close'))
    expect(document.activeElement).toBe(card('theirs')!.querySelector('[data-ah-action="open"]'))
    openCard('mine')
    keydown(document.getElementById('dashFocusTitle')!, 'Escape')
    expect(isOpen()).toBe(false)
    expect(document.activeElement).toBe(card('mine')!.querySelector('[data-ah-action="open"]'))
  })

  it('a poll while it is open keeps its draft, its scroll and the split, and reads no layout', async () => {
    const d = open()
    seed(d)
    await bootApp(d)
    openCard('mine')
    const input = panel()!.querySelector<HTMLTextAreaElement>('.dash-focus-message textarea')!
    type(input, 'half a thought')
    const body = panel()!.querySelector<HTMLElement>('.sp-body')!
    body.scrollTop = 120
    const rect = vi.spyOn(card('mine')!, 'getBoundingClientRect')
    const scroll = vi.spyOn(window, 'scrollBy').mockImplementation(() => {})
    work(d, 'mine', 'Still painting', MSG)
    await pollTick()
    expect(panel()!.querySelector('.dash-focus-doing')?.textContent).toBe('Still painting')
    expect(panel()!.querySelector('.dash-focus-message textarea')).toBe(input)
    expect(input.value).toBe('half a thought')
    expect(panel()!.querySelector('.sp-body')).toBe(body)
    expect(body.scrollTop).toBe(120)
    expect([isOpen(), panel()!.parentElement === split()]).toEqual([true, true])
    expect(rect).not.toHaveBeenCalled()
    expect(scroll).not.toHaveBeenCalled()
  })

  it('keeps the split, its class and the scroll when its session changes lane or leaves the lists', async () => {
    const d = open()
    seed(d)
    await bootApp(d)
    openCard('mine')
    const scroll = vi.spyOn(window, 'scrollBy').mockImplementation(() => {})
    const observer = new MutationObserver(() => {})
    observer.observe(split(), { attributes: true })
    upsertActivity(d, { ...A, session: 'mine', doing: 'open', idle: true })
    await pollTick()
    expect(card('mine')?.closest('.quiet-lane')).not.toBeNull()
    expect([panel()!.hidden, panel()!.parentElement === split(), isOpen()]).toEqual([false, true, true])
    endActivity(d, 'mine')
    await pollTick()
    expect(card('mine')).toBeNull()
    expect([panel()!.hidden, panel()!.parentElement === split(), isOpen()]).toEqual([false, true, true])
    expect(panel()!.querySelector<HTMLElement>('.dash-focus-gone')?.hidden).toBe(false)
    expect(observer.takeRecords()).toEqual([])
    observer.disconnect()
    expect(scroll).not.toHaveBeenCalled()
  })

  it('opening and closing keep the opened card where it was on screen', async () => {
    const d = open()
    seed(d)
    await bootApp(d)
    // the card reflows 120px down while the lanes are narrowed beside the panel
    vi.spyOn(card('mine')!, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, isOpen() ? 420 : 300, 340, 120))
    const scroll = vi.spyOn(window, 'scrollBy').mockImplementation(() => {})
    openCard('mine')
    expect(scroll.mock.calls).toEqual([[0, 120]])
    // a switch and a poll flip nothing, so nothing scrolls
    openCard('theirs')
    openCard('mine')
    work(d, 'mine', 'Still painting', MSG)
    await pollTick()
    expect(scroll.mock.calls).toEqual([[0, 120]])
    click(panel()!.querySelector('.dash-focus-close'))
    expect(scroll.mock.calls).toEqual([[0, 120], [0, -120]])
  })

  it('below 1280px the split never opens; the panel is inline under its card and under its row', async () => {
    const d = open()
    seed(d)
    setViewport(760)
    await bootApp(d)
    openCard('mine')
    expect(panel()!.parentElement).toBe(card('mine')!.parentElement)
    expect(panel()!.previousElementSibling).toBe(card('mine'))
    expect(isOpen()).toBe(false)
    click(card('idle')?.querySelector('.sc-doing'))
    expect(panel()!.parentElement?.classList.contains('qt-rows')).toBe(true)
    expect(panel()!.previousElementSibling).toBe(card('idle'))
    expect(isOpen()).toBe(false)
    click(panel()!.querySelector('.dash-focus-close'))
    expect([panel()!.hidden, panel()!.parentElement === split(), isOpen()]).toEqual([true, true, false])
  })

  it('a window crossing 1280px moves the panel and the split with it', async () => {
    const d = open()
    seed(d)
    await bootApp(d)
    openCard('mine')
    expect(isOpen()).toBe(true)
    setViewport(760)
    expect(panel()!.previousElementSibling).toBe(card('mine'))
    expect(isOpen()).toBe(false)
    setViewport('wide')
    expect(panel()!.parentElement).toBe(split())
    expect(isOpen()).toBe(true)
  })

  it('a panel holding focus stays put across 1280px, with no split while narrow, until focus leaves', async () => {
    const d = open()
    seed(d)
    await bootApp(d)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    openCard('mine')
    const title = document.getElementById('dashFocusTitle')!
    expect(document.activeElement).toBe(title)
    const input = panel()!.querySelector<HTMLTextAreaElement>('.dash-focus-message textarea')!
    type(input, 'a draft')
    // wide to narrow: held in the split, which no longer splits
    setViewport(760)
    expect([panel()!.parentElement === split(), isOpen()]).toEqual([true, false])
    expect(document.activeElement).toBe(title)
    expect(input.value).toBe('a draft')
    title.blur()
    work(d, 'mine', 'Still painting', MSG)
    await pollTick()
    expect(panel()!.previousElementSibling).toBe(card('mine'))
    expect(isOpen()).toBe(false)
    // narrow to wide: held inline, with no split, until it lets go
    title.focus()
    setViewport('wide')
    expect([panel()!.previousElementSibling === card('mine'), isOpen()]).toEqual([true, false])
    expect(document.activeElement).toBe(title)
    title.blur()
    work(d, 'mine', 'Painting again', MSG)
    await pollTick()
    expect([panel()!.parentElement === split(), isOpen()]).toEqual([true, true])
    expect(panel()!.querySelector('.dash-focus-message textarea')).toBe(input)
    expect(input.value).toBe('a draft')
  })

  it('a window resized across 1280px before the first paint throws nothing', async () => {
    const d = open()
    seed(d)
    // the app is loaded but its first read is still in flight: no Dashboard, no split
    const bridge = await bootApp(d, { holdFetch: true })
    expect(document.querySelector('#dashboard .dash-split')).toBeNull()
    expect(() => { setViewport(760); setViewport('wide') }).not.toThrow()
    bridge.releaseFetch()
    await settle()
    openCard('mine')
    expect(isOpen()).toBe(true)
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

  it('"answer…" lands on the ask’s Inbox card, open, from any tab (dashboard lanes design §6)', async () => {
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
    expect(document.getElementById('needsYou')?.hidden).toBe(false)
    expect(row(ids[3]!)?.dataset.open).toBe('1')
    expect(row(ids[3]!)?.querySelector('.nrow-card')).not.toBeNull()

    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()
    await choose('answer ', 'Ship it?')
    expect(document.getElementById('needsYou')?.hidden).toBe(false)
    expect(row(own)?.dataset.open).toBe('1')
    expect(panel()?.hidden).toBe(true)
  })

  it('"answer…" opens an @sessions approval’s Inbox card, from a lens that hides it (#462 review)', async () => {
    const d = open()
    work(d, 'mcp-1', 'Running the tests')
    const id = insertItem(d, {
      project: '@sessions', stream: 'alpha · 307-polish', agent: 'copilot', kind: 'question', session: 'mcp-1', title: 'Allow shell: npm test',
      action_owner: 'approval', options: [{ label: 'Allow once' }, { label: 'Deny' }],
    })
    await bootApp(d)
    click(document.querySelector('#rail button.rail-tab[data-project="alpha"]'))
    await settle()
    await choose('answer allow', 'Allow shell: npm test')
    expect(document.getElementById('needsYou')?.hidden).toBe(false)
    expect(row(id)?.dataset.open).toBe('1')
    // its live session's card holds it, so the Inbox card offers the way to its panel
    expect(row(id)?.querySelector('.nrow-show-agents')).not.toBeNull()
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

// #617 PR 1: where a session runs, in the session panel. The head's meta line says it; two controls
// act on it: "Open in claude.ai", an ordinary link built from a pattern-checked id only, and
// "Copy attach command". A row an older server wrote has none of the fields and the panel is as it was.
describe('where a session runs, in the session panel (#617)', () => {
  const placed = (d: Database.Database, session = 'mine') => {
    work(d, session, 'Painting the panel', { machine: 'hub', pane: '%3' })
    setActivityPlace(d, session, { desk: 'api', remote_session: 'session_abc123' })
  }
  const place = () => panel()!.querySelector<HTMLElement>('.sp-place')!
  const meta = () => panel()!.querySelector('.dash-focus-meta')?.textContent ?? ''
  const writeText = () => {
    const fn = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: fn } })
    return fn
  }
  afterEach(() => { Reflect.deleteProperty(navigator, 'clipboard') })

  it('says "machine · desk" in the head’s meta line, and shows the two controls', async () => {
    const d = open()
    placed(d)
    await bootApp(d)
    openCard('mine')
    expect(meta()).toContain('Copilot · terminal · hub · api')
    expect(place().hidden).toBe(false)
    const link = place().querySelector<HTMLAnchorElement>('a')!
    expect(link.textContent).toBe('Open in claude.ai')
    expect(link.getAttribute('href')).toBe('https://claude.ai/code/session_abc123')
    // an ordinary link: it leaves through the window's one link path, never a script or a bridge of its own
    expect([link.target, link.rel, link.dataset.linkKind]).toEqual(['_blank', 'noopener noreferrer', 'web'])
    expect([...place().querySelectorAll('button')].map((el) => el.textContent)).toEqual(['Copy attach command'])
  })

  it('Copy attach command copies exactly tmux attach -t \'=<desk>\' through the page’s one clipboard path', async () => {
    const d = open()
    placed(d)
    const copy = writeText()
    await bootApp(d)
    openCard('mine')
    click(place().querySelector('button'))
    await settle()
    expect(copy).toHaveBeenCalledTimes(1)
    expect(copy).toHaveBeenCalledWith("tmux attach -t '=api'")
    expect(place().querySelector('button')?.textContent).toBe('Copied ✓')
    // the label goes back by itself
    await vi.advanceTimersByTimeAsync(2000)
    expect(place().querySelector('button')?.textContent).toBe('Copy attach command')
  })

  it('a row with none of the fields is the panel it was: the same meta line, no controls, nothing drawn', async () => {
    const d = open()
    work(d, 'mine', 'Painting the panel')
    work(d, 'twin', 'Painting the panel', { machine: 'hub' })
    setActivityPlace(d, 'twin', { desk: 'api', remote_session: 'session_abc123' })
    await bootApp(d)
    openCard('twin')
    const withPlace = meta()
    expect(withPlace).toContain('hub · api')
    openCard('mine')
    expect(panel()!.dataset.session).toBe('mine')
    expect(meta()).toBe(withPlace.replace(' · hub · api', ''))
    expect(place().hidden).toBe(true)
    expect(place().querySelector('a, button')).toBeNull()
    expect(place().textContent).toBe('')
  })

  it('shows only the machine, and no control, for a session with no tmux and no Remote Control', async () => {
    const d = open()
    work(d, 'mine', 'Painting the panel', { machine: 'hub' })
    await bootApp(d)
    openCard('mine')
    expect(meta()).toMatch(/^Copilot · terminal · hub · last call /)
    expect(place().hidden).toBe(true)
  })

  it('draws a control only for a value that passes its pattern, and never builds a link or command from text', async () => {
    const d = open()
    placed(d)
    const raw = d.prepare(`UPDATE activity SET desk = ?, remote_session = ? WHERE session = ?`)
    raw.run("api'; touch /tmp/x; '", 'javascript:alert(1)', 'mine')
    const copy = writeText()
    await bootApp(d)
    openCard('mine')
    expect(meta()).not.toContain('touch')
    expect(place().hidden).toBe(true)
    expect(place().querySelector('a, button')).toBeNull()
    expect(panel()!.querySelector('a[href^="javascript"]')).toBeNull()
    raw.run('api', 'https://evil.example/session_abc', 'mine')
    await pollTick()
    await settle()
    expect(place().querySelector('a')).toBeNull()
    expect([...place().querySelectorAll('button')].map((el) => el.textContent)).toEqual(['Copy attach command'])
    click(place().querySelector('button'))
    await settle()
    expect(copy).toHaveBeenCalledWith("tmux attach -t '=api'")
  })

  it('follows the session: a desk that goes away takes its control with it at the next poll', async () => {
    const d = open()
    placed(d)
    await bootApp(d)
    openCard('mine')
    expect(place().querySelector('button')).not.toBeNull()
    setActivityPlace(d, 'mine', { desk: null, remote_session: 'session_abc123' })
    await pollTick()
    await settle()
    expect(place().querySelector('button')).toBeNull()
    expect(place().querySelector('a')?.getAttribute('href')).toBe('https://claude.ai/code/session_abc123')
    expect(meta()).not.toContain('hub · api')
  })
})
