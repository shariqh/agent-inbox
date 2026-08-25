// Pure tab model for the content tabs. Dependency-free (Node-testable): the
// attention count is INJECTED rather than imported, so the filter-blindness
// rule is stated here instead of hiding inside a call site.

export const TAB_IDS = ['dashboard', 'needsYou', 'boards', 'notes', 'done']

// the active tab is never persisted — the app always opens at the live desk
export const DEFAULT_TAB = 'dashboard'

// `globalAttention` is the §7 predicate over UNFILTERED data; `scoped` is the
// project/agent/search-narrowed view; `unreadNotes` is an ALREADY-COMPUTED
// number (the caller decides what "unread" means). Needs-you is filter-blind by
// construction: selecting a project narrows the list, never the global signal.
// Live is no longer a tab (spec §16) — it's an always-visible footer strip, so
// it carries no count here at all.
export function tabCounts({ globalAttention, unreadNotes, scoped }) {
  return {
    needsYou: globalAttention,
    boards: scoped.boards.length,
    notes: unreadNotes ?? 0,
    done: scoped.done.length,
  }
}

// (A `livePresence(activity)` helper used to live here, commented "still used by
// the footer strip". It was not: livebar.js's liveSummary re-derives `!a.idle`
// itself, and nothing else ever imported this. Deleted with issue #31.4 —
// test/dead-exports.test.ts now fails the moment an export goes quiet like that.)
