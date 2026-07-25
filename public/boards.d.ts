export type RowStatus = 'done' | 'partial' | 'missing' | 'tracked' | 'na' | 'blocked'

export interface BoardRowLike {
  id: string
  label: string
  status: RowStatus
  note?: string
  context?: string
  annotation?: string | null
  annotation_unseen?: boolean
}

export interface ProgressLike { done: number; countable: number; fraction: number }
export interface BoardLike { id: string; rows: BoardRowLike[]; progress: ProgressLike }
export interface RowsViewOpts { hideCompleted?: boolean; showDone?: boolean }

export function boardRowsView(
  board: BoardLike,
  opts?: RowsViewOpts,
): Array<{ row: BoardRowLike; num: number; needsAnswer: boolean }>
export function progressLabel(progress: ProgressLike): { primary: string; secondary: string; complete: boolean }
export function hiddenDoneCount(board: BoardLike, opts?: RowsViewOpts): number
export function lingeringBoards<T extends { id: string; progress: ProgressLike }>(
  prevActiveIds: Iterable<string>,
  boards: Array<{ id: string }>,
  archived: T[],
): T[]
