const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const strings = (value, keys) => record(value) && keys.every((key) => typeof value[key] === 'string')
const counts = (value, keys) => record(value) && keys.every((key) => Number.isInteger(value[key]) && value[key] >= 0)
const item = (value) => strings(value, ['id', 'title', 'project', 'agent', 'kind', 'status'])
const group = (value) => strings(value, ['project']) && Array.isArray(value.items) && value.items.every(item)
// Issue #184: what a page omitted from closed history. Absent means complete.
const closedHistory = (value) => value === undefined || (counts(value, ['total', 'loaded'])
  && (value.before === null || typeof value.before === 'string')
  && Array.isArray(value.older)
  && value.older.every((older) => strings(older, ['project', 'agent']) && counts(older, ['items', 'outcomes'])
    && (older.latest === undefined || older.latest === null || typeof older.latest === 'string')))
const items = (value) => record(value)
  && Array.isArray(value.needsYou) && value.needsYou.every(group)
  && Array.isArray(value.notes) && value.notes.every(group)
  && Array.isArray(value.done) && value.done.every(item)
  && closedHistory(value.history)
const history = (value) => record(value) && Array.isArray(value.done) && value.done.every(item)
const boards = (value) => Array.isArray(value) && value.every((board) =>
  strings(board, ['id', 'title', 'project', 'agent'])
  && Array.isArray(board.rows) && board.rows.every((row) => strings(row, ['id', 'label', 'status']))
  && record(board.progress) && ['done', 'countable', 'fraction'].every((key) => Number.isFinite(board.progress[key])))
const spans = (value) => Array.isArray(value) && value.every(record)
// Issue #103: the sub-issue graph, version 1. Only its shape is checked here;
// public/issues.js validates each node and edge again before drawing it.
const issueGraph = (value) => record(value) && value.version === 1
  && Array.isArray(value.nodes) && value.nodes.every((node) => strings(node, ['key']))
  && Array.isArray(value.edges) && value.edges.every((edge) => strings(edge, ['from', 'to']))
  && Array.isArray(value.roots) && value.roots.every((root) => strings(root, ['key']))
  && record(value.aliases)
const validators = new Map([
  ['/api/items', items],
  ['/api/items/history', history],
  ['/api/boards', boards],
  ['/api/boards/archived', boards],
  ['/api/activity/history', spans],
  ['/api/issues', issueGraph],
])
// The only route whose query string selects one of its own representations
// (#185). Anywhere else a query names a different representation, such as the
// dock watcher's `/api/items?scope=attention`, which must never enter (and so
// never share or evict) the slot of the route it shares a path with.
const QUERY_ROUTES = new Set(['/api/activity/history'])

const HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
const HISTORY_STEP_MS = 60 * 60 * 1000

// The poll's 30-day history window (issue #185). Its start is floored to the
// hour, so successive ticks name the same representation and can revalidate it.
// The extra hour is clipped by the dashboard's own range.
export function activityHistoryUrl(nowMs) {
  const sinceMs = Math.floor((nowMs - HISTORY_WINDOW_MS) / HISTORY_STEP_MS) * HISTORY_STEP_MS
  return `/api/activity/history?since_ms=${sinceMs}`
}

function freezeSnapshot(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeSnapshot(child)
    Object.freeze(value)
  }
  return value
}

// Window-local authoritative snapshots. Consumers derive views without mutating
// these frozen values; optimistic state (such as closed projects) stays separate.
// A query string selects one representation of its route. Each route retains only
// its newest representation, reused only for the exact URL that fetched it.
export function createSnapshotReader(fetcher) {
  const cache = new Map()
  const latest = new Map()
  let generation = 0
  return async (url) => {
    const route = url.split('?')[0]
    const validate = validators.get(route)
    if (!validate || (url !== route && !QUERY_ROUTES.has(route))) throw new Error(`Unsupported snapshot route: ${url}`)
    const held = cache.get(route)
    const requested = held?.url === url ? held : undefined
    const requestGeneration = ++generation
    latest.set(route, requestGeneration)
    const response = await fetcher(url, {
      cache: 'no-store',
      ...(requested ? { headers: { 'If-None-Match': requested.etag } } : {}),
    })
    const etag = response.headers.get('etag')?.trim()
    let parsed
    return {
      headers: response.headers,
      status: response.status,
      json() {
        parsed ??= (async () => {
          if (response.status === 304) {
            if (!requested) throw new Error(`Invalid snapshot 304 without a representation: ${url}`)
            // Pin to what this request revalidated, not a later overlapping read.
            return requested.value
          }
          if (response.status !== 200) throw new Error(`Snapshot ${url} failed (HTTP ${response.status})`)
          let value
          try { value = await response.json() } catch { throw new Error(`Invalid snapshot JSON: ${url}`) }
          if (!validate(value)) throw new Error(`Invalid snapshot payload: ${url}`)
          freezeSnapshot(value)
          if (latest.get(route) === requestGeneration) {
            if (etag) cache.set(route, { url, etag, value })
            else cache.delete(route)
          }
          return value
        })()
        return parsed
      },
    }
  }
}
