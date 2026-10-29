// @vitest-environment jsdom
// Issue #299: the poll carries archived plans in brief (/api/boards/archived/summary).
// The complete list is read from /api/boards/archived only while a surface needs
// it (the archived fold, a plan lingering after its agent archived it, search,
// a deep link, Handoffs or Plan flow), and every surface reads as it did with
// the complete list on every tick.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { archiveBoard, getBoard, insertItem, listBoards, resolveItem, updateBoardRow, upsertBoard } from '../../src/store.js'
import {
  advanceClock, bootApp, buttonLabelled, click, expectConsoleError, freshDb, pollTick, searchFor, settle, useDomTest,
} from './harness.js'
import type { BootOptions } from './harness.js'

useDomTest()
let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const FULL = '/api/boards/archived'
const BRIEF = '/api/boards/archived/summary'
const ALPHA = { project: 'alpha', stream: 'main', agent: 'copilot' } as const
const UNAVAILABLE = 'Archived plans are unavailable right now.'

interface Read { path: string; status: number }

// Holds or fails /api/boards/archived on demand (and the brief, for an older
// viewer); records every GET the app makes.
function archivedControl() {
  const control = { fail: false, hold: null as Promise<void> | null, briefMissing: false, reads: [] as Read[] }
  let release: (() => void) | null = null
  const interceptFetch: NonNullable<BootOptions['interceptFetch']> = async (input, init, next) => {
    const path = String(input)
    if (path === BRIEF && control.briefMissing) {
      control.reads.push({ path, status: 404 })
      return new Response('Not Found', { status: 404 })
    }
    if (path === FULL) {
      if (control.hold) await control.hold
      if (control.fail) {
        control.reads.push({ path, status: 500 })
        return new Response('unavailable', { status: 500 })
      }
    }
    const response = await next()
    if ((init?.method ?? 'GET') === 'GET') control.reads.push({ path, status: response.status })
    return response
  }
  return {
    control,
    interceptFetch,
    hold() { control.hold = new Promise<void>((resolve) => { release = resolve }) },
    release() { control.hold = null; release?.(); release = null },
  }
}

const fullReads = (reads: Read[]): number[] => reads.filter((read) => read.path === FULL).map((read) => read.status)
const status = (): string => document.getElementById('status')?.textContent ?? ''
const fold = (): HTMLDetailsElement | null => document.querySelector<HTMLDetailsElement>('#boards .archived-fold')
// a plan's title, without the short id the card shows after it
const foldTitles = (): string[] =>
  [...document.querySelectorAll('#boards .archived-fold .board .board-title')].map((el) => (el.textContent ?? '').replace(/#\w+$/, ''))
const foldWait = (): string | null => fold()?.querySelector('.archived-loading')?.textContent ?? null
const signal = (name: string): string =>
  document.querySelector(`[data-dashboard-signal="${name}"] .dashboard-value`)?.textContent ?? ''
const recentOutcomes = (): string[] =>
  [...document.querySelectorAll('.dashboard-outcome-list .dashboard-outcome strong')].map((el) => el.textContent ?? '')

async function selectTab(tab: string): Promise<void> {
  click(document.querySelector(`.tab[data-tab="${tab}"]`))
  await settle()
}

// The human opening (or closing) the fold: the browser sets `open`, then fires `toggle`.
async function toggleFold(open: boolean): Promise<void> {
  const details = fold()!
  details.open = open
  details.dispatchEvent(new window.Event('toggle'))
  await settle()
}

// An archived plan, written as an agent would, then archived.
function archived(d: Database.Database, project: string, title: string, context: string, outcomes: string[] = [], agent = 'copilot'): string {
  advanceClock()
  const scope = { project, stream: 'main', agent }
  upsertBoard(d, { ...scope, title, rows: [{ label: 'Step', status: 'tracked', context }] })
  for (const label of outcomes) {
    advanceClock()
    updateBoardRow(d, {
      ...scope, title, expectedBoardVersion: getBoard(d, project, title)!.revision, label, status: 'done', outcome: `${label} shipped.`,
    })
  }
  advanceClock()
  const board = getBoard(d, project, title)!
  expect(archiveBoard(d, board.id, board.revision)).toBe(true)
  return board.id
}

// One active plan, and archived ones: `retired` has nothing else, and alpha's
// six outcomes are more than the brief carries for one project.
function seedHub(d: Database.Database): { quokka: string; rollout: string; docs: string } {
  upsertBoard(d, { ...ALPHA, title: 'Active plan', rows: [{ label: 'Work', status: 'tracked' }] })
  const quokka = archived(d, 'retired', 'Habitat move', 'The quokka enclosure moved north.')
  const rollout = archived(d, 'alpha', 'Old rollout', 'Canary background.', ['Ship 1', 'Ship 2', 'Ship 3'])
  const docs = archived(d, 'alpha', 'Older docs', 'Docs background.', ['Ship 4', 'Ship 5', 'Ship 6'])
  return { quokka, rollout, docs }
}

describe('archived plans in brief (issue #299)', () => {
  // First on purpose: a result click deep-links through the hash, and window
  // listeners from earlier boots in this file stay live (see harness.ts).
  it('searches every archived plan, busy while the complete list loads, and opens the match', async () => {
    db = freshDb()
    const { quokka } = seedHub(db)
    const archive = archivedControl()
    await bootApp(db, { interceptFetch: archive.interceptFetch })
    expect(fullReads(archive.control.reads)).toEqual([])

    archive.hold()
    await searchFor('quokka')
    const results = document.getElementById('searchResults')!
    expect(results.textContent).not.toContain('No results')
    expect(document.getElementById('searchStatus')?.textContent).toBe('Searching archived plans…')

    archive.release()
    await settle()
    expect(fullReads(archive.control.reads)).toEqual([200])
    const option = results.querySelector<HTMLElement>(`[role="option"][data-search-target="${quokka}"]`)
    expect(option?.closest('.search-result-group')?.querySelector('.search-result-group-label')?.textContent).toBe('Archived plans')
    expect(option?.querySelector('.search-result-match mark')?.textContent?.toLowerCase()).toBe('quokka')
    expect(document.getElementById('searchStatus')?.textContent).toBe('1 search result')

    click(option)
    await settle()
    expect(document.getElementById('boards')?.hidden).toBe(false)
    expect(fold()?.open).toBe(true)
    const card = document.querySelector(`#boards .archived-fold [data-card-id="${quokka}"]`)
    expect(card?.querySelector('.search-jump-highlight')?.textContent?.toLowerCase()).toBe('quokka')
    // the open fold keeps the complete list read, and the plan on screen
    await pollTick()
    expect(document.querySelector(`#boards .archived-fold [data-card-id="${quokka}"]`)).not.toBeNull()
    expect(fullReads(archive.control.reads).at(-1)).toBe(304)
  })

  it('polls only the brief while every count that mentions archived plans stays exact', async () => {
    db = freshDb()
    seedHub(db)
    const archive = archivedControl()
    await bootApp(db, { interceptFetch: archive.interceptFetch })

    // The Dashboard (the cold-launch view) counts every archived outcome and
    // proves its recent ones from the brief.
    expect(signal('outcomes')).toBe('6')
    expect(recentOutcomes()).toEqual(['Ship 6', 'Ship 5', 'Ship 4', 'Ship 3'])
    // A project whose only plans are archived keeps its rail tab.
    expect(document.querySelector('#rail button.rail-tab[data-project="retired"]')).not.toBeNull()
    await pollTick()
    await selectTab('needsYou')
    await pollTick()
    await selectTab('boards')
    expect(fold()?.open).toBe(false)
    expect(fold()?.querySelector('summary')?.textContent).toBe('Archived plans (3)')
    click(document.querySelector('#rail button.rail-tab[data-project="alpha"]'))
    await settle()
    expect(fold()?.querySelector('summary')?.textContent).toBe('Archived plans (2)')
    await pollTick()
    expect(fullReads(archive.control.reads)).toEqual([])
    const briefs = archive.control.reads.filter((read) => read.path === BRIEF)
    expect(briefs.length).toBeGreaterThan(3)
    expect(briefs.at(-1)?.status).toBe(304)
    expect(status()).toBe('')
  })

  it('reads the complete list when the archived fold opens, paints it at once, and stops once it closes', async () => {
    db = freshDb()
    seedHub(db)
    const archive = archivedControl()
    await bootApp(db, { interceptFetch: archive.interceptFetch })
    await selectTab('boards')
    expect(foldWait()).toBe('Loading archived plans…')

    archive.hold()
    await toggleFold(true)
    // painted at once with what is known: the count, and a loading line
    expect(fold()?.querySelector('summary')?.textContent).toBe('Archived plans (3)')
    expect(foldWait()).toBe('Loading archived plans…')
    expect(fold()?.querySelector('.archived-loading')?.getAttribute('role')).toBe('status')

    // the human's own entry point paints the list without waiting for a poll
    archive.release()
    await settle()
    expect(foldTitles()).toEqual(['Older docs', 'Old rollout', 'Habitat move'])
    expect(foldWait()).toBeNull()
    expect(fullReads(archive.control.reads)).toEqual([200])

    await pollTick()
    expect(fullReads(archive.control.reads)).toEqual([200, 304])
    await toggleFold(false)
    await pollTick()
    await pollTick()
    expect(fullReads(archive.control.reads)).toEqual([200, 304])
  })

  it('skips an idle poll that read the complete list again, and repaints when it changed (#298)', async () => {
    db = freshDb()
    seedHub(db)
    const archive = archivedControl()
    await bootApp(db, { interceptFetch: archive.interceptFetch })
    await selectTab('boards')
    await toggleFold(true)
    await pollTick() // the frame the last input asked for
    const card = document.querySelector('#boards .archived-fold .board')
    expect(card).not.toBeNull()
    for (let tick = 0; tick < 3; tick++) {
      await pollTick()
      expect(fullReads(archive.control.reads).at(-1)).toBe(304)
      expect(document.querySelector('#boards .archived-fold .board'), `tick ${tick + 1} rebuilt an unchanged frame`).toBe(card)
    }

    // an agent archives another plan: both reads change, and the frame repaints
    archived(db, 'alpha', 'Newest retirement', 'New background.')
    await pollTick()
    expect(fullReads(archive.control.reads).at(-1)).toBe(200)
    expect(fold()?.querySelector('summary')?.textContent).toBe('Archived plans (4)')
    expect(foldTitles()[0]).toBe('Newest retirement')
  })

  it('degrades a failed read to an unavailable line, without failing the tick or blanking the frame', async () => {
    db = freshDb()
    seedHub(db)
    const archive = archivedControl()
    await bootApp(db, { interceptFetch: archive.interceptFetch })
    await selectTab('boards')
    archive.control.fail = true
    await toggleFold(true)
    expect(foldWait()).toBe(UNAVAILABLE)
    // one read for the human's open, then one per poll: a fold rebuilt open asks for nothing
    expect(fullReads(archive.control.reads)).toEqual([500])
    await pollTick()
    expect(fullReads(archive.control.reads)).toEqual([500, 500])
    expect(foldWait()).toBe(UNAVAILABLE)
    expect(fold()?.querySelector('summary')?.textContent).toBe('Archived plans (3)')
    expect(document.querySelector('#boards .boards > .board .board-title')?.textContent).toContain('Active plan')
    expect(status()).toBe('')
    await searchFor('quokka')
    expect(document.getElementById('searchStatus')?.textContent).toBe(UNAVAILABLE)
    expect(document.getElementById('searchResults')?.textContent).not.toContain('No results')

    // the poll keeps trying while a surface needs the list, and recovers
    archive.control.fail = false
    await pollTick()
    expect(foldWait()).toBeNull()
    expect(foldTitles()).toHaveLength(3)
    expect(document.getElementById('searchStatus')?.textContent).toBe('1 search result')
    expect(status()).toBe('')
  })

  it('reads a plan the human watched within the tick that archives it, so it lingers (#373: on its own)', async () => {
    db = freshDb()
    upsertBoard(db, { ...ALPHA, title: 'Watched', rows: [{ label: 'First', status: 'done' }, { label: 'Last', status: 'tracked' }] })
    const archive = archivedControl()
    await bootApp(db, { interceptFetch: archive.interceptFetch })
    await selectTab('boards')
    expect(fullReads(archive.control.reads)).toEqual([])

    // the agent finishes the last row, and the store archives the complete plan
    advanceClock()
    updateBoardRow(db, {
      ...ALPHA, title: 'Watched', expectedBoardVersion: getBoard(db, 'alpha', 'Watched')!.revision,
      label: 'Last', status: 'done', expectedRevision: getBoard(db, 'alpha', 'Watched')!.rows[1]!.revision,
    })
    await pollTick()
    expect(fullReads(archive.control.reads)).toEqual([])
    expect(archive.control.reads.filter((read) => read.path.startsWith('/api/boards/archived/plans?ids=')).map((read) => read.status))
      .toEqual([200])
    const lingering = document.querySelector('#boards .boards > .board.lingering')
    expect(lingering?.querySelector('.linger-badge')?.textContent).toBe('completed — archived')
    expect(buttonLabelled('Un-archive', lingering!)).not.toBeNull()
    expect(document.querySelector('#boards .archived-loading')).toBeNull()
    // it keeps lingering while Plans shows it
    await pollTick()
    expect(document.querySelector('#boards .boards > .board.lingering')).not.toBeNull()
  })

  it('counts every outcome in Handoffs at once and lists the omitted ones once read', async () => {
    db = freshDb()
    seedHub(db)
    const archive = archivedControl()
    await bootApp(db, { interceptFetch: archive.interceptFetch })
    archive.hold()
    click(document.querySelector('.relay-btn'))
    await settle()
    const lane = () => document.querySelector('#relaybox [data-relay-lane="outcome"]')!
    expect(lane().querySelector('.relay-count')?.textContent).toBe('6')
    expect(lane().querySelectorAll('.relay-card')).toHaveLength(4)
    expect(lane().querySelector('[role="status"]')?.textContent).toBe('Loading older outcomes…')

    archive.release()
    await settle()
    expect(lane().querySelector('.relay-count')?.textContent).toBe('6')
    expect(lane().querySelectorAll('.relay-card')).toHaveLength(6)
    expect(lane().querySelector('[role="status"]')).toBeNull()
    expect(lane().textContent).toContain('Ship 1 shipped.')
  })

  it('reads the complete list for a Dashboard lens only the archived plans can prove, and not older history', async () => {
    db = freshDb()
    const claude = { project: 'alpha', stream: 'main', agent: 'claude' }
    const resolved = (scope: typeof claude, title: string, outcome?: string) => {
      advanceClock()
      const id = insertItem(db!, { ...scope, kind: 'question', title })
      advanceClock()
      resolveItem(db!, id, outcome)
    }
    // claude's oldest outcome, which a hook sweep of 55 newer closures pushes off the page
    resolved(claude, 'Old claude question', 'Old claude outcome.')
    for (let index = 0; index < 55; index += 1) resolved({ project: 'sweep', stream: '', agent: 'hook' }, `Backstop ${index}`)
    // claude's four recent outcomes, on the page
    for (const index of [1, 2, 3, 4]) resolved(claude, `Claude item ${index}`, `Claude outcome ${index}.`)
    // claude's archived outcomes, newer still, which alpha's four newest (copilot's) leave out of the brief
    archived(db, 'alpha', 'Claude archived', 'Background.', ['C1', 'C2'], 'claude')
    archived(db, 'alpha', 'Newest copilot', 'Background.', ['N1', 'N2', 'N3', 'N4'])
    const archive = archivedControl()
    await bootApp(db, { interceptFetch: archive.interceptFetch })
    expect(recentOutcomes()).toEqual(['N4', 'N3', 'N2', 'N1'])
    expect(fullReads(archive.control.reads)).toEqual([])

    const agents = document.getElementById('agentSelect') as HTMLSelectElement
    agents.value = 'claude'
    agents.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    expect(fullReads(archive.control.reads)).toEqual([200])
    expect(signal('outcomes')).toBe('7')
    expect(recentOutcomes()).toEqual(['C2', 'C1', 'Claude item 4', 'Claude item 3'])
    // the page alone proves claude's lens against older history: it is not read
    expect(archive.control.reads.some((read) => read.path === '/api/items/history')).toBe(false)
  })

  // A project with no more archived outcomes than the brief carries: the open
  // lane draws them from the brief, and each card must read as the complete
  // list draws it (owner, then note or next step, then the outcome).
  it('draws Handoffs outcome cards from the brief exactly as from the complete list', async () => {
    db = freshDb()
    advanceClock()
    upsertBoard(db, {
      ...ALPHA, title: 'Cards',
      rows: [
        {
          label: 'Approve', status: 'done', note: 'Ready to ship.', next_step: 'Approve the release.',
          action_owner: 'approval', outcome: 'Approved.',
        },
        { label: 'Pick', status: 'done', options: [{ label: 'Tuesday', recommended: true }, { label: 'Thursday' }], outcome: 'Tuesday.' },
        { label: 'Open step', status: 'tracked' },
      ],
    })
    const plan = getBoard(db, 'alpha', 'Cards')!
    archiveBoard(db, plan.id, plan.revision)
    const archive = archivedControl()
    await bootApp(db, { interceptFetch: archive.interceptFetch })
    click(document.querySelector('.relay-btn'))
    await settle()
    const lane = () => document.querySelector('#relaybox [data-relay-lane="outcome"] .relay-body')!
    // drawn from the brief: nothing omitted, so the complete list is not read
    expect(fullReads(archive.control.reads)).toEqual([])
    const cards = [...lane().querySelectorAll('.relay-card')]
    expect(cards.map((card) => card.querySelector('.relay-owner')?.textContent)).toEqual(['Ready after approval', 'Decision'])
    expect(cards[0]?.querySelector('.relay-summary-text')?.textContent).toBe('Ready to ship.')
    const fromBrief = lane().innerHTML

    // the same lane from the complete list, as a viewer without the brief serves it
    archive.control.briefMissing = true
    await pollTick()
    expect(fullReads(archive.control.reads)).toEqual([200])
    expect(lane().innerHTML).toBe(fromBrief)
  })

  it('keeps reading the complete list while Plan flow shows an archived plan', async () => {
    db = freshDb()
    const { rollout } = seedHub(db)
    const archive = archivedControl()
    await bootApp(db, { interceptFetch: archive.interceptFetch })
    await selectTab('boards')
    await toggleFold(true)
    const card = document.querySelector(`#boards .archived-fold [data-card-id="${rollout}"]`)!
    click(buttonLabelled('Plan flow', card))
    await settle()
    expect(document.getElementById('missionbox')?.hidden).toBe(false)
    // the fold behind it closes; the flow still needs the plan's rows
    fold()!.open = false
    fold()!.dispatchEvent(new window.Event('toggle'))
    const before = fullReads(archive.control.reads).length
    await pollTick()
    expect(fullReads(archive.control.reads).length).toBe(before + 1)
    expect(document.getElementById('missionbox')?.hidden).toBe(false)
    expect(document.querySelector('#missionbox .mission-root-title')?.textContent).toBe('Old rollout')
    // a failed read leaves the flow as last drawn rather than closing it
    archive.control.fail = true
    await pollTick()
    expect(fullReads(archive.control.reads).at(-1)).toBe(500)
    expect(document.getElementById('missionbox')?.hidden).toBe(false)
    expect(document.querySelector('#missionbox .mission-root-title')?.textContent).toBe('Old rollout')
  })

  it('reads the complete list in place of the brief from a viewer older than #299', async () => {
    db = freshDb()
    seedHub(db)
    const archive = archivedControl()
    archive.control.briefMissing = true
    await bootApp(db, { interceptFetch: archive.interceptFetch })
    expect(status()).toBe('')
    expect(signal('outcomes')).toBe('6')
    expect(fullReads(archive.control.reads)).toEqual([200])
    await selectTab('boards')
    expect(fold()?.querySelector('summary')?.textContent).toBe('Archived plans (3)')
    expect(foldWait()).toBeNull()
    expect(foldTitles()).toHaveLength(3)
    await pollTick()
    expect(status()).toBe('')
    expect(fullReads(archive.control.reads).at(-1)).toBe(304)
  })

  it('fails the tick, as before #299, when an older viewer cannot serve the complete list either', async () => {
    db = freshDb()
    seedHub(db)
    const archive = archivedControl()
    await bootApp(db, { interceptFetch: archive.interceptFetch })
    expect(signal('outcomes')).toBe('6')
    archive.control.briefMissing = true
    archive.control.fail = true
    expectConsoleError(/Archived plans are unavailable right now/)
    await pollTick()
    expect(status()).toBe('disconnected')
    // the frame on screen stays
    expect(signal('outcomes')).toBe('6')
  })
})

// Issue #373: a plan the human watched lingers in Plans once its agent archives
// it, for the rest of the session. It is drawn whole from its own read
// (/api/boards/archived/plans?ids=…), so the poll stops reading every archived
// plan for it, and the card stays complete and current.
describe('a lingering plan reads only itself (issue #373)', () => {
  const PLANS = '/api/boards/archived/plans'
  const lingerReads = (reads: Read[]): number[] =>
    reads.filter((read) => read.path.startsWith(`${PLANS}?`)).map((read) => read.status)
  const lingeringCard = (): HTMLElement | null => document.querySelector('#boards .boards > .board.lingering')
  const cardRows = (card: HTMLElement | null): string[] =>
    [...card?.querySelectorAll('.board-row') ?? []].map((tr) =>
      `${tr.querySelector('.row-label')?.textContent}: ${tr.querySelector('.note-line')?.textContent}${tr.querySelector('.more-dot') ? ' …' : ''}`)

  // A watched plan the agent finishes, which the store archives at 100%, beside
  // an unrelated active plan and archived plans the human never watched.
  async function lingering(d: Database.Database, archive: ReturnType<typeof archivedControl>): Promise<void> {
    seedHub(d)
    upsertBoard(d, {
      ...ALPHA, title: 'Watched',
      rows: [{ label: 'First', status: 'done', note: 'Landed.', context: 'First background.' }, { label: 'Last', status: 'tracked', context: 'Last background.' }],
    })
    // every row of a finished plan is done: show them, to check the card draws each
    localStorage.setItem('agent-inbox-hide-completed', 'false')
    await bootApp(d, { interceptFetch: archive.interceptFetch })
    await selectTab('boards')
    advanceClock()
    const watched = getBoard(d, 'alpha', 'Watched')!
    updateBoardRow(d, {
      ...ALPHA, title: 'Watched', expectedBoardVersion: watched.revision,
      label: 'Last', status: 'done', note: 'Shipped.', expectedRevision: watched.rows[1]!.revision,
    })
    await pollTick()
    expect(watchedArchived(d)).toBeDefined()
  }
  const watchedArchived = (d: Database.Database) => listBoards(d, { status: 'archived' }).find((plan) => plan.title === 'Watched')

  // An agent's write to the unrelated active plan: the boards and board_rows
  // domains move, so before #373 the complete list was rebuilt and read again.
  function unrelatedWrite(d: Database.Database, note: string): void {
    advanceClock()
    const plan = getBoard(d, 'alpha', 'Active plan')!
    updateBoardRow(d, {
      ...ALPHA, title: 'Active plan', expectedBoardVersion: plan.revision,
      label: 'Work', status: 'tracked', note, expectedRevision: plan.rows[0]!.revision,
    })
  }

  it('stops reading the complete archived list once the lingering card is in hand', async () => {
    db = freshDb()
    const archive = archivedControl()
    await lingering(db, archive)
    const card = lingeringCard()
    expect(card?.querySelector('.linger-badge')?.textContent).toBe('completed — archived')
    expect(cardRows(card)).toEqual(['First: Landed. …', 'Last: Shipped. …'])
    expect(buttonLabelled('Un-archive', card!)).not.toBeNull()
    expect(document.querySelector('#boards .boards > .archived-loading')).toBeNull()
    const before = fullReads(archive.control.reads).length

    for (let tick = 0; tick < 4; tick++) {
      unrelatedWrite(db, `Edit ${tick}.`)
      await pollTick()
      expect(cardRows(lingeringCard()), `tick ${tick + 1}`).toEqual(['First: Landed. …', 'Last: Shipped. …'])
    }
    expect(fullReads(archive.control.reads).length - before).toBe(0)
    expect(fullReads(archive.control.reads)).toEqual([])
    // one read of the lingering plan in the tick that archived it, then a
    // revalidation per poll: its bytes did not change
    expect(lingerReads(archive.control.reads)).toEqual([200, 304, 304, 304, 304])
    // an idle poll revalidates it and paints nothing (#298)
    const painted = lingeringCard()
    await pollTick()
    expect(lingerReads(archive.control.reads).at(-1)).toBe(304)
    expect(lingeringCard()).toBe(painted)
    expect(fold()?.querySelector('summary')?.textContent).toBe('Archived plans (3)')
    expect(foldWait()).toBe('Loading archived plans…')
  })

  it('redraws the lingering card when its agent writes to the archived plan', async () => {
    db = freshDb()
    const archive = archivedControl()
    await lingering(db, archive)
    advanceClock()
    const watched = watchedArchived(db)!
    updateBoardRow(db, {
      ...ALPHA, title: 'Watched', expectedBoardVersion: watched.revision,
      label: 'First', status: 'done', note: 'Landed, then verified.', expectedRevision: watched.rows[0]!.revision,
    })
    expect(watchedArchived(db)?.rows[0]?.note).toBe('Landed, then verified.')
    await pollTick()
    expect(cardRows(lingeringCard())).toEqual(['First: Landed, then verified. …', 'Last: Shipped. …'])
    expect(lingerReads(archive.control.reads)).toEqual([200, 200])
    expect(fullReads(archive.control.reads)).toEqual([])
  })

  it('reads the lingering plan at once when the human returns to Plans, and only while Plans shows it', async () => {
    db = freshDb()
    const archive = archivedControl()
    await lingering(db, archive)
    await selectTab('needsYou')
    await pollTick()
    await pollTick()
    expect(lingerReads(archive.control.reads)).toEqual([200])
    await selectTab('boards')
    expect(lingerReads(archive.control.reads)).toEqual([200, 304])
    expect(cardRows(lingeringCard())).toEqual(['First: Landed. …', 'Last: Shipped. …'])
    expect(fullReads(archive.control.reads)).toEqual([])
  })

  it('draws the lingering card from the complete list while the fold is open, and goes back to its own read', async () => {
    db = freshDb()
    const archive = archivedControl()
    await lingering(db, archive)
    await toggleFold(true)
    expect(fullReads(archive.control.reads)).toEqual([200])
    expect(foldTitles()).toHaveLength(3)
    expect(cardRows(lingeringCard())).toEqual(['First: Landed. …', 'Last: Shipped. …'])
    await pollTick()
    expect(lingerReads(archive.control.reads)).toEqual([200])
    await toggleFold(false)
    await pollTick()
    await pollTick()
    expect(fullReads(archive.control.reads)).toEqual([200, 304])
    expect(lingerReads(archive.control.reads)).toEqual([200, 304, 304])
    expect(cardRows(lingeringCard())).toEqual(['First: Landed. …', 'Last: Shipped. …'])
  })

  it('degrades a failed read of the lingering plan to an unavailable line, and recovers', async () => {
    db = freshDb()
    const archive = archivedControl()
    const failing = { on: false }
    const intercept: NonNullable<BootOptions['interceptFetch']> = async (input, init, next) => {
      if (failing.on && String(input).startsWith(`${PLANS}?`)) {
        archive.control.reads.push({ path: String(input), status: 500 })
        return new Response('unavailable', { status: 500 })
      }
      return archive.interceptFetch(input, init, next)
    }
    await lingering(db, { ...archive, interceptFetch: intercept })
    failing.on = true
    unrelatedWrite(db, 'Edit.')
    await pollTick()
    expect(lingeringCard()).toBeNull()
    expect(document.querySelector('#boards .boards > .archived-loading')?.textContent).toBe(UNAVAILABLE)
    expect(status()).toBe('')
    expect(document.querySelector('#boards .boards > .board .board-title')?.textContent).toContain('Active plan')
    failing.on = false
    await pollTick()
    expect(cardRows(lingeringCard())).toEqual(['First: Landed. …', 'Last: Shipped. …'])
    expect(fullReads(archive.control.reads)).toEqual([])
  })

  it('reads the complete list in place of its own read from a viewer older than #373', async () => {
    db = freshDb()
    const archive = archivedControl()
    const intercept: NonNullable<BootOptions['interceptFetch']> = async (input, init, next) => {
      if (String(input).startsWith(`${PLANS}?`)) {
        archive.control.reads.push({ path: String(input), status: 404 })
        return new Response('Not Found', { status: 404 })
      }
      return archive.interceptFetch(input, init, next)
    }
    await lingering(db, { ...archive, interceptFetch: intercept })
    expect(cardRows(lingeringCard())).toEqual(['First: Landed. …', 'Last: Shipped. …'])
    expect(fullReads(archive.control.reads)).toEqual([200])
    expect(status()).toBe('')
  })
})
