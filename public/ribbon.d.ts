import type { DashboardSpan, RibbonMark } from './dashboard.js'

export interface RibbonBar {
  left: number
  width: number
  /** where the static striped "now" tail starts, as a percentage of the bar */
  liveFrom: number | null
  from: string
  to: string
}

export interface RibbonLaneMark {
  kind: 'ask' | 'outcome'
  key: string
  left: number
  open: boolean
  title: string
  at: string
}

export interface RibbonLane {
  project: string
  workMs: number
  live: boolean
  asks: number
  openAsks: number
  outcomes: number
  bars: RibbonBar[]
  marks: RibbonLaneMark[]
}

export interface Ribbon {
  totalMs: number
  startMs: number
  endMs: number
  /** percentage before which markers are not drawn, or null */
  marksFrom: number | null
  /** the same floor as a time: markers before it are not drawn (omitted history or the marker budget) */
  marksFromAt: string | null
  /** projects past the lane budget */
  more: number
  lanes: RibbonLane[]
}

export function buildRibbon(input: {
  spans: Array<DashboardSpan & { project?: string }> | null | undefined
  asks?: RibbonMark[]
  outcomes?: RibbonMark[]
  startMs: number
  endMs: number
  marksAfter?: string | null
}): Ribbon

export function sinceLastLooked(input: {
  sinceMs: number
  untilMs: number
  asks?: RibbonMark[]
  outcomes?: RibbonMark[]
  asksAfter?: string | null
  outcomesAfter?: string | null
  spans?: Array<DashboardSpan & { project?: string }> | null
}): string | null

/** #305 review: true while the human is reading the "Since you last looked" line */
export function sinceKeepsOn(
  event: { metaKey?: boolean; ctrlKey?: boolean; target?: EventTarget | null } | null | undefined,
  line: Node,
  selection: { anchorNode?: Node | null } | null | undefined,
): boolean

/** true only for input the browser itself produced (`event.isTrusted`) */
export function trustedInput(event: { isTrusted?: boolean } | null | undefined): boolean
