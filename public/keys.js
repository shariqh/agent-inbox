// public/keys.js
// Pure keyboard mapping and accessible-name helpers (spec §13). No DOM: the
// caller hands in the key plus what is on screen and gets back an intent.

export const KEYS = {
  next: ['j', 'ArrowDown'],
  prev: ['k', 'ArrowUp'],
}

export const KEYBOARD_COMMANDS = [
  { id: 'hints', key: 'f', display: 'F', label: 'Show keys for the controls on screen', group: 'Start here', selector: '#keyboardHints' },
  { id: 'help', key: '?', display: '?', label: 'Open keyboard shortcuts', group: 'Start here', selector: '#keyboardHelp' },
  { id: 'search', key: 'mod+k', display: 'Mod K', label: 'Search this workspace (or press /)', group: 'Start here', legacy: true },
  { id: 'dashboard', key: 'd', prefix: 'g', display: 'G D', label: 'Dashboard', group: 'Go to', selector: '#tabs [data-tab="dashboard"]' },
  { id: 'needsYou', key: 'i', prefix: 'g', display: 'G I', label: 'Inbox', group: 'Go to', selector: '#tabs [data-tab="needsYou"]' },
  { id: 'boards', key: 'p', prefix: 'g', display: 'G P', label: 'Plans', group: 'Go to', selector: '#tabs [data-tab="boards"]' },
  { id: 'notes', key: 'n', prefix: 'g', display: 'G N', label: 'Notes', group: 'Go to', selector: '#tabs [data-tab="notes"]' },
  { id: 'done', key: 'h', prefix: 'g', display: 'G H', label: 'History', group: 'Go to', selector: '#tabs [data-tab="done"]' },
  { id: 'setup', key: 's', prefix: 'g', display: 'G S', label: 'Settings', group: 'Go to', selector: '#gear' },
  { id: 'agents', key: 'a', prefix: 'g', display: 'G A', label: 'Agent filter', group: 'Go to', selector: '.agent-pick .tab-label' },
  { id: 'projects', key: 'o', prefix: 'g', display: 'G O', label: 'Project picker', group: 'Go to', selector: '#projectDisclosureToggle, .sidebar-section-label' },
  { id: 'live', key: 'l', prefix: 'g', display: 'G L', label: 'Toggle Live sessions', group: 'Go to', selector: '#liveStrip .live-label' },
  { id: 'next', key: 'j', display: 'J / K', label: 'Move between items (arrow keys also work)', group: 'Work through items', legacy: true },
  { id: 'open', key: 'Enter', display: 'Enter', label: 'Open the selected item or focused control', group: 'Work through items', legacy: true },
  { id: 'reply', key: 'r', display: 'R', label: 'Focus the open reply box', group: 'Work through items' },
  { id: 'options', key: '1-4', display: '1-4', label: 'Choose an option in the active card', group: 'Work through items', legacy: true },
  { id: 'submit', key: 'mod+Enter', display: 'Mod Enter', label: 'Send a reply; plain Enter keeps a new line', group: 'Work through items', legacy: true },
  { id: 'resolve', key: 'e', display: 'E', label: 'Resolve the current item', group: 'Work through items', legacy: true },
  { id: 'dismiss', key: 'x', display: 'X', label: 'Dismiss the current item with its undo window', group: 'Work through items', legacy: true },
  { id: 'review', key: 't', display: 'T', label: 'Open the review queue', group: 'Work through items', legacy: true },
  { id: 'focus', key: 'Tab', display: 'Tab / Shift Tab', label: 'Move through controls; use arrows for pickers and pane dividers', group: 'Every control', legacy: true },
  { id: 'escape', key: 'Escape', display: 'Esc', label: 'Leave hints, cancel a shortcut, or close the current surface', group: 'Every control', legacy: true, selector: '.keyboard-close, .lb-close, .relay-close, .mission-close, .mission-detail-close' },
]

// ctx: { typing, deckOpen, expanded, peeking, optionCount }
export function keyAction(key, ctx = {}) {
  const {
    typing = false,
    deckOpen = false,
    expanded = false,
    peeking = false,
    optionCount = 0,
  } = ctx
  if (key === 'Escape') {
    if (typing) return { type: 'blur' }
    if (deckOpen) return { type: 'closeDeck' }
    if (expanded) return { type: 'collapse' }
    if (peeking) return { type: 'exitPeek' }
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
