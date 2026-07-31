export type SuspendReason = 'draft'

export interface SuspendState {
  drafts?: Record<string, string | undefined>
  /**
   * When the pointer went down (issue #38 / D2). Deliberately NOT part of the
   * suspension vocabulary — `suspendReason`/`suspendHint` ignore it, because a
   * press is not a pause and must never light #pauseHint. Only
   * `shouldDeferRender` reads it.
   */
  pressedAt?: number | null
}

export function suspendReason(state: SuspendState): SuspendReason | null
export function shouldSuspendRender(state: SuspendState): boolean
export function suspendHint(state: SuspendState): string | null
export const PRESS_GRACE_MS: number
export function pressHeld(pressedAt: number | null | undefined, nowMs: number): boolean
export function shouldDeferRender(state: SuspendState, nowMs: number): boolean
export function pinOrder(current: string[], incoming: string[]): string[]
export function reconcileOpenRow(
  openId: string | null | undefined,
  renderedIds: string[] | Set<string> | null | undefined,
): string | null
