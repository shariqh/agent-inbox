import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  secondaryLine, streamCounts, agentCounts, rowModel, urgencyChip, relMs,
  FRESH_MS, AGING_MS, freshnessTone, ageChip, needsYouEntries, staleFoldLabel,
  SECONDARY_BUDGET, rowStarOption, stagedLabel, undoRefusal, handledUndoRefusal, repliedEntries,
  ASK_SORT_OPTIONS, currentAskAt, askTimeModel, sortNeedsYouByAsk,
} from '../public/rowview.js'
import type { RowItem, Entry } from '../public/rowview.js'
import { attentionCount } from '../public/attention.js'
import type { AttentionBoard, AttentionEntry } from '../public/attention.js'

const T0 = Date.parse('2026-07-24T12:00:00.000Z')
const base: RowItem = {
  id: 'i1', project: 'api', stream: '', agent: 'claude', kind: 'question',
  title: 'Ship it?', detail: '', status: 'open', options: null, session: null,
  reply: null, reply_seen_at: null, created_at: new Date(T0).toISOString(),
}
const item = (over: Partial<RowItem> = {}): RowItem => ({ ...base, ...over })

describe('secondaryLine', () => {
  it('uses the explanation below the action-first headline without repeating the request', () => {
    expect(secondaryLine(item({ detail: 'reviews are green', next_step: 'Merge PR #42.' })))
      .toBe('reviews are green')
    expect(rowModel({
      kind: 'item',
      item: item({ title: 'PR-42 gate', detail: 'reviews are green', next_step: 'Merge PR #42.' }),
      liveness: 'waiting',
    })).toMatchObject({ title: 'Merge PR #42.', originalTitle: 'PR-42 gate', secondary: 'reviews are green' })
  })
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
      row: {
        id: 'r1', label: 'Deploy staging', note: 'needs a prod token',
        next_step: 'Create the production token.', status: 'blocked',
      },
      board: { id: 'b1', project: 'web', stream: '', title: 'Rollout' },
    })
    expect(m).toMatchObject({
      kind: 'row', id: 'r1', project: 'web', title: 'Create the production token.',
      originalTitle: 'Deploy staging', secondary: 'needs a prod token',
      boardId: 'b1', boardTitle: 'Rollout', liveness: 'blocked',
    })
  })
  it('marks a replied item answered', () => {
    expect(rowModel({ kind: 'item', item: item({ reply: 'go' }), liveness: 'parked' }).answered).toBe(true)
  })

  // #37 — a board row gets the SAME two facts an item has: the human answered
  // (annotation), and an agent collected it (annotation_seen_at). `answered` is
  // what dims the row and drops it to the foot; `pickedUp` is what makes the
  // difference between "you're waiting on the agent" and "it has the answer".
  it('marks an annotated row answered, and reports whether it was delivered', () => {
    const rowEntry = (row: Record<string, unknown>) => ({
      kind: 'row' as const,
      row: { id: 'r1', label: 'Merge', note: 'ready', status: 'blocked', ...row },
      board: { id: 'b1', project: 'web', stream: '', title: 'Rollout' },
    })
    expect(rowModel(rowEntry({})).answered).toBe(false)
    const waiting = rowModel(rowEntry({ annotation: 'merge it' }))
    expect(waiting).toMatchObject({ answered: true, pickedUp: false, pickedUpAt: null, pickedUpBy: '' })
    const done = rowModel(rowEntry({ annotation: 'merge it', annotation_seen_at: '2026-07-24T12:00:00Z', annotation_seen_by: 'claude-code' }))
    expect(done).toMatchObject({ answered: true, pickedUp: true, pickedUpAt: '2026-07-24T12:00:00Z', pickedUpBy: 'claude-code' })
  })

  // #36 — the second shape of "the human is finished with this row". It must dim
  // and sink the row exactly as an annotation does (so `answered`), while still
  // being distinguishable for the card that has to describe it (so `handled`).
  describe('the handled mark (#36)', () => {
    const rowEntry = (row: Record<string, unknown>) => ({
      kind: 'row' as const,
      row: { id: 'r1', label: 'Paddle account', note: '~15 min KYC', status: 'blocked', annotation: null, ...row },
      board: { id: 'b1', project: 'web', stream: '', title: 'Wave 0' },
    })

    it('marks a row with no words but a mark as answered, and says which shape it was', () => {
      const m = rowModel(rowEntry({ handled_at: '2026-07-24T11:00:00Z' }))
      expect(m).toMatchObject({ answered: true, handled: true, handledAt: '2026-07-24T11:00:00Z' })
    })

    it('an unmarked, unannotated row is neither answered nor handled', () => {
      expect(rowModel(rowEntry({}))).toMatchObject({ answered: false, handled: false, handledAt: null })
    })

    it('an annotated row is answered but NOT handled — the two are not synonyms', () => {
      expect(rowModel(rowEntry({ annotation: 'go ahead' }))).toMatchObject({ answered: true, handled: false })
    })

    it('an item is never handled — the mark is a row-only concept', () => {
      expect(rowModel({ kind: 'item', item: item({ reply: 'go' }), liveness: 'parked' }))
        .toMatchObject({ handled: false, handledAt: null, handledPickedUp: false })
    })

    it('a mark nobody has collected reports no pickup', () => {
      expect(rowModel(rowEntry({ handled_at: '2026-07-24T11:00:00Z' })))
        .toMatchObject({ pickedUp: false, pickedUpAt: null, pickedUpBy: '', handledPickedUp: false })
    })

    it('a collected mark reports the pickup, its time and the agent', () => {
      expect(rowModel(rowEntry({ handled_at: '2026-07-24T11:00:00Z', handled_seen_at: '2026-07-24T11:30:00Z', handled_seen_by: 'claude-code' })))
        .toMatchObject({ pickedUp: true, pickedUpAt: '2026-07-24T11:30:00Z', pickedUpBy: 'claude-code', handledPickedUp: true })
    })

    // The half-delivered case is the one that matters: reporting "delivered"
    // while a whole half of what the human left is still queued is exactly the
    // lie #37 exists to prevent.
    it('a delivered annotation plus an uncollected mark still reports NO pickup', () => {
      expect(rowModel(rowEntry({
        annotation: 'and I emailed them',
        annotation_seen_at: '2026-07-24T11:10:00Z',
        annotation_seen_by: 'claude-code',
        handled_at: '2026-07-24T11:20:00Z',
      }))).toMatchObject({ pickedUp: false, pickedUpAt: null })
    })

    it('an uncollected annotation plus a delivered mark also reports NO pickup', () => {
      expect(rowModel(rowEntry({
        annotation: 'and I emailed them',
        handled_at: '2026-07-24T11:20:00Z',
        handled_seen_at: '2026-07-24T11:30:00Z',
        handled_seen_by: 'claude-code',
      }))).toMatchObject({ pickedUp: false, pickedUpAt: null })
    })

    it('with both halves delivered it reports the LATER stamp and that agent', () => {
      expect(rowModel(rowEntry({
        annotation: 'and I emailed them',
        annotation_seen_at: '2026-07-24T11:10:00Z',
        annotation_seen_by: 'codex',
        handled_at: '2026-07-24T11:20:00Z',
        handled_seen_at: '2026-07-24T11:30:00Z',
        handled_seen_by: 'claude-code',
      }))).toMatchObject({ pickedUp: true, pickedUpAt: '2026-07-24T11:30:00Z', pickedUpBy: 'claude-code' })
    })

    // ADDED alongside the test above, which its own fixture cannot bind: there the
    // later stamp is ALSO the mark's, so "always report the mark's stamp" passes it
    // (verified by mutation). This is the same claim with the ordering reversed, so
    // only an implementation that really compares the two stamps satisfies both.
    // It matters because the age shown is the human's evidence for how long an
    // agent has been sitting on their answer — naming the EARLIER pickup would
    // overstate the delay and point at the wrong agent.
    it('…and the LATER stamp is whichever it is — the annotation’s, when the mark was collected first', () => {
      expect(rowModel(rowEntry({
        annotation: 'and I emailed them',
        annotation_seen_at: '2026-07-24T11:30:00Z',
        annotation_seen_by: 'codex',
        handled_at: '2026-07-24T11:00:00Z',
        handled_seen_at: '2026-07-24T11:10:00Z',
        handled_seen_by: 'claude-code',
      }))).toMatchObject({ pickedUp: true, pickedUpAt: '2026-07-24T11:30:00Z', pickedUpBy: 'codex' })
    })
  })
})

describe('urgencyChip', () => {
  const model = (over: Record<string, unknown> = {}) =>
    ({ ...rowModel({ kind: 'item', item: item(), liveness: 'waiting' }), ...over })

  it('is warm for a young waiting item and hot past the escalation age', () => {
    expect(urgencyChip(model(), T0 + 10 * 60_000)).toEqual({ text: 'Waiting 10m', tone: 'warm' })
    expect(urgencyChip(model(), T0 + 90 * 60_000)).toEqual({ text: 'Waiting 1h', tone: 'hot' })
  })
  it('is neutral for parked and muted for stale', () => {
    expect(urgencyChip(model({ liveness: 'parked' }), T0 + 3 * 3600_000).tone).toBe('neutral')
    expect(urgencyChip(model({ liveness: 'stale' }), T0 + 100 * 3600_000).tone).toBe('muted')
  })
  it('is blocked for a board row and muted once answered', () => {
    expect(urgencyChip(model({ kind: 'row' }), T0)).toEqual({ text: 'Needs input', tone: 'blocked' })
    expect(urgencyChip(model({ answered: true }), T0).tone).toBe('muted')
  })

  // #37 — the whole point of keeping an annotated row on screen is that it reads
  // differently depending on whether anyone actually collected the answer. One
  // chip, three states, and the un-delivered one is never silent.
  it('gives an annotated row the two-state pickup vocabulary', () => {
    const row = (over: Record<string, unknown>) => model({ kind: 'row', answered: true, pickedUp: false, pickedUpAt: null, pickedUpBy: '', ...over })
    expect(urgencyChip(row({}), T0)).toEqual({ text: 'Waiting for delivery', tone: 'muted' })
    expect(urgencyChip(row({ pickedUp: true, pickedUpAt: new Date(T0 - 3 * 60_000).toISOString() }), T0))
      .toEqual({ text: 'delivered 3m', tone: 'muted' })
  })
  it('an un-picked-up row is never rendered as blocked — the human already answered', () => {
    const m = model({ kind: 'row', answered: true, pickedUp: false, pickedUpAt: null, pickedUpBy: '' })
    expect(urgencyChip(m, T0).tone).not.toBe('blocked')
  })

  // #36 requirement 3: a marked row relabels into the awaiting-pickup foot
  // "exactly like an annotated row" — so it gets the SAME two-state vocabulary,
  // not a third one nobody has to learn.
  it('gives a row marked handled the same two-state pickup vocabulary as an annotated one', () => {
    const marked = model({ kind: 'row', answered: true, handled: true, pickedUp: false, pickedUpAt: null, pickedUpBy: '' })
    expect(urgencyChip(marked, T0)).toEqual({ text: 'Waiting for delivery', tone: 'muted' })
    const collected = { ...marked, pickedUp: true, pickedUpAt: new Date(T0 - 3 * 60_000).toISOString() }
    expect(urgencyChip(collected, T0)).toEqual({ text: 'delivered 3m', tone: 'muted' })
  })
})

// The mark's own undo-refusal copy, the rows-shaped twin of undoRefusal above.
describe('handledUndoRefusal (#36)', () => {
  it('is silent while the mark is still undelivered — there is nothing to refuse', () => {
    expect(handledUndoRefusal({ id: 'r1', label: 'x', handled_at: '2026-07-24T11:00:00Z' }, T0)).toBeNull()
    expect(handledUndoRefusal({ id: 'r1', label: 'x' }, T0)).toBeNull()
  })
  it('names the delivery age once an agent has been handed the mark', () => {
    const msg = handledUndoRefusal({ id: 'r1', label: 'x', handled_at: '2026-07-24T11:00:00Z', handled_seen_at: new Date(T0 - 4 * 60_000).toISOString() }, T0)
    expect(msg).toContain('4m')
    expect(msg).toBe('Delivered 4m ago — this confirmation can no longer be withdrawn')
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

describe('current ask timestamps and list-only sorting (#64)', () => {
    const board = { id: 'b1', project: 'web', stream: '', agent: 'copilot', title: 'Launch' }
    const rowEntry = (over: Record<string, unknown> = {}): Entry => ({
      kind: 'row',
      row: {
        id: 'r1',
        label: 'Approve launch',
        status: 'blocked',
        created_at: '2026-07-24T08:00:00.000Z',
        ...over,
      },
      board,
    })
    const rowData = (over: Record<string, unknown> = {}) => {
      const entry = rowEntry(over)
      if (entry.kind !== 'row') throw new Error('row fixture produced an item')
      return entry.row
    }

    it('uses item creation, current row action, and the legacy row creation fallback', () => {
      expect(currentAskAt({ kind: 'item', item: item({ created_at: '2026-07-24T09:00:00.000Z' }), liveness: 'parked' }))
        .toBe('2026-07-24T09:00:00.000Z')
      expect(currentAskAt({
        kind: 'item',
        item: { ...item({ created_at: '2026-07-24T09:00:00.000Z' }), action_started_at: '2026-07-24T11:00:00.000Z' },
        liveness: 'parked',
      })).toBe('2026-07-24T09:00:00.000Z')
      expect(currentAskAt(rowEntry({ action_started_at: '2026-07-24T11:00:00.000Z' })))
        .toBe('2026-07-24T11:00:00.000Z')
      expect(currentAskAt(rowEntry())).toBe('2026-07-24T08:00:00.000Z')
    })

    it('builds compact age copy and an exact local timestamp from the same instant', () => {
      const time = askTimeModel('2026-07-24T09:00:00.000Z', T0)
      expect(time).toMatchObject({
        datetime: '2026-07-24T09:00:00.000Z',
        text: 'Asked 3h ago',
      })
      expect(time?.exact).toContain('2026')
      expect(time?.accessibleLabel).toContain(time!.exact)
      expect(askTimeModel('not-a-date', T0)).toBeNull()
    })

    it('keeps current priority byte-for-byte and sorts newest/oldest with deterministic ties', () => {
      const entries: Entry[] = [
        rowEntry({ id: 'row-b', action_started_at: '2026-07-24T10:00:00.000Z' }),
        { kind: 'item', item: item({ id: 'item-z', created_at: '2026-07-24T11:00:00.000Z' }), liveness: 'parked' },
        { kind: 'item', item: item({ id: 'item-a', created_at: '2026-07-24T10:00:00.000Z' }), liveness: 'parked' },
        rowEntry({ id: 'row-a', action_started_at: '2026-07-24T10:00:00.000Z' }),
      ]
      expect(ASK_SORT_OPTIONS.map(({ value }) => value)).toEqual(['priority', 'newest', 'oldest'])
      expect(sortNeedsYouByAsk(entries, 'priority')).toBe(entries)
      expect(sortNeedsYouByAsk(entries, 'newest').map((entry) => entry.kind === 'row' ? entry.row.id : entry.item.id))
        .toEqual(['item-z', 'item-a', 'row-a', 'row-b'])
      expect(sortNeedsYouByAsk(entries, 'oldest').map((entry) => entry.kind === 'row' ? entry.row.id : entry.item.id))
        .toEqual(['item-a', 'row-a', 'row-b', 'item-z'])
      expect(entries[0]!.kind).toBe('row')
    })

    it('sorting never changes attention membership or counts', () => {
      const entries = needsYouEntries(
        [item({ id: 'q1', created_at: '2026-07-24T09:00:00.000Z' }), item({ id: 'q2', created_at: '2026-07-24T10:00:00.000Z' })],
        [{ ...board, rows: [{ ...rowData({ id: 'r1' }), status: 'blocked', annotation: null, annotation_unseen: false }] }],
        T0,
        new Set<string>(),
      )
      const ids = (list: AttentionEntry[]) => new Set(list.map((entry) => entry.kind === 'row' ? entry.row.id : entry.item.id))
      for (const { value } of ASK_SORT_OPTIONS) expect(ids(sortNeedsYouByAsk(entries, value))).toEqual(ids(entries))
      expect(attentionCount(
        [item({ id: 'q1', created_at: '2026-07-24T09:00:00.000Z' }), item({ id: 'q2', created_at: '2026-07-24T10:00:00.000Z' })],
        [{ ...board, rows: [{ ...rowData({ id: 'r1' }), status: 'blocked', annotation: null, annotation_unseen: false }] }],
        T0,
        new Set<string>(),
      )).toBe(3)
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
    expect(row.text).toBe(`Waiting ${live.text}`)
  })
})

// §7: what you SEE obeys the rail + search; what the badge COUNTS never does.
describe('needsYouEntries', () => {
  const items = [item({ id: 'q-api', project: 'api' })]
  const boards: AttentionBoard[] = [
    { id: 'b-web', project: 'web', title: 'Rollout', rows: [{ id: 'r-web', label: 'Deploy', status: 'blocked', annotation: null, annotation_unseen: false }] },
    { id: 'b-api', project: 'api', title: 'Migration', rows: [{ id: 'r-api', label: 'Backfill', status: 'blocked', annotation: null, annotation_unseen: false }] },
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
    expect(fn.indexOf('orderedIds(')).toBeLessThan(fn.indexOf('paginateNeedsYou('))
  })
})

// fix round 1: the stale fold's open/closed state must survive the 3s poll
// rebuild, the same way openLive/openContexts already do — otherwise the
// <details> silently snaps shut under the user mid-read. A source-level pin,
// deliberately: it fails if the persisted flag is declared inside staleFoldEl
// (re-initialized every render, so it can never remember anything) instead of
// at module scope, or if the toggle listener stops writing the state back —
// WHERE the flag lives is the invariant, and the jsdom harness in test/dom/
// cannot see that.
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
      .toBe('Delivered 2m ago — this answer can no longer be withdrawn')
  })
})

// fix round 1: a stale row (no re-render between staging and the click, which is
// routine — renderIfIdle suspends whenever a card is open or any draft has text) must
// never let the star Undo fallback silently revert a reply the agent already picked
// up. undoRefusal itself already tells the two snapshots apart correctly (below); this
// pins that needsRowEl's Undo handler actually FEEDS it the fresh lookup, not the
// row's closed-over `entry.item` — WHICH snapshot the handler reads, which is
// structure, not behaviour. Same readFileSync/source-pin style as the other
// app.js wiring pins in this file.
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

// Fix round 2 (I4): once the agent set reply_seen_at and BEFORE it calls
// resolve (which it may forget, permanently), an answered-but-open question was
// dropped by attentionEntries, by the strict still-awaiting-pickup filter the
// list used to run, by staleEntries AND by g.done —
// it rendered in no tab at all, while the old global search index still counted it
// under needsYou. The tab badge lit up and the tab then said "No matches here".
// The dimmed foot group is where it belongs: it also makes the card's
// "✓ picked up" marker (spec §15) reachable for the first time.
describe('repliedEntries', () => {
  const items = [
    item({ id: 'a', reply: 'go' }),
    item({ id: 'b', reply: 'go', reply_seen_at: new Date(T0).toISOString() }),
    item({ id: 'c' }),
    item({ id: 'd', kind: 'note', reply: 'go' }),
    item({ id: 'e', reply: 'go', status: 'resolved' }),
  ]
  it('keeps every replied, still-open question — picked up or not', () => {
    const entries = repliedEntries(items, T0, new Set<string>())
    expect(entries.map((e) => (e.kind === 'item' ? e.item.id : ''))).toEqual(['a', 'b'])
  })
  it('keeps the picked-up reply a strict awaiting-agent filter would drop — that is the whole point of I4', () => {
    const entries = repliedEntries(items, T0, new Set<string>())
    const b = entries.find((e) => e.kind === 'item' && e.item.id === 'b')
    expect(b, 'the picked-up-but-open question is missing from the foot group').toBeTruthy()
    expect(b!.kind === 'item' && b!.item.reply_seen_at, 'b must be the PICKED-UP one, or this case proves nothing').toBeTruthy()
  })
})
