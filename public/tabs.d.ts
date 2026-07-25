export type TabId = 'needsYou' | 'boards' | 'live' | 'notes' | 'done'

export const TAB_IDS: TabId[]
export const DEFAULT_TAB: TabId

export interface ScopedCounts {
  boards: readonly unknown[]
  done: readonly unknown[]
  // tabCounts() never reads this — Notes now takes its number from the
  // precomputed `unreadNotes` argument (spec §8) — but callers still pass the
  // scoped note list through for shape symmetry with the rest of `g`, so the
  // field is typed here (optional) to keep those call sites/tests honest.
  notes?: readonly unknown[]
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
