export interface CardOption { label: string; detail?: string; recommended?: boolean }

export interface CardItem {
  id: string
  kind?: string
  status?: string
  title: string
  detail?: string
  next_step?: string
  action_owner?: 'decision' | 'task' | 'approval' | null
  impact?: string
  next_after?: string
  outcome?: string
  outcome_at?: string | null
  context?: string
  annotation?: string | null
  options?: CardOption[] | null
  reply?: string | null
  reply_kind?: 'answer' | 'clarify' | 'decline' | null
  reply_context?: string | null
  reply_seen_at?: string | null
}

export interface CardSections {
  detail: string
  nextStep: string
  actionOwner: 'decision' | 'task' | 'approval' | null
  impact: string
  nextAfter: string
  outcome: string
  outcomeAt: string | null
  context: string
  annotation: string
  reply: string
  options: CardOption[]
  recWarning: string | null
  showAnswer: boolean
  showActions: boolean
  showPickup: boolean
  answered: boolean
}

export function optionOrder(options: CardOption[] | null | undefined): CardOption[]
export function recommendedWarning(options: CardOption[] | null | undefined): string | null
export function cardSections(it: CardItem, opts?: { done?: boolean }): CardSections
