export interface NoteLike {
  id: string
  kind?: string
  status?: string
  created_at: string
  reply?: string | null
  reply_seen_at?: string | null
}
export interface BoardProgressLike { progress: { done: number; countable: number; fraction: number } }

/** A per-id read-mark. Optional everywhere: `undefined` is "no id set", i.e. v1 behaviour. */
export type SeenIds = ReadonlySet<string> | readonly string[] | undefined

export function partitionNotes<T extends NoteLike>(notes: T[], nowMs: number): { fresh: T[]; aged: T[] }
export function unreadNotes<T extends NoteLike>(notes: T[], lastSeenIso: string | null, nowMs: number, seenIds?: SeenIds): T[]
export function unreadNoteCount(notes: NoteLike[], lastSeenIso: string | null, nowMs: number, seenIds?: SeenIds): number
export function ambientChips(
  items: NoteLike[],
  boards: BoardProgressLike[],
  nowMs: number,
  lastSeenIso: string | null,
  seenIds?: SeenIds,
): Array<{ key: string; label: string }>
export function seenWatermark(
  rendered: NoteLike[],
  hidden: NoteLike[],
  prevIso: string | null,
): string | null
export function markSeenIds(prevIds: SeenIds, rendered: NoteLike[], live: NoteLike[]): string[]
