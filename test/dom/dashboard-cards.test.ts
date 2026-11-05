// @vitest-environment jsdom
// The Agents home's session cards (#454), carrying what the Dashboard's live
// lanes did (#304, #306): they are updated in place by the ambient painter, keyed
// by card; a rail draft, a held pointer and a background window never stop them
// or pull focus; a working card pulses once on a new call and carries the
// 30-minute call trace and its plan; the Now strip reads the lanes' model; and
// nothing here reaches attention.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { endActivity, getBoard, getItem, insertItem, recordActivityCall, snoozeItem, touchActivity, upsertActivity, upsertBoard } from '../../src/store.js'
import { attentionEntries, sortRail } from '../../public/attention.js'
import {
  advanceClock, badgeCount, bootApp, click, freshDb, pollTick, row, settle, tabCount, type, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null; vi.restoreAllMocks() })

const A = { project: 'alpha', stream: 'main', agent: 'copilot' } as const
const MIN = 60_000

function open(): Database.Database {
  db = freshDb()
  return db
}

const card = (session: string): HTMLElement | null =>
  [...document.querySelectorAll<HTMLElement>('#dashboard [data-session-card]')].find((el) => el.dataset.sessionCard === `session:${session}`) ?? null
const cardIds = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('#dashboard .ah-groups [data-session-card]')].map((el) => el.dataset.sessionCard!.replace(/^session:/, ''))
const doing = (session: string): string => card(session)?.querySelector('.sc-doing')?.textContent ?? ''
const signal = (name: string): string =>
  document.querySelector(`[data-dashboard-signal="${name}"] .dashboard-value`)?.textContent ?? ''

// A real MCP call stamps last_call_at, then status() claims the work.
function work(d: Database.Database, session: string, what: string, extra: Record<string, unknown> = {}): void {
  upsertActivity(d, { ...A, session, doing: what, idle: false, ...extra })
  recordActivityCall(d, session)
  upsertActivity(d, { ...A, session, doing: what, idle: false, ...extra })
}

describe('session cards carry the lanes (#304, #454)', () => {
  it('updates each card in place across polls, pins order and appends new sessions', async () => {
    const d = open()
    work(d, 'first', 'Writing the store')
    advanceClock()
    work(d, 'second', 'Reviewing the diff')
    await bootApp(d)
    // A forced paint orders by the newest call.
    expect(cardIds()).toEqual(['second', 'first'])
    const nodes = cardIds().map(card)

    advanceClock()
    work(d, 'first', 'Running the tests')
    advanceClock()
    work(d, 'third', 'Drafting the PR')
    await pollTick()

    // The newest call no longer re-sorts: the order is pinned, the new one appends.
    expect(cardIds()).toEqual(['second', 'first', 'third'])
    expect([card('second'), card('first')]).toEqual(nodes)
    expect(doing('first')).toBe('Running the tests')
    // A card that only just appeared does not pulse; the one whose call moved does.
    expect([...document.querySelectorAll<HTMLElement>('.sc.pulse')].map((el) => el.dataset.sessionCard)).toEqual(['session:first'])

    // A frame the human asked for re-sorts.
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()
    expect(cardIds()).toEqual(['third', 'first', 'second'])
    expect(card('second')).toBe(nodes[0])
  })

  it('reads a heads-down session as working until its claim decays, then as idle, never dropping it', async () => {
    const d = open()
    work(d, 'heads-down', 'Long build')
    await bootApp(d)
    expect(card('heads-down')!.querySelector('.sc-when')?.textContent).toBe('last call just now')

    // The liveness heartbeat keeps the row present; it never keeps the claim.
    advanceClock(12 * MIN)
    touchActivity(d, 'heads-down')
    await pollTick()
    expect(card('heads-down')!.querySelector('.sc-when')?.textContent).toBe('last call 12m ago')

    advanceClock(19 * MIN)
    touchActivity(d, 'heads-down')
    await pollTick()
    expect(card('heads-down')!.querySelector('.sc-state')?.textContent).toBe('Idle')
    expect(signal('agents')).toBe('0')
  })

  it('shows the joined plan on a working card and adds its bar to the Now strip', async () => {
    const d = open()
    upsertBoard(d, {
      ...A, title: 'Cards plan',
      rows: [
        { label: 'Model', status: 'done' }, { label: 'Paint', status: 'partial' }, { label: 'Docs', status: 'missing' },
        {
          label: 'Approve', status: 'blocked', note: 'Ready.', next_step: 'Approve it.', action_owner: 'approval',
          impact: 'Ships it.', options: [{ label: 'Approve', recommended: true }, { label: 'Hold' }],
        },
      ],
    })
    upsertBoard(d, { ...A, agent: 'claude-code', title: 'Someone else', rows: [{ label: 'X', status: 'done' }] })
    work(d, 'mine', 'Painting cards')
    work(d, 'theirs', 'Elsewhere', { stream: 'feature' })
    await bootApp(d)

    // the plan's blocked row is mine's ask, so its card shows the ask; its plan is the Now strip's
    expect(card('mine')!.querySelector('.sc-state')?.textContent).toBe('Needs you')
    expect(card('mine')!.querySelector('.sc-ask-title')?.textContent).toBe('Approve')
    expect(card('theirs')!.querySelector('.sc-plan')).toBeNull()
    // The Now strip's numbers are the lanes' own: working sessions, their plans' bars, the attention set.
    expect(signal('agents')).toBe('2')
    expect(signal('plans')).toBe('1')
    expect(document.querySelector('[data-dashboard-signal="plans"] .dashboard-value-total')?.textContent).toBe('/4')
    expect(document.querySelector('[data-dashboard-signal="plans"] .dash-now-sub')?.textContent).toBe('in sessions')
    expect(signal('waiting')).toBe(String(badgeCount()))
    // The headings carry none of the strip's numbers.
    for (const heading of document.querySelectorAll('#dashboard .dashboard-card-head h2')) {
      expect(heading.textContent).not.toMatch(/\d/)
    }
    // the Working tile opens the Agents home, as G L and the sidebar's Sessions line do
    click(document.querySelector('[data-dashboard-signal="agents"]'))
    expect(document.activeElement).toBe(document.getElementById('agentsHomeTitle'))
  })
})

describe('cards keep moving while the rest of the Dashboard holds (#304)', () => {
  it('updates cards while a draft in the session panel holds its asks', async () => {
    const d = open()
    const id = insertItem(d, { ...A, kind: 'question', title: 'Pick a window' })
    work(d, 'busy', 'Step one')
    await bootApp(d)
    click(document.querySelector(`[data-session-card="ask:item:${id}"] [data-ah-action="review"]`))
    type(document.querySelector<HTMLTextAreaElement>(`[data-panel-ask="${id}"] .reply-input`), 'Thursday')
    const node = card('busy')

    advanceClock()
    work(d, 'busy', 'Step two', { children: [{ name: 'tester', doing: 'Testing' }] })
    await pollTick()

    expect(document.getElementById('pauseHint')?.textContent).toContain('paused')
    expect(card('busy')).toBe(node)
    expect(doing('busy')).toBe('Step two')
    expect(card('busy')!.querySelector('.sc-kids')?.textContent).toBe('▸ 1 subagent')
    expect(document.querySelector<HTMLTextAreaElement>(`[data-panel-ask="${id}"] .reply-input`)?.value).toBe('Thursday')
  })

  it('writes nothing to an unchanged card, whether the tick is idle or changed elsewhere', async () => {
    const d = open()
    work(d, 'busy', 'Step one', { children: [{ name: 'tester', doing: 'Testing' }] })
    upsertBoard(d, { ...A, title: 'Plan', rows: [{ label: 'Build', status: 'done' }, { label: 'Ship', status: 'missing' }] })
    await bootApp(d)
    const mutations: MutationRecord[] = []
    const observer = new MutationObserver((records) => mutations.push(...records))
    observer.observe(document.querySelector('.agents-home .ah-groups')!, { subtree: true, childList: true, characterData: true, attributes: true })

    await pollTick()
    insertItem(d, { project: 'beta', stream: 'main', agent: 'claude', kind: 'note', title: 'Unrelated' })
    await pollTick()
    observer.disconnect()

    expect(document.querySelector('#dashboard')?.textContent).toContain('Step one')
    expect(mutations).toEqual([])
  })

  it('holds cards through a pointer press, then updates the same nodes', async () => {
    const d = open()
    work(d, 'busy', 'Step one')
    await bootApp(d)
    const node = card('busy')!
    await vi.advanceTimersByTimeAsync(2800)
    node.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    work(d, 'busy', 'Step two')
    await vi.advanceTimersByTimeAsync(200)
    expect(doing('busy')).toBe('Step one')

    node.dispatchEvent(new Event('pointerup', { bubbles: true }))
    await pollTick()
    expect(card('busy')).toBe(node)
    expect(doing('busy')).toBe('Step two')
  })

  it('never pulls focus into a background window while its cards update', async () => {
    const d = open()
    work(d, 'talker', 'Step one', { receives_messages: true })
    await bootApp(d)
    const button = card('talker')!.querySelector<HTMLButtonElement>('[data-ah-action="message"]')!
    button.focus()
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')

    work(d, 'talker', 'Step two', { receives_messages: true })
    await pollTick()

    expect(doing('talker')).toBe('Step two')
    expect(document.activeElement).toBe(button)
    expect(focus).not.toHaveBeenCalled()
  })
})

describe('one-shot activity motion (#304: no infinite animation)', () => {
  // Every pulse a paint starts, by session.
  function shots(): string[] {
    const started: string[] = []
    const add = DOMTokenList.prototype.add
    vi.spyOn(DOMTokenList.prototype, 'add').mockImplementation(function (this: DOMTokenList, ...names: string[]) {
      if (names.includes('pulse')) {
        const owner = [...document.querySelectorAll<HTMLElement>('[data-session-card]')].find((el) => el.classList === this)
        if (owner) started.push(owner.dataset.sessionCard!.replace(/^session:/, ''))
      }
      return add.apply(this, names)
    })
    return started
  }

  it('pulses once when a call arrives, never on first paint, an unchanged poll or a forced repaint', async () => {
    const d = open()
    work(d, 'a', 'Working')
    work(d, 'b', 'Also working')
    const started = shots()
    await bootApp(d)
    expect(started).toEqual([])

    await pollTick()
    advanceClock()
    insertItem(d, { project: 'beta', stream: 'main', agent: 'claude', kind: 'note', title: 'Unrelated' })
    await pollTick()
    expect(started).toEqual([])

    advanceClock()
    recordActivityCall(d, 'b')
    await pollTick()
    expect(started).toEqual(['b'])
    expect(card('b')!.classList.contains('pulse')).toBe(true)

    // a paint while it runs keeps it running
    insertItem(d, { project: 'beta', stream: 'main', agent: 'claude', kind: 'note', title: 'Another' })
    await pollTick()
    expect(card('b')!.classList.contains('pulse')).toBe(true)
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()
    expect(started).toHaveLength(1)

    // The one-shot cleans itself up when its animation ends.
    const end = new Event('animationend', { bubbles: true })
    Object.defineProperty(end, 'animationName', { value: 'dash-lane-pulse' })
    card('b')!.dispatchEvent(end)
    expect(card('b')!.classList.contains('pulse')).toBe(false)
  })

  it('removes a one-shot class when its animation is cancelled', async () => {
    const d = open()
    work(d, 'a', 'Working')
    await bootApp(d)
    advanceClock()
    recordActivityCall(d, 'a')
    await pollTick()
    expect(card('a')!.classList.contains('pulse')).toBe(true)
    const other = new Event('animationcancel')
    Object.defineProperty(other, 'animationName', { value: 'dash-focus-in' })
    card('a')!.dispatchEvent(other)
    expect(card('a')!.classList.contains('pulse')).toBe(true)
    const cancel = new Event('animationcancel')
    Object.defineProperty(cancel, 'animationName', { value: 'dash-lane-pulse' })
    card('a')!.dispatchEvent(cancel)
    expect(card('a')!.classList.contains('pulse')).toBe(false)
    await pollTick()
    expect(card('a')!.classList.contains('pulse')).toBe(false)
  })

  it.each([
    ['reduced motion', () => { (window.matchMedia('(prefers-reduced-motion: reduce)') as { matches: boolean }).matches = true }],
    ['Calm', () => { localStorage.setItem('agent-inbox-motion', 'calm') }],
    ['a hidden page', () => { vi.spyOn(document, 'hidden', 'get').mockReturnValue(true) }],
  ] as const)('starts nothing under %s', async (_name, set) => {
    const d = open()
    work(d, 'a', 'Working')
    if (_name === 'Calm') set()
    const started = shots()
    await bootApp(d)
    if (_name !== 'Calm') set()
    advanceClock()
    recordActivityCall(d, 'a')
    await pollTick()
    expect(doing('a')).toBe('Working')
    expect(started).toEqual([])
  })

  it('starts nothing while the Dashboard is not on screen, nor on coming back to it', async () => {
    const d = open()
    work(d, 'a', 'Working')
    const started = shots()
    await bootApp(d)
    click(document.querySelector('.tab[data-tab="needsYou"]'))
    await settle()
    advanceClock()
    recordActivityCall(d, 'a')
    await pollTick()
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()
    expect(started).toEqual([])
  })
})

describe('focus when a card leaves (#304 review, #454)', () => {
  it('hands focus to the Agents heading when the card holding it leaves', async () => {
    const d = open()
    work(d, 'first', 'Working', { receives_messages: true })
    await bootApp(d)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    card('first')!.querySelector<HTMLButtonElement>('[data-ah-action="message"]')!.focus()
    endActivity(d, 'first')
    await pollTick()
    expect(card('first')).toBeNull()
    expect(document.activeElement).toBe(document.getElementById('agentsHomeTitle'))
  })

  it('never pulls focus in a background window when a focused card leaves', async () => {
    const d = open()
    work(d, 'first', 'Working', { receives_messages: true })
    await bootApp(d)
    const button = card('first')!.querySelector<HTMLButtonElement>('[data-ah-action="message"]')!
    button.focus()
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    endActivity(d, 'first')
    await pollTick()
    expect(card('first')).toBeNull()
    expect(focus).not.toHaveBeenCalled()
  })
})

describe('the Dashboard element budget (#304, proposal §10)', () => {
  it('stays within 1,500 elements with fourteen busy sessions, their plans and asks, and a full rail', async () => {
    const d = open()
    for (let index = 0; index < 14; index += 1) {
      const scope = { ...A, stream: `branch-${index}` }
      upsertBoard(d, { ...scope, title: `Plan ${index}`, rows: Array.from({ length: 8 }, (_, row) => ({ label: `Step ${row}`, status: row < 3 ? 'done' : 'missing' })) })
      work(d, `s${index}`, `Session ${index}`, { stream: scope.stream, detail: 'Detail', children: [{ name: 'a', doing: 'x' }, { name: 'b', doing: 'y' }, { name: 'c', doing: 'z' }] })
      insertItem(d, { ...scope, kind: 'question', title: `Ask ${index}`, session: `s${index}` })
      advanceClock()
    }
    await bootApp(d)
    expect(document.querySelectorAll('#dashboard [data-session-card]')).toHaveLength(14)
    const count = document.querySelectorAll('#dashboard *').length
    expect(count).toBeLessThanOrEqual(1500)
  })
})

describe('the call trace and the session-to-plan link on cards (#306)', () => {
  const spark = (session: string) => card(session)!.querySelector<SVGPathElement>('.sc-spark path')!

  it('draws the 30-minute trace as a static path, redrawn by a call and by the clock alone', async () => {
    const d = open()
    work(d, 'busy', 'Step one')
    recordActivityCall(d, 'busy')
    recordActivityCall(d, 'busy')
    await bootApp(d)
    expect(spark('busy').getAttribute('d')).toMatch(/^M58 12v-12h1\.5v12z$/)
    expect(card('busy')!.querySelector('.sc-spark')?.getAttribute('aria-label')).toBe('3 MCP calls in the last 30 minutes')

    // a call two minutes on adds a bar; the old one moves back
    advanceClock(2 * MIN)
    recordActivityCall(d, 'busy')
    await pollTick()
    expect(spark('busy').getAttribute('d')).toBe('M54 12v-12h1.5v12zM58 12v-4h1.5v4z')

    // with no call, the clock alone rolls the bars back once the frame is repainted
    advanceClock(2 * MIN)
    await pollTick()
    expect(spark('busy').getAttribute('d')).toBe('M50 12v-12h1.5v12zM54 12v-4h1.5v4z')

    // nothing about it is animated: no SMIL, no CSS animation on it
    expect(card('busy')!.querySelector('animate, animateTransform, animateMotion')).toBeNull()
    const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8')
    const rules = css.match(/[^}]*\.sc-spark[^{]*\{[^}]*\}/g) ?? []
    expect(rules.length).toBeGreaterThan(0)
    for (const rule of rules) expect(rule).not.toMatch(/animation|transition/)
  })

  it('puts the plan a session stamped on its card, ahead of the project, branch and agent join', async () => {
    const d = open()
    work(d, 'one', 'First')
    work(d, 'two', 'Second')
    upsertBoard(d, { ...A, title: 'Two plan', session: 'two', rows: [{ label: 'Build', status: 'done' }, { label: 'Ship', status: 'missing' }] })
    advanceClock()
    upsertBoard(d, { ...A, title: 'Shared plan', rows: [{ label: 'Build', status: 'missing' }] })
    await bootApp(d)
    const title = (session: string) => card(session)!.querySelector('.sc-plan-text')?.textContent
    // `two` stamped its plan; `one` joins the newest plan nobody present stamped
    expect(title('two')).toBe('1/2 Two plan')
    expect(title('one')).toBe('0/1 Shared plan')

    // `one` writes `two`'s plan: it moves to `one`'s card, and `two` joins what is left
    advanceClock()
    const plan = getBoard(d, 'alpha', 'Two plan')!
    upsertBoard(d, {
      ...A, title: 'Two plan', session: 'one', expectedVersion: plan.revision,
      rows: plan.rows.map((row) => ({ label: row.label, status: row.status, revision: row.revision })),
    })
    await pollTick()
    expect(title('one')).toBe('1/2 Two plan')
    expect(title('two')).toBe('0/1 Shared plan')
  })
})

describe('attention parity with the cards present (#304, #454)', () => {
  const surfaces = async () => {
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

  it('changes no badge, tab or dock read when only the cards change', async () => {
    const d = open()
    work(d, 'asker', 'Step one')
    const asked = insertItem(d, { ...A, kind: 'question', title: 'Ship it?', session: 'asker' })
    const snoozed = insertItem(d, { ...A, kind: 'question', title: 'Later', session: 'asker' })
    snoozeItem(d, snoozed, new Date(Date.now() + 60 * MIN).toISOString())
    upsertBoard(d, { ...A, title: 'Plan', rows: [{ label: 'Build', status: 'tracked' }, { label: 'Test', status: 'missing' }] })
    const reads = new Set<string>()
    await bootApp(d, { interceptFetch: async (input, _init, next) => { reads.add(String(input).split('?')[0]!); return next() } })
    const before = await surfaces()

    advanceClock(6 * MIN)
    work(d, 'asker', 'Step two', { detail: 'more', children: [{ name: 'helper', doing: 'Helping' }] })
    const plan = getBoard(d, 'alpha', 'Plan')!
    upsertBoard(d, {
      ...A, title: 'Plan', expectedVersion: plan.revision, session: 'asker',
      rows: [
        { label: 'Build', status: 'done', revision: plan.rows[0]!.revision },
        { label: 'Test', status: 'missing', revision: plan.rows[1]!.revision },
      ],
    })
    work(d, 'second', 'Another session')
    reads.clear()
    await pollTick()

    expect(cardIds()).toEqual(['asker', 'second'])
    expect(await surfaces()).toEqual(before)
    // The card's ask is the attention set's own, and a snoozed one is not drawn.
    const asks = sortRail(attentionEntries([getItem(d, asked)!, getItem(d, snoozed)!], [], Date.now(), ['asker', 'second']), Date.now())
    expect(asks.map((entry) => entry.kind === 'item' && entry.item.id)).toEqual([asked])
    expect(card('asker')!.querySelector('.sc-ask-title')?.textContent).toBe('Ship it?')
    expect(card('asker')!.querySelector('.sc-ask-more')).toBeNull()
    // No new poll reads.
    expect([...reads].sort()).toEqual([
      '/api/activity', '/api/activity/history', '/api/boards', '/api/boards/archived/summary', '/api/issues',
      '/api/items', '/api/links', '/api/messages', '/api/projects/closed',
    ])
  })
})
