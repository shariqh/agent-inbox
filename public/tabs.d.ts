export type TabId = 'dashboard' | 'boards' | 'find' | 'agent'

export const TAB_IDS: TabId[]
export const DEFAULT_TAB: TabId

export interface ScopedCounts {
  boards: readonly unknown[]
}

export interface TabCountsInput {
  globalAttention: number
  /** the unread notes in the scope, already counted (spec §8) */
  unreadNotes?: number
  scoped: ScopedCounts
}

export interface TabCounts {
  dashboard: number
  boards: number
  find: number
}

export function tabCounts(input: TabCountsInput): TabCounts
