// @vitest-environment jsdom
// Dashboard lanes PR 6 (docs/superpowers/specs/2026-11-13-dashboard-lanes-design.md
// §3.5): the Plans in progress lane, after Quiet, then Just landed and the Today
// ribbon, last on the page. A row shows one active plan with open steps under
// the lens and opens it in Plans; it holds no control and answers nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { annotateBoardRow, archiveBoard, closeProject, listBoards, upsertBoard } from '../../src/store.js'
import { PLANS_EMPTY } from '../../public/plans-lane.js'
import { advanceClock, bootApp, changedPollTick, click, freshDb, settle, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
beforeEach(() => {
  vi.stubGlobal('location', { hash: '', reload: vi.fn() })
})
afterEach(() => {
  db?.close()
  db = null
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const
const ASK = { status: 'blocked', note: 'Ready.', next_step: 'Do it.', action_owner: 'task', impact: 'Unblocks it.' }
type Step = string | Record<string, unknown>

// a plan with one row per step (a status, or a row's fields); rewriting it bumps its last change
function plan(d: Database.Database, title: string, steps: Step[], extra: { project?: string } = {}): string {
  advanceClock()
  const project = extra.project ?? AGENT.project
  const before = listBoards(d).find((b) => b.title === title && b.project === project)
  upsertBoard(d, {
    ...AGENT, ...extra, title, expectedVersion: before?.revision,
    rows: steps.map((step, index) => {
      const label = `Step ${index + 1}`
      const revision = before?.rows.find((r) => r.label === label)?.revision
      return { label, revision, ...(typeof step === 'string' ? { status: step } : step) }
    }) as never,
  })
  return listBoards(d).find((b) => b.title === title && b.project === project)!.id
}

const lane = () => document.querySelector<HTMLElement>('#dashboard .plans-lane')!
const planRows = () => [...document.querySelectorAll<HTMLElement>('#dashboard .pl-row')]
const planIds = () => planRows().map((el) => el.dataset.plPlan)
const planRow = (id: string) => planRows().find((el) => el.dataset.plPlan === id)!
const titles = () => planRows().map((el) => el.querySelector('.pl-title')?.textContent)
const part = (id: string, cls: string) => planRow(id).querySelector<HTMLElement>(cls)!
const allPlans = () => document.querySelector<HTMLButtonElement>('#dashboard .pl-all')!
const selectedTab = () => document.querySelector('.tab[aria-selected="true"]')?.getAttribute('data-tab')
const lensOn = (project: string) => document.querySelector(`#rail .rail-tab[data-project="${project}"]`)?.getAttribute('aria-selected') === 'true'
const key = (target: Element, name: string) => {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}
async function backToDashboard(): Promise<void> {
  click(document.querySelector('.tab[data-tab="dashboard"]'))
  await settle()
}

describe('the Plans in progress lane’s place on the page (§3.5)', () => {
  it('sits after Quiet; Home reads the list of asks, then Working, Quiet, Plans in progress, Just landed, Today', async () => {
    db = freshDb()
    plan(db, 'Plan A', ['missing'])
    await bootApp(db)
    // the list of asks comes first in the DOM, before the Dashboard part of Home
    expect(document.getElementById('needsYou')!.compareDocumentPosition(document.getElementById('dashboard')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const regions = ['working-lane', 'quiet-lane', 'plans-lane', 'dashboard-outcomes', 'dashboard-activity']
    const found = [...document.querySelectorAll<HTMLElement>(regions.map((cls) => `#dashboard .${cls}`).join(', '))]
    expect(found.map((el) => regions.find((cls) => el.classList.contains(cls)))).toEqual(regions)
    // the ribbon is the page's last lane, Just landed right before it
    const grid = document.querySelector('#dashboard .dashboard-grid')!
    expect(grid.lastElementChild?.classList.contains('dashboard-activity')).toBe(true)
    expect(grid.lastElementChild?.previousElementSibling?.classList.contains('dashboard-outcomes')).toBe(true)
    expect(lane().closest('.dashboard-grid')).toBe(grid)
    expect([lane(), grid.querySelector('.dashboard-outcomes'), grid.querySelector('.dashboard-activity')].map((el) => el?.querySelector('h2')?.textContent))
      .toEqual(['Plans in progress', 'Just landed', 'Today'])
    // the heading carries no count
    expect(document.getElementById('plansLaneTitle')?.textContent).not.toMatch(/\d/)
  })
})

describe('a Plans in progress row (§3.5)', () => {
  it('shows the title, the project under All projects, done of countable, the rows waiting on you and its last change', async () => {
    db = freshDb()
    const id = plan(db, 'Plan A', ['done', 'done', 'missing', ASK])
    await bootApp(db)
    expect(planIds()).toEqual([id])
    expect(part(id, '.pl-title').textContent).toBe('Plan A')
    // the title ellipsizes on one line, so its tooltip holds the whole of it
    expect(part(id, '.pl-title').title).toBe('Plan A')
    expect(part(id, '.pl-project-name').textContent).toBe('alpha')
    expect(part(id, '.pl-project').hidden).toBe(false)
    expect(part(id, '.pl-count').textContent).toBe('2/4')
    expect(part(id, '.pl-bar > i').style.getPropertyValue('--pl-done')).toBe('50%')
    expect(part(id, '.pl-bar').getAttribute('aria-hidden')).toBe('true')
    expect(part(id, '.pl-waiting').textContent).toBe('1 needs you')
    expect(part(id, '.pl-waiting').hidden).toBe(false)
    const board = listBoards(db).find((b) => b.id === id)!
    const time = part(id, '.pl-updated') as HTMLTimeElement
    expect(time.textContent).toMatch(/ ago$|^just now$/)
    expect(time.title).toBe(new Date(board.updated_at).toLocaleString())
    expect(time.dateTime).toBe(board.updated_at)
    expect(planRow(id).getAttribute('aria-label')).toMatch(/^Plan A\. alpha\. 2 of 4 steps done\. 1 needs you\. Updated /)
    expect(planRow(id).getAttribute('role')).toBe('listitem')
    // one link-like control: nothing inside it is a control
    expect(planRow(id).querySelector('button, a, select, input, textarea, summary')).toBeNull()
  })

  it('shows the pink count only above zero', async () => {
    db = freshDb()
    const id = plan(db, 'Plan A', ['done', 'missing'])
    await bootApp(db)
    expect(part(id, '.pl-waiting').hidden).toBe(true)
    expect(planRow(id).getAttribute('aria-label')).not.toMatch(/need/)
    plan(db, 'Plan A', ['done', ASK])
    await changedPollTick(db)
    expect(part(id, '.pl-waiting').hidden).toBe(false)
    expect(part(id, '.pl-waiting').textContent).toBe('1 needs you')
    plan(db, 'Plan A', [ASK, ASK])
    await changedPollTick(db)
    expect(part(id, '.pl-waiting').textContent).toBe('2 need you')
    // an answered ask no longer waits on you
    advanceClock()
    const asked = listBoards(db).find((b) => b.id === id)!.rows
    expect(annotateBoardRow(db, asked[0]!.id, 'Done my part.', 'answer', asked[0]!.revision)).toBe(true)
    expect(annotateBoardRow(db, asked[1]!.id, 'Done my part.', 'answer', asked[1]!.revision)).toBe(true)
    await changedPollTick(db)
    expect(part(id, '.pl-waiting').hidden).toBe(true)
  })

  it('keeps text that looks like HTML as text', async () => {
    db = freshDb()
    const title = '<img src=x onerror="window.__x=1">'
    const id = plan(db, title, ['missing'])
    await bootApp(db)
    expect(part(id, '.pl-title').textContent).toBe(title)
    expect(lane().querySelector('img')).toBeNull()
    expect((window as unknown as { __x?: number }).__x).toBeUndefined()
  })
})

describe('opening a plan from the lane (§3.5)', () => {
  it('a click or Enter opens that plan in Plans, with its project as the lens', async () => {
    db = freshDb()
    plan(db, 'Plan B', ['missing'], { project: 'beta' })
    const id = plan(db, 'Plan A', ['missing'])
    await bootApp(db)
    click(planRow(id))
    await settle()
    expect(selectedTab()).toBe('boards')
    expect(lensOn('alpha')).toBe(true)
    expect(document.querySelector(`#boards [data-card-id="${id}"]`)).not.toBeNull()

    // back on the Dashboard, under All projects again
    click(document.querySelector('#rail .rail-tab[data-project="__all__"]'))
    await backToDashboard()
    expect(lensOn('alpha')).toBe(false)
    const enter = key(planRow(id), 'Enter')
    await settle()
    expect(enter.defaultPrevented).toBe(true)
    expect(selectedTab()).toBe('boards')
    expect(lensOn('alpha')).toBe(true)
    expect(document.querySelector(`#boards [data-card-id="${id}"]`)).not.toBeNull()
  })

  it('a click that ends a text selection opens nothing', async () => {
    db = freshDb()
    const id = plan(db, 'Plan A', ['missing'])
    await bootApp(db)
    const text = part(id, '.pl-title').firstChild!
    document.getSelection()!.setBaseAndExtent(text, 0, text, 4)
    click(planRow(id))
    await settle()
    expect(selectedTab()).toBe('dashboard')
  })

  it('shows six plans, then All plans with how many more, which opens Plans under the lens', async () => {
    db = freshDb()
    for (let n = 1; n <= 8; n += 1) plan(db, `Plan ${n}`, ['missing'])
    await bootApp(db)
    expect(planRows()).toHaveLength(6)
    // newest change first
    expect(titles()).toEqual(['Plan 8', 'Plan 7', 'Plan 6', 'Plan 5', 'Plan 4', 'Plan 3'])
    expect(allPlans().textContent).toBe('All plans · 2 more ›')
    click(allPlans())
    await settle()
    expect(selectedTab()).toBe('boards')
    expect(lensOn('__all__')).toBe(true)
  })

  it('says only “All plans ›” when every plan shows', async () => {
    db = freshDb()
    for (let n = 1; n <= 3; n += 1) plan(db, `Plan ${n}`, ['missing'])
    await bootApp(db)
    expect(planRows()).toHaveLength(3)
    expect(allPlans().textContent).toBe('All plans ›')
    expect(allPlans().closest('.pl-more')?.hasAttribute('hidden')).toBe(false)
  })
})

describe('which plans the lane holds (§3.5)', () => {
  it('puts plans waiting on you first, then the newest change', async () => {
    db = freshDb()
    const waits = plan(db, 'Waits on you', [ASK])
    const older = plan(db, 'Older', ['missing'])
    const newer = plan(db, 'Newer', ['missing'])
    await bootApp(db)
    expect(planIds()).toEqual([waits, newer, older])
  })

  it('with a lens, only that project’s plans, with no project name', async () => {
    db = freshDb()
    const a = plan(db, 'Plan A', ['missing'])
    plan(db, 'Plan B', ['missing'], { project: 'beta' })
    await bootApp(db)
    expect(planRows()).toHaveLength(2)
    click(document.querySelector('#rail button.rail-tab[data-project="alpha"]'))
    await settle()
    expect(planIds()).toEqual([a])
    expect(part(a, '.pl-project').hidden).toBe(true)
    expect(planRow(a).getAttribute('aria-label')).not.toMatch(/alpha/)
  })

  it('leaves out an archived plan, a closed project’s plan and a plan with no open step', async () => {
    db = freshDb()
    const kept = plan(db, 'Still open', ['done', 'missing'])
    const archived = plan(db, 'Archived', ['missing'])
    archiveBoard(db, archived, listBoards(db).find((b) => b.id === archived)!.revision)
    plan(db, 'In a closed project', ['missing'], { project: 'beta' })
    closeProject(db, 'beta')
    // every row na: nothing countable, so the plan stays active, yet no step is open
    const settled = plan(db, 'Nothing left', ['na', 'na'])
    expect(listBoards(db).some((b) => b.id === settled)).toBe(true)
    await bootApp(db)
    expect(planIds()).toEqual([kept])
  })

  it('empty, the lane keeps its heading and says so', async () => {
    db = freshDb()
    plan(db, 'Nothing left', ['na'])
    await bootApp(db)
    expect(document.getElementById('plansLaneTitle')?.textContent).toBe('Plans in progress')
    expect(planRows()).toHaveLength(0)
    const empty = lane().querySelector<HTMLElement>('.pl-empty')!
    expect(empty.hidden).toBe(false)
    expect(empty.textContent).toBe(PLANS_EMPTY)
    expect(lane().querySelector<HTMLElement>('.pl-more')!.hidden).toBe(true)
  })
})

describe('the lane under the keyboard and the pointer (§3.1, §2)', () => {
  it('has one roving tab stop; J/K and the arrows move and reveal the row, never into the next lane', async () => {
    db = freshDb()
    const [c, b, a] = [plan(db, 'Plan C', ['missing']), plan(db, 'Plan B', ['missing']), plan(db, 'Plan A', ['missing'])]
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    expect(planIds()).toEqual([a, b, c])
    expect(planRows().filter((el) => el.tabIndex === 0)).toEqual([planRow(a)])
    planRow(a).focus()
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
    expect(key(planRow(a), 'j').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(planRow(b))
    expect(planRows().filter((el) => el.tabIndex === 0)).toEqual([planRow(b)])
    expect(scroll.mock.contexts).toEqual([planRow(b)])
    expect(scroll.mock.calls[0]![0]).toMatchObject({ block: 'nearest' })
    expect(key(planRow(b), 'ArrowDown').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(planRow(c))
    // at the lane's end nothing moves and nothing scrolls
    expect(key(planRow(c), 'j').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(planRow(c))
    expect(scroll).toHaveBeenCalledTimes(2)
    key(planRow(c), 'k')
    expect(document.activeElement).toBe(planRow(b))
    key(planRow(b), 'ArrowUp')
    expect(document.activeElement).toBe(planRow(a))
    expect(lane().contains(document.activeElement)).toBe(true)
  })

  it('holds a row under the pointer in place through a poll; the next poll after it leaves sorts', async () => {
    db = freshDb()
    const b = plan(db, 'Plan B', ['missing'])
    const a = plan(db, 'Plan A', ['missing'])
    await bootApp(db)
    expect(planIds()).toEqual([a, b])
    lane().dispatchEvent(new Event('pointerenter'))
    plan(db, 'Plan B', ['partial'])
    await changedPollTick(db)
    expect(planIds()).toEqual([a, b])
    lane().dispatchEvent(new Event('pointerleave'))
    await changedPollTick(db)
    expect(planIds()).toEqual([b, a])
  })

  it('holds the order while a row has focus, which it keeps through the poll', async () => {
    db = freshDb()
    const b = plan(db, 'Plan B', ['missing'])
    const a = plan(db, 'Plan A', ['missing'])
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    planRow(a).focus()
    plan(db, 'Plan B', ['partial'])
    await changedPollTick(db)
    expect(planIds()).toEqual([a, b])
    expect(document.activeElement).toBe(planRow(a))
    planRow(a).blur()
    await changedPollTick(db)
    expect(planIds()).toEqual([b, a])
  })

  it('moves focus on All plans to the heading when the lane empties under it', async () => {
    db = freshDb()
    plan(db, 'Plan A', ['missing'])
    await bootApp(db)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    allPlans().focus()
    expect(document.activeElement).toBe(allPlans())
    // its last open step is set aside, so the lane empties and All plans hides
    plan(db, 'Plan A', ['na'])
    await changedPollTick(db)
    expect(planRows()).toHaveLength(0)
    expect(lane().querySelector<HTMLElement>('.pl-more')!.hidden).toBe(true)
    expect(document.activeElement).toBe(document.getElementById('plansLaneTitle'))
  })

  it('keeps a text selection in a row through a poll that repaints', async () => {
    db = freshDb()
    const id = plan(db, 'Plan A', ['missing'])
    const other = plan(db, 'Plan B', ['missing'])
    await bootApp(db)
    const text = part(id, '.pl-title').firstChild!
    document.getSelection()!.setBaseAndExtent(text, 0, text, 4)
    // another plan changes, so this paint has something to draw
    plan(db, 'Plan B', ['done', 'missing'])
    await changedPollTick(db)
    expect(part(other, '.pl-count').textContent).toBe('1/2')
    expect(part(id, '.pl-title').firstChild).toBe(text)
    expect(String(document.getSelection())).toBe('Plan')
  })

  it('CONTROL: a changed title does replace its text node', async () => {
    db = freshDb()
    const id = plan(db, 'Plan A', ['missing'])
    await bootApp(db)
    const text = part(id, '.pl-title').firstChild!
    advanceClock()
    db.prepare('UPDATE boards SET title = ?, revision = revision + 1, updated_at = ? WHERE id = ?').run('Plan A, renamed', new Date().toISOString(), id)
    await changedPollTick(db)
    expect(part(id, '.pl-title').textContent).toBe('Plan A, renamed')
    expect(part(id, '.pl-title').firstChild).not.toBe(text)
  })
})
