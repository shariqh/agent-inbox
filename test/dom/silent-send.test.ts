// @vitest-environment jsdom
// test/dom/silent-send.test.ts
//
// Issue #38 · D1 — "I clicked Send and nothing happened."
//
// Reproduced first in real Chrome over CDP, then here against the real viewer and
// a real temp SQLite DB. The write ALWAYS landed (POST 200, row in the DB); what
// never happened was the frame that says so.
//
// The cause is one confusion. `load()` repaints through `renderIfIdle()` — the §10
// poll gate — and THE GATE IS GLOBAL: `suspendState()` reports `openRowId` (ANY
// expanded Needs-you card) plus EVERY entry in draftReplies/draftReplyContexts/
// rowDrafts anywhere in the app. So a handler that ends in a bare `load()` after a
// successful POST is asking the gate for permission to show the human the result of
// their own click — and one unrelated card left expanded, or one half-typed draft
// on a different board, is enough to refuse it. Indefinitely: the observed viewer
// sat on the old state across repeated poll ticks until a collapse (which calls
// `render()` directly, outside the gate) revealed the truth. The input still held
// the text, so a second Send re-sent the same string.
//
// §10 is right and stays: the 3s rebuild must never land under the cursor. What it
// must never do is swallow the confirmation a click asked for. `load()` is the
// poll's; `reloadAndPaint()` is the human's.
//
// The owner reported two surfaces. There are at least SEVEN, all the same defect,
// and one of them (Resolve) freezes the badge — it lives inside the card that is by
// construction `openRowId`, so it is a GUARANTEED self-silencing write. Every one
// is covered below, because fixing only what was reported leaves the bug shipped.
//
// The last test in this file is the anti-regression: it is GREEN today and must
// stay green. Without it, "fixing" #38 by wiring forceRender() into load() — i.e.
// deleting the gate — passes everything above it.
import { describe, it, expect, afterEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, listBoards, upsertBoard } from '../../src/store.js'
import {
  advanceClock, answerInput, badgeCount, bootApp, buttonLabelled, click, freshDb, pollTick,
  row, rowTitles, searchFor, sendButton, settle, type, useDomTest,
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
function blockedRow(d: Database.Database, title = 'PR #429', label = 'Merge'): string {
  upsertBoard(d, { ...AGENT, title, rows: [{ label, status: 'blocked', note: 'ready when you are' }] })
  return listBoards(d).find((b) => b.title === title)!.rows.find((r) => r.label === label)!.id
}

/** Show the Boards tab, the way the human does. */
async function showBoards(): Promise<void> {
  click(document.querySelector('.tab[data-tab="boards"]'))
  await settle()
}

/** The board card whose title is `title`, in the Boards matrix. */
function boardCard(title: string): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('#boards .board')]
    .find((el) => el.querySelector('.board-title')?.textContent?.includes(title)) ?? null
}

/**
 * Board titles by WHERE they are, not merely whether they are in the document —
 * an archived board is still on screen, folded away under "show archived", so a
 * bare `.board-title` sweep would call every one of these assertions green.
 */
function boardTitles(where: 'active' | 'archived'): string[] {
  const sel = where === 'active' ? '#boards .boards > .board .board-title' : '#boards .archived-fold .board-title'
  return [...document.querySelectorAll(sel)].map((el) => el.textContent ?? '')
}

/** The open matrix row-panel's answer input / Send button (boards tab, not the accordion). */
function panelInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('#boards .row-panel .reply-input')
}
function panelSend(): HTMLButtonElement | null {
  return buttonLabelled('Send', document.querySelector('#boards .row-panel') ?? document.createElement('div'))
}

/** Expand a matrix row by its Answer button and type into the panel it opens. */
async function answerInMatrix(text: string): Promise<void> {
  click(document.querySelector('#boards .answer-btn'))
  await settle()
  type(panelInput(), text)
  await settle()
}

/** An open question, expanded in the Needs-you accordion — the global suspender. */
async function expandAnUnrelatedQuestion(d: Database.Database): Promise<string> {
  const id = insertItem(d, { ...AGENT, kind: 'question', title: 'bump the timeout?' })
  advanceClock()
  return id
}

const pauseHint = (): string => document.getElementById('pauseHint')?.textContent ?? ''

// ── the reported surfaces ────────────────────────────────────────────────────

describe('#38 · a board-row answer shows itself, with no collapse and no poll tick', () => {
  it('answering from the Needs-you accordion paints the annotation immediately', async () => {
    const d = open()
    const rowId = blockedRow(d)
    await bootApp(d)

    click(row(rowId))
    await settle()
    type(answerInput(rowId), 'merge it')
    click(sendButton(rowId))
    await settle()

    // NOTHING else happens here: no collapse, no pollTick, no tab switch. This is
    // the frame the click itself asked for.
    expect(row(rowId)?.querySelector('.nrow-card .annotation')?.textContent,
      'the saved answer must appear without the human having to collapse the card').toContain('merge it')
    expect(answerInput(rowId)?.value, 'a box that still holds the text re-sends it on the next click').toBe('')
    expect(row(rowId)?.dataset['open'], 'the card the human is reading must stay open').toBe('1')
  })

  // THE OWNER'S BUG, stated as an assertion. Two completely unrelated surfaces:
  // a question card left expanded in Needs-you silences a Send in the Boards matrix.
  it('…even while an unrelated question card is expanded on the other tab', async () => {
    const d = open()
    const rowId = blockedRow(d)
    const questionId = await expandAnUnrelatedQuestion(d)
    await bootApp(d)

    click(row(questionId))                 // the innocent bystander that freezes the gate
    await settle()
    expect(row(questionId)?.dataset['open']).toBe('1')

    await showBoards()
    await answerInMatrix('go ahead and merge')
    click(panelSend())
    await settle()

    const panel = document.querySelector('#boards .row-panel')
    expect(panel?.querySelector('.annotation')?.textContent,
      'an expanded card on ANOTHER tab must not silence this write').toContain('go ahead and merge')
    expect(panel?.textContent).toContain('waiting for agent pickup')
    expect(panelInput()?.value).toBe('')
    // and the row's own state moved: it is answered, so it leaves the attention set
    expect(badgeCount(), 'the badge must agree with what the human just did').toBe(1) // the question only
    expect(rowId).toBeTruthy()
  })

  // THE OTHER SURFACE THE ISSUE NAMES. `sendReply()` is a different function from
  // the board row's `save()` above — different endpoint (/api/items/:id/reply),
  // different state (draftReplies/draftReplyContexts, not rowDrafts) — and it is
  // the one the human hits most, since it is also where the option pills, Enter,
  // the ★'s staged send and the triage card all land. It ended in a bare `load()`
  // too, and `openRowId` is set BY CONSTRUCTION here: the input only exists inside
  // the expanded card, so the gate was guaranteed to refuse. Reverting this one
  // call site alone left the rest of the suite green, which is why it gets its own
  // test rather than riding on a board row's.
  it('answering a QUESTION shows the answer, with no collapse and no poll tick', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'bump the timeout?' })
    await bootApp(d)
    expect(badgeCount()).toBe(1)

    click(row(id))
    await settle()
    type(answerInput(id), 'yes — 30s')
    click(sendButton(id))
    await settle()

    const card = row(id)?.querySelector('.nrow-card')
    expect(card, 'the card must still be on screen, or this proves nothing').not.toBeNull()
    expect(card!.querySelector('.reply-block')?.textContent ?? '(no reply block — the card still shows the question)',
      "the human's own answer must be on screen before anything else happens").toContain('yes — 30s')
    expect(card!.textContent, 'and it must say the agent has not collected it yet').toContain('waiting for agent pickup')
    expect(answerInput(id), 'an answered question has no answer box left to re-send from').toBeNull()
    expect(row(id)?.className, 'the row must wear its answered state').toContain('answered')
    expect(badgeCount(), 'an answered question has stopped needing the human').toBe(0)
    expect(row(id)?.dataset['open'], 'the card the human is reading must stay open').toBe('1')
  })

  it('a second Send cannot re-send the same string, because the box was cleared', async () => {
    const d = open()
    const rowId = blockedRow(d)
    const bridge = await bootApp(d)

    click(row(rowId))
    await settle()
    type(answerInput(rowId), 'merge it')
    click(sendButton(rowId))
    await settle()
    // the human, seeing nothing happen, clicks Send again — the #38 double-write
    click(sendButton(rowId))
    await settle()

    const annotates = bridge.posts.filter((p) => p.url.includes('/annotate'))
    expect(annotates.length, 'the empty box is what makes the second click a no-op').toBe(1)
  })
})

// ── the surfaces nobody reported ─────────────────────────────────────────────
// Resolve/Dismiss/Note live INSIDE the expanded card. `openRowId` is set by
// construction for every one of them: they are guaranteed self-silencing writes,
// and Resolve strands `openRowId` on a row `render()` would have reconciled away —
// so the badge freezes and the viewer stops updating for good. That is a live
// tenet-2 violation (the badge must stay TRUSTWORTHY), not a cosmetic one.

describe('#38 · the card actions repaint the card they live in', () => {
  it('Resolve removes the row, drops the badge, and leaves the viewer LIVE', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'ship it?' })
    await bootApp(d)
    expect(badgeCount()).toBe(1)

    click(row(id))
    await settle()
    click(buttonLabelled('Resolve', row(id)!))
    await settle()

    expect(rowTitles()).not.toContain('ship it?')
    expect(badgeCount(), 'a badge that outlives the thing it counts is a badge nobody trusts').toBe(0)

    // …and the proof that `openRowId` was RECONCILED rather than stranded on a row
    // that no longer exists: the viewer must still be able to show new work.
    advanceClock()
    insertItem(d, { ...AGENT, kind: 'question', title: 'and this one?' })
    await pollTick()
    expect(rowTitles(), 'the poll froze — openRowId was left pointing at a deleted row').toContain('and this one?')
    expect(badgeCount()).toBe(1)
  })

  it('a staged Dismiss repaints when its 5s undo window closes', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'noise' })
    await bootApp(d)

    click(row(id))
    await settle()
    click(row(id)!.querySelector('.nrow-dismiss'))
    await settle()
    expect(row(id)?.className, 'the row stages first, undoable').toContain('staged')

    await vi.advanceTimersByTimeAsync(5000) // the undo window closes and act() fires
    await settle()

    expect(rowTitles()).not.toContain('noise')
    expect(badgeCount()).toBe(0)
  })

  it('Note shows the note it just saved', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'ship it?' })
    await bootApp(d)
    // jsdom's window.prompt throws "Not implemented", which the harness's
    // console.error contract would (correctly) fail the test on.
    vi.spyOn(window, 'prompt').mockReturnValue('deploy after the freeze')

    click(row(id))
    await settle()
    click(buttonLabelled('Note', row(id)!))
    await settle()

    expect(row(id)?.querySelector('.nrow-card .annotation')?.textContent).toContain('deploy after the freeze')
  })
})

describe('#38 · archiving a board takes the board off the screen', () => {
  it('…even with a half-typed draft parked on a different board', async () => {
    const d = open()
    blockedRow(d, 'BOARD A', 'ship')
    advanceClock()
    blockedRow(d, 'BOARD B', 'deploy')
    await bootApp(d)
    await showBoards()
    expect(boardTitles('active').join(' ')).toContain('BOARD A')

    // park a draft on B — a draft ANYWHERE suspends the whole viewer's poll
    click(boardCard('BOARD B')!.querySelector('.answer-btn'))
    await settle()
    type(document.querySelector<HTMLInputElement>('#boards .row-panel .reply-input'), 'half a thought')
    await settle()
    expect(pauseHint(), 'a draft really is a pause — that part is not the bug').toBe('')

    // now archive A: two-click inline confirm, no tick in between
    const card = boardCard('BOARD A')!
    click(buttonLabelled('Archive', card))
    await settle()
    click(buttonLabelled('Really archive?', boardCard('BOARD A')!))
    await settle()

    expect(listBoards(d, { status: 'active' }).map((b) => b.title), 'the server took it').toEqual(['BOARD B'])
    expect(boardTitles('active').filter((t) => t.includes('BOARD A')),
      'the human archived it and it stayed in the live list — the write is invisible').toEqual([])
    expect(boardTitles('archived').join(' '), 'and it must be reachable in the fold, not gone').toContain('BOARD A')
  })

  it('un-archiving brings it back', async () => {
    const d = open()
    blockedRow(d, 'BOARD A', 'ship')
    advanceClock()
    const rowId = blockedRow(d, 'BOARD B', 'deploy')
    await bootApp(d)
    await showBoards()

    const card = boardCard('BOARD A')!
    click(buttonLabelled('Archive', card))
    await settle()
    click(buttonLabelled('Really archive?', boardCard('BOARD A')!))
    await settle()

    // open the archived fold, then suspend the viewer with an expanded card
    const fold = document.querySelector<HTMLDetailsElement>('#boards .archived-fold')
    expect(fold, 'no archived fold rendered').not.toBeNull()
    fold!.open = true
    fold!.dispatchEvent(new window.Event('toggle'))
    await settle()

    click(row(rowId)) // an expanded Needs-you card — the global suspender
    await settle()

    click(buttonLabelled('Un-archive', document.querySelector('#boards .archived-fold')!))
    await settle()

    expect(listBoards(d, { status: 'active' }).map((b) => b.title).sort()).toEqual(['BOARD A', 'BOARD B'])
    expect(boardTitles('active').join(' '), 'un-archived on the server, still filed away on screen').toContain('BOARD A')
    expect(boardTitles('archived').join(' ')).not.toContain('BOARD A')
  })
})

// ── the cost of nine new callers: a click can beat the first payload ─────────

describe('#38 · forceRender() before there is anything to render', () => {
  // `if (!lastData) return` is the guard #38 added to forceRender(), and it is not
  // theoretical bookkeeping: app.js calls `load()` at module top level WITHOUT
  // awaiting it, so every listener wired the line before — initSearch, initTabs,
  // initKeys, the rail — is live while the first payload is still in the air. Nine
  // human-write call sites now paint unconditionally, and the earliest of them can
  // fire in that window.
  //
  // Removing the guard passed the entire suite. What it actually costs, measured in
  // real Chrome:
  //   TypeError: Cannot read properties of null (reading 'activity')
  //     at applyBadge (app.js:361) → render (505) → forceRender (183) → Timeout
  // and it lands inside a setTimeout, so it is OUTSIDE load()'s try/catch: no
  // console.error, no 'disconnected' status line, nothing on screen. A blank page
  // with no signal is the exact failure mode load()'s catch was hardened for.
  it('typing in the search box before any data has arrived defers, and does not throw', async () => {
    const d = open()
    insertItem(d, { ...AGENT, kind: 'question', title: 'ship it?' })
    const bridge = await bootApp(d, { holdFetch: true })

    // (`document.title` is NOT a usable signal here: jsdom's document outlives the
    // test and no beforeEach resets it, so it still carries the previous test's badge.
    // The rendered list is rebuilt by mountShell on every boot, so it is.)
    expect(rowTitles(), 'nothing can have rendered yet, or the payload is not actually held').toEqual([])

    // initSearch's 120ms debounce fires forceRender() with lastData still null.
    // THE DISCRIMINATOR IS THIS LINE, not the assertions after it: without the
    // guard, the debounce callback throws and `advanceTimersByTimeAsync` rethrows
    // it, so the test dies here with the stack quoted above. In the browser the
    // same throw is silent, which is precisely why it needs a test.
    await searchFor('ship')

    // …and skipping a frame is not an error, so nothing may be painted about it.
    expect(document.getElementById('status')?.textContent, 'a deferred frame is not a failed fetch').toBe('')

    // …and the frame is DEFERRED, not lost: the payload lands and the query applies.
    bridge.releaseFetch()
    await settle()
    expect(rowTitles(), 'the guard must skip the frame, not poison the app').toEqual(['ship it?'])
  })
})

// ── the gate itself, unchanged ───────────────────────────────────────────────

describe('#38 · §10 survives the fix — the POLL still holds while the human works', () => {
  // GREEN TODAY, and the point is that it stays green. Every test above would
  // also pass if the fix were "wire forceRender() into load()" — which deletes
  // the gate, rebuilds the DOM under the cursor every 3s, and reintroduces the
  // exact class of bug §10 exists to prevent. This is the only test that fails
  // for that mistake.
  it('a card left expanded still freezes the 3s rebuild, and says so', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'ship it?' })
    await bootApp(d)

    click(row(id))
    await settle()

    advanceClock()
    insertItem(d, { ...AGENT, kind: 'question', title: 'brand new' })
    await pollTick()
    await pollTick()

    expect(rowTitles(), 'the poll must not move rows under an open card').not.toContain('brand new')
    expect(pauseHint(), 'and it must SAY it is holding data back').toBe("paused — updating when you're done")

    // …and it lands the moment the human is done, exactly as §10 promises
    click(row(id))
    await settle()
    expect(rowTitles()).toContain('brand new')
    expect(pauseHint()).toBe('')
  })
})

// ── the cost of the extra frames, paid down ──────────────────────────────────

describe('#38 · a forced frame must not drag the caret back to an empty box', () => {
  // The focus tokens (rowFocusId / draftFocusKey) are STICKY: set on focus, cleared
  // only by a successful send, and re-applied by every rebuild. That already stole
  // focus on any unsuspended poll tick — a PRE-EXISTING bug — but #38's forced
  // frames make it reachable while the poll is suspended too, so a Send on one card
  // could yank the cursor into a board-row input the human touched minutes earlier.
  // Released on blur, and ONLY when the box is empty: a real draft still gets its
  // cursor back, which is the whole point of the token.
  it('an empty input the human has left alone does not reclaim focus on the next frame', async () => {
    const d = open()
    const rowId = blockedRow(d)
    await bootApp(d)

    click(row(rowId))
    await settle()
    const input = answerInput(rowId)!
    input.focus()
    expect(document.activeElement).toBe(input)

    // the human types nothing, gives up on this box and goes to the search field
    document.getElementById('search')!.focus()
    await settle()

    // …and then does something else entirely, which now forces a frame (#38). The
    // card stays open — that is exactly the case the §10 gate used to make
    // unreachable, and the reason this guard is part of the same change.
    click(document.querySelector('#rail .rail-tab'))
    await settle()

    expect(answerInput(rowId), 'the card must still be open, or this proves nothing').not.toBeNull()
    expect(document.activeElement, 'the rebuild must not chase the caret into an abandoned box')
      .toBe(document.getElementById('search'))
  })

  it('…but a box holding a real draft keeps its draft AND its claim on the caret', async () => {
    // The guard is `!input.value`, and this is the half it deliberately does NOT
    // change: an unfinished draft keeps its focus token, so the rebuild puts the
    // caret back in it. That is the pre-existing spec §13 behaviour — narrowing the
    // guard to empty boxes is the whole point, and an unconditional clear on blur
    // fails right here.
    const d = open()
    const rowId = blockedRow(d)
    await bootApp(d)

    click(row(rowId))
    await settle()
    const input = answerInput(rowId)!
    input.focus()
    type(input, 'half a thought')
    document.getElementById('search')!.focus()
    await settle()

    // a repaint from somewhere else entirely: the human filters the rail
    click(document.querySelector('#rail .rail-tab'))
    await settle()

    expect(answerInput(rowId), 'the card must survive the rebuild').not.toBeNull()
    expect(answerInput(rowId)?.value).toBe('half a thought')
    expect(document.activeElement, 'the caret must come back to the unfinished draft')
      .toBe(answerInput(rowId))
  })

  // THE OTHER TWO GUARDS. The release shipped on THREE inputs — a board row's
  // (`rowFocusId`, covered by the pair above) and both of a question card's
  // (`draftFocusKey`, one token with two values, `${id}:answer` and
  // `${id}:context`). Only the first was tested: deleting either draftFocusKey
  // blur listener left the whole suite green. These two are the item half, and
  // each carries BOTH directions, so neither can be satisfied by simply deleting
  // the focus restore it is asserting against.
  it('a QUESTION card\'s answer box releases the caret when empty, and keeps it when not', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'ship it?' })
    await bootApp(d)

    click(row(id))
    await settle()
    answerInput(id)!.focus()
    expect(document.activeElement).toBe(answerInput(id))

    // typed nothing, gave up, went to the search field
    document.getElementById('search')!.focus()
    await settle()
    click(document.querySelector('#rail .rail-tab')) // any human-forced frame (#38)
    await settle()

    expect(answerInput(id), 'the card must still be open, or this proves nothing').not.toBeNull()
    expect(document.activeElement, 'the rebuild must not chase the caret into an abandoned answer box')
      .toBe(document.getElementById('search'))

    // …and the half the guard must NOT change: a real draft still owns the caret
    const again = answerInput(id)!
    again.focus()
    type(again, 'yes, but after the freeze')
    document.getElementById('search')!.focus()
    await settle()
    click(document.querySelector('#rail .rail-tab'))
    await settle()

    expect(answerInput(id)?.value).toBe('yes, but after the freeze')
    expect(document.activeElement, 'an unfinished answer must get its cursor back')
      .toBe(answerInput(id))
  })

  it('…and so does the optional CONTEXT box beside it', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'ship it?' })
    await bootApp(d)

    click(row(id))
    await settle()
    const ctx = () => row(id)?.querySelector<HTMLInputElement>('.reply-context-input') ?? null
    expect(ctx(), 'no context input rendered — the rest of this test proves nothing').not.toBeNull()
    ctx()!.focus()
    document.getElementById('search')!.focus()
    await settle()
    click(document.querySelector('#rail .rail-tab'))
    await settle()

    expect(document.activeElement, 'the rebuild must not chase the caret into an abandoned context box')
      .toBe(document.getElementById('search'))

    const again = ctx()!
    again.focus()
    type(again, 'the freeze ends Thursday')
    document.getElementById('search')!.focus()
    await settle()
    click(document.querySelector('#rail .rail-tab'))
    await settle()

    expect(ctx()?.value).toBe('the freeze ends Thursday')
    expect(document.activeElement, 'an unfinished context note must get its cursor back').toBe(ctx())
  })
})
