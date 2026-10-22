// Types for public/source.js (issue #30). Deliberately a LOCAL entity shape
// rather than an extension of card.d.ts's CardItem — items and boards both feed
// these builders, and keeping card.d.ts out of the graph keeps them independent.
import type { IssueNodeView, IssueView, IssueViewRow, PlanGroup } from './issues.js'
import type { buildMission, MissionPath } from './mission.js'

export interface LinkedEntity {
  project?: string
  stream?: string | null
  repo?: string | null
  issue_ref?: number | null
  /** issue #157 — where the branch is pushed; absent/null means `repo` itself */
  head_repo?: string | null
  /** issue #103 PR2 — a plan's explicit pin, which outranks its PR and branch issue */
  issue_pin_repo?: string | null
  issue_pin_number?: number | null
}

/** One cached /api/links row — the store's SourceLink, over the wire. */
export interface CachedLink {
  repo: string
  branch: string
  head_repo: string
  provider: string
  pr_number: number | null
  pr_url: string | null
  pr_title: string | null
  pr_state: string | null
  pr_head_sha: string | null
  pr_draft: boolean
  review_decision: string | null
  checks: string | null
  issue_number: number | null
  issue_url: string | null
  issue_title: string | null
  preview_url: string | null
  preview_environment: string | null
  preview_deployment_id: number | null
  preview_updated_at: string | null
  preview_error: string | null
  tldr: string | null
  fetched_at: string | null
  checked_at: string
  error: string | null
  revision: number
  /** issue #103 PR1b — every closing reference, bound to fetched_at; JSON text or parsed */
  closing_refs?: unknown
}

export type ChipTone = 'merged' | 'good' | 'bad' | 'neutral' | 'muted' | 'issue'

export interface PrChip {
  text: string
  word: string
  glyph: string
  tone: ChipTone
}

export interface IssueRef {
  num: number
  url: string
  title: string
  /** owner/name#number, the repository lowercased; null for a number with no usable repository */
  key: string | null
  /** the repository the number belongs to, as shown; null when unknown */
  repo: string | null
  /** only a certain identity gets relationships (#103 §4.2) */
  certain: boolean
}

export interface PreviewRef {
  url: string
  environment: string
  headSha: string
  deploymentId: number
}

export interface SourceOptions {
  tabbable?: boolean
  preview?: boolean
  /** issue #103 PR3 — the frame's sub-issue view; absent or null draws plain chips */
  issues?: IssueView | null
  /** a plan row drawn for its plan: its own issue link, when it has one, replaces the plan's */
  row?: IssueViewRow | { id: string } | null
}

export interface PrDetail {
  chip: PrChip
  title: string
  tldr: string
  url: string
  checked: string
  error: string
}

export function linkKey(repo: string, branch: string, head?: string): string
export function indexLinks(links: CachedLink[] | null | undefined): Map<string, CachedLink>
export function linkFor(index: Map<string, CachedLink> | null, entity: LinkedEntity | null): CachedLink | null
export function safeHttpUrl(url: unknown): string
export function textLinkHtml(url: unknown, label: unknown, kind?: 'web' | 'pr' | 'issue'): string
/** issue #300 — a local file as an inert control carrying its path; never an href */
export function fileLinkHtml(path: unknown, label: unknown, title?: unknown): string

/** issue #300 — one chip of a card's Links strip */
export interface StripLink {
  kind: 'web' | 'pr' | 'issue' | 'file'
  label: string
  title?: string
  url?: string
  path?: string
}
export function linkStripHtml(links: StripLink[] | null | undefined, opts?: { key?: string; open?: boolean }): string
export function issueRef(entity: LinkedEntity | null, link: CachedLink | null, row?: IssueViewRow | { id: string } | null): IssueRef | null
export const PREVIEW_TTL_MS: number
export function previewRef(link: CachedLink | null | undefined, nowMs: number): PreviewRef | null
export function prChip(link: CachedLink | null): PrChip | null
export function prDetail(link: CachedLink | null, nowMs: number): PrDetail | null
export function sourceTooltip(entity: LinkedEntity | null, link: CachedLink | null, nowMs: number, opts?: SourceOptions): string
export function sourceChipsHtml(
  index: Map<string, CachedLink> | null,
  entity: LinkedEntity | null,
  nowMs: number,
  opts?: SourceOptions,
): string
export function sourceBlockHtml(
  index: Map<string, CachedLink> | null,
  entity: LinkedEntity | null,
  nowMs: number,
  opts?: SourceOptions,
): string
/** issue #103 PR3 — a plan row's own issue chips for its matrix note cell; '' for a row with no link */
export function rowIssueChipsHtml(
  row: IssueViewRow | { id: string } | null,
  plan: LinkedEntity | null,
  nowMs: number,
  opts?: SourceOptions,
): string
/** issue #103 PR3 — a plan card's parent trail and sub-issues; '' when there is nothing to draw */
export function issueRelationsHtml(
  index: Map<string, CachedLink> | null,
  entity: LinkedEntity | null,
  nowMs: number,
  opts?: SourceOptions,
): string
/** slice 2 §7.5 — the heading over one group of plans under a shared GitHub parent */
export function planGroupHeadHtml(group: PlanGroup, nowMs: number, opts?: { continued?: boolean }): string
/** slice 2 §7.1 — "Part of #117" over a run of a plan's rows */
export function rowParentHeadHtml(parent: IssueNodeView, plan: LinkedEntity | null): string
/** slice 2 §9.1 — "waits on …" after a row's issue chip; '' when it waits on nothing open */
export function rowWaitsChipHtml(
  row: IssueViewRow | { id: string } | null,
  plan: (LinkedEntity & { id?: string }) | null,
  nowMs: number,
  opts?: SourceOptions,
): string
/** slice 2 §9.1 — "waits on …" beside a plan's own issue chip */
export function planWaitsChipHtml(plan: (LinkedEntity & { id: string }) | null, nowMs: number, opts?: SourceOptions): string
/** slice 2 §9.1 — the row detail's "Waits on" block, each target with its source */
export function rowWaitsHtml(
  row: IssueViewRow | { id: string } | null,
  plan: (LinkedEntity & { id?: string }) | null,
  nowMs: number,
  opts?: SourceOptions,
): string
/** slice 2 §9.2 — a Plan flow step's "Circular", "Part of", "Waits on" and "Unblocks"; '' when none */
export function missionDepsHtml(path: MissionPath, plan: LinkedEntity | null): string
/** slice 2 §9.2 — the flow's "Not in this plan" fold; '' when every child is linked */
export function missionOutsideHtml(
  outside: ReturnType<typeof buildMission>['outside'],
  plan: LinkedEntity | null,
  opts?: { open?: boolean; key?: string },
): string
