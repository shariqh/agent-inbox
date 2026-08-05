import type { AttentionBoard, AttentionEntry, AttentionItem, AttentionRow, ClosedProjects, LiveSessionIds } from './attention.js'

export interface RelayItem extends AttentionItem {
  title?: string
  detail?: string
  note?: string
  outcome?: string
  outcome_at?: string | null
  reply_kind?: 'answer' | 'clarify' | 'decline' | null
  replied_at?: string | null
}

export interface RelayRow extends AttentionRow {
  label?: string
  note?: string
  next_step?: string
  action_owner?: 'decision' | 'task' | 'approval' | null
  annotated_at?: string | null
  outcome?: string
  outcome_at?: string | null
}

export interface RelayBoard extends Omit<AttentionBoard, 'rows'> {
  agent?: string
  stream?: string
  rows: RelayRow[]
}

export type RelayEntry = AttentionEntry | {
  kind: 'item'
  item: RelayItem
} | {
  kind: 'row'
  row: RelayRow
  board: RelayBoard
}

export function buildRelay(
  items: RelayItem[],
  boards: RelayBoard[],
  archived: RelayBoard[],
  nowMs: number,
  liveSessionIds: LiveSessionIds,
  closedProjects?: ClosedProjects,
): {
  human: RelayEntry[]
  agent: RelayEntry[]
  outcomes: RelayEntry[]
}
