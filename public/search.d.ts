export interface HaystackEntity {
  id: string
  title?: string
  project?: string
  agent?: string
  stream?: string
  detail?: string
  next_step?: string
  action_owner?: string
  impact?: string
  next_after?: string
  outcome?: string
  context?: string
  kind?: string
  annotation?: string
  reply?: string
  reply_context?: string
  options?: Array<{ label?: string; detail?: string }>
  rows?: Array<{
    id?: string
    label?: string
    note?: string
    next_step?: string
    action_owner?: string
    impact?: string
    next_after?: string
    outcome?: string
    options?: Array<{ label?: string; detail?: string }>
    context?: string
    annotation?: string
  }>
}

export function haystackFor(entity: HaystackEntity): string
export function searchTerms(query: string): string[]
export function createBoundedMatcher(
  searchFn: (haystack: string[], needle: string) => Array<{ index: number; ranges: number[] }> | null,
): (haystack: string[], needle: string) => Array<{ index: number; ranges: number[] }> | null
export function paginate<T>(items: T[], limit: number): { visible: T[]; remaining: number }
export function paginateGroups<G extends { items: unknown[] }>(
  groups: G[],
  limit: number,
): { groups: G[]; remaining: number }
