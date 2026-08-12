import type { AttentionBoard, AttentionEntry, AttentionItem, LiveSessionIds } from './attention.js'

export interface RowOption { label: string; detail?: string; recommended?: boolean }

export interface RowItem {
  id: string
  project: string
  stream?: string
  agent?: string
  kind?: string
  title: string
  detail?: string
  next_step?: string
  status?: string
  session?: string | null
  options?: RowOption[] | null
  reply?: string | null
  reply_seen_at?: string | null
  reply_kind?: 'answer' | 'clarify' | 'decline' | null
  snoozed_until?: string | null
  action_owner?: 'decision' | 'task' | 'approval' | null
  impact?: string
  next_after?: string
  updated_at?: string
  action_started_at?: string
  revision?: number
  created_at: string
}

export interface RowBoard { id: string; project: string; stream?: string; agent?: string; title: string; revision?: number }
export interface RowRow {
  id: string
  label: string
  note?: string
  next_step?: string
  options?: RowOption[] | null
  status?: string
  /** issue #37 — the human's answer on this row, and its delivery state. */
  annotation?: string | null
  annotation_seen_at?: string | null
  annotation_seen_by?: string | null
  /** issue #36 — the human's "I did my part" mark, and its own delivery state. */
  handled_at?: string | null
  handled_seen_at?: string | null
  handled_seen_by?: string | null
  snoozed_until?: string | null
  action_owner?: 'decision' | 'task' | 'approval' | null
  impact?: string
  next_after?: string
  created_at?: string
  updated_at?: string
  action_started_at?: string
  revision?: number
}

export type Liveness = 'waiting' | 'parked' | 'stale' | 'snoozed'
export type Entry =
  | { kind: 'item'; item: RowItem; liveness: Liveness }
  | { kind: 'row'; row: RowRow; board: RowBoard; liveness?: Liveness }

export interface RowModel {
  kind: 'item' | 'row'
  id: string
  project: string
  projectLabel: string
  stream: string
  agent: string
  title: string
  secondary: string
  liveness: string
  boardId: string | null
  boardTitle: string | null
  created_at: string | null
  askedAt: string | null
  snoozedUntil: string | null
  ownerLabel: string
  actionCategory: 'decision' | 'task'
  changeKind: 'new' | 'changed' | null
  answered: boolean
  /** issue #36 — the human answered by DOING it rather than by writing. */
  handled: boolean
  handledAt: string | null
  handledPickedUp: boolean
  /** issue #37 — whether an agent has collected everything the human left, when, and which one. */
  pickedUp: boolean
  pickedUpAt: string | null
  pickedUpBy: string
}

export interface RowModelOpts {
  streams?: Map<string, number>
  agents?: Map<string, number>
  showProject?: boolean
  lastVisitAt?: string | null
}

export function secondaryLine(item: RowItem): string
export function streamCounts(entities: Array<{ project: string; stream?: string }>): Map<string, number>
export function agentCounts(entities: Array<{ project: string; agent?: string }>): Map<string, number>
export function rowModel(entry: Entry, opts?: RowModelOpts): RowModel
export const ASK_SORT_OPTIONS: ReadonlyArray<{
  value: 'priority' | 'newest' | 'oldest'
  label: string
}>
export type AskSortableEntry =
  | {
      kind: 'item'
      item: { id: string; created_at?: string; action_started_at?: string }
      liveness?: unknown
    }
  | {
      kind: 'row'
      row: { id: string; created_at?: string; action_started_at?: string }
      board?: unknown
      liveness?: unknown
    }
export function currentAskAt(entry: AskSortableEntry): string | null
export function sortNeedsYouByAsk<T extends AskSortableEntry>(
  entries: T[],
  mode: 'priority' | 'newest' | 'oldest',
): T[]
export function askTimeModel(askedAt: string | null, nowMs: number): {
  datetime: string
  exact: string
  text: string
  accessibleLabel: string
} | null
export function urgencyChip(model: RowModel, nowMs: number): { text: string; tone: string }
export function relMs(ms: number): string
export const FRESH_MS: number
export const AGING_MS: number
export function freshnessTone(ageMs: number): 'fresh' | 'aging' | 'quiet'
export function ageChip(ageMs: number): { tone: 'fresh' | 'aging' | 'quiet'; text: string }
export function needsYouEntries(
  items: AttentionItem[],
  boards: AttentionBoard[],
  nowMs: number,
  liveSessionIds: LiveSessionIds,
  extra?: AttentionEntry[],
): AttentionEntry[]
export function staleFoldLabel(n: number): string
export const SECONDARY_BUDGET: number
export function rowStarOption(model: RowModel, item: RowItem): RowOption | null
export function stagedLabel(staged: { label: string }): string
export function undoRefusal(item: RowItem, nowMs: number): string | null
export function handledUndoRefusal(row: RowRow, nowMs: number): string | null
export function repliedEntries(items: RowItem[], nowMs: number, liveSessionIds: Set<string>): Entry[]
