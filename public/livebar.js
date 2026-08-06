// The Live footer strip's summary line (spec §16). Pure: no DOM, no clock —
// the caller passes nowMs. Live is ambient presence, so this never produces a
// number that reads as a to-do.
import { freshnessTone } from './rowview.js'

/**
 * @param {Array<any>} activity rows from /api/activity
 * @param {number} nowMs
 * @returns {{count:number,idleCount:number,tone:string,label:string,sessions:Array<{session:string,project:string,agent:string,label:string,tone:string}>}}
 */
export function liveSummary(activity, nowMs) {
  const rows = Array.isArray(activity) ? activity.filter(Boolean) : []
  const active = rows.filter((a) => a && !a.idle)
  const sessions = active.map((a) => ({
    session: a.session,
    project: a.project,
    agent: a.agent,
    label: `${a.project}/${a.agent}`,
    tone: freshnessTone(nowMs - Date.parse(lastActivityAt(a))),
  }))
  // the strip takes the FRESHEST tone: one actively-working agent must not be
  // hidden behind a quieter one
  const rank = { fresh: 0, aging: 1, quiet: 2 }
  const tone = sessions.length
    ? sessions.reduce((best, s) => (rank[s.tone] < rank[best] ? s.tone : best), 'quiet')
    : 'idle'
  return {
    count: active.length,
    idleCount: rows.length - active.length,
    tone,
    label: active.length ? `${active.length} working` : 'no agents running',
    sessions,
  }
}

// ── issue #45: when a session last actually DID something ───────────────────
//
// `updated_at` is liveness, not activity: the MCP server bumps it every five
// minutes whether or not the agent has made a single call, so a dot keyed on it
// re-greens forever and "last activity 30s ago" only ever meant "this process
// has not crashed". `last_call_at` is written by real MCP calls alone. It is
// NULL until a session makes its first one (a just-registered presence row, or
// a row written by a server still running the old code), and `started_at`
// stands in — the same fallback src/store.ts uses to decide a claim is cold, so
// the dot and the decay can never disagree.
export function lastActivityAt(a) {
  return a?.last_call_at ?? a?.started_at ?? a?.updated_at
}

// Long-idle: not an error and not attention — just a terminal somebody left
// open. The Live surface keeps it (the session IS present, and its questions
// still classify as "waiting"), but it sorts last and reads as background.
export const DORMANT_MS = 8 * 60 * 60 * 1000

export function isDormant(a, nowMs) {
  return nowMs - Date.parse(lastActivityAt(a)) >= DORMANT_MS
}

// A stale claim must not stay "working", but throwing its words away leaves an
// idle session with no useful identity beyond project/agent. `last_doing` is a
// historical caption only: it never participates in state, freshness, or
// attention.
export function activitySynopsis(a) {
  const current = typeof a?.doing === 'string' ? a.doing.trim() : ''
  if (!a?.idle && current && current !== 'open') return { text: current, historical: false }
  const last = typeof a?.last_doing === 'string' ? a.last_doing.trim() : ''
  if (last && last !== 'open') return { text: last, historical: true }
  return { text: 'No activity summary yet', historical: false }
}
