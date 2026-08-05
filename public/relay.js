import { attentionEntries, awaitingAgentRows } from './attention.js'

const asSet = (values) => values instanceof Set ? values : new Set(values ?? [])

function stamp(entity) {
  for (const value of [
    entity.outcome_at,
    entity.reply_seen_at,
    entity.annotation_seen_at,
    entity.handled_seen_at,
    entity.replied_at,
    entity.annotated_at,
    entity.handled_at,
    entity.updated_at,
    entity.created_at,
  ]) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function respondedItem(item) {
  return item.kind === 'question'
    && (item.status ?? 'open') === 'open'
    && Boolean(item.reply || item.reply_kind)
}

export function buildRelay(
  items,
  boards,
  archived,
  nowMs,
  liveSessionIds,
  closedProjects = [],
) {
  const closed = asSet(closedProjects)
  const visibleItems = (items ?? []).filter((item) => !closed.has(item.project))
  const visibleBoards = (boards ?? []).filter((board) => !closed.has(board.project))
  const visibleArchived = (archived ?? []).filter((board) => !closed.has(board.project))

  const human = attentionEntries(
    visibleItems,
    visibleBoards,
    nowMs,
    liveSessionIds,
  )
  const agent = [
    ...visibleItems
      .filter(respondedItem)
      .map((item) => ({ kind: 'item', item })),
    ...awaitingAgentRows(visibleBoards),
  ].sort((a, b) => stamp(a.item ?? a.row) - stamp(b.item ?? b.row))

  const outcomes = [
    ...visibleItems
      .filter((item) => item.outcome)
      .map((item) => ({ kind: 'item', item })),
    ...[...visibleBoards, ...visibleArchived].flatMap((board) =>
      (board.rows ?? [])
        .filter((row) => row.outcome)
        .map((row) => ({ kind: 'row', row, board }))),
  ].sort((a, b) => stamp(b.item ?? b.row) - stamp(a.item ?? a.row))

  return { human, agent, outcomes }
}
