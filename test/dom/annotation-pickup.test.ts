// @vitest-environment jsdom
// test/dom/annotation-pickup.test.ts
//
// Issue #37 (root cause) and the half of #36 it unblocks, driven end to end
// through the real viewer against a real temp SQLite DB.
//
// The rule the whole design turns on: NEVER remove the signal — RELABEL it
// truthfully. Before this, a blocked row left the human's attention set only
// once an agent had read the board, so annotating (the only lever the viewer
// offers) did not move the badge and the row was unclearable. The naive fix —
// just drop it on annotate — is worse, because today's stuck badge is the ONLY
// evidence that pickup never happened. So: the badge comes down (the human has
// acted, and an uncollected answer is the agent's failure, not their to-do) and
// the row STAYS ON SCREEN, reading "awaiting pickup" until an agent collects it
// and "delivered" afterwards.
//
// Asserted as behaviour — badge numbers and rendered chips — never as source text.
import { describe, it, expect, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { annotateBoardRow, listBoards, markAnnotationDelivered, upsertBoard } from '../../src/store.js'
import {
  advanceClock, answerInput, badgeCount, bootApp, click, freshDb, pollTick, row, rowTitles,
  sendButton, settle, tabCount, type, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'claude' } as const

function open(): Database.Database {
  db = freshDb()
  return db
}

/** A board with one blocked row waiting on the human. Returns that row's id. */
function blockedRow(d: Database.Database, label = 'Merge'): string {
  upsertBoard(d, { ...AGENT, title: 'PR #429', rows: [{ label, status: 'blocked', note: 'ready when you are' }] })
  return listBoards(d)[0]!.rows.find((r) => r.label === label)!.id
}

/**
 * The urgency chip's WORDS on a Needs-you row ('' when the row is not rendered).
 * The leading glyph is an `aria-hidden` element, so read only the text nodes —
 * otherwise every assertion here is really asserting the glyph too.
 */
function chipText(id: string): string {
  const chip = row(id)?.querySelector('.chip')
  if (!chip) return ''
  return [...chip.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent ?? '').join('').trim()
}

describe('#36 · the human can clear a blocked row without any agent round-trip', () => {
  it('annotating in the viewer decrements the badge, and the row stays on screen relabeled', async () => {
    const d = open()
    const rowId = blockedRow(d)

    await bootApp(d)
    expect(badgeCount(), 'a blocked row starts in the attention set').toBe(1)
    expect(tabCount('needsYou')).toBe('1')
    expect(chipText(rowId)).toBe('blocked')

    // the human answers it, through the real UI: expand the row, type, Send
    click(row(rowId))
    await settle()
    type(answerInput(rowId), 'merge it')
    click(sendButton(rowId))
    await settle()

    // NO collapse. This test used to end with one, explained as "§10 freezes
    // re-renders while a card is expanded, so the repaint lands when the human is
    // done reading" — which documented issue #38 as intent. §10 governs the 3s
    // POLL; it never governed the frame the human's own Send asked for, and while
    // it did, this badge stayed stuck at 1 until something else happened to
    // repaint. The badge must come down on the click.

    // NO agent has run. The badge must still come down.
    expect(badgeCount(), 'the only lever the viewer offers must move the badge').toBe(0)
    expect(tabCount('needsYou')).toBe('')
    // …and the row must NOT vanish: an answer nobody collected is still a fact
    // the human needs to see, just no longer as their own to-do.
    expect(rowTitles()).toContain('Merge')
    expect(chipText(rowId)).toBe('awaiting pickup')
    expect(row(rowId)?.className, 'it renders dimmed, like an answered question').toContain('answered')
  })

  it('the deck agrees with the badge — annotating empties it too (tenet 3)', async () => {
    const d = open()
    const rowId = blockedRow(d)
    await bootApp(d)
    click(document.querySelector('.triage-btn'))
    await settle()
    expect(document.querySelector('#lightbox .lb-count')?.textContent).toBe('1 of 1')

    advanceClock()
    annotateBoardRow(d, rowId, 'merge it')
    await pollTick()

    expect(badgeCount()).toBe(0)
    expect(document.querySelector('#lightbox .lb-count')?.textContent).toBe('all clear')
  })
})

describe('#37 · annotated-and-unpicked renders differently from annotated-and-picked', () => {
  it('flips from "awaiting pickup" to "delivered" only when an agent collects it', async () => {
    const d = open()
    const rowId = blockedRow(d)
    advanceClock()
    annotateBoardRow(d, rowId, 'merge it')

    await bootApp(d)
    const waiting = chipText(rowId)
    expect(waiting).toBe('awaiting pickup')
    expect(badgeCount(), 'answered is answered — pickup is not the human’s problem').toBe(0)

    // the row's own card says the same thing in words, and offers the human a
    // way to change their mind while it is still undelivered
    click(row(rowId))
    await settle()
    expect(row(rowId)?.querySelector('.nrow-card')?.textContent).toContain('waiting for agent pickup')
    expect(answerInput(rowId), 'the human can still revise an uncollected answer').not.toBeNull()
    // The one collapse kept on purpose (#38): the human is done reading, so they
    // shut the card — and THAT is what hands the suspended poll its pending data
    // back. §10 still holds the 3s rebuild while a card is open; what it no longer
    // does is hold the frame a human action asked for.
    click(row(rowId))
    await settle()

    // an agent finally polls pending() — modelled by the exact store call that
    // tool makes. STAMP FIRST, then move the clock: markAnnotationDelivered
    // writes `now`, so advancing before it made the delivered age zero and the
    // chip really said "delivered moments" while the test claimed four minutes.
    // The AGE is the whole point of this chip — it is what shows the human an
    // agent has had their answer for a while and done nothing — so assert it.
    markAnnotationDelivered(d, rowId, listBoards(d)[0]!.rows[0]!.annotated_at, 'claude-code')
    advanceClock(4 * 60_000)
    await pollTick()

    const delivered = chipText(rowId)
    expect(delivered).not.toBe(waiting)
    expect(delivered).toBe('picked up 4m')
    click(row(rowId))
    await settle()
    expect(row(rowId)?.querySelector('.nrow-card')?.textContent).toContain('claude-code')
    // still visible, still not attention — the row leaves only when the agent
    // flips its status, which is the acknowledgement
    expect(rowTitles()).toContain('Merge')
    expect(badgeCount()).toBe(0)
  })

  it('a re-annotation puts a delivered row back to awaiting pickup', async () => {
    const d = open()
    const rowId = blockedRow(d)
    advanceClock()
    annotateBoardRow(d, rowId, 'wait for CI')
    advanceClock()
    markAnnotationDelivered(d, rowId, listBoards(d)[0]!.rows[0]!.annotated_at, 'claude-code')

    await bootApp(d)
    expect(chipText(rowId)).toMatch(/^picked up /)

    // the human changes their mind — the agent has NOT seen this one
    advanceClock()
    click(row(rowId))
    await settle()
    type(answerInput(rowId), 'actually, merge it')
    click(sendButton(rowId))
    await settle()
    // no collapse (#38): re-answering must relabel the row on the spot, or the
    // human cannot tell their revision from the delivered answer it replaced
    expect(chipText(rowId)).toBe('awaiting pickup')
  })
})
