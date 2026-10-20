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

export type IssueFreshness = 'fresh' | 'stale' | 'hidden' | 'unavailable'

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
}

export interface IssueView {
  relations: Map<string, IssueRelation>
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
