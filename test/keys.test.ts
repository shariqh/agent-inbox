import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { keyAction, rovingIndex, ariaAnswerLabel, livenessGlyph } from '../public/keys.js'

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

// spec §13 regression: keyboard '1'-'4' must answer whatever the triage deck is
// SHOWING, not whatever the list still has selected underneath it. app.js has no
// DOM test harness in this repo (see test/shell.test.ts), so this is source-level.
//
// Deviation from the task brief's literal reference wiring: the brief's suggested
// `keyTargetItem` body is `findEntryData(triageDeck.entries[triageDeck.index])?.it`,
// called unconditionally. That throws when the deck is open but empty (the "all
// clear" state — triageDeck is non-null, entries is []), because
// `findEntryData(undefined)` dereferences `undefined.type`. initKeys computes
// optionCount from keyTargetItem() on EVERY keydown while the deck is open, so
// that state is reachable on a live keypress, not just a corner case. The
// implementation below guards the empty-array case before calling findEntryData;
// these assertions pin that shape instead of the brief's exact (unsafe) substring.
describe('app.js wiring — deck-open keyboard options target the deck entry, not the list selection', () => {
  const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')

  it('defines keyTargetItem, deriving from the deck entry while triageDeck is open', () => {
    const start = js.indexOf('function keyTargetItem')
    expect(start, 'keyTargetItem is missing').toBeGreaterThan(-1)
    const fn = js.slice(start, start + 500)
    expect(fn).toContain('triageDeck')
    expect(fn).toContain('triageDeck.entries[triageDeck.index]')
    expect(fn).toContain('findEntryData(')
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
})
