// Issue #184: the default /api/items snapshot carries every open item plus only
// the most recently touched closed items; its `history` summary describes the
// rest. Pure — no DOM, no fetch — so the viewer and its tests share these rules.
import { stamp } from './relay.js'

const asSet = (values) => values instanceof Set ? values : new Set(values ?? [])

// Fold the complete History list (/api/items/history) into a page. The page is
// authoritative for every item it carries — a write can land between the two
// reads — so the complete list supplies only the closed items the page omitted,
// in its own server order (same-millisecond ties included).
export function mergeClosedHistory(g, done) {
  const open = new Set([...g.needsYou, ...g.notes].flatMap((group) => group.items.map((item) => item.id)))
  const paged = new Map(g.done.map((item) => [item.id, item]))
  const merged = []
  for (const item of done) {
    if (open.has(item.id)) continue
    merged.push(paged.get(item.id) ?? item)
    paged.delete(item.id)
  }
  // Closed or announced after the history read: newest first, by creation.
  for (const item of paged.values()) {
    const index = merged.findIndex((other) => other.created_at < item.created_at)
    merged.splice(index < 0 ? merged.length : index, 0, item)
  }
  return { ...g, done: merged }
}

// The omitted closed items a lens would show: the project/agent filters and the
// suppressed (closed, not peeked) projects every loaded item passes through.
export function olderHistory(summary, { project = null, agent = null, hidden = [] } = {}) {
  const suppressed = asSet(hidden)
  const groups = (summary?.older ?? []).filter((group) =>
    (!project || group.project === project)
    && (!agent || group.agent === agent)
    && !suppressed.has(group.project))
  return {
    items: groups.reduce((total, group) => total + group.items, 0),
    outcomes: groups.reduce((total, group) => total + group.outcomes, 0),
    projects: [...new Set(groups.map((group) => group.project))],
    agents: [...new Set(groups.map((group) => group.agent))],
  }
}

// The leading History entries no omitted item can precede. An item is never
// touched before it is created, so every omitted item sorts after anything the
// page carries that was created after `before`. Aged notes always follow closed
// history, so the first one ends the run.
export function knownHistory(done, before) {
  if (before == null) return done
  const known = []
  for (const item of done) {
    if (item.status === 'open' && item.kind !== 'done') break
    if (!(item.created_at > before)) break
    known.push(item)
  }
  return known
}

// The leading recorded outcomes (newest first) no omitted item can outrank: an
// omitted item's stamp is never later than its last touch, which is `before` at
// the latest.
export function knownOutcomes(outcomes, before) {
  if (before == null) return outcomes
  const cutoff = Date.parse(before)
  const known = []
  for (const entry of outcomes) {
    if (!(stamp(entry.item ?? entry.row) > cutoff)) break
    known.push(entry)
  }
  return known
}
