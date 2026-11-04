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
}

export interface AgentsHomeLaunches {
  granted(): boolean
  newSession(): { disabled: boolean; note: string } | null
  openNewSession(): void
}

export function installAgentsHome(deps: {
  doc?: Document
  /** the lanes' own: opens an ask on the rail or in the Inbox */
  jumpToAsk: (entry: AttentionEntry) => void
  /** #411: open this session's message composer, focused */
  openMessage: (session: string) => void
  /** a click on a card that is not on a control */
  openSession?: (card: SessionCard) => void
  /** a card's action on its launch: transcript, close, take-over, open-worktree, resume */
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
  paint(host: Element, input: AgentsHomeInput): void
  /** the window-local view state (lens, filter, grouping, folds), for frameInputs() */
  state(): string
}
