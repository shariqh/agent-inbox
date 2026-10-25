// @vitest-environment jsdom
// Issue #299: a deep link to an archived plan, which the poll carries only in
// brief. Like #184's deep links to omitted history it waits for the complete
// list, then lands, unless the human has navigated since. Its own file, so no
// earlier boot's window listeners answer its hash changes with reads of their
// own (see harness.ts): the reads below are exactly this app's.
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { archiveBoard, getBoard, upsertBoard } from '../../src/store.js'
import { focusHashFor } from '../../public/badge.js'
import { advanceClock, bootApp, click, freshDb, navigateToHash, pollTick, settle, useDomTest } from './harness.js'

useDomTest()
let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const FULL = '/api/boards/archived'

function archivedPlan(d: Database.Database, title: string): string {
  advanceClock()
  upsertBoard(d, { project: 'retired', stream: 'main', agent: 'copilot', title, rows: [{ label: 'Step', status: 'tracked' }] })
  const board = getBoard(d, 'retired', title)!
  expect(archiveBoard(d, board.id, board.revision)).toBe(true)
  return board.id
}

describe('deep link to an archived plan (issue #299)', () => {
  it('waits for the complete archived plans, lands on the plan, then keeps it while it is shown', async () => {
    db = freshDb()
    upsertBoard(db, { project: 'alpha', stream: 'main', agent: 'copilot', title: 'Active plan', rows: [{ label: 'Work', status: 'tracked' }] })
    const target = archivedPlan(db, 'Retired plan')
    const reads: number[] = []
    let hold: Promise<void> | null = null
    let release!: () => void
    await bootApp(db, {
      interceptFetch: async (input, _init, next) => {
        if (String(input) !== FULL) return next()
        if (hold) await hold
        const response = await next()
        reads.push(response.status)
        return response
      },
    })
    expect(reads).toEqual([])

    hold = new Promise<void>((resolve) => { release = resolve })
    navigateToHash(focusHashFor(target))
    await settle()
    // nothing moves while the plan's rows are still being read
    expect(document.getElementById('dashboard')?.hidden).toBe(false)

    hold = null
    release()
    await settle()
    expect(reads).toEqual([200])
    expect(document.getElementById('boards')?.hidden).toBe(false)
    expect(document.querySelector('#rail button.rail-tab[data-project="retired"]')?.getAttribute('aria-selected')).toBe('true')
    const card = () => document.querySelector<HTMLDetailsElement>(`#boards .archived-fold [data-card-id="${target}"]`)
    expect(card()?.closest<HTMLDetailsElement>('.archived-fold')?.open).toBe(true)
    expect(document.activeElement).toBe(card()?.querySelector(':scope > summary'))

    await pollTick()
    expect(card()).not.toBeNull()
    expect(reads).toEqual([200, 304])
  })

  it('drops the link once the human navigates while it waits', async () => {
    db = freshDb()
    const target = archivedPlan(db, 'Another retired plan')
    const reads: number[] = []
    let hold: Promise<void> | null = null
    let release!: () => void
    await bootApp(db, {
      interceptFetch: async (input, _init, next) => {
        if (String(input) !== FULL) return next()
        if (hold) await hold
        const response = await next()
        reads.push(response.status)
        return response
      },
    })
    hold = new Promise<void>((resolve) => { release = resolve })
    navigateToHash(focusHashFor(target))
    await settle()
    click(document.querySelector('.tab[data-tab="notes"]'))
    await settle()

    hold = null
    release()
    await settle()
    await pollTick()
    expect(document.getElementById('notes')?.hidden).toBe(false)
    expect(document.getElementById('boards')?.hidden).toBe(true)
    // nothing needs the list any more, so the poll stops reading it
    const settled = reads.length
    await pollTick()
    expect(reads).toHaveLength(settled)
  })
})
