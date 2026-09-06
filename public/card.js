// public/card.js
// Which sections the unified item card shows (spec §4). Pure so the one
// component behind the inline accordion and the triage lightbox has a single,
// tested definition of "what belongs on a card".
import { humanActedOnRow } from './attention.js'

export function actionPresentation(entity, { done = false } = {}) {
  const isRow = typeof entity.label === 'string'
  const originalTitle = (isRow ? entity.label : entity.title) ?? ''
  const unanswered = isRow
    ? entity.status === 'blocked' && !humanActedOnRow(entity)
    : entity.kind === 'question' && (entity.status ?? 'open') === 'open' && !entity.reply && !entity.reply_kind
  const hasRequest = !done && !entity.outcome && unanswered
    && typeof entity.next_step === 'string' && Boolean(entity.next_step.trim())
  const headline = hasRequest ? entity.next_step : originalTitle
  const shown = new Set([headline])
  const distinct = (text) => {
    if (typeof text !== 'string' || !text.trim() || shown.has(text)) return ''
    shown.add(text)
    return text
  }
  return {
    headline,
    headlineField: hasRequest ? 'next-step' : isRow ? 'label' : 'title',
    originalTitle,
    detail: distinct(isRow ? entity.note : entity.detail),
    impact: distinct(entity.impact),
    nextAfter: distinct(entity.next_after),
  }
}

// Recommended first, everything else in author order (stable sort).
export function optionOrder(options) {
  return [...(options ?? [])].sort((a, b) => (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0))
}

// The store does not validate this — two recommendations kills the safe star (§5.1).
export function recommendedWarning(options) {
  const n = (options ?? []).filter((o) => o.recommended).length
  return n > 1 ? `${n} options are marked recommended — one-tap accept is disabled` : null
}

export function cardSections(it, { done = false } = {}) {
  const open = it.status === 'open'
  const responded = it.kind === 'question' && Boolean(it.reply || it.reply_kind)
  const answered = open && responded
  return {
    detail: it.detail ?? '',
    nextStep: it.next_step ?? '',
    actionOwner: it.action_owner ?? null,
    impact: it.impact ?? '',
    nextAfter: it.next_after ?? '',
    outcome: it.outcome ?? '',
    outcomeAt: it.outcome_at ?? null,
    context: it.context ?? '',
    annotation: it.annotation ?? '',
    reply: responded ? (it.reply ?? '') : '',
    options: optionOrder(it.options),
    recWarning: it.kind === 'question' && !answered ? recommendedWarning(it.options) : null,
    // A chat-recorded answer is already picked up by definition, so clearing it
    // first would be refused. Reuse the answer surface as a non-destructive
    // correction form; its next non-empty send becomes the authoritative inbox reply.
    showAnswer: !done && it.kind === 'question' && open && (!it.reply || it.reply_source === 'agent'),
    showActions: !done,
    showPickup: answered,
    answered,
  }
}
