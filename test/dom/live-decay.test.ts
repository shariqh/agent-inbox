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

    expect(drawer().textContent).not.toContain('Executing Track B')
    expect(drawer().querySelectorAll('.live-entry')).toHaveLength(0)
    expect(drawer().querySelector('.idle-fold > summary')?.textContent).toBe('1 open session')
    expect(document.getElementById('liveStripLabel')?.textContent).toBe('no agents running')

    // the row did NOT expire, so the item is still an agent blocked on you
    const nrow = rows().find((r) => r.dataset['cardId'] === id)!
    expect(nrow.textContent).toContain('waiting')
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
    // "alive 9h" reads as a plus; what the human needs is how long it has been quiet
    expect(seen[1]!.querySelector('.live-age')?.textContent).toMatch(/^quiet 9h/)
    expect(seen[0]!.querySelector('.live-age')?.textContent).toMatch(/^alive /)
  })
})
