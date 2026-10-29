// @vitest-environment jsdom
// Dashboard 2.0 phase 2 (#304): live lanes and the Now strip. Lanes are updated
// in place by the ambient painter, keyed by session; a rail draft, a held
// pointer and a background window never stop them or pull focus; the Now strip
// reads the lanes' own model; and nothing here reaches attention.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { getBoard, getItem, insertItem, recordActivityCall, snoozeItem, touchActivity, upsertActivity, upsertBoard } from '../../src/store.js'
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

const lane = (session: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`#dashboard .dash-lane[data-lane="${session}"]`)
const laneIds = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('#dashboard .dash-lane')].map((el) => el.dataset.lane!)
const doing = (session: string): string => lane(session)?.querySelector('.dash-lane-doing')?.textContent ?? ''
const signal = (name: string): string =>
  document.querySelector(`[data-dashboard-signal="${name}"] .dashboard-value`)?.textContent ?? ''
const railIds = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('#dashRail [data-rail-card]')].map((card) => card.dataset.railCard!)

// A real MCP call stamps last_call_at, then status() claims the work.
function work(d: Database.Database, session: string, what: string, extra: Record<string, unknown> = {}): void {
  upsertActivity(d, { ...A, session, doing: what, idle: false, ...extra })
  recordActivityCall(d, session)
  upsertActivity(d, { ...A, session, doing: what, idle: false, ...extra })
}

describe('live lanes (#304)', () => {
  it('updates each lane in place across polls, pins order and appends new sessions', async () => {
    const d = open()
    work(d, 'first', 'Writing the store')
    advanceClock()
    work(d, 'second', 'Reviewing the diff')
    await bootApp(d)
    // A forced paint orders by the newest call.
    expect(laneIds()).toEqual(['second', 'first'])
    const nodes = laneIds().map(lane)

    advanceClock()
    work(d, 'first', 'Running the tests', { detail: 'vitest, 2 workers' })
    advanceClock()
    work(d, 'third', 'Drafting the PR')
    await pollTick()

    // The newest call no longer re-sorts: the order is pinned, the new one appends.
    expect(laneIds()).toEqual(['second', 'first', 'third'])
    expect([lane('second'), lane('first')]).toEqual(nodes)
    expect(doing('first')).toBe('Running the tests')
    expect(lane('first')!.querySelector('.dash-lane-detail')?.textContent).toBe('vitest, 2 workers')
    // A lane that only just appeared does not pulse; the one whose call moved does.
    expect([...document.querySelectorAll<HTMLElement>('.dash-lane.pulse')].map((el) => el.dataset.lane)).toEqual(['first'])
    expect([...document.querySelectorAll<HTMLElement>('.dash-lane.sweep')].map((el) => el.dataset.lane)).toEqual(['first'])

    // A frame the human asked for re-sorts.
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()
    expect(laneIds()).toEqual(['third', 'first', 'second'])
    expect(lane('second')).toBe(nodes[0])
  })

  it('says quiet after five minutes without a call, then folds the lane once its claim decays', async () => {
    const d = open()
    work(d, 'heads-down', 'Long build')
    await bootApp(d)
    expect(lane('heads-down')!.querySelector('.dash-lane-recency')?.textContent).toBe('just now')

    // The liveness heartbeat keeps the row present; it never keeps the claim.
    advanceClock(12 * MIN)
    touchActivity(d, 'heads-down')
    await pollTick()
    expect(lane('heads-down')!.classList.contains('quiet')).toBe(true)
    expect(lane('heads-down')!.querySelector('.dash-lane-recency')?.textContent).toBe('quiet 12m')

    advanceClock(19 * MIN)
    touchActivity(d, 'heads-down')
    await pollTick()
    expect(lane('heads-down')).toBeNull()
    expect(document.querySelector('.dash-lanes-idle')?.textContent).toBe('+1 idle connection')
  })

  it('joins the plan by project, branch and agent and adds its bar to the Now strip', async () => {
    const d = open()
    upsertBoard(d, {
      ...A, title: 'Lanes plan',
      rows: [
        { label: 'Model', status: 'done' }, { label: 'Paint', status: 'partial' }, { label: 'Docs', status: 'missing' },
        {
          label: 'Approve', status: 'blocked', note: 'Ready.', next_step: 'Approve it.', action_owner: 'approval',
          impact: 'Ships it.', options: [{ label: 'Approve', recommended: true }, { label: 'Hold' }],
        },
      ],
    })
    upsertBoard(d, { ...A, agent: 'claude-code', title: 'Someone else', rows: [{ label: 'X', status: 'done' }] })
    work(d, 'mine', 'Painting lanes')
    work(d, 'theirs', 'Elsewhere', { stream: 'feature' })
    await bootApp(d)

    const bar = lane('mine')!.querySelector('.dash-lane-plan')!
    expect(bar.querySelector('.dash-lane-plan-count')?.textContent).toBe('1/4')
    expect(bar.querySelector('.dash-lane-bar')?.getAttribute('aria-label'))
      .toBe('Lanes plan: 1 done, 1 in progress, 1 waiting on you, 1 to do')
    expect(lane('theirs')!.querySelector<HTMLElement>('.dash-lane-plan')?.hidden).toBe(true)
    // The Now strip's numbers are the lanes' own: working sessions, their plans' bars, the attention set.
    expect(signal('agents')).toBe(String(laneIds().length))
    expect(signal('plans')).toBe('1')
    expect(document.querySelector('[data-dashboard-signal="plans"] .dashboard-value-total')?.textContent).toBe('/4')
    expect(signal('waiting')).toBe(String(badgeCount()))
    // The headings carry none of the strip's numbers.
    for (const heading of document.querySelectorAll('#dashboard .dashboard-card-head h2')) {
      expect(heading.textContent).not.toMatch(/\d/)
    }
  })

  it('jumps from "Asking you" to the rail card, and past the rail to the Inbox', async () => {
    const d = open()
    work(d, 'asker', 'Waiting on a decision')
    const ids: string[] = []
    for (let index = 0; index < 4; index += 1) {
      ids.push(insertItem(d, { ...A, kind: 'question', title: `Decision ${index}`, session: 'asker' }))
      advanceClock(30 * MIN)
    }
    work(d, 'asker', 'Waiting on a decision')
    await bootApp(d)

    const strip = lane('asker')!.querySelector<HTMLElement>('.dash-lane-ask')!
    expect(strip.hidden).toBe(false)
    expect(strip.querySelector('.dash-lane-ask-title')?.textContent).toBe('Decision 0')
    expect(strip.querySelector('.dash-lane-ask-more')?.textContent).toBe(' +3 more')
    expect(strip.querySelector('.dash-lane-waiting')?.textContent).toBe('waiting on you 2h')
    expect(railIds()).toEqual(ids.slice(0, 3))

    click(strip.querySelector('.dash-lane-asking'))
    expect(document.activeElement).toBe(document.querySelector(`#dashRail [data-rail-card="${ids[0]}"]`))

  })

  it('opens an ask past the rail in the Inbox', async () => {
    const d = open()
    work(d, 'other', 'Asking first')
    for (let index = 0; index < 3; index += 1) {
      insertItem(d, { ...A, kind: 'question', title: `Older ${index}`, session: 'other' })
      advanceClock()
    }
    work(d, 'asker', 'Asking later')
    const late = insertItem(d, { ...A, kind: 'question', title: 'Late decision', session: 'asker' })
    await bootApp(d)
    expect(railIds()).not.toContain(late)

    click(lane('asker')!.querySelector('.dash-lane-waiting'))
    await settle()
    expect(document.getElementById('needsYou')?.hidden).toBe(false)
    expect(row(late)).not.toBeNull()
  })
})

describe('lanes keep moving while the rest of the Dashboard holds (#304)', () => {
  it('updates lanes while a rail draft holds the rail', async () => {
    const d = open()
    const id = insertItem(d, { ...A, kind: 'question', title: 'Pick a window' })
    work(d, 'busy', 'Step one')
    await bootApp(d)
    click(document.querySelector(`[data-rail-card="${id}"] [data-rail-action="expand"]`))
    type(document.querySelector<HTMLTextAreaElement>(`[data-rail-card="${id}"] .reply-input`), 'Thursday')
    const node = lane('busy')

    advanceClock()
    work(d, 'busy', 'Step two', { children: [{ name: 'tester', doing: 'Testing' }] })
    await pollTick()

    expect(document.getElementById('pauseHint')?.textContent).toContain('paused')
    expect(lane('busy')).toBe(node)
    expect(doing('busy')).toBe('Step two')
    expect(lane('busy')!.querySelector('.dash-lane-child')?.textContent).toBe('tester')
    expect(document.querySelector<HTMLTextAreaElement>(`[data-rail-card="${id}"] .reply-input`)?.value).toBe('Thursday')
  })

  it('writes nothing to an unchanged lane, whether the tick is idle or changed elsewhere', async () => {
    const d = open()
    work(d, 'busy', 'Step one', { children: [{ name: 'tester', doing: 'Testing' }] })
    upsertBoard(d, { ...A, title: 'Plan', rows: [{ label: 'Build', status: 'done' }, { label: 'Ship', status: 'missing' }] })
    await bootApp(d)
    const mutations: MutationRecord[] = []
    const observer = new MutationObserver((records) => mutations.push(...records))
    observer.observe(document.querySelector('.dash-lane-list')!, { subtree: true, childList: true, characterData: true, attributes: true })

    await pollTick()
    insertItem(d, { project: 'beta', stream: 'main', agent: 'claude', kind: 'note', title: 'Unrelated' })
    await pollTick()
    observer.disconnect()

    expect(document.querySelector('#dashboard')?.textContent).toContain('Step one')
    expect(mutations).toEqual([])
  })

  it('holds lanes through a pointer press, then updates the same nodes', async () => {
    const d = open()
    work(d, 'busy', 'Step one')
    await bootApp(d)
    const node = lane('busy')!
    await vi.advanceTimersByTimeAsync(2800)
    node.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    work(d, 'busy', 'Step two')
    await vi.advanceTimersByTimeAsync(200)
    expect(doing('busy')).toBe('Step one')
    expect(document.getElementById('pauseHint')?.textContent).toBe('')

    node.dispatchEvent(new Event('pointerup', { bubbles: true }))
    await pollTick()
    expect(lane('busy')).toBe(node)
    expect(doing('busy')).toBe('Step two')
  })

  it('never pulls focus into a background window while its lanes update', async () => {
    const d = open()
    work(d, 'asker', 'Step one')
    insertItem(d, { ...A, kind: 'question', title: 'Ship it?', session: 'asker' })
    await bootApp(d)
    const button = lane('asker')!.querySelector<HTMLButtonElement>('.dash-lane-asking')!
    button.focus()
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')

    work(d, 'asker', 'Step two')
    await pollTick()

    expect(doing('asker')).toBe('Step two')
    expect(lane('asker')!.querySelector('.dash-lane-asking')).toBe(button)
    expect(document.activeElement).toBe(button)
    expect(focus).not.toHaveBeenCalled()
  })
})

describe('one-shot activity motion (#304: no infinite animation)', () => {
  // Every class a paint starts a one-shot with, as [session, name].
  function shots(): Array<[string, string]> {
    const started: Array<[string, string]> = []
    const add = DOMTokenList.prototype.add
    vi.spyOn(DOMTokenList.prototype, 'add').mockImplementation(function (this: DOMTokenList, ...names: string[]) {
      const lane = document.querySelector<HTMLElement>('.dash-lane-list')
      for (const name of names) {
        if (name !== 'pulse' && name !== 'sweep') continue
        const owner = [...(lane?.children ?? [])].find((el) => el.classList === this) as HTMLElement | undefined
        if (owner) started.push([owner.dataset.lane!, name])
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
    expect(started).toEqual([['b', 'pulse'], ['b', 'sweep']])
    expect(lane('b')!.classList.contains('pulse')).toBe(true)

    await pollTick()
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()
    expect(started).toHaveLength(2)

    // The one-shot cleans itself up when its animation ends.
    const end = new Event('animationend', { bubbles: true })
    Object.defineProperty(end, 'animationName', { value: 'dash-lane-pulse' })
    lane('b')!.dispatchEvent(end)
    expect(lane('b')!.classList.contains('pulse')).toBe(false)
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

describe('focus when a lane control leaves (#304 review)', () => {
  const finish = (d: Database.Database, session: string) =>
    upsertActivity(d, { ...A, session, doing: 'open', idle: true })

  it('hands focus to the adjacent lane control, then to the heading', async () => {
    const d = open()
    work(d, 'first', 'Asking first')
    insertItem(d, { ...A, kind: 'question', title: 'First ask', session: 'first' })
    advanceClock()
    work(d, 'second', 'Asking second')
    insertItem(d, { ...A, kind: 'question', title: 'Second ask', session: 'second' })
    await bootApp(d)
    expect(laneIds()).toEqual(['second', 'first'])
    lane('second')!.querySelector<HTMLButtonElement>('.dash-lane-asking')!.focus()

    finish(d, 'second')
    await pollTick()
    expect(lane('second')).toBeNull()
    expect(document.activeElement).toBe(lane('first')!.querySelector('.dash-lane-asking'))

    finish(d, 'first')
    await pollTick()
    expect(document.activeElement).toBe(document.getElementById('dashLanesTitle'))
  })

  it('never pulls focus in a background window when a focused lane leaves', async () => {
    const d = open()
    work(d, 'first', 'Asking first')
    insertItem(d, { ...A, kind: 'question', title: 'First ask', session: 'first' })
    work(d, 'second', 'Working')
    await bootApp(d)
    const button = lane('first')!.querySelector<HTMLButtonElement>('.dash-lane-asking')!
    button.focus()
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    button.dispatchEvent(new FocusEvent('blur'))
    button.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')

    finish(d, 'first')
    await pollTick()

    expect(lane('first')).toBeNull()
    expect(focus).not.toHaveBeenCalled()
  })
})

describe('the Dashboard element budget (#304, proposal §10)', () => {
  it('stays within 1,500 elements with twelve busy lanes, more working and a full rail', async () => {
    const d = open()
    for (let index = 0; index < 14; index += 1) {
      const scope = { ...A, stream: `branch-${index}` }
      upsertBoard(d, { ...scope, title: `Plan ${index}`, rows: Array.from({ length: 8 }, (_, row) => ({ label: `Step ${row}`, status: row < 3 ? 'done' : 'missing' })) })
      work(d, `s${index}`, `Lane ${index}`, { stream: scope.stream, detail: 'Detail', children: [{ name: 'a', doing: 'x' }, { name: 'b', doing: 'y' }, { name: 'c', doing: 'z' }] })
      insertItem(d, { ...scope, kind: 'question', title: `Ask ${index}`, session: `s${index}` })
      advanceClock()
    }
    await bootApp(d)
    expect(document.querySelectorAll('#dashboard .dash-lane')).toHaveLength(12)
    expect(document.querySelector('.dash-lanes-more')?.textContent).toBe('+2 more working')
    const count = document.querySelectorAll('#dashboard *').length
    expect(count).toBeLessThanOrEqual(1500)
  })
})

describe('attention parity with lanes present (#304)', () => {
  const surfaces = async () => {
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

  it('changes no badge, tab, rail card or dock read when only the lanes change', async () => {
    const d = open()
    work(d, 'asker', 'Step one')
    const asked = insertItem(d, { ...A, kind: 'question', title: 'Ship it?', session: 'asker' })
    const snoozed = insertItem(d, { ...A, kind: 'question', title: 'Later', session: 'asker' })
    snoozeItem(d, snoozed, new Date(Date.now() + 60 * MIN).toISOString())
    upsertBoard(d, { ...A, title: 'Plan', rows: [{ label: 'Build', status: 'tracked' }, { label: 'Test', status: 'missing' }] })
    const reads = new Set<string>()
    await bootApp(d, { interceptFetch: async (input, _init, next) => { reads.add(String(input).split('?')[0]!); return next() } })
    const before = await surfaces()

    // Only what lanes draw moves: the claim, its detail, subagents, the plan's progress, quiet time.
    advanceClock(6 * MIN)
    work(d, 'asker', 'Step two', { detail: 'more', children: [{ name: 'helper', doing: 'Helping' }] })
    const plan = getBoard(d, 'alpha', 'Plan')!
    upsertBoard(d, {
      ...A, title: 'Plan', expectedVersion: plan.revision,
      rows: [
        { label: 'Build', status: 'done', revision: plan.rows[0]!.revision },
        { label: 'Test', status: 'missing', revision: plan.rows[1]!.revision },
      ],
    })
    work(d, 'second', 'Another lane')
    reads.clear()
    await pollTick()

    expect(laneIds()).toEqual(['asker', 'second'])
    expect(lane('asker')!.querySelector('.dash-lane-plan-count')?.textContent).toBe('1/2')
    expect(await surfaces()).toEqual(before)
    // The lane's ask is the attention set's own, and a snoozed one is not drawn.
    const asks = sortRail(attentionEntries([getItem(d, asked)!, getItem(d, snoozed)!], [], Date.now(), ['asker', 'second']), Date.now())
    expect(asks.map((entry) => entry.kind === 'item' && entry.item.id)).toEqual([asked])
    expect(lane('asker')!.querySelector('.dash-lane-ask-title')?.textContent).toBe('Ship it?')
    expect(lane('asker')!.querySelector('.dash-lane-ask-more')?.textContent).toBe('')
    // No new poll reads.
    expect([...reads].sort()).toEqual([
      '/api/activity', '/api/activity/history', '/api/boards', '/api/boards/archived/summary', '/api/issues',
      '/api/items', '/api/links', '/api/projects/closed',
    ])
  })
})
