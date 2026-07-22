// Pure search + pagination helpers for the viewer.
// No external imports: the fuzzy engine is injected as `filterFn`, so this
// module stays dependency-free and unit-testable in Node. The browser passes
// in window.uFuzzy's .filter; tests pass a stub or the real engine.

// One lowercased searchable string for an entity. Boards carry `.rows`; items
// do not — that is how the two shapes are told apart.
export function haystackFor(entity) {
  const parts = [entity.title, entity.project, entity.agent, entity.stream]
  if (Array.isArray(entity.rows)) {
    for (const r of entity.rows) parts.push(r.label, r.note, r.context, r.annotation)
  } else {
    parts.push(entity.detail, entity.context, entity.kind, entity.annotation, entity.reply)
  }
  return parts.filter(Boolean).join(' ').toLowerCase()
}

// Map a fuzzy filter over entities. null = no query (show everything); a Set of
// matching ids otherwise (empty Set = query present but nothing matched).
export function searchMatches(entities, query, filterFn) {
  const needle = (query ?? '').trim()
  if (!needle) return null
  const haystack = entities.map(haystackFor)
  const idxs = filterFn(haystack, needle)
  const ids = new Set()
  if (idxs) for (const i of idxs) { const e = entities[i]; if (e) ids.add(e.id) }
  return ids
}

// Flat list → first `limit` items plus how many remain hidden.
export function paginate(items, limit) {
  return { visible: items.slice(0, limit), remaining: Math.max(0, items.length - limit) }
}

// Grouped list ([{ project, items }]) → groups truncated to a shared item
// budget of `limit`, walking in order and dropping groups that get nothing.
export function paginateGroups(groups, limit) {
  const total = groups.reduce((n, g) => n + g.items.length, 0)
  const out = []
  let budget = Math.max(0, limit)
  for (const g of groups) {
    if (budget <= 0) break
    const items = g.items.slice(0, budget)
    if (items.length === 0) continue
    out.push({ ...g, items })
    budget -= items.length
  }
  return { groups: out, remaining: Math.max(0, total - limit) }
}
