import type { AttentionEntry } from './attention.js'
import type { LaneActivity, LaneBoard, PlanBar } from './lanes.js'

export type SessionState = 'failed' | 'lost' | 'starting' | 'stopping' | 'working' | 'idle' | 'parked' | 'terminal' | 'ended' | 'dormant'
export type SessionPlace = 'main' | 'ended' | 'earlier' | 'dormant' | 'closed'
export type SessionLane = 'working' | 'quiet'

export interface SessionCard {
  /** `launch:<id>` or `session:<session>` */
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
  origin: 'started here' | 'terminal' | 'driven'
  /** the card's own state; asks never change it (dashboard lanes design §3.3) */
  base: SessionState
  /** the same as `base` */
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
  /** the asks this card holds, in sortRail order: the Needs you lane shows them, the card counts them */
  asks: AttentionEntry[]
  /** this session's answers the agent has not picked up yet: shown in the panel, never counted */
  answered: Array<Record<string, any>>
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
  closed?: Iterable<string>
  nowMs: number
}): SessionCard[]
/** the lane a card is in: Working, Quiet, or null for a fold (dashboard lanes design §3.3, §3.4) */
export function laneOf(card: SessionCard): SessionLane | null
/** the main cards split into the two lanes, each in input order */
export function splitLanes(cards: SessionCard[]): { working: SessionCard[]; quiet: SessionCard[] }
/** the page head's Working and Quiet chips: the two lanes' sizes (dashboard lanes design §3.1) */
export function laneCounts(cards: SessionCard[]): { working: number; quiet: number }
/** "Copilot", "Claude Code", or the agent name */
export function hostLabel(agent: string): string
/** the Working lane's project groups, each where its first card is */
export function groupCards(cards: SessionCard[]): Array<{ key: string; label: string; cards: SessionCard[] }>
export function messageHint(row: LaneActivity | null | undefined): string
