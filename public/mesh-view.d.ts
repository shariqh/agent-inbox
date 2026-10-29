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
  nowMs: number
}): MeshAgentGroup[]
export function sessionRecency(session: MeshSession): string
export function installMeshView(options: { doc?: Document; jumpToAsk: (entry: AttentionEntry) => void }): {
  paint(host: Element, input: { activity: LaneActivity[]; attention: AttentionEntry[]; closed?: Iterable<string>; nowMs: number }): void
  renderSettings(host: Element | null): void
  /** the window-local lens, for frameInputs() */
  lens(): 'sessions' | 'agents'
}
