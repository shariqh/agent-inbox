export type SuspendReason = 'expanded' | 'draft'

export interface SuspendState {
  expanded?: string[] | Set<string>
  drafts?: Record<string, string | undefined>
}

export function suspendReason(state: SuspendState): SuspendReason | null
export function shouldSuspendRender(state: SuspendState): boolean
export function suspendHint(state: SuspendState): string | null
export function pinOrder(current: string[], incoming: string[]): string[]
export function pendingCount(current: string[], incoming: string[]): number
export function applyListUpdate(args: {
  current: string[]
  incoming: string[]
  hovering: boolean
}): { ids: string[]; staged: string[] | null; pending: number }
export function reconcileOpenRow(
  openId: string | null | undefined,
  renderedIds: string[] | Set<string> | null | undefined,
): string | null
