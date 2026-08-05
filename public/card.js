// public/card.js
// Which sections the unified item card shows (spec §4). Pure so the one
// component behind the inline accordion and the triage lightbox has a single,
// tested definition of "what belongs on a card".

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
    showAnswer: !done && it.kind === 'question' && open && !it.reply,
    showActions: !done,
    showPickup: answered,
    answered,
  }
}
