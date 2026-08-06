import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { keyAction, rovingIndex, ariaAnswerLabel, livenessGlyph, deckEntryAt } from '../public/keys.js'

describe('keyAction — list keys', () => {
  it('j/ArrowDown move down, k/ArrowUp move up', () => {
    expect(keyAction('j', {})).toEqual({ type: 'move', delta: 1 })
    expect(keyAction('ArrowDown', {})).toEqual({ type: 'move', delta: 1 })
    expect(keyAction('k', {})).toEqual({ type: 'move', delta: -1 })
    expect(keyAction('ArrowUp', {})).toEqual({ type: 'move', delta: -1 })
  })
  it('Enter expands, x dismisses, e resolves, / focuses search', () => {
    expect(keyAction('Enter', {})).toEqual({ type: 'expand' })
    expect(keyAction('x', {})).toEqual({ type: 'dismiss' })
    expect(keyAction('e', {})).toEqual({ type: 'resolve' })
    expect(keyAction('/', {})).toEqual({ type: 'search' })
  })
  it('1-4 pick option N — but only options that exist', () => {
    expect(keyAction('1', { optionCount: 3 })).toEqual({ type: 'option', index: 0 })
    expect(keyAction('3', { optionCount: 3 })).toEqual({ type: 'option', index: 2 })
    expect(keyAction('4', { optionCount: 3 })).toBeNull()
    expect(keyAction('1', { optionCount: 0 })).toBeNull()
  })
  it('returns null for unmapped keys', () => {
    expect(keyAction('q', {})).toBeNull()
    expect(keyAction('5', { optionCount: 9 })).toBeNull()
  })
})

describe('keyAction — never steal a keystroke from an input', () => {
  it('is inert while typing, except Escape which blurs', () => {
    expect(keyAction('j', { typing: true })).toBeNull()
    expect(keyAction('x', { typing: true })).toBeNull()
    expect(keyAction('1', { typing: true, optionCount: 3 })).toBeNull()
    expect(keyAction('Escape', { typing: true })).toEqual({ type: 'blur' })
  })
})

// The Now strip's "Triage →" button is gone (Task 6); 't' is the deck's only
// remaining door, and it must not fight the deck's own keys once open.
describe("keyAction — 't' opens the triage deck", () => {
  it('opens the deck when it is closed', () => {
    expect(keyAction('t', {})).toEqual({ type: 'openDeck' })
  })
  it('is inert once the deck is already open — deck keys own the keyboard there', () => {
    expect(keyAction('t', { deckOpen: true })).toBeNull()
  })
  it('never steals a "t" typed into a field', () => {
    expect(keyAction('t', { typing: true })).toBeNull()
  })
})

describe('keyAction — the Escape ladder', () => {
  it('closes the deck first, then collapses, then clears the selection', () => {
    expect(keyAction('Escape', { deckOpen: true, expanded: true })).toEqual({ type: 'closeDeck' })
    expect(keyAction('Escape', { expanded: true })).toEqual({ type: 'collapse' })
    expect(keyAction('Escape', {})).toEqual({ type: 'clearSelection' })
  })
})

describe('keyAction — the triage deck keeps the same keys as the list', () => {
  it('maps j/k and the arrows onto deck navigation', () => {
    expect(keyAction('j', { deckOpen: true })).toEqual({ type: 'deckNext' })
    expect(keyAction('ArrowRight', { deckOpen: true })).toEqual({ type: 'deckNext' })
    expect(keyAction('k', { deckOpen: true })).toEqual({ type: 'deckPrev' })
    expect(keyAction('ArrowLeft', { deckOpen: true })).toEqual({ type: 'deckPrev' })
  })
  it('still accepts an option by number inside the deck', () => {
    expect(keyAction('2', { deckOpen: true, optionCount: 2 })).toEqual({ type: 'option', index: 1 })
  })
})

describe('rovingIndex — tablist roving focus', () => {
  it('wraps forward and back', () => {
    expect(rovingIndex(0, 'ArrowDown', 3)).toBe(1)
    expect(rovingIndex(2, 'ArrowDown', 3)).toBe(0)
    expect(rovingIndex(0, 'ArrowUp', 3)).toBe(2)
    expect(rovingIndex(1, 'ArrowRight', 3)).toBe(2)
    expect(rovingIndex(1, 'ArrowLeft', 3)).toBe(0)
  })
  it('Home/End jump to the ends and unmapped keys hold', () => {
    expect(rovingIndex(2, 'Home', 4)).toBe(0)
    expect(rovingIndex(0, 'End', 4)).toBe(3)
    expect(rovingIndex(2, 'a', 4)).toBe(2)
  })
  it('is safe on an empty tablist', () => {
    expect(rovingIndex(0, 'ArrowDown', 0)).toBe(0)
  })
})

describe('ariaAnswerLabel — the star says what it sends', () => {
  it('reads "Answer: <label>"', () => {
    expect(ariaAnswerLabel({ label: 'Ship it', recommended: true })).toBe('Answer: Ship it')
  })
  it('is null with no option — no star, no name', () => {
    expect(ariaAnswerLabel(null)).toBeNull()
    expect(ariaAnswerLabel({})).toBeNull()
  })
})

describe('livenessGlyph — colour is never the only carrier', () => {
  it('gives every state a glyph AND text', () => {
    expect(livenessGlyph('waiting')).toEqual({ glyph: '◉', text: 'waiting' })
    expect(livenessGlyph('parked')).toEqual({ glyph: '◌', text: 'parked' })
    expect(livenessGlyph('stale')).toEqual({ glyph: '·', text: 'stale' })
  })
  it('degrades rather than rendering a bare colour', () => {
    expect(livenessGlyph('nonsense')).toEqual({ glyph: '·', text: 'nonsense' })
  })
})

// fix round 1: `keyTargetItem`'s deck-index lookup used to be a raw
// `triageDeck.entries[triageDeck.index]`, pinned only by a source-string test
// that also matched the brief's original UNSAFE reference (it never asserted
// the out-of-range/empty-deck guard, so reintroducing the crash would have
// passed it). Extracted into a pure, unit-tested helper instead — this is the
// executable guarantee; the empty/out-of-range cases are real test cases
// below, not just a source-string pin.
describe('deckEntryAt — the triage deck index is not always in range', () => {
  it('returns the entry at a valid index', () => {
    expect(deckEntryAt(['a', 'b', 'c'], 1)).toBe('b')
  })
  it('returns null on an empty deck (the "all clear" state) — this used to throw downstream', () => {
    expect(deckEntryAt([], 0)).toBeNull()
  })
  it('returns null for an out-of-range index', () => {
    expect(deckEntryAt(['a'], 3)).toBeNull()
    expect(deckEntryAt(['a'], -1)).toBeNull()
  })
  it('is safe with no entries array at all', () => {
    expect(deckEntryAt(undefined, 0)).toBeNull()
    expect(deckEntryAt(null, 0)).toBeNull()
  })
})

// spec §13 regression: keyboard '1'-'4' must answer whatever the triage deck is
// SHOWING, not whatever the list still has selected underneath it. app.js has no
// DOM test harness in this repo (see test/shell.test.ts), so this is source-level.
describe('app.js wiring — deck-open keyboard options target the deck entry, not the list selection', () => {
  const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')

  it('defines keyTargetItem, deriving from the deck entry (via deckEntryAt) while triageDeck is open', () => {
    const start = js.indexOf('function keyTargetItem')
    expect(start, 'keyTargetItem is missing').toBeGreaterThan(-1)
    const fn = js.slice(start, start + 500)
    expect(fn).toContain('triageDeck')
    expect(fn).toContain('deckEntryAt(triageDeck.entries, triageDeck.index)')
    expect(fn).toContain('findEntryData(')
    expect(fn).toMatch(/entry\s*\?/) // explicit null-guard around findEntryData — belt-and-suspenders with deckEntryAt itself
  })

  it('runIntent resolves its target through keyTargetItem(), not a bare selectedItem()', () => {
    const start = js.indexOf('function runIntent')
    const body = js.slice(start, js.indexOf('function initKeys'))
    expect(body).toContain('keyTargetItem()')
    expect(body).not.toContain('const it = selectedItem()')
  })

  it("initKeys computes optionCount from the same target — 1-4 can't validate against one item and answer another", () => {
    const start = js.indexOf('function initKeys')
    const body = js.slice(start, js.indexOf('function wireTablist'))
    expect(body).toContain('optionCount: optionOrder(keyTargetItem()?.options).length')
  })

  it("dismiss and resolve also resolve through keyTargetItem(), not a bare selectedId", () => {
    const start = js.indexOf('function runIntent')
    const body = js.slice(start, js.indexOf('function initKeys'))
    const dismiss = body.slice(body.indexOf("case 'dismiss'"), body.indexOf("case 'resolve'"))
    const resolve = body.slice(body.indexOf("case 'resolve'"), body.indexOf("case 'search'"))
    expect(dismiss).toContain('stageDismiss(it.id)')
    expect(resolve).toContain('act(it.id')
  })

  it("keyboard dismiss reuses the row task's staged 5s-undo path, not a second undo mechanism", () => {
    expect(js).not.toContain('function dismissRowStaged')
    const start = js.indexOf('function stageDismiss')
    expect(start, 'stageDismiss is missing').toBeGreaterThan(-1)
    // stageDismiss is defined exactly once — the ✕ button and the keyboard both call it
    expect(js.split('function stageDismiss').length - 1).toBe(1)
  })

  // The Now strip's own "Triage →" button is gone (Task 6); 't' → keyAction's
  // `openDeck` intent is the deck's only remaining door, so runIntent's
  // 'openDeck' case is what must actually open it. shell.test.ts's surviving
  // `expect(js).toContain('openTriage()')` is too loose to catch this wiring
  // going missing on its own — it's already satisfied by `function openTriage()
  // {`'s own definition line, without runIntent ever calling it.
  it("runIntent's 'openDeck' case calls openTriage()", () => {
    const start = js.indexOf('function runIntent')
    const body = js.slice(start, js.indexOf('function initKeys'))
    const openDeckCase = body.slice(body.indexOf("case 'openDeck'"))
    expect(openDeckCase, "no case 'openDeck' found in runIntent").toContain('openTriage()')
  })
})

// fix round 1 (Important #1): renderNeedsYou rebuilds every `.nrow` from
// scratch on EVERY render() — including the 3s poll — and, before this fix,
// had no idea a row was keyboard-selected. `selectedId` kept working in the
// closure (j/k never broke), but the VISIBLE `.selected` class and the row's
// real DOM focus were destroyed every ~3s and only self-healed on the next
// keypress: for a screen-reader user that reads as random flakiness, not a
// clean failure. This source pin complements the behavioral DOM coverage by
// failing at the ordering mistake itself.
describe('app.js wiring — keyboard row selection survives the poll rebuild (spec §13, fix round 1)', () => {
  const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')

  it('captures whether focus was already in the list BEFORE clearing it, and restores selection after rebuilding', () => {
    const start = js.indexOf('function renderNeedsYou')
    expect(start, 'renderNeedsYou is missing').toBeGreaterThan(-1)
    const body = js.slice(start, js.indexOf('function staleFoldEl'))
    const captureAt = body.indexOf('hadListFocus =')
    const clearAt = body.indexOf("host.innerHTML = ''")
    const restoreAt = body.lastIndexOf('restoreRowSelection(hadListFocus && !restoredCardFocus)')
    expect(captureAt, 'hadListFocus is not captured').toBeGreaterThan(-1)
    expect(clearAt, "host.innerHTML = '' not found").toBeGreaterThan(-1)
    expect(restoreAt, 'row focus is not restored after giving the open card first refusal').toBeGreaterThan(-1)
    // captured BEFORE the list is cleared — clearing a focused element's
    // subtree moves document.activeElement immediately, so capturing after
    // would always read false
    expect(captureAt).toBeLessThan(clearAt)
    // restored AFTER the rebuild, not before it (the new rows don't exist yet)
    expect(restoreAt).toBeGreaterThan(clearAt)
  })

  it('restoreRowSelection is NOT gated behind the poll-suspend check — selection must survive an ordinary, non-suspended poll too', () => {
    const start = js.indexOf('function restoreRowSelection')
    expect(start, 'restoreRowSelection is missing').toBeGreaterThan(-1)
    const body = js.slice(start, start + 400)
    expect(body).toContain('markSelectedRow(selectedId)')
    expect(body).not.toContain('shouldSuspendRender')
    expect(body).not.toContain('suspendState')
  })

  it('only steals DOM focus back when focus was already in the list — never the search box or a draft input', () => {
    const start = js.indexOf('function restoreRowSelection')
    const body = js.slice(start, start + 400)
    expect(body).toContain('if (focusIt)')
  })

  it('selectRow and restoreRowSelection share one class/attr/tabIndex helper, so the two paths cannot drift', () => {
    const selectStart = js.indexOf('function selectRow')
    const selectBody = js.slice(selectStart, js.indexOf('function selectedItem'))
    expect(selectBody).toContain('markSelectedRow(id)')
    const restoreStart = js.indexOf('function restoreRowSelection')
    const restoreBody = js.slice(restoreStart, restoreStart + 400)
    expect(restoreBody).toContain('markSelectedRow(selectedId)')
  })
})
