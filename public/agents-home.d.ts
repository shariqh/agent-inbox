import type { AttentionEntry } from './attention.js'
import type { LaneActivity, LaneBoard } from './lanes.js'
import type { SessionCard } from './sessions.js'

export interface AgentsHomeInput {
  activity: LaneActivity[] | null | undefined
  /** #412: this app's launches, or null with its switch off (§9) */
  launches?: Array<Record<string, any>> | null
  boards?: LaneBoard[]
  attention?: AttentionEntry[]
  closed?: Iterable<string>
  nowMs: number
  /** a forced paint re-sorts the cards (§10 rule 5) */
  forced?: boolean
  /** the sidebar's project lens, named in the card count */
  lensProject?: string | null
  /** the session panel's key, so its card is marked */
  selected?: string | null
}

export interface AgentsHomeLaunches {
  granted(): boolean
  newSession(): { disabled: boolean; note: string } | null
  openNewSession(): void
}

export function installAgentsHome(deps: {
  doc?: Document
  /**
   * The session panel (#454): a card's click toggles it (no part); Review, Message, Transcript and
   * Resume… open it at that part. `key` is a launch card's id, else the card's session.
   */
  openSession: (key: string, part?: 'approval' | 'asks' | 'message' | 'transcript' | 'resume' | null) => void
  /** a card's action on its launch: close, take-over, open-worktree */
  launchAction?: (id: string, action: string) => void
  /** the launch UI while the app's switch is on, else null */
  launches?: () => AgentsHomeLaunches | null
  hasDraft?: (session: string) => boolean
  build?: (row: LaneActivity) => { older: boolean; newer: boolean; hint: string } | null
  projectColor?: (project: string) => string
  /** the one-shot pulse on a new call (#304), where motion is allowed */
  pulse?: (el: Element) => void
  /** the global "Not delivered" fold (#411) */
  paintUndelivered?: (slot: Element) => void
}): {
  /** the Agents home card, made once; renderDashboard mounts it in the Dashboard grid */
  element(): HTMLElement
  paint(host: Element, input: AgentsHomeInput): void
  /** repaints New session… alone, as a start begins or settles */
  paintNewSession(): void
  /** the window-local view state (filter, grouping, folds), for frameInputs() */
  state(): string
  /** the card a session panel key names: a card id, a live session, or a session a launch remembers */
  cardFor(key: string | null | undefined): SessionCard | null
}
