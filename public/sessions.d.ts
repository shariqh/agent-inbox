import type { AttentionEntry } from './attention.js'
import type { LaneActivity, LaneBoard, PlanBar } from './lanes.js'

export type SessionState = 'ask' | 'failed' | 'lost' | 'starting' | 'stopping' | 'working' | 'idle' | 'parked' | 'terminal' | 'ended' | 'dormant'
export type SessionPlace = 'main' | 'ended' | 'earlier' | 'dormant' | 'closed'
export type SessionFilter = 'all' | 'ask' | 'working' | 'idle' | 'parked'

export const FILTERS: ReadonlyArray<readonly [SessionFilter, string]>

export interface SessionCard {
  /** `launch:<id>`, `session:<session>`, or an ask-only card's `ask:session:<id>`, `ask:plan:<id>` or `ask:item:<id>` */
  id: string
  /** the live session a Message goes to, if any */
  session: string | null
  /** every session id the card's asks can name */
  sessions: string[]
  row: LaneActivity | null
  launch: Record<string, any> | null
  status: { state: string; text: string; actions: string[] } | null
  project: string
  branch: string
  agent: string
  /** "Copilot", "Claude Code", or the agent name */
  host: string
  origin: 'started here' | 'terminal' | 'driven' | 'session ended' | 'no session'
  /** #454 A.1: an ask-only card, for an ask whose session no card shows ('ended' when it names one) */
  askOnly?: 'ended' | 'none'
  /** the state before any ask */
  base: Exclude<SessionState, 'ask'>
  state: SessionState
  label: string
  text: string
  historical: boolean
  recency: string
  lastCallAt: string | null
  worktree: string | null
  plan: PlanBar | null
  children: Array<{ name: string; doing: string; state: string }>
  trace: number[] | null
  asks: AttentionEntry[]
  /** this session's answers the agent has not picked up yet: shown in the panel, never counted */
  answered: Array<Record<string, any>>
  /** the first ask is an app session's approval (#412) */
  approval: boolean
  place: SessionPlace
  activeAt: number
}

export function sessionCards(input: {
  activity: LaneActivity[] | null | undefined
  launches?: Array<Record<string, any>> | null
  boards?: LaneBoard[]
  attention?: AttentionEntry[]
  /** the frame's answered-awaiting-pickup entries (relay's `agent`) */
  answered?: Array<Record<string, any>>
  /** the items in the lens, for an ask-only card's "last heard" */
  items?: Array<Record<string, any>>
  closed?: Iterable<string>
  nowMs: number
}): SessionCard[]
export function cardMatches(card: SessionCard, filter: SessionFilter | null | undefined): boolean
export function filterCounts(cards: SessionCard[]): Record<SessionFilter, number>
export function groupCards(cards: SessionCard[], by?: 'project' | 'agent'): Array<{ key: string; label: string; cards: SessionCard[] }>
export function messageHint(row: LaneActivity | null | undefined): string
