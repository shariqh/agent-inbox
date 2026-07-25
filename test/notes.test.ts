import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { partitionNotes, unreadNotes, unreadNoteCount, ambientChips, seenWatermark } from '../public/notes.js'

const NOW = Date.parse('2026-07-24T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const DAY = 24 * 3600e3

const note = (id: string, createdAgoMs: number) => ({
  id, kind: 'note' as const, status: 'open' as const, project: 'api', title: id,
  created_at: ago(createdAgoMs), reply: null, reply_seen_at: null,
})

describe('partitionNotes', () => {
  it('ages notes older than 7 days out of the notes bucket', () => {
    const { fresh, aged } = partitionNotes([note('new', DAY), note('old', 8 * DAY)], NOW)
    expect(fresh.map((n) => n.id)).toEqual(['new'])
    expect(aged.map((n) => n.id)).toEqual(['old'])
  })
  it('keeps a note that is exactly at the boundary', () => {
    const { fresh } = partitionNotes([note('edge', 7 * DAY)], NOW)
    expect(fresh.map((n) => n.id)).toEqual(['edge'])
  })
})

describe('unreadNotes', () => {
  const notes = [note('a', 2 * DAY), note('b', 1 * DAY), note('c', 9 * DAY)]
  it('counts everything when the user has never looked', () => {
    expect(unreadNotes(notes, null, NOW).map((n) => n.id)).toEqual(['a', 'b'])
  })
  it('counts only notes created after the last look', () => {
    expect(unreadNotes(notes, ago(1.5 * DAY), NOW).map((n) => n.id)).toEqual(['b'])
  })
  it('never counts an aged-out note as new', () => {
    expect(unreadNotes(notes, ago(30 * DAY), NOW).map((n) => n.id)).toEqual(['a', 'b'])
  })
  it('unreadNoteCount agrees with unreadNotes', () => {
    expect(unreadNoteCount(notes, ago(1.5 * DAY), NOW)).toBe(1)
    expect(unreadNoteCount([], null, NOW)).toBe(0)
  })
})

describe('ambientChips', () => {
  const items = [
    { ...note('n1', DAY) },
    { id: 'q1', kind: 'question', status: 'open', project: 'api', title: 'q', created_at: ago(DAY), reply: 'yes', reply_seen_at: null },
    { id: 'q2', kind: 'question', status: 'open', project: 'api', title: 'q', created_at: ago(DAY), reply: 'yes', reply_seen_at: ago(60e3) },
    { id: 'm1', kind: 'done', status: 'open', project: 'api', title: 'shipped', created_at: ago(DAY), reply: null, reply_seen_at: null },
  ]
  const boards = [
    { id: 'b1', project: 'api', progress: { done: 2, countable: 2, fraction: 1 } },
    { id: 'b2', project: 'api', progress: { done: 1, countable: 4, fraction: 0.25 } },
  ]

  it('returns discrete chips, not one joined string', () => {
    const chips = ambientChips(items, boards, NOW, null)
    expect(chips.map((c) => c.key)).toEqual(['awaiting', 'notes', 'milestones', 'boards'])
    expect(chips.map((c) => c.label)).toEqual([
      '1 answered · awaiting agent', '1 new note', '1 milestone', '2 boards · 1 complete',
    ])
  })
  it('drops chips whose count is zero', () => {
    expect(ambientChips([], [], NOW, null)).toEqual([])
  })
  it('drops the notes chip once they have been seen', () => {
    expect(ambientChips(items, boards, NOW, ago(0)).map((c) => c.key)).not.toContain('notes')
  })
  it('pluralises', () => {
    const two = [note('n1', DAY), note('n2', DAY)]
    expect(ambientChips(two, [], NOW, null)[0]!.label).toBe('2 new notes')
  })
})

// The triage deck survives (spec §15) but the old #now strip that used to open it
// is gone, so the Needs-you header is now its ONLY entry point. Assert it exists
// and that nothing opens the deck by itself (tenet 1: opt-in, never self-opening).
describe('triage stays reachable from Needs-you', () => {
  const appJs = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')

  it('the Needs-you header carries the opt-in Triage button', () => {
    expect(appJs).toMatch(/function needsYouHeader\(\)[\s\S]*?btn\('Triage →', openTriage\)/)
  })
  it('renderNeedsYou renders that header', () => {
    expect(appJs).toMatch(/function renderNeedsYou\([^)]*\)\s*\{[\s\S]*?needsYouHeader\(\)/)
  })
  it('the auto-opening #now strip is not back', () => {
    expect(appJs).not.toContain('renderNow')
  })
})

// Fix round 2 (I3): opening the Notes tab used to stamp ONE global
// `notesSeenAt = now` on every render, marking notes read that were never on
// screen — including everything behind the "Show N more" pager, and everything
// the rail's project filter was hiding. A single watermark can only honestly
// advance to a point below every note the user was NOT shown.
describe('seenWatermark', () => {
  const prev = null
  it('advances to the newest note that was actually rendered', () => {
    const rendered = [note('a', 3 * DAY), note('b', 1 * DAY)]
    expect(seenWatermark(rendered, [], prev)).toBe(ago(1 * DAY))
  })
  it('never advances past a note the pager left hidden', () => {
    const rendered = [note('a', 3 * DAY), note('b', 1 * DAY)]
    const hidden = [note('c', 2 * DAY)] // older than `b`, so `b` cannot be the watermark
    expect(seenWatermark(rendered, hidden, prev)).toBe(ago(3 * DAY))
  })
  it('does not move at all when every rendered note is newer than a hidden one', () => {
    const rendered = [note('a', 1 * DAY)]
    const hidden = [note('c', 5 * DAY)]
    expect(seenWatermark(rendered, hidden, prev)).toBeNull()
  })
  it('never moves backwards', () => {
    const rendered = [note('a', 5 * DAY)]
    expect(seenWatermark(rendered, [], ago(1 * DAY))).toBe(ago(1 * DAY))
  })
  it('keeps the previous mark when nothing was rendered', () => {
    expect(seenWatermark([], [], ago(2 * DAY))).toBe(ago(2 * DAY))
    expect(seenWatermark([], [], null)).toBeNull()
  })
})
