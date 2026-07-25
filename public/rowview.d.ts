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
  status?: string
  session?: string | null
  options?: RowOption[] | null
  reply?: string | null
  reply_seen_at?: string | null
  created_at: string
}

export interface RowBoard { id: string; project: string; stream?: string; agent?: string; title: string }
export interface RowRow { id: string; label: string; note?: string; status?: string }

export type Liveness = 'waiting' | 'parked' | 'stale'
export type Entry =
  | { kind: 'item'; item: RowItem; liveness: Liveness }
  | { kind: 'row'; row: RowRow; board: RowBoard }

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
  answered: boolean
}

export interface RowModelOpts {
  streams?: Map<string, number>
  agents?: Map<string, number>
  showProject?: boolean
}

export function secondaryLine(item: RowItem): string
export function streamCounts(entities: Array<{ project: string; stream?: string }>): Map<string, number>
export function agentCounts(entities: Array<{ project: string; agent?: string }>): Map<string, number>
export function rowModel(entry: Entry, opts?: RowModelOpts): RowModel
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
export function awaitingPickupEntries(items: RowItem[], nowMs: number, liveSessionIds: Set<string>): Entry[]
