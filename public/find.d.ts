import type { SearchMatch, SearchResult } from './search-index.js'
import type { StepState } from './lanes.js'
import type { Chat } from './chats.js'

export type FindChip = 'all' | 'answers' | 'notes' | 'plans' | 'chats'
export const FIND_CHIPS: FindChip[]
export const FIND_PAGE: number

export type FindExtra =
  | { kind: 'chip'; text: string; full: string }
  | { kind: 'text'; text: string; full: string }
  | { kind: 'state'; text: string; full: string }
  | { kind: 'bar'; runs: boolean; segments: Array<{ state: StepState; grow: number }>; label: string }

export interface FindRow {
  key: string
  id: string
  type: 'answer' | 'note' | 'plan' | 'finished' | 'ask' | 'chat'
  /** the type's word; a chat's is its tool's name ("Claude Code", "Copilot") */
  label: string
  /** expand: opens in place; home: goes to the ask on Home; plans: goes to the plan */
  action: 'expand' | 'home' | 'plans'
  title: string
  project: string
  /** ms since the epoch: the row's own sort stamp */
  stamp: number
  open: boolean
  /** a closed item: only these can fall below the cut */
  cuttable: boolean
  extra: FindExtra | null
  /** the search hit that put it in the list, for the landing's highlight */
  source?: SearchResult['source']
  entity: any
}

/** A chat's row (step B): keyed `chat:<tool>:<id>`; its id is `<tool>:<id>`. */
export interface FindChatRow extends FindRow {
  type: 'chat'
  tool: string
  /** an automatic or missing title is drawn quietly, with `titleNote` saying why */
  titleQuiet: boolean
  titleNote: string | null
  live: boolean
  chat: Chat
}

export function findAge(ageMs: number): string
export function findRow(entity: any, options?: { nowMs?: number; archived?: boolean; fromCounts?: boolean }): FindRow
export function chatFindRow(chat: Chat): FindChatRow
export function buildFindRows(data: any, options?: {
  chip?: FindChip
  query?: string
  searchFn?: ((haystack: string[], needle: string) => SearchMatch[] | null) | null
  before?: string | null
  nowMs?: number
  archivedWhole?: boolean
  keep?: Iterable<string>
  previous?: string[]
  /** the chat list read, sorted or not; null before any read */
  chats?: readonly Chat[] | null
  /** the Chats line's tool toggle, applied under the Chats chip only */
  chatTool?: 'all' | 'claude' | 'copilot'
}): { rows: FindRow[]; cut: number }
