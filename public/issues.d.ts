// Types for public/issues.js (issue #103, PR3). Structural on purpose: the
// viewer passes /api/items, /api/boards and /api/links rows, the attention
// entries public/attention.js computed, and the /api/issues body as it arrived.
import type { CachedLink } from './source.js'
import type { IssueKeyEntity } from './issue-key.js'

/** No successful fetch for this long dims relationships (§5.8). */
export const STALE_AFTER_MS: number
/** No successful fetch for this long hides them, leaving the plain chip. */
export const HIDDEN_AFTER_MS: number

export type IssueMark = 'open' | 'completed' | 'not planned' | 'duplicate' | 'closed'

/** One issue the view draws, validated against its own key. */
export interface IssueNodeView {
  /** canonical owner/name#number, the repository lowercased */
  key: string
  /** GitHub's casing of nameWithOwner */
  repo: string
  number: number
  title: string
  state: 'OPEN' | 'CLOSED'
  mark: IssueMark
  /** GitHub's sub-issue counts, only where an observation carried them */
  total?: number
  completed?: number
}

/**
 * fresh and stale draw relationships; hidden (expired), no-hierarchy (GitHub
 * returned the issue without its parent or sub-issues) and unavailable (a hard
 * failure) draw the plain chip and one line saying why.
 */
export type IssueFreshness = 'fresh' | 'stale' | 'hidden' | 'no-hierarchy' | 'unavailable'

/** The item, plan or plan row an activity label opens. */
export interface IssueTarget {
  id: string
  rowId?: string
}

/** Agent Inbox activity for one sub-issue (§7.3): local work only, never a GitHub assignee. */
export interface IssueActivity {
  kind: 'waiting' | 'active' | 'done' | 'none'
  label: string
  target: IssueTarget | null
}

export interface IssueChildView {
  node: IssueNodeView
  activity: IssueActivity
}

/** Everything the chips and blocks draw for one key an entity links. */
export interface IssueRelation {
  /** the key the entity asked for; `node.key` is its canonical answer */
  key: string
  freshness: IssueFreshness
  /** the root's last error code, soft or hard */
  error: string | null
  /** start of the attempt behind the cached answer; null after a hard failure */
  fetchedAt: string | null
  /** fresh and stale only */
  node: IssueNodeView | null
  /** ancestors, top first; the last is the immediate parent */
  trail: IssueNodeView[]
  /** in GitHub's order */
  children: IssueChildView[]
  more: { notVisible: number; onGitHub: number; notShown: number }
  /**
   * GitHub dependencies (slice 2 §9.1), fresh and stale only: null when the
   * section is unknown or the relation does not draw, never "no dependencies".
   */
  dependencies: IssueDependenciesView | null
}

/** The OPEN issues on one side that the list cannot show. */
export interface IssueDependencyMore {
  /** counted by GitHub but not visible to this account */
  notVisible: number
  /** beyond GitHub's page */
  onGitHub: number
}

export type IssueDependenciesView =
  | { status: 'unavailable' }
  | {
      status: 'ok'
      /** open blockers, by repository and number */
      waitsOn: IssueChildView[]
      /** open dependents, by repository and number */
      unblocks: IssueChildView[]
      /** a GitHub cycle touches this issue */
      cycle: boolean
      /** `notShown`: entries the node cap cut, either side */
      more: { waitsOn: IssueDependencyMore; unblocks: IssueDependencyMore; notShown: number }
    }

/** One thing a plan or row waits on: a step of its plan, an open GitHub issue, or both at once. */
export interface IssueWaitEntry {
  step: { id: string; label: string } | null
  node: IssueNodeView | null
  /** the GitHub relation's age; null for a step alone */
  freshness: 'fresh' | 'stale' | null
  fetchedAt: string | null
  sources: Array<'step' | 'github'>
}

export interface IssueView {
  relations: Map<string, IssueRelation>
  /** plan id → its issue's open blockers */
  planWaits: Map<string, IssueWaitEntry[]>
  /** row id → its unfinished waits_on steps and its issue's open blockers */
  rowWaits: Map<string, IssueWaitEntry[]>
}

export interface IssueViewItem extends IssueKeyEntity {
  id: string
  project?: string
  agent?: string
  kind?: string
  title?: string
  status?: string
  created_at?: string
  updated_at?: string | null
}

export interface IssueViewRow {
  id: string
  label?: string
  status?: string
  issue_repo?: string | null
  issue_number?: number | null
  updated_at?: string | null
  /** labels of other rows of the same plan (slice 2 §4) */
  waits_on?: readonly string[]
}

export interface IssueViewPlan extends IssueKeyEntity {
  id: string
  project?: string
  agent?: string
  title?: string
  status?: string
  updated_at?: string | null
  rows?: IssueViewRow[]
}

export type IssueViewAttention =
  | { kind: 'item'; item: IssueViewItem; liveness?: string }
  | { kind: 'row'; row: IssueViewRow; board: IssueViewPlan }

export interface IssueViewContext {
  items?: readonly IssueViewItem[]
  boards?: readonly IssueViewPlan[]
  archived?: readonly IssueViewPlan[]
  links?: Map<string, CachedLink> | null
  /** the attention entries the render computed; read, never changed */
  attention?: readonly IssueViewAttention[]
  nowMs?: number
}

export function buildIssueView(graph: unknown, context?: IssueViewContext): IssueView

/** Slice 2 §7: two or more active plans of one project under one GitHub parent. */
export interface PlanGroup {
  /** project and parent key: plans of different projects never share one */
  key: string
  project: string
  /** the shared parent, with GitHub's sub-issue counts when known */
  parent: IssueNodeView
  /** how many plans the group holds */
  size: number
  /** every member's relation is stale: the header is dimmed with "as of …" */
  stale: boolean
  /** the oldest member's fetch, for that "as of" */
  fetchedAt: string | null
  /** the repository the parent's label is read against */
  against: string | null
}

/** Today's plans, each once, with groups gathered at their first member's place. */
export function planGroups<P extends IssueViewPlan>(
  plans: readonly P[],
  view: IssueView | null,
  links: Map<string, CachedLink> | null,
): { plans: P[]; groupOf: Map<string, PlanGroup> }

/** Row id → the parent its run starts under; empty unless rows span two parents. */
export function rowParentRuns(rows: readonly IssueViewRow[], view: IssueView | null): Map<string, IssueNodeView>
