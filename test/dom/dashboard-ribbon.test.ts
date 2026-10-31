// @vitest-environment jsdom
// Dashboard 2.0 phase 3 (#305): the Today ribbon, Just landed and "Since you
// last looked". The ribbon updates in place and never animates; Just landed's
// arrival highlight is a one-shot per new outcome under the lanes' motion gate;
// nothing here reaches attention and the poll reads nothing new.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import {
  archiveBoard, endActivity, getBoard, insertItem, recordActivityCall, resolveItem, updateBoardRow, upsertActivity,
  upsertBoard, upsertSourceLink,
} from '../../src/store.js'
import {
  T0, advanceClock, badgeCount, bootApp, click, freshDb, pollTick, settle, tabCount, useDomTest,
} from './harness.js'

// jsdom can only dispatch untrusted events, and the app ignores those for
// "Since you last looked" (#305 review). This file stands in for the human's
// own input; test/dom/dashboard.test.ts keeps the real check and shows a
// scripted key press does not dismiss the line.
vi.mock('../../public/ribbon.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../public/ribbon.js')>(),
  trustedInput: () => true,
}))

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null; vi.restoreAllMocks() })

const A = { project: 'alpha', stream: 'main', agent: 'copilot' } as const
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

function open(): Database.Database {
  db = freshDb()
  return db
}

function span(d: Database.Database, session: string, startMs: number, endMs: number, scope: Record<string, string> = A): void {
  vi.setSystemTime(startMs)
  upsertActivity(d, { ...A, ...scope, session, doing: `Work for ${session}` })
  vi.setSystemTime(endMs)
  endActivity(d, session)
}

function land(d: Database.Database, title: string, extra: Record<string, unknown> = {}): string {
  advanceClock()
  const id = insertItem(d, { ...A, kind: 'done', title, ...extra })
  resolveItem(d, id, `${title} landed.`)
  return id
}

const range = () => document.querySelector<HTMLSelectElement>('.dashboard-range')!
const ribbonLanes = () => [...document.querySelectorAll<HTMLElement>('.dash-ribbon-lane')].map((el) => el.dataset.ribbonProject)
const landedTitles = () => [...document.querySelectorAll('.dashboard-outcome strong')].map((el) => el.textContent)
const since = () => document.querySelector<HTMLElement>('.dash-since')!

// Every outcome row a paint starts the arrival highlight on, by title. New rows
// are built before they are inserted, so the class lists are resolved after.
function arrivals(): { titles: () => string[] } {
  const lists: DOMTokenList[] = []
  const add = DOMTokenList.prototype.add
  vi.spyOn(DOMTokenList.prototype, 'add').mockImplementation(function (this: DOMTokenList, ...names: string[]) {
    if (names.includes('arrived')) lists.push(this)
    return add.apply(this, names)
  })
  return {
    titles: () => lists.map((list) => [...document.querySelectorAll('.dashboard-outcome')]
      .find((el) => el.classList === list)?.querySelector('strong')?.textContent ?? '?'),
  }
}

describe('the Today ribbon (#305)', () => {
  it('draws one lane per project with work, a static live tail, ◆ asks and ● outcomes', async () => {
    const d = open()
    // Spans without calls are capped once cold, so these stay under 30 minutes.
    span(d, 'done-a', T0 - 5 * HOUR, T0 - 5 * HOUR + 20 * MIN)
    span(d, 'beta-1', T0 - 3 * HOUR, T0 - 3 * HOUR + 20 * MIN, { project: 'beta' })
    vi.setSystemTime(T0 - 10 * MIN)
    upsertActivity(d, { ...A, session: 'live', doing: 'Shipping', idle: false })
    insertItem(d, { ...A, project: 'gamma', kind: 'question', title: 'Approve gamma?' })
    land(d, 'Alpha release')
    vi.setSystemTime(T0)
    await bootApp(d)

    expect(ribbonLanes()).toEqual(['alpha', 'beta', 'gamma'])
    const alpha = document.querySelector('[data-ribbon-project="alpha"]')!
    expect(alpha.querySelectorAll('.dash-ribbon-bar')).toHaveLength(2)
    expect(alpha.querySelector('.dash-ribbon-bar.live')?.getAttribute('style')).toMatch(/--live-from:\s*0%/)
    expect(alpha.querySelector('.dash-ribbon-mark.outcome')?.getAttribute('title')).toMatch(/^Landed: Alpha release · /)
    expect(document.querySelector('[data-ribbon-project="gamma"] .dash-ribbon-mark.ask.open')?.textContent).toBe('◆')
    expect(document.querySelector('.dashboard-activity-total strong')?.textContent).toBe('50m')
  })

  it('keeps the range menu, its value and its focus across polls, a changed ribbon and a history error', async () => {
    const d = open()
    span(d, 'one', T0 - 2 * DAY, T0 - 2 * DAY + HOUR)
    vi.setSystemTime(T0)
    let failHistory = false
    await bootApp(d, {
      interceptFetch: async (input, _init, next) => failHistory && String(input).startsWith('/api/activity/history')
        ? new Response('unavailable', { status: 503 })
        : next(),
    })
    const menu = range()
    expect(ribbonLanes()).toEqual([])
    menu.focus()
    menu.value = String(7 * DAY)
    menu.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    expect(ribbonLanes()).toEqual(['alpha'])
    const lane = document.querySelector('.dash-ribbon-lane')!

    span(d, 'two', T0 - HOUR, T0 + 1000, { project: 'beta' })
    vi.setSystemTime(T0 + 2000)
    await pollTick()
    expect(ribbonLanes()).toEqual(['alpha', 'beta'])
    expect(document.querySelector('.dash-ribbon-lane')).toBe(lane)

    failHistory = true
    await pollTick()
    expect(document.querySelector('.dashboard-history-error')?.textContent).toBe('History unavailable')
    failHistory = false
    await pollTick()
    expect(ribbonLanes()).toEqual(['alpha', 'beta'])
    for (const check of [range(), document.activeElement]) expect(check).toBe(menu)
    expect(menu.value).toBe(String(7 * DAY))
    expect(document.querySelector('.dash-ribbon-title')?.textContent).toBe('Last 7 days')
  })

  it('leaves an unchanged lane untouched by a poll', async () => {
    const d = open()
    span(d, 'one', T0 - 2 * HOUR, T0 - HOUR)
    await bootApp(d)
    const track = document.querySelector('.dash-ribbon-track')!
    const bar = track.firstElementChild
    insertItem(d, { ...A, project: 'beta', kind: 'note', title: 'Unrelated' })
    await pollTick()
    expect(track.firstElementChild).toBe(bar)
  })

  // #305 review: a live bar grows with the clock; its node and tooltip stay.
  it('moves a live bar in place across ticks instead of rewriting its track', async () => {
    const d = open()
    vi.setSystemTime(T0 - 10 * MIN)
    upsertActivity(d, { ...A, session: 'live', doing: 'Shipping', idle: false })
    vi.setSystemTime(T0)
    await bootApp(d)
    const track = document.querySelector<HTMLElement>('.dash-ribbon-track')!
    const bar = track.querySelector<HTMLElement>('.dash-ribbon-bar.live')!
    const before = bar.getAttribute('style')
    const writes = vi.spyOn(Element.prototype, 'innerHTML', 'set')
    for (let tick = 0; tick < 4; tick += 1) {
      advanceClock(5 * MIN)
      recordActivityCall(d, 'live')
      await pollTick()
    }
    expect(writes.mock.contexts.filter((el) => el === track)).toEqual([])
    expect(track.querySelector('.dash-ribbon-bar.live')).toBe(bar)
    expect(bar.getAttribute('style')).not.toBe(before)
    expect(bar.getAttribute('title')).toMatch(/–now \(working\)$/)
  })

  it('draws no marker before what the page proves complete, and says so (#184)', async () => {
    const d = open()
    vi.setSystemTime(T0 - 20 * HOUR)
    const early = insertItem(d, { ...A, kind: 'question', title: 'Early ask' })
    resolveItem(d, early)
    // Sixty newer closed items push the early one off the page.
    for (let index = 0; index < 60; index += 1) land(d, `Closed ${index}`)
    vi.setSystemTime(T0)
    await bootApp(d)
    const titles = [...document.querySelectorAll('.dash-ribbon-mark')].map((mark) => mark.getAttribute('title'))
    expect(titles.some((title) => title?.includes('Early ask'))).toBe(false)
    expect(document.querySelector('.dash-ribbon-note')?.textContent).toMatch(/^Asks and outcomes from /)
    // Heard as well as seen: the note is outside anything hidden from assistive tech.
    expect(document.querySelector('.dash-ribbon-note')?.closest('[aria-hidden="true"]')).toBeNull()
  })
})

// #392: a longer range the page cannot prove reads the complete closed history
// (and archived plans) once, on the human's own change; passive paths never do.
describe('older history for a longer ribbon range (#392)', () => {
  const HISTORY = '/api/items/history'
  const ARCHIVED = '/api/boards/archived'
  const note = () => document.querySelector('.dash-ribbon-note')?.textContent ?? ''
  const markTitles = () => [...document.querySelectorAll('.dash-ribbon-mark')].map((mark) => mark.getAttribute('title') ?? '')
  const pick = async (ms: number) => {
    range().value = String(ms)
    range().dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
  }

  // An ask closed three days ago, then sixty outcomes in the last hour push it
  // off the page: the page proves 24 hours, not 7 days.
  function seedOldAsk(d: Database.Database): void {
    vi.setSystemTime(T0 - 3 * DAY)
    resolveItem(d, insertItem(d, { ...A, kind: 'question', title: 'Early ask' }))
    vi.setSystemTime(T0 - HOUR)
    for (let index = 0; index < 60; index += 1) land(d, `Closed ${index}`)
    vi.setSystemTime(T0)
  }

  function recorder(fail: { history?: boolean; archived?: boolean } = {}) {
    const reads: string[] = []
    const statuses: Array<{ path: string; status: number }> = []
    return {
      reads,
      statuses,
      interceptFetch: async (input: RequestInfo | URL, init: RequestInit | undefined, next: () => Promise<Response>) => {
        const path = String(input).split('?')[0]!
        if ((init?.method ?? 'GET') === 'GET') reads.push(path)
        const response = (fail.history && path === HISTORY) || (fail.archived && path === ARCHIVED)
          ? new Response('unavailable', { status: 500 })
          : await next()
        statuses.push({ path, status: response.status })
        return response
      },
    }
  }

  it('reads no older history at 24 hours, across several polls', async () => {
    const d = open()
    seedOldAsk(d)
    const { reads, interceptFetch } = recorder()
    await bootApp(d, { interceptFetch })
    for (let tick = 0; tick < 3; tick += 1) await pollTick()
    expect(reads.filter((path) => path === HISTORY)).toEqual([])
    expect(note()).toMatch(/^Asks and outcomes from /)
  })

  it('reads it once when the human picks 7 days, then draws the older ask and drops the note', async () => {
    const d = open()
    seedOldAsk(d)
    const { reads, interceptFetch } = recorder()
    await bootApp(d, { interceptFetch })
    expect(markTitles().some((title) => title.includes('Early ask'))).toBe(false)
    reads.length = 0
    await pick(7 * DAY)
    expect(reads.filter((path) => path === HISTORY)).toHaveLength(1)
    expect(markTitles().some((title) => title.includes('Early ask'))).toBe(true)
    expect(note()).toBe('')
    // The next poll keeps it: historyWanted judges the page, which still omits it.
    await pollTick()
    expect(markTitles().some((title) => title.includes('Early ask'))).toBe(true)
    expect(note()).toBe('')
  })

  it('stops reading once the range returns to 24 hours', async () => {
    const d = open()
    seedOldAsk(d)
    const { reads, interceptFetch } = recorder()
    await bootApp(d, { interceptFetch })
    await pick(7 * DAY)
    await pick(DAY)
    reads.length = 0
    for (let tick = 0; tick < 3; tick += 1) await pollTick()
    expect(reads.filter((path) => path === HISTORY)).toEqual([])
    expect(note()).toMatch(/^Asks and outcomes from /)
  })

  it('reads nothing at a range the page proves, and reads at one it does not', async () => {
    const d = open()
    // Everything the page omits closed more than eight days ago: 7 days is
    // proven, 30 days is not.
    vi.setSystemTime(T0 - 10 * DAY)
    resolveItem(d, insertItem(d, { ...A, kind: 'question', title: 'Old ask' }))
    vi.setSystemTime(T0 - 8 * DAY)
    for (let index = 0; index < 60; index += 1) land(d, `Closed ${index}`)
    vi.setSystemTime(T0)
    const { reads, interceptFetch } = recorder()
    await bootApp(d, { interceptFetch })
    await pick(7 * DAY)
    await pollTick()
    expect(reads.filter((path) => path === HISTORY)).toEqual([])
    expect(note()).toBe('')
    await pick(30 * DAY)
    expect(reads.filter((path) => path === HISTORY)).toHaveLength(1)
    expect(markTitles().some((title) => title.includes('Old ask'))).toBe(true)
  })

  it('keeps the note and says older history is unavailable when the read fails', async () => {
    const d = open()
    seedOldAsk(d)
    const fail = { history: true }
    const { interceptFetch } = recorder(fail)
    await bootApp(d, { interceptFetch })
    await pick(7 * DAY)
    expect(note()).toMatch(/^Asks and outcomes from .* · Older history is unavailable right now\.$/)
    expect(ribbonLanes()).toEqual(['alpha'])
    // A later poll that reads it fills the ribbon in.
    fail.history = false
    await pollTick()
    expect(note()).toBe('')
    expect(markTitles().some((title) => title.includes('Early ask'))).toBe(true)
  })

  // Six outcomes on one archived plan, two of them three days old: the brief
  // carries the project's newest four, so 7 days needs the complete list.
  function seedArchived(d: Database.Database): void {
    const scope = { ...A, title: 'Shipped plan' }
    vi.setSystemTime(T0 - 3 * DAY)
    upsertBoard(d, { ...scope, rows: [{ label: 'Step', status: 'tracked' }] })
    // Six outcomes: the brief carries the project's newest four.
    for (let index = 0; index < 6; index += 1) {
      vi.setSystemTime(index < 2 ? T0 - 3 * DAY + index * MIN : T0 - HOUR + index * MIN)
      updateBoardRow(d, {
        ...scope, expectedBoardVersion: getBoard(d, A.project, scope.title)!.revision,
        label: `Row ${index}`, status: 'done', outcome: `Row ${index} shipped.`,
      })
    }
    vi.setSystemTime(T0 - 10 * MIN)
    const board = getBoard(d, A.project, scope.title)!
    expect(archiveBoard(d, board.id, board.revision)).toBe(true)
    vi.setSystemTime(T0)
  }

  it('reads the complete archived plans once when their omitted outcomes fall in the range', async () => {
    const d = open()
    seedArchived(d)
    const { reads, interceptFetch } = recorder()
    await bootApp(d, { interceptFetch })
    for (let tick = 0; tick < 2; tick += 1) await pollTick()
    expect(reads.filter((path) => path === ARCHIVED)).toEqual([])
    reads.length = 0
    await pick(7 * DAY)
    expect(reads.filter((path) => path === ARCHIVED)).toHaveLength(1)
    expect(markTitles().filter((title) => title.startsWith('Landed: Row'))).toHaveLength(6)
    expect(note()).toBe('')
  })

  it('keeps the note and says archived plans are unavailable when that read fails', async () => {
    const d = open()
    seedArchived(d)
    const { interceptFetch } = recorder({ archived: true })
    await bootApp(d, { interceptFetch })
    await pick(7 * DAY)
    expect(note()).toMatch(/^Asks and outcomes from .* · Archived plans are unavailable right now\.$/)
    expect(ribbonLanes()).toEqual(['alpha'])
  })

  it('stays idle at 7 days: the history read revalidates and the ribbon is not rebuilt', async () => {
    const d = open()
    seedOldAsk(d)
    const { statuses, interceptFetch } = recorder()
    await bootApp(d, { interceptFetch })
    await pick(7 * DAY)
    await pollTick()
    const part = () => document.querySelector('#dashboard .dashboard-activity > :not(.dashboard-card-head)')
    const node = part()
    expect(node).not.toBeNull()
    statuses.length = 0
    for (let tick = 0; tick < 3; tick += 1) {
      await pollTick()
      expect(part()).toBe(node)
    }
    expect(statuses.filter((read) => read.path === HISTORY).map((read) => read.status)).toEqual([304, 304, 304])
  })

  it('changes no attention surface and keeps the nine poll reads at 24 hours', async () => {
    const d = open()
    seedOldAsk(d)
    insertItem(d, { ...A, kind: 'question', title: 'Ship it?' })
    const { reads, interceptFetch } = recorder()
    await bootApp(d, { interceptFetch })
    const before = { title: document.title, badge: badgeCount(), tabs: ['needsYou', 'notes', 'boards'].map(tabCount) }
    await pick(7 * DAY)
    expect({ title: document.title, badge: badgeCount(), tabs: ['needsYou', 'notes', 'boards'].map(tabCount) }).toEqual(before)
    await pick(DAY)
    reads.length = 0
    await pollTick()
    expect(new Set(reads)).toEqual(new Set([
      '/api/activity', '/api/activity/history', '/api/boards', '/api/boards/archived/summary', '/api/issues',
      '/api/items', '/api/links', '/api/messages', '/api/projects/closed',
    ]))
    expect(reads).toHaveLength(9)
  })
})

describe('Just landed (#305)', () => {
  const openPr = (d: Database.Database, branch: string) => upsertSourceLink(d, {
    repo: 'acme/app', branch, pr_number: 7, pr_state: 'OPEN', pr_title: 'Open PR', pr_url: 'https://github.com/acme/app/pull/7',
  })

  it('never lists an open ask\'s open PR, says how many it leaves out, and keeps four rows', async () => {
    const d = open()
    const pr = { repo: 'acme/app', stream: 'feat-x' }
    for (let index = 0; index < 5; index += 1) land(d, `Other ${index}`)
    land(d, 'Merged feat-x', pr)
    insertItem(d, { ...A, ...pr, kind: 'question', title: 'Merge PR feat-x?' })
    openPr(d, 'feat-x')
    await bootApp(d)
    expect(landedTitles()).toEqual(['Other 4', 'Other 3', 'Other 2'])
    expect(document.querySelector('.dash-landed-waiting')?.textContent).toBe('1 on a PR still waiting on you')
    expect(document.querySelector('.dashboard-outcomes h2')?.textContent).toBe('Just landed')
  })

  // #305 review: one open ask on `main` hid every outcome on `main`, showed "No
  // recorded outcomes" and read older history on every tick.
  it.each([false, true])('reads no older history for an open ask on a busy branch (open PR on it: %s)', async (withPr) => {
    const d = open()
    const main = { repo: 'acme/app', stream: 'main' }
    for (let index = 0; index < 70; index += 1) land(d, `Main ${index}`, main)
    insertItem(d, { ...A, ...main, kind: 'question', title: 'Deploy main?' })
    if (withPr) openPr(d, 'main')
    const reads: string[] = []
    await bootApp(d, { interceptFetch: async (input, _init, next) => { reads.push(String(input).split('?')[0]!); return next() } })
    for (let tick = 0; tick < 3; tick += 1) await pollTick()
    expect(reads.filter((url) => url === '/api/items/history')).toEqual([])
    expect(landedTitles()).toEqual(withPr ? [] : ['Main 69', 'Main 68', 'Main 67', 'Main 66'])
    const waiting = document.querySelector<HTMLElement>('.dash-landed-waiting')!
    expect(waiting.hidden).toBe(!withPr)
    if (withPr) expect(waiting.textContent).toBe('4 on PRs still waiting on you')
    expect(document.querySelector('.dashboard-outcome-list .dashboard-empty')).toBeNull()
  })

  it('highlights each new outcome once, never on first paint, a poll or older history', async () => {
    const d = open()
    land(d, 'Before boot')
    const started = arrivals()
    await bootApp(d)
    expect(started.titles()).toEqual([])
    land(d, 'First new')
    await pollTick()
    expect(started.titles()).toEqual(['First new'])
    await pollTick()
    click(document.querySelector('.tab[data-tab="needsYou"]'))
    await settle()
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()
    expect(started.titles()).toEqual(['First new'])
    const row = document.querySelector('.dashboard-outcome')!
    expect(row.classList.contains('arrived')).toBe(true)
    const end = new Event('animationend')
    Object.defineProperty(end, 'animationName', { value: 'dash-landed-arrive' })
    row.dispatchEvent(end)
    expect(row.classList.contains('arrived')).toBe(false)
    land(d, 'Second new')
    land(d, 'Third new')
    await pollTick()
    expect(started.titles()).toEqual(['First new', 'Third new', 'Second new'])
  })

  // #305 review: an outcome older than what was drawn entering the rows is not
  // an arrival, here through a lens change that brings beta's into view.
  it('starts no highlight for an older outcome that enters the rows', async () => {
    const d = open()
    land(d, 'Older beta', { project: 'beta' })
    for (let index = 0; index < 4; index += 1) land(d, `Alpha ${index}`)
    const started = arrivals()
    await bootApp(d)
    expect(landedTitles()).toEqual(['Alpha 3', 'Alpha 2', 'Alpha 1', 'Alpha 0'])
    click(document.querySelector('#rail .rail-tab[data-project="beta"]'))
    await settle()
    expect(landedTitles()).toEqual(['Older beta'])
    expect(started.titles()).toEqual([])
  })

  it.each([
    ['reduced motion', () => { (window.matchMedia('(prefers-reduced-motion: reduce)') as { matches: boolean }).matches = true }],
    ['Calm', () => { localStorage.setItem('agent-inbox-motion', 'calm') }],
    ['a hidden page', () => { vi.spyOn(document, 'hidden', 'get').mockReturnValue(true) }],
    ['another tab', () => { click(document.querySelector('.tab[data-tab="needsYou"]')) }],
  ] as const)('starts no highlight under %s, nor once that ends', async (name, set) => {
    const d = open()
    if (name === 'Calm') set()
    const started = arrivals()
    await bootApp(d)
    if (name !== 'Calm') set()
    await settle()
    land(d, 'Quiet arrival')
    await pollTick()
    expect(landedTitles()).toContain('Quiet arrival')
    vi.restoreAllMocks()
    const later = arrivals()
    if (name === 'reduced motion') (window.matchMedia('(prefers-reduced-motion: reduce)') as { matches: boolean }).matches = false
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await pollTick()
    expect([...started.titles(), ...later.titles()]).toEqual([])
  })
})

describe('Since you last looked (#305)', () => {
  it('appears only after a gap, counting outcomes, new asks and finished sessions', async () => {
    const d = open()
    localStorage.setItem('agent-inbox-last-visit', new Date(T0 - 3 * HOUR).toISOString())
    span(d, 'finished', T0 - 2 * HOUR, T0 - HOUR)
    vi.setSystemTime(T0 - 30 * MIN)
    land(d, 'Away outcome')
    insertItem(d, { ...A, kind: 'question', title: 'Away ask' })
    vi.setSystemTime(T0)
    await bootApp(d)
    expect(since().hidden).toBe(false)
    expect(since().textContent).toBe('Since you last looked: 1 outcome landed, 1 new ask, 1 session finished')
  })

  it('stays through polls in a window the human has not used, and goes on their first click or key', async () => {
    const d = open()
    localStorage.setItem('agent-inbox-last-visit', new Date(T0 - 3 * HOUR).toISOString())
    land(d, 'Away outcome')
    await bootApp(d)
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    for (let tick = 0; tick < 3; tick += 1) { advanceClock(MIN); await pollTick() }
    expect(since().hidden).toBe(false)
    // Selecting the line itself is reading it, not moving on.
    since().dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(since().hidden).toBe(false)
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }))
    expect(since().hidden).toBe(true)
    land(d, 'Later outcome')
    await pollTick()
    click(document.querySelector('.tab[data-tab="needsYou"]'))
    await settle()
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()
    expect(since().hidden).toBe(true)
  })

  // #305 review: ⌘C on the line used to dismiss it before the copy ran.
  it('stays while the human copies it, and goes on a plain key or a click elsewhere', async () => {
    const d = open()
    localStorage.setItem('agent-inbox-last-visit', new Date(T0 - 3 * HOUR).toISOString())
    land(d, 'Away outcome')
    await bootApp(d)
    const selection = document.getSelection()!
    selection.selectAllChildren(since())
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true }))
    expect(since().hidden).toBe(false)
    // Any key while the line is selected is still reading it.
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(since().hidden).toBe(false)
    // So is a shortcut with nothing selected (Ctrl+C, ⌘-Tab).
    selection.removeAllRanges()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', metaKey: true, bubbles: true }))
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }))
    expect(since().hidden).toBe(false)
    document.querySelector('.dash-now')!.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(since().hidden).toBe(true)
  })

  it('is not dismissed by input while another tab is showing', async () => {
    const d = open()
    localStorage.setItem('agent-inbox-last-visit', new Date(T0 - 3 * HOUR).toISOString())
    land(d, 'Away outcome')
    insertItem(d, { ...A, kind: 'question', title: 'Away ask' })
    await bootApp(d)
    click(document.querySelector('.tab[data-tab="needsYou"]'))
    await settle()
    expect(document.getElementById('dashboard')!.hidden).toBe(true)
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }))
    click(document.querySelector('.tab[data-tab="dashboard"]'))
    await settle()
    expect(since().hidden).toBe(false)
  })

  it('stays hidden without a gap or a previous visit', async () => {
    const d = open()
    land(d, 'Recent outcome')
    localStorage.setItem('agent-inbox-last-visit', new Date(Date.now() - 5 * MIN).toISOString())
    await bootApp(d)
    expect(since().hidden).toBe(true)
    expect(since().textContent).toBe('')
  })

  it('stays hidden on a first visit', async () => {
    const d = open()
    land(d, 'Recent outcome')
    await bootApp(d)
    expect(since().hidden).toBe(true)
  })
})

describe('attention parity and the budget with the ribbon (#305)', () => {
  const surfaces = async () => ({
    title: document.title,
    badge: badgeCount(),
    // History's count follows the outcome that landed; the attention tabs never move.
    tabs: ['needsYou', 'notes', 'boards'].map(tabCount),
    rail: [...document.querySelectorAll<HTMLElement>('#dashRail [data-rail-card]')].map((card) => card.dataset.railCard),
    dock: [await (await fetch('/api/items?scope=attention')).text(), await (await fetch('/api/boards?scope=attention')).text()],
  })

  it('changes no badge, tab, rail card or dock read when only the ribbon and Just landed change, and reads nothing new', async () => {
    const d = open()
    insertItem(d, { ...A, kind: 'question', title: 'Ship it?' })
    upsertBoard(d, { ...A, title: 'Plan', rows: [{ label: 'Approve', status: 'blocked', note: 'Approve?', next_step: 'Approve it', action_owner: 'approval', impact: 'Unblocks', options: [{ label: 'Yes' }, { label: 'No' }] }] })
    const reads = new Set<string>()
    await bootApp(d, { interceptFetch: async (input, _init, next) => { reads.add(String(input).split('?')[0]!); return next() } })
    const before = await surfaces()
    const now = Date.now()
    span(d, 'one', now + MIN, now + HOUR, { project: 'beta' })
    land(d, 'Landed beta', { project: 'beta' })
    range().value = String(30 * DAY)
    range().dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    reads.clear()
    await pollTick()
    expect(ribbonLanes()).toEqual(['alpha', 'beta'])
    expect(await surfaces()).toEqual(before)
    expect([...reads].sort()).toEqual([
      '/api/activity', '/api/activity/history', '/api/boards', '/api/boards/archived/summary', '/api/issues',
      '/api/items', '/api/links', '/api/messages', '/api/projects/closed',
    ])
  })

  it('stays within 1,500 Dashboard elements over 30 days of many projects, with lanes and a full rail', async () => {
    const d = open()
    // Forty projects with a span every eight hours for thirty days.
    for (let p = 0; p < 40; p += 1) {
      for (let i = 0; i < 90; i += 1) {
        const start = T0 - 30 * DAY + i * 8 * HOUR + p * MIN
        span(d, `p${p}-${i}`, start, start + 2 * HOUR, { project: `project-${p}` })
      }
    }
    vi.setSystemTime(T0)
    for (let index = 0; index < 14; index += 1) {
      const scope = { ...A, project: `project-${index}`, stream: `branch-${index}` }
      upsertBoard(d, { ...scope, title: `Plan ${index}`, rows: Array.from({ length: 8 }, (_, row) => ({ label: `Step ${row}`, status: row < 3 ? 'done' : 'missing' })) })
      upsertActivity(d, { ...scope, session: `s${index}`, doing: `Lane ${index}`, idle: false, detail: 'Detail', children: [{ name: 'a', doing: 'x' }, { name: 'b', doing: 'y' }] })
      recordActivityCall(d, `s${index}`)
      insertItem(d, { ...scope, kind: 'question', title: `Ask ${index}`, session: `s${index}` })
      land(d, `Outcome ${index}`, { project: `project-${index}` })
    }
    await bootApp(d)
    range().value = String(30 * DAY)
    range().dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    expect(ribbonLanes()).toHaveLength(12)
    expect(document.querySelectorAll('#dashboard .dash-lane')).toHaveLength(12)
    expect(document.querySelectorAll('.dash-ribbon-bar').length).toBeLessThanOrEqual(200)
    expect(document.querySelector('.dash-ribbon-more')?.textContent).toBe('+28 more projects')
    const count = document.querySelectorAll('#dashboard *').length
    expect(count).toBeLessThanOrEqual(1500)
    console.info(`#305 Dashboard elements, worst case: ${count}`)
  })
})
