// Types for public/issue-key.js (issue #103). Structural on purpose: the viewer
// passes store rows (src/store.ts IssueEntity, SourceLink) and the browser will
// pass the same shapes over the wire.

/** What an item, plan or row says about its own issue (§4.2). */
export interface IssueKeyEntity {
  repo?: string | null
  stream?: string | null
  head_repo?: string | null
  issue_ref?: number | null
  /** PR2: a plan's explicit pin, which outranks its PR and branch issue */
  issue_pin_repo?: string | null
  issue_pin_number?: number | null
  /** PR2: a row's explicit link, its only source */
  issue_repo?: string | null
  issue_number?: number | null
}

/** One cached PR row: the /api/links shape, of which only these fields matter. */
export interface IssueKeyLink {
  repo: string
  branch: string
  head_repo?: string
  issue_number?: number | null
  fetched_at?: string | null
  /** PR1b: every closing reference, bound to the row's fetched_at; stored JSON text or parsed */
  closing_refs?: unknown
}

export type IssueKeySource = 'pin' | 'link' | 'pr' | 'branch'

export interface IssueIdentity {
  /** owner/name#number, the repository lowercased */
  key: string
  source: IssueKeySource
  /** only a certain identity gets relationships */
  certain: boolean
}

export interface IssueKeySetEntity extends IssueKeyEntity {
  kind: 'item' | 'plan' | 'row'
  id: string
  project: string
  project_closed: boolean
  archived: boolean
  stream: string
  updated_at: string
}

export interface IssueDisplayRoot {
  /** also in the refresh set */
  refresh: boolean
  /** the newest updated_at among the entities that link the key */
  updated_at: string
}

export interface IssueKeySets {
  refresh: Set<string>
  display: Map<string, IssueDisplayRoot>
}

export function issueKey(repo: unknown, number: unknown): string | null
export function issueKeyFor(entity: IssueKeyEntity | null, link: IssueKeyLink | null): IssueIdentity | null
export function issueKeySets(entities: IssueKeySetEntity[], links: IssueKeyLink[]): IssueKeySets
