import { haystackFor } from './search.js'

const groupedItems = (groups = []) => groups.flatMap((group) => group.items ?? [])

const SECTION_DEFS = [
  { id: 'open', label: 'Open items', kind: 'Open item', tab: 'needsYou' },
  { id: 'plans', label: 'Active plans', kind: 'Active plan', tab: 'boards' },
  { id: 'notes', label: 'Notes', kind: 'Note', tab: 'notes' },
  { id: 'history', label: 'History', kind: 'History', tab: 'done' },
  { id: 'archived', label: 'Archived plans', kind: 'Archived plan', tab: 'boards' },
]

function cleanText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function addField(fields, key, label, value, { field = key, rowId = null } = {}) {
  const text = cleanText(value)
  if (text) fields.push({ key, label, text, field, rowId })
}

function itemFields(item) {
  const fields = []
  addField(fields, 'title', 'Title', item.title)
  addField(fields, 'detail', 'Details', item.detail)
  addField(fields, 'next-step', 'Next step', item.next_step)
  addField(fields, 'owner', 'Owner', item.action_owner)
  addField(fields, 'impact', 'Impact', item.impact)
  addField(fields, 'next', 'Then', item.next_after)
  addField(fields, 'context', 'Background', item.context)
  addField(fields, 'annotation', 'Human note', item.annotation)
  addField(fields, 'reply', 'Answer', item.reply)
  addField(fields, 'reply-context', 'Answer context', item.reply_context)
  addField(fields, 'outcome', 'Outcome', item.outcome)
  for (const [optionIndex, option] of (item.options ?? []).entries()) {
    const optionName = cleanText(option.label) || `Option ${optionIndex + 1}`
    addField(fields, `option-${optionIndex}`, 'Option', option.label, { field: 'option' })
    addField(fields, `option-${optionIndex}-detail`, `${optionName} · Option detail`, option.detail, { field: 'option-detail' })
  }
  addField(fields, 'project', 'Project', item.project)
  addField(fields, 'stream', 'Stream', item.stream)
  addField(fields, 'agent', 'Agent', item.agent)
  addField(fields, 'kind', 'Type', item.kind)
  return fields
}

function boardFields(board) {
  const fields = []
  addField(fields, 'title', 'Title', board.title)
  for (const [rowIndex, row] of (board.rows ?? []).entries()) {
    const rowName = cleanText(row.label) || `Row ${rowIndex + 1}`
    const meta = (field) => ({ field, rowId: row.id ?? null })
    addField(fields, `row-${rowIndex}-label`, 'Plan row', row.label, meta('label'))
    addField(fields, `row-${rowIndex}-note`, `${rowName} · Note`, row.note, meta('note'))
    addField(fields, `row-${rowIndex}-next-step`, `${rowName} · Next step`, row.next_step, meta('next-step'))
    addField(fields, `row-${rowIndex}-owner`, `${rowName} · Owner`, row.action_owner, meta('owner'))
    addField(fields, `row-${rowIndex}-impact`, `${rowName} · Impact`, row.impact, meta('impact'))
    addField(fields, `row-${rowIndex}-next`, `${rowName} · Then`, row.next_after, meta('next'))
    addField(fields, `row-${rowIndex}-context`, `${rowName} · Background`, row.context, meta('context'))
    addField(fields, `row-${rowIndex}-annotation`, `${rowName} · Human note`, row.annotation, meta('annotation'))
    addField(fields, `row-${rowIndex}-outcome`, `${rowName} · Outcome`, row.outcome, meta('outcome'))
    for (const [optionIndex, option] of (row.options ?? []).entries()) {
      addField(fields, `row-${rowIndex}-option-${optionIndex}`, `${rowName} · Option`, option.label, meta('option'))
      addField(fields, `row-${rowIndex}-option-${optionIndex}-detail`, `${rowName} · Option detail`, option.detail, meta('option-detail'))
    }
  }
  addField(fields, 'project', 'Project', board.project)
  addField(fields, 'stream', 'Stream', board.stream)
  addField(fields, 'agent', 'Agent', board.agent)
  return fields
}

function fieldsFor(entity) {
  return Array.isArray(entity.rows) ? boardFields(entity) : itemFields(entity)
}

function rankedMatches(values, query, searchFn) {
  return (searchFn(values, query) ?? []).filter((match) => (
    Number.isInteger(match?.index) && match.index >= 0 && match.index < values.length
  ))
}

function rankedEntities(entities, query, searchFn) {
  return rankedMatches(entities.map(haystackFor), query, searchFn)
    .map((match) => entities[match.index])
    .filter(Boolean)
}

function normalizeRanges(ranges, length) {
  const rawPairs = []
  for (let index = 0; index < (ranges?.length ?? 0); index += 2) {
    const start = Math.max(0, Math.min(length, Number(ranges[index])))
    const end = Math.max(start, Math.min(length, Number(ranges[index + 1])))
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    rawPairs.push([start, end])
  }
  rawPairs.sort((left, right) => left[0] - right[0] || left[1] - right[1])
  const pairs = []
  for (const [start, end] of rawPairs) {
    const previous = pairs[pairs.length - 1]
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end)
    else pairs.push([start, end])
  }
  return pairs.flat()
}

function matchTerms(query) {
  return (query.match(/"[^"]+"|\S+/g) ?? [])
    .map((term) => term.replace(/^"|"$/g, ''))
    .filter((term) => term && !term.startsWith('-'))
    .sort((left, right) => right.length - left.length)
}

function directFieldMatch(fields, query, searchFn) {
  const values = fields.map((field) => field.text)
  const match = rankedMatches(values, query, searchFn)[0]
  const field = match ? fields[match.index] : null
  return match && field
    ? { field, ranges: normalizeRanges(match.ranges, field.text.length) }
    : null
}

function firstTermFieldMatch(fields, terms, searchFn) {
  for (const term of terms) {
    const fieldMatch = directFieldMatch(fields, term, searchFn)
    if (fieldMatch) return { term, ...fieldMatch }
  }
  return null
}

function matchSnippet(text, ranges, maxLength = 160) {
  const normalized = normalizeRanges(ranges, text.length)
  if (text.length <= maxLength) return { text, ranges: normalized }
  if (normalized.length < 2) return { text: `${text.slice(0, maxLength)}…`, ranges: [] }
  const matchStart = normalized[0]
  const matchEnd = normalized[1]
  let start = Math.max(0, matchStart - 48)
  let end = Math.min(text.length, start + maxLength)
  if (matchEnd > end) {
    end = Math.min(text.length, matchEnd + 48)
    start = Math.max(0, end - maxLength)
  } else if (end === text.length) {
    start = Math.max(0, end - maxLength)
  }

  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  const snippetRanges = []
  for (let index = 0; index < normalized.length; index += 2) {
    const rangeStart = Math.max(start, normalized[index])
    const rangeEnd = Math.min(end, normalized[index + 1])
    if (rangeEnd <= rangeStart) continue
    snippetRanges.push(
      prefix.length + rangeStart - start,
      prefix.length + rangeEnd - start,
    )
  }
  return {
    text: `${prefix}${text.slice(start, end)}${suffix}`,
    ranges: snippetRanges,
  }
}

function matchFragments(text, ranges) {
  const seen = new Set()
  const fragments = []
  const normalized = normalizeRanges(ranges, text.length)
  for (let index = 0; index < normalized.length; index += 2) {
    const fragment = text.slice(normalized[index], normalized[index + 1]).trim()
    const key = fragment.toLocaleLowerCase()
    if (!fragment || seen.has(key)) continue
    seen.add(key)
    fragments.push(fragment)
  }
  return fragments
}

function resultContext(entity) {
  return [entity.project, entity.stream, entity.agent].map(cleanText).filter(Boolean).join(' · ')
}

function buildResult(entity, section, query, searchFn) {
  const fields = fieldsFor(entity)
  const title = cleanText(entity.title)
  const titleField = fields.find((field) => field.key === 'title')
  const terms = matchTerms(query)
  const directTitleMatch = titleField ? directFieldMatch([titleField], query, searchFn) : null
  const titleTermMatches = directTitleMatch || !titleField
    ? []
    : terms.map((term) => ({ term, match: directFieldMatch([titleField], term, searchFn) }))
      .filter((candidate) => candidate.match)
  const titleRanges = directTitleMatch?.ranges ?? normalizeRanges(
    titleTermMatches.flatMap((candidate) => candidate.match.ranges),
    title.length,
  )
  const hiddenFields = fields.filter((field) => field.key !== 'title')
  let evidence = null
  if (!directTitleMatch) {
    evidence = directFieldMatch(hiddenFields, query, searchFn)
    if (!evidence) {
      const titleTerms = new Set(titleTermMatches.map((candidate) => candidate.term))
      const unmatchedTerms = terms.filter((term) => !titleTerms.has(term))
      const hiddenTermMatch = firstTermFieldMatch(
        hiddenFields,
        unmatchedTerms.length ? unmatchedTerms : terms,
        searchFn,
      )
      evidence = hiddenTermMatch
    }
  }
  const match = evidence
    ? { label: evidence.field.label, ...matchSnippet(evidence.field.text, evidence.ranges) }
    : null
  const sourceMatch = evidence ?? (
    titleField && titleRanges.length
      ? { field: titleField, ranges: titleRanges }
      : null
  )
  const source = sourceMatch
    ? {
        field: sourceMatch.field.field,
        rowId: sourceMatch.field.rowId,
        text: sourceMatch.field.text,
        fragments: matchFragments(sourceMatch.field.text, sourceMatch.ranges),
      }
    : null
  return {
    key: `${Array.isArray(entity.rows) ? 'board' : 'item'}:${entity.id}`,
    targetId: entity.id,
    tab: section.tab,
    section: section.id,
    sectionLabel: section.label,
    kind: section.kind,
    title,
    titleRanges,
    match,
    source,
    context: resultContext(entity),
  }
}

export function buildSearchResults(data, query, searchFn, limit = 20) {
  const needle = (query ?? '').trim()
  if (!needle || !data) return []

  const sections = [
    { ...SECTION_DEFS[0], entities: groupedItems(data.g?.needsYou) },
    { ...SECTION_DEFS[1], entities: data.boards ?? [] },
    { ...SECTION_DEFS[2], entities: groupedItems(data.g?.notes) },
    { ...SECTION_DEFS[3], entities: data.g?.done ?? [] },
    { ...SECTION_DEFS[4], entities: data.archived ?? [] },
  ]
  const seen = new Set()
  const results = []

  for (const section of sections) {
    for (const entity of rankedEntities(section.entities, needle, searchFn)) {
      if (!entity || seen.has(entity.id)) continue
      seen.add(entity.id)
      results.push(buildResult(entity, section, needle, searchFn))
      if (results.length >= limit) return results
    }
  }
  return results
}
