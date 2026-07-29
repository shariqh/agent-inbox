// @vitest-environment jsdom
// test/dom/row-handled.test.ts
//
// Issue #36, the half that #37 unblocked: the human's OWN exit from a blocked row.
//
// Why it exists. Every `blocked` row the owner had in the wild was a TASK —
// "create the Paddle account", "register the Notion integration", "record the
// hero demo" — not a question. Agents use `blocked` exactly per the rule (it
// needs the human), but the viewer only offered a free-text answer box. A task
// wants DONE, and there was no way to give it: the agent had to flip the status,
// and if that session was over, nobody ever would.
//
// The rule this file guards, same as annotation-pickup.test.ts: NEVER remove the
// signal — RELABEL it. Marking drops the badge (the human has acted) and the row
// STAYS ON SCREEN reading "awaiting pickup" until an agent collects the mark and
// then acknowledges it by changing the status.
//
// Asserted as behaviour — badge numbers, rendered chips, real POSTs against a
// real temp SQLite DB — never as source text.
import { describe, it, expect, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { listBoards, markHandledDelivered, markRowHandled, upsertBoard } from '../../src/store.js'
import {
  advanceClock, badgeCount, bootApp, buttonLabelled, click, freshDb, pollTick,
  row, rowTitles, settle, tabCount, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

const AGENT = { project: 'alpha', stream: 'main', agent: 'claude' } as const
const MARK = 'I’ve done my part'
const UNMARK = 'Not done after all'

function open(): Database.Database {
  db = freshDb()
  return db
}

/** A board with one blocked TASK row waiting on the human. Returns that row's id. */
function blockedRow(d: Database.Database, status: 'blocked' | 'partial' = 'blocked'): string {
  upsertBoard(d, { ...AGENT, title: 'Wave 0', rows: [{ label: 'Paddle account', status, note: '~15 min KYC' }] })
  return listBoards(d)[0]!.rows[0]!.id
}

/** The urgency chip's WORDS on a Needs-you row — text nodes only, so the aria-hidden glyph is excluded. */
function chipText(id: string): string {
  const chip = row(id)?.querySelector('.chip')
  if (!chip) return ''
  return [...chip.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent ?? '').join('').trim()
}

/** The expanded Needs-you card for a row, opening it first if needed. */
async function openCard(id: string): Promise<Element> {
  if (!row(id)?.querySelector('.nrow-card')) {
    click(row(id))
    await settle()
  }
  return row(id)!.querySelector('.nrow-card')!
}

/**
 * Shut the card again — MANDATORY before any assertion that depends on a POLL
 * tick. Spec §10 suspends the 3s rebuild while a card is expanded, so a test
 * that leaves one open and then advances the clock asserts a frozen screen and
 * passes for the wrong reason.
 */
async function collapseCard(id: string): Promise<void> {
  if (row(id)?.querySelector('.nrow-card')) {
    click(row(id))
    await settle()
  }
}

describe('#36 · marking a blocked row done clears the badge with no agent round-trip', () => {
  it('drops the badge to 0 on the click, and leaves the row on screen relabeled', async () => {
    const d = open()
    const rowId = blockedRow(d)

    await bootApp(d)
    expect(badgeCount(), 'a blocked row starts in the attention set').toBe(1)
    expect(tabCount('needsYou')).toBe('1')
    expect(chipText(rowId)).toBe('blocked')

    await openCard(rowId)
    click(buttonLabelled(MARK, row(rowId)!))
    await settle()

    // NO agent has run, and no poll tick was needed.
    expect(badgeCount(), 'the human’s own lever must move the badge').toBe(0)
    expect(tabCount('needsYou')).toBe('')
    // …and the row must NOT vanish: a mark nobody collected is still a fact the
    // human needs to see, just no longer as their own to-do.
    expect(rowTitles()).toContain('Paddle account')
    expect(chipText(rowId)).toBe('awaiting pickup')
    expect(row(rowId)?.className, 'it renders dimmed, like an answered question').toContain('answered')
  })

  it('writes the mark through the store, not just the screen', async () => {
    const d = open()
    const rowId = blockedRow(d)
    await bootApp(d)
    await openCard(rowId)
    click(buttonLabelled(MARK, row(rowId)!))
    await settle()
    expect(listBoards(d)[0]!.rows[0]!.handled_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(listBoards(d)[0]!.rows[0]!.handled_seen_at, 'nobody has collected it yet').toBeNull()
  })

  it('the card says what was marked, and in words that are not the row’s own status', async () => {
    const d = open()
    const rowId = blockedRow(d)
    await bootApp(d)
    await openCard(rowId)
    click(buttonLabelled(MARK, row(rowId)!))
    await settle()
    const card = await openCard(rowId)
    expect(card.textContent).toContain('You marked your part done')
    expect(card.textContent).toContain('waiting for agent pickup')
  })

  it('the triage deck agrees with the badge — marking empties it too (tenet 3)', async () => {
    const d = open()
    const rowId = blockedRow(d)
    await bootApp(d)
    click(document.querySelector('.triage-btn'))
    await settle()
    expect(document.querySelector('#lightbox .lb-count')?.textContent).toBe('1 of 1')

    // the same lever, from inside the deck card
    click(buttonLabelled(MARK, document.querySelector('#lightbox')!))
    await settle()
    expect(badgeCount()).toBe(0)
    expect(document.querySelector('#lightbox .lb-count')?.textContent).toBe('all clear')
  })
})

describe('#36 · the mark is undoable only while it is still the human’s own business', () => {
  it('“Not done after all” puts the row back into the attention set', async () => {
    const d = open()
    const rowId = blockedRow(d)
    await bootApp(d)
    await openCard(rowId)
    click(buttonLabelled(MARK, row(rowId)!))
    await settle()
    expect(badgeCount()).toBe(0)

    click(buttonLabelled(UNMARK, await openCard(rowId)))
    await settle()
    expect(badgeCount(), 'un-marking is the human saying they still need to do it').toBe(1)
    expect(chipText(rowId)).toBe('blocked')
    expect(listBoards(d)[0]!.rows[0]!.handled_at).toBeNull()
  })

  it('once an agent has collected the mark the undo is not drawn at all, and the card says why', async () => {
    const d = open()
    const rowId = blockedRow(d)
    markRowHandled(d, rowId)
    advanceClock()
    markHandledDelivered(d, rowId, listBoards(d)[0]!.rows[0]!.handled_at, 'claude-code')
    advanceClock(4 * 60_000)

    await bootApp(d)
    const card = await openCard(rowId)
    expect(buttonLabelled(UNMARK, card), 'a control that cannot work must not be drawn (#38)').toBeNull()
    expect(card.textContent).toContain('will not un-tell the agent')
    // the chip flips to the delivered vocabulary, and the row is still on screen
    expect(chipText(rowId)).toBe('delivered 4m')
    expect(rowTitles()).toContain('Paddle account')
    expect(badgeCount()).toBe(0)
  })

  it('an undo that RACES a delivery is refused out loud, and the mark survives', async () => {
    const d = open()
    const rowId = blockedRow(d)
    await bootApp(d)
    await openCard(rowId)
    click(buttonLabelled(MARK, row(rowId)!))
    await settle()

    // an agent polls in the gap between this screen's snapshot and the click
    markHandledDelivered(d, rowId, listBoards(d)[0]!.rows[0]!.handled_at, 'claude-code')
    click(buttonLabelled(UNMARK, await openCard(rowId)))
    await settle()

    expect(document.querySelector(`.write-error[data-error-for="${rowId}"]`)?.textContent)
      .toContain('will not un-tell the agent')
    expect(listBoards(d)[0]!.rows[0]!.handled_at, 'the refusal must not half-apply').not.toBeNull()
    expect(badgeCount(), 'the row is still out of the attention set — the mark stands').toBe(0)
  })
})

describe('#36 · where the control lives', () => {
  it('is reachable from the boards matrix panel, and moves the badge from there', async () => {
    const d = open()
    blockedRow(d)
    await bootApp(d)
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()

    const panelRow = document.querySelector('#boards .board-row')!
    click(buttonLabelled('Answer', panelRow))
    await settle()
    const panel = document.querySelector('#boards .row-panel')!
    click(buttonLabelled(MARK, panel))
    await settle()

    expect(badgeCount()).toBe(0)
    expect(listBoards(d)[0]!.rows[0]!.handled_at).not.toBeNull()
    // the matrix keeps showing the row, now carrying the human's ✓
    expect(document.querySelector('#boards .board-row .row-note')?.textContent).toContain('✓')
  })

  it('is NOT offered on a row that is not blocked — nothing there is being asked of the human', async () => {
    const d = open()
    blockedRow(d, 'partial')
    await bootApp(d)
    click(document.querySelector('.tab[data-tab="boards"]'))
    await settle()
    click(document.querySelector('#boards .board-row .row-expand'))
    await settle()
    const panel = document.querySelector('#boards .row-panel')!
    expect(panel.querySelector('.reply-input'), 'the note box is still there').not.toBeNull()
    expect(buttonLabelled(MARK, panel)).toBeNull()
  })
})

describe('#36 · the mark survives the agent, and only a status change retires the row', () => {
  it('a full-table re-upsert that leaves the row blocked does not put it back in the badge', async () => {
    const d = open()
    const rowId = blockedRow(d)
    await bootApp(d)
    await openCard(rowId)
    click(buttonLabelled(MARK, row(rowId)!))
    await settle()
    expect(badgeCount()).toBe(0)

    // the agent refreshes the whole board, still asserting it is blocked
    await collapseCard(rowId)
    advanceClock()
    upsertBoard(d, { ...AGENT, title: 'Wave 0', rows: [{ label: 'Paddle account', status: 'blocked', note: 'still waiting on you' }] })
    await pollTick()

    expect(badgeCount(), 'a routine re-send must not wipe the human’s action').toBe(0)
    expect(rowTitles()).toContain('Paddle account')
    expect(chipText(rowId)).toBe('awaiting pickup')
  })

  it('the row leaves the list only when an agent flips the status', async () => {
    const d = open()
    const rowId = blockedRow(d)
    await bootApp(d)
    await openCard(rowId)
    click(buttonLabelled(MARK, row(rowId)!))
    await settle()
    expect(rowTitles()).toContain('Paddle account')

    await collapseCard(rowId)
    advanceClock()
    upsertBoard(d, { ...AGENT, title: 'Wave 0', rows: [{ label: 'Paddle account', status: 'done', note: 'account live' }] })
    await pollTick()

    expect(rowTitles()).not.toContain('Paddle account')
    expect(badgeCount()).toBe(0)
  })
})

// The delivery attribution is the ONE place a row prints a value the human never
// typed and no agent chose deliberately: `handled_seen_by` / `annotation_seen_by`
// come from inferAgent(clientName), which returns an unrecognised MCP client name
// VERBATIM (src/infer.ts) — so it is whatever string a client declared itself as.
// CLAUDE.md designates that class attacker-influenced, and removing the esc() on
// it killed ZERO of 1092 tests. Pinning the escape, not the wording.
describe('#36 · the delivery attribution escapes the client-declared agent name', () => {
  it('renders a hostile agent name as text, injecting no element and running no handler', async () => {
    const d = open()
    const rowId = blockedRow(d)
    markRowHandled(d, rowId)
    advanceClock()
    markHandledDelivered(
      d,
      rowId,
      listBoards(d)[0]!.rows[0]!.handled_at,
      '<img src=x onerror="globalThis.__pwned = true">',
    )
    advanceClock(4 * 60_000)

    await bootApp(d)
    const card = await openCard(rowId)

    // the DOM is the assertion — not the markup string, which is what esc() shapes
    expect(card.querySelector('img'), 'an injected element means the attribution reached innerHTML raw').toBeNull()
    expect((globalThis as Record<string, unknown>).__pwned, 'no handler may run').toBeUndefined()
    // and it is still SHOWN, escaped — suppressing it would pass this test for the wrong reason
    expect(card.textContent).toContain('onerror')
  })
})
