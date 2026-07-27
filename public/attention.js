// The attention set, liveness classification and Needs-you ordering — one
// predicate, used by the dock badge, the rail badges, the tab count and the
// triage deck (design §6, §7, §3). Pure: no DOM, no fetch, clock injected as
// `nowMs`, live sessions injected as `liveSessionIds` and closed projects
// injected as `closedProjects`.
//
// TWO things sit outside the attention set on purpose: the §6 stale fold
// (nobody is listening any more) and, since issue #32, a project the human has
// explicitly CLOSED. Both are demotions, never deletions — the stale fold and
// the rail's closed fold each still show what they hold.

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

// A blocked row stops asking the moment the HUMAN answers it — i.e. annotates.
// Whether an agent has picked that answer up is the agent's state, not a reason
// to keep nagging the human, and this is precisely what items already do:
// isAskingQuestion goes false as soon as `reply` is non-empty, pickup irrelevant.
//
// Issues #36 + #37 removed the old `annotation_unseen` dependency deliberately.
// Two things were wrong with it. (1) Annotating is the ONLY lever the viewer
// offers on a blocked row, and it did not move the badge — if the agent's
// session was over, nothing ever would, so the row was literally unclearable
// (#36). (2) It made board-level mark-seen state, written by a different OS
// process, an input to the badge: one `board_get` silently cleared rows nobody
// had read, which is how a real "merge it" note stopped escalating a day later
// with the merge still not done. Nothing here reads delivery state any more.
//
// The signal is NOT removed, it is relabeled: see awaitingAgentRows below.
export function isBlockedRowAttention(row) {
  return row.status === 'blocked' && !row.annotation
}

// The rows isBlockedRowAttention just dropped: blocked, and carrying the human's
// answer. They render in the Needs-you foot beside repliedEntries — "delivered
// 3m ago" vs "waiting for agent pickup" — so an answer nobody collected stays
// visible, as the AGENT's failure rather than the human's to-do. It lives in
// THIS module, next to the predicate whose complement it is, so there is never a
// second place that decides what a blocked row means (tenet 3).
export function awaitingAgentRows(boards, closedProjects = []) {
  const closed = asSet(closedProjects)
  const out = []
  for (const b of boards ?? []) {
    if (closed.has(b.project)) continue
    for (const r of b.rows ?? []) if (r.status === 'blocked' && r.annotation) out.push({ kind: 'row', row: r, board: b })
  }
  return out
}

// attention = open unanswered questions (minus the stale fold) ∪ escalating
// blocked rows. Nothing else: not notes, not milestones, not resolved, not
// answered-awaiting-pickup.
//
// `closedProjects` (issue #32) is the SECOND thing outside the set, alongside
// the §6 stale fold: a project the human explicitly retired. Tenet 2 —
// "when in doubt, a thing does not enter the attention set" — and §6 already
// drops questions on a mere 72h heuristic, so an explicit close is stronger
// evidence, not weaker. The suppression lives HERE, in the one predicate, so
// the dock badge, the title badge, the Needs-you count and the triage deck can
// never disagree about it (tenet 3). Optional and defaulting to empty: every
// existing 4-argument call site keeps its exact behaviour.
export function attentionEntries(items, boards, nowMs, liveSessionIds, closedProjects = []) {
  const live = asSet(liveSessionIds)
  const closed = asSet(closedProjects)
  const out = []
  for (const it of items ?? []) {
    if (closed.has(it.project)) continue
    if (!isAskingQuestion(it)) continue
    const liveness = classifyLiveness(it, nowMs, live)
    if (liveness === 'stale') continue
    out.push({ kind: 'item', item: it, liveness })
  }
  for (const b of boards ?? []) {
    if (closed.has(b.project)) continue
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

export function attentionCount(items, boards, nowMs, liveSessionIds, closedProjects = []) {
  return attentionEntries(items, boards, nowMs, liveSessionIds, closedProjects).length
}

// per-project totals for the rail. `escalated` is the red subset: blocked rows,
// or waiting items (live agent blocked) older than an hour. A rail of all-red
// badges is a rail of no information.
//
// It deliberately never takes the closed set (issue #32): the rail is where a
// suppressed count is RELOCATED, not destroyed. Suppressing here would make the
// closed fold read 0 and turn an honest mute into a silent one — the number the
// fold shows is the whole reason suppression is acceptable at all. The 4-arg
// call below therefore picks up attentionEntries' `closedProjects = []` default
// on purpose; do not "fix" its arity.
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
//
// Bucket 3 covers BOTH nouns: an answered question and an annotated blocked row
// are the same state — the human is done, the agent has not closed it out — so
// they share one ordering rule rather than growing a second one for rows (#37).
function bucket(e) {
  if (e.kind === 'row') return e.row.annotation ? 3 : 0
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
