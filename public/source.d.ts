// Types for public/source.js (issue #30). Deliberately a LOCAL entity shape
// rather than an extension of card.d.ts's CardItem — items and boards both feed
// these builders, and keeping card.d.ts out of the graph keeps them independent.

export interface LinkedEntity {
  project?: string
  stream?: string | null
  repo?: string | null
  issue_ref?: number | null
}

/** One cached /api/links row — the store's SourceLink, over the wire. */
export interface CachedLink {
  repo: string
  branch: string
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
}

export interface PrDetail {
  chip: PrChip
  title: string
  tldr: string
  url: string
  checked: string
  error: string
}

export function linkKey(repo: string, branch: string): string
export function indexLinks(links: CachedLink[] | null | undefined): Map<string, CachedLink>
export function linkFor(index: Map<string, CachedLink> | null, entity: LinkedEntity | null): CachedLink | null
export function safeHttpUrl(url: unknown): string
export function textLinkHtml(url: unknown, label: unknown): string
export function issueRef(entity: LinkedEntity | null, link: CachedLink | null): IssueRef | null
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
