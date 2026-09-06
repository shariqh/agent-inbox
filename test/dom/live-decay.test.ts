// @vitest-environment jsdom
// test/dom/live-decay.test.ts
//
// Issue #45, through the real viewer over a real DB: a `doing` claim that has
// gone cold must stop being advertised as work WITHOUT the session leaving the
// Live surface. Both halves matter and they pull in opposite directions —
// expiring the row would have been the easy fix and it would have hidden a live
// agent, demoting its open question from "waiting" to "parked".
import { describe, it, expect, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, upsertActivity, recordActivityCall, touchActivity } from '../../src/store.js'
import { advanceClock, bootApp, freshDb, rows, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

function open(): Database.Database {
  db = freshDb()
  return db
}

const drawer = (): HTMLElement => document.getElementById('liveDrawer') as HTMLElement
const idleRows = (): HTMLElement[] => [...drawer().querySelectorAll<HTMLElement>('.idle-row')]

describe('the Live drawer after a claim goes cold (#45)', () => {
  it('renders an open session instead of the stale claim — and the session stays LIVE for its question', async () => {
    const d = open()
    const id = insertItem(d, { project: 'alpha', stream: 'main', agent: 'claude', kind: 'question', title: 'ship it?', session: 's1' })
    upsertActivity(d, { session: 's1', project: 'alpha', stream: 'main', agent: 'claude', doing: 'Executing Track B — 18-task viewer redesign', detail: 'task 7 of 18' })
    recordActivityCall(d, 's1')
    advanceClock(31 * 60_000)
    touchActivity(d, 's1') // the 5-minute liveness heartbeat, still running

    await bootApp(d)

    expect(drawer().querySelectorAll('.live-entry')).toHaveLength(0)
    expect(drawer().querySelector('.idle-fold > summary')?.textContent).toBe('1 connection · no task reported')
    expect(drawer().querySelector('.idle-row .live-state-label')?.textContent).toBe('Connected')
    expect(drawer().querySelector('.idle-row .live-doing')?.textContent).toBe('Last report: Executing Track B — 18-task viewer redesign')
    expect(document.getElementById('liveStripLabel')?.textContent).toBe('1 connected · no task reported')

    // the row did NOT expire, so the item is still an agent blocked on you
    const nrow = rows().find((r) => r.dataset['cardId'] === id)!
    expect(nrow.textContent).toContain('Waiting')
  })

  it('sinks and dims a terminal nobody has touched in hours, and dates it by silence', async () => {
    const d = open()
    insertItem(d, { project: 'alpha', stream: 'main', agent: 'claude', kind: 'note', title: 'so the page has content' })
    // seeded so that both the rowid order and the (ended_at, updated_at) index
    // order put `forgotten` first — only the real-call sort sinks it
    upsertActivity(d, { session: 'forgotten', project: 'beta', stream: '', agent: 'claude', doing: 'open', idle: true })
    recordActivityCall(d, 'forgotten')
    advanceClock(9 * 3600_000)
    touchActivity(d, 'forgotten') // its CLI is alive; that is why it is still listed at all
    advanceClock(2 * 60_000)
    upsertActivity(d, { session: 'recent', project: 'alpha', stream: '', agent: 'claude', doing: 'open', idle: true })
    recordActivityCall(d, 'recent')

    await bootApp(d)

    const seen = idleRows()
    expect(seen.map((r) => r.querySelector('.live-who')?.textContent)).toEqual(['claude · alpha', 'claude · beta'])
    expect(seen[0]!.classList.contains('dormant')).toBe(false)
    expect(seen[1]!.classList.contains('dormant')).toBe(true)
    // Both rows date real Inbox calls, not inferred activity in the agent's terminal.
    expect(seen[1]!.querySelector('.live-age')?.textContent).toBe('Inbox call 9h ago')
    expect(seen[0]!.querySelector('.live-age')?.textContent).toMatch(/^Inbox call /)
    // …and both hover surfaces must use the same real-call stamp. Keyed on
    // `updated_at` — what it used to read — this row would claim "last update 2m
    // ago", because the server heartbeated it two minutes ago and will go on
    // doing so forever. Color now identifies the project; the title carries state.
    expect(seen[1]!.querySelector('.live-age')?.getAttribute('title')).toBe('Inbox call 9h ago')
    expect(seen[1]!.querySelector('.live-dot')?.getAttribute('title')).toBe('beta · connected · Inbox call 9h ago')
    expect(seen.every((r) => r.querySelector('.live-doing')?.textContent === 'No task reported yet')).toBe(true)
  })
})
