// @vitest-environment jsdom
// test/dom/session-decay.test.ts
//
// Issue #45, through the real viewer over a real DB: a `doing` claim that has
// gone cold must stop being advertised as work WITHOUT the session leaving the
// Agents home (#454, once the Live drawer). Both halves matter and they pull in
// opposite directions — expiring the row would have been the easy fix and it
// would have hidden a live agent, demoting its open question from "waiting" to
// "parked".
import { describe, it, expect, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, upsertActivity, recordActivityCall, touchActivity } from '../../src/store.js'
import { advanceClock, bootApp, click, freshDb, rows, settle, useDomTest } from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

function open(): Database.Database {
  db = freshDb()
  return db
}

const card = (session: string) => document.querySelector<HTMLElement>(`#dashboard [data-session-card="session:${session}"]`)

describe('a session card after a claim goes cold (#45)', () => {
  it('draws an open session instead of the stale claim — and the session stays LIVE for its question', async () => {
    const d = open()
    const ask = insertItem(d, { project: 'alpha', stream: 'main', agent: 'claude', kind: 'question', title: 'ship it?', session: 's1' })
    upsertActivity(d, { session: 's1', project: 'alpha', stream: 'main', agent: 'claude', doing: 'Executing Track B — 18-task viewer redesign', detail: 'task 7 of 18' })
    recordActivityCall(d, 's1')
    advanceClock(31 * 60_000)
    touchActivity(d, 's1') // the 5-minute liveness heartbeat, still running

    await bootApp(d)

    // its card asks, never works: the claim is drawn as what it was doing
    expect(card('s1')?.classList.contains('tone-working')).toBe(false)
    expect(card('s1')?.classList.contains('tone-ask')).toBe(true)
    expect(card('s1')?.querySelector('.sc-doing')?.textContent).toBe('Last reported: Executing Track B — 18-task viewer redesign · 31m ago')
    expect(document.querySelector('#sessionsIndicator .si-v')?.textContent).toBe('1 connected')
    expect(document.querySelector('#sessionsIndicator .si-s')?.textContent).toBe('all quiet')

    // the row did NOT expire, so the item is still an agent blocked on you
    click(document.querySelector('.tab[data-tab="needsYou"]'))
    await settle()
    const nrow = rows().find((r) => r.dataset['cardId'] === ask)!
    expect(nrow.textContent).toContain('Waiting')
  })

  it('folds a terminal nobody has touched in hours into Dormant, dated by silence', async () => {
    const d = open()
    insertItem(d, { project: 'alpha', stream: 'main', agent: 'claude', kind: 'note', title: 'so the page has content' })
    // seeded so that both the rowid order and the (ended_at, updated_at) index
    // order put `forgotten` first — only the real-call time folds it
    upsertActivity(d, { session: 'forgotten', project: 'beta', stream: '', agent: 'claude', doing: 'open', idle: true })
    recordActivityCall(d, 'forgotten')
    advanceClock(9 * 3600_000)
    touchActivity(d, 'forgotten') // its CLI is alive; that is why it is still listed at all
    advanceClock(2 * 60_000)
    upsertActivity(d, { session: 'recent', project: 'alpha', stream: '', agent: 'claude', doing: 'open', idle: true })
    recordActivityCall(d, 'recent')

    await bootApp(d)

    expect(card('recent')?.closest('[data-ah-fold]')).toBeNull()
    expect(card('recent')?.querySelector('.sc-when')?.textContent).toBe('last Agent Inbox call just now')
    const fold = document.querySelector<HTMLDetailsElement>('.agents-home [data-ah-fold="dormant"]')!
    expect(fold.hidden).toBe(false)
    expect(fold.querySelector(':scope > summary')?.textContent).toBe('Dormant (1) · quiet 8 h or more')
    // a closed fold paints nothing it hides
    expect(card('forgotten')).toBeNull()
    fold.open = true
    fold.dispatchEvent(new Event('toggle'))
    // dated by its last real Inbox call, never by the heartbeat two minutes ago
    expect(card('forgotten')?.querySelector('.sc-when')?.textContent).toBe('no Agent Inbox call for 9h')
    expect(card('forgotten')?.querySelector('.sc-doing')?.textContent).toBe('No task reported yet')
  })
})
