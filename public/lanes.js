// Live lanes and the Now strip (#304, Dashboard 2.0 phase 2). Pure: no DOM, the
// clock injected as `nowMs`. One lane per WORKING session, from /api/activity,
// /api/boards and the attention set the caller already built; no new reads.
//
// Working is the claim and `last_call_at` alone (#45): a row whose claim is not
// idle and whose last real call (or, before its first, its start) is within the
// 30-minute claim window. `updated_at` is the liveness heartbeat and is never
// read here, so a session that only heartbeats folds into the idle count.
import { currentAskAt } from './rowview.js'
import { isBlockedRowAttention } from './attention.js'

const CLAIM_COLD_MS = 30 * 60_000 // src/store.ts CLAIM_COLD_MS
// A working lane with no call for this long says "quiet 12m" until its claim
// decays. The proposal leaves N open; 5 minutes is where freshnessTone
// (rowview.js AGING_MS) already calls a session quiet.
export const QUIET_MS = 5 * 60_000
// §10: at most 12 infinite animations, and the Dashboard draws at most 12 lanes.
export const MAX_LOOPS = 12
export const MAX_LANES = 12

const callAt = (row) => Date.parse(row?.last_call_at ?? row?.started_at ?? '')

export function isWorking(row, nowMs) {
  if (!row || row.idle) return false
  const at = callAt(row)
  return Number.isFinite(at) && nowMs - at < CLAIM_COLD_MS
}

const doingText = (value) => typeof value === 'string' && value.trim() && value.trim() !== 'open' ? value.trim() : ''

// D4: the session's plan is the most recently updated active plan with the same
// project, branch (`stream`) and agent. Phase 4 may stamp it instead.
export function linkedPlan(row, boards) {
  let best = null
  for (const board of boards ?? []) {
    if (board.project !== row.project || board.stream !== row.stream || board.agent !== row.agent) continue
    if (!best || String(board.updated_at ?? '') > String(best.updated_at ?? '')) best = board
  }
  return best
}

// The plan's bar: done, in progress, waiting on you (the attention predicate's
// own rows) and to do, over the same `countable` the Plans tab shows.
export function planBar(board, nowMs) {
  const progress = board.progress ?? { done: 0, partial: 0, countable: 0 }
  const waiting = (board.rows ?? []).filter((row) => isBlockedRowAttention(row, nowMs)).length
  const done = progress.done ?? 0
  const partial = progress.partial ?? 0
  const countable = progress.countable ?? 0
  return {
    id: board.id,
    title: board.title,
    done,
    countable,
    segments: { done, partial, waiting, todo: Math.max(0, countable - done - partial - waiting) },
  }
}

const askMs = (entry) => {
  const at = Date.parse(currentAskAt(entry) ?? '')
  return Number.isFinite(at) ? at : Infinity
}

/**
 * @param {{activity: any[], boards: any[], asks: any[], nowMs: number}} input
 *   `asks` is the attention set in rail order (sortRail(attentionEntries(...))).
 */
export function buildLanes({ activity, boards, asks, nowMs }) {
  const lanes = []
  let idle = 0
  for (const row of activity ?? []) {
    if (!isWorking(row, nowMs)) { idle += 1; continue }
    const at = callAt(row)
    const sinceMs = Math.max(0, nowMs - at)
    const board = linkedPlan(row, boards)
    const laneAsks = (asks ?? []).filter((entry) => entry.kind === 'item'
      ? entry.item.session === row.session
      : Boolean(board) && entry.board.id === board.id)
    // The lane is blocked on you while any of its asks waits: "waiting on you 2h".
    const oldest = laneAsks.reduce((best, entry) => (best && askMs(best) <= askMs(entry) ? best : entry), null)
    lanes.push({
      session: row.session,
      project: row.project,
      branch: row.stream ?? '',
      agent: row.agent,
      doing: doingText(row.doing) || 'No task reported yet',
      detail: typeof row.detail === 'string' ? row.detail : '',
      lastCallAt: new Date(at).toISOString(),
      sinceMs,
      quiet: sinceMs >= QUIET_MS,
      children: (Array.isArray(row.children) ? row.children : [])
        .map((child) => ({ name: String(child?.name ?? ''), doing: doingText(child?.doing) })),
      plan: board ? planBar(board, nowMs) : null,
      asks: laneAsks,
      waiting: oldest ? { entry: oldest, ms: Number.isFinite(askMs(oldest)) ? Math.max(0, nowMs - askMs(oldest)) : 0 } : null,
    })
  }
  lanes.sort((a, b) => a.sinceMs - b.sinceMs || (a.session < b.session ? -1 : 1))
  // The Now strip's plan steps are the lanes' bars, each plan counted once.
  const plans = new Map(lanes.filter((lane) => lane.plan).map((lane) => [lane.plan.id, lane.plan]))
  let oldestAsk = Infinity
  for (const entry of asks ?? []) oldestAsk = Math.min(oldestAsk, askMs(entry))
  return {
    lanes,
    idle,
    now: {
      working: lanes.length,
      subagents: lanes.reduce((count, lane) => count + lane.children.length, 0),
      waiting: (asks ?? []).length,
      oldestWaitingMs: Number.isFinite(oldestAsk) ? Math.max(0, nowMs - oldestAsk) : null,
      plans: [...plans.values()].reduce((sum, plan) =>
        ({ done: sum.done + plan.done, countable: sum.countable + plan.countable }), { done: 0, countable: 0 }),
    },
  }
}

// §10 rule 5: lane order is pinned between forced paints. Sessions still
// working keep their place, new ones append in model order, and a forced paint
// (`previous` empty) takes the model's order: newest call first.
export function pinLaneOrder(previous, lanes) {
  const present = new Set(lanes.map((lane) => lane.session))
  const kept = (previous ?? []).filter((session) => present.has(session))
  const known = new Set(kept)
  return [...kept, ...lanes.map((lane) => lane.session).filter((session) => !known.has(session))]
}

// Which drawn lanes animate, within MAX_LOOPS: the top-edge sweep only on the
// lane with the newest call, then lane pulses in drawn order, then subagent
// pulses. A quiet lane's claim is still live, so it still pulses.
export function laneMotion(drawn) {
  let newest = null
  for (const lane of drawn) if (!newest || lane.sinceMs < newest.sinceMs) newest = lane
  let budget = MAX_LOOPS - (newest ? 1 : 0)
  const pulse = new Set()
  const childPulse = new Set()
  for (const lane of drawn) if (budget > 0) { pulse.add(lane.session); budget -= 1 }
  for (const lane of drawn) {
    lane.children.forEach((_, index) => {
      if (budget > 0) { childPulse.add(`${lane.session}\u0000${index}`); budget -= 1 }
    })
  }
  return { sweep: newest?.session ?? null, pulse, childPulse }
}
