import type { AttentionEntry } from './attention.js'
import type { LaneActivity } from './lanes.js'

export type MeshSessionState = 'working' | 'idle' | 'dormant'

export interface MeshSession {
  session: string
  project: string
  branch: string
  state: MeshSessionState
  text: string
  historical: boolean
  /** whether the session has made a real MCP call (`last_call_at`) */
  called: boolean
  /** since the last real call, or the start before the first; null when neither is known */
  sinceMs: number | null
  /** #412: an Agent Inbox driver runs it */
  driven: boolean
  /** #412: a session of a launch this app started (the app's switch on) */
  startedHere: boolean
}

export interface MeshAgentGroup {
  agent: string
  sessions: MeshSession[]
  working: number
  /** MCP calls a minute over the last 30 minutes, summed over the sessions */
  trace: number[]
  /** this kind's asks, read from the frame's attention entries, in rail order */
  asks: AttentionEntry[]
}

export function agentGroups(input: {
  activity: LaneActivity[]
  attention: AttentionEntry[]
  closed?: Iterable<string>
  /** #412: the sessions of this app's launches, with its switch on */
  startedHere?: Iterable<string>
  nowMs: number
}): MeshAgentGroup[]
export function sessionRecency(session: MeshSession): string
export function installAgentsHome(options: {
  doc?: Document
  jumpToAsk: (entry: AttentionEntry) => void
  /** #411: open the Live drawer with this session's message composer, focused */
  openMessage?: (session: string) => void
}): {
  paint(host: Element, input: { activity: LaneActivity[]; attention: AttentionEntry[]; closed?: Iterable<string>; startedHere?: Iterable<string>; nowMs: number }): void
  /** the window-local lens, for frameInputs() */
  lens(): 'sessions' | 'agents'
}
