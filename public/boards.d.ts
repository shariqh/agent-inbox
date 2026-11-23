export type RowStatus = 'done' | 'partial' | 'missing' | 'tracked' | 'na' | 'blocked'

export interface BoardRowLike {
  id: string
  label: string
  status: RowStatus
  note?: string
  next_step?: string
  action_owner?: 'decision' | 'task' | 'approval' | null
  impact?: string
  next_after?: string
  options?: Array<{ label: string; detail?: string; recommended?: boolean }> | null
  context?: string
  outcome?: string
  outcome_at?: string | null
  created_at?: string
  updated_at?: string
  action_started_at?: string
  action_version?: number
  revision?: number
  history?: unknown[]
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
export function boardRowLine(row: BoardRowLike): string
export function progressLabel(progress: ProgressLike): { primary: string; secondary: string; complete: boolean }
export function hiddenDoneCount(board: BoardLike, opts?: RowsViewOpts): number
export function lingeringBoards<T extends { id: string; progress: ProgressLike }>(
  prevActiveIds: Iterable<string>,
  boards: Array<{ id: string }>,
  archived: T[],
): T[]
export function omittedOutcomes(
  plans: Array<{ omitted?: { outcomes: number; latest: string | null } }> | null | undefined,
): { outcomes: number; latest: string | null }

/** UX pass, slice 3: the Plans page's sections and a plan's form. */
export type PlanSection = 'needs' | 'moving' | 'stalled'
export const STALL_MS: number
export function planSections<T extends { id: string; updated_at?: string; session?: string | null; rows?: Array<Record<string, any>> }>(
  plans: T[],
  opts: {
    nowMs: number
    liveSessions?: Iterable<string>
    workingPlanIds?: Iterable<string>
    held?: Map<string, PlanSection>
  },
): Record<PlanSection, T[]>
export type PlanForm = 'closed' | 'brief' | 'full'
export function planForm(input: { choice?: boolean; section?: PlanSection | null; kept?: boolean }): PlanForm
