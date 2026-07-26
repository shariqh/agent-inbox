export interface RailProjected {
  project?: string
}

export interface RailActivity {
  session?: string
  project?: string
}

export interface RailSources {
  items?: RailProjected[]
  boards?: RailProjected[]
  archived?: RailProjected[]
  activity?: RailActivity[]
}

export interface RailEntry {
  key: string
  label: string
  total: number
  escalated: number
  unknown: boolean
}

export const RAIL_FILTER_THRESHOLD: number

export function railProjects(sources?: RailSources): string[]
export function railEntries(
  projects: string[],
  counts: Map<string, { total: number; escalated: number }>,
): RailEntry[]
export function shouldShowRailFilter(projects?: readonly unknown[]): boolean
export function filterRailEntries(entries: RailEntry[], query: string | undefined): RailEntry[]

export type ClosedProjects = Set<string> | readonly string[]

export interface ClosedFoldLabel {
  /** the summary's own text — 'Closed (2)', or the bare count at narrow width */
  text: string
  /** the 'N muted' chip, or '' when the fold holds no attention */
  muted: string
  /** the full sentence, for the summary's title attribute */
  hint: string
}

export function splitClosed(
  projects: string[],
  closed?: ClosedProjects,
): { open: string[]; closed: string[] }
export function closedRailEntries(
  closed: string[],
  counts: Map<string, { total: number; escalated: number }>,
): RailEntry[]
export function suppressedTotal(entries?: readonly RailEntry[]): number
export function closedFoldLabel(
  count: number,
  suppressed?: number,
  mode?: 'wide' | 'narrow',
): ClosedFoldLabel | null
