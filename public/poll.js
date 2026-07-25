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
