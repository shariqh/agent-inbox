export interface NoteLike {
  id: string
  kind?: string
  status?: string
  created_at: string
  reply?: string | null
  reply_seen_at?: string | null
}
export interface BoardProgressLike { progress: { done: number; countable: number; fraction: number } }

export function partitionNotes<T extends NoteLike>(notes: T[], nowMs: number): { fresh: T[]; aged: T[] }
export function unreadNotes<T extends NoteLike>(notes: T[], lastSeenIso: string | null, nowMs: number): T[]
export function unreadNoteCount(notes: NoteLike[], lastSeenIso: string | null, nowMs: number): number
export function ambientChips(
  items: NoteLike[],
  boards: BoardProgressLike[],
  nowMs: number,
  lastSeenIso: string | null,
): Array<{ key: string; label: string }>
