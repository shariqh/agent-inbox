import { buildRelay } from './relay.js'
import { activitySynopsis, lastActivityAt, liveSummary } from './livebar.js'

const asSet = (values) => values instanceof Set ? values : new Set(values ?? [])

function validProject(entity, closed) {
  return entity?.project && !closed.has(entity.project)
}

function sessionModel(activity) {
  const synopsis = activitySynopsis(activity)
  return {
    ...activity,
    synopsis: synopsis.text,
    historical: synopsis.historical,
    lastActiveAt: lastActivityAt(activity),
  }
}

export function buildDashboard({
  items,
  boards,
  archived,
  activity,
  nowMs,
  liveSessionIds,
  closedProjects = [],
}) {
  const closed = asSet(closedProjects)
  const visibleItems = (items ?? []).filter((item) => validProject(item, closed))
  const visibleBoards = (boards ?? []).filter((board) => validProject(board, closed))
  const visibleActivity = (activity ?? []).filter((row) => validProject(row, closed))
  const relay = buildRelay(items, boards, archived, nowMs, liveSessionIds, closedProjects)
  const live = liveSummary(visibleActivity, nowMs)
  const reportedChildren = visibleActivity.reduce((count, row) =>
    count + (!row.idle && Array.isArray(row.children) ? row.children.length : 0), 0)
  const workingLanes = live.count + reportedChildren
  const projects = new Set([
    ...visibleItems.map((item) => item.project),
    ...visibleBoards.map((board) => board.project),
    ...visibleActivity.map((row) => row.project),
  ])
  const sessions = visibleActivity
    .map(sessionModel)
    .sort((a, b) => Number(a.idle) - Number(b.idle)
      || Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt))

  return {
    signals: {
      agents: {
        working: workingLanes,
        quiet: live.idleCount,
        total: workingLanes + live.idleCount,
        reportedChildren,
      },
      waiting: relay.human.length,
      withAgents: relay.agent.length,
      plans: visibleBoards.length,
      outcomes: relay.outcomes.length,
      projects: projects.size,
    },
    ownership: {
      human: relay.human.length,
      agent: relay.agent.length,
      outcome: relay.outcomes.length,
    },
    waitingEntries: relay.human,
    agentEntries: relay.agent,
    recentOutcomes: relay.outcomes.slice(0, 5),
    sessions,
  }
}

export function buildActivitySeries(spans, { startMs, endMs, bucketCount }) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new RangeError('activity range must have finite ascending bounds')
  }
  if (!Number.isInteger(bucketCount) || bucketCount < 1) {
    throw new RangeError('activity bucketCount must be a positive integer')
  }

  const duration = endMs - startMs
  const bucketMs = duration / bucketCount
  const buckets = Array.from({ length: bucketCount }, (_, index) => {
    const bucketStart = startMs + index * bucketMs
    const bucketEnd = index === bucketCount - 1 ? endMs : startMs + (index + 1) * bucketMs
    return {
      startAt: new Date(bucketStart).toISOString(),
      endAt: new Date(bucketEnd).toISOString(),
      activeMs: 0,
      sessionIds: new Set(),
    }
  })

  let hasHistory = false
  let totalActiveMs = 0
  for (const span of spans ?? []) {
    const rawStart = Date.parse(span?.started_at)
    const rawEnd = span?.effective_ended_at ?? span?.ended_at
    const parsedEnd = rawEnd == null ? endMs : Date.parse(rawEnd)
    if (!Number.isFinite(rawStart) || !Number.isFinite(parsedEnd)) continue
    const spanStart = Math.max(startMs, rawStart)
    const spanEnd = Math.min(endMs, parsedEnd)
    if (spanEnd <= spanStart) continue
    hasHistory = true
    totalActiveMs += spanEnd - spanStart

    for (let index = 0; index < buckets.length; index += 1) {
      const bucket = buckets[index]
      const bucketStart = startMs + index * bucketMs
      const bucketEnd = index === bucketCount - 1 ? endMs : startMs + (index + 1) * bucketMs
      const overlap = Math.min(spanEnd, bucketEnd) - Math.max(spanStart, bucketStart)
      if (overlap <= 0) continue
      bucket.activeMs += overlap
      if (span.session) bucket.sessionIds.add(span.session)
    }
  }

  if (!hasHistory) return { hasHistory: false, totalActiveMs: 0, buckets: [] }
  return {
    hasHistory: true,
    totalActiveMs,
    buckets: buckets.map(({ sessionIds, ...bucket }) => ({
      ...bucket,
      sessions: sessionIds.size,
    })),
  }
}
