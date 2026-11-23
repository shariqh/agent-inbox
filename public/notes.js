// Notes: read-state + expiry (spec §8).
// Pure — no DOM, no storage; the viewer passes `nowMs` and the last-seen stamp in.
import { NOTE_AGE_MS } from './attention.js'

// Notes older than NOTE_AGE_MS stop being notes and age into Done, so the tab
// count can come back down instead of growing forever.
export function partitionNotes(notes, nowMs) {
  const cutoff = nowMs - NOTE_AGE_MS
  const fresh = []
  const aged = []
  for (const n of notes) (Date.parse(n.created_at) >= cutoff ? fresh : aged).push(n)
  return { fresh, aged }
}

// accepts a Set (viewer) or a plain array (localStorage JSON / tests)
function asIdSet(ids) {
  return ids instanceof Set ? ids : new Set(ids ?? [])
}

// "new since you last looked" — an aged-out note is never new.
// Two read-marks compose with AND-NOT: the watermark (a stamp below everything
// that stayed hidden) and `seenIds` (notes that were literally on screen). The
// watermark alone cannot express "these five, but not the older one behind the
// pager", which is the ordinary case once an agent writes more notes than the
// pager shows — see markSeenIds.
export function unreadNotes(notes, lastSeenIso, nowMs, seenIds) {
  const { fresh } = partitionNotes(notes, nowMs)
  const seen = asIdSet(seenIds)
  const byMark = lastSeenIso ? fresh.filter((n) => n.created_at > lastSeenIso) : fresh
  return seen.size ? byMark.filter((n) => !seen.has(n.id)) : byMark
}

export function unreadNoteCount(notes, lastSeenIso, nowMs, seenIds) {
  return unreadNotes(notes, lastSeenIso, nowMs, seenIds).length
}

// Read-marking is a single watermark (`notesSeenAt`), so it can only honestly
// advance to a point below every note the human was NOT shown — the pager's
// hidden tail, and anything the rail filter narrowed away. Stamping `now()` on
// every render while the tab is open (the old rule) marked those read too.
// Never moves backwards.
export function seenWatermark(rendered, hidden, prevIso) {
  const stamps = (list) => list.map((n) => n.created_at).filter(Boolean).sort()
  const cutoff = stamps(hidden ?? [])[0] // the oldest note that stayed hidden
  const safe = stamps(rendered ?? []).filter((s) => cutoff === undefined || s < cutoff)
  const next = safe[safe.length - 1]
  if (!next) return prevIso ?? null
  return prevIso && prevIso >= next ? prevIso : next
}

// The other half of read-marking (issue #31.2): the notes that were literally on
// screen, by id. A single ISO watermark cannot say "these five, but not the older
// one the pager hid" — and that is the COMMON case, not an edge: any agent that
// writes more notes than the pager shows pins the tab count until they age out.
//
// `live` is the current note list, which the viewer keeps trimmed to the 7-day
// window; intersecting against it is the pruning that keeps this set bounded
// instead of growing in localStorage forever. It MUST be the global note list —
// prune against a rail-filtered one and every note behind the filter comes back
// unread. Returns an array, so the caller can JSON.stringify it straight out.
export function markSeenIds(prevIds, rendered, live) {
  const liveIds = new Set((live ?? []).map((n) => n.id))
  const next = new Set()
  for (const id of asIdSet(prevIds)) if (liveIds.has(id)) next.add(id)
  for (const n of rendered ?? []) if (liveIds.has(n.id)) next.add(n.id)
  return [...next]
}
