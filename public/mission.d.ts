import type { IssueActivity, IssueNodeView, IssueView } from './issues.js'
import type { CachedLink } from './source.js'
import type { IssueKeyEntity } from './issue-key.js'

export interface MissionRow {
  id: string
  label: string
  status: 'done' | 'partial' | 'missing' | 'tracked' | 'na' | 'blocked'
  action_owner?: 'decision' | 'task' | 'approval' | null
  note?: string
  impact?: string
  next_after?: string
  outcome?: string
  issue_repo?: string | null
  issue_number?: number | null
  waits_on?: readonly string[]
}

export interface MissionBoard extends IssueKeyEntity {
  id: string
  title: string
  project: string
  progress: { done: number; countable: number; fraction: number }
  rows: MissionRow[]
}

/** The frame's issue view and links; the flow never fetches. */
export interface MissionDeps {
  issues: IssueView | null
  links: Map<string, CachedLink> | null
}

/** A step of this plan, or an open GitHub issue no row of this plan links. */
export type MissionDep =
  | {
      kind: 'step'
      rowId: string
      label: string
      /** the step's own linked issue, if any */
      issue: { repo: string; number: number } | null
      sources: Array<'step' | 'github'>
    }
  | { kind: 'issue'; node: IssueNodeView; activity: IssueActivity | null; freshness: 'fresh' | 'stale' | null }

export interface MissionPath {
  row: MissionRow
  result: { kind: 'next' | 'outcome'; text: string } | null
  waitsOn: MissionDep[]
  unblocks: MissionDep[]
  /** the step's GitHub parent, where it differs from the plan's own issue */
  partOf: { node: IssueNodeView; freshness: 'fresh' | 'stale' } | null
  /** on a GitHub cycle or a local waits_on cycle */
  circular: boolean
}

export function buildMission(board: MissionBoard, deps?: MissionDeps | null): {
  root: { id: string; title: string; project: string; progress: string }
  paths: MissionPath[]
  /** the plan issue's children that no row links */
  outside: { list: Array<{ node: IssueNodeView; activity: IssueActivity }>; freshness: 'fresh' | 'stale' } | null
}
