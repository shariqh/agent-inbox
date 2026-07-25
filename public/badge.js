// Pure badge + deep-link helpers (spec §11). No DOM — the caller owns
// document.title and location.hash.

// The browser's ambient signal: `(3) Agent Inbox`. The count is always the
// GLOBAL attention set, never the filtered view (§7 filter-blindness).
export function titleWithBadge(base, count) {
  const n = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0
  return n > 0 ? `(${n}) ${base}` : base
}

// A link that survives a reload: #item/<id>.
export function focusHashFor(id) {
  return `#item/${encodeURIComponent(String(id))}`
}

export function parseFocusHash(hash) {
  const m = /^#?item\/(.+)$/.exec(String(hash ?? ''))
  if (!m || !m[1]) return null
  try {
    return { id: decodeURIComponent(m[1]) }
  } catch {
    return { id: m[1] } // malformed escape — take it literally rather than lose the link
  }
}
