// Pure view-model for the Needs-you compact rows (spec §3). No DOM: line-2
// selection, stream/agent disambiguation, the urgency chip and the single age
// vocabulary stay unit-testable; app.js only turns these models into elements.
import { canUndo, starOption } from './star.js'
import { attentionEntries, classifyLiveness, humanActedOnRow, sortNeedsYou, ESCALATE_MS } from './attention.js'
import { projectMonogram } from './colors.js'
import { actionCategory, actionOwnerLabel, agentFollowupChip, changeKind } from './action.js'
import { actionPresentation } from './card.js'

export const ASK_SORT_OPTIONS = [
  { value: 'priority', label: 'Priority' },
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
]

export function currentAskAt(entry) {
  if (entry?.kind === 'row') return entry.row?.action_started_at ?? entry.row?.created_at ?? null
  return entry?.item?.created_at ?? null
}

function askSortKey(entry) {
  const entity = entry.kind === 'row' ? entry.row : entry.item
  return `${entry.kind}:${entity.id}`
}

function askMs(entry) {
  const parsed = Date.parse(currentAskAt(entry) ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

export function sortNeedsYouByAsk(entries, mode) {
  if (mode === 'priority') return entries
  const direction = mode === 'oldest' ? 1 : -1
  return entries
    .map((entry, index) => ({ entry, index, at: askMs(entry), key: askSortKey(entry) }))
    .sort((a, b) => {
      if (a.at !== b.at) return direction * (a.at - b.at)
      if (a.key !== b.key) return a.key < b.key ? -1 : 1
      return a.index - b.index
    })
    .map(({ entry }) => entry)
}

export function askTimeModel(askedAt, nowMs) {
  const at = Date.parse(askedAt ?? '')
  if (!Number.isFinite(at)) return null
  const exact = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(at))
  const text = `Asked ${relMs(Math.max(0, nowMs - at))} ago`
  return {
    datetime: new Date(at).toISOString(),
    exact,
    text,
    accessibleLabel: `${text}, ${exact}`,
  }
}

// Line 2 is what makes one-tap defensible (§5): you accept what you just read.
// The item's own detail wins; otherwise the recommended option's detail.
export function secondaryLine(item) {
  const presentation = actionPresentation(item)
  if (presentation.detail) return presentation.detail
  const rec = starOption(item)
  return rec?.detail && rec.detail !== presentation.headline ? rec.detail : ''
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

// Everything the human left on a row, as {at, by} delivery pairs — one per shape
// they actually used. #36 made "has an agent collected this?" a question about
// TWO independent halves (the annotation's stamp, and the mark's), and reporting
// "delivered" while one of them is still queued is exactly the lie #37 exists to
// prevent. So: delivered only when EVERY half is, and then the age shown is the
// LATEST of them — the one that decides how long the row has really been sitting
// with an agent.
function humanHalves(row) {
  const halves = []
  if (row.annotation) halves.push({ at: row.annotation_seen_at ?? null, by: row.annotation_seen_by ?? '' })
  if (row.handled_at) halves.push({ at: row.handled_seen_at ?? null, by: row.handled_seen_by ?? '' })
  return halves
}

function rowPickup(row) {
  const halves = humanHalves(row)
  if (!halves.length || halves.some((h) => !h.at)) return { pickedUp: false, pickedUpAt: null, pickedUpBy: '' }
  const latest = halves.reduce((a, b) => (Date.parse(b.at) > Date.parse(a.at) ? b : a))
  return { pickedUp: true, pickedUpAt: latest.at, pickedUpBy: latest.by }
}

export function rowModel(entry, {
  streams = new Map(),
  agents = new Map(),
  showProject = true,
  lastVisitAt = null,
} = {}) {
  if (entry.kind === 'row') {
    const { row, board } = entry
    const presentation = actionPresentation(row)
    return {
      kind: 'row',
      id: row.id,
      project: board.project,
      projectLabel: showProject ? projectMonogram(board.project) : '',
      stream: (streams.get(board.project) ?? 0) > 1 ? (board.stream ?? '') : '',
      agent: (agents.get(board.project) ?? 0) > 1 ? (board.agent ?? '') : '',
      title: presentation.headline,
      headlineField: presentation.headlineField,
      originalTitle: presentation.originalTitle,
      secondary: presentation.detail,
      liveness: entry.liveness ?? 'blocked',
      boardId: board.id,
      boardTitle: board.title,
      created_at: null,
      askedAt: currentAskAt(entry),
      snoozedUntil: row.snoozed_until ?? null,
      ownerLabel: actionOwnerLabel(row),
      actionCategory: actionCategory(row),
      changeKind: changeKind(row, lastVisitAt),
      // #37 — a row carries the same two facts an item does: the human answered,
      // and an agent collected that answer. `answered` is what dims it and sinks
      // it to the awaiting-pickup foot, so it must key on what the HUMAN did,
      // never on delivery — and #36 gave them a second way to do it, so this is
      // the same predicate the badge uses rather than a second reading of it.
      answered: humanActedOnRow(row),
      // #36 — WHICH shape it was. `answered` decides how the row looks; this
      // decides what the card can SAY about it, and it is the only field that
      // tells "I wrote you a note" apart from "I went and did it".
      handled: Boolean(row.handled_at),
      handledAt: row.handled_at ?? null,
      handledPickedUp: Boolean(row.handled_seen_at),
      ...rowPickup(row),
    }
  }
  const it = entry.item
  const presentation = actionPresentation(it)
  return {
    kind: 'item',
    id: it.id,
    project: it.project,
    projectLabel: showProject ? projectMonogram(it.project) : '',
    stream: (streams.get(it.project) ?? 0) > 1 ? (it.stream ?? '') : '',
    agent: (agents.get(it.project) ?? 0) > 1 ? (it.agent ?? '') : '',
    title: presentation.headline,
    headlineField: presentation.headlineField,
    originalTitle: presentation.originalTitle,
    secondary: secondaryLine(it),
    liveness: entry.liveness,
    boardId: null,
    boardTitle: null,
    created_at: it.created_at,
    askedAt: currentAskAt(entry),
    snoozedUntil: it.snoozed_until ?? null,
    ownerLabel: actionOwnerLabel(it),
    actionCategory: actionCategory(it),
    changeKind: changeKind(it, lastVisitAt),
    answered: Boolean(it.reply || it.reply_kind),
    // an ITEM is never "handled": the mark is a board-row concept. These three
    // are a stated false rather than an absence, so a consumer reading them off
    // an item model gets an answer instead of `undefined`.
    //
    // NOTE, so nobody mistakes these for load-bearing: no shipping code reads
    // them today. public/app.js works off the raw row (`r.handled_at`,
    // `r.handled_seen_at`), and `rowHumanStateHtml` — not this model — is what
    // tells "I wrote you a note" apart from "I went and did it". They exist
    // because public/rowview.d.ts declares them, and they are covered by
    // rowview.test.ts only. Wire them or drop them deliberately; do not assume
    // a card depends on them.
    handled: false,
    handledAt: null,
    handledPickedUp: false,
    pickedUp: Boolean(it.reply_seen_at),
    pickedUpAt: it.reply_seen_at ?? null,
    pickedUpBy: '',
  }
}

// One time vocabulary shared with the Live freshness dots (§6) — never a raw
// age ramp: only a live asking session earns heat.
export function urgencyChip(model, nowMs) {
  if (model.liveness === 'snoozed' && model.snoozedUntil) {
    return { text: `snoozed ${relMs(Date.parse(model.snoozedUntil) - nowMs)}`, tone: 'muted' }
  }
  if (model.kind === 'row') {
    // #37: a blocked row that the human has ANSWERED must stop reading "you
    // still need to act" and start reading "answered — has anyone collected it?"
    // The alarm is relabeled, never removed, so a pickup that never happens
    // stays on screen as the agent's failure rather than as your to-do.
    if (!model.answered) return { text: 'Needs input', tone: 'blocked' }
    return agentFollowupChip(model, nowMs) ?? { text: 'Waiting for delivery', tone: 'muted' }
  }
  if (model.answered) return agentFollowupChip(model, nowMs) ?? { text: 'Answered', tone: 'muted' }
  const age = nowMs - Date.parse(model.created_at)
  if (model.liveness === 'waiting') return { text: `Waiting ${relMs(age)}`, tone: age >= ESCALATE_MS ? 'hot' : 'warm' }
  if (model.liveness === 'stale') return { text: `Later ${relMs(age)}`, tone: 'muted' }
  return { text: `Queued ${relMs(age)}`, tone: 'neutral' }
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
  return `Delivered ${relMs(nowMs - Date.parse(item.reply_seen_at))} ago — this answer can no longer be withdrawn`
}

// The mark's own twin of the above (#36). store.ts's clearRowHandled refuses once
// `handled_seen_at` is set, because un-marking cannot un-tell an agent that has
// already been handed the mark — so the viewer must not DRAW an undo it knows
// will be refused (#38: never ship a control that lies), and must be able to say
// why when it loses the race anyway. Null = still the human's own business, undo
// freely. The delivery AGE is named for the same reason the row chip names it:
// it is the evidence about how long an agent has been sitting on this.
export function handledUndoRefusal(row, nowMs) {
  if (!row.handled_seen_at) return null
  return `Delivered ${relMs(nowMs - Date.parse(row.handled_seen_at))} ago — this confirmation can no longer be withdrawn`
}

// Replying does not resolve (§5): answered questions leave the active set and
// sit dimmed at the foot of the list until the agent closes them out.
//
// This deliberately keeps the ones the agent has ALREADY picked up. Between
// `reply_seen_at` being stamped and the agent's `resolve` call — which it may
// simply forget, permanently — such an item is dropped by attentionEntries,
// staleEntries and group.ts's `done` alike, so it used to render in NO tab
// while the old global search index still counted it under Needs-you: the tab
// badge lit up and the tab then said "No matches here". The foot group is also the
// only place the card's "✓ picked up" marker (§15) can ever be seen.
export function repliedEntries(items, nowMs, liveSessionIds) {
  return items
    .filter((i) => i.kind === 'question' && (i.status ?? 'open') === 'open' && (i.reply || i.reply_kind))
    .map((i) => ({ kind: 'item', item: i, liveness: classifyLiveness(i, nowMs, liveSessionIds) }))
}
// (There used to be a strict "still awaiting pickup" subset of the above here.
// Nothing called it once repliedEntries became what the list renders — issue
// #31.4. The one ambient reading of "answered · awaiting agent" is notes.js's
// inline count inside ambientChips, which needs a NUMBER, not entries with a
// computed liveness, and has no liveSessionIds to pass. test/dead-exports.test.ts
// is what now notices a helper like that going quiet.)
