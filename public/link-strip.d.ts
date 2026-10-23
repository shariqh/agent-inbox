// Types for public/link-strip.js (issue #300).
import type { CachedLink, LinkedEntity, StripLink } from './source.js'

export interface CardLink extends StripLink {
  /** one chip per key: gh:owner/name#N, web:<href> or file:<path> */
  key: string
  /** the card's own PR or issue, which its origin chips already show */
  own: boolean
  line?: number | null
}

export interface LinkSourceEntity {
  id?: string
  title?: string | null
  label?: string
  next_step?: string | null
  detail?: string | null
  note?: string | null
  impact?: string | null
  next_after?: string | null
  outcome?: string | null
  context?: string | null
  options?: Array<{ label?: string; detail?: string | null } | null> | null
  issue_repo?: string | null
  issue_number?: number | null
  [field: string]: unknown
}

export function cardLinks(
  entity: LinkSourceEntity | null,
  identity: (LinkedEntity & { id?: string }) | null,
  index: Map<string, CachedLink> | null,
): CardLink[]
