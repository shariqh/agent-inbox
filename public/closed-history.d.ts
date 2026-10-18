export interface ClosedHistoryGroup {
  project: string
  agent: string
  items: number
  outcomes: number
}

export interface ClosedHistorySummary {
  total: number
  loaded: number
  before: string | null
  older: ClosedHistoryGroup[]
}

export interface HistoryItem {
  id: string
  project?: string
  kind?: string
  status?: string
  created_at: string
  [key: string]: unknown
}

export interface HistoryPage<T extends HistoryItem> {
  needsYou: Array<{ project: string; items: T[] }>
  notes: Array<{ project: string; items: T[] }>
  done: T[]
  history?: ClosedHistorySummary | null
}

export interface OlderHistory {
  items: number
  outcomes: number
  projects: string[]
  agents: string[]
}

export function mergeClosedHistory<T extends HistoryItem, P extends HistoryPage<T>>(g: P, done: T[]): P
export function olderHistory(
  summary: ClosedHistorySummary | null | undefined,
  lens?: { project?: string | null; agent?: string | null; hidden?: Set<string> | string[] },
): OlderHistory
export function knownHistory<T extends HistoryItem>(done: T[], before: string | null | undefined): T[]
export function knownOutcomes<T extends { item?: object; row?: object }>(outcomes: T[], before: string | null | undefined): T[]
