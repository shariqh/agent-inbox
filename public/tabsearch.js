// Cross-tab search accounting (spec §12). With content behind tabs, a scoped
// search produces confident false negatives — so a query is always measured
// against the WHOLE dataset, per tab and per project, whatever is on screen.
// search.js stays untouched: searchMatches/haystackFor are shape-agnostic and
// every shape here is mapped onto that same haystack contract.
import { searchMatches } from './search.js'

const TABS = ['needsYou', 'boards', 'live', 'notes', 'done']

// one haystack-shaped entity per live session, children folded into `detail`
export function liveEntity(a) {
  return {
    id: a.session,
    title: a.doing,
    project: a.project,
    agent: a.agent,
    stream: a.stream,
    detail: [a.detail, ...(a.children ?? []).flatMap((c) => [c.name, c.doing])].filter(Boolean).join(' '),
  }
}

const items = (groups) => groups.flatMap((gr) => gr.items)

// { tab -> Set of matching ids | null }. Unscoped by project/agent on purpose:
// tab counts must stay honest while the rail narrows the visible list.
export function searchIndex(data, query, filterFn) {
  const hit = (ents) => searchMatches(ents, query, filterFn)
  return {
    needsYou: hit(items(data.g.needsYou)),
    notes: hit(items(data.g.notes)),
    done: hit(data.g.done),
    boards: hit([...data.boards, ...data.archived]),
    live: hit((data.activity ?? []).map(liveEntity)),
  }
}

export function tabMatchCounts(data, query, filterFn) {
  const idx = searchIndex(data, query, filterFn)
  const out = {}
  for (const t of TABS) out[t] = idx[t] === null ? null : idx[t].size
  return out
}

export function projectMatchCounts(data, query, filterFn) {
  const out = new Map()
  const idx = searchIndex(data, query, filterFn)
  if (idx.needsYou === null) return out // no query → no per-project search badges
  const hit = new Set(TABS.flatMap((t) => [...idx[t]]))
  const bump = (p) => out.set(p, (out.get(p) ?? 0) + 1)
  for (const it of [...items(data.g.needsYou), ...items(data.g.notes), ...data.g.done]) if (hit.has(it.id)) bump(it.project)
  for (const b of [...data.boards, ...data.archived]) if (hit.has(b.id)) bump(b.project)
  for (const a of data.activity ?? []) if (hit.has(a.session)) bump(a.project)
  return out
}

// the tabs holding matches the user is NOT currently looking at — this is what
// makes a bare "no matches" impossible
export function otherTabMatches(counts, activeTab) {
  return TABS
    .filter((t) => t !== activeTab && (counts[t] ?? 0) > 0)
    .map((t) => ({ tab: t, n: counts[t] }))
}

// The rendered form of the above — "2 in Boards · 1 in Notes", '' when there is
// nothing to point at. It lives HERE, not inside app.js's emptyMsg, because two
// surfaces need it: the ordinary "No matches … — <here>" empty state, and the
// one case that must NOT print a "no matches" claim at all (a Needs-you search
// whose only hits are inside the collapsed stale fold — fix round 2 / I2), where
// the pointer is the entire message. One builder, so they cannot drift.
// `labels` is injected rather than imported: this module stays presentation-free
// and Node-testable. Interpolates only caller-supplied fixed labels and integers
// — never agent text — so the app can put the result straight into innerHTML.
export function elsewhereLabel(counts, activeTab, labels = {}) {
  return otherTabMatches(counts, activeTab)
    .map(({ tab, n }) => `${n} in ${labels[tab] ?? tab}`)
    .join(' · ')
}
