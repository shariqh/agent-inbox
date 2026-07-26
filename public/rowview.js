// Pure view-model for the Needs-you compact rows (spec §3). No DOM: line-2
// selection, stream/agent disambiguation, the urgency chip and the single age
// vocabulary stay unit-testable; app.js only turns these models into elements.
import { canUndo, starOption } from './star.js'
import { attentionEntries, classifyLiveness, sortNeedsYou, ESCALATE_MS } from './attention.js'
import { projectMonogram } from './colors.js'

// Line 2 is what makes one-tap defensible (§5): you accept what you just read.
// The item's own detail wins; otherwise the recommended option's detail.
export function secondaryLine(item) {
  if (item.detail) return item.detail
  const rec = starOption(item)
  return rec && rec.detail ? rec.detail : ''
}

function countDistinct(entities, field) {
  const map = new Map()
  for (const e of entities) {
    const set = map.get(e.project) ?? new Set()
    set.add(e[field] ?? '')
    map.set(e.project, set)
  }
  return new Map([...map].map(([project, set]) => [project, set.size]))
}

// project -> how many distinct streams it has; a single-stream project must
// not pay for a stream suffix on every row.
export function streamCounts(entities) {
  return countDistinct(entities, 'stream')
}

// same treatment for agents: flattening the old agent <h4> must not lose
// attribution when two agents share a project (§15).
export function agentCounts(entities) {
  return countDistinct(entities, 'agent')
}

export function rowModel(entry, { streams = new Map(), agents = new Map(), showProject = true } = {}) {
  if (entry.kind === 'row') {
    const { row, board } = entry
    return {
      kind: 'row',
      id: row.id,
      project: board.project,
      projectLabel: showProject ? projectMonogram(board.project) : '',
      stream: (streams.get(board.project) ?? 0) > 1 ? (board.stream ?? '') : '',
      agent: (agents.get(board.project) ?? 0) > 1 ? (board.agent ?? '') : '',
      title: row.label,
      secondary: row.note ?? '',
      liveness: 'blocked',
      boardId: board.id,
      boardTitle: board.title,
      created_at: null,
      answered: false,
    }
  }
  const it = entry.item
  return {
    kind: 'item',
    id: it.id,
    project: it.project,
    projectLabel: showProject ? projectMonogram(it.project) : '',
    stream: (streams.get(it.project) ?? 0) > 1 ? (it.stream ?? '') : '',
    agent: (agents.get(it.project) ?? 0) > 1 ? (it.agent ?? '') : '',
    title: it.title,
    secondary: secondaryLine(it),
    liveness: entry.liveness,
    boardId: null,
    boardTitle: null,
    created_at: it.created_at,
    answered: Boolean(it.reply),
  }
}

// One time vocabulary shared with the Live freshness dots (§6) — never a raw
// age ramp: only a live asking session earns heat.
export function urgencyChip(model, nowMs) {
  if (model.kind === 'row') return { text: 'blocked', tone: 'blocked' }
  if (model.answered) return { text: 'answered', tone: 'muted' }
  const age = nowMs - Date.parse(model.created_at)
  if (model.liveness === 'waiting') return { text: `waiting ${relMs(age)}`, tone: age >= ESCALATE_MS ? 'hot' : 'warm' }
  if (model.liveness === 'stale') return { text: `stale ${relMs(age)}`, tone: 'muted' }
  return { text: `parked ${relMs(age)}`, tone: 'neutral' }
}

export function relMs(ms) {
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'moments'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

// The Live surface used to keep its own thresholds and its own "3h 20m"
// formatter. §6 wants one system: these are it, and renderLive consumes them.
export const FRESH_MS = 60 * 1000
export const AGING_MS = 5 * 60 * 1000

export function freshnessTone(ageMs) {
  if (ageMs < FRESH_MS) return 'fresh'
  if (ageMs < AGING_MS) return 'aging'
  return 'quiet'
}

export function ageChip(ageMs) {
  return { tone: freshnessTone(ageMs), text: relMs(ageMs) }
}

// The rendered Needs-you list: the attention set over the boards the user is
// actually looking at, plus any extra entries (Task 12's awaiting-pickup foot),
// through the one ordering rule. The tab count deliberately uses the UNFILTERED
// data instead — see Task 8's tabCounts (§7 filter-blindness).
export function needsYouEntries(items, boards, nowMs, liveSessionIds, extra = []) {
  return sortNeedsYou([...attentionEntries(items, boards, nowMs, liveSessionIds), ...extra], nowMs)
}

// Stale = nobody is listening and it is older than STALE_MS. It must stay
// reachable (never deleted) but must not sit in the active list (§6).
export function staleFoldLabel(n) {
  return `stale — decide later (${n})`
}

// Gate 2 of the safe star (§5): you may only one-tap what the row actually
// showed you, so a line-2 that would ellipsize kills the star.
export const SECONDARY_BUDGET = 140

export function rowStarOption(model, item) {
  if (model.kind !== 'item' || model.answered) return null
  if (model.secondary.length === 0 || model.secondary.length > SECONDARY_BUDGET) return null
  return starOption(item)
}

export function stagedLabel(staged) {
  return `Sent: ${staged.label}`
}

// Undo cannot win the race against a picked-up reply — say so instead of lying.
export function undoRefusal(item, nowMs) {
  if (canUndo(item)) return null
  return `Picked up ${relMs(nowMs - Date.parse(item.reply_seen_at))} ago — answering again will not un-do it`
}

// Replying does not resolve (§5): answered questions leave the active set and
// sit dimmed at the foot of the list until the agent closes them out.
//
// This deliberately keeps the ones the agent has ALREADY picked up. Between
// `reply_seen_at` being stamped and the agent's `resolve` call — which it may
// simply forget, permanently — such an item is dropped by attentionEntries,
// staleEntries and group.ts's `done` alike, so it used to render in NO tab
// while tabsearch's searchIndex still counted it under Needs-you: the tab badge
// lit up and the tab then said "No matches here". The foot group is also the
// only place the card's "✓ picked up" marker (§15) can ever be seen.
export function repliedEntries(items, nowMs, liveSessionIds) {
  return items
    .filter((i) => i.kind === 'question' && (i.status ?? 'open') === 'open' && i.reply)
    .map((i) => ({ kind: 'item', item: i, liveness: classifyLiveness(i, nowMs, liveSessionIds) }))
}
// (There used to be a strict "still awaiting pickup" subset of the above here.
// Nothing called it once repliedEntries became what the list renders — issue
// #31.4. The one ambient reading of "answered · awaiting agent" is notes.js's
// inline count inside ambientChips, which needs a NUMBER, not entries with a
// computed liveness, and has no liveSessionIds to pass. test/dead-exports.test.ts
// is what now notices a helper like that going quiet.)
