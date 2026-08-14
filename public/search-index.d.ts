import type { HaystackEntity } from './search.js'

export interface SearchResult {
  key: string
  targetId: string
  tab: 'needsYou' | 'boards' | 'notes' | 'done'
  section: 'open' | 'plans' | 'notes' | 'history' | 'archived'
  sectionLabel: 'Open items' | 'Active plans' | 'Notes' | 'History' | 'Archived plans'
  kind: 'Open item' | 'Active plan' | 'Note' | 'History' | 'Archived plan'
  title: string
  titleRanges: number[]
  match: { label: string; text: string; ranges: number[] } | null
  source: {
    field: string
    rowId: string | null
    text: string
    fragments: string[]
  } | null
  context: string
}

export interface SearchMatch {
  index: number
  ranges: number[]
}

export interface SearchData {
  g?: {
    needsYou?: Array<{ items?: HaystackEntity[] }>
    notes?: Array<{ items?: HaystackEntity[] }>
    done?: HaystackEntity[]
  }
  boards?: HaystackEntity[]
  archived?: HaystackEntity[]
}

export function buildSearchResults(
  data: SearchData | null | undefined,
  query: string | null | undefined,
  searchFn: (haystack: string[], needle: string) => SearchMatch[] | null,
  limit?: number,
): SearchResult[]
