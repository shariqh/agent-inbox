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
import { getItem, insertItem, replyItem } from '../../src/store.js'
import {
  advanceClock, answerInput, bootApp, buttonLabelled, click, collapseRow, expectConsoleError, freshDb, pollTick,
  row, rowTitles, searchFor, settle, showInbox, tabCount, type, useDomTest,
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
    await collapseRow(id)          // nothing is suspending the poll now

    advanceClock()
    insertItem(d, { ...AGENT, kind: 'question', title: 'SECOND question' })
    await pollTick()

    expect(rowTitles()).toContain('SECOND question')
  })

  it('recovers a failed collapsed-row star, retries its exact intent, and opens the correct correction surface', async () => {
    // A failed staged choice now becomes an exact-intent recovery, not a stale
    // "Sent / Undo" control. Follow the supported recovery → retry → correction
    // path, while a real unrelated draft (not mere expansion) holds the poll gate.
    const d = open()
    const starred = insertItem(d, {
      ...AGENT, kind: 'question', title: 'deploy now?', detail: 'the canary is green',
      options: [{ label: 'Deploy', recommended: true }, { label: 'Hold' }],
    })
    advanceClock()
    const other = insertItem(d, { ...AGENT, kind: 'question', title: 'other question' })
    const bridge = await bootApp(d)
    await showInbox()
    click(row(other))
    await settle()
    type(answerInput(other), 'Keep this unrelated answer.')

    click(row(starred)!.querySelector('.star-btn'))
    await settle()
    expect(buttonLabelled('Undo', row(starred)!), 'the ★ should stage with an undo window').toBeTruthy()
    expect(row(starred)?.querySelector('.nrow-card')).toBeNull()

    bridge.failPostsWith(500)
    expectConsoleError(new RegExp(`POST /api/items/${starred}/reply failed: HTTP 500`))
    await vi.advanceTimersByTimeAsync(5000)
    await settle()
    bridge.failPostsWith(null)

    const recovery = document.querySelector<HTMLDetailsElement>('.stale-drafts-fold')!
    expect(recovery?.open).toBe(true)
    expect(recovery?.textContent).toContain('deploy now?')
    expect(recovery?.textContent).toContain('answer: Deploy')
    expect(buttonLabelled('Undo', row(starred)!)).toBeNull()
    expect(getItem(d, starred)?.reply).toBeNull()
    expect(answerInput(other)?.value).toBe('Keep this unrelated answer.')
    const failed = bridge.posts.filter((post) => post.url === `/api/items/${starred}/reply`)
    expect(failed).toHaveLength(1)
    const failedBody = JSON.parse(String(failed[0]!.init?.body))
    expect(failedBody).toMatchObject({ text: 'Deploy', kind: 'answer' })

    click(buttonLabelled('Retry', recovery))
    await settle()
    const retried = bridge.posts.filter((post) => post.url === `/api/items/${starred}/reply`)
    expect(retried).toHaveLength(2)
    expect(JSON.parse(String(retried[1]!.init?.body))).toEqual(failedBody)
    expect(getItem(d, starred)?.reply).toBe('Deploy')
    expect(getItem(d, other)?.reply).toBeNull()
    expect(document.querySelector('.stale-drafts-fold')).toBeNull()
    expect(answerInput(other)?.value).toBe('Keep this unrelated answer.')

    click(row(starred))
    await settle()
    expect(row(starred)?.dataset.open).toBe('1')
    expect(row(starred)?.querySelector('.reply-block')?.textContent).toContain('Deploy')
    click(buttonLabelled('Change answer', row(starred)!))
    await settle()

    expect(answerInput(starred), 'the recovered answer must remain reviewable and editable').toBeTruthy()
    expect(answerInput(starred)?.value).toBe('Deploy')
    click(row(other))
    await settle()
    expect(answerInput(other)?.value).toBe('Keep this unrelated answer.')
    click(row(starred))
    await settle()
    expect(answerInput(starred)?.value).toBe('Deploy')
    expect(bridge.posts.some((post) => post.url === `/api/items/${other}/reply`)).toBe(false)
  })

  // The working-network path likewise retires the staged affordance on its send.
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
describe('31.3 · search indexes destinations without rewriting the active tab', () => {
  it('lists matches from the stale fold and Notes without changing the queue', async () => {
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

    const options = [...document.querySelectorAll('#searchResults [role="option"]')]
      .map((el) => el.textContent ?? '')
    expect(options.some((text) => text.includes('rotate the auth token'))).toBe(true)
    expect(options.some((text) => text.includes('auth cookie workaround'))).toBe(true)
    expect(document.querySelector('#needsYou .stale-fold')).toBeTruthy()
  })

  it('shows cross-tab matches in the index instead of a queue empty state', async () => {
    const d = open()
    insertItem(d, { ...AGENT, kind: 'question', title: 'unrelated question' })
    advanceClock()
    insertItem(d, { ...AGENT, kind: 'note', title: 'auth cookie workaround' })
    await bootApp(d)

    await searchFor('auth')

    expect(document.querySelector('#searchResults [role="option"]')?.textContent)
      .toContain('auth cookie workaround')
    expect(document.querySelector('#needsYou .empty')).toBeNull()
  })
})
