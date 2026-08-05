// test/issue-31-followups.test.ts
// GitHub issue #31 — the four follow-ups from the final review of the
// glanceable-viewer rebuild, pinned as SOURCE TEXT.
//
// The user-visible half runs for real against jsdom in test/dom/issue-31.test.ts
// (all of it verified to fail before the fix). This file asserts the things a
// rendered result cannot distinguish: WHICH construct each fix uses, and — the
// reason this file exists at all — that a green suite cannot certify a no-op.
//
// The specific trap: 31.2's per-id write, appended naively, sits behind
// markNotesSeen's watermark early-return and therefore never runs in exactly the
// case it was written for. Every pure test still passes and the shipped
// behaviour is unchanged. `it('the id write is not gated behind the watermark')`
// below is the assertion that catches that.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')

/**
 * Drop comment-ONLY lines. These pins reason about ORDER and about which symbols
 * a function mentions, and this file's own explanatory comments name every symbol
 * it pins — without this, prose reads as code and the assertions lie in both
 * directions. A trailing comment keeps its code half.
 */
const code = (src: string): string => src
  .split('\n')
  .filter((line) => {
    const t = line.trim()
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
  })
  .join('\n')

/** A top-level function body, comments stripped: from its `function` keyword to the next one. */
const topLevelFn = (decl: string): string => {
  const start = js.indexOf(decl)
  expect(start, `${decl} not found in public/app.js`).toBeGreaterThan(-1)
  const end = js.indexOf('\nfunction ', start + 1)
  expect(end, `no following top-level function after ${decl}`).toBeGreaterThan(-1)
  return code(js.slice(start, end))
}

// ── 31.1: the accepted "Change answer" parked an invisible draft ─────────────
// It stages a prefill draft and then calls load(). A draft IS a suspend reason
// (poll.js's suspendReason), so load()'s renderIfIdle() is GUARANTEED to skip the
// render that would have built the input the draft lives in. Nothing painted,
// nothing could clear it: the C2 freeze, on the accepted path this time.
describe('31.1 · changeAnswer paints the surface it just staged a draft into', () => {
  const body = code(js.match(/async function changeAnswer\([\s\S]*?\n\}/)?.[0] ?? '')

  it('changeAnswer was matched (the slice is not silently empty)', () => {
    expect(body, 'async function changeAnswer( … ) not found').toBeTruthy()
  })

  it('renders directly after the accepted path, and only after awaiting the reload', () => {
    // `await load(); forceRender()` written out by hand here originally. Issue #38
    // found the same two lines missing from EIGHT other write handlers and gave the
    // pair a name — reloadAndPaint(), whose own shape (await load() then
    // forceRender()) is pinned in test/shell.test.ts. Same construct, one caller
    // instead of nine hand-copies.
    expect(body).toMatch(/draftReplies\[it\.id\]\s*=[\s\S]*await reloadAndPaint\(\)/)
    expect(body, 'the prefill must be written BEFORE the reload, or the frame paints the old reply')
      .not.toMatch(/await reloadAndPaint\(\)[\s\S]*draftReplies\[it\.id\]\s*=/)
  })

  it('guarantees a surface exists before rendering — the star-Undo call site fires from a COLLAPSED row', () => {
    // A repaint alone builds no answer input when the row is not expanded
    // (itemCardEl is only mounted under `openRowId === m.id`), so the fix has to
    // open the row. setOpenRow stays the single writer of openRowId — that
    // invariant is pinned in test/card.test.ts.
    expect(body).toMatch(/setOpenRow\(it\.id\)/)
    expect(body.indexOf('setOpenRow(it.id)')).toBeLessThan(body.indexOf('reloadAndPaint()'))
  })

  it('the refusal branch still returns before any render or draft write (C2 must not regress)', () => {
    const refusal = body.match(/if \(!res\.ok\) \{[\s\S]*?\n  \}/)
    expect(refusal, 'no refusal branch found').toBeTruthy()
    expect(refusal![0]).toMatch(/return/)
    expect(refusal![0]).not.toMatch(/reloadAndPaint|forceRender|setOpenRow|draftReplies\[it\.id\]\s*=/)
  })

  it('the network-failure branch still returns before any render or draft write', () => {
    const netFail = body.slice(body.indexOf('res === null'), body.indexOf('if (!res.ok)'))
    expect(netFail).toMatch(/return/)
    expect(netFail).not.toMatch(/reloadAndPaint|forceRender|setOpenRow|draftReplies\[it\.id\]\s*=/)
  })

  it('forceRender clears renderDirty and repaints the pause hint, so a painted viewer stops claiming it is paused', () => {
    const fn = topLevelFn('function forceRender()')
    expect(fn).toMatch(/renderDirty\s*=\s*false/)
    expect(fn).toMatch(/\brender\(\)/)
    expect(fn).toMatch(/showPauseHint\(\)/)
  })

  it('forceRender is never reachable from the poll — renderIfIdle() stays its ONLY entry', () => {
    // If this ever leaks into load(), renderIfIdle() or the 3s interval, spec §10's
    // gate is gone and the poll starts rebuilding the DOM under the cursor.
    expect(topLevelFn('async function load()')).not.toContain('forceRender')
    expect(topLevelFn('function renderIfIdle()')).not.toContain('forceRender')
    expect(topLevelFn('function resumeRender()')).not.toContain('forceRender')
    expect(js).not.toMatch(/setInterval\(\s*forceRender/)
  })

  // This replaces the old "forceRender() has exactly ONE caller" count, which was
  // standing in for an invariant it could only approximate. Issue #38 gave
  // forceRender the callers it was always owed: every user-initiated repaint. The
  // count is therefore meaningless now — but the property it was protecting is
  // stronger than ever, and directly checkable.
  //
  // The comment above forceRender() has claimed this since the rebuild: there are
  // exactly TWO ways into render(), the poll's (renderIfIdle, gated by §10) and the
  // human's (forceRender, ungated, and the ONLY thing that clears renderDirty and
  // refreshes #pauseHint). Before #38 that claim was false in both directions —
  // seventeen handlers called render() directly, so the viewer would repaint and go
  // on telling the human "paused — updating when you're done" over data that was
  // already on screen.
  it('render() has exactly two entries: the poll’s and the human’s (#38 / D3)', () => {
    const src = code(js)
    const enclosing = (i: number): string => {
      const decls = [...src.slice(0, i).matchAll(/\n(?:async )?function (\w+)/g)]
      return decls[decls.length - 1]?.[1] ?? '<module top level>'
    }
    // `(?<!function )` skips the declaration itself; the capital R in forceRender /
    // resumeRender / renderIfIdle means none of those match `render()`.
    const callers = [...src.matchAll(/(?<!function )(?<![\w.])render\([^)]*\)/g)]
      .map((m) => enclosing(m.index!))
    expect([...new Set(callers)].sort(),
      'a direct render() outside these two leaves #pauseHint lying about paused data').toEqual(['forceRender', 'renderIfIdle'])
  })

  it('rowCardBodyEl resolves the item through freshItem() rather than the render-time closure', () => {
    const fn = topLevelFn('function rowCardBodyEl(')
    expect(fn).toMatch(/itemCardEl\(freshItem\(entry\.item\.id\)\s*\?\?\s*entry\.item/)
    // …and the lookup stays INSIDE the item branch: entry.item is undefined for
    // board-row entries, so hoisting it is a TypeError on every expanded blocked row.
    expect(fn).toMatch(/entry\.kind === 'row'\s*\n?\s*\?\s*rowCardEl\(/)
  })
})

// ── 31.2: the notes read-mark could not come down ────────────────────────────
describe('31.2 · read-marking records ids as well as a watermark', () => {
  const mark = topLevelFn('function markNotesSeen(')

  it('uses the unit-tested pure builders, and still never stamps now() (I3 must not regress)', () => {
    expect(mark).toMatch(/seenWatermark\(/)
    expect(mark).toMatch(/markSeenIds\(/)
    expect(mark).not.toMatch(/new Date\(\)/)
    expect(js).toMatch(/import \{[^}]*markSeenIds[^}]*\} from '\/notes\.js'/)
  })

  it('the id write is NOT gated behind the watermark — "the watermark could not advance" is the whole point', () => {
    // The naive edit keeps `if (!next || next === notesSeenAt) return` and appends the
    // id write after it. Every pure test still passes and NOTHING changes on screen.
    expect(mark, 'the watermark early-return still swallows the id write').not.toMatch(/if \(!next \|\| next === notesSeenAt\) return/)
    const beforeIds = mark.slice(0, mark.indexOf('markSeenIds('))
    expect(beforeIds, 'something returns before the id write is reached').not.toMatch(/\breturn\b/)
  })

  it('persists the id set under its own key, so an older bundle reading the watermark still works', () => {
    expect(js).toMatch(/const NOTES_SEEN_IDS_KEY = 'agent-inbox-notes-seen-ids'/)
    expect(mark).toMatch(/localStorage\.setItem\(NOTES_SEEN_IDS_KEY/)
    expect(mark).toMatch(/localStorage\.setItem\(NOTES_SEEN_KEY/)
  })

  it('renderGroups prunes against the GLOBAL note list, never the rail-filtered one', () => {
    // Prune against a filtered list and every note behind the rail filter is
    // resurrected as unread on the next render.
    const body = topLevelFn('function renderGroups(')
    expect(body).toMatch(/const all = lastData\.g\.notes\.flatMap/)
    expect(body).toMatch(/markNotesSeen\(visible,[\s\S]*?,\s*all\)/)
  })

  it('every reader of the unread count is fed the id set, so no two note numbers can disagree', () => {
    for (const reader of ['function paintTabCounts(', 'function renderNeedsYouExtras(', 'function renderEmptyState(']) {
      expect(topLevelFn(reader), `${reader} still reads the watermark alone`).toMatch(/notesSeenIds/)
    }
  })
})

// ── 31.3: suppressing a false claim also swallowed the pointer ───────────────
describe('31.3 · a stale-only search still prints the §12 pointer', () => {
  const body = topLevelFn('function renderNeedsYou(')

  it('keeps I2 (no "no matches" claim above a fold holding one) and adds the pointer beside it', () => {
    expect(body).toMatch(/!stale\.length/)
    const branch = body.slice(body.indexOf("if (searchQuery.trim())"), body.indexOf('} else {'))
    expect(branch).toContain('elsewhereMsg()')
    // the else is the STALE-matches path — it must not print the false claim
    const elseBranch = branch.slice(branch.indexOf('else {'))
    expect(elseBranch).not.toContain('emptyMsg(')
  })

  it('both surfaces share ONE builder, so the pointer cannot drift between them', () => {
    expect(js).toMatch(/import \{[^}]*elsewhereLabel[^}]*\} from '\/tabsearch\.js'/)
    expect(topLevelFn('function elsewhereMsg()')).toMatch(/elsewhereLabel\(matchCounts, activeTab, TAB_LABEL\)/)
    expect(topLevelFn('function emptyMsg(')).toMatch(/elsewhereMsg\(\)/)
  })

  it('emptyMsg still escapes the search query — the refactor must not drop esc(q)', () => {
    expect(topLevelFn('function emptyMsg(')).toMatch(/esc\(q\)/)
  })

  it('the new sentence interpolates only the shared builder — never agent text', () => {
    // The result goes straight into innerHTML, which is only safe because the ONLY
    // interpolation is `where`: elsewhereLabel over the fixed TAB_LABEL map and
    // integer counts. Anything agent-authored appearing here needs esc().
    const fn = topLevelFn('function elsewhereMsg()')
    expect(fn.match(/\$\{[^}]*\}/g)).toEqual(['${where}'])
  })
})

// ── 31.4: exported, typed, tested — and called by nothing ────────────────────
describe('31.4 · the dead helpers are gone, not merely untested', () => {
  const files = ['app.js', 'rowview.js', 'rowview.d.ts', 'tabs.js', 'tabs.d.ts']
    .map((n) => readFileSync(new URL(`../public/${n}`, import.meta.url), 'utf8'))
    .join('\n')

  it('awaitingPickupEntries is deleted from the module AND its .d.ts', () => {
    expect(files).not.toMatch(/export function awaitingPickupEntries/)
    expect(files).not.toMatch(/^export function awaitingPickupEntries/m)
  })

  it('livePresence and the interface that existed only to type it are deleted', () => {
    expect(files).not.toMatch(/export function livePresence/)
    expect(files).not.toMatch(/export interface LiveActivity/)
  })

  it('the ambient awaiting count stays where it was — this was not an excuse for a second predicate', () => {
    // notes.js's inline `kind === 'question' && reply && !reply_seen_at` is AMBIENT,
    // explicitly not the attention set (tenet 3 does not reach it), and public/
    // attention.js is untouched by this workstream.
    const notes = readFileSync(new URL('../public/notes.js', import.meta.url), 'utf8')
    expect(notes).toMatch(/i\.kind === 'question' && i\.reply && !i\.reply_seen_at/)
  })
})
