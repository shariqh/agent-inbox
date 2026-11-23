// UX pass, slice 4: Find's pure row builder (public/find.js): each kind under each
// chip, the stamps, the cut by a row's own stamp, the extras, the bar from counts,
// the order with and without a query, more than 20 matches, and the age formatter.
import { describe, expect, it } from 'vitest'
import uFuzzy from '@leeoniya/ufuzzy'
import { FIND_CHIPS, FIND_PAGE, buildFindRows, findAge, findRow } from '../public/find.js'

const uf = new uFuzzy({ intraMode: 1 })
const fuzzy = (hay: string[], needle: string): Array<{ index: number; ranges: number[] }> | null => {
  const [matches, info, order] = uf.search(hay, needle, 0, Number.POSITIVE_INFINITY)
  return info && order
    ? order.map((index) => ({ index: info.idx[index]!, ranges: info.ranges[index] ?? [] }))
    : matches?.map((index) => ({ index, ranges: [] })) ?? null
}

const NOW = Date.parse('2026-11-23T12:00:00.000Z')
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const at = (agoMs: number) => new Date(NOW - agoMs).toISOString()

type Rec = Record<string, any>
const base = { project: 'atlas', stream: 'main', agent: 'claude' }
const item = (id: string, extra: Rec): Rec => ({ id, ...base, title: `Item ${id}`, status: 'open', created_at: at(DAY * 30), ...extra })
const plan = (id: string, extra: Rec = {}): Rec => ({
  id, ...base, title: `Plan ${id}`, status: 'active', updated_at: at(DAY), progress: { done: 1, partial: 0, countable: 2 },
  rows: [{ id: `${id}-r1`, label: 'First', status: 'done' }, { id: `${id}-r2`, label: 'Second', status: 'partial' }], ...extra,
})
const data = (parts: { needsYou?: Rec[]; notes?: Rec[]; done?: Rec[]; boards?: Rec[]; archived?: Rec[] }) => ({
  g: { needsYou: [{ project: 'atlas', items: parts.needsYou ?? [] }], notes: [{ project: 'atlas', items: parts.notes ?? [] }], done: parts.done ?? [] },
  boards: parts.boards ?? [],
  archived: parts.archived ?? [],
})
const keys = (rows: Array<{ key: string }>) => rows.map((row) => row.key)

// one of every kind the page holds
const openAnswered = item('qa', { kind: 'question', title: 'Where should staging live?', reply: 'Managed', replied_at: at(2 * DAY), options: [{ label: 'Managed' }, { label: 'Self-hosted' }] })
const openAsk = item('qo', { kind: 'question', title: 'Ship the backup job?', created_at: at(HOUR) })
const closedAnswered = item('qc', { kind: 'question', title: 'Keep 30 or 90 days of backups?', status: 'resolved', reply: '30 days of backups please, thanks', replied_at: at(9 * DAY), resolved_at: at(8 * DAY) })
const closedAsk = item('qx', { kind: 'question', title: 'Swept permission', status: 'dismissed', resolved_at: at(3 * HOUR) })
const freshNote = item('n1', { kind: 'note', title: 'Backups run nightly', detail: 'The old cron job was removed and the new schedule is in infra.', created_at: at(HOUR) })
const agedNote = item('n2', { kind: 'note', title: 'An old caveat', created_at: at(10 * DAY) })
const closedNote = item('n3', { kind: 'note', title: 'Resolved caveat', status: 'resolved', created_at: at(2 * HOUR), resolved_at: at(MIN * 30) })
const dismissedNote = item('n4', { kind: 'note', title: 'Dismissed caveat', status: 'dismissed', created_at: at(3 * DAY), resolved_at: at(DAY) })
const milestone = item('m1', { kind: 'done', title: 'Shipped the exporter', created_at: at(5 * HOUR), updated_at: at(5 * HOUR) })
const outcome = item('m2', { kind: 'done', title: 'Request: fix the drill', status: 'resolved', outcome: 'Fixed the restore drill and wrote the runbook for the on-call team today', outcome_at: at(4 * HOUR), resolved_at: at(4 * HOUR) })
const handoff = item('h1', { kind: 'done', handoff: 1, title: 'Review the drill', status: 'resolved', outcome: 'Acknowledged', outcome_at: at(6 * DAY) })
const active = plan('p1', { updated_at: at(2 * HOUR) })
const archived = plan('p2', { status: 'archived', updated_at: at(14 * DAY), progress: { done: 5, partial: 0, countable: 5 }, rows: [] })

const everything = data({
  needsYou: [openAnswered, openAsk],
  notes: [freshNote],
  done: [closedAnswered, closedAsk, closedNote, dismissedNote, milestone, outcome, handoff, agedNote],
  boards: [active],
  archived: [archived],
})
const build = (options: Rec = {}) => buildFindRows(everything, { nowMs: NOW, archivedWhole: false, ...options })

describe('findAge', () => {
  it('is compact and has a week unit', () => {
    expect(findAge(0)).toBe('now')
    expect(findAge(59_000)).toBe('now')
    expect(findAge(5 * MIN)).toBe('5m')
    expect(findAge(3 * HOUR)).toBe('3h')
    expect(findAge(2 * DAY)).toBe('2d')
    expect(findAge(6 * DAY + 23 * HOUR)).toBe('6d')
    expect(findAge(7 * DAY)).toBe('1w')
    expect(findAge(21 * DAY)).toBe('3w')
    expect(findAge(-5000), 'a clock that moved back is now').toBe('now')
  })
})

describe('findRow', () => {
  it('types each kind, says what a press does, and stamps it by its own time', () => {
    const rowOf = (entity: Rec, opts: Rec = {}) => findRow(entity, { nowMs: NOW, ...opts })
    expect(rowOf(openAnswered)).toMatchObject({ type: 'answer', label: 'Answer', action: 'home', open: true, cuttable: false, stamp: NOW - 2 * DAY })
    expect(rowOf(closedAnswered)).toMatchObject({ type: 'answer', action: 'expand', cuttable: true, stamp: NOW - 8 * DAY })
    expect(rowOf(openAsk)).toMatchObject({ type: 'ask', label: 'Ask', action: 'home' })
    expect(rowOf(closedAsk)).toMatchObject({ type: 'finished', label: 'Finished', action: 'expand' })
    expect(rowOf(freshNote)).toMatchObject({ type: 'note', label: 'Note', action: 'expand', stamp: NOW - HOUR })
    expect(rowOf(closedNote), 'a note keeps its creation stamp').toMatchObject({ type: 'note', stamp: NOW - 2 * HOUR, cuttable: true })
    expect(rowOf(milestone)).toMatchObject({ type: 'finished', action: 'expand', open: true, cuttable: false, stamp: NOW - 5 * HOUR })
    expect(rowOf(outcome)).toMatchObject({ type: 'finished', stamp: NOW - 4 * HOUR })
    expect(rowOf(handoff)).toMatchObject({ type: 'finished', stamp: NOW - 6 * DAY })
    expect(rowOf(item('h2', { kind: 'done', handoff: 1, title: 'Open hand-off' }))).toMatchObject({ type: 'ask', label: 'Hand-off', action: 'home' })
    expect(rowOf(active)).toMatchObject({ key: 'board:p1', type: 'plan', label: 'Plan', action: 'plans', cuttable: false, stamp: NOW - 2 * HOUR })
    expect(rowOf(openAnswered).key).toBe('item:qa')
  })

  it('shows one small extra: the answer, the note text, the state or outcome, the bar', () => {
    const extra = (entity: Rec, opts: Rec = {}) => findRow(entity, { nowMs: NOW, ...opts }).extra
    expect(extra(openAnswered)).toEqual({ kind: 'chip', text: 'Managed', full: 'Managed' })
    expect(extra(closedAnswered)).toEqual({ kind: 'chip', text: '30 days of backups…', full: '30 days of backups please, thanks' })
    expect(extra({ ...closedAnswered, reply_kind: 'decline', reply: 'Not now' })).toMatchObject({ text: 'Declined', full: 'Not now' })
    expect(extra({ ...closedAnswered, reply_kind: 'clarify', reply: 'Which bucket?' })).toMatchObject({ text: 'Asked to clarify' })
    expect(extra(freshNote)).toEqual({
      kind: 'text', text: 'The old cron job was removed and the new schedule is in…',
      full: 'The old cron job was removed and the new schedule is in infra.',
    })
    expect(extra({ ...freshNote, detail: freshNote.title }), 'a detail that repeats the title is nothing more').toBeNull()
    expect(extra(closedNote)).toEqual({ kind: 'state', text: 'Resolved', full: '' })
    expect(extra(dismissedNote)).toEqual({ kind: 'state', text: 'Dismissed', full: '' })
    expect(extra(milestone)).toEqual({ kind: 'state', text: 'Completed', full: '' })
    expect(extra({ ...milestone, status: 'dismissed' })).toEqual({ kind: 'state', text: 'Dismissed', full: '' })
    expect(extra(outcome)).toMatchObject({ kind: 'text', text: 'Fixed the restore drill and wrote the runbook for the on-call team…' })
    expect(extra(active)).toMatchObject({ kind: 'bar', runs: false, label: '1 of 2 steps done, 1 in progress' })
    expect((extra(active) as any).segments.map((s: Rec) => s.state)).toEqual(['done', 'progress'])
  })

  it('draws an archived plan whose steps are not loaded from its progress counts', () => {
    const bar = findRow(archived, { nowMs: NOW, archived: true, fromCounts: true }).extra as any
    expect(bar.label).toBe('5 of 5 steps done')
    expect(bar.segments.map((s: Rec) => s.state)).toEqual(['done', 'done', 'done', 'done', 'done'])
    const many = findRow({ ...archived, progress: { done: 20, partial: 3, countable: 30 } }, { nowMs: NOW, archived: true, fromCounts: true }).extra as any
    expect(many.runs).toBe(true)
    expect(many.segments).toEqual([{ state: 'done', grow: 20 }, { state: 'progress', grow: 3 }, { state: 'todo', grow: 7 }])
  })
})

describe('buildFindRows with no query', () => {
  it('has the four chips, a page of 20', () => {
    expect(FIND_CHIPS).toEqual(['all', 'answers', 'notes', 'plans'])
    expect(FIND_PAGE).toBe(20)
  })

  it('lists each kind under its chips, newest first by its own stamp', () => {
    expect(keys(build({ chip: 'answers' }).rows)).toEqual(['item:qa', 'item:qc'])
    expect(keys(build({ chip: 'plans' }).rows)).toEqual(['board:p1', 'board:p2'])
    // open notes first, newest first, then closed ones
    expect(keys(build({ chip: 'notes' }).rows)).toEqual(['item:n1', 'item:n2', 'item:n3', 'item:n4'])
    // All: answers, notes, plans and finished things; no open ask, no ask closed without a reply
    expect(keys(build({ chip: 'all' }).rows)).toEqual([
      'item:n1', 'board:p1', 'item:n3', 'item:m2', 'item:m1', 'item:qa', 'item:n4', 'item:h1', 'item:qc', 'item:n2', 'board:p2',
    ])
    expect(build().rows.map((row) => row.key)).toEqual(keys(build({ chip: 'all' }).rows))
  })

  it('cuts closed items by their own stamp, never open items or plans', () => {
    // older history is omitted; its newest touch was five days ago
    const before = at(5 * DAY)
    const { rows, cut } = build({ chip: 'all', before })
    // qc (8 days), h1 (6 days) are closed and older: cut. n2 (an aged OPEN note) and p2 (a plan) stay.
    expect(keys(rows)).toEqual(['item:n1', 'board:p1', 'item:n3', 'item:m2', 'item:m1', 'item:qa', 'item:n4', 'item:n2', 'board:p2'])
    expect(cut).toBe(2)
    // created long ago, closed recently: its own stamp is later than the cut, so it stays
    const late = item('late', { kind: 'done', title: 'Old item, new outcome', status: 'resolved', created_at: at(60 * DAY), outcome: 'Done now', outcome_at: at(MIN) })
    const withLate = buildFindRows(data({ done: [late, closedAnswered] }), { nowMs: NOW, before, chip: 'all' })
    expect(keys(withLate.rows)).toEqual(['item:late'])
    expect(withLate.cut).toBe(1)
    // the Plans chip never waits on history
    expect(build({ chip: 'plans', before }).cut).toBe(0)
  })
})

describe('buildFindRows with a query', () => {
  it('keeps search order, applies the chip inside each section, and finds what has no chip under All', () => {
    const all = build({ chip: 'all', query: 'backup', searchFn: fuzzy })
    // open items first (the open ask), then notes, then finished history
    expect(keys(all.rows)).toEqual(['item:qo', 'item:n1', 'item:qc'])
    expect(all.cut).toBe(0)
    expect(keys(build({ chip: 'answers', query: 'backup', searchFn: fuzzy }).rows)).toEqual(['item:qc'])
    expect(keys(build({ chip: 'notes', query: 'backup', searchFn: fuzzy }).rows)).toEqual(['item:n1'])
    expect(keys(build({ chip: 'plans', query: 'backup', searchFn: fuzzy }).rows)).toEqual([])
    // a closed ask without a reply: left out of All with no query, found by one
    expect(keys(build({ chip: 'all' }).rows)).not.toContain('item:qx')
    expect(keys(build({ chip: 'all', query: 'swept', searchFn: fuzzy }).rows)).toEqual(['item:qx'])
    // a plan step's hit is its plan, carrying the step for the landing
    const step = build({ chip: 'plans', query: 'second', searchFn: fuzzy }).rows
    expect(keys(step)).toEqual(['board:p1'])
    expect(step[0]?.source).toMatchObject({ rowId: 'p1-r2', field: 'label' })
  })

  it('has no limit of 20 under any chip', () => {
    const many = (n: number, make: (i: number) => Rec) => Array.from({ length: n }, (_, i) => make(i))
    const big = data({
      needsYou: many(25, (i) => item(`a${i}`, { kind: 'question', title: `Lantern answer ${i}`, reply: 'Yes', replied_at: at(i * MIN) })),
      notes: many(25, (i) => item(`n${i}`, { kind: 'note', title: `Lantern note ${i}`, created_at: at(i * MIN) })),
      done: many(25, (i) => item(`d${i}`, { kind: 'done', title: `Lantern done ${i}`, status: 'resolved', resolved_at: at(i * MIN) })),
      boards: many(25, (i) => plan(`p${i}`, { title: `Lantern plan ${i}` })),
    })
    const count = (chip: string) => buildFindRows(big, { nowMs: NOW, chip: chip as any, query: 'lantern', searchFn: fuzzy }).rows.length
    expect(count('answers')).toBe(25)
    expect(count('notes')).toBe(25)
    expect(count('plans')).toBe(25)
    expect(count('all')).toBe(100)
  })
})

describe('rows the person acted on stay where they were', () => {
  it('keeps a row that left the chip in its painted place, and a kept row not painted before goes first', () => {
    const previous = keys(build({ chip: 'notes' }).rows)
    // the fresh note is resolved under the Notes chip: it would move to the closed group
    const resolved = { ...freshNote, status: 'resolved', resolved_at: at(0) }
    const after = data({ notes: [], done: [resolved, closedNote, dismissedNote, agedNote] })
    const plain = buildFindRows(after, { nowMs: NOW, chip: 'notes' })
    expect(keys(plain.rows)).toEqual(['item:n2', 'item:n1', 'item:n3', 'item:n4'])
    const kept = buildFindRows(after, { nowMs: NOW, chip: 'notes', keep: ['item:n1'], previous })
    expect(keys(kept.rows)).toEqual(['item:n1', 'item:n2', 'item:n3', 'item:n4'])
    // a row whose editor holds text stays listed under a chip that excludes it
    const plans = buildFindRows(everything, { nowMs: NOW, chip: 'plans', keep: ['item:n1'], previous: ['board:p1', 'board:p2'] })
    expect(keys(plans.rows)).toEqual(['item:n1', 'board:p1', 'board:p2'])
    // a kept key whose entity is gone is not drawn
    expect(keys(buildFindRows(everything, { nowMs: NOW, chip: 'plans', keep: ['item:gone'] }).rows)).toEqual(['board:p1', 'board:p2'])
  })
})
