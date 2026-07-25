import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  secondaryLine, streamCounts, agentCounts, rowModel, urgencyChip, relMs,
  FRESH_MS, AGING_MS, freshnessTone, ageChip, needsYouEntries, staleFoldLabel,
  SECONDARY_BUDGET, rowStarOption, stagedLabel, undoRefusal, awaitingPickupEntries,
} from '../public/rowview.js'
import type { RowItem, Entry } from '../public/rowview.js'
import { attentionCount } from '../public/attention.js'
import type { AttentionBoard } from '../public/attention.js'

const T0 = Date.parse('2026-07-24T12:00:00.000Z')
const base: RowItem = {
  id: 'i1', project: 'api', stream: '', agent: 'claude', kind: 'question',
  title: 'Ship it?', detail: '', status: 'open', options: null, session: null,
  reply: null, reply_seen_at: null, created_at: new Date(T0).toISOString(),
}
const item = (over: Partial<RowItem> = {}): RowItem => ({ ...base, ...over })

describe('secondaryLine', () => {
  it('prefers the item detail', () => {
    expect(secondaryLine(item({ detail: 'one glanceable line' }))).toBe('one glanceable line')
  })
  it('falls back to the single recommended option detail', () => {
    const it2 = item({ options: [{ label: 'A', detail: 'cheap', recommended: true }, { label: 'B', detail: 'slow' }] })
    expect(secondaryLine(it2)).toBe('cheap')
  })
  it('is empty when there is no detail and no single recommendation', () => {
    expect(secondaryLine(item({ options: [{ label: 'A', recommended: true }, { label: 'B', recommended: true }] }))).toBe('')
    expect(secondaryLine(item())).toBe('')
  })
})

describe('streamCounts', () => {
  it('counts distinct streams per project', () => {
    const m = streamCounts([
      { project: 'api', stream: 'auth' },
      { project: 'api', stream: 'billing' },
      { project: 'web', stream: 'ui' },
      { project: 'web', stream: 'ui' },
    ])
    expect(m.get('api')).toBe(2)
    expect(m.get('web')).toBe(1)
  })
})

describe('agentCounts', () => {
  it('counts distinct agents per project', () => {
    const m = agentCounts([
      { project: 'api', agent: 'claude' },
      { project: 'api', agent: 'codex' },
      { project: 'api', agent: 'claude' },
      { project: 'web', agent: 'claude' },
    ])
    expect(m.get('api')).toBe(2)
    expect(m.get('web')).toBe(1)
  })
})

describe('rowModel', () => {
  const entry = (over: Partial<RowItem> = {}): Entry => ({ kind: 'item', item: item(over), liveness: 'waiting' })

  it('maps an item entry to title + secondary + liveness', () => {
    const m = rowModel(entry({ detail: 'about to drop the column' }))
    expect(m).toMatchObject({
      kind: 'item', id: 'i1', project: 'api', title: 'Ship it?',
      secondary: 'about to drop the column', liveness: 'waiting', boardId: null, answered: false,
    })
  })
  it('hides stream when the project has only one, shows it when it has more', () => {
    const e = entry({ stream: 'auth' })
    expect(rowModel(e, { streams: new Map([['api', 1]]) }).stream).toBe('')
    expect(rowModel(e, { streams: new Map([['api', 2]]) }).stream).toBe('auth')
  })
  // §15: multi-agent attribution survives the flattening as a row-level chip
  it('hides the agent chip for a single-agent project and shows it for a multi-agent one', () => {
    const e = entry({ agent: 'codex' })
    expect(rowModel(e, { agents: new Map([['api', 1]]) }).agent).toBe('')
    expect(rowModel(e, { agents: new Map([['api', 2]]) }).agent).toBe('codex')
  })
  it('carries the agent chip on a blocked board row too', () => {
    const m = rowModel({
      kind: 'row',
      row: { id: 'r1', label: 'Deploy staging', note: 'needs a prod token', status: 'blocked' },
      board: { id: 'b1', project: 'web', stream: '', agent: 'codex', title: 'Rollout' },
    }, { agents: new Map([['web', 3]]) })
    expect(m.agent).toBe('codex')
  })
  // §2: color is never the only carrier — the All view labels the dot
  it('carries a project monogram only while no project filter is active', () => {
    expect(rowModel(entry(), { showProject: true }).projectLabel).toBe('AP')
    expect(rowModel(entry(), { showProject: false }).projectLabel).toBe('')
    expect(rowModel(entry()).projectLabel).toBe('AP')
  })
  it('maps a blocked board row to a row model carrying the board link', () => {
    const m = rowModel({
      kind: 'row',
      row: { id: 'r1', label: 'Deploy staging', note: 'needs a prod token', status: 'blocked' },
      board: { id: 'b1', project: 'web', stream: '', title: 'Rollout' },
    })
    expect(m).toMatchObject({
      kind: 'row', id: 'r1', project: 'web', title: 'Deploy staging',
      secondary: 'needs a prod token', boardId: 'b1', boardTitle: 'Rollout', liveness: 'blocked',
    })
  })
  it('marks a replied item answered', () => {
    expect(rowModel({ kind: 'item', item: item({ reply: 'go' }), liveness: 'parked' }).answered).toBe(true)
  })
})

describe('urgencyChip', () => {
  const model = (over: Record<string, unknown> = {}) =>
    ({ ...rowModel({ kind: 'item', item: item(), liveness: 'waiting' }), ...over })

  it('is warm for a young waiting item and hot past the escalation age', () => {
    expect(urgencyChip(model(), T0 + 10 * 60_000)).toEqual({ text: 'waiting 10m', tone: 'warm' })
    expect(urgencyChip(model(), T0 + 90 * 60_000)).toEqual({ text: 'waiting 1h', tone: 'hot' })
  })
  it('is neutral for parked and muted for stale', () => {
    expect(urgencyChip(model({ liveness: 'parked' }), T0 + 3 * 3600_000).tone).toBe('neutral')
    expect(urgencyChip(model({ liveness: 'stale' }), T0 + 100 * 3600_000).tone).toBe('muted')
  })
  it('is blocked for a board row and muted once answered', () => {
    expect(urgencyChip(model({ kind: 'row' }), T0)).toEqual({ text: 'blocked', tone: 'blocked' })
    expect(urgencyChip(model({ answered: true }), T0).tone).toBe('muted')
  })
})

describe('relMs', () => {
  it('renders compact ages', () => {
    expect(relMs(30_000)).toBe('moments')
    expect(relMs(5 * 60_000)).toBe('5m')
    expect(relMs(3 * 3600_000)).toBe('3h')
    expect(relMs(50 * 3600_000)).toBe('2d')
  })
})

// §6: ONE freshness/age system — the row chip and the Live dot must never
// disagree about what "3h" or "aging" means.
describe('freshnessTone / ageChip', () => {
  it('classifies on the shared thresholds', () => {
    expect(freshnessTone(FRESH_MS - 1)).toBe('fresh')
    expect(freshnessTone(FRESH_MS)).toBe('aging')
    expect(freshnessTone(AGING_MS - 1)).toBe('aging')
    expect(freshnessTone(AGING_MS)).toBe('quiet')
  })
  it('gives a row chip and a Live entry the same text for the same age', () => {
    const ageMs = 3 * 3600_000
    const live = ageChip(ageMs)
    expect(live).toEqual({ tone: 'quiet', text: relMs(ageMs) })
    const row = urgencyChip(rowModel({ kind: 'item', item: item(), liveness: 'waiting' }), T0 + ageMs)
    expect(row.text).toBe(`waiting ${live.text}`)
  })
})

// §7: what you SEE obeys the rail + search; what the badge COUNTS never does.
describe('needsYouEntries', () => {
  const items = [item({ id: 'q-api', project: 'api' })]
  const boards: AttentionBoard[] = [
    { id: 'b-web', project: 'web', title: 'Rollout', rows: [{ id: 'r-web', label: 'Deploy', status: 'blocked' }] },
    { id: 'b-api', project: 'api', title: 'Migration', rows: [{ id: 'r-api', label: 'Backfill', status: 'blocked' }] },
  ]
  it('drops another project rows from the rendered list but not from the count', () => {
    const scoped = boards.filter((b) => b.project === 'api')
    const rendered = needsYouEntries(items, scoped, T0, new Set<string>())
    expect(rendered.map((e) => (e.kind === 'row' ? e.row.id : e.item.id))).toEqual(['r-api', 'q-api'])
    expect(attentionCount(items, boards, T0, new Set<string>())).toBe(3)
  })
  it('folds extra entries through the same ordering', () => {
    const extra = [{ kind: 'item' as const, item: item({ id: 'ans', reply: 'go' }), liveness: 'parked' as const }]
    const out = needsYouEntries(items, [], T0, new Set<string>(), extra)
    expect(out.map((e) => (e.kind === 'item' ? e.item.id : ''))).toEqual(['q-api', 'ans'])
  })
})

describe('staleFoldLabel', () => {
  it('names the collapsed decide-later fold', () => {
    expect(staleFoldLabel(3)).toBe('stale — decide later (3)')
    expect(staleFoldLabel(1)).toBe('stale — decide later (1)')
  })
})

// spec §10: the row-staging pin (Task 9's orderedIds) only protects the list if
// renderNeedsYou actually runs its entries through it BEFORE paginating. This is
// wiring inside app.js, which — like the rest of the shell — has no DOM test
// harness in this repo (see test/shell.test.ts), so the check is source-level:
// the same pattern already used to pin renderNeedsYou/jumpToCard/openTriage wiring.
describe('renderNeedsYou reorders through the poll-suspension pin before paginating (spec §10)', () => {
  const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  const start = js.indexOf('function renderNeedsYou')
  const fn = js.slice(start, js.indexOf('function staleFoldEl', start))

  it('runs the entries through orderedIds', () => {
    expect(start, 'renderNeedsYou is missing').toBeGreaterThan(-1)
    expect(fn).toContain('orderedIds(')
  })

  it('reorders BEFORE paginating — reordering after slicing cannot stop a new row landing under the pointer', () => {
    expect(fn.indexOf('orderedIds(')).toBeLessThan(fn.indexOf('paginate('))
  })
})

// fix round 1: the stale fold's open/closed state must survive the 3s poll
// rebuild, the same way openLive/openContexts already do — otherwise the
// <details> silently snaps shut under the user mid-read. No jsdom in this
// repo, so this is a source-level pin: it fails if the persisted flag is
// declared inside staleFoldEl (re-initialized every render, so it can never
// remember anything) instead of at module scope, or if the toggle listener
// stops writing the state back.
describe('staleFoldEl persists open state across re-renders (fix round 1)', () => {
  const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  const start = js.indexOf('function staleFoldEl')
  const end = js.indexOf('function needsRowEl', start)
  const fn = js.slice(start, end)
  const before = js.slice(0, start)

  it('exists', () => {
    expect(start, 'staleFoldEl is missing').toBeGreaterThan(-1)
  })

  it('declares the persisted flag at module scope, not inside the function', () => {
    // must be readable/writable OUTSIDE staleFoldEl, or a re-render just
    // resets it to closed every time — defeating the whole fix
    expect(before).toMatch(/\bstaleFoldOpen\b/)
    expect(fn).not.toMatch(/\b(let|const|var)\s+staleFoldOpen\b/)
  })

  it('opens the <details> from the persisted flag rather than always defaulting closed', () => {
    expect(fn).toMatch(/fold\.open\s*=\s*true/)
  })

  it('writes the current open state back on toggle, so the next render remembers it', () => {
    expect(fn).toMatch(/addEventListener\(\s*['"]toggle['"]/)
    expect(fn).toMatch(/staleFoldOpen\s*=\s*fold\.open/)
  })
})

describe('rowStarOption', () => {
  const withOpts = (opts: RowItem['options'], detail = 'short') => {
    const it2 = item({ options: opts, detail })
    return { it2, m: rowModel({ kind: 'item', item: it2, liveness: 'waiting' }) }
  }
  it('returns the single recommended option', () => {
    const { it2, m } = withOpts([{ label: 'Roll forward', recommended: true }, { label: 'Revert' }])
    expect(rowStarOption(m, it2)?.label).toBe('Roll forward')
  })
  it('is null when the agent marked two recommendations', () => {
    const { it2, m } = withOpts([{ label: 'A', recommended: true }, { label: 'B', recommended: true }])
    expect(rowStarOption(m, it2)).toBeNull()
  })
  it('is null when line 2 blows the one-line budget', () => {
    const { it2, m } = withOpts([{ label: 'A', recommended: true }], 'x'.repeat(SECONDARY_BUDGET + 1))
    expect(rowStarOption(m, it2)).toBeNull()
  })
  it('is null for a blocked board row and for an answered item', () => {
    const rowM = rowModel({
      kind: 'row', row: { id: 'r1', label: 'Deploy' }, board: { id: 'b1', project: 'web', title: 'Rollout' },
    })
    expect(rowStarOption(rowM, item())).toBeNull()
    const answered = item({ reply: 'go', options: [{ label: 'A', recommended: true }] })
    expect(rowStarOption(rowModel({ kind: 'item', item: answered, liveness: 'parked' }), answered)).toBeNull()
  })
})

describe('stagedLabel', () => {
  it('names what was accepted', () => {
    expect(stagedLabel({ label: 'Roll forward' })).toBe('Sent: Roll forward')
  })
})

describe('undoRefusal', () => {
  it('is null while the reply is still un-picked-up', () => {
    expect(undoRefusal(item({ reply: 'go' }), T0)).toBeNull()
  })
  it('explains the lost race once the agent picked it up', () => {
    const picked = item({ reply: 'go', reply_seen_at: new Date(T0).toISOString() })
    expect(undoRefusal(picked, T0 + 2 * 60_000))
      .toBe('Picked up 2m ago — answering again will not un-do it')
  })
})

describe('awaitingPickupEntries', () => {
  it('keeps only replied questions the agent has not picked up', () => {
    const items = [
      item({ id: 'a', reply: 'go' }),
      item({ id: 'b', reply: 'go', reply_seen_at: new Date(T0).toISOString() }),
      item({ id: 'c' }),
      item({ id: 'd', kind: 'note', reply: 'go' }),
    ]
    const entries = awaitingPickupEntries(items, T0, new Set<string>())
    expect(entries.map((e) => (e.kind === 'item' ? e.item.id : ''))).toEqual(['a'])
  })
})

// fix round 1: a stale row (no re-render between staging and the click, which is
// routine — renderIfIdle suspends whenever a card is open or any draft has text) must
// never let the star Undo fallback silently revert a reply the agent already picked
// up. undoRefusal itself already tells the two snapshots apart correctly (below); this
// pins that needsRowEl's Undo handler actually FEEDS it the fresh lookup, not the
// row's closed-over `entry.item`. No jsdom — same readFileSync/source-pin style as the
// other app.js wiring pins in this file.
describe('undoRefusal distinguishes a stale snapshot from the fresh one (fix round 1)', () => {
  it('a stale (pre-pickup) snapshot says undo is fine, even once the real item has been picked up', () => {
    const stale = item({ reply: 'go' }) // as read before the agent's pickup landed
    const fresh = item({ reply: 'go', reply_seen_at: new Date(T0).toISOString() }) // current truth
    expect(undoRefusal(stale, T0)).toBeNull() // a stale check would wrongly allow it
    expect(undoRefusal(fresh, T0)).not.toBeNull() // the fresh check correctly refuses
  })
})

describe('the star Undo fallback in app.js is wired to fresh state, not the stale render-time snapshot (fix round 1)', () => {
  const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  const start = js.indexOf('function needsRowEl')
  const end = js.indexOf('function rowCardBodyEl', start)
  const fn = js.slice(start, end)
  const before = js.slice(0, start)

  it('needsRowEl is where this is expected to live', () => {
    expect(start, 'needsRowEl is missing').toBeGreaterThan(-1)
  })

  it('looks the item up fresh (freshItem) before deciding, rather than trusting the closure', () => {
    expect(before, 'freshItem is missing').toMatch(/function\s+freshItem\s*\(/)
    expect(fn).toMatch(/const\s+fresh\s*=\s*freshItem\(m\.id\)/)
  })

  it('feeds the fresh lookup — not entry.item — into undoRefusal and changeAnswer', () => {
    expect(fn).toMatch(/undoRefusal\(\s*fresh\s*,/)
    // fix round 1 (hardening): changeAnswer also takes the existing `label` element,
    // so it can surface a server-side refusal it wouldn't otherwise catch — see
    // test/hardening.test.ts for that behavior
    expect(fn).toMatch(/changeAnswer\(\s*fresh\s*,\s*label\s*\)/)
    expect(fn).not.toMatch(/undoRefusal\(\s*entry\.item\s*,/)
    expect(fn).not.toMatch(/changeAnswer\(\s*entry\.item\s*\)/)
  })
})
