import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { partitionNotes, unreadNotes, unreadNoteCount, ambientChips, seenWatermark, markSeenIds } from '../public/notes.js'

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

  // Issue #31.2. The watermark is a single ISO stamp, so it can only advance to a
  // point below EVERYTHING that stayed hidden (that is the I3 fix, and it is
  // right). The consequence: with more notes than the pager shows, the pager hides
  // the OLDEST — and there is then no stamp below it that is also at-or-above
  // anything rendered, so the mark cannot move at all and the tab count is pinned
  // until the notes age out seven days later. §8 says the count means "new since
  // you last looked" and tenet 2 forbids a count that can only grow, so the seen
  // set has to be able to name individual notes.
  it('drops a note the human has seen by id even when the watermark could not advance', () => {
    // six fresh notes, newest first — exactly what the viewer renders with PAGE.notes = 5
    const six = [0, 1, 2, 3, 4, 5].map((i) => note(`n${i}`, (i + 1) * 3600e3))
    const rendered = six.slice(0, 5)
    const hidden = six.slice(5)
    expect(seenWatermark(rendered, hidden, null), 'the watermark genuinely cannot move here').toBeNull()
    expect(unreadNoteCount(six, null, NOW), 'without the id set the count is stuck at six').toBe(6)
    const seen = new Set(rendered.map((n) => n.id))
    expect(unreadNoteCount(six, null, NOW, seen)).toBe(1)
    expect(unreadNotes(six, null, NOW, seen).map((n) => n.id)).toEqual(['n5'])
  })

  it('composes with the watermark rather than replacing it (AND-NOT on both)', () => {
    const seen = new Set(['b'])
    expect(unreadNotes(notes, null, NOW, seen).map((n) => n.id)).toEqual(['a'])
    expect(unreadNotes(notes, ago(1.5 * DAY), NOW, seen).map((n) => n.id)).toEqual([])
  })

  it('accepts an array as well as a Set — localStorage round-trips JSON', () => {
    expect(unreadNotes(notes, null, NOW, ['a']).map((n) => n.id)).toEqual(['b'])
    expect(unreadNotes(notes, null, NOW, []).map((n) => n.id)).toEqual(['a', 'b'])
  })
})

// The id set has to be pruned or it grows without bound in localStorage. The
// prune input is the LIVE note list, which the viewer keeps trimmed to the 7-day
// window — so an aged-out note drops out of the set on its own.
describe('markSeenIds', () => {
  const live = [note('a', DAY), note('b', 2 * DAY), note('c', 3 * DAY)]

  it('remembers every note that was actually on screen', () => {
    expect(markSeenIds([], [note('a', DAY)], live).sort()).toEqual(['a'])
  })

  it('unions across renders, so paging through "Show 5 more" accumulates', () => {
    const first = markSeenIds([], [note('a', DAY)], live)
    expect(markSeenIds(first, [note('b', 2 * DAY)], live).sort()).toEqual(['a', 'b'])
  })

  it('prunes ids that are no longer live notes, so the set stays bounded by the 7-day window', () => {
    expect(markSeenIds(['gone', 'a'], [], live).sort()).toEqual(['a'])
  })

  it('accepts a Set or an array for the previous ids, and never returns duplicates', () => {
    expect(markSeenIds(new Set(['a']), [note('a', DAY)], live)).toEqual(['a'])
  })

  it('is empty when nothing is live at all', () => {
    expect(markSeenIds(['a', 'b'], [note('a', DAY)], [])).toEqual([])
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
  it('honours the per-id seen set for the new-notes chip', () => {
    expect(ambientChips(items, boards, NOW, null).map((c) => c.key)).toContain('notes')
    expect(ambientChips(items, boards, NOW, null, ['n1']).map((c) => c.key)).not.toContain('notes')
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
