import { describe, expect, it } from 'vitest'
import { buildRibbon, sinceKeepsOn, sinceLastLooked, trustedInput } from '../public/ribbon.js'

// #305: the Today ribbon and "Since you last looked", pure.
const HOUR = 3_600_000
const END = Date.parse('2026-08-24T20:00:00.000Z')
const START = END - 24 * HOUR
const iso = (ms: number) => new Date(ms).toISOString()
const span = (project: string, from: number, to: number | null, extra: Record<string, unknown> = {}) => ({
  session: `${project}-${from}`, project, agent: 'copilot', started_at: iso(from),
  ended_at: to == null ? null : iso(to), effective_ended_at: to == null ? null : iso(to), ...extra,
})
const mark = (project: string, at: number, key = `${project}-${at}`, extra: Record<string, unknown> = {}) =>
  ({ key, project, at, title: key, ...extra })

describe('buildRibbon', () => {
  it('clips spans to the range, drops those outside it, and totals only what is inside', () => {
    const ribbon = buildRibbon({
      spans: [
        span('alpha', START - 2 * HOUR, START + HOUR),
        span('alpha', START + 12 * HOUR, START + 18 * HOUR),
        span('beta', START - 5 * HOUR, START - HOUR),
      ],
      startMs: START,
      endMs: END,
    })
    expect(ribbon.totalMs).toBe(7 * HOUR)
    expect(ribbon.lanes.map((lane) => lane.project)).toEqual(['alpha'])
    expect(ribbon.lanes[0]!.bars.map(({ left, width, liveFrom }) => [left, width, liveFrom])).toEqual([[0, 4.2, null], [50, 25, null]])
    expect(ribbon.lanes[0]!.bars[0]!.from).toBe(iso(START))
  })

  it('draws work happening now as a live tail reaching the end of the range', () => {
    const ribbon = buildRibbon({
      spans: [span('alpha', END - 6 * HOUR, END - 3 * HOUR), span('alpha', END - 3 * HOUR, null)],
      startMs: START,
      endMs: END,
    })
    const [bar] = ribbon.lanes[0]!.bars
    // Touching spans merge into one bar whose striped tail starts where the live one does.
    expect(ribbon.lanes[0]!.bars).toHaveLength(1)
    expect([bar!.left, bar!.width, bar!.liveFrom]).toEqual([75, 25, 50])
    expect(bar!.to).toBe(iso(END))
    expect(ribbon.lanes[0]!.live).toBe(true)
    expect(ribbon.totalMs).toBe(6 * HOUR)
    // A span the server capped (effective end, no ended_at) is not live.
    const capped = buildRibbon({
      spans: [{ ...span('alpha', END - 2 * HOUR, null), effective_ended_at: iso(END - HOUR) }],
      startMs: START,
      endMs: END,
    })
    expect(capped.lanes[0]!.bars[0]!.liveFrom).toBeNull()
    expect(capped.lanes[0]!.live).toBe(false)
  })

  it('places ◆ and ● markers in their project lane, only inside the range', () => {
    const ribbon = buildRibbon({
      spans: [],
      asks: [mark('alpha', END - 6 * HOUR, 'a1', { open: true }), mark('alpha', START - HOUR, 'old'), mark('gamma', END - HOUR, 'g1')],
      outcomes: [mark('alpha', END - 12 * HOUR, 'o1')],
      startMs: START,
      endMs: END,
    })
    expect(ribbon.lanes.map((lane) => lane.project)).toEqual(['alpha', 'gamma'])
    expect(ribbon.lanes[0]!.marks.map(({ kind, key, left, open }) => [kind, key, left, open]))
      .toEqual([['ask', 'a1', 75, true], ['outcome', 'o1', 50, false]])
    expect(ribbon.lanes[0]).toMatchObject({ asks: 1, openAsks: 1, outcomes: 1, workMs: 0 })
  })

  it('draws no marker before the point the page proves complete (#184, #299)', () => {
    const ribbon = buildRibbon({
      spans: [span('alpha', START, START + HOUR)],
      asks: [mark('alpha', START + 2 * HOUR, 'early'), mark('alpha', END - HOUR, 'late')],
      startMs: START,
      endMs: END,
      marksAfter: iso(START + 6 * HOUR),
    })
    expect(ribbon.marksFrom).toBe(25)
    expect(ribbon.lanes[0]!.marks.map((m) => m.key)).toEqual(['late'])
    // Spans are complete for the whole range; only markers are cut.
    expect(ribbon.lanes[0]!.bars).toHaveLength(1)
    expect(buildRibbon({ spans: [], startMs: START, endMs: END, marksAfter: iso(START - HOUR) }).marksFrom).toBeNull()
  })

  it('keeps the twelve most recently active projects, drawn by name, within the bar budget', () => {
    const spans = Array.from({ length: 20 }, (_, p) =>
      Array.from({ length: 40 }, (_, i) => span(`p${String(p).padStart(2, '0')}`, START + i * 30 * 60_000 + p * 1000, START + i * 30 * 60_000 + p * 1000 + 60_000))).flat()
    const ribbon = buildRibbon({ spans, startMs: START, endMs: END })
    expect(ribbon.lanes.map((lane) => lane.project)).toEqual(Array.from({ length: 12 }, (_, i) => `p${String(i + 8).padStart(2, '0')}`))
    expect(ribbon.more).toBe(8)
    expect(ribbon.lanes.reduce((total, lane) => total + lane.bars.length, 0)).toBeLessThanOrEqual(200)
    // Merging never loses time: every lane's bars still span its first to last span.
    const first = ribbon.lanes[0]!.bars
    expect(first[0]!.left).toBeLessThan(1)
    expect(first.at(-1)!.left + first.at(-1)!.width).toBeGreaterThan(80)
  })

  // #305 review: the marker budget used to drop older markers silently.
  it('raises the marker floor past the budget, drawing every marker after it', () => {
    const START30 = END - 30 * 24 * HOUR
    const asks = Array.from({ length: 300 }, (_, i) => mark(`p${i % 3}`, START30 + (i + 1) * 2 * HOUR, `a${i}`))
    // A tie at the cut instant goes with the cut.
    asks.push(mark('p0', asks[179]!.at, 'tie'))
    const ribbon = buildRibbon({ spans: [], asks, startMs: START30, endMs: END })
    const drawn = ribbon.lanes.flatMap((lane) => lane.marks)
    expect(drawn.length).toBeLessThanOrEqual(120)
    const floor = Date.parse(ribbon.marksFromAt!)
    expect(floor).toBe(asks[179]!.at)
    expect(drawn.map((m) => m.key).sort()).toEqual(asks.filter((m) => m.at > floor).map((m) => m.key).sort())
    expect(ribbon.marksFrom).toBeGreaterThan(0)
    expect(ribbon.lanes.reduce((total, lane) => total + lane.asks, 0)).toBe(drawn.length)
  })

  it('refuses a range that is not finite and ascending', () => {
    expect(() => buildRibbon({ spans: [], startMs: END, endMs: START })).toThrow(RangeError)
  })
})

describe('sinceLastLooked', () => {
  const since = END - 5 * HOUR
  const input = {
    sinceMs: since,
    untilMs: END,
    outcomes: [mark('alpha', END - HOUR), mark('alpha', END - 2 * HOUR), mark('alpha', END - HOUR - 1), mark('alpha', since - 1)],
    asks: [mark('alpha', END - 3 * HOUR), mark('beta', END - 10), mark('beta', since)],
    spans: [
      span('alpha', END - 8 * HOUR, END - 4 * HOUR, { session: 'done' }),
      span('alpha', END - 9 * HOUR, END - 6 * HOUR, { session: 'before' }),
      span('alpha', END - 4 * HOUR, END - 3 * HOUR, { session: 'back' }),
      span('alpha', END - HOUR, null, { session: 'back' }),
    ],
  }

  it('summarises outcomes, new asks and finished sessions between the visits', () => {
    expect(sinceLastLooked(input)).toBe('3 outcomes landed, 2 new asks, 1 session finished')
  })

  it('says nothing without a gap, a previous visit or anything to report', () => {
    expect(sinceLastLooked({ ...input, sinceMs: END - 10 * 60_000 })).toBeNull()
    expect(sinceLastLooked({ ...input, sinceMs: Number.NaN })).toBeNull()
    expect(sinceLastLooked({ sinceMs: since, untilMs: END, spans: [] })).toBeNull()
  })

  it('reads "N+" where omitted history could hold more, and drops sessions without history', () => {
    expect(sinceLastLooked({ ...input, outcomesAfter: iso(END - 4 * HOUR), asksAfter: iso(since - HOUR), spans: null }))
      .toBe('3+ outcomes landed, 2 new asks')
    expect(sinceLastLooked({ sinceMs: since, untilMs: END, asksAfter: iso(END - HOUR) })).toBeNull()
  })
})

describe('dismissing "Since you last looked" (#305 review)', () => {
  const inside = {} as Node
  const outside = {} as Node
  const line = { contains: (node: Node | null) => node === inside } as unknown as Node

  it('keeps it while the human reads or copies it', () => {
    expect(sinceKeepsOn({ metaKey: true, target: outside as EventTarget }, line, null)).toBe(true)
    expect(sinceKeepsOn({ ctrlKey: true, target: outside as EventTarget }, line, null)).toBe(true)
    expect(sinceKeepsOn({ target: inside as EventTarget }, line, null)).toBe(true)
    expect(sinceKeepsOn({ target: outside as EventTarget }, line, { anchorNode: inside })).toBe(true)
    expect(sinceKeepsOn({ target: outside as EventTarget }, line, { anchorNode: outside })).toBe(false)
    expect(sinceKeepsOn({ target: outside as EventTarget }, line, null)).toBe(false)
  })

  it('counts only input the browser produced', () => {
    expect(trustedInput({ isTrusted: true })).toBe(true)
    expect(trustedInput({ isTrusted: false })).toBe(false)
    expect(trustedInput(undefined)).toBe(false)
  })
})

describe('a bar that just started', () => {
  it('stays inside the track at its minimum width', () => {
    const ribbon = buildRibbon({ spans: [span('alpha', END - 1000, null)], startMs: START, endMs: END })
    const [bar] = ribbon.lanes[0]!.bars
    expect(bar!.width).toBe(0.2)
    expect(bar!.left + bar!.width).toBeLessThanOrEqual(100)
  })
})
