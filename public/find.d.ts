import type { SearchMatch, SearchResult } from './search-index.js'
import type { StepState } from './lanes.js'

export type FindChip = 'all' | 'answers' | 'notes' | 'plans'
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
  type: 'answer' | 'note' | 'plan' | 'finished' | 'ask'
  label: 'Answer' | 'Note' | 'Plan' | 'Finished' | 'Ask' | 'Hand-off'
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

export function findAge(ageMs: number): string
export function findRow(entity: any, options?: { nowMs?: number; archived?: boolean; fromCounts?: boolean }): FindRow
export function buildFindRows(data: any, options?: {
  chip?: FindChip
  query?: string
  searchFn?: ((haystack: string[], needle: string) => SearchMatch[] | null) | null
  before?: string | null
  nowMs?: number
  archivedWhole?: boolean
  keep?: Iterable<string>
  previous?: string[]
}): { rows: FindRow[]; cut: number }
