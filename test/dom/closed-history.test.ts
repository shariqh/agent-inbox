// @vitest-environment jsdom
// Issue #184: /api/items carries open work plus the most recently touched closed
// items. Older history is read from /api/items/history only while a surface
// needs it, and every surface reads exactly as it did with the full list.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, listItems, replyItem, resolveItem } from '../../src/store.js'
import {
  advanceClock, badgeCount, bootApp, buttonLabelled, click, freshDb, navigateToHash, pollTick, searchFor,
  settle, showInbox, tabCount, type, useDomTest,
} from './harness.js'
import type { BootOptions } from './harness.js'

useDomTest()
let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const ALPHA = { project: 'alpha', stream: 'main', agent: 'copilot' } as const
const ARCHIVE = { project: 'archive', stream: 'legacy', agent: 'legacy-bot' } as const
const HISTORY = '/api/items/history'

interface Read { path: string; status: number }

function recorder(): { reads: Read[]; interceptFetch: NonNullable<BootOptions['interceptFetch']> } {
  const reads: Read[] = []
  return {
    reads,
    interceptFetch: async (input, init, next) => {
      const response = await next()
      if ((init?.method ?? 'GET') === 'GET') reads.push({ path: String(input), status: response.status })
      return response
    },
  }
}

const historyReads = (reads: Read[]): Read[] => reads.filter((read) => read.path === HISTORY)
const status = (): string => document.getElementById('status')?.textContent ?? ''
const UNAVAILABLE = 'Older history is unavailable right now.'

// A hook sweep janitoring old backstop questions: closed without an outcome,
// they take every recently touched slot of the page.
function openBackstops(d: Database.Database, count = 55): string[] {
  const ids: string[] = []
  for (let index = 0; index < count; index += 1) {
    advanceClock()
    ids.push(insertItem(d, { project: 'sweep', stream: '', agent: 'hook', kind: 'question', title: `Backstop ${index}` }))
  }
  return ids
}

function sweep(d: Database.Database, ids: string[]): void {
  advanceClock()
  for (const id of ids) resolveItem(d, id)
}

// Fails or holds /api/items/history on demand; everything else reaches the app.
function historyControl() {
  const control = { fail: false, hold: null as Promise<void> | null, reads: [] as Read[] }
  const interceptFetch: NonNullable<BootOptions['interceptFetch']> = async (input, init, next) => {
    if (String(input) === HISTORY) {
      if (control.hold) await control.hold
      if (control.fail) {
        control.reads.push({ path: HISTORY, status: 500 })
        return new Response('unavailable', { status: 500 })
      }
    }
    const response = await next()
    if ((init?.method ?? 'GET') === 'GET') control.reads.push({ path: String(input), status: response.status })
    return response
  }
  return { control, interceptFetch }
}

// The three archive decisions are the oldest closed items and the page's bound
// (50) leaves them and the ten oldest alpha items out: 13 omitted of 63 closed.
function seedHub(d: Database.Database): { archive: string[]; alpha: string[] } {
  const archive: string[] = []
  for (let index = 0; index < 3; index += 1) {
    advanceClock()
    const id = insertItem(d, {
      ...ARCHIVE, kind: 'question', title: `Archived decision ${index}`,
      context: index === 1 ? 'The quokka migration plan was retired.' : 'Legacy background.',
    })
    advanceClock()
    resolveItem(d, id, `Archived outcome ${index}`)
    archive.push(id)
  }
  const alpha: string[] = []
  for (let index = 0; index < 60; index += 1) {
    advanceClock()
    const id = insertItem(d, { ...ALPHA, kind: 'note', title: `Alpha closed ${index}` })
    advanceClock()
    resolveItem(d, id, `Alpha outcome ${index}`)
    alpha.push(id)
  }
  return { archive, alpha }
}

const historyTitles = (): string[] =>
  [...document.querySelectorAll('#done .history-row .history-copy strong')].map((el) => el.textContent ?? '')
const signal = (name: string): string =>
  document.querySelector(`[data-dashboard-signal="${name}"] .dashboard-value`)?.textContent ?? ''
const recentOutcomes = (): string[] =>
  [...document.querySelectorAll('.dashboard-outcome-list .dashboard-outcome strong')].map((el) => el.textContent ?? '')

async function selectTab(tab: string): Promise<void> {
  click(document.querySelector(`.tab[data-tab="${tab}"]`))
  await settle()
}

async function selectProject(project: string): Promise<void> {
  click(document.querySelector(`#rail button.rail-tab[data-project="${project}"]`))
  await settle()
}

describe('paged closed history (issue #184)', () => {
  // First on purpose: window listeners from earlier boots in this file stay live
  // (see harness.ts), and those apps would answer this test's hash change with
  // their own deep-link reads and repaints over the highlight it checks.
  it('searches the complete history and opens an omitted match without showing partial results', async () => {
    db = freshDb()
    const { archive } = seedHub(db)
    let hold: Promise<void> | null = null
    let release!: () => void
    const { reads, interceptFetch } = recorder()
    await bootApp(db, {
      interceptFetch: async (input, init, next) => {
        if (String(input) === HISTORY && hold) await hold
        return interceptFetch(input, init, next)
      },
    })
    hold = new Promise<void>((resolve) => { release = resolve })
    await searchFor('quokka')
    const results = document.getElementById('searchResults')!
    expect(results.textContent).not.toContain('No results')
    expect(document.getElementById('searchStatus')?.textContent).toBe('Searching older history…')

    hold = null
    release()
    await settle()
    expect(historyReads(reads)).toHaveLength(1)
    const option = results.querySelector<HTMLElement>(`[role="option"][data-search-target="${archive[1]}"]`)
    expect(option?.closest('.search-result-group')?.querySelector('.search-result-group-label')?.textContent).toBe('History')
    expect(option?.querySelector('.search-result-match-source')?.textContent).toBe('Background')
    expect(option?.querySelector('.search-result-match mark')?.textContent?.toLowerCase()).toBe('quokka')

    click(option)
    await settle()
    expect(document.getElementById('done')?.hidden).toBe(false)
    const card = document.querySelector<HTMLDetailsElement>(`#done [data-card-id="${archive[1]}"]`)
    expect(card?.open).toBe(true)
    expect(card?.querySelector('.search-jump-highlight')?.textContent?.toLowerCase()).toBe('quokka')
    await pollTick()
    expect(document.querySelector(`#done [data-card-id="${archive[1]}"]`)).not.toBeNull()
  })

  it('keeps passive polls on the bounded page while every count stays exact', async () => {
    db = freshDb()
    seedHub(db)
    advanceClock()
    insertItem(db, { ...ALPHA, kind: 'done', title: 'Release announced' })
    const { reads, interceptFetch } = recorder()
    await bootApp(db, { interceptFetch })

    // Dashboard (the cold-launch view) proves its recent outcomes from the page.
    expect(signal('outcomes')).toBe('63')
    expect(recentOutcomes()).toEqual(['Alpha closed 59', 'Alpha closed 58', 'Alpha closed 57', 'Alpha closed 56'])
    expect(tabCount('done')).toBe('64')
    // Projects and agents whose only trace is omitted history keep their controls.
    expect(document.querySelector('#rail button.rail-tab[data-project="archive"]')).not.toBeNull()
    expect([...document.querySelectorAll<HTMLOptionElement>('#agentSelect option')].map((option) => option.value))
      .toContain('legacy-bot')

    await pollTick()
    await showInbox()
    await pollTick()
    await selectTab('boards')
    await selectTab('notes')
    await selectTab('done')
    expect(historyTitles()).toEqual(['Release announced', 'Alpha closed 59', 'Alpha closed 58', 'Alpha closed 57', 'Alpha closed 56'])
    expect(buttonLabelled('Show 5 more (59 hidden)')).not.toBeNull()
    await pollTick()
    expect(historyReads(reads)).toEqual([])
    // Every tick applied: the page alone never reads as a broken connection.
    expect(status()).toBe('')
    const page = reads.filter((read) => read.path === '/api/items')
    expect(page.at(-1)?.status).toBe(304)
  })

  it('reads older history for a lens the page cannot complete, then stops when it is left', async () => {
    db = freshDb()
    seedHub(db)
    const { reads, interceptFetch } = recorder()
    await bootApp(db, { interceptFetch })
    await selectTab('done')
    expect(historyReads(reads)).toEqual([])

    await selectProject('archive')
    expect(historyReads(reads).map((read) => read.status)).toEqual([200])
    expect(historyTitles()).toEqual(['Archived decision 2', 'Archived decision 1', 'Archived decision 0'])
    expect(tabCount('done')).toBe('3')
    expect(document.querySelector('#done .show-more')).toBeNull()

    await pollTick()
    expect(historyReads(reads).map((read) => read.status)).toEqual([200, 304])
    expect(historyTitles()).toEqual(['Archived decision 2', 'Archived decision 1', 'Archived decision 0'])

    await selectProject('__all__')
    await pollTick()
    await showInbox()
    await pollTick()
    expect(historyReads(reads)).toHaveLength(2)
    expect(tabCount('done')).toBe('63')
  })

  it('pages past the recent slice down to the oldest closed item', async () => {
    db = freshDb()
    seedHub(db)
    const { reads, interceptFetch } = recorder()
    await bootApp(db, { interceptFetch })
    await selectTab('done')
    for (let page = 1; page < 10; page += 1) {
      click(document.querySelector('#done .show-more'))
      await settle()
    }
    expect(historyTitles()).toHaveLength(50)
    expect(historyReads(reads)).toEqual([])
    expect(buttonLabelled('Show 5 more (13 hidden)')).not.toBeNull()

    click(document.querySelector('#done .show-more'))
    await settle()
    expect(historyReads(reads)).toHaveLength(1)
    expect(historyTitles()).toHaveLength(55)
    expect(historyTitles().at(-1)).toBe('Alpha closed 5')
    click(document.querySelector('#done .show-more'))
    await settle()
    click(document.querySelector('#done .show-more'))
    await settle()
    expect(historyTitles().slice(-3)).toEqual(['Archived decision 2', 'Archived decision 1', 'Archived decision 0'])
    expect(document.querySelector('#done .show-more')).toBeNull()
    expect(tabCount('done')).toBe('63')
  })

  it('deep links to a closed item the page omitted', async () => {
    db = freshDb()
    const { archive } = seedHub(db)
    const { reads, interceptFetch } = recorder()
    await bootApp(db, { interceptFetch })
    navigateToHash(`#item/${archive[0]}`)
    await settle()
    // Earlier boots' window listeners answer the hash change too (harness.ts),
    // reading through this test's bridge, so only the shape of reads is pinned.
    expect(historyReads(reads).length).toBeGreaterThan(0)
    expect(document.getElementById('done')?.hidden).toBe(false)
    expect(document.querySelector('#rail button.rail-tab[data-project="archive"]')?.getAttribute('aria-selected')).toBe('true')
    const card = () => document.querySelector<HTMLDetailsElement>(`#done [data-card-id="${archive[0]}"]`)
    expect(card()?.open).toBe(true)
    expect(document.activeElement).toBe(card()?.querySelector(':scope > summary'))
    await pollTick()
    expect(card()).not.toBeNull()
    expect(historyReads(reads).some((read) => read.status === 304)).toBe(true)
  })

  it('keeps Dashboard numbers whole and reads older outcomes only for a lens that needs them', async () => {
    db = freshDb()
    seedHub(db)
    const { reads, interceptFetch } = recorder()
    await bootApp(db, { interceptFetch })
    const outcomes = listItems(db).filter((item) => item.outcome).length
    expect(signal('outcomes')).toBe(String(outcomes))
    expect(historyReads(reads)).toEqual([])

    await selectProject('archive')
    expect(historyReads(reads)).toHaveLength(1)
    expect(signal('outcomes')).toBe('3')
    expect(recentOutcomes()).toEqual(['Archived decision 2', 'Archived decision 1', 'Archived decision 0'])
  })

  it('refreshes the page and the complete history independently as items change', async () => {
    db = freshDb()
    seedHub(db)
    advanceClock()
    const question = insertItem(db, { ...ALPHA, kind: 'question', title: 'Ship the archive export?' })
    const { reads, interceptFetch } = recorder()
    await bootApp(db, { interceptFetch })
    await selectTab('done')
    await selectProject('archive')
    expect(historyReads(reads)).toHaveLength(1)
    await selectProject('__all__')
    await selectTab('done')
    for (let page = 1; page <= 10; page += 1) {
      click(document.querySelector('#done .show-more'))
      await settle()
    }
    const before = historyReads(reads).length

    advanceClock()
    replyItem(db, question, 'Yes')
    await pollTick()
    const page = (): Read[] => reads.filter((read) => read.path === '/api/items')
    expect(page().at(-1)?.status).toBe(200)
    expect(historyReads(reads).at(-1)?.status).toBe(304)

    advanceClock()
    resolveItem(db, question, 'Export shipped.')
    await pollTick()
    expect(page().at(-1)?.status).toBe(200)
    expect(historyReads(reads).at(-1)?.status).toBe(200)
    expect(historyReads(reads).length).toBeGreaterThan(before)
    expect(historyTitles()[0]).toBe('Ship the archive export?')
    expect(tabCount('done')).toBe('64')
  })

  it('counts every outcome in Handoffs at once and lists the omitted ones once read', async () => {
    db = freshDb()
    seedHub(db)
    let hold: Promise<void> | null = null
    let release!: () => void
    await bootApp(db, {
      interceptFetch: async (input, _init, next) => {
        if (String(input) === HISTORY && hold) await hold
        return next()
      },
    })
    hold = new Promise<void>((resolve) => { release = resolve })
    click(document.querySelector('.relay-btn'))
    await settle()
    const lane = () => document.querySelector('#relaybox [data-relay-lane="outcome"]')!
    expect(lane().querySelector('.relay-count')?.textContent).toBe('63')
    expect(document.querySelector('#relaybox .relay-summary')?.textContent).toContain('63 outcomes')
    expect(lane().querySelectorAll('.relay-card')).toHaveLength(50)
    expect(lane().querySelector('[role="status"]')?.textContent).toBe('Loading older outcomes…')

    hold = null
    release()
    await settle()
    expect(lane().querySelector('.relay-count')?.textContent).toBe('63')
    expect(lane().querySelectorAll('.relay-card')).toHaveLength(63)
    expect(lane().querySelector('[role="status"]')).toBeNull()
    expect(lane().textContent).toContain('Archived outcome 0')
  })

  it('opens a History target the page carries outside its proven prefix before older history lands', async () => {
    db = freshDb()
    // Created before everything else, resolved after: the newest outcome, but
    // the page cannot place it among the History entries it omits.
    const early = insertItem(db, { ...ALPHA, kind: 'question', title: 'Early question, late outcome' })
    seedHub(db)
    advanceClock()
    resolveItem(db, early, 'Finally settled.')
    let hold: Promise<void> | null = null
    let release!: () => void
    await bootApp(db, {
      interceptFetch: async (input, _init, next) => {
        if (String(input) === HISTORY && hold) await hold
        return next()
      },
    })
    expect(recentOutcomes()[0]).toBe('Early question, late outcome')
    hold = new Promise<void>((resolve) => { release = resolve })
    click(document.querySelector('.dashboard-outcome'))
    await settle()
    const card = () => document.querySelector<HTMLDetailsElement>(`#done [data-card-id="${early}"]`)
    expect(document.getElementById('done')?.hidden).toBe(false)
    expect(card()?.open).toBe(true)
    expect(document.activeElement).toBe(card()?.querySelector(':scope > summary'))
    expect(document.querySelector('#done .history-loading')?.textContent).toBe('Loading older history…')

    hold = null
    release()
    await settle()
    expect(document.querySelector('#done .history-loading')).toBeNull()
    expect(card()).not.toBeNull()
    expect(historyTitles().at(-1)).toBe('Early question, late outcome')
  })

  it('stops reading older history once a search is left, and resumes when it is reopened', async () => {
    db = freshDb()
    const { archive } = seedHub(db)
    const { reads, interceptFetch } = recorder()
    await bootApp(db, { interceptFetch })
    const input = document.getElementById('search') as HTMLInputElement
    const option = () => document.querySelector(`#searchResults [role="option"][data-search-target="${archive[1]}"]`)
    input.focus()
    await searchFor('quokka')
    expect(historyReads(reads)).toHaveLength(1)
    expect(option()).not.toBeNull()

    // Leaving the dock closes the results but keeps the query.
    document.querySelector('#tabs')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
    expect(document.getElementById('searchResults')?.hidden).toBe(true)
    expect(input.value).toBe('quokka')
    await pollTick()
    await pollTick()
    expect(historyReads(reads)).toHaveLength(1)

    input.focus()
    await settle()
    expect(historyReads(reads).map((read) => read.status)).toEqual([200, 304])
    expect(option()).not.toBeNull()
  })

  it('keeps applying the page while the complete History read fails, and says so where it is awaited', async () => {
    db = freshDb()
    seedHub(db)
    const { control, interceptFetch } = historyControl()
    await bootApp(db, { interceptFetch })
    control.fail = true
    click(document.querySelector('.relay-btn'))
    await settle()
    await pollTick()
    const lane = () => document.querySelector('#relaybox [data-relay-lane="outcome"]')!
    expect(lane().querySelector('.relay-count')?.textContent).toBe('63')
    expect(lane().querySelector('[role="status"]')?.textContent).toBe(UNAVAILABLE)
    expect(historyReads(control.reads).length).toBeGreaterThan(0)

    advanceClock()
    insertItem(db, { ...ALPHA, kind: 'question', title: 'Arrives while older history is down' })
    await pollTick()
    expect(badgeCount()).toBe(1)
    expect(status()).toBe('')

    control.fail = false
    await pollTick()
    expect(lane().querySelectorAll('.relay-card')).toHaveLength(63)
    expect(lane().querySelector('[role="status"]')).toBeNull()
  })

  it('reads older history within the tick whose own data needs it, never painting a blank page', async () => {
    db = freshDb()
    const backstops = openBackstops(db)
    seedHub(db)
    const { reads, interceptFetch } = recorder()
    await bootApp(db, { interceptFetch })
    await selectTab('done')
    const firstPage = ['Alpha closed 59', 'Alpha closed 58', 'Alpha closed 57', 'Alpha closed 56', 'Alpha closed 55']
    expect(historyTitles()).toEqual(firstPage)
    expect(historyReads(reads)).toEqual([])

    sweep(db, backstops)
    await pollTick()
    expect(historyTitles()).toEqual(firstPage)
    expect(document.querySelector('#done .history-loading')).toBeNull()
    expect(historyReads(reads).map((read) => read.status)).toEqual([200])
    expect(status()).toBe('')
  })

  it('keeps the Dashboard on the page after closures without an outcome take every recent slot', async () => {
    db = freshDb()
    const backstops = openBackstops(db)
    seedHub(db)
    sweep(db, backstops)
    const { reads, interceptFetch } = recorder()
    await bootApp(db, { interceptFetch })
    await pollTick()
    await pollTick()
    expect(signal('outcomes')).toBe('63')
    expect(recentOutcomes()).toEqual(['Alpha closed 59', 'Alpha closed 58', 'Alpha closed 57', 'Alpha closed 56'])
    expect(document.querySelector('.dashboard-outcome-list')?.hasAttribute('aria-busy')).toBe(false)
    expect(historyReads(reads)).toEqual([])
  })

  it('drops a deep link still waiting on older history once the human navigates elsewhere', async () => {
    db = freshDb()
    const { archive } = seedHub(db)
    const { control, interceptFetch } = historyControl()
    await bootApp(db, { interceptFetch })
    let release!: () => void
    control.hold = new Promise<void>((resolve) => { release = resolve })
    navigateToHash(`#item/${archive[0]}`)
    await settle()
    await selectProject('alpha')
    control.hold = null
    release()
    await settle()
    await pollTick()
    expect(document.getElementById('done')?.hidden).toBe(true)
    expect(document.querySelector('#rail button.rail-tab[data-project="alpha"]')?.getAttribute('aria-selected')).toBe('true')
  })

  it('lands a waiting deep link only once a held pointer is released', async () => {
    db = freshDb()
    const { archive } = seedHub(db)
    await bootApp(db)
    window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    navigateToHash(`#item/${archive[0]}`)
    await settle()
    expect(document.getElementById('done')?.hidden).toBe(true)
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    await pollTick()
    await settle()
    expect(document.getElementById('done')?.hidden).toBe(false)
    expect(document.querySelector<HTMLDetailsElement>(`#done [data-card-id="${archive[0]}"]`)?.open).toBe(true)
  })

  it('refreshes the search status when unchanged results return after older history was unavailable', async () => {
    db = freshDb()
    seedHub(db)
    const { control, interceptFetch } = historyControl()
    await bootApp(db, { interceptFetch })
    const input = document.getElementById('search') as HTMLInputElement
    const searchStatus = () => document.getElementById('searchStatus')?.textContent
    input.focus()
    await searchFor('quokka')
    expect(searchStatus()).toBe('1 search result')
    control.fail = true
    await pollTick()
    expect(searchStatus()).toBe(UNAVAILABLE)
    expect(status()).toBe('')
    control.fail = false
    await pollTick()
    expect(searchStatus()).toBe('1 search result')
    expect(document.querySelectorAll('#searchResults [role="option"]')).toHaveLength(1)
  })

  it('keeps a typed search waiting for older history across a held read', async () => {
    db = freshDb()
    seedHub(db)
    let hold: Promise<void> | null = null
    let release!: () => void
    await bootApp(db, {
      interceptFetch: async (_input, _init, next) => {
        if (String(_input) === HISTORY && hold) await hold
        return next()
      },
    })
    hold = new Promise<void>((resolve) => { release = resolve })
    const input = document.getElementById('search') as HTMLInputElement
    input.focus()
    type(input, 'archived decision')
    await vi.advanceTimersByTimeAsync(200)
    await pollTick()
    expect(document.getElementById('searchResults')?.querySelectorAll('[role="option"]')).toHaveLength(0)
    hold = null
    release()
    await settle()
    expect(document.getElementById('searchResults')?.querySelectorAll('[role="option"]').length).toBeGreaterThan(0)
  })
})
