// @vitest-environment jsdom
// Slice 2 §7: opt-in grouping of plans under their GitHub parent issue, in the
// real viewer. The cache is seeded through store.ts as the poller writes it,
// and the graph reaches the page through the real /api/issues route.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { getBoard, insertItem, upsertBoard, upsertIssueSnapshot } from '../../src/store.js'
import { facts, snapshot } from '../issue-fixtures.js'
import type { SnapshotOpts } from '../issue-fixtures.js'
import {
  advanceClock, answerInput, bootApp, click, freshDb, pollTick, row, settle, showInbox, type, useDomTest,
} from './harness.js'

useDomTest()
let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const REPO = 'shariqh/agent-inbox'
const K = (n: number): string => `${REPO}#${n}`
const SCOPE = { project: 'agent-inbox', agent: 'copilot' }
const GROUP_KEY = 'agent-inbox-group-plans'
const UMBRELLA = 'Integrate Agent Inbox with Agent Host Protocol'
const route = (input: RequestInfo | URL): string => String(input).split('?')[0]!
const parent117 = facts(K(117), { title: UMBRELLA, children_total: 10, children_completed: 1 })

function cache(d: Database.Database, n: number, opts: SnapshotOpts = {}): void {
  upsertIssueSnapshot(d, { repo: REPO, number: n, snapshot: snapshot(K(n), opts), startedAt: new Date().toISOString() })
}

/** One plan, newest first in the server's order, pinned to an issue or to none. */
function plan(d: Database.Database, title: string, pin: number | null, rows = [{ label: `${title} step`, status: 'tracked' as const }]): string {
  advanceClock(1000)
  upsertBoard(d, {
    ...SCOPE, stream: 'main', title, repo: REPO, ...(pin === null ? {} : { issuePin: { repo: REPO, number: pin } }), rows,
  })
  return getBoard(d, 'agent-inbox', title)!.id
}

/** #117 lists its children in GitHub's order, #121 before #120. */
function cacheFamily(d: Database.Database, kids = [120, 121]): void {
  cache(d, 117, { issue: { title: UMBRELLA }, children: [121, 120, 118].map((n) => facts(K(n), { title: `Sub-issue ${n}` })), total: 10, completed: 1 })
  for (const n of kids) cache(d, n, { issue: { title: `Sub-issue ${n}` }, ancestors: [parent117] })
}

/** Server order (newest first): Unrelated, Child 121, Umbrella, Spacer, Child 120. */
function seed(d: Database.Database) {
  const c120 = plan(d, 'Child 120', 120)
  const spacer = plan(d, 'Spacer', null)
  const umbrella = plan(d, 'Umbrella', 117)
  const c121 = plan(d, 'Child 121', 121)
  const unrelated = plan(d, 'Unrelated', null)
  cacheFamily(d)
  return { c120, spacer, umbrella, c121, unrelated }
}

type Mode = 'graph' | '404' | 'offline'
let lastPoll = 0
async function boot(d: Database.Database): Promise<{ set(mode: Mode): void }> {
  let mode: Mode = 'graph'
  await bootApp(d, {
    interceptFetch: async (input, _init, next) => {
      if (route(input) === '/api/boards') lastPoll = Date.now()
      if (route(input) === '/api/issues') {
        if (mode === '404') return new Response('<!doctype html><title>Not found</title>', { status: 404 })
        if (mode === 'offline') throw new TypeError('issues offline')
      }
      return next()
    },
  })
  return { set(next) { mode = next } }
}

async function showPlans(): Promise<void> {
  click(document.querySelector('.tab[data-tab="boards"]'))
  await settle()
}

const planIds = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('#boards .boards > [data-card-id]')].map((el) => el.dataset.cardId!)
const heads = (): string[] => [...document.querySelectorAll('#boards .plan-group-head')].map((el) => el.textContent ?? '')
const headerSwitch = (): HTMLInputElement => {
  const input = document.querySelector<HTMLInputElement>('#boards .tab-header input[type="checkbox"][role="switch"]')
  if (!input) throw new Error('no Group by parent issue switch')
  return input
}
const settingsBox = (): HTMLInputElement => {
  if (document.getElementById('setup')?.hidden) click(document.getElementById('gear'))
  const input = document.querySelector<HTMLInputElement>('#setup .plan-settings input[type="checkbox"]')
  if (!input) throw new Error('no grouping setting')
  return input
}
async function toggle(input: HTMLInputElement): Promise<void> {
  click(input)
  await settle()
}

describe('grouping plans by parent issue (slice 2 §7)', () => {
  it('is off by default: today\'s flat order, an unchecked labelled switch, nothing saved', async () => {
    db = freshDb()
    const ids = seed(db)
    await boot(db)
    await showPlans()
    expect(planIds()).toEqual([ids.unrelated, ids.c121, ids.umbrella, ids.spacer, ids.c120])
    expect(heads()).toEqual([])
    expect(headerSwitch().checked).toBe(false)
    expect(headerSwitch().closest('label')?.textContent?.trim()).toBe('Group by parent issue')
    expect(localStorage.getItem(GROUP_KEY)).toBeNull()
  })

  it('groups at the first member\'s place: the umbrella, then GitHub\'s child order', async () => {
    db = freshDb()
    const ids = seed(db)
    await boot(db)
    await showPlans()
    await toggle(headerSwitch())
    expect(planIds()).toEqual([ids.unrelated, ids.umbrella, ids.c121, ids.c120, ids.spacer])
    expect(heads()).toEqual([`#117${UMBRELLA}1 of 10 sub-issues done · 3 plans · agent-inbox`])
    expect(document.querySelector('#boards .plan-group-head')?.tagName).toBe('H3')
    // the header sits right before its first member
    expect(document.querySelector('#boards .plan-group-head')?.nextElementSibling?.getAttribute('data-card-id')).toBe(ids.umbrella)
    expect(document.querySelectorAll('#boards .boards > .board.in-group')).toHaveLength(3)
  })

  it('seeds the switch from the saved Settings default on every load, and a Settings change saves and repaints', async () => {
    localStorage.setItem(GROUP_KEY, 'true')
    db = freshDb()
    const ids = seed(db)
    await boot(db)
    await showPlans()
    expect(headerSwitch().checked).toBe(true)
    expect(planIds()).toEqual([ids.unrelated, ids.umbrella, ids.c121, ids.c120, ids.spacer])
    expect(settingsBox().checked).toBe(true)

    await toggle(settingsBox())
    expect(localStorage.getItem(GROUP_KEY)).toBe('false')
    expect(headerSwitch().checked).toBe(false)
    expect(heads()).toEqual([])
    expect(planIds()).toEqual([ids.unrelated, ids.c121, ids.umbrella, ids.spacer, ids.c120])
  })

  it('keeps keyboard focus on the switch across its own repaint and a poll', async () => {
    db = freshDb()
    seed(db)
    await boot(db)
    await showPlans()
    headerSwitch().focus()
    await toggle(headerSwitch())
    expect(heads()).toHaveLength(1)
    expect(document.activeElement).toBe(headerSwitch())
    plan(db, 'Late plan', null)
    await pollTick()
    expect(document.activeElement).toBe(headerSwitch())
    expect(headerSwitch().checked).toBe(true)
  })

  it('never refocuses the switch once the window is in the background (#233)', async () => {
    db = freshDb()
    seed(db)
    await boot(db)
    await showPlans()
    headerSwitch().focus()
    expect(document.activeElement).toBe(headerSwitch())
    // a background window keeps activeElement; never .blur() here (#233)
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    const blurred = headerSwitch()
    blurred.dispatchEvent(new FocusEvent('blur'))
    blurred.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    window.dispatchEvent(new FocusEvent('blur'))
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    plan(db, 'Late plan', null)
    await pollTick()
    expect(blurred.isConnected, 'the poll must rebuild Plans, or this test proves nothing').toBe(false)
    expect(focus).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(headerSwitch())
  })

  it('the header switch changes only the current view, never the saved default', async () => {
    db = freshDb()
    seed(db)
    await boot(db)
    await showPlans()
    await toggle(headerSwitch())
    expect(heads()).toHaveLength(1)
    expect(localStorage.getItem(GROUP_KEY)).toBeNull()
    expect(settingsBox().checked).toBe(false)

    vi.resetModules()
    await boot(db)
    await showPlans()
    expect(headerSwitch().checked).toBe(false)
    expect(heads()).toEqual([])
  })

  it('repaints at once past an unrelated draft, which it keeps', async () => {
    db = freshDb()
    const ids = seed(db)
    const question = insertItem(db, { ...SCOPE, stream: 'main', kind: 'question', title: 'Which region?' })
    await boot(db)
    await showInbox()
    click(row(question))
    await settle()
    type(answerInput(question), 'half-written answer')
    await showPlans()
    const late = plan(db, 'Late plan', null)
    await pollTick()
    expect(planIds(), 'the draft must hold the poll, or this test proves nothing').not.toContain(late)

    await toggle(headerSwitch())
    expect(heads()).toHaveLength(1)
    // six plans: the sixth, Spacer, waits behind Show more
    expect(planIds()).toEqual([late, ids.unrelated, ids.umbrella, ids.c121, ids.c120])
    expect(answerInput(question)?.value).toBe('half-written answer')
  })

  it.each(['404', 'offline'] as const)('is exactly today\'s flat list when /api/issues is %s', async (failure) => {
    localStorage.setItem(GROUP_KEY, 'true')
    db = freshDb()
    const ids = seed(db)
    const viewer = await boot(db)
    viewer.set(failure)
    await pollTick()
    await showPlans()
    expect(document.getElementById('status')?.textContent).toBe('')
    expect(heads()).toEqual([])
    expect(planIds()).toEqual([ids.unrelated, ids.c121, ids.umbrella, ids.spacer, ids.c120])
    expect(document.querySelectorAll('#boards .in-group')).toHaveLength(0)

    viewer.set('graph')
    await pollTick()
    expect(heads()).toHaveLength(1)
  })

  it('repeats a group\'s header with "(continued)" where a page boundary cuts it, and hides no plan', async () => {
    localStorage.setItem(GROUP_KEY, 'true')
    db = freshDb()
    // newest first: A, B, C, then the group of three, then D
    const d = plan(db, 'D', null)
    const c120 = plan(db, 'Child 120', 120)
    const c121 = plan(db, 'Child 121', 121)
    const umbrella = plan(db, 'Umbrella', 117)
    const later = ['C', 'B', 'A'].map((title) => plan(db!, title, null)).reverse()
    cacheFamily(db)
    await boot(db)
    await showPlans()
    expect(planIds()).toEqual([...later, umbrella, c121])
    expect(heads().map((h) => h.includes('(continued)'))).toEqual([false])

    click([...document.querySelectorAll<HTMLButtonElement>('#boards .show-more')][0])
    await settle()
    expect(planIds()).toEqual([...later, umbrella, c121, c120, d])
    expect(heads()).toHaveLength(2)
    expect(heads()[1]).toContain(`${UMBRELLA} (continued)`)
    expect(document.querySelectorAll('#boards .plan-group-head')[1]?.nextElementSibling?.getAttribute('data-card-id')).toBe(c120)
  })

  it('waits for a released pointer before a poll moves plans into a group', async () => {
    localStorage.setItem(GROUP_KEY, 'true')
    db = freshDb()
    const c120 = plan(db, 'Child 120', 120)
    const spacer = plan(db, 'Spacer', null)
    const c121 = plan(db, 'Child 121', 121)
    cacheFamily(db, [120])
    await boot(db)
    await showPlans()
    expect(planIds()).toEqual([c121, spacer, c120])

    const pressed = document.querySelector(`#boards [data-card-id="${spacer}"] summary`)!
    cache(db, 121, { issue: { title: 'Sub-issue 121' }, ancestors: [parent117] })
    // press 100ms before the next tick, then cross it inside the press grace
    await vi.advanceTimersByTimeAsync(lastPoll + 3000 - Date.now() - 100)
    pressed.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }))
    const before = lastPoll
    await vi.advanceTimersByTimeAsync(250)
    expect(lastPoll, 'the tick must land inside the press, or this test proves nothing').toBeGreaterThan(before)
    expect(document.contains(pressed)).toBe(true)
    expect(planIds()).toEqual([c121, spacer, c120])

    pressed.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true }))
    await pollTick()
    expect(planIds()).toEqual([c121, c120, spacer])
    expect(heads()).toHaveLength(1)
  })

  it('keeps a draft, its focus and an expanded row through a poll that changes grouping', async () => {
    localStorage.setItem(GROUP_KEY, 'true')
    db = freshDb()
    const c120 = plan(db, 'Child 120', 120, [{
      label: 'Pick a region', status: 'blocked', note: 'Two regions fit.', next_step: 'Choose a region.',
      action_owner: 'decision', impact: 'Unblocks the rollout.', options: [{ label: 'East', recommended: true }, { label: 'West' }],
    } as never])
    const spacer = plan(db, 'Spacer', null)
    const c121 = plan(db, 'Child 121', 121)
    cacheFamily(db, [120])
    await boot(db)
    await showPlans()
    const rowId = getBoard(db, 'agent-inbox', 'Child 120')!.rows[0]!.id
    click(document.querySelector(`#boards .board-row[data-row-id="${rowId}"]`))
    await settle()
    const draft = () => document.querySelector<HTMLTextAreaElement>(`#boards .row-panel-row[data-row-id="${rowId}"] textarea`)
    const input = draft()!
    input.focus()
    type(input, 'Half-typed')

    advanceClock(60_000)
    cache(db, 121, { issue: { title: 'Sub-issue 121' }, ancestors: [parent117] })
    await pollTick()
    // the draft holds the editable frame: same element, same text, same focus
    expect(draft()).toBe(input)
    expect(input.value).toBe('Half-typed')
    expect(document.activeElement).toBe(input)
    expect(planIds()).toEqual([c121, spacer, c120])

    type(draft(), '')
    await settle()
    expect(planIds()).toEqual([c121, c120, spacer])
    expect(heads()).toHaveLength(1)
    expect(document.querySelector(`#boards .row-panel-row[data-row-id="${rowId}"]`)).not.toBeNull()
    expect(document.activeElement).toBe(draft())

    // without a draft, a poll that dissolves the group still keeps the row open
    advanceClock(60_000)
    cache(db, 121, { issue: { title: 'Sub-issue 121' }, ancestors: [facts(K(116), { title: 'Moved' })] })
    await pollTick()
    expect(heads()).toEqual([])
    expect(planIds()).toEqual([c121, spacer, c120])
    expect(document.querySelector(`#boards .row-panel-row[data-row-id="${rowId}"]`)).not.toBeNull()
  })

  it('marks runs of a plan\'s rows under two parents, without reordering them, only while grouping', async () => {
    localStorage.setItem(GROUP_KEY, 'true')
    db = freshDb()
    cacheFamily(db)
    cache(db, 130, { issue: { title: 'Sub-issue 130' }, ancestors: [facts(K(116), { title: 'Other parent' })] })
    const link = (label: string, n: number | null) => ({ label, status: 'tracked' as const, ...(n === null ? {} : { issue: { repo: REPO, number: n } }) })
    const id = plan(db, 'Mixed', null, [link('one', 120), link('two', 121), link('three', 130), link('four', null)] as never)
    await boot(db)
    await showPlans()
    const table = document.querySelector(`#boards [data-card-id="${id}"] table.board-table`)!
    const lines = [...table.querySelectorAll('tr')].map((tr) => tr.classList.contains('row-parent-run')
      ? `> ${tr.textContent}` : tr.querySelector('.row-label')?.textContent)
    expect(lines).toEqual(['> Part of #117', 'one', 'two', '> Part of #116', 'three', 'four'])
    await toggle(headerSwitch())
    expect(document.querySelectorAll('#boards .row-parent-run')).toHaveLength(0)
  })
})
