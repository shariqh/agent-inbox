// Conditional reads for the dock watcher (issue #287). Electron main asks the
// viewer for the same representations every 3 seconds, and almost every time it
// already holds their bytes. Each read sends the validator its last 200 carried;
// a bodyless 304 means the bytes are unchanged, so the reader hands back what it
// parsed then and nothing is sent, copied or parsed again.
//
// A 200 without a validator (a viewer from before conditional snapshots, or a
// route that has none) is parsed every time and never held. A failed read (no
// answer at all, an answer other than a 200 or a 304 to what is held, or a body
// that does not parse) throws and drops what was held, so the next one asks
// unconditionally: a failure is never answered from a cached success, and a
// viewer that comes back after a failure is never asked to revalidate what
// another instance sent.
//
// One reader per watcher. Values are held per exact URL and shared with the
// caller, who must treat them as read-only.
function createConditionalReader(fetchImpl = (url, init) => fetch(url, init)) {
  const held = new Map()
  return async function read(url) {
    const last = held.get(url)
    let response
    try {
      response = await fetchImpl(url, last ? { headers: { 'If-None-Match': last.etag } } : {})
    } catch (error) {
      held.delete(url)
      throw error
    }
    if (response.status === 304 && last) return last.value
    held.delete(url)
    if (response.status !== 200) throw new Error(`${url} answered HTTP ${response.status}`)
    const value = await response.json()
    const etag = response.headers.get('etag')
    if (etag) held.set(url, { etag, value })
    return value
  }
}

module.exports = { createConditionalReader }
