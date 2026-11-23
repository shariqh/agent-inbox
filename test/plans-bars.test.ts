// UX pass, slice 3: Plans as bars. The pure parts: a plan's step states and
// the bar's segments (public/lanes.js), the sections and a plan's form
// (public/boards.js).
import { describe, expect, it } from 'vitest'
import { planBarLabel, planSegments, planStepStates } from '../public/lanes.js'
import { STALL_MS, planForm, planSections } from '../public/boards.js'
import { pinOrder } from '../public/poll.js'

const NOW = Date.parse('2026-11-20T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const SEEN = ago(DAY * 9)

type Row = Record<string, any>
const row = (status: string, extra: Row = {}): Row => ({ id: `r-${Math.random()}`, label: 'Step', status, annotation: null, ...extra })
const plan = (id: string, rows: Row[], extra: Row = {}) => ({
  id, title: `Plan ${id}`, project: 'alpha', status: 'active', updated_at: ago(DAY), session: null, rows, ...extra,
})
const old = (id: string, rows: Row[], extra: Row = {}) => plan(id, rows, { updated_at: ago(DAY * 8), ...extra })
const ask = (extra: Row = {}) => row('blocked', extra)
const sectionOf = (sections: Record<string, Array<{ id: string }>>, id: string) =>
  Object.entries(sections).find(([, plans]) => plans.some((p) => p.id === id))?.[0]

describe('planStepStates', () => {
  it('keeps step order, leaves na out, and names each state in the one vocabulary', () => {
    const { states, counts } = planStepStates(plan('p', [
      row('done'), row('na'), row('partial'), ask(), row('tracked'), row('missing'),
    ]), NOW)
    expect(states).toEqual(['done', 'progress', 'needs', 'todo', 'todo'])
    expect(counts).toEqual({ done: 1, progress: 1, needs: 1, todo: 2 })
  })

  it('counts a blocked step that is answered, snoozed or pinned as to do', () => {
    const { states } = planStepStates(plan('p', [
      ask({ annotation: 'yes' }),
      ask({ handled_at: ago(1000) }),
      ask({ snoozed_until: new Date(NOW + DAY).toISOString() }),
      ask({ pinned_at: ago(1000) }),
      ask(),
    ]), NOW)
    expect(states).toEqual(['todo', 'todo', 'todo', 'todo', 'needs'])
  })

  it('an archived plan has nothing that needs you, and its label says so', () => {
    const { states, counts } = planStepStates(plan('p', [row('done'), ask()], { status: 'archived' }), NOW)
    expect(states).toEqual(['done', 'todo'])
    expect(planBarLabel(counts)).toBe('1 of 2 steps done')
    expect(planBarLabel(counts)).not.toMatch(/needs you/)
  })
})

describe('planSegments', () => {
  const states = (n: number) => Array.from({ length: n }, (_, i) => (i < 3 ? 'done' : i === 3 ? 'needs' : i < 6 ? 'progress' : 'todo') as const)

  it('draws one segment per step up to the place limit, in step order', () => {
    const at24 = planSegments([...states(24)], 24)
    expect(at24.runs).toBe(false)
    expect(at24.segments).toHaveLength(24)
    expect(at24.segments.map((s) => s.state)).toEqual(states(24))
    expect(at24.segments.every((s) => s.grow === 1)).toBe(true)
  })

  it('one step past the limit draws runs of equal states, still in order, each growing by its length', () => {
    const at25 = planSegments([...states(25)], 24)
    expect(at25.runs).toBe(true)
    expect(at25.segments).toEqual([
      { state: 'done', grow: 3 }, { state: 'needs', grow: 1 }, { state: 'progress', grow: 2 }, { state: 'todo', grow: 19 },
    ])
    expect(at25.segments.reduce((n, s) => n + s.grow, 0)).toBe(25)
    // a run boundary never merges states out of order: done, todo, done stays three runs
    expect(planSegments(['done', 'todo', 'done'], 2).segments.map((s) => s.state)).toEqual(['done', 'todo', 'done'])
  })

  it('a plan with no counted steps has no segment', () => {
    expect(planSegments([], 24)).toEqual({ runs: false, segments: [] })
  })
})

describe('planBarLabel', () => {
  it('says done of counted, then needs you and in progress, leaving zero parts out', () => {
    expect(planBarLabel({ done: 3, progress: 1, needs: 1, todo: 2 })).toBe('3 of 7 steps done, 1 needs you, 1 in progress')
    expect(planBarLabel({ done: 3, progress: 0, needs: 2, todo: 2 })).toBe('3 of 7 steps done, 2 need you')
    expect(planBarLabel({ done: 0, progress: 0, needs: 0, todo: 4 })).toBe('0 of 4 steps done')
    expect(planBarLabel({ done: 0, progress: 0, needs: 0, todo: 0 })).toBe('No steps to count')
  })
})

describe('planSections', () => {
  const opts = { nowMs: NOW, liveSessions: new Set<string>(), workingPlanIds: new Set<string>(), held: new Map() }
  const place = (p: ReturnType<typeof plan>, extra: Partial<typeof opts> = {}) => sectionOf(planSections([p], { ...opts, ...extra }), p.id)

  it('a step waiting on the person puts a plan in Needs you, however old', () => {
    expect(place(old('a', [ask()]))).toBe('needs')
    expect(place(plan('a', [row('tracked'), ask()]))).toBe('needs')
  })

  it('an answered and delivered blocked step does not keep an old plan out of Stalled', () => {
    expect(place(old('a', [ask({ annotation: 'go', annotation_seen_at: SEEN })]))).toBe('stalled')
    expect(place(old('a', [ask({ handled_at: SEEN, handled_seen_at: SEEN })]))).toBe('stalled')
  })

  it('an answer an agent has not picked up keeps an old plan Moving', () => {
    expect(place(old('a', [ask({ annotation: 'go', annotation_seen_at: null })]))).toBe('moving')
    expect(place(old('a', [ask({ handled_at: SEEN, handled_seen_at: null })]))).toBe('moving')
  })

  it('a step set aside (snoozed or pinned) keeps an old plan Moving', () => {
    expect(place(old('a', [ask({ snoozed_until: new Date(NOW + DAY).toISOString() })]))).toBe('moving')
    expect(place(old('a', [ask({ pinned_at: ago(DAY * 8) })]))).toBe('moving')
  })

  it('a note not yet picked up on a step that is not blocked keeps an old plan Moving', () => {
    expect(place(old('a', [row('tracked', { annotation: 'remember X', annotation_seen_at: null })]))).toBe('moving')
    expect(place(old('a', [row('tracked', { annotation: 'remember X', annotation_seen_at: SEEN })]))).toBe('stalled')
  })

  it('a live session or a working card showing the plan keeps it Moving', () => {
    expect(place(old('a', [row('tracked')], { session: 's1' }), { liveSessions: new Set(['s1']) })).toBe('moving')
    expect(place(old('a', [row('tracked')], { session: 's1' }))).toBe('stalled')
    expect(place(old('a', [row('tracked')]), { workingPlanIds: new Set(['a']) })).toBe('moving')
  })

  it('tracked-only plans are Moving within the week and Stalled after it', () => {
    expect(place(plan('a', [row('tracked'), row('missing')]))).toBe('moving')
    expect(place(old('a', [row('tracked'), row('missing')]))).toBe('stalled')
    // exactly a week is not "more than 7 days"
    expect(place(plan('a', [row('tracked')], { updated_at: ago(STALL_MS) }))).toBe('moving')
    expect(place(plan('a', [row('tracked')], { updated_at: ago(STALL_MS + 1) }))).toBe('stalled')
  })

  it('empty, all-na and un-archived complete plans follow the same rule at 6 and at 8 days', () => {
    for (const rows of [[], [row('na'), row('na')], [row('done'), row('done')]]) {
      expect(place(plan('a', rows, { updated_at: ago(DAY * 6) }))).toBe('moving')
      expect(place(plan('a', rows, { updated_at: ago(DAY * 8) }))).toBe('stalled')
    }
  })

  it('a held plan stays in its section until it gains a new ask', () => {
    const answered = old('a', [ask({ annotation: 'go', annotation_seen_at: SEEN })])
    expect(place(answered, { held: new Map([['a', 'needs']]) })).toBe('needs')
    expect(place(plan('a', [row('tracked')]), { held: new Map([['a', 'stalled']]) })).toBe('stalled')
    // a new ask always moves it to Needs you
    expect(place(plan('a', [ask()]), { held: new Map([['a', 'moving']]) })).toBe('needs')
  })

  it('keeps the input order in each section, which the order pin then holds for the visit', () => {
    const plans = [plan('n1', [ask()]), plan('m1', [row('tracked')]), old('s1', []), plan('m2', [row('partial')]), plan('n2', [ask()])]
    const sections = planSections(plans, opts)
    expect(sections.needs.map((p) => p.id)).toEqual(['n1', 'n2'])
    expect(sections.moving.map((p) => p.id)).toEqual(['m1', 'm2'])
    expect(sections.stalled.map((p) => p.id)).toEqual(['s1'])
    // the next frame's server order puts m2 first and adds m3 on top; the pin keeps the drawn order, new ids at the foot
    const pinned = pinOrder(['m1', 'm2'], ['m3', 'm2', 'm1'])
    expect(pinned).toEqual(['m1', 'm2', 'm3'])
  })
})

describe('planForm', () => {
  it('the person’s choice wins; with none, Needs you or a kept step is brief and the rest closed', () => {
    for (const section of ['needs', 'moving', 'stalled', null] as const) {
      for (const kept of [true, false]) {
        expect(planForm({ choice: true, section, kept })).toBe('full')
        expect(planForm({ choice: false, section, kept })).toBe('closed')
        expect(planForm({ choice: undefined, section, kept })).toBe(section === 'needs' || kept ? 'brief' : 'closed')
      }
    }
  })
})
