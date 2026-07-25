// The Live footer strip's summary line (spec §16). Pure: no DOM, no clock —
// the caller passes nowMs. Live is ambient presence, so this never produces a
// number that reads as a to-do.
import { freshnessTone } from './rowview.js'

/**
 * @param {Array<any>} activity rows from /api/activity
 * @param {number} nowMs
 * @returns {{count:number,tone:string,label:string,sessions:Array<{session:string,label:string,tone:string}>}}
 */
export function liveSummary(activity, nowMs) {
  const rows = Array.isArray(activity) ? activity : []
  const active = rows.filter((a) => a && !a.idle)
  const sessions = active.map((a) => ({
    session: a.session,
    label: `${a.project}/${a.agent}`,
    tone: freshnessTone(nowMs - Date.parse(a.updated_at)),
  }))
  // the strip takes the FRESHEST tone: one actively-working agent must not be
  // hidden behind a quieter one
  const rank = { fresh: 0, aging: 1, quiet: 2 }
  const tone = sessions.length
    ? sessions.reduce((best, s) => (rank[s.tone] < rank[best] ? s.tone : best), 'quiet')
    : 'idle'
  return {
    count: active.length,
    tone,
    label: active.length ? `${active.length} working` : 'no agents running',
    sessions,
  }
}
