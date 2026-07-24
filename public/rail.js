// Pure rail helpers: which projects get a vertical tab, in what order, what
// badge each carries, and how the typed filter narrows them. No DOM and no
// imports, so this is unit-testable in Node.

// Every project the user can filter by. `activity` matters: a project whose only
// trace is a LIVE session still deserves a rail tab — the old pill strip dropped
// it, which is a bug once the rail is the primary navigation.
// 'unknown' always sorts last so the viewer can pin it to the foot.
export function railProjects({ items = [], boards = [], archived = [], activity = [] } = {}) {
  const names = new Set()
  for (const x of [...items, ...boards, ...archived, ...activity]) if (x && x.project) names.add(x.project)
  const rest = [...names].filter((n) => n !== 'unknown').sort()
  return names.has('unknown') ? [...rest, 'unknown'] : rest
}

// Rail rows: an All pseudo-project pinned top carrying the GLOBAL totals, then
// each project in railProjects order. `counts` is the Map from countsByProject().
export function railEntries(projects, counts) {
  const rows = projects.map((p) => {
    const c = counts.get(p) ?? { total: 0, escalated: 0 }
    return { key: p, label: p, total: c.total, escalated: c.escalated, unknown: p === 'unknown' }
  })
  return [{
    key: '__all__',
    label: 'All',
    total: rows.reduce((n, r) => n + r.total, 0),
    escalated: rows.reduce((n, r) => n + r.escalated, 0),
    unknown: false,
  }, ...rows]
}

// A rail longer than a dozen projects stops being scannable; past that we offer
// a type-to-narrow box. Twelve fits a laptop viewport without scrolling.
export const RAIL_FILTER_THRESHOLD = 12

export function shouldShowRailFilter(projects) {
  return (projects?.length ?? 0) > RAIL_FILTER_THRESHOLD
}

// Narrow the rail by typed query. 'All' is never filtered out — losing the
// escape hatch back to the unfiltered view would strand the user.
export function filterRailEntries(entries, query) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return entries
  return entries.filter((e) => e.key === '__all__' || String(e.label).toLowerCase().includes(q))
}
