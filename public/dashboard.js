import { buildRelay } from './relay.js'
import { activitySynopsis, lastActivityAt, liveSummary } from './livebar.js'
import { knownOutcomes } from './closed-history.js'
import { laterEntries, sortRail } from './attention.js'

const asSet = (values) => values instanceof Set ? values : new Set(values ?? [])
// Issue #184: what the paged item snapshot omitted within this lens. Issue
// #299 adds `archived`: the outcomes archived plans carried in brief omit
// (omittedOutcomes in public/boards.js).
const NO_OLDER_HISTORY = { older: { items: 0, outcomes: 0, latest: null, projects: [] } }
const NO_OMITTED_OUTCOMES = { outcomes: 0, latest: null }
// The recent outcomes the Dashboard lists, and so the most it needs to prove.
const RECENT_OUTCOMES = 4
// Issue #303 (D3): the rail holds the top three asks; Inbox and Review queue hold the rest.
const RAIL_CARDS = 3

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
  history = NO_OLDER_HISTORY,
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
    ...history.older.projects,
  ])
  const sessions = visibleActivity
    .map(sessionModel)
    .sort((a, b) => Number(a.idle) - Number(b.idle)
      || Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt))
  // Omitted outcomes still count; a recent one is listed only once nothing
  // omitted could outrank it: older closed history (#184), archived plans (#299).
  const archivedOlder = history.archived ?? NO_OMITTED_OUTCOMES
  const omitted = [history.older, archivedOlder].filter((source) => source.outcomes > 0)
  const outcomes = relay.outcomes.length + omitted.reduce((total, source) => total + source.outcomes, 0)
  const listed = Math.min(RECENT_OUTCOMES, outcomes)
  const latest = omitted.reduce((newest, source) => (newest === null || source.latest > newest ? source.latest : newest), null)
  const recentOutcomes = (omitted.length ? knownOutcomes(relay.outcomes, latest) : relay.outcomes).slice(0, RECENT_OUTCOMES)
  // Which omitted source still keeps the list from being proven: each is read
  // on its own (#184's older history, #299's archived plans).
  const keepsUnproven = (source) => source.outcomes > 0 && knownOutcomes(relay.outcomes, source.latest).length < listed

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
      outcomes,
      projects: projects.size,
    },
    // Issue #303: the Needs you rail, from the one attention set (relay.human is
    // attentionEntries) in the rail's order; deferred asks count, never show.
    rail: railModel(sortRail(relay.human, nowMs), laterEntries(visibleItems, visibleBoards, nowMs).length),
    waitingEntries: relay.human,
    agentEntries: relay.agent,
    recentOutcomes,
    recentOutcomesComplete: recentOutcomes.length === listed,
    recentOutcomesWait: { history: keepsUnproven(history.older), archived: keepsUnproven(archivedOlder) },
    sessions,
  }
}

function railModel(ordered, later) {
  const cards = ordered.slice(0, RAIL_CARDS)
  return { cards, more: ordered.length - cards.length, later }
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
