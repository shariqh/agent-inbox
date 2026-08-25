export type ActionOwner = 'decision' | 'task' | 'approval'
export type ResponseKind = 'answer' | 'clarify' | 'decline'

export interface ActionLike {
  action_owner?: ActionOwner | null
  options?: Array<{ label?: string }> | null
  created_at?: string | null
  updated_at?: string | null
  action_started_at?: string | null
  reply?: string | null
  reply_kind?: ResponseKind | null
  replied_at?: string | null
  reply_seen_at?: string | null
  annotation?: string | null
  annotation_kind?: ResponseKind | null
  annotated_at?: string | null
  annotation_seen_at?: string | null
  handled_at?: string | null
  handled_seen_at?: string | null
  outcome?: string | null
  outcome_at?: string | null
}

export function actionOwnerLabel(entity: ActionLike): string
export function actionCategory(entity: ActionLike): 'decision' | 'task'
export function changeKind(entity: ActionLike, lastVisitAt: string | null): 'new' | 'changed' | null
export function responseLabel(entity: ActionLike): string
export function agentFollowupChip(
  model: { answered?: boolean; pickedUp?: boolean; pickedUpAt?: string | null },
  nowMs: number,
): { text: string; tone: 'muted' | 'warm' | 'hot' } | null
export function lifecycleReceipt(entity: ActionLike): Array<{
  kind: 'asked' | 'response' | 'pickup' | 'outcome'
  label: string
  at: string | null
}>
