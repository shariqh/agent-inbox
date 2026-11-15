import type { LaneBoard } from './lanes.js'

export const PLANS_LANE_CAP: 6
export const PLANS_EMPTY: 'No plan in this view has open steps.'

/** one row of the Plans in progress lane (dashboard lanes design §3.5) */
export interface PlanInProgress {
  id: string
  title: string
  project: string
  /** planBar(board).done: the server's progress.done */
  done: number
  /** planBar(board).countable: every row but na, as the Plans tab counts */
  countable: number
  /** planBar(board).segments.waiting: rows the attention predicate counts */
  waiting: number
  /** board.updated_at, or null when it does not parse */
  updatedAt: string | null
  updatedMs: number | null
}

/** status is neither 'done' nor 'na' */
export function isOpenRow(row: { status?: string } | null | undefined): boolean
/** active plans with at least one open row, in lane order: waiting first, newest change, id */
export function plansInProgress(boards: LaneBoard[], nowMs: number): PlanInProgress[]
/** the first `cap` ids and how many are left over */
export function capPlans(order: string[], cap?: number): { shown: string[]; more: number }
export interface PlansLaneInput {
  /** buildDashboard().plansInProgress */
  plans: PlanInProgress[]
  /** the lens is All projects: each row names its project */
  showProject: boolean
  nowMs: number
}

export interface PlansLaneDeps {
  doc?: Document
  /** a row's click or Enter: the plan in the Plans tab (app.js focusItem) */
  open(id: string): void
  /** "All plans ›": the Plans tab under the current lens */
  openAll(): void
  projectColor?(project: string): string
  scrollBehavior?(): ScrollBehavior
}

export function installPlansLane(deps: PlansLaneDeps): {
  /** the lane, made once; renderDashboard mounts it in the Dashboard grid after Working and Quiet */
  element(): HTMLElement
  paint(input: PlansLaneInput): void
}
