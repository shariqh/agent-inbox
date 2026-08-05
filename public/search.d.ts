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
  rows?: Array<{
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
export function searchMatches(
  entities: HaystackEntity[],
  query: string,
  filterFn: (haystack: string[], needle: string) => number[] | null,
): Set<string> | null
export function paginate<T>(items: T[], limit: number): { visible: T[]; remaining: number }
export function paginateGroups<G extends { items: unknown[] }>(
  groups: G[],
  limit: number,
): { groups: G[]; remaining: number }
