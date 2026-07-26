// test/important-fixes.test.ts
// Fix round 2 (final whole-branch review): the five IMPORTANT findings in
// public/app.js, pinned as SOURCE TEXT — this file asserts STRUCTURE no runtime
// test can see: WHICH shared predicate each call site feeds, and that there is
// exactly one of them (tenet 3).
// The BEHAVIOURAL half now runs for real against jsdom in
// test/dom/render-agreement.test.ts (I1–I4) and test/dom/toggle-row.test.ts (I5).
// That is five FINDINGS but SIX tests — I2 has two, one per empty state — so a
// count of "five" over there is a count of tests that does not exist.
//
// DISCRIMINATION, re-verified by reverting each hunk on THIS tree one at a time
// (the older "all five verified to fail on 4f12144^" was a claim about a tree six
// commits behind, which is not the same statement):
//   I1  buildDeck AND findEntryData put back on their own predicate → 1 red,
//       "expected '1 of 1' to be 'all clear'". buildDeck ALONE → 0 red: the
//       re-validation in findEntryData catches it, so both halves are load-bearing.
//   I2  the `!rest.length` guard removed          → 1 red, "claimed 'no boards' above
//                                                  the fold holding the match"
//       the `!stale.length` guard removed        → 1 red, "denied a match the stale
//                                                  fold is holding"
//   I3  markNotesSeen back to an unconditional now() → 4 red across
//       render-agreement + issue-31, incl. the watermark stamp itself
//   I4  repliedEntries narrowed back to the strict awaiting-pickup subset → 1 red,
//       "expected [] to deeply equal [ 'ship it?' ]"
//   I5  `keepalive: true` removed                → 1 red, "expected undefined to be true"
// Keep both files; they cover different things.
// The parts that could be lifted into pure functions were: reconcileOpenRow
// (test/poll.test.ts), seenWatermark (test/notes.test.ts), repliedEntries
// (test/rowview.test.ts) and isAskingQuestion (test/attention.test.ts) carry real
// behavioural coverage; this file pins that app.js actually calls them.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')

const fn = (name: string, endMarker: string) => {
  const start = js.indexOf(name)
  expect(start, `${name} not found in public/app.js`).toBeGreaterThan(-1)
  const end = js.indexOf(endMarker, start)
  expect(end, `end marker ${endMarker} not found after ${name}`).toBeGreaterThan(-1)
  return js.slice(start, end)
}

// ── I5: a staged ★ flushed on close used a non-keepalive fetch ───────────────
// Spec §5 promises the POST fires "immediately on tab blur/close", but a plain
// fetch started in beforeunload is routinely cancelled on teardown: the row said
// "Sent: <label>" and nothing was written, leaving the agent blocked.
describe('I5 · postJSON survives page teardown', () => {
  it('sets keepalive on the write fetch', () => {
    expect(fn('async function postJSON(', '\nfunction allItems')).toMatch(/keepalive:\s*true/)
  })
})

// ── I1: the triage deck ran a SECOND attention predicate ─────────────────────
// Spec §7 tenet 3 names the deck explicitly: the dock badge, the rail badges,
// the Needs-you tab count AND the triage deck derive from one predicate. The
// deck filtered `!i.reply` + `status === 'blocked'` instead, so it included
// stale items and blocked rows the human had already annotated and the agent had
// already seen — badge 0, calm panel, and then a deck reading "1 of 5".
describe('I1 · the triage deck is built from THE attention predicate', () => {
  const build = fn('function buildDeck()', '\n// resolve a deck entry')
  const find = fn('function findEntryData(', '\nfunction openTriage')

  it('buildDeck calls attentionEntries over the same inputs the badge uses', () => {
    expect(build).toMatch(/attentionEntries\(/)
    expect(build).toMatch(/allItems\(lastData\.g\)/)
    expect(build).toMatch(/liveSessionIds\(\)/)
  })

  it('buildDeck no longer runs its own second filter', () => {
    expect(build).not.toMatch(/!i\.reply/)
    expect(build).not.toMatch(/status === 'blocked'/)
  })

  it('findEntryData re-validates through the same shared predicates', () => {
    expect(find).toMatch(/isAskingQuestion\(/)
    expect(find).toMatch(/isBlockedRowAttention\(/)
    expect(find).not.toMatch(/!it\.reply/)
    expect(find).not.toMatch(/status === 'blocked'/)
  })
})

// ── I2: two "no matches" claims rendered directly above the matches ──────────
describe('I2 · an empty-state claim accounts for the folds below it', () => {
  it('Needs-you computes the stale fold before deciding the list is empty', () => {
    const body = fn('function renderNeedsYou(', '\n// the stale fold')
    expect(body.indexOf('staleEntries(')).toBeLessThan(body.indexOf("if (searchQuery.trim())"))
    expect(body).toMatch(/!stale\.length/)
  })

  it('Boards counts the archived fold before printing "No boards"', () => {
    const body = fn('function renderBoards(', '\nfunction boardEl')
    expect(body.indexOf('const rest =')).toBeLessThan(body.indexOf('emptyMsg('))
    expect(body).toMatch(/!boards\.length && !lingering\.length && !rest\.length/)
  })
})

// ── I3: notes chip vs Notes tab count, and read-marking ──────────────────────
describe('I3 · one scope for both note numbers, and only rendered notes get marked read', () => {
  it('the foot chip is fed the SAME scoped notes the tab count is computed from', () => {
    const extras = fn('function renderNeedsYouExtras(', '\n// the calm state')
    expect(extras, 'the chip still reads the global lastData.g.notes').not.toMatch(/lastData\.g\.notes/)
    expect(extras).toMatch(/function renderNeedsYouExtras\(host,\s*notes\)/)
    expect(fn('function renderNeedsYou(', '\n// the stale fold')).toMatch(/renderNeedsYouExtras\(host,\s*g\.notes/)
  })

  it('markNotesSeen advances the unit-tested watermark instead of stamping now()', () => {
    const mark = fn('function markNotesSeen(', '\n}')
    expect(mark).toMatch(/seenWatermark\(/)
    expect(mark).not.toMatch(/new Date\(\)/)
  })

  it('renderGroups passes the notes it actually rendered plus the ones it hid', () => {
    const body = fn('function renderGroups(', '\nfunction renderDone')
    expect(body).toMatch(/markNotesSeen\(visible,/)
    // the hidden set is the GLOBAL one — a note behind the rail filter was never
    // shown either, and one watermark covers every scope
    expect(body).toMatch(/lastData\.g\.notes/)
  })
})

// ── I4: answered-and-picked-up open questions rendered nowhere ───────────────
describe('I4 · the dimmed foot group keeps picked-up-but-open questions', () => {
  it('renderNeedsYou feeds the list repliedEntries, not the strict awaiting-pickup subset', () => {
    const body = fn('function renderNeedsYou(', '\n// the stale fold')
    expect(body).toMatch(/repliedEntries\(items,/)
    // `awaitingPickupEntries` was the strict subset this call site used to use. It has
    // since been deleted outright (issue #31.4 — nothing called it any more), so this
    // is a never-come-back guard rather than a live either/or.
    expect(body).not.toMatch(/awaitingPickupEntries\(items,/)
  })
})
