export type Liveness = 'waiting' | 'parked' | 'stale'

export interface AttentionItem {
  id: string
  project: string
  kind?: string
  /** 'open' | 'resolved' | 'dismissed'; absent is treated as open */
  status?: string
  reply?: string | null
  session?: string | null
  created_at: string
  title?: string
  detail?: string
  reply_seen_at?: string | null
}

export interface AttentionRow {
  id: string
  label?: string
  status: string
  annotation: string | null
  annotation_unseen: boolean
  note?: string
}

export interface AttentionBoard {
  id: string
  project: string
  title?: string
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
export function isAskingQuestion(item: AttentionItem): boolean
export function isBlockedRowAttention(row: AttentionRow): boolean
export function attentionEntries(
  items: AttentionItem[],
  boards: AttentionBoard[],
  nowMs: number,
  liveSessionIds: LiveSessionIds,
): AttentionEntry[]
export function staleEntries(
  items: AttentionItem[],
  nowMs: number,
  liveSessionIds: LiveSessionIds,
): StaleEntry[]
export function attentionCount(
  items: AttentionItem[],
  boards: AttentionBoard[],
  nowMs: number,
  liveSessionIds: LiveSessionIds,
): number
export function countsByProject(
  items: AttentionItem[],
  boards: AttentionBoard[],
  nowMs: number,
  liveSessionIds: LiveSessionIds,
): Map<string, { total: number; escalated: number }>
export function sortNeedsYou(entries: AttentionEntry[], nowMs: number): AttentionEntry[]
