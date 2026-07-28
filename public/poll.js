// Pure poll-suspension decisions for the viewer (spec §10). No DOM, no timers:
// the caller hands in the current UI state and gets back what the 3s poll is
// allowed to do. Unit-tested from test/poll.test.ts.

// Any expanded card or any non-empty draft freezes the re-render — the poll
// must never eat a half-typed answer or collapse a card under the cursor.
export function suspendReason(state) {
  const expanded = (state && state.expanded) || []
  const size = expanded instanceof Set ? expanded.size : expanded.length
  if (size > 0) return 'expanded'
  const drafts = (state && state.drafts) || {}
  for (const v of Object.values(drafts)) {
    if (String(v ?? '').trim() !== '') return 'draft'
  }
  return null
}

export function shouldSuspendRender(state) {
  return suspendReason(state) !== null
}

// The quiet hint a paused viewer shows; null when nothing is suspended.
export function suspendHint(state) {
  return shouldSuspendRender(state) ? "paused — updating when you're done" : null
}

// ── the press guard (issue #38 / D2) ─────────────────────────────────────────
// Measured in real Chrome over CDP, not theorised: the 3s rebuild destroys and
// recreates the node the human is pressing on, so `pointerdown` and `pointerup`
// share no ancestor and the browser dispatches NO CLICK AT ALL — roughly
// `hold / 3000` of every click, on every surface (rail pills, tabs, Answer, Send,
// the ★, the pager), not merely the one that got instrumented.
//
// So the gate is on the PRESS, not on hover, focus or expansion: it is the press
// interval that must not be interrupted, and it is the only interval that has to
// be. Three properties earn it its place beside suspendReason:
//
//  · It is NOT a suspension, and must never be routed through suspendReason() /
//    suspendHint(). A press is bounded by the human's own button-up — tens of ms
//    — and loses nothing (input values are rebuilt from module state, focus is
//    restored, and clicks now survive), so "paused — updating when you're done"
//    would be a NEW lie rather than a repair of the old one.
//  · It CANNOT STRAND. This is a timestamp comparison, not a flag: if the release
//    is never seen (button let go outside the window, no pointercancel) it heals
//    itself within PRESS_GRACE_MS. `reconcileOpenRow` below is the same lesson
//    learned the expensive way — one wasted click, never a frozen viewer.
//  · A press held longer than the grace degrades to today's behaviour exactly.
//    It can never do worse than the code it replaces.
export const PRESS_GRACE_MS = 1000

export function pressHeld(pressedAt, nowMs) {
  return pressedAt != null && nowMs - pressedAt < PRESS_GRACE_MS
}

// What the 3s poll may do RIGHT NOW: the §10 suspension, plus the press interval.
export function shouldDeferRender(state, nowMs) {
  return pressHeld(state?.pressedAt ?? null, nowMs) || shouldSuspendRender(state)
}

// Sort order pins per render session: ids already on screen keep their relative
// order however the server re-sorts them; genuinely new ids append at the foot.
export function pinOrder(current, incoming) {
  const next = new Set(incoming)
  const kept = current.filter((id) => next.has(id))
  const seen = new Set(kept)
  return [...kept, ...incoming.filter((id) => !seen.has(id))]
}

// How many rows would appear/disappear if a staged update were applied.
export function pendingCount(current, incoming) {
  const now = new Set(current)
  const next = new Set(incoming)
  let n = 0
  for (const id of next) if (!now.has(id)) n++
  for (const id of now) if (!next.has(id)) n++
  return n
}

// While the pointer is over the list, membership changes STAGE instead of
// applying — rows must not move out from under a click. `staged` is replayed on
// mouse-leave.
export function applyListUpdate({ current, incoming, hovering }) {
  if (hovering) return { ids: current, staged: incoming, pending: pendingCount(current, incoming) }
  return { ids: pinOrder(current, incoming), staged: null, pending: 0 }
}

// The other half of the suspension contract. `expanded` above is fed from
// module state (app.js's openRowId) whose only clearing path is a DOM
// affordance — `toggleRow`, reachable exclusively from a rendered `.nrow`.
// Anything else written into it (a deep-linked BOARD id, a notes/done item id)
// therefore suspended the poll FOREVER: no row, no toggle, no clear. This is
// the render-time reconciliation — the render that just happened is the truth
// about what is still collapsible — so a writer that aims at nothing costs one
// wasted click instead of a frozen viewer.
export function reconcileOpenRow(openId, renderedIds) {
  if (openId == null) return null
  const ids = renderedIds instanceof Set ? renderedIds : new Set(renderedIds ?? [])
  return ids.has(openId) ? openId : null
}
