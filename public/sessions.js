// The Agents home's session cards (#454, design
// docs/superpowers/specs/2026-11-04-agents-home-design.md §2). Pure: no DOM,
// the clock injected as `nowMs`. One card per session, built from what the
// frame already read: /api/activity, the attention entries, the plans and
// (with the app's switch on only) /api/launches. Nothing is fed back: the
// asks are READ from the attention set, never counted anew.
//
// A launch is one card, joined with its live driven presence rows, whatever
// its state, so a parked or ended launch keeps its card. Every other presence
// row (a terminal Claude Code or Copilot session, another driver's session) is
// a card of its own.
import { callTrace, isWorking, linkedPlan, planBar } from './lanes.js'
import { activitySynopsis, isDormant } from './livebar.js'
import { launchSessions, launchStatus } from './launches.js'
import { isReservedProject } from './reserved-projects.js'
import { relMs, rowPickup } from './rowview.js'
import { sortRail } from './attention.js'
import { deliveryState } from './messages.js'

// The drawer's rule (#412 step 5): the newest five ended launches, and every
// one whose worktree is still on disk (#432); the rest are "Earlier sessions".
const ENDED_SHOWN = 5

const STATES = Object.freeze({
  ask: { label: 'Needs you', rank: 0 },
  failed: { label: 'Didn’t start', rank: 1 },
  lost: { label: 'Not responding', rank: 1 },
  starting: { label: 'Starting…', rank: 2 },
  stopping: { label: 'Stopping…', rank: 2 },
  working: { label: 'Working', rank: 3 },
  idle: { label: 'Idle', rank: 4 },
  // #466: an idle card with no evidence either way. A terminal session reports
  // only through Agent Inbox calls, so no call says nothing about whether it is
  // busy with other tools; only a driver that reports no running turn (no
  // `driven_turn`) knows its session idles.
  quiet: { label: 'Quiet', rank: 4 },
  parked: { label: 'Parked', rank: 5 },
  terminal: { label: 'In Terminal', rank: 6 },
  ended: { label: 'Ended', rank: 7 },
  dormant: { label: 'Dormant', rank: 8 },
})

// The state filters in the card's header, over the cards in its main list.
export const FILTERS = Object.freeze([
  // `idle` holds Quiet and Idle cards alike (#466): a known-idle card is quiet too
  ['all', 'All'], ['ask', 'Needs you'], ['working', 'Working'], ['idle', 'Quiet'], ['parked', 'Parked'],
])

const HOSTS = { copilot: 'Copilot', 'claude-code': 'Claude Code' }
const hostLabel = (agent) => HOSTS[agent] ?? agent

const time = (iso) => {
  const at = Date.parse(iso ?? '')
  return Number.isFinite(at) ? at : null
}
const ago = (nowMs, at) => (at === null ? null : Math.max(0, nowMs - at))
const since = (ms) => (relMs(ms) === 'moments' ? '<1m' : relMs(ms))
const NO_TASK = 'No task reported yet'

// #466: what a quiet card can truthfully say about time: when it last called
// Agent Inbox, never that it has been idle that long.
function quietRecency(row, nowMs) {
  const call = time(row.last_call_at)
  if (call !== null) {
    const ms = ago(nowMs, call)
    return relMs(ms) === 'moments' ? 'last Agent Inbox call just now' : `no Agent Inbox call for ${relMs(ms)}`
  }
  const start = ago(nowMs, time(row.started_at))
  return start === null ? 'no Agent Inbox call yet' : `connected ${since(start)} · no Agent Inbox call yet`
}

// The kind of an ask: an app session's approval (#412), filed in `@sessions`
// with the tool line as its title, or anything else asking the human.
const isApproval = (entry) => entry.kind === 'item' && isReservedProject(entry.item?.project)

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const isCount = (n) => Number.isSafeInteger(n) && n >= 0

/** "worktree · 2 ahead · 5 files · 1 uncommitted", or null for a launch in its folder. */
function worktreeShort(launch) {
  if (typeof launch?.worktree_path !== 'string' || !launch.worktree_path) return null
  if (launch.worktree_removed_at) return 'worktree removed'
  const s = launch.worktree_summary
  if (!s || typeof s !== 'object' || ![s.ahead, s.behind, s.files, s.dirty].every(isCount)) return 'worktree'
  return ['worktree', `${s.ahead} ahead`, ...(s.behind ? [`${s.behind} behind`] : []), plural(s.files, 'file'), `${s.dirty} uncommitted`].join(' · ')
}

// The newest live session of a launch: the one a Message goes to.
function newest(rows) {
  let best = null
  for (const row of rows) if (!best || String(row.started_at ?? '') >= String(best.started_at ?? '')) best = row
  return best
}

// What the card says about time, from its own state.
function recency(state, { row, launch, nowMs, quiet = false }) {
  if (row && quiet) return quietRecency(row, nowMs)
  if (state === 'working') {
    const call = time(row?.last_call_at)
    if (call === null) return 'no call yet'
    const ms = ago(nowMs, call)
    return relMs(ms) === 'moments' ? 'last call just now' : `last call ${relMs(ms)} ago`
  }
  if (row && (state === 'idle' || state === 'dormant')) {
    const ms = ago(nowMs, time(row.last_call_at) ?? time(row.started_at))
    return ms === null ? '' : `idle ${since(ms)}`
  }
  if (!launch) return ''
  const at = (iso) => ago(nowMs, time(iso))
  const say = (word, ms) => (ms === null ? word : `${word} ${since(ms)}`)
  if (state === 'parked') return launch.status === 'parked' ? say('parked', at(launch.parked_at)) : say('stopped', at(launch.ended_at))
  if (state === 'starting') return say('started', at(launch.created_at))
  if (state === 'stopping') return say('stopping', at(launch.stop_requested_at))
  if (state === 'lost') return say('no word for', at(launch.updated_at))
  if (state === 'idle') return say('idle', at(launch.updated_at))
  return say('ended', at(launch.ended_at ?? launch.updated_at))
}

// A launch's own state, before any ask: launchStatus decides, and a running
// one is working or idle by its presence row, as a terminal session is.
function launchState(status, launch, row, nowMs) {
  switch (status.state) {
    case 'running': return row && isWorking(row, nowMs) ? 'working' : 'idle'
    case 'ended': return status.actions.includes('resume') ? 'parked' : 'ended'
    case 'handed_off': return 'terminal'
    default: return status.state
  }
}

/**
 * Every session as one card. Pure: the clock is `nowMs`.
 * @param {{activity: any[], launches?: any[] | null, boards?: any[], attention?: any[], closed?: Iterable<string>, nowMs: number}} input
 *   `activity` is the lens's /api/activity rows; `launches` is /api/launches, or null when the
 *   app's switch is off (§9: then no launch card exists); `boards` are the plans the lanes read;
 *   `attention` is the frame's attention entries.
 */
export function sessionCards({ activity, launches = null, boards = [], attention = [], answered = [], items = [], closed = [], nowMs }) {
  const shut = new Set(closed)
  const rows = (activity ?? []).filter((row) => row?.project)
  const working = new Set(rows.filter((row) => isWorking(row, nowMs)).map((row) => row.session))
  const asks = sortRail(attention ?? [], nowMs)
  const all = launches ?? []
  const endedLaunches = all.filter((launch) => launch.status === 'ended')
  const recent = new Set(endedLaunches.slice(0, ENDED_SHOWN))
  const kept = (launch) => recent.has(launch) || Boolean(launch.worktree_path && !launch.worktree_removed_at)
  const claimed = new Set()
  const cards = []

  // Each card first, from its own session or launch; its asks are attributed after, once every card exists.
  const finish = (card, row) => {
    if (card.base === 'working') {
      card.children = (Array.isArray(row?.children) ? row.children : [])
        .map((child) => ({
          name: String(child?.name ?? ''),
          doing: typeof child?.doing === 'string' ? child.doing : '',
          // status()'s optional per-subagent state (#454: once shown only in the Live drawer)
          state: typeof child?.state === 'string' ? child.state : '',
        }))
      card.trace = callTrace(row, nowMs)
    }
    card.activeAt = Math.max(time(row?.last_call_at) ?? 0, time(row?.started_at) ?? 0, time(card.launch?.updated_at) ?? 0)
    cards.push(card)
  }

  for (const launch of all) {
    const live = launchSessions(launch, rows)
    for (const row of live) claimed.add(row.session)
    const row = newest(live)
    const status = launchStatus(launch, rows, nowMs)
    const base = launchState(status, launch, row, nowMs)
    const synopsis = row ? activitySynopsis(row) : null
    // #466: running with no live claim is Idle only while its driver reports no turn
    const quiet = base === 'idle' && Boolean(row?.driven_turn)
    const calls = Number.isSafeInteger(launch.tool_calls) && launch.tool_calls > 0 && launch.budget_tool_calls
      ? ` · ${launch.tool_calls} of ${launch.budget_tool_calls} tool calls` : ''
    finish({
      id: `launch:${launch.id}`,
      session: row?.session ?? null,
      sessions: [...new Set([...(Array.isArray(launch.sessions) ? launch.sessions : []), ...live.map((r) => r.session)])],
      row,
      launch,
      status,
      project: String(launch.project ?? row?.project ?? ''),
      branch: String(launch.branch || launch.stream || row?.stream || ''),
      agent: 'copilot',
      host: 'Copilot',
      origin: 'started here',
      base,
      text: synopsis && (base === 'working' || base === 'idle') ? synopsis.text : `${status.text}${base === 'starting' || base === 'stopping' ? '' : calls}`,
      claim: Boolean(synopsis && (base === 'working' || base === 'idle')),
      quiet,
      historical: synopsis && (base === 'working' || base === 'idle') ? synopsis.historical || base !== 'working' : base !== 'starting' && base !== 'stopping',
      recency: recency(base, { row, launch, nowMs, quiet }),
      lastCallAt: row?.last_call_at ?? null,
      worktree: worktreeShort(launch),
      plan: null, children: [], trace: null,
    }, row)
  }

  for (const row of rows) {
    if (claimed.has(row.session)) continue
    const base = isWorking(row, nowMs) ? 'working' : isDormant(row, nowMs) ? 'dormant' : 'idle'
    // a terminal row has only its calls; a driven row is known idle only while its driver reports no turn
    const quiet = base !== 'working' && !(row.driven === true && !row.driven_turn)
    const synopsis = activitySynopsis(row)
    const agent = typeof row.agent === 'string' && row.agent ? row.agent : 'unknown'
    finish({
      id: `session:${row.session}`,
      session: String(row.session ?? ''),
      sessions: [String(row.session ?? '')],
      row,
      launch: null,
      status: null,
      project: String(row.project),
      branch: typeof row.stream === 'string' ? row.stream : '',
      agent,
      host: hostLabel(agent),
      origin: row.driven === true ? 'driven' : 'terminal',
      base,
      text: synopsis.text,
      claim: true,
      quiet,
      historical: synopsis.historical || base !== 'working',
      recency: recency(base, { row, launch: null, nowMs, quiet }),
      lastCallAt: row.last_call_at ?? null,
      worktree: null,
      plan: null, children: [], trace: null,
    }, row)
  }
  const owners = attributeAsks(cards, { asks, boards, working, nowMs })
  // Step 3 (#454 amendment A.1): what no card owns gets an ask-only card, so
  // every attention entry is on exactly one card.
  for (const entry of owners.unowned) {
    const owner = entry.kind === 'item' ? entry.item : entry.board
    const session = typeof owner?.session === 'string' && owner.session ? owner.session : null
    const id = session ? `ask:session:${session}` : entry.kind === 'row' ? `ask:plan:${entry.board.id}` : `ask:item:${entry.item.id}`
    let card = owners.orphans.get(id)
    if (!card) {
      card = askOnlyCard(id, entry, session, { items, boards, nowMs })
      owners.orphans.set(id, card)
      cards.push(card)
    }
    card.asks.push(entry)
  }
  // this session's answers the agent has not picked up yet: shown in its panel, never counted
  for (const entry of answered ?? []) {
    if (entry.kind === 'item' ? entry.item?.reply_seen_at : rowPickup(entry.row ?? {}).pickedUp) continue
    const session = entry.kind === 'item' ? entry.item?.session : null
    const owner = entry.kind === 'item'
      ? owners.bySession.get(session) ?? owners.orphans.get(`ask:session:${session}`)
      : owners.planOwner.get(entry.board?.id) ?? owners.orphans.get(`ask:plan:${entry.board?.id}`)
        ?? owners.orphans.get(`ask:session:${entry.board?.session}`)
    owner?.answered.push(entry)
  }
  for (const card of cards) {
    card.approval = card.asks.length > 0 && isApproval(card.asks[0])
    card.state = card.asks.length ? 'ask' : card.base
    card.label = card.askOnly ? (card.askOnly === 'ended' ? 'Session ended' : 'No session')
      : STATES[card.state === 'idle' && card.quiet ? 'quiet' : card.state].label
    card.line = doingLine(card, nowMs)
    // an ask is never folded away: Needs you counts every one (A.1)
    if (card.state === 'ask') card.place = 'main'
    else if (shut.has(card.project)) card.place = 'closed'
    else if (card.state === 'dormant') card.place = 'dormant'
    else if (card.base === 'ended' || card.base === 'terminal' || card.base === 'failed') card.place = kept(card.launch) ? 'ended' : 'earlier'
    else card.place = 'main'
  }
  return cards.sort((a, b) => STATES[a.state].rank - STATES[b.state].rank || b.activeAt - a.activeAt || (a.id < b.id ? -1 : 1))
}

// The card's and the panel's "doing" line. A claim that is no longer live is
// what the session last reported (#466), dated by its last Agent Inbox call:
// the claim was live then, and nothing since says what it is doing now.
function doingLine(card, nowMs) {
  if (!(card.historical && card.base !== 'working' && card.row && card.text !== NO_TASK)) return card.text
  if (!card.claim) return `was: ${card.text}`
  const ms = ago(nowMs, time(card.row.last_call_at) ?? time(card.row.started_at))
  if (ms === null) return `Last reported: ${card.text}`
  return `Last reported: ${card.text} · ${relMs(ms) === 'moments' ? 'just now' : `${relMs(ms)} ago`}`
}

// An ask whose session no card shows (#454 amendment A.1): "Session ended" when
// it names a session, else "No session". No composer, actions or transcript: the
// ask, its context and Open in Inbox. It is no launch feature, so it draws with
// the app's switch off too.
function askOnlyCard(id, entry, session, { items, boards, nowMs }) {
  const owner = entry.kind === 'item' ? entry.item : entry.board
  const newestBoard = (list) => list.reduce((best, board) => (!best || String(board.updated_at ?? '') > String(best.updated_at ?? '') ? board : best), null)
  const board = entry.kind === 'row' && !session ? entry.board : newestBoard(session ? boards.filter((b) => b.session === session) : [])
  // last heard: the newest item or stamped plan that session wrote, else the ask itself
  const heard = session
    ? Math.max(0, ...(items ?? []).filter((item) => item?.session === session).map((item) => time(item.created_at) ?? 0),
      ...boards.filter((b) => b.session === session).map((b) => time(b.updated_at) ?? 0),
      time(owner?.created_at) ?? 0, time(owner?.updated_at) ?? 0)
    : time(entry.kind === 'row' ? owner?.updated_at : owner?.created_at) ?? 0
  const heardMs = heard ? ago(nowMs, heard) : null
  const agent = typeof owner?.agent === 'string' && owner.agent ? owner.agent : 'unknown'
  return {
    id,
    askOnly: session ? 'ended' : 'none',
    session: null,
    sessions: session ? [session] : [],
    row: null, launch: null, status: null,
    project: String(owner?.project ?? ''),
    branch: typeof owner?.stream === 'string' ? owner.stream : '',
    agent,
    host: hostLabel(agent),
    origin: session ? 'session ended' : 'no session',
    base: 'ended',
    text: board ? `Plan: ${board.title ?? ''}` : session ? 'Its session has ended' : 'Filed without a session',
    claim: false, quiet: false,
    historical: true,
    recency: heardMs === null ? '' : relMs(heardMs) === 'moments' ? 'last heard just now' : `last heard ${relMs(heardMs)} ago`,
    lastCallAt: null,
    worktree: null,
    plan: board ? planBar(board, nowMs) : null,
    children: [], trace: null,
    asks: [], answered: [],
    activeAt: heard,
  }
}

// Every ask belongs to at most ONE card, so the cards never count an ask twice
// (#458 review). An item goes to the card whose live session it names, else to
// the card that remembers that session (a launch whose session has gone). A plan
// row goes to the card of the session that stamped its plan (`boards.session`),
// else to the newest WORKING card the lanes' join links it to (`linkedPlan`),
// else (step 2, #454 A.1) to the newest idle or dormant card the same join
// matches, so an idle session never looks ended. What is left is `unowned`.
function attributeAsks(cards, { asks, boards, working, nowMs }) {
  const bySession = new Map()
  for (const card of cards) if (card.session && !bySession.has(card.session)) bySession.set(card.session, card)
  for (const card of cards) for (const session of card.sessions) if (session && !bySession.has(session)) bySession.set(session, card)
  const planOwner = new Map()
  const byActivity = [...cards].sort((a, b) => b.activeAt - a.activeAt || (a.id < b.id ? -1 : 1))
  for (const card of byActivity) {
    card.asks = []
    card.answered = []
    const stamped = boards.filter((board) => board.session && card.sessions.includes(board.session))
    for (const board of stamped) if (!planOwner.has(board.id)) planOwner.set(board.id, card)
  }
  for (const card of byActivity) {
    if (card.base !== 'working' || !card.row) continue
    const board = linkedPlan(card.row, boards, working)
    if (board && !planOwner.has(board.id)) planOwner.set(board.id, card)
  }
  const joins = (row, board) => board.project === row.project && board.stream === row.stream && board.agent === row.agent
    && !(board.session && working.has(board.session))
  for (const entry of asks) {
    if (entry.kind !== 'row' || !entry.board || planOwner.has(entry.board.id)) continue
    const quiet = byActivity.find((card) => (card.base === 'idle' || card.base === 'dormant') && card.row && joins(card.row, entry.board))
    if (quiet) planOwner.set(entry.board.id, quiet)
  }
  for (const card of byActivity) {
    const own = [...planOwner].filter(([, owner]) => owner === card).map(([id]) => boards.find((board) => board.id === id))
    // the plan its card shows: a working card's lane plan, else the newest plan it owns
    const shown = card.base === 'working' && card.row ? linkedPlan(card.row, boards, working) : null
    const plan = shown && planOwner.get(shown.id) === card ? shown
      : own.reduce((best, board) => (!best || String(board.updated_at ?? '') > String(best.updated_at ?? '') ? board : best), null)
    card.plan = plan ? planBar(plan, nowMs) : null
  }
  const unowned = []
  for (const entry of asks) {
    const owner = entry.kind === 'item' ? bySession.get(entry.item?.session) : planOwner.get(entry.board?.id)
    if (owner) owner.asks.push(entry)
    else unowned.push(entry)
  }
  return { bySession, planOwner, unowned, orphans: new Map() }
}

/** Whether a main-list card shows under a state filter. */
export function cardMatches(card, filter) {
  return !filter || filter === 'all' || card.state === filter
}

/** The header's counts, over the main list: cards per state, and Needs you's distinct asks. */
export function filterCounts(cards) {
  const counts = Object.fromEntries(FILTERS.map(([key]) => [key, 0]))
  for (const card of cards) {
    counts.all += 1
    // Needs you counts the asks, each once (every ask has at most one card), as the rail does
    if (card.state === 'ask') counts.ask += card.asks.length
    else if (card.state in counts) counts[card.state] += 1
  }
  return counts
}

/**
 * Cards in groups, by project (the default) or by agent kind, keeping the
 * order the cards come in: a group sits where its first card does.
 * @param {any[]} cards @param {'project'|'agent'} by
 */
export function groupCards(cards, by = 'project') {
  const groups = new Map()
  for (const card of cards) {
    const key = by === 'agent' ? card.agent : card.project
    const group = groups.get(key) ?? { key, label: by === 'agent' ? card.host : card.project, cards: [] }
    groups.set(key, group)
    group.cards.push(card)
  }
  return [...groups.values()]
}

// When a Message reaches the session, as briefly as a card can say it; the
// composer's delivery line (`deliveryState`) is the full rule.
const HINTS = {
  'next-check': 'It sees a message when it next checks',
  now: 'A message arrives now',
  queued: 'A message waits for its turn to end',
  cannot: 'It can’t receive messages until it restarts',
}

export function messageHint(row) {
  return row ? HINTS[deliveryState(row, () => '').state] ?? '' : ''
}
