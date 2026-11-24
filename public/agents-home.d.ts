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
  closed?: Iterable<string>
  nowMs: number
  /** a forced paint re-sorts each lane, unless the pointer or the keyboard is in it (dashboard lanes design §3.3) */
  forced?: boolean
  /** the session panel's key, so its card is marked */
  selected?: string | null
  /** launches the project and agent lens hides that are not ended (#454) */
  outside?: number
}

export interface AgentsHomeLaunches {
  granted(): boolean
  newSession(): { disabled: boolean; note: string } | null
  openNewSession(): void
}

export interface AgentsHomeDeps {
  doc?: Document
  /** #617 PR 4b: Open desk (public/desk-open.js); a card shows its button only while `available()` says so */
  deskOpen?: () => import('./desk-open.js').DeskOpen | null
  /**
   * The session panel (#454): a card's or row's click toggles it (no part); Enter and Open open it
   * at its head, Message, Transcript and Resume… at that part. `key` is a launch card's id, else
   * the card's session.
   */
  openSession: (key: string, part?: 'approval' | 'asks' | 'message' | 'transcript' | 'resume' | 'head' | null, ask?: string | null) => void
  /** the "Asking you · N" chip: the session's first ask in the Needs you lane, by its id (dashboard lanes design §3.3) */
  showAsk?: (id: string | null) => void
  /** a card's action on its launch: close, take-over, open-worktree */
  launchAction?: (id: string, action: string) => void
  /** the launch UI while the app's switch is on, else null */
  launches?: () => AgentsHomeLaunches | null
  hasDraft?: (session: string) => boolean
  projectColor?: (project: string) => string
  /** the one-shot pulse on a new call (#304), where motion is allowed */
  pulse?: (el: Element) => void
  /** the global "Not delivered" fold (#411) */
  paintUndelivered?: (slot: Element) => void
  /** clears the project and agent lens ("N sessions outside this filter · Show all") */
  showAll?: () => void
  /** after the lanes' own repaints (the folds): the session panel finds its place again */
  afterRepaint?: () => void
  /** the scroll behavior a chip's jump uses (motion.scrollBehavior) */
  scrollBehavior?: () => ScrollBehavior
}

/** moves `node` with `move()`, giving back the focus (and a text control's selection) it held, in a focused window */
export function moveKeepingFocus(node: Element, move: () => void): void

/** Working's first-run message, with no session at all */
export const SESSIONS_EMPTY: string
/** a lane's one quiet line when it has nothing (dashboard lanes design §3.3, §3.4) */
export const WORKING_EMPTY: string
export const QUIET_EMPTY: string
/** Working's line before the first /api/activity read */
export const READING: string

export function installAgentsHome(deps: AgentsHomeDeps): {
  /** the Working and Quiet lanes in one wrapper, made once; renderDashboard mounts it in the Dashboard grid */
  element(): HTMLElement
  paint(host: Element, input: AgentsHomeInput): void
  /** repaints the cards from the last paint's input (a closed panel's draft shows on its card at once) */
  repaint(overrides?: Partial<AgentsHomeInput>): void
  /** repaints New session… alone, as a start begins or settles */
  paintNewSession(): void
  /** New session… and its note, made once: the page head mounts them (dashboard lanes design §3.1) */
  newSessionElements(): { button: HTMLButtonElement; note: HTMLElement }
  /** the page head's Working and Quiet counts, each its lane's size, or null before the first activity read */
  counts(): { working: number; quiet: number } | null
  /** a lane chip's jump: scrolls its lane in and focuses the lane's first card or row, else its heading */
  focusFirst(kind: 'working' | 'quiet'): void
  /** the heading of the lane a panel key's card is in: Quiet for a row or a fold's card, else Working */
  laneTitle(key?: string | null): HTMLElement | null
  /** the window-local view state (the open folds), for frameInputs() */
  state(): string
  /** the card a session panel key names: a card id, a live session, or a session a launch remembers */
  cardFor(key: string | null | undefined): SessionCard | null
  /** the panel key of the card holding an ask (at most one card does), or null */
  askKey(id: string): string | null
}
