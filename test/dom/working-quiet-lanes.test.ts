// @vitest-environment jsdom
// Dashboard lanes PR 4 (docs/superpowers/specs/2026-11-13-dashboard-lanes-design.md
// §3.3, §3.4, §8): the Agents card becomes the Working and Quiet lanes. Working
// holds a card per session with live work, grouped by project; Quiet a table
// row per idle or parked session, with the folds at its end. Every live card is
// in exactly one place; a move between lanes shows on the next paint; inside a
// lane, order is pinned, and held under the pointer; the chips count and focus
// their own lane; the session panel opens from either lane, wide and narrow.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { closeProject, insertItem, recordActivityCall, touchActivity, upsertActivity } from '../../src/store.js'
import { QUIET_EMPTY, READING, SESSIONS_EMPTY, WORKING_EMPTY, installAgentsHome } from '../../public/agents-home.js'
import { advanceClock, attachStylesheet, bootApp, click, freshDb, pollTick, settle, setViewport, type, useDomTest } from './harness.js'

// jsdom dispatches only untrusted events, and an outside click closes the panel
// only on trusted input: stub that one seam, as dashboard-focus.test.ts does.
const trust = vi.hoisted(() => ({ on: false }))
vi.mock('../../public/ribbon.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../public/ribbon.js')>(),
  trustedInput: () => trust.on,
}))

useDomTest()

let db: Database.Database | null = null
beforeEach(() => { vi.stubGlobal('location', { hash: '', reload: vi.fn() }) })
afterEach(() => {
  db?.close()
  db = null
  trust.on = false
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const A = { project: 'alpha', stream: 'main', agent: 'copilot' } as const
const MIN = 60_000

function work(d: Database.Database, session: string, doing: string, extra: Record<string, unknown> = {}): void {
  upsertActivity(d, { ...A, session, doing, idle: false, ...extra })
  recordActivityCall(d, session)
  upsertActivity(d, { ...A, session, doing, idle: false, ...extra })
}
const rest = (d: Database.Database, session: string, extra: Record<string, unknown> = {}) =>
  upsertActivity(d, { ...A, session, doing: 'open', idle: true, ...extra })

const home = () => document.querySelector<HTMLElement>('#dashboard .agents-home')!
const workingLane = () => document.querySelector<HTMLElement>('#dashboard .working-lane')!
const quietLane = () => document.querySelector<HTMLElement>('#dashboard .quiet-lane')!
const ids = (scope: ParentNode | null, selector: string) =>
  [...(scope?.querySelectorAll<HTMLElement>(selector) ?? [])].map((el) => el.dataset.sessionCard!)
const workingIds = () => ids(workingLane(), '.ah-cards [data-session-card]')
const quietIds = () => ids(quietLane(), '.qt-rows [data-session-card]')
const foldIds = () => ids(quietLane(), '.ah-folds [data-session-card]')
const groups = () => [...workingLane().querySelectorAll<HTMLElement>('.ah-groups > .ah-group')]
  .map((group) => [group.querySelector('.ah-group-name')?.textContent, ids(group, '[data-session-card]')])
const item = (id: string) => [...document.querySelectorAll<HTMLElement>('#dashboard [data-session-card]')].find((el) => el.dataset.sessionCard === id) ?? null
const chip = (key: string) => document.querySelector<HTMLButtonElement>(`#dashboard [data-dash-chip="${key}"]`)!
const chipCount = (key: string) => chip(key).querySelector('.dash-chip-count')?.textContent
const panel = () => document.querySelector<HTMLElement>('#dashboard .dash-focus')!
const labels = (el: Element | null) => [...(el?.querySelectorAll('[data-ah-action]') ?? [])].map((b) => b.textContent)
const key = (target: Element, name: string) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
const pointer = (el: Element, type: 'pointerenter' | 'pointerleave') => el.dispatchEvent(new Event(type))
const forced = async () => {
  click(document.querySelector('.tab[data-tab="dashboard"]'))
  await settle()
}

describe('the Working and Quiet lanes (§3.3, §3.4)', () => {
  it('sit after Needs you, Working then Quiet, each with its lane heading and no count, and no filter or group-by', async () => {
    db = freshDb()
    work(db, 'w', 'Writing')
    rest(db, 'q')
    await bootApp(db)
    const lanes = [...home().children].map((el) => el.className)
    expect(lanes).toEqual(['dashboard-card ah-lane working-lane', 'dashboard-card ah-lane quiet-lane'])
    expect([...home().querySelectorAll('.ah-lane-head h2')].map((h) => [h.id, h.textContent])).toEqual([
      ['workingLaneTitle', 'Working'], ['quietLaneTitle', 'Quiet'],
    ])
    expect(document.querySelector('#dashboard .needs-you-lane')?.nextElementSibling?.classList.contains('dashboard-grid')).toBe(true)
    // the lanes share the split with the session panel (§3.6), and the split is the grid's
    expect(home().parentElement?.classList.contains('dash-split')).toBe(true)
    expect(home().parentElement?.parentElement?.classList.contains('dashboard-grid')).toBe(true)
    // Just landed and the ribbon stay after the lanes
    const grid = [...home().parentElement!.parentElement!.children].map((el) => el.classList[1] ?? el.classList[0])
    expect(grid.indexOf('dash-split')).toBeLessThan(grid.indexOf('dashboard-activity'))
    expect(document.querySelector('#dashboard [data-ah-filter], #dashboard .ah-group-by, #dashboard .ah-count, #dashboard .ah-none, #agentsHomeTitle')).toBeNull()
    expect([chipCount('working'), chipCount('quiet')]).toEqual(['1', '1'])
  })

  it('groups Working by project with a dot, name and count; the agent kind is on each card, and Open opens its panel', async () => {
    db = freshDb()
    work(db, 'a1', 'First in alpha')
    advanceClock()
    work(db, 'b1', 'In beta', { project: 'beta', agent: 'claude-code' })
    advanceClock()
    work(db, 'a2', 'Second in alpha')
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    // the newest call first; a group sits where its first card is
    expect(groups()).toEqual([['alpha', ['session:a2', 'session:a1']], ['beta', ['session:b1']]])
    const alpha = workingLane().querySelector<HTMLElement>('.ah-group')!
    expect(alpha.querySelector('.ah-group-count')?.textContent).toBe('2 sessions')
    expect(alpha.style.getPropertyValue('--ah-group')).not.toBe('')
    expect(item('session:b1')?.querySelector('.sc-agent')?.textContent).toBe('Claude Code')
    expect(item('session:a1')?.querySelector('.sc-agent')?.textContent).toBe('Copilot')
    expect(item('session:a1')?.tagName).toBe('ARTICLE')
    expect(labels(item('session:a1'))).toEqual(['Open', 'Message'])
    click(item('session:a1')?.querySelector('[data-ah-action="open"]'))
    await settle()
    expect([panel().hidden, panel().dataset.session]).toEqual([false, 'a1'])
    expect(document.activeElement).toBe(document.getElementById('dashFocusTitle'))
    // Open opens; it never toggles the panel closed
    click(item('session:a1')?.querySelector('[data-ah-action="open"]'))
    await settle()
    expect(panel().hidden).toBe(false)
  })

  it('pins order inside Working between forced paints, and holds it under the pointer through one', async () => {
    db = freshDb()
    work(db, 'older', 'Older')
    advanceClock()
    work(db, 'newer', 'Newer')
    await bootApp(db)
    expect(workingIds()).toEqual(['session:newer', 'session:older'])
    advanceClock()
    work(db, 'older', 'Called again')
    await pollTick()
    expect(workingIds()).toEqual(['session:newer', 'session:older'])
    pointer(workingLane(), 'pointerenter')
    await forced()
    expect(workingIds()).toEqual(['session:newer', 'session:older'])
    pointer(workingLane(), 'pointerleave')
    await forced()
    expect(workingIds()).toEqual(['session:older', 'session:newer'])
  })

  it('keeps the project groups still when a card leaves, so the cards under the pointer do not swap', async () => {
    db = freshDb()
    work(db, 'a2', 'Second in alpha')
    advanceClock()
    work(db, 'b1', 'In beta', { project: 'beta' })
    advanceClock()
    work(db, 'a1', 'First in alpha')
    await bootApp(db)
    // order [a1, b1, a2]: alpha (a1, a2), then beta (b1)
    expect(groups()).toEqual([['alpha', ['session:a1', 'session:a2']], ['beta', ['session:b1']]])
    const b1 = item('session:b1')
    pointer(workingLane(), 'pointerenter')
    // a1 stops working: it moves to Quiet; beta stays second, its card the same node
    rest(db, 'a1')
    await pollTick()
    expect(groups()).toEqual([['alpha', ['session:a2']], ['beta', ['session:b1']]])
    expect(item('session:b1')).toBe(b1)
    expect(quietIds()).toEqual(['session:a1'])
  })

  it('pins order inside Quiet under the pointer', async () => {
    db = freshDb()
    rest(db, 'q1')
    recordActivityCall(db, 'q1')
    rest(db, 'q1')
    advanceClock()
    rest(db, 'q2')
    recordActivityCall(db, 'q2')
    rest(db, 'q2')
    await bootApp(db)
    expect(quietIds()).toEqual(['session:q2', 'session:q1'])
    advanceClock()
    recordActivityCall(db, 'q1')
    rest(db, 'q1')
    await pollTick()
    expect(quietIds()).toEqual(['session:q2', 'session:q1'])
    pointer(quietLane(), 'pointerenter')
    await forced()
    expect(quietIds()).toEqual(['session:q2', 'session:q1'])
    pointer(quietLane(), 'pointerleave')
    await forced()
    expect(quietIds()).toEqual(['session:q1', 'session:q2'])
  })

  it('moves a session between lanes on the next paint, even with the pointer in the other lane', async () => {
    db = freshDb()
    work(db, 'w', 'Stays working')
    rest(db, 'q')
    await bootApp(db)
    expect([workingIds(), quietIds()]).toEqual([['session:w'], ['session:q']])
    const row = item('session:q')!
    expect([row.tagName, row.className]).toEqual(['DIV', 'qt-row tone-idle quiet'])
    // the pointer rests in Working: q starts working and moves in on the next poll
    pointer(workingLane(), 'pointerenter')
    work(db, 'q', 'Back at it')
    await pollTick()
    expect([workingIds(), quietIds()]).toEqual([['session:w', 'session:q'], []])
    // a node of its new lane's shape, never the row it was
    expect(workingLane().querySelector('[data-session-card="session:q"]')?.matches('article.sc')).toBe(true)
    expect(document.querySelectorAll('#dashboard [data-session-card="session:q"]')).toHaveLength(1)
    expect([chipCount('working'), chipCount('quiet')]).toEqual(['2', '0'])
    pointer(workingLane(), 'pointerleave')
    // the pointer in Quiet now: w stops working (its claim decays) and moves out of Working
    pointer(quietLane(), 'pointerenter')
    advanceClock(31 * MIN)
    work(db, 'q', 'Still going')
    touchActivity(db, 'w')
    await pollTick()
    expect([workingIds(), quietIds()]).toEqual([['session:q'], ['session:w']])
    expect(quietLane().querySelector('.qt-rows [data-session-card="session:w"]')?.matches('div.qt-row')).toBe(true)
    expect([chipCount('working'), chipCount('quiet')]).toEqual(['1', '1'])
  })

  it('puts every live card in exactly one place, and the chips count what each lane shows', async () => {
    db = freshDb()
    work(db, 'w', 'Working')
    rest(db, 'q')
    work(db, 'old', 'Long gone')
    rest(db, 'old')
    work(db, 'shut', 'In a closed project', { project: 'shut' })
    advanceClock(9 * 60 * MIN)
    work(db, 'w', 'Still working')
    for (const session of ['q', 'old', 'shut']) touchActivity(db, session)
    recordActivityCall(db, 'q')
    work(db, 'shut', 'Still in a closed project', { project: 'shut' })
    closeProject(db, 'shut')
    await bootApp(db)
    for (const fold of document.querySelectorAll<HTMLDetailsElement>('#dashboard [data-ah-fold]')) {
      fold.open = true
      fold.dispatchEvent(new Event('toggle'))
    }
    const placed = [...workingIds(), ...quietIds(), ...foldIds()]
    expect(new Set(placed).size).toBe(placed.length)
    expect([...placed].sort()).toEqual(['session:old', 'session:q', 'session:shut', 'session:w'])
    expect(foldIds().sort()).toEqual(['session:old', 'session:shut'])
    expect([chipCount('working'), chipCount('quiet')]).toEqual([String(workingIds().length), String(quietIds().length)])
    expect([workingIds(), quietIds()]).toEqual([['session:w'], ['session:q']])
  })

  it('writes nothing to an unchanged row across polls', async () => {
    db = freshDb()
    rest(db, 'q1')
    rest(db, 'q2', { stream: 'feature' })
    await bootApp(db)
    const mutations: MutationRecord[] = []
    const observer = new MutationObserver((records) => mutations.push(...records))
    observer.observe(quietLane().querySelector('.qt-rows')!, { subtree: true, childList: true, characterData: true, attributes: true })
    await pollTick()
    insertItem(db, { project: 'beta', stream: 'main', agent: 'claude-code', kind: 'note', title: 'Unrelated' })
    await pollTick()
    observer.disconnect()
    expect(quietIds()).toHaveLength(2)
    expect(mutations).toEqual([])
  })
})

describe('the Quiet table (§3.4)', () => {
  it('has the six columns, one row per session with every column named for assistive tech', async () => {
    db = freshDb()
    rest(db, 'q', { project: 'alpha', agent: 'claude-code', stream: 'feat/x' })
    await bootApp(db)
    const head = quietLane().querySelector<HTMLElement>('.qt-rows > .qt-head')!
    expect(head.getAttribute('aria-hidden')).toBe('true')
    expect([...head.children].map((el) => el.textContent)).toEqual(['State', 'Session', 'Branch', 'Last caption', 'Since', ''])
    expect(quietLane().querySelector('.qt-rows')?.getAttribute('role')).toBe('list')
    const row = item('session:q')!
    expect(row.getAttribute('role')).toBe('listitem')
    expect([...row.children].map((el) => el.className)).toEqual(['qt-state', 'qt-session', 'qt-branch', 'qt-caption', 'qt-since', 'qt-act'])
    expect([
      row.querySelector('.qt-state .sc-state')?.textContent,
      row.querySelector('.qt-session .qt-project')?.textContent,
      row.querySelector('.qt-session .sc-agent')?.textContent,
      row.querySelector('.qt-branch .sc-branch')?.textContent,
      row.querySelector('.qt-caption .sc-doing')?.textContent,
      row.querySelector('.qt-since .sc-when')?.textContent,
    ]).toEqual(['Quiet', 'alpha', 'Claude Code', 'feat/x', 'No task reported yet', 'connected <1m · no Agent Inbox call yet'])
    expect(row.getAttribute('aria-label')).toBe('Quiet: Claude Code in alpha on feat/x. No task reported yet. connected <1m · no Agent Inbox call yet')
    expect(row.style.getPropertyValue('--ah-group')).not.toBe('')
  })

  it('keeps each state’s main action: Open and Message on an idle row, the hint in Message’s title', async () => {
    db = freshDb()
    rest(db, 'q', { receives_messages: true })
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    expect(labels(item('session:q'))).toEqual(['Open', 'Message'])
    expect(item('session:q')?.querySelector<HTMLElement>('[data-ah-action="message"]')?.title)
      .toBe('Message this session. It sees a message when it next checks')
    click(item('session:q')?.querySelector('[data-ah-action="open"]'))
    await settle()
    expect([panel().hidden, panel().dataset.session]).toEqual([false, 'q'])
    expect(document.activeElement).toBe(document.getElementById('dashFocusTitle'))
  })

  it('keeps a launch row’s own actions: Take over and Resume when parked, Close when lost, Open and Message when running', () => {
    const host = document.createElement('div')
    const grid = document.createElement('div')
    grid.className = 'dashboard-grid'
    host.append(grid)
    document.body.append(host)
    const openSession = vi.fn()
    const launchAction = vi.fn()
    const lanes = installAgentsHome({
      openSession, launchAction,
      launches: () => ({ granted: () => true, newSession: () => null, openNewSession: () => {} }),
    })
    grid.append(lanes.element())
    const now = Date.now()
    const at = (ms: number) => new Date(now - ms).toISOString()
    const id = (n: number) => `11111111-2222-4333-8444-${String(n).padStart(12, '0')}`
    const launch = (n: number, o: Record<string, unknown>) => ({ id: id(n), project: 'alpha', stream: 'main', mode: 'ask', sessions: [], created_at: at(60 * MIN), updated_at: at(1000), ...o })
    lanes.paint(host, {
      activity: [{ session: 'run', project: 'alpha', stream: 'main', agent: 'copilot', driven: true, driven_launch: id(3), receives_messages: true,
        doing: 'open', idle: true, started_at: at(60 * MIN), updated_at: at(1000), last_call_at: at(12 * MIN) }] as never,
      launches: [
        launch(1, { status: 'parked', parked_at: at(MIN), resumable: true, worktree_path: '/tmp/wt-synthetic' }),
        launch(2, { status: 'running', driver_pid: 0, updated_at: at(30 * MIN) }),
        launch(3, { status: 'running', sessions: ['run'] }),
      ],
      nowMs: now,
    })
    const rowOf = (n: number) => host.querySelector<HTMLElement>(`.qt-rows [data-session-card="launch:${id(n)}"]`)
    expect(labels(rowOf(1))).toEqual(['Take over in Terminal', 'Resume…'])
    expect(rowOf(1)?.querySelector('.sc-here')?.textContent).toBe('A')
    // the row's name carries the Session column's origin mark and the Branch column's worktree too
    expect(rowOf(1)?.querySelector('.qt-branch .sc-worktree')?.textContent).toBe('worktree')
    expect(rowOf(1)?.getAttribute('aria-label')).toMatch(/^[^:]+: Copilot \(started here\) in alpha on main \(worktree\)\. /)
    expect(rowOf(2)?.querySelector('.sc-state')?.textContent).toBe('Not responding')
    expect(labels(rowOf(2))).toEqual(['Close'])
    expect(labels(rowOf(3))).toEqual(['Open', 'Message'])
    // Open is the panel, never a launch's own action
    ;(rowOf(3)!.querySelector('[data-ah-action="open"]') as HTMLElement).click()
    expect(openSession).toHaveBeenCalledWith(`launch:${id(3)}`, 'head')
    ;(rowOf(1)!.querySelector('[data-ah-action="take-over"]') as HTMLElement).click()
    expect(launchAction).toHaveBeenCalledWith(id(1), 'take-over')
    expect(launchAction).toHaveBeenCalledTimes(1)
    host.remove()
  })

  it('carries the Asking you chip on a row with open asks; the chip goes to Needs you', async () => {
    db = freshDb()
    rest(db, 'q')
    const first = insertItem(db, { ...A, kind: 'question', title: 'First ask', session: 'q' })
    advanceClock()
    insertItem(db, { ...A, kind: 'question', title: 'Second ask', session: 'q' })
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const asking = item('session:q')!.querySelector<HTMLButtonElement>('.qt-caption .sc-asking')!
    expect([asking.hidden, asking.textContent]).toEqual([false, 'Asking you · 2'])
    expect(item('session:q')?.textContent).not.toContain('First ask')
    click(asking)
    await settle()
    expect((document.activeElement as HTMLElement | null)?.dataset.nyAsk).toBe(first)
    expect(panel().hidden).toBe(true)
  })

  it('hides the folds’ row while there is nothing to fold', async () => {
    db = freshDb()
    rest(db, 'q')
    await bootApp(db)
    const folds = quietLane().querySelector<HTMLElement>('.ah-folds')!
    expect(quietLane().lastElementChild).toBe(folds)
    expect(folds.hidden).toBe(true)
  })

  it('ends with the folds, unchanged in rule and content', async () => {
    db = freshDb()
    work(db, 'old', 'Long gone')
    rest(db, 'old')
    work(db, 'c1', 'In demo', { project: 'demo' })
    rest(db, 'c2', { project: 'demo' })
    advanceClock(9 * 60 * MIN)
    for (const session of ['old', 'c1', 'c2']) touchActivity(db, session)
    work(db, 'c1', 'Still in demo', { project: 'demo' })
    rest(db, 'q')
    closeProject(db, 'demo')
    await bootApp(db)
    const fold = (k: string) => quietLane().querySelector<HTMLDetailsElement>(`[data-ah-fold="${k}"]`)!
    expect(quietLane().lastElementChild).toBe(quietLane().querySelector('.ah-folds'))
    expect(quietLane().querySelector<HTMLElement>('.ah-folds')?.hidden).toBe(false)
    expect([fold('dormant').hidden, fold('dormant').querySelector('summary')?.textContent]).toEqual([false, 'Dormant (1) · quiet 8 h or more'])
    expect([fold('closed').hidden, fold('closed').querySelector('summary')?.textContent]).toEqual([false, 'In closed projects (2)'])
    expect(fold('ended').hidden).toBe(true)
    expect(fold('closed').querySelectorAll('[data-session-card]')).toHaveLength(0)
    fold('closed').open = true
    fold('closed').dispatchEvent(new Event('toggle'))
    // a fold's cards are cards, as before, with the actions they had
    const cards = [...fold('closed').querySelectorAll<HTMLElement>('[data-session-card]')]
    expect(cards.map((el) => [el.tagName, el.dataset.sessionCard])).toEqual([['ARTICLE', 'session:c1'], ['ARTICLE', 'session:c2']])
    expect(cards.map(labels)).toEqual([['Message'], ['Message']])
  })
})

describe('empty and reading states (§3.3, §3.4)', () => {
  it('with no session: the first-run message in Working, a quiet line in Quiet, both headings kept', async () => {
    db = freshDb()
    await bootApp(db)
    expect(workingLane().querySelector<HTMLElement>('.ah-empty')?.hidden).toBe(false)
    expect(workingLane().querySelector('.ah-empty-text')?.textContent).toBe(SESSIONS_EMPTY)
    expect(workingLane().querySelector<HTMLElement>('.ah-lane-empty')?.hidden).toBe(true)
    expect(quietLane().querySelector<HTMLElement>('.ah-lane-empty')?.textContent).toBe(QUIET_EMPTY)
    expect(quietLane().querySelector<HTMLElement>('.ah-lane-empty')?.hidden).toBe(false)
    expect(quietLane().querySelector<HTMLElement>('.qt-rows')?.hidden).toBe(true)
    expect(quietLane().querySelector<HTMLElement>('.ah-folds')?.hidden).toBe(true)
    expect(document.getElementById('workingLaneTitle')).not.toBeNull()
    expect(document.getElementById('quietLaneTitle')).not.toBeNull()
  })

  it('with only quiet sessions, Working says so in one line; with only working ones, Quiet does', async () => {
    db = freshDb()
    rest(db, 'q')
    await bootApp(db)
    const workingNone = workingLane().querySelector<HTMLElement>('.ah-lane-empty')!
    expect([workingNone.hidden, workingNone.textContent]).toEqual([false, WORKING_EMPTY])
    expect(workingLane().querySelector<HTMLElement>('.ah-empty')?.hidden).toBe(true)
    expect(quietLane().querySelector<HTMLElement>('.ah-lane-empty')?.hidden).toBe(true)
    work(db, 'q', 'Back at it')
    await pollTick()
    expect(workingNone.hidden).toBe(true)
    expect([quietLane().querySelector<HTMLElement>('.ah-lane-empty')?.hidden, quietLane().querySelector<HTMLElement>('.qt-rows')?.hidden]).toEqual([false, true])
  })

  it('before the first activity read: no counts, and Working says it is reading', () => {
    const host = document.createElement('div')
    const grid = document.createElement('div')
    grid.className = 'dashboard-grid'
    host.append(grid)
    document.body.append(host)
    const lanes = installAgentsHome({ openSession: vi.fn() })
    grid.append(lanes.element())
    lanes.paint(host, { activity: null, nowMs: Date.now() })
    expect(lanes.counts()).toBeNull()
    expect(host.querySelector('.working-lane .ah-lane-empty')?.textContent).toBe(READING)
    expect(host.querySelector<HTMLElement>('.working-lane .ah-lane-empty')?.hidden).toBe(false)
    expect(host.querySelector<HTMLElement>('.quiet-lane .ah-lane-empty')?.hidden).toBe(true)
    expect(host.querySelector('.agents-home')?.classList.contains('reading')).toBe(true)
    host.remove()
  })
})

describe('chips and keys (§3.1)', () => {
  it('the Working and Quiet chips focus their own lane’s first card or row and never filter', async () => {
    db = freshDb()
    work(db, 'w', 'Working')
    rest(db, 'q1')
    advanceClock()
    rest(db, 'q2')
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const before = [workingIds(), quietIds()]
    click(chip('quiet'))
    expect(document.activeElement).toBe(item(quietIds()[0]!))
    expect((document.activeElement as HTMLElement).tabIndex).toBe(0)
    click(chip('working'))
    expect(document.activeElement).toBe(item('session:w'))
    expect([workingIds(), quietIds()]).toEqual(before)
    expect([chipCount('working'), chipCount('quiet')]).toEqual(['1', '2'])
  })

  it('an empty Working lane’s chip lands on its heading', async () => {
    db = freshDb()
    rest(db, 'q')
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    click(chip('working'))
    expect(document.activeElement).toBe(document.getElementById('workingLaneTitle'))
  })

  it('an empty Quiet lane’s chip lands on its heading', async () => {
    db = freshDb()
    work(db, 'w', 'Working')
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    click(chip('quiet'))
    expect(document.activeElement).toBe(document.getElementById('quietLaneTitle'))
  })

  it('gives each lane one tab stop in page order; J/K and the arrows stay in a lane; Enter opens', async () => {
    db = freshDb()
    work(db, 'w1', 'One')
    advanceClock()
    work(db, 'w2', 'Two')
    rest(db, 'q1')
    advanceClock()
    rest(db, 'q2')
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const stops = [...document.querySelectorAll<HTMLElement>('#dashboard [data-session-card]')].filter((el) => el.tabIndex === 0)
    expect(stops.map((el) => el.closest('[data-ah-lane]')?.getAttribute('data-ah-lane'))).toEqual(['working', 'quiet'])
    const [lastWorking] = workingIds().slice(-1)
    item(lastWorking!)!.focus()
    key(item(lastWorking!)!, 'j')
    // never into Quiet
    expect(document.activeElement).toBe(item(lastWorking!))
    const [r1, r2] = quietIds()
    item(r1!)!.focus()
    key(item(r1!)!, 'ArrowDown')
    expect(document.activeElement).toBe(item(r2!))
    expect(quietIds().map((id) => item(id)!.tabIndex)).toEqual([-1, 0])
    // Working's own stop is untouched
    expect(workingIds().map((id) => item(id)!.tabIndex)).toEqual([0, -1])
    key(item(r2!)!, 'k')
    expect(document.activeElement).toBe(item(r1!))
    key(item(r1!)!, 'Enter')
    expect(panel().hidden).toBe(false)
    expect(panel().dataset.session).toBe(r1!.slice('session:'.length))
    expect(document.activeElement).toBe(document.getElementById('dashFocusTitle'))
    // never on a row's own controls
    const open = item(r2!)!.querySelector<HTMLElement>('[data-ah-action="open"]')!
    open.focus()
    key(open, 'j')
    expect(document.activeElement).toBe(open)
  })

  it('hands focus to its lane’s heading when the row holding it leaves', async () => {
    db = freshDb()
    rest(db, 'q', { receives_messages: true })
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    item('session:q')!.querySelector<HTMLElement>('[data-ah-action="message"]')!.focus()
    work(db, 'q', 'Back at it', { receives_messages: true })
    await pollTick()
    expect(item('session:q')?.closest('.working-lane')).not.toBeNull()
    expect(document.activeElement).toBe(document.getElementById('quietLaneTitle'))
  })
})

describe('the session panel from both lanes (§3.6)', () => {
  afterEach(() => setViewport('wide'))

  it('opens beside the lanes in the split at 1280px and wider, from a Working card and from a Quiet row', async () => {
    db = freshDb()
    work(db, 'w', 'Working')
    rest(db, 'q')
    await bootApp(db)
    click(item('session:w')?.querySelector('.sc-doing'))
    await settle()
    expect([panel().hidden, panel().dataset.session, panel().parentElement?.className]).toEqual([false, 'w', 'dash-split open'])
    expect(panel().previousElementSibling).toBe(home())
    expect(item('session:w')?.classList.contains('sel')).toBe(true)
    click(item('session:q')?.querySelector('.sc-doing'))
    await settle()
    expect([panel().hidden, panel().dataset.session, panel().parentElement?.className]).toEqual([false, 'q', 'dash-split open'])
    expect(item('session:q')?.classList.contains('sel')).toBe(true)
    // a second click on the row closes it
    click(item('session:q')?.querySelector('.sc-doing'))
    await settle()
    expect(panel().hidden).toBe(true)
    // and the lanes have the full width again
    expect(panel().parentElement?.className).toBe('dash-split')
  })

  it('opens inline under its card or its row below 1280px, and goes home on close', async () => {
    db = freshDb()
    work(db, 'w', 'Working')
    rest(db, 'q')
    setViewport(760)
    await bootApp(db)
    click(item('session:w')?.querySelector('.sc-doing'))
    await settle()
    expect(panel().parentElement).toBe(item('session:w')!.parentElement)
    expect(panel().previousElementSibling).toBe(item('session:w'))
    click(item('session:q')?.querySelector('.sc-doing'))
    await settle()
    expect(panel().parentElement?.classList.contains('qt-rows')).toBe(true)
    expect(panel().previousElementSibling).toBe(item('session:q'))
    click(panel().querySelector('.dash-focus-close'))
    await settle()
    expect(panel().hidden).toBe(true)
    expect(panel().parentElement?.classList.contains('dash-split')).toBe(true)
  })

  it('a trusted click on a Quiet row toggles its panel, never closing and reopening it', async () => {
    db = freshDb()
    rest(db, 'q')
    await bootApp(db)
    // the split's own position: an outside click closes only a panel beside the lanes, never an inline one
    attachStylesheet()
    trust.on = true
    click(item('session:q')?.querySelector('.sc-doing'))
    await settle()
    expect([panel().hidden, panel().dataset.session]).toEqual([false, 'q'])
    expect(getComputedStyle(panel()).position).toBe('sticky')
    // on the row itself: neither closed by the outside click nor reopened by the row
    click(item('session:q')?.querySelector('.qt-since'))
    await settle()
    expect(panel().hidden).toBe(true)
    // a trusted click elsewhere still closes it
    click(item('session:q')?.querySelector('.sc-doing'))
    await settle()
    click(document.querySelector('#dashboard .dash-head'))
    await settle()
    expect(panel().hidden).toBe(true)
  })

  it('keeps the panel, its draft, caret and focus when its session changes lane (narrow)', async () => {
    db = freshDb()
    rest(db, 'q', { receives_messages: true })
    setViewport(760)
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    click(item('session:q')?.querySelector('[data-ah-action="message"]'))
    await settle()
    expect(panel().parentElement?.classList.contains('qt-rows')).toBe(true)
    const input = panel().querySelector<HTMLTextAreaElement>('.dash-focus-message textarea')!
    expect(document.activeElement).toBe(input)
    type(input, 'hello there')
    input.setSelectionRange(2, 5)
    work(db, 'q', 'Back at it', { receives_messages: true })
    await pollTick()
    expect(item('session:q')?.closest('.working-lane')).not.toBeNull()
    expect(panel().isConnected).toBe(true)
    expect(panel().hidden).toBe(false)
    expect(panel().parentElement?.closest('[hidden], details:not([open])')).toBeNull()
    expect(document.activeElement).toBe(input)
    expect([input.value, input.selectionStart, input.selectionEnd]).toEqual(['hello there', 2, 5])
  })
})
