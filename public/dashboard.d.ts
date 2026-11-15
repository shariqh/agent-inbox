import type { RelayBoard, RelayEntry, RelayItem } from './relay.js'
import type { Lane, LaneBoard } from './lanes.js'

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
  /**
   * issue #184: what the paged item snapshot omitted within this lens; #299:
   * the outcomes archived plans carried in brief omit (omittedOutcomes)
   */
  history?: {
    older: { items: number; outcomes: number; latest: string | null; projects: string[]; agents?: string[] }
    archived?: { outcomes: number; latest: string | null }
    /** #184: the page's touch boundary; every item created after it is on the page */
    before?: string | null
  }
  /** #305: the frame's PR index (indexLinks), so Just landed can skip an open ask's open PR */
  links?: Map<string, any> | null
}

export interface DashboardModel {
  signals: {
    waiting: number
    withAgents: number
    plans: number
    outcomes: number
    projects: number
  }
  /** #454 A.2: how many asks wait in Later, for the Needs you lane's "Later N ›" */
  later: number
  waitingEntries: RelayEntry[]
  agentEntries: RelayEntry[]
  /** every loaded outcome, newest first (#307) */
  outcomeEntries: RelayEntry[]
  recentOutcomes: RelayEntry[]
  /** #305: proven outcomes Just landed leaves out because their open PR still waits on you */
  recentOutcomesHidden: number
  /** false while omitted closed history or archived outcomes could still outrank a listed outcome */
  recentOutcomesComplete: boolean
  /** which omitted source, read, would let the list be proven (#184, #299) */
  recentOutcomesWait: { history: boolean; archived: boolean }
  /** #305: the ribbon's ◆ and ● markers, and from when each list is complete */
  marks: {
    asks: RibbonMark[]
    outcomes: RibbonMark[]
    asksAfter: string | null
    outcomesAfter: string | null
    /** #392: the newest outcome archived plans in brief omit, or null */
    archivedAfter: string | null
  }
  /** #304: one lane per working session, in model order (newest call first) */
  lanes: Lane[]
  /** #454: the plans the lanes link (closed projects left out), which the Agents home's cards link too */
  boards: LaneBoard[]
  /** the items in the lens (closed projects left out) */
  items: RelayItem[]
  /** connected sessions with no live claim, folded into "+N idle connections" */
  idleConnections: number
  /** the Needs you lane (dashboard lanes design §3.2): waitingEntries in sortRail order */
  needsYou: RelayEntry[]
}

export interface RibbonMark {
  key: string
  project: string
  at: number
  title: string
  open?: boolean
}

export function buildDashboard(input: DashboardInput): DashboardModel
