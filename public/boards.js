// Pure board-matrix helpers (spec §9). No DOM: the Boards tab renders from these.
// Sibling public modules are imported RELATIVELY so the same file resolves in the
// browser (/boards.js → /attention.js) and under vitest.
import { humanActedOnRow, isBlockedRowAttention } from './attention.js'
import { rowPickup } from './rowview.js'

// hide-completed hides `done` rows unless this board opted back in; `num` keeps the
// ORIGINAL 1-based index so "row N" references stay stable when rows are hidden.
export function boardRowsView(board, { hideCompleted = false, showDone = false } = {}) {
  return board.rows
    .map((row, i) => ({ row, num: i + 1, needsAnswer: isBlockedRowAttention(row) }))
    .filter(({ row }) => !(hideCompleted && !showDone && row.status === 'done'))
}

export function boardRowLine(row) {
  return row.status === 'blocked' && row.next_step ? `Next: ${row.next_step}` : (row.note ?? '')
}

// done/countable is the primary reading; the percentage is secondary (spec §9).
export function progressLabel(progress) {
  return {
    primary: `${progress.done}/${progress.countable}`,
    secondary: `${Math.round(progress.fraction * 100)}%`,
    complete: progress.fraction === 1 && progress.countable > 0,
  }
}

// how many done rows this board is currently hiding — drives its "N hidden — show" hint
export function hiddenDoneCount(board, { hideCompleted = false, showDone = false } = {}) {
  if (!hideCompleted || showDone) return 0
  return board.rows.filter((r) => r.status === 'done').length
}

// Boards the human watched reach 100% and that their agent then archived. They
// stay on screen for the rest of the session instead of blinking out of the list
// (spec §9) — `prevActiveIds` is every board id seen active so far this session.
export function lingeringBoards(prevActiveIds, boards, archived) {
  const seen = new Set(prevActiveIds)
  const live = new Set(boards.map((b) => b.id))
  return archived.filter((b) =>
    seen.has(b.id) && !live.has(b.id) && b.progress.fraction === 1 && b.progress.countable > 0)
}

// Issue #299: the outcome-bearing rows archived plans carried in brief leave
// out, and the newest Dashboard stamp among them, shaped like olderHistory()'s
// (public/closed-history.js). A complete plan omits nothing.
export function omittedOutcomes(plans) {
  let outcomes = 0
  let latest = null
  for (const plan of plans ?? []) {
    const omitted = plan?.omitted
    if (!(omitted?.outcomes > 0)) continue
    outcomes += omitted.outcomes
    if (latest === null || omitted.latest > latest) latest = omitted.latest
  }
  return { outcomes, latest }
}

// UX pass, slice 3: the Plans page's sections. A plan with a step waiting on
// the person is in Needs you, always. One the person is writing to stays in
// the section it held (`held`, plan id -> section) for the visit. A plan is
// Stalled only when nothing about it is still in motion: no change for a week,
// no blocked step still asking or set aside, no response an agent has not
// picked up, no live session that wrote it and no working card showing it.
// Everything else is Moving. Order within a section is the input's.
export const STALL_MS = 7 * 24 * 60 * 60 * 1000
const PLAN_SECTIONS = ['needs', 'moving', 'stalled']

const asSet = (values) => (values instanceof Set ? values : new Set(values ?? []))

function stalled(plan, { nowMs, liveSessions, workingPlanIds }) {
  const updated = Date.parse(plan.updated_at ?? '')
  if (!Number.isFinite(updated) || !(nowMs - updated > STALL_MS)) return false
  for (const row of plan.rows ?? []) {
    // a blocked step not yet answered still asks, or waits where the person set it aside
    if (row.status === 'blocked' && !humanActedOnRow(row)) return false
    // a note, a choice or "I've done my part" an agent has not picked up yet
    if (humanActedOnRow(row) && !rowPickup(row).pickedUp) return false
  }
  if (plan.session && liveSessions.has(plan.session)) return false
  return !workingPlanIds.has(plan.id)
}

export function planSections(plans, { nowMs, liveSessions, workingPlanIds, held } = {}) {
  const opts = { nowMs, liveSessions: asSet(liveSessions), workingPlanIds: asSet(workingPlanIds) }
  const out = { needs: [], moving: [], stalled: [] }
  for (const plan of plans ?? []) {
    const asks = (plan.rows ?? []).some((row) => isBlockedRowAttention(row, nowMs))
    const hold = held?.get(plan.id)
    const section = asks ? 'needs' : PLAN_SECTIONS.includes(hold) ? hold : stalled(plan, opts) ? 'stalled' : 'moving'
    out[section].push(plan)
  }
  return out
}

// Which form a plan is drawn in. A plan has two states for the person: expanded (the
// person opened it: the full plan) and collapsed (anything else). A collapsed plan is brief
// when it waits on the person or holds a step they have in hand (only those steps show),
// otherwise closed (the summary alone). So collapsing never hides an ask.
export function planForm({ choice, section, kept }) {
  if (choice === true) return 'full'
  return section === 'needs' || kept ? 'brief' : 'closed'
}
