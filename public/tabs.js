// Pure tab model for the content tabs. Dependency-free (Node-testable): the
// attention count is INJECTED rather than imported, so the filter-blindness
// rule is stated here instead of hiding inside a call site.

export const TAB_IDS = ['needsYou', 'boards', 'live', 'notes', 'done']

// the active tab is never persisted — the app always opens where the action is
export const DEFAULT_TAB = 'needsYou'

// `globalAttention` is the §7 predicate over UNFILTERED data; `scoped` is the
// project/agent/search-narrowed view; `unreadNotes` is an ALREADY-COMPUTED
// number (the caller decides what "unread" means). Needs-you is filter-blind by
// construction: selecting a project narrows the list, never the global signal.
// `live` is null on purpose — Live gets a presence dot; numbers are reserved for
// things that actually want you.
export function tabCounts({ globalAttention, unreadNotes, scoped }) {
  return {
    needsYou: globalAttention,
    boards: scoped.boards.length,
    live: null,
    notes: unreadNotes ?? 0,
    done: scoped.done.length,
  }
}

export function livePresence(activity) {
  return (activity ?? []).some((a) => !a.idle)
}
