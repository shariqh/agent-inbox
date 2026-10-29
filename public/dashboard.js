import { buildRelay, stamp } from './relay.js'
import { buildLanes } from './lanes.js'
import { knownOutcomes } from './closed-history.js'
import { laterEntries, sortRail } from './attention.js'
import { currentAskAt } from './rowview.js'
import { linkKey } from './source.js'

const asSet = (values) => values instanceof Set ? values : new Set(values ?? [])
// Issue #184: what the paged item snapshot omitted within this lens. Issue
// #299 adds `archived`: the outcomes archived plans carried in brief omit
// (omittedOutcomes in public/boards.js).
const NO_OLDER_HISTORY = { older: { items: 0, outcomes: 0, latest: null, projects: [] } }
const NO_OMITTED_OUTCOMES = { outcomes: 0, latest: null }
// Just landed's fixed row budget (#305), and so the most it needs to prove. It
// matches the archived brief's RECENT_OUTCOMES, so the default lens is proven
// without the complete archived plans.
const RECENT_OUTCOMES = 4
// Issue #303 (D3): the rail holds the top three asks; Inbox and Review queue hold the rest.
const RAIL_CARDS = 3

const entryKey = (entry) => entry.kind === 'item' ? `item:${entry.item.id}` : `row:${entry.row.id}`
const entryEntity = (entry) => entry.kind === 'item' ? entry.item : entry.row
const entryTitle = (entry) => entry.kind === 'item' ? entry.item.title : entry.row.label

// The PR an entry's branch opens (#30: repo, branch as `stream`, head repo), or
// null when it records no repository.
function prKey(entry) {
  const source = entry.kind === 'item' ? entry.item : entry.board
  return source?.repo && source.stream ? linkKey(source.repo, source.stream, source.head_repo || source.repo) : null
}

function validProject(entity, closed) {
  return entity?.project && !closed.has(entity.project)
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
  const railOrder = sortRail(relay.human, nowMs)
  // #304: lanes and the Now strip come from one model, so their numbers agree.
  const lanes = buildLanes({ activity: visibleActivity, boards: visibleBoards, asks: railOrder, nowMs })
  const projects = new Set([
    ...visibleItems.map((item) => item.project),
    ...visibleBoards.map((board) => board.project),
    ...visibleActivity.map((row) => row.project),
    ...history.older.projects,
  ])
  const later = laterEntries(visibleItems, visibleBoards, nowMs)
  // Just landed (#305) never repeats an open ask's PR: that PR has not landed.
  const askPrs = new Set([...relay.human, ...later].map(prKey).filter(Boolean))
  const landed = (entries) => entries.filter((entry) => !askPrs.has(prKey(entry)))
  // Omitted outcomes still count; a recent one is listed only once nothing
  // omitted could outrank it: older closed history (#184), archived plans (#299).
  const archivedOlder = history.archived ?? NO_OMITTED_OUTCOMES
  const omitted = [history.older, archivedOlder].filter((source) => source.outcomes > 0)
  const outcomes = relay.outcomes.length + omitted.reduce((total, source) => total + source.outcomes, 0)
  const listable = outcomes - (relay.outcomes.length - landed(relay.outcomes).length)
  const listed = Math.min(RECENT_OUTCOMES, listable)
  const latest = omitted.reduce((newest, source) => (newest === null || source.latest > newest ? source.latest : newest), null)
  const recentOutcomes = landed(omitted.length ? knownOutcomes(relay.outcomes, latest) : relay.outcomes).slice(0, RECENT_OUTCOMES)
  // Which omitted source still keeps the list from being proven: each is read
  // on its own (#184's older history, #299's archived plans).
  const keepsUnproven = (source) => source.outcomes > 0 && landed(knownOutcomes(relay.outcomes, source.latest)).length < listed
  // The ribbon's markers (#305): ◆ every question raised and every ask still
  // open (an open one is in the attention set or Later), ● every outcome.
  const open = new Set([...relay.human, ...later].map(entryKey))
  const askMark = (entry) => ({
    key: entryKey(entry), project: entryEntity(entry).project ?? entry.board?.project,
    at: Date.parse(currentAskAt(entry) ?? ''), open: open.has(entryKey(entry)), title: entryTitle(entry),
  })
  const questions = visibleItems.filter((item) => item.kind === 'question').map((item) => ({ kind: 'item', item }))
  const openRows = [...relay.human, ...later].filter((entry) => entry.kind === 'row')

  return {
    signals: {
      waiting: relay.human.length,
      withAgents: relay.agent.length,
      plans: visibleBoards.length,
      outcomes,
      projects: projects.size,
    },
    // Issue #303: the Needs you rail, from the one attention set (relay.human is
    // attentionEntries) in the rail's order; deferred asks count, never show.
    rail: railModel(railOrder, later.length),
    waitingEntries: relay.human,
    agentEntries: relay.agent,
    recentOutcomes,
    recentOutcomesComplete: recentOutcomes.length === listed,
    recentOutcomesWait: { history: keepsUnproven(history.older), archived: keepsUnproven(archivedOlder) },
    marks: {
      asks: [...questions, ...openRows].map(askMark),
      outcomes: relay.outcomes.map((entry) => ({
        key: entryKey(entry), project: entry.item?.project ?? entry.board?.project,
        at: stamp(entryEntity(entry)), title: entryTitle(entry),
      })),
      // Items created after the page's boundary are all on the page (#184);
      // outcomes after the newest omitted one's stamp are all loaded (#299).
      asksAfter: history.older.items > 0 ? history.before ?? null : null,
      outcomesAfter: latest,
    },
    lanes: lanes.lanes,
    idleConnections: lanes.idle,
    now: lanes.now,
  }
}

function railModel(ordered, later) {
  const cards = ordered.slice(0, RAIL_CARDS)
  return { cards, more: ordered.length - cards.length, later }
}
