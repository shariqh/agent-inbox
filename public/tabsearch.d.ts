import type { HaystackEntity } from './search.js'

export type TabName = 'needsYou' | 'boards' | 'live' | 'notes' | 'done'
export type FilterFn = (haystack: string[], needle: string) => number[] | null

export interface ActivityLike {
  session: string
  project: string
  agent?: string
  stream?: string
  doing?: string
  detail?: string
  children?: Array<{ name?: string; doing?: string }>
}

export interface SearchData {
  g: {
    needsYou: Array<{ items: Array<HaystackEntity & { project: string }> }>
    notes: Array<{ items: Array<HaystackEntity & { project: string }> }>
    done: Array<HaystackEntity & { project: string }>
  }
  boards: Array<HaystackEntity & { project: string }>
  archived: Array<HaystackEntity & { project: string }>
  activity?: ActivityLike[]
}

export function liveEntity(a: ActivityLike): HaystackEntity
export function searchIndex(data: SearchData, query: string, filterFn: FilterFn): Record<TabName, Set<string> | null>
export function tabMatchCounts(data: SearchData, query: string, filterFn: FilterFn): Record<TabName, number | null>
export function projectMatchCounts(data: SearchData, query: string, filterFn: FilterFn): Map<string, number>
export function otherTabMatches(counts: Record<TabName, number | null>, activeTab: TabName): Array<{ tab: TabName; n: number }>
