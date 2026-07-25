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
  const answered = it.kind === 'question' && open && Boolean(it.reply)
  return {
    detail: it.detail ?? '',
    context: it.context ?? '',
    annotation: it.annotation ?? '',
    reply: answered ? it.reply : '',
    options: optionOrder(it.options),
    recWarning: it.kind === 'question' && !answered ? recommendedWarning(it.options) : null,
    showAnswer: !done && it.kind === 'question' && open && !it.reply,
    showActions: !done,
    answered,
  }
}
