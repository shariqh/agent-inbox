// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { archiveBoard, getBoard, insertItem, upsertBoard } from '../../src/store.js'
import {
  badgeCount, bootApp, click, freshDb, pollTick, searchFor, settle, useDomTest,
} from './harness.js'

useDomTest()
let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })
const AGENT = { project: 'alpha', stream: 'main', agent: 'copilot' } as const

describe('inactive expensive panes', () => {
  it('retains hidden plan, note and history DOM on ordinary polls, but paints current data on activation', async () => {
    db = freshDb()
    const note = insertItem(db, { ...AGENT, kind: 'note', title: 'A note' })
    const done = insertItem(db, { ...AGENT, kind: 'done', title: 'A milestone' })
    upsertBoard(db, {
      ...AGENT, title: 'Plan',
      rows: Array.from({ length: 20 }, (_, index) => ({ label: `Step ${index}`, status: 'tracked' })),
    })
    const board = getBoard(db, 'alpha', 'Plan')!
    await bootApp(db)
    const oldPlan = document.querySelector(`#boards [data-card-id="${board.id}"]`)
    const oldNote = document.querySelector(`#notes [data-card-id="${note}"]`)
    const oldHistory = document.querySelector(`#done [data-card-id="${done}"]`)
    expect(oldPlan).not.toBeNull()
    await pollTick()
    expect(document.querySelector(`#boards [data-card-id="${board.id}"]`)).toBe(oldPlan)
    expect(document.querySelector(`#notes [data-card-id="${note}"]`)).toBe(oldNote)
    expect(document.querySelector(`#done [data-card-id="${done}"]`)).toBe(oldHistory)

    upsertBoard(db, {
      ...AGENT, title: 'Plan', expectedVersion: board.revision,
      rows: board.rows.map((row, index) => ({
        label: row.label, revision: row.revision,
        status: index === 0 ? 'blocked' : 'tracked',
        note: index === 0 ? 'Fresh action, not stale hidden markup' : '',
      })),
    })
    await pollTick()
    expect(badgeCount()).toBe(1)
    expect(document.querySelector(`#boards [data-card-id="${board.id}"]`)).toBe(oldPlan)
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    expect(document.querySelector(`#boards [data-card-id="${board.id}"]`)).not.toBe(oldPlan)
    expect(document.querySelector('#boards .row-note')?.textContent).toContain('Fresh action')
  })

  it('searches current archived data and opens the exact cross-project source from a retained hidden pane', async () => {
    db = freshDb()
    insertItem(db, { ...AGENT, kind: 'question', title: 'Alpha decision' })
    upsertBoard(db, {
      project: 'beta', stream: 'release', agent: 'claude', title: 'Regional plan',
      rows: [{ label: 'Canary', status: 'tracked', context: 'Portugal is the selected region.' }],
    })
    const board = getBoard(db, 'beta', 'Regional plan')!
    await bootApp(db)
    const oldPlan = document.querySelector(`#boards [data-card-id="${board.id}"]`)
    archiveBoard(db, board.id, board.revision)
    await pollTick()
    expect(document.querySelector(`#boards [data-card-id="${board.id}"]`)).toBe(oldPlan)
    await searchFor('Portugal')
    const result = document.querySelector(`[data-search-target="${board.id}"]`)!
    expect(result.textContent).toContain('Archived plan')
    click(result)
    await settle()
    expect(document.getElementById('boards')?.hidden).toBe(false)
    expect(document.querySelector<HTMLDetailsElement>('#boards .archived-fold')?.open).toBe(true)
    const source = document.querySelector<HTMLDetailsElement>(`.row-panel-row[data-row-id="${board.rows[0]!.id}"] .card-context`)
    expect(source?.open).toBe(true)
    expect(source?.querySelector('.search-jump-highlight')?.textContent).toBe('Portugal')
    expect(document.activeElement).toBe(source?.querySelector('summary'))
  })
})
