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
