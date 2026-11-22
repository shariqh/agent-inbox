export interface NoteLike {
  id: string
  kind?: string
  /** issue #612 — 1 on a done item stored as a hand-off (an ask, not a milestone). */
  handoff?: number | null
  status?: string
  created_at: string
  reply?: string | null
  reply_seen_at?: string | null
}

/** A per-id read-mark. Optional everywhere: `undefined` is "no id set", i.e. v1 behaviour. */
export type SeenIds = ReadonlySet<string> | readonly string[] | undefined

export function partitionNotes<T extends NoteLike>(notes: T[], nowMs: number): { fresh: T[]; aged: T[] }
export function unreadNotes<T extends NoteLike>(notes: T[], lastSeenIso: string | null, nowMs: number, seenIds?: SeenIds): T[]
export function unreadNoteCount(notes: NoteLike[], lastSeenIso: string | null, nowMs: number, seenIds?: SeenIds): number
export function seenWatermark(
  rendered: NoteLike[],
  hidden: NoteLike[],
  prevIso: string | null,
): string | null
export function markSeenIds(prevIds: SeenIds, rendered: NoteLike[], live: NoteLike[]): string[]
