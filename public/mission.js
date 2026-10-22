// Plan flow's model: a plan's rows in the agent's order, each with its explicit
// result (outcome or next_after text; prose never creates an edge) and, from
// slice 2 §9.2, what it waits on and unblocks. Pure: the dependency half reads
// the frame's issue view (public/issues.js, the model Plans draws), so the flow
// and the chips can never disagree, and nothing here fetches or reorders.
import { issueKey, issueKeyFor } from './issue-key.js'
import { linkFor } from './source.js'

const drawn = (rel) => (rel && rel.node && (rel.freshness === 'fresh' || rel.freshness === 'stale') ? rel : null)
const linkOf = (row) => (issueKey(row.issue_repo, row.issue_number) ? { repo: row.issue_repo, number: row.issue_number } : null)

// Rows on a cycle of raw waits_on labels. The store refuses one, but an older
// process could have written it (slice 2 §11); it renders, it never reorders.
function localCycles(rows) {
  const byLabel = new Map(rows.map((row) => [row.label, row]))
  const next = (row) => (Array.isArray(row.waits_on) ? row.waits_on : [])
    .map((label) => byLabel.get(label)).filter((target) => target && target !== row)
  const circular = new Set()
  for (const start of rows) {
    const seen = new Set()
    const queue = next(start)
    while (queue.length) {
      const at = queue.shift()
      if (at === start) { circular.add(start.id); break }
      if (seen.has(at)) continue
      seen.add(at)
      queue.push(...next(at))
    }
  }
  return circular
}

function dependenciesOf(board, rows, paths, deps) {
  const view = deps && deps.issues
  const relations = view && view.relations instanceof Map ? view.relations : new Map()
  const rowWaits = view && view.rowWaits instanceof Map ? view.rowWaits : new Map()
  const relOf = (row) => drawn(relations.get(issueKey(row.issue_repo, row.issue_number)))
  const keyOf = (row) => {
    const raw = issueKey(row.issue_repo, row.issue_number)
    return raw ? relations.get(raw)?.node?.key ?? raw : null
  }
  // an issue this plan links: its first drawn row is the step it stands for
  const stepOf = new Map()
  const linked = new Set()
  for (const row of rows) {
    const key = keyOf(row)
    if (!key) continue
    linked.add(key)
    if (row.status !== 'na' && !stepOf.has(key)) stepOf.set(key, row)
  }
  const byId = new Map(paths.map((path) => [path.row.id, path]))
  const stepEntry = (row, sources) => ({ kind: 'step', rowId: row.id, label: row.label, issue: linkOf(row), sources })
  // waiter → target, once per pair, both sources merged
  const edges = new Map()
  const edge = (waiter, target, source) => {
    if (waiter === target || !byId.has(waiter.id) || !byId.has(target.id)) return
    const pair = `${waiter.id}\u0000${target.id}`
    const found = edges.get(pair) ?? { waiter, target, sources: [] }
    for (const s of source) if (!found.sources.includes(s)) found.sources.push(s)
    found.sources.sort((a, b) => (a === b ? 0 : a === 'step' ? -1 : 1))
    edges.set(pair, found)
  }
  const external = new Map(paths.map((path) => [path.row.id, { waitsOn: [], unblocks: [] }]))
  for (const path of paths) {
    const row = path.row
    for (const entry of rowWaits.get(row.id) ?? []) {
      const target = entry.step ? byId.get(entry.step.id)?.row : entry.node ? stepOf.get(entry.node.key) : null
      if (target) edge(row, target, entry.sources)
      else if (!entry.step && entry.node) {
        external.get(row.id).waitsOn.push({ kind: 'issue', node: entry.node, activity: entry.activity ?? null, freshness: entry.freshness })
      }
    }
  }
  // a dependent's side may be all we know: GitHub's "blocking" of a row's open issue
  for (const path of paths) {
    const row = path.row
    const rel = relOf(row)
    const deps_ = rel && rel.dependencies && rel.dependencies.status === 'ok' && rel.node.state === 'OPEN' ? rel.dependencies : null
    for (const { node, activity } of deps_ ? deps_.unblocks : []) {
      const dependent = stepOf.get(node.key)
      if (dependent) edge(dependent, row, ['github'])
      else external.get(row.id).unblocks.push({ kind: 'issue', node, activity, freshness: rel.freshness })
    }
  }
  const waitsOn = new Map(paths.map((path) => [path.row.id, []]))
  const unblocks = new Map(paths.map((path) => [path.row.id, []]))
  // both lists follow the agent's row order, as the flow itself does
  for (const path of paths) {
    for (const { waiter, target, sources } of edges.values()) {
      if (target.id === path.row.id) waitsOn.get(waiter.id).push(stepEntry(target, sources))
      if (waiter.id === path.row.id) unblocks.get(target.id).push(stepEntry(waiter, sources))
    }
  }
  const planRel = (() => {
    const identity = issueKeyFor(board, linkFor((deps && deps.links) ?? null, board))
    return identity && identity.certain ? drawn(relations.get(identity.key)) : null
  })()
  const loops = localCycles(rows)
  for (const path of paths) {
    const rel = relOf(path.row)
    const parent = rel ? rel.trail[rel.trail.length - 1] ?? null : null
    path.waitsOn = [...waitsOn.get(path.row.id), ...external.get(path.row.id).waitsOn]
    path.unblocks = [...unblocks.get(path.row.id), ...external.get(path.row.id).unblocks]
    path.partOf = parent && parent.key !== planRel?.node.key ? { node: parent, freshness: rel.freshness } : null
    path.circular = loops.has(path.row.id) || Boolean(rel && rel.dependencies && rel.dependencies.status === 'ok' && rel.dependencies.cycle)
  }
  const outside = planRel ? planRel.children.filter((child) => child.node && !linked.has(child.node.key)) : []
  return outside.length ? { list: outside, freshness: planRel.freshness } : null
}

export function buildMission(board, deps = null) {
  const done = board?.progress?.done ?? 0
  const countable = board?.progress?.countable ?? 0
  const rows = (board.rows ?? []).filter((row) => row && typeof row.id === 'string')
  const paths = rows
    .filter((row) => row.status !== 'na')
    .map((row) => ({
      row,
      result: row.outcome
        ? { kind: 'outcome', text: row.outcome }
        : row.next_after ? { kind: 'next', text: row.next_after } : null,
      waitsOn: [],
      unblocks: [],
      partOf: null,
      circular: false,
    }))
  const outside = deps ? dependenciesOf(board, rows, paths, deps) : null
  return {
    root: {
      id: board.id,
      title: board.title,
      project: board.project,
      progress: `${done}/${countable}`,
    },
    paths,
    outside,
  }
}
