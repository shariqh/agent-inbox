import type { RelayBoard, RelayEntry, RelayItem } from './relay.js'

export interface DashboardActivity {
  session: string
  project: string
  agent: string
  doing?: string
  last_doing?: string
  idle?: boolean
  started_at?: string
  updated_at?: string
  last_call_at?: string | null
  [key: string]: unknown
}

export interface DashboardSpan {
  session: string
  started_at: string
  ended_at?: string | null
  effective_ended_at?: string | null
}

export interface DashboardInput {
  items: RelayItem[]
  boards: RelayBoard[]
  archived: RelayBoard[]
  activity: DashboardActivity[]
  nowMs: number
  liveSessionIds: Set<string> | string[]
  closedProjects?: Set<string> | string[]
}

export interface DashboardModel {
  signals: {
    agents: { working: number; quiet: number; total: number; reportedChildren: number }
    waiting: number
    withAgents: number
    plans: number
    outcomes: number
    projects: number
  }
  ownership: { human: number; agent: number; outcome: number }
  waitingEntries: RelayEntry[]
  agentEntries: RelayEntry[]
  recentOutcomes: RelayEntry[]
  sessions: Array<DashboardActivity & {
    synopsis: string
    historical: boolean
    lastActiveAt: string | undefined
  }>
}

export interface ActivityBucket {
  startAt: string
  endAt: string
  activeMs: number
  sessions: number
}

export function buildDashboard(input: DashboardInput): DashboardModel
export function buildActivitySeries(
  spans: DashboardSpan[],
  range: { startMs: number; endMs: number; bucketCount: number },
): { hasHistory: boolean; totalActiveMs: number; buckets: ActivityBucket[] }
