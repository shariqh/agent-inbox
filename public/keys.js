// public/keys.js
// Pure keyboard mapping and accessible-name helpers (spec §13). No DOM: the
// caller hands in the key plus what is on screen and gets back an intent.

export const KEYS = {
  next: ['j', 'ArrowDown'],
  prev: ['k', 'ArrowUp'],
}

// ctx: { typing, deckOpen, expanded, optionCount }
export function keyAction(key, ctx = {}) {
  const { typing = false, deckOpen = false, expanded = false, optionCount = 0 } = ctx
  if (key === 'Escape') {
    if (typing) return { type: 'blur' }
    if (deckOpen) return { type: 'closeDeck' }
    if (expanded) return { type: 'collapse' }
    return { type: 'clearSelection' }
  }
  if (typing) return null // an input owns every other keystroke
  // the Now strip's "Triage →" button is gone (Task 6) — 't' is the deck's only
  // remaining door, and it only opens: an already-open deck owns its own keys
  if (key === 't' && !deckOpen) return { type: 'openDeck' }
  if (deckOpen) {
    if (key === 'ArrowRight' || KEYS.next.includes(key)) return { type: 'deckNext' }
    if (key === 'ArrowLeft' || KEYS.prev.includes(key)) return { type: 'deckPrev' }
  } else {
    if (KEYS.next.includes(key)) return { type: 'move', delta: 1 }
    if (KEYS.prev.includes(key)) return { type: 'move', delta: -1 }
  }
  if (key === 'Enter') return { type: 'expand' }
  // accepting a recommendation by keyboard costs the same as reading it
  if (/^[1-4]$/.test(key)) {
    const index = Number(key) - 1
    return index < optionCount ? { type: 'option', index } : null
  }
  if (key === 'x') return { type: 'dismiss' }
  if (key === 'e') return { type: 'resolve' }
  if (key === '/') return { type: 'search' }
  return null
}

// Roving focus for a tablist (rail + top tabs): exactly one tab is tabbable and
// the arrows move between them.
export function rovingIndex(current, key, count) {
  if (count <= 0) return 0
  const wrap = (i) => ((i % count) + count) % count
  switch (key) {
    case 'ArrowDown':
    case 'ArrowRight':
      return wrap(current + 1)
    case 'ArrowUp':
    case 'ArrowLeft':
      return wrap(current - 1)
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return current
  }
}

// The star's accessible name must say what one tap sends.
export function ariaAnswerLabel(option) {
  return option && option.label ? `Answer: ${option.label}` : null
}

// Every colour-coded state also carries a glyph AND text.
const LIVENESS = {
  waiting: { glyph: '◉', text: 'waiting' },
  parked: { glyph: '◌', text: 'parked' },
  stale: { glyph: '·', text: 'stale' },
}

export function livenessGlyph(liveness) {
  return LIVENESS[liveness] ?? { glyph: '·', text: String(liveness ?? '') }
}

// The triage deck's "current" entry. `index` is not always in range: the deck
// can narrow to nothing ("all clear" — entries: []) while still open, or an
// entry can age out from under a stale index. Centralizing the out-of-range
// guard here (fix round 1) turns it into an executable, unit-tested
// guarantee instead of a source-string pin on the app.js call site.
export function deckEntryAt(entries, index) {
  return (entries ?? [])[index] ?? null
}
