import type { AttentionEntry } from './attention.js'

export interface LaneActivity {
  session: string
  project: string
  stream?: string
  agent: string
  doing?: string
  detail?: string
  idle?: boolean
  children?: Array<{ name?: string; doing?: string }>
  started_at?: string
  updated_at?: string
  last_call_at?: string | null
  calls?: number[]
  calls_at?: number
  [key: string]: unknown
}

export interface LaneBoard {
  id: string
  project: string
  stream?: string
  agent?: string
  title: string
  updated_at?: string
  session?: string | null
  progress?: { done: number; partial: number; countable: number; [key: string]: number }
  rows?: Array<Record<string, any>>
  [key: string]: unknown
}

export interface PlanBar {
  id: string
  title: string
  done: number
  countable: number
  segments: { done: number; partial: number; waiting: number; todo: number }
}

export interface Lane {
  session: string
  project: string
  branch: string
  agent: string
  doing: string
  detail: string
  lastCallAt: string
  sinceMs: number
  quiet: boolean
  children: Array<{ name: string; doing: string }>
  plan: PlanBar | null
  /** MCP calls a minute over the last 30 minutes, oldest first (#306) */
  trace: number[]
  asks: AttentionEntry[]
  /** the lane's oldest ask, while any waits on the human */
  waiting: { entry: AttentionEntry; ms: number } | null
}

export interface NowStrip {
  working: number
  subagents: number
  waiting: number
  oldestWaitingMs: number | null
  plans: { done: number; countable: number }
}

export const QUIET_MS: number
export const MAX_LANES: number
export function isWorking(row: LaneActivity, nowMs: number): boolean
export function linkedPlan<B extends LaneBoard>(row: LaneActivity, boards: B[], present?: Set<string>): B | null
export const TRACE_MINUTES: number
export function callTrace(row: LaneActivity, nowMs: number): number[]
export function tracePath(trace: number[]): string
export function planBar(board: LaneBoard, nowMs: number): PlanBar
export function buildLanes(input: {
  activity: LaneActivity[]
  boards: LaneBoard[]
  asks: AttentionEntry[]
  nowMs: number
}): { lanes: Lane[]; idle: number; now: NowStrip }
export function pinLaneOrder(previous: string[], lanes: Array<{ session: string }>): string[]
export function calledLanes(previous: Map<string, string>, drawn: Lane[]): { pulse: Set<string>; sweep: string | null }
