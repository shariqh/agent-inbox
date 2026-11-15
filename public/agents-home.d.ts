import type { AttentionEntry } from './attention.js'
import type { LaneActivity, LaneBoard } from './lanes.js'
import type { SessionCard } from './sessions.js'
import type { MeshAgentsInput } from './mesh-section.js'

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
  /** the Mesh agents section's last `/api/mesh/agents` body, or null to draw none (agent cards view V3) */
  mesh?: MeshAgentsInput | null
}

export interface AgentsHomeLaunches {
  granted(): boolean
  newSession(): { disabled: boolean; note: string } | null
  openNewSession(): void
}

export interface AgentsHomeDeps {
  doc?: Document
  /**
   * The session panel (#454): a card's click toggles it (no part); Enter, Message, Transcript and
   * Resume… open it at that part. `key` is a launch card's id, else the card's session.
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
  /** the Mesh agents section's Refresh: posts `refresh`, then repaints through reloadAndPaint() */
  refreshMesh?: () => void
  /** after the home's own repaints (filters, grouping, folds): the session panel finds its place again */
  afterRepaint?: () => void
  /** the scroll behavior a chip's jump uses (motion.scrollBehavior) */
  scrollBehavior?: () => ScrollBehavior
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
  /** New session… and its note, made once: the page head mounts them (dashboard lanes design §3.1) */
  newSessionElements(): { button: HTMLButtonElement; note: HTMLElement }
  /** the page head's Working and Quiet counts over the main list, or null before the first activity read */
  counts(): { working: number; quiet: number } | null
  /** a lane chip's jump: scrolls the card in and focuses its first shown working (or other) card, else its heading */
  focusFirst(kind: 'working' | 'quiet'): void
  /** the window-local view state (filter, grouping, folds), for frameInputs() */
  state(): string
  /** the card a session panel key names: a card id, a live session, or a session a launch remembers */
  cardFor(key: string | null | undefined): SessionCard | null
  /** the panel key of the card holding an ask (at most one card does), or null */
  askKey(id: string): string | null
}
