import type { AttentionEntry } from './attention.js'

export const NEEDS_YOU_EMPTY: 'Nothing in this view is waiting on you.'

/** the ask's id: a plan row's, else the item's (app.js needsEntryId) */
export function laneAskId(entry: AttentionEntry): string

export interface NeedsYouLaneInput {
  /** the attention set under the Dashboard's lens, in sortRail order */
  entries: AttentionEntry[]
  /** how many asks wait in Later: the header's "Later N ›", shown only above 0 */
  later: number
  nowMs: number
}

export interface NeedsYouLaneDeps {
  doc?: Document
  /** a card's click or Enter: the ask in the Inbox's detail panel (app.js jumpToAsk) */
  open(entry: AttentionEntry): void
  /** "Later N ›": the Inbox's Later section */
  openLater?(): void
  /** "Review queue": the triage deck */
  openReview?(): void
  projectColor?(project: string): string
  /** "session ended" or "no session" for an ask no session card holds, else '' (§6) */
  sessionTag?(entry: AttentionEntry): '' | 'session ended' | 'no session'
  scrollBehavior?(): ScrollBehavior
}

export function installNeedsYouLane(deps: NeedsYouLaneDeps): {
  /** the lane, made once; renderDashboard mounts it above the Dashboard grid */
  element(): HTMLElement
  paint(input: NeedsYouLaneInput): void
  /** the Needs you chip: scrolls the lane in and focuses its first card, else its heading */
  focusFirst(): void
  /** focuses one ask's card, moving the roving stop to it; false when the lane does not show it */
  focusAsk(id: string, opts?: { scroll?: boolean }): boolean
}
