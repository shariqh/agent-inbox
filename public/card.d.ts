import type { ItemAnnotationReceipt } from './action.js'

export interface CardOption { label: string; detail?: string; recommended?: boolean }

export interface ActionPresentation {
  headline: string
  headlineField: 'next-step' | 'title' | 'label'
  originalTitle: string
  detail: string
  impact: string
  nextAfter: string
}

export function actionPresentation(entity: {
  title?: string
  label?: string
  kind?: string
  status?: string | null
  next_step?: string
  detail?: string
  note?: string
  impact?: string
  next_after?: string
  outcome?: string
  reply?: string | null
  reply_kind?: string | null
  annotation?: string | null
  annotation_kind?: string | null
  handled_at?: string | null
}, opts?: { done?: boolean }): ActionPresentation

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
  annotated_at?: string | null
  annotation_seen_at?: string | null
  annotation_seen_by?: string | null
  options?: CardOption[] | null
  reply?: string | null
  reply_kind?: 'answer' | 'clarify' | 'decline' | null
  reply_context?: string | null
  reply_seen_at?: string | null
  reply_source?: 'inbox' | 'agent' | null
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
  annotationReceipt: ItemAnnotationReceipt | null
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
