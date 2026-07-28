// @vitest-environment jsdom
// test/dom/issue-31.test.ts
// The three USER-VISIBLE follow-ups from the final review of the glanceable-viewer
// rebuild (GitHub issue #31), driven through the real viewer instead of pinned as
// source text. Three FINDINGS, eight tests — the counts are not interchangeable.
//
// Discrimination re-verified by reverting each fix on this tree, one at a time:
// 31.1 (setOpenRow + forceRender) → 3 red, "the answer surface never came back";
// 31.2 (the per-id seen set) → 3 red, "expected '6' to be '1'"; 31.3 (the pointer
// branch) → 1 red, "the tab went completely silent about where the match is".
//
//   31.1 — "Change answer" accepted by the server staged a prefill draft and then
//          called load(), whose renderIfIdle() is GUARANTEED to skip: the draft it
//          just wrote is itself a suspend reason. The answer surface the draft
//          belongs in never appeared, and nothing could clear it. A frozen viewer
//          with an invisible draft — the C2 failure mode, on the accepted path.
//   31.2 — the notes read-mark is a single ISO watermark, so it cannot move at all
//          whenever the pager hides the OLDEST note. Six fresh notes pinned the
//          Notes tab count at six until they aged out seven days later.
//   31.3 — a Needs-you search whose only hit is inside the collapsed stale fold
//          correctly suppresses the false "No matches here" claim (fix round 2 /
//          I2) — and used to swallow the §12 "matches elsewhere" pointer with it,
//          leaving a blank tab and no way to find the hit.
//
// The structural half (which construct each fix uses) is pinned in
// test/issue-31-followups.test.ts. Keep both — they cover different things.
import { describe, it, expect, afterEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { insertItem, replyItem } from '../../src/store.js'
import {
  advanceClock, answerInput, bootApp, buttonLabelled, click, expectConsoleError, freshDb, pollTick,
  row, rowTitles, searchFor, settle, tabCount, type, useDomTest,
} from './harness.js'

useDomTest()

let db: Database.Database | null = null
afterEach(() => { db?.close(); db = null })

function open(): Database.Database {
  db = freshDb()
  return db
}

const AGENT = { project: 'alpha', stream: 'main', agent: 'claude' } as const

// ── 31.1 ────────────────────────────────────────────────────────────────────
describe('31.1 · an accepted "Change answer" must show the surface it staged a draft into', () => {
  it('reopens the answer input holding the previous reply', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'ship it?' })
    replyItem(d, id, 'yes') // answered, NOT picked up — the store will accept the blank-out
    await bootApp(d)

    click(row(id))
    await settle()
    expect(answerInput(id), 'an answered question shows no answer surface yet').toBeNull()

    click(buttonLabelled('Change answer', row(id)!))
    await settle()

    // the whole bug: before the fix load()'s renderIfIdle() was suspended by the very
    // draft it had just written, so this input was never built and the text was parked
    // where no UI could reach it.
    expect(answerInput(id), 'the answer surface never came back — the draft is invisible').toBeTruthy()
    expect(answerInput(id)?.value).toBe('yes')
  })

  it('leaves the parked draft clearable, so the viewer can un-freeze', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'ship it?' })
    replyItem(d, id, 'yes')
    await bootApp(d)

    click(row(id))
    await settle()
    click(buttonLabelled('Change answer', row(id)!))
    await settle()

    type(answerInput(id), '')      // the human abandons the change
    click(row(id))                 // collapse — nothing is suspending the poll now
    await settle()

    advanceClock()
    insertItem(d, { ...AGENT, kind: 'question', title: 'SECOND question' })
    await pollTick()

    expect(rowTitles()).toContain('SECOND question')
  })

  it('opens the row on the star-Undo path too, where nothing was expanded to begin with', async () => {
    // The other of changeAnswer's two call sites. The ★/Undo affordance sits on line 1
    // of a COLLAPSED row, so a repaint alone builds no answer surface at all: the fix
    // has to guarantee the surface, not merely repaint.
    //
    // REACHABILITY, rewritten for issue #38. This test used to reach the stale Undo by
    // letting the staged send flush while §10 held the repaint — i.e. it used the #38
    // bug as its setup, and documented that bug as intent ("exactly the real-world
    // sequence"). A successful send now repaints (reloadAndPaint), so that route is
    // gone, and good riddance. The state is still perfectly reachable, from the two
    // things #38 deliberately does NOT change:
    //   · a FAILED write must not repaint the human's context away — it shows the
    //     error and leaves everything where it was; and
    //   · the POLL is still suspended by the expanded row, so nothing else repaints
    //     either.
    // Meanwhile the agent answered the same question in chat (issue #29's dual
    // channel), so the item genuinely carries a reply the human may want to change.
    const d = open()
    const starred = insertItem(d, {
      ...AGENT, kind: 'question', title: 'deploy now?', detail: 'the canary is green',
      options: [{ label: 'Deploy', recommended: true }, { label: 'Hold' }],
    })
    advanceClock()
    const other = insertItem(d, { ...AGENT, kind: 'question', title: 'other question' })
    const bridge = await bootApp(d)

    // Expanding a DIFFERENT row suspends the poll (spec §10) — nothing on screen is
    // rebuilt from here on unless a human action asks for it.
    click(row(other))
    await settle()

    click(row(starred)!.querySelector('.star-btn'))
    await settle()
    expect(buttonLabelled('Undo', row(starred)!), 'the ★ should stage with an undo window').toBeTruthy()

    // the agent answers the same question in chat while the ★ sits staged
    advanceClock()
    replyItem(d, starred, 'Deploy')
    await pollTick() // lastData learns about it; §10 keeps it off screen

    // …and the staged send then fails on the wire. stagedStars was already cleared by
    // the stager, so the "Sent: … — Undo" line on screen is now stale.
    bridge.failPostsWith(500)
    expectConsoleError(/HTTP 500/)
    await vi.advanceTimersByTimeAsync(2000) // REPLY_DELAY_MS elapses — the send fires
    await settle()
    bridge.failPostsWith(null)

    click(buttonLabelled('Undo', row(starred)!)) // too late to cancel → falls through to changeAnswer
    await settle()

    expect(answerInput(starred), 'the un-done answer has nowhere to live').toBeTruthy()
    expect(answerInput(starred)?.value).toBe('Deploy')
  })

  // The #38 half of the same surface: the sequence above, but with the network
  // WORKING. The stale affordance must not survive its own send any more.
  it('a staged ★ that lands repaints itself away, even with another card expanded', async () => {
    const d = open()
    const starred = insertItem(d, {
      // `detail` is load-bearing: rowStarOption refuses a row with no secondary line
      ...AGENT, kind: 'question', title: 'deploy now?', detail: 'the canary is green',
      options: [{ label: 'Deploy', recommended: true }, { label: 'Hold' }],
    })
    advanceClock()
    const other = insertItem(d, { ...AGENT, kind: 'question', title: 'other question' })
    await bootApp(d)

    click(row(other))
    await settle()
    click(row(starred)!.querySelector('.star-btn'))
    await settle()
    expect(buttonLabelled('Undo', row(starred)!)).toBeTruthy()

    await vi.advanceTimersByTimeAsync(5000) // REPLY_DELAY_MS — the staged reply sends
    await settle()

    expect(buttonLabelled('Undo', row(starred)!), 'a sent reply must stop offering an Undo it cannot honour').toBeNull()
    expect(row(starred)?.className, 'and the row must say it is answered').toContain('answered')
  })
})

// ── 31.2 ────────────────────────────────────────────────────────────────────
describe('31.2 · the Notes count must come down once you have looked', () => {
  it('drops to the notes the pager actually hid, instead of staying pinned', async () => {
    const d = open()
    // six notes > PAGE.notes (5): the pager hides the OLDEST, which is precisely the
    // shape a single watermark cannot express.
    for (let i = 0; i < 6; i++) {
      insertItem(d, { ...AGENT, kind: 'note', title: `note ${i}` })
      advanceClock()
    }
    await bootApp(d)
    expect(tabCount('notes')).toBe('6')

    click(document.querySelector('.tab[data-tab="notes"]'))
    await pollTick() // read-marking happens in render(), which the poll drives

    expect(document.querySelectorAll('#notes .groups .item').length, 'the pager should hide one').toBe(5)
    expect(tabCount('notes'), 'only the note that stayed behind the pager is still new').toBe('1')
  })

  it('stays down across a reload — the seen set is persisted, not per-session', async () => {
    const d = open()
    for (let i = 0; i < 6; i++) {
      insertItem(d, { ...AGENT, kind: 'note', title: `note ${i}` })
      advanceClock()
    }
    await bootApp(d)
    click(document.querySelector('.tab[data-tab="notes"]'))
    await pollTick()
    expect(tabCount('notes')).toBe('1')

    vi.resetModules() // a fresh page load against the same localStorage
    await bootApp(d)
    expect(tabCount('notes')).toBe('1')
  })

  it('a genuinely new note still counts', async () => {
    const d = open()
    for (let i = 0; i < 6; i++) {
      insertItem(d, { ...AGENT, kind: 'note', title: `note ${i}` })
      advanceClock()
    }
    await bootApp(d)
    click(document.querySelector('.tab[data-tab="notes"]'))
    await pollTick()
    expect(tabCount('notes')).toBe('1') // note 0, the one the pager kept hidden

    // Leave the tab BEFORE the new note lands. Read-marking is gated on
    // `activeTab === 'notes'`, so with Notes still open the new note renders and
    // the same tick marks it seen — the count would honestly stay at 1 and this
    // test would prove nothing about a new note counting. (That is exactly what
    // the first version asserted: `< 6`, which also passes at 0.)
    click(document.querySelector('.tab[data-tab="needsYou"]'))
    await settle()

    advanceClock()
    insertItem(d, { ...AGENT, kind: 'note', title: 'brand new' })
    await pollTick()

    // 2 = the pager-hidden note 0 + the brand new one. The per-id seen set must
    // suppress the five already looked at and nothing more.
    expect(tabCount('notes'), 'a note that arrived after you looked away is new').toBe('2')
  })
})

// ── 31.3 ────────────────────────────────────────────────────────────────────
describe('31.3 · a search that only the stale fold answers still points somewhere', () => {
  it('prints the §12 pointer instead of nothing at all', async () => {
    const d = open()
    const id = insertItem(d, { ...AGENT, kind: 'question', title: 'rotate the auth token' })
    advanceClock()
    insertItem(d, { ...AGENT, kind: 'note', title: 'auth cookie workaround' })
    vi.setSystemTime(Date.now() + 73 * 3600e3) // past STALE_MS: the question demotes into the fold
    await bootApp(d)

    // the fold is appended INTO #needsYouList, so row() still finds it — what matters
    // is that it sits inside the collapsed fold rather than the active list
    expect(row(id)?.closest('.stale-fold'), 'the question should have demoted into the stale fold').toBeTruthy()

    await searchFor('auth')

    const empties = [...document.querySelectorAll('#needsYou .empty')].map((el) => el.textContent ?? '')
    expect(empties.join(' '), 'the tab went completely silent about where the match is').not.toBe('')
    expect(empties.join(' ')).toContain('1 in Notes')
    // …and it must NOT be the false claim I2 removed
    expect(empties.join(' ')).not.toContain('No matches')
    // the fold below is still holding the other match
    expect(document.querySelector('#needsYou .stale-fold')).toBeTruthy()
  })

  it('an ordinary no-match search still gets the full "No matches … — N in X" line', async () => {
    const d = open()
    insertItem(d, { ...AGENT, kind: 'question', title: 'unrelated question' })
    advanceClock()
    insertItem(d, { ...AGENT, kind: 'note', title: 'auth cookie workaround' })
    await bootApp(d)

    await searchFor('auth')

    const empty = document.querySelector('#needsYou .empty')?.textContent ?? ''
    expect(empty).toContain('No matches')
    expect(empty).toContain('1 in Notes')
  })
})
