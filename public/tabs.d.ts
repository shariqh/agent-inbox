export type TabId = 'needsYou' | 'boards' | 'live' | 'notes' | 'done'

export const TAB_IDS: TabId[]
export const DEFAULT_TAB: TabId

export interface ScopedCounts {
  boards: readonly unknown[]
  done: readonly unknown[]
}

export interface TabCountsInput {
  globalAttention: number
  unreadNotes?: number
  scoped: ScopedCounts
}

export interface TabCounts {
  needsYou: number
  boards: number
  live: null
  notes: number
  done: number
}

export function tabCounts(input: TabCountsInput): TabCounts

export interface LiveActivity {
  idle?: boolean
  session?: string
  [key: string]: unknown
}

export function livePresence(activity: readonly LiveActivity[] | undefined): boolean
