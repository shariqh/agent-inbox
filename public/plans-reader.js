// Slow links, step 2: the poll's plans list, read in pieces. A change to one plan used to make
// the poll download every plan again (`/api/boards`, megabytes on a slow link). This reader asks
// `/api/boards/tags` for each active plan's tag, then `/api/boards/plans?ids=` for only the plans
// it does not hold at that tag, and assembles the list `/api/boards` would have sent: the same
// frozen plans in the same order. To the poll it looks like that one read did.

// ids per /api/boards/plans request; the requests of one round run one after another
const CHUNK = 10

const sameTags = (a, b) => a.length === b.length && a.every((entry, n) => entry.id === b[n].id && entry.tag === b[n].tag)

/**
 * `readSnapshot` is the page's snapshot reader (public/snapshots.js), so every read keeps its
 * validator and the stall limit. Each call is one read of the plans list.
 */
export function createPlansReader(readSnapshot) {
  // id -> { tag, plan }: every plan held, frozen as the hub sent it, kept across rounds
  const held = new Map()
  // the tags the last list was assembled for, and that list; null while it was not whole
  let assembled = null
  return async () => {
    const tags = await readSnapshot('/api/boards/tags')
    // a hub without the route: the whole list, exactly as before, for this round
    if (tags.status === 404) return readSnapshot('/api/boards')
    const boot = tags.headers.get('x-inbox-boot')
    let parsed
    return {
      headers: tags.headers,
      status: tags.status,
      json() {
        parsed ??= (async () => {
          const named = (await tags.json()).plans
          // the page's idle check compares the list by identity
          if (assembled && sameTags(assembled.tags, named)) return assembled.plans
          const wanted = named.filter((entry) => held.get(entry.id)?.tag !== entry.tag).map((entry) => entry.id)
          for (let start = 0; start < wanted.length; start += CHUNK) {
            const url = `/api/boards/plans?ids=${wanted.slice(start, start + CHUNK).join(',')}`
            const read = await readSnapshot(url)
            if (read.headers.get('x-inbox-boot') !== boot) throw new Error(`The hub restarted during the plans read: ${url}`)
            // kept at once: a later request that fails fails the round, and the next asks only for the rest
            for (const { tag, plan } of (await read.json()).plans) held.set(plan.id, { tag, plan })
          }
          const ids = new Set(named.map((entry) => entry.id))
          for (const id of held.keys()) if (!ids.has(id)) held.delete(id)
          // a plan still not held vanished between the two reads; the next round's tags settle it
          const plans = Object.freeze(named.filter((entry) => held.has(entry.id)).map((entry) => held.get(entry.id).plan))
          assembled = named.every((entry) => held.get(entry.id)?.tag === entry.tag) ? { tags: named, plans } : null
          return plans
        })()
        return parsed
      },
    }
  }
}
