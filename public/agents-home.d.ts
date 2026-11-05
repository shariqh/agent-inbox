import type { AttentionEntry } from './attention.js'
import type { LaneActivity, LaneBoard } from './lanes.js'
import type { SessionCard } from './sessions.js'

export interface AgentsHomeInput {
  activity: LaneActivity[] | null | undefined
  /** #412: this app's launches, or null with its switch off (§9) */
  launches?: Array<Record<string, any>> | null
  boards?: LaneBoard[]
  attention?: AttentionEntry[]
  answered?: Array<Record<string, any>>
  items?: Array<Record<string, any>>
  closed?: Iterable<string>
  nowMs: number
  /** a forced paint re-sorts the cards (§10 rule 5) */
  forced?: boolean
  /** the sidebar's project lens, named in the card count */
  lensProject?: string | null
  /** the session panel's key, so its card is marked */
  selected?: string | null
  /** launches the project and agent lens hides that are not ended (#454) */
  outside?: number
  /** how many asks wait in Later: the header's "Later N ›" (#454 A.2) */
  later?: number
}

export interface AgentsHomeLaunches {
  granted(): boolean
  newSession(): { disabled: boolean; note: string } | null
  openNewSession(): void
}

export interface AgentsHomeDeps {
  doc?: Document
  /**
   * The session panel (#454): a card's click toggles it (no part); Review, Message, Transcript and
   * Resume… open it at that part, and Answer or the ask strip at that ask (`ask`, its id). `key` is a launch or
   * ask-only card's id, else the card's session.
   */
  openSession: (key: string, part?: 'approval' | 'asks' | 'message' | 'transcript' | 'resume' | 'head' | null, ask?: string | null) => void
  /** an ask-only card's Open in Inbox (#454 A.1) */
  openInInbox?: (entry: AttentionEntry | undefined) => void
  /** whether an ask holds an unsent answer: its card says "Answer · draft" */
  hasAskDraft?: (id: string | null) => boolean
  /** a card's action on its launch: close, take-over, open-worktree */
  launchAction?: (id: string, action: string) => void
  /** the launch UI while the app's switch is on, else null */
  launches?: () => AgentsHomeLaunches | null
  hasDraft?: (session: string) => boolean
  /** the header's "Later N ›" and Review queue (#454 A.2) */
  openLater?: () => void
  openReview?: () => void
  projectColor?: (project: string) => string
  /** the one-shot pulse on a new call (#304), where motion is allowed */
  pulse?: (el: Element) => void
  /** the global "Not delivered" fold (#411) */
  paintUndelivered?: (slot: Element) => void
  /** clears the project and agent lens ("N sessions outside this filter · Show all") */
  showAll?: () => void
  /** after the home's own repaints (filters, grouping, folds): the session panel finds its place again */
  afterRepaint?: () => void
}

/** moves `node` with `move()`, giving back the focus (and a text control's selection) it held, in a focused window */
export function moveKeepingFocus(node: Element, move: () => void): void

export function installAgentsHome(deps: AgentsHomeDeps): {
  /** the Agents home card, made once; renderDashboard mounts it in the Dashboard grid */
  element(): HTMLElement
  paint(host: Element, input: AgentsHomeInput): void
  /** repaints the cards from the last paint's input (a closed panel's draft shows on its card at once) */
  repaint(overrides?: Partial<AgentsHomeInput>): void
  /** repaints New session… alone, as a start begins or settles */
  paintNewSession(): void
  /** the window-local view state (filter, grouping, folds), for frameInputs() */
  state(): string
  /** the card a session panel key names: a card id, a live session, or a session a launch remembers */
  cardFor(key: string | null | undefined): SessionCard | null
  /** shows one state filter and lands on the Agents heading (the Now strip's Waiting on you) */
  showFilter(key: string): void
  /** the panel key of the card holding an ask (every attention entry is on exactly one card), or null */
  askKey(id: string): string | null
}
