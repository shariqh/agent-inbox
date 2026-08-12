export type Liveness = 'waiting' | 'parked' | 'stale' | 'snoozed'

export interface AttentionItem {
  id: string
  project: string
  kind?: string
  /** 'open' | 'resolved' | 'dismissed'; absent is treated as open */
  status?: string
  reply?: string | null
  reply_kind?: 'answer' | 'clarify' | 'decline' | null
  session?: string | null
  snoozed_until?: string | null
  created_at: string
  title?: string
  detail?: string
  next_step?: string
  action_owner?: 'decision' | 'task' | 'approval' | null
  impact?: string
  next_after?: string
  reply_seen_at?: string | null
  updated_at?: string
}

export interface AttentionRow {
  id: string
  label?: string
  status: string
  annotation: string | null
  annotation_kind?: 'answer' | 'clarify' | 'decline' | null
  annotation_unseen: boolean
  /** issue #37 — when the annotation was handed to an agent, and to which one. */
  annotation_seen_at?: string | null
  annotation_seen_by?: string | null
  /** issue #36 — the human's "I did my part" mark, and its own delivery stamps. */
  handled_at?: string | null
  handled_seen_at?: string | null
  handled_seen_by?: string | null
  snoozed_until?: string | null
  note?: string
  next_step?: string
  action_owner?: 'decision' | 'task' | 'approval' | null
  impact?: string
  next_after?: string
  options?: Array<{ label: string; detail?: string; recommended?: boolean }> | null
  created_at?: string
  action_started_at?: string
  updated_at?: string
  revision?: number
}

export interface AttentionBoard {
  id: string
  project: string
  title?: string
  revision?: number
  rows: AttentionRow[]
}

export type AttentionEntry =
  | { kind: 'item'; item: AttentionItem; liveness: Liveness }
  | { kind: 'row'; row: AttentionRow; board: AttentionBoard }

export interface StaleEntry {
  kind: 'item'
  item: AttentionItem
  liveness: 'stale'
}

export type LiveSessionIds = Set<string> | readonly string[]

export const STALE_MS: number
export const ESCALATE_MS: number
export const NOTE_AGE_MS: number

export function classifyLiveness(item: AttentionItem, nowMs: number, liveSessionIds: LiveSessionIds): Liveness
export function isAskingQuestion(item: AttentionItem, nowMs?: number): boolean
export function isBlockedRowAttention(row: AttentionRow, nowMs?: number): boolean
/** issue #36 — the human answered it in words, or went and did it. Either ends their part. */
export function humanActedOnRow(row: AttentionRow): boolean
/** A closed set: project names, as a Set (browser) or a plain array (JSON). */
export type ClosedProjects = Set<string> | readonly string[]

/** Blocked rows carrying the human's answer — the relabeled half of #36/#37. */
export function awaitingAgentRows(
  boards: AttentionBoard[] | undefined,
  closedProjects?: ClosedProjects,
): Array<{ kind: 'row'; row: AttentionRow; board: AttentionBoard }>

export function attentionEntries(
  items: AttentionItem[],
  boards: AttentionBoard[],
  nowMs: number,
  liveSessionIds: LiveSessionIds,
  closedProjects?: ClosedProjects,
): AttentionEntry[]
export function staleEntries(
  items: AttentionItem[],
  nowMs: number,
  liveSessionIds: LiveSessionIds,
): StaleEntry[]
export function snoozedEntries(
  items: AttentionItem[],
  boards: AttentionBoard[],
  nowMs: number,
  closedProjects?: ClosedProjects,
): AttentionEntry[]
export function attentionCount(
  items: AttentionItem[],
  boards: AttentionBoard[],
  nowMs: number,
  liveSessionIds: LiveSessionIds,
  closedProjects?: ClosedProjects,
): number
export function countsByProject(
  items: AttentionItem[],
  boards: AttentionBoard[],
  nowMs: number,
  liveSessionIds: LiveSessionIds,
): Map<string, { total: number; escalated: number }>
export function sortNeedsYou(entries: AttentionEntry[], nowMs: number): AttentionEntry[]
