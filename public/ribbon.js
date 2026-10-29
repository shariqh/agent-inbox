// The Today ribbon and "Since you last looked" (#305, Dashboard 2.0 phase 3).
// Pure: no DOM, no fetch, the clock passed in. One thin swimlane per project
// over the selected range: work spans from /api/activity/history, a static
// striped tail for work happening now, ◆ where an agent asked you and ● where
// an outcome landed. Every input is data the poll already reads.

// §10 DOM budget: at most 12 swimlanes and 200 bars; markers are bounded too.
const RIBBON_LANES = 12
const RIBBON_BARS = 200
const RIBBON_MARKS = 120
// "Since you last looked" shows only after a gap this long between visits.
const SINCE_GAP_MS = 30 * 60_000

const pct = (ms, startMs, endMs) => Math.round(((ms - startMs) / (endMs - startMs)) * 1000) / 10

// A span is live while it has no end of either kind: the server caps a span
// that went cold (#185), so an open end here means the claim is still warm.
const isLive = (span) => span?.ended_at == null && span?.effective_ended_at == null
const spanEnd = (span) => Date.parse(span?.effective_ended_at ?? span?.ended_at ?? '')

export function buildRibbon({ spans, asks = [], outcomes = [], startMs, endMs, marksAfter = null }) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new RangeError('ribbon range must have finite ascending bounds')
  }
  const byProject = new Map()
  const laneFor = (project) => {
    let lane = byProject.get(project)
    if (!lane) byProject.set(project, lane = { project, segments: [], marks: [], workMs: 0, live: false, lastAt: -Infinity })
    return lane
  }
  let totalMs = 0
  for (const span of spans ?? []) {
    if (!span?.project) continue
    const rawStart = Date.parse(span.started_at)
    const live = isLive(span)
    const rawEnd = live ? endMs : spanEnd(span)
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) continue
    const start = Math.max(startMs, rawStart)
    const end = Math.min(endMs, rawEnd)
    if (end <= start) continue
    const lane = laneFor(span.project)
    lane.segments.push({ start, end, liveFrom: live ? start : null })
    lane.workMs += end - start
    lane.live ||= live
    lane.lastAt = Math.max(lane.lastAt, end)
    totalMs += end - start
  }
  // Markers older than `marksAfter` may sit in history the page omits (#184,
  // #299), so none is drawn there rather than an incomplete few.
  const markFloor = Math.max(startMs, Number.isFinite(Date.parse(marksAfter)) ? Date.parse(marksAfter) : -Infinity)
  const marks = [
    ...asks.map((mark) => ({ ...mark, kind: 'ask' })),
    ...outcomes.map((mark) => ({ ...mark, kind: 'outcome' })),
  ].filter((mark) => mark.project && Number.isFinite(mark.at) && mark.at > markFloor && mark.at <= endMs)
    .sort((a, b) => b.at - a.at || String(a.key).localeCompare(String(b.key)))
  for (const mark of marks) {
    const lane = laneFor(mark.project)
    lane.marks.push(mark)
    lane.lastAt = Math.max(lane.lastAt, mark.at)
  }
  // The most recently active projects get lanes, drawn by name so a lane keeps
  // its place from one poll to the next.
  const ranked = [...byProject.values()].sort((a, b) => b.lastAt - a.lastAt || a.project.localeCompare(b.project))
  const kept = ranked.slice(0, RIBBON_LANES).sort((a, b) => a.project.localeCompare(b.project))
  for (const lane of kept) lane.segments.sort((a, b) => a.start - b.start)
  const merged = mergeToBudget(kept, endMs - startMs)
  const keptMarks = new Set(kept.flatMap((lane) => lane.marks).sort((a, b) => b.at - a.at).slice(0, RIBBON_MARKS))
  return {
    totalMs,
    startMs,
    endMs,
    marksFrom: markFloor > startMs ? pct(markFloor, startMs, endMs) : null,
    more: ranked.length - kept.length,
    lanes: kept.map((lane, index) => ({
      project: lane.project,
      workMs: lane.workMs,
      live: lane.live,
      asks: lane.marks.filter((mark) => mark.kind === 'ask').length,
      openAsks: lane.marks.filter((mark) => mark.kind === 'ask' && mark.open).length,
      outcomes: lane.marks.filter((mark) => mark.kind === 'outcome').length,
      bars: merged[index].map((segment) => ({
        left: pct(segment.start, startMs, endMs),
        width: Math.max(0.2, pct(segment.end, startMs, endMs) - pct(segment.start, startMs, endMs)),
        // Where the striped "now" tail starts, as a share of the bar.
        liveFrom: segment.liveFrom == null ? null
          : Math.round(((segment.liveFrom - segment.start) / (segment.end - segment.start || 1)) * 1000) / 10,
        from: new Date(segment.start).toISOString(),
        to: new Date(segment.end).toISOString(),
      })),
      marks: lane.marks.filter((mark) => keptMarks.has(mark)).map((mark) => ({
        kind: mark.kind,
        key: mark.key,
        left: pct(mark.at, startMs, endMs),
        open: Boolean(mark.open),
        title: mark.title ?? '',
        at: new Date(mark.at).toISOString(),
      })),
    })),
  }
}

// Merge touching spans per lane, then widen the merge gap until every lane fits
// the shared bar budget. A merged bar keeps the earliest live start it holds.
function mergeToBudget(lanes, rangeMs) {
  let gap = 0
  for (;;) {
    const merged = lanes.map((lane) => {
      const out = []
      for (const segment of lane.segments) {
        const last = out.at(-1)
        if (last && segment.start - last.end <= gap) {
          last.end = Math.max(last.end, segment.end)
          if (segment.liveFrom != null && (last.liveFrom == null || segment.liveFrom < last.liveFrom)) last.liveFrom = segment.liveFrom
        } else {
          out.push({ ...segment })
        }
      }
      return out
    })
    if (merged.reduce((total, bars) => total + bars.length, 0) <= RIBBON_BARS || gap >= rangeMs) return merged
    gap = gap ? gap * 2 : rangeMs / 400
  }
}

// "3 outcomes landed, 2 new asks, 1 session finished" between the previous
// visit and this one. A count the page cannot prove (#184, #299) reads "3+";
// one that might be wholly in omitted history is left out rather than "0".
export function sinceLastLooked({ sinceMs, untilMs, asks = [], outcomes = [], asksAfter = null, outcomesAfter = null, spans = null }) {
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || untilMs - sinceMs < SINCE_GAP_MS) return null
  const within = (at) => at > sinceMs && at <= untilMs
  const partial = (bound) => Number.isFinite(Date.parse(bound)) && Date.parse(bound) > sinceMs
  const count = (n, plus, one, many) => `${n}${plus ? '+' : ''} ${n === 1 && !plus ? one : many}`
  const parts = []
  const landed = outcomes.filter((mark) => within(mark.at)).length
  if (landed) parts.push(count(landed, partial(outcomesAfter), 'outcome landed', 'outcomes landed'))
  const asked = asks.filter((mark) => within(mark.at)).length
  if (asked) parts.push(count(asked, partial(asksAfter), 'new ask', 'new asks'))
  if (spans) {
    const sessions = new Map()
    for (const span of spans) {
      const prev = sessions.get(span.session) ?? { live: false, end: -Infinity }
      if (isLive(span)) prev.live = true
      else if (Number.isFinite(spanEnd(span))) prev.end = Math.max(prev.end, spanEnd(span))
      sessions.set(span.session, prev)
    }
    const finished = [...sessions.values()].filter((session) => !session.live && within(session.end)).length
    if (finished) parts.push(count(finished, false, 'session finished', 'sessions finished'))
  }
  return parts.length ? parts.join(', ') : null
}
