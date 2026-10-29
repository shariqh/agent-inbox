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
// The Dashboard draws at most 12 lanes (§10 DOM budget).
export const MAX_LANES = 12

const callAt = (row) => Date.parse(row?.last_call_at ?? row?.started_at ?? '')

export function isWorking(row, nowMs) {
  if (!row || row.idle) return false
  const at = callAt(row)
  return Number.isFinite(at) && nowMs - at < CLAIM_COLD_MS
}

const doingText = (value) => typeof value === 'string' && value.trim() && value.trim() !== 'open' ? value.trim() : ''

// #306: a plan stamped with this session (`boards.session`, the MCP session
// that last wrote it) is its plan, the most recently updated one when several
// are. Otherwise D4's join: the most recently updated active plan with the same
// project, branch (`stream`) and agent, leaving out any plan stamped with
// another session that is still present, which is that session's own plan. A
// stamp naming a session that has gone (or none, from an older server) joins.
export function linkedPlan(row, boards, present = new Set()) {
  let stamped = null
  let joined = null
  const newer = (board, best) => !best || String(board.updated_at ?? '') > String(best.updated_at ?? '')
  for (const board of boards ?? []) {
    if (board.session && board.session === row.session) {
      if (newer(board, stamped)) stamped = board
      continue
    }
    if (board.session && present.has(board.session)) continue
    if (board.project !== row.project || board.stream !== row.stream || board.agent !== row.agent) continue
    if (newer(board, joined)) joined = board
  }
  return stamped ?? joined
}

// #306: the session's MCP calls over the last 30 minutes, oldest first, one
// count a minute ending at the current one. /api/activity carries the stored
// buckets (`calls`, the last counting minute `calls_at`); the clock rolls them
// here, so the bytes change only with a call. A `calls_at` ahead of the clock
// counts as now, as the store does.
export const TRACE_MINUTES = 30

export function callTrace(row, nowMs) {
  const trace = new Array(TRACE_MINUTES).fill(0)
  const counts = Array.isArray(row?.calls) ? row.calls : []
  if (!Number.isInteger(row?.calls_at) || !counts.length) return trace
  const shift = Math.max(0, Math.floor(nowMs / 60_000) - row.calls_at)
  counts.forEach((count, index) => {
    const at = TRACE_MINUTES - 1 - shift - (counts.length - 1 - index)
    if (at >= 0 && at < TRACE_MINUTES && Number.isFinite(count) && count > 0) trace[at] = count
  })
  return trace
}

// The trace drawn as one SVG path of bars on a 60 × 12 box, scaled to its
// busiest minute: static, so it redraws by attribute and never animates.
export function tracePath(trace) {
  const peak = Math.max(0, ...trace)
  if (!peak) return ''
  return trace.map((count, index) => {
    if (!count) return ''
    const height = Math.max(1, Math.round((count / peak) * 120) / 10)
    return `M${index * 2} 12v-${height}h1.5v${height}z`
  }).join('')
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
  const present = new Set((activity ?? []).map((row) => row?.session).filter(Boolean))
  for (const row of activity ?? []) {
    if (!isWorking(row, nowMs)) { idle += 1; continue }
    const at = callAt(row)
    const sinceMs = Math.max(0, nowMs - at)
    const board = linkedPlan(row, boards, present)
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
      trace: callTrace(row, nowMs),
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

// Lanes run no infinite animation (#304: a loop cost ~5.6 pp of renderer and
// ~34 pp of GPU CPU). Motion is one-shot per real event: a lane pulses once when
// its `last_call_at` moves forward, and the sweep runs once on the lane whose
// call is the newest of those. `previous` maps session → the last call already
// seen; a session it has not seen (first paint, a lane that just appeared) never
// pulses, and an unchanged call never does either.
export function calledLanes(previous, drawn) {
  const pulse = new Set()
  let sweep = null
  for (const lane of drawn) {
    const seen = previous.get(lane.session)
    if (seen === undefined || !(Date.parse(lane.lastCallAt) > Date.parse(seen))) continue
    pulse.add(lane.session)
    if (!sweep || lane.sinceMs < sweep.sinceMs) sweep = lane
  }
  return { pulse, sweep: sweep?.session ?? null }
}
