// The safe ★ (one-tap accept, design §5). Pure: the gating rule, the staged
// send with undo (timers injected so it is unit-testable), and the rule that
// undo is refused once the agent has picked the reply up.

// Gate 1: the star renders only when EXACTLY ONE option is recommended. Zero →
// nothing to accept. Two or more → the flag is ambiguous and the store does not
// validate it, so refuse rather than pick. Absence of a star is neutral.
export function starOption(item) {
  const options = item?.options ?? []
  const recommended = options.filter((o) => o && o.recommended === true)
  return recommended.length === 1 ? recommended[0] : null
}

// Gate 3: the tap stages the reply; it fires after `delayMs` (or immediately on
// flush — tab blur/close), and undo within the window cancels it outright so no
// request is ever made.
export function createStagedSend({ delayMs, setTimeoutFn, clearTimeoutFn, send }) {
  const pending = new Map() // key → { handle, payload }

  function fire(key) {
    const entry = pending.get(key)
    if (!entry) return
    pending.delete(key)
    send(entry.payload)
  }

  return {
    stage(key, payload) {
      const existing = pending.get(key)
      if (existing) clearTimeoutFn(existing.handle)
      const handle = setTimeoutFn(() => fire(key), delayMs)
      pending.set(key, { handle, payload })
    },
    undo(key) {
      const entry = pending.get(key)
      if (!entry) return false // already sent (or never staged) — cannot be undone
      clearTimeoutFn(entry.handle)
      pending.delete(key)
      return true
    },
    flush() {
      for (const [key, entry] of [...pending]) {
        clearTimeoutFn(entry.handle)
        pending.delete(key)
        send(entry.payload)
      }
    },
    pending(key) {
      return pending.has(key)
    },
  }
}

// Once the agent has read the reply, un-sending it is a lie: the UI must refuse
// with an explanation rather than pretend it worked.
export function canUndo(item) {
  return !item?.reply_seen_at
}
