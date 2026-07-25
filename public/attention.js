// The attention set, liveness classification and Needs-you ordering — one
// predicate, used by the dock badge, the rail badges, the tab count and the
// triage deck (design §6, §7, §3). Pure: no DOM, no fetch, clock injected as
// `nowMs` and live sessions injected as `liveSessionIds`.

export const STALE_MS = 72 * 60 * 60 * 1000     // no live session + older than this → stale fold
export const ESCALATE_MS = 60 * 60 * 1000       // a *waiting* item older than this turns the rail badge red
export const NOTE_AGE_MS = 7 * 24 * 60 * 60 * 1000 // notes auto-age into Done (§8)

// accepts a Set (browser) or a plain array (tests / JSON) without copying a Set
function asSet(sessions) {
  return sessions instanceof Set ? sessions : new Set(sessions ?? [])
}

// unparseable timestamps sort as maximally old rather than throwing NaN into a
// comparator — fail-open, never drop an item
function createdMs(entity) {
  const t = Date.parse(entity.created_at)
  return Number.isFinite(t) ? t : 0
}

// A question is still asking only while it is OPEN and unanswered. `resolve`
// closes an item without ever writing a reply, so keying on `reply` alone
// counts a resolved question forever and the badge can never reach zero.
// Absent status (hand-built fixtures, legacy rows) is treated as open.
// EXPORTED because the triage deck re-validates its entries against the live
// data: it used to re-implement this as a bare `!i.reply`, which is the second
// predicate spec §7 tenet 3 exists to forbid.
export function isAskingQuestion(item) {
  if (!item || item.kind !== 'question' || item.reply) return false
  return item.status === undefined || item.status === null || item.status === 'open'
}

// waiting = an agent is blocked on you *right now*; parked = answer whenever;
// stale = nobody is listening and it has been >72h (demoted to the fold, §6)
export function classifyLiveness(item, nowMs, liveSessionIds) {
  if (item.session && asSet(liveSessionIds).has(item.session)) return 'waiting'
  return nowMs - createdMs(item) > STALE_MS ? 'stale' : 'parked'
}

// A blocked row stops asking once the human has annotated it AND the agent has
// seen that annotation. Counting every blocked row (the old app.js:139 rule)
// makes the badge unable to return to zero.
export function isBlockedRowAttention(row) {
  if (row.status !== 'blocked') return false
  return !(row.annotation && !row.annotation_unseen)
}

// attention = open unanswered questions (minus the stale fold) ∪ escalating
// blocked rows. Nothing else: not notes, not milestones, not resolved, not
// answered-awaiting-pickup.
export function attentionEntries(items, boards, nowMs, liveSessionIds) {
  const live = asSet(liveSessionIds)
  const out = []
  for (const it of items ?? []) {
    if (!isAskingQuestion(it)) continue
    const liveness = classifyLiveness(it, nowMs, live)
    if (liveness === 'stale') continue
    out.push({ kind: 'item', item: it, liveness })
  }
  for (const b of boards ?? []) {
    for (const r of b.rows ?? []) if (isBlockedRowAttention(r)) out.push({ kind: 'row', row: r, board: b })
  }
  return out
}

// The other half of the split: questions the attention set drops because nobody
// is listening any more. §6 DEMOTES these into a collapsed fold — it does not
// delete them, so the fold needs its own accessor.
export function staleEntries(items, nowMs, liveSessionIds) {
  const live = asSet(liveSessionIds)
  const out = []
  for (const it of items ?? []) {
    if (!isAskingQuestion(it)) continue
    if (classifyLiveness(it, nowMs, live) === 'stale') out.push({ kind: 'item', item: it, liveness: 'stale' })
  }
  return out
}

export function attentionCount(items, boards, nowMs, liveSessionIds) {
  return attentionEntries(items, boards, nowMs, liveSessionIds).length
}

// per-project totals for the rail. `escalated` is the red subset: blocked rows,
// or waiting items (live agent blocked) older than an hour. A rail of all-red
// badges is a rail of no information.
export function countsByProject(items, boards, nowMs, liveSessionIds) {
  const map = new Map()
  for (const e of attentionEntries(items, boards, nowMs, liveSessionIds)) {
    const project = e.kind === 'row' ? e.board.project : e.item.project
    const cur = map.get(project) ?? { total: 0, escalated: 0 }
    cur.total += 1
    if (e.kind === 'row') cur.escalated += 1
    else if (e.liveness === 'waiting' && nowMs - createdMs(e.item) > ESCALATE_MS) cur.escalated += 1
    map.set(project, cur)
  }
  return map
}

// 0 blocked rows · 1 waiting · 2 parked · 3 answered-awaiting-pickup (dimmed foot)
function bucket(e) {
  if (e.kind === 'row') return 0
  if (e.item.reply) return 3
  return e.liveness === 'waiting' ? 1 : 2
}

// Stable: equal keys keep input order, so a poll rebuild does not reshuffle the
// list under the pointer.
export function sortNeedsYou(entries, nowMs) {
  return entries
    .map((e, i) => ({ e, i, b: bucket(e) }))
    .sort((a, b) => {
      if (a.b !== b.b) return a.b - b.b
      if (a.b === 1 || a.b === 2) {
        const age = (nowMs - createdMs(a.e.item)) - (nowMs - createdMs(b.e.item))
        if (age !== 0) return -age // oldest (largest age) first
      }
      return a.i - b.i
    })
    .map((k) => k.e)
}
