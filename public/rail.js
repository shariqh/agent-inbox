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
//
// issue #32: feed this the OPEN projects only. Because countsByProject is
// deliberately unsuppressed, All then sums to exactly the SUPPRESSED global
// badge with no subtraction anywhere — do not re-add closed projects to its
// input, or the rail's All row and the title badge start disagreeing.
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

// ── issue #32: closed projects ──────────────────────────────────────────────

// accepts a Set (browser) or a plain array (tests / JSON from /api/projects/closed)
function asSet(names) {
  return names instanceof Set ? names : new Set(names ?? [])
}

// Partition railProjects' output. Order is preserved from railProjects on BOTH
// sides, so 'unknown' stays last whichever side it lands on. A closed name with
// no remaining trace in the rail simply produces no row.
export function splitClosed(projects, closed = []) {
  const set = asSet(closed)
  const list = projects ?? []
  return { open: list.filter((p) => !set.has(p)), closed: list.filter((p) => set.has(p)) }
}

// Fold rows: the same shape as railEntries' project rows, but NEVER escalated —
// red is an alarm, and a project the badge is deliberately ignoring must not
// alarm. `total` is kept on purpose: the number is RELOCATED here, never
// destroyed, which is what makes the badge suppression honest instead of silent.
export function closedRailEntries(closed, counts) {
  return (closed ?? []).map((p) => {
    const c = counts?.get(p) ?? { total: 0, escalated: 0 }
    return { key: p, label: p, total: c.total, escalated: 0, unknown: p === 'unknown' }
  })
}

export function suppressedTotal(entries) {
  return (entries ?? []).reduce((n, e) => n + e.total, 0)
}

// The closed fold's summary. Returns null when nothing is closed (no fold at
// all). Feed `count` and `suppressed` from the SAME unfiltered list: a rail
// query that narrows one but not the other would print two numbers drawn from
// different populations, which is the exact dishonesty the fold exists to avoid.
export function closedFoldLabel(count, suppressed = 0, mode = 'wide') {
  if (!count) return null
  const projects = `${count} closed project${count === 1 ? '' : 's'}`
  const items = `${suppressed} item${suppressed === 1 ? '' : 's'} muted`
  return {
    text: mode === 'narrow' ? String(count) : `Closed (${count})`,
    muted: suppressed ? `${suppressed} muted` : '',
    hint: suppressed ? `${projects} · ${items} — not counted in the badge` : projects,
  }
}
