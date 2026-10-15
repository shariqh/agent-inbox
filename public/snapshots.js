const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const strings = (value, keys) => record(value) && keys.every((key) => typeof value[key] === 'string')
const item = (value) => strings(value, ['id', 'title', 'project', 'agent', 'kind', 'status'])
const group = (value) => strings(value, ['project']) && Array.isArray(value.items) && value.items.every(item)
const items = (value) => record(value)
  && Array.isArray(value.needsYou) && value.needsYou.every(group)
  && Array.isArray(value.notes) && value.notes.every(group)
  && Array.isArray(value.done) && value.done.every(item)
const boards = (value) => Array.isArray(value) && value.every((board) =>
  strings(board, ['id', 'title', 'project', 'agent'])
  && Array.isArray(board.rows) && board.rows.every((row) => strings(row, ['id', 'label', 'status']))
  && record(board.progress) && ['done', 'countable', 'fraction'].every((key) => Number.isFinite(board.progress[key])))
const validators = new Map([
  ['/api/items', items],
  ['/api/boards', boards],
  ['/api/boards/archived', boards],
])

function freezeSnapshot(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeSnapshot(child)
    Object.freeze(value)
  }
  return value
}

// Window-local authoritative snapshots. Consumers derive views without mutating
// these frozen values; optimistic state (such as closed projects) stays separate.
export function createSnapshotReader(fetcher) {
  const cache = new Map()
  const latest = new Map()
  let generation = 0
  return async (url) => {
    const validate = validators.get(url)
    if (!validate) throw new Error(`Unsupported snapshot route: ${url}`)
    const requested = cache.get(url)
    const requestGeneration = ++generation
    latest.set(url, requestGeneration)
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
          if (latest.get(url) === requestGeneration) {
            if (etag) cache.set(url, { etag, value })
            else cache.delete(url)
          }
          return value
        })()
        return parsed
      },
    }
  }
}
