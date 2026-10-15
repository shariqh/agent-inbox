// Pure search + pagination helpers for the viewer.
// No external imports: the fuzzy engine is injected as `filterFn`, so this
// module stays dependency-free and unit-testable in Node. The browser passes
// in window.uFuzzy's .filter; tests pass a stub or the real engine.

// One lowercased searchable string for an entity. Boards carry `.rows`; items
// do not — that is how the two shapes are told apart.
export function haystackFor(entity) {
  const parts = [entity.title, entity.project, entity.agent, entity.stream]
  if (Array.isArray(entity.rows)) {
    for (const r of entity.rows) {
      parts.push(r.label, r.note, r.next_step, r.action_owner, r.impact, r.next_after, r.context, r.annotation, r.outcome)
      for (const option of r.options ?? []) parts.push(option.label, option.detail)
    }
  } else {
    parts.push(entity.detail, entity.next_step, entity.action_owner, entity.impact, entity.next_after, entity.context, entity.kind, entity.annotation, entity.reply, entity.reply_context, entity.outcome)
    for (const option of entity.options ?? []) parts.push(option.label, option.detail)
  }
  return parts.filter(Boolean).join(' ').toLowerCase()
}

function queryParts(query) {
  const exclusions = []
  const positive = query.replace(/(?:^|\s)-(?:"[^"\n]+"|[a-z\d']+)/gi, (match) => {
    const value = match.trim().slice(1)
    exclusions.push(value.startsWith('"') ? value.slice(1, -1) : value.replace(/\p{P}/gu, ''))
    return ' '
  })
  return { terms: positive.match(/"[^"\n]+"|[a-z\d']+/gi) ?? [], exclusions }
}

export function searchTerms(query) {
  return queryParts(query).terms
}

const searchOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

// uFuzzy's multi-term regexp backtracks across every intervening row/background.
// Match one term at a time instead; earliest-ending prefixes make ordered matching
// monotone, without truncating text or limiting how far apart terms may be.
export function createBoundedMatcher(searchFn) {
  const cache = new Map()
  function single(text, term) {
    let entries = cache.get(term)
    if (!entries) cache.set(term, entries = new Map())
    if (!entries.has(text)) {
      const match = searchFn([text], term)?.find((candidate) => candidate.index === 0)
      entries.set(text, match?.ranges?.length ? match.ranges : null)
    }
    return entries.get(text)
  }

  function earliest(text, term, ranges) {
    let low = 0
    let high = ranges.at(-1)
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      const found = single(text.slice(0, middle), term)
      if (found) {
        ranges = found
        high = found.at(-1)
      } else low = middle + 1
    }
    return ranges
  }

  function ordered(text, terms) {
    const parts = []
    let cursor = 0
    for (const [index, term] of terms.entries()) {
      const suffix = text.slice(cursor)
      let ranges = single(suffix, term)
      if (!ranges) return null
      if (index < terms.length - 1) ranges = earliest(suffix, term, ranges)
      parts.push(ranges.map((offset) => cursor + offset))
      cursor += ranges.at(-1)
    }
    // Earliest matches can be short typo variants. Prefer a complete/exact term
    // within the already-proven gap, never by consuming the next term's match.
    for (let index = 0; index < parts.length - 1; index += 1) {
      const start = index === 0 ? 0 : parts[index - 1].at(-1)
      const end = parts[index + 1][0]
      const refined = single(text.slice(start, end), terms[index])
      if (refined) parts[index] = refined.map((offset) => start + offset)
    }
    return parts
  }

  function scored(text, terms, parts, index) {
    let inexact = 0
    let boundaries = 0
    let length = 0
    for (const [termIndex, ranges] of parts.entries()) {
      let matched = ''
      for (let offset = 0; offset < ranges.length; offset += 2) {
        matched += text.slice(ranges[offset], ranges[offset + 1])
        length += ranges[offset + 1] - ranges[offset]
      }
      const term = terms[termIndex].replace(/^"|"$/g, '')
      if (matched.toLocaleLowerCase() !== term.toLocaleLowerCase()) inexact += 1
      else {
        const start = ranges[0]
        const end = ranges.at(-1)
        const left = start === 0 || /[^a-z\d]/i.test(text[start - 1])
        const right = end === text.length || /[^a-z\d]/i.test(text[end])
        if (left) boundaries += right ? 2 : 1
      }
    }
    const ranges = parts.flat()
    return {
      index, ranges, inexact, boundaries,
      gap: ranges.at(-1) - ranges[0] - length,
      start: ranges[0],
    }
  }

  return (values, query) => {
    const { terms, exclusions } = queryParts(query)
    if (terms.length < 2) return searchFn(values, query)
    const negatives = exclusions.filter(Boolean).map((value) =>
      new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
    const probes = [...new Set(terms)].sort((left, right) =>
      Number(/^\d+$/.test(right)) - Number(/^\d+$/.test(left)) || right.length - left.length)
    const matches = []
    for (const [index, text] of values.entries()) {
      if (negatives.some((negative) => negative.test(text))) continue
      if (probes.some((term) => !single(text, term))) continue
      const parts = ordered(text, terms)
      if (parts) matches.push(scored(text, terms, parts, index))
    }
    matches.sort((left, right) =>
      left.inexact - right.inexact
      || right.boundaries - left.boundaries
      || left.gap - right.gap
      || left.start - right.start
      || searchOrder.compare(values[left.index], values[right.index])
      || left.index - right.index)
    return matches.map(({ index, ranges }) => ({ index, ranges }))
  }
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
