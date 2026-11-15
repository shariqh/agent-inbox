// #454: the Agents home's session cards (design
// docs/superpowers/specs/2026-11-04-agents-home-design.md §2). Pure, so plain
// objects in, cards out; the clock is NOW.
import { describe, expect, it } from 'vitest'
import { groupCards, hostLabel, laneCounts, laneOf, messageHint, sessionCards, splitLanes } from '../public/sessions.js'
import { attentionEntries } from '../public/attention.js'
import { buildDashboard } from '../public/dashboard.js'

const NOW = Date.parse('2026-11-04T12:00:00.000Z')
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const minute = Math.floor(NOW / 60_000)
const MIN = 60_000
const HOUR = 60 * MIN
const ID = (n: number) => `11111111-2222-4333-8444-${String(n).padStart(12, '0')}`

const row = (o: Record<string, unknown>) => ({ started_at: at(HOUR), updated_at: at(1000), stream: 'main', agent: 'copilot', ...o }) as never
const launch = (n: number, o: Record<string, unknown> = {}) => ({
  id: ID(n), project: 'alpha', stream: 'main', status: 'running', mode: 'ask', budget_tool_calls: 500, tool_calls: 0,
  created_at: at(HOUR), updated_at: at(1000), sessions: [], ...o,
}) as never
const driven = (session: string, n: number, o: Record<string, unknown> = {}) =>
  row({ session, project: 'alpha', driven: true, driven_launch: ID(n), receives_messages: true, ...o })
const by = <T extends { id: string }>(cards: T[]): Record<string, T> => Object.fromEntries(cards.map((card) => [card.id, card]))

describe('sessionCards: one card per session', () => {
  it('reads a terminal session as working, idle or dormant, by its last call, never the heartbeat', () => {
    const cards = by(sessionCards({
      activity: [
        row({ session: 'w', project: 'alpha', doing: 'Writing tests', last_call_at: at(8000) }),
        row({ session: 'i', project: 'alpha', doing: 'open', idle: true, last_doing: 'Proofreading', last_call_at: at(47 * MIN) }),
        // heartbeat only: a fresh updated_at with no call for 40 minutes is not working
        row({ session: 'h', project: 'alpha', doing: 'Claims work', last_call_at: at(40 * MIN), updated_at: at(10) }),
        row({ session: 'd', project: 'alpha', agent: 'claude-code', doing: 'open', idle: true, last_call_at: at(9 * HOUR) }),
      ],
      nowMs: NOW,
    }))
    expect(cards['session:w']).toMatchObject({ state: 'working', label: 'Working', place: 'main', text: 'Writing tests', historical: false,
      recency: 'last call just now', host: 'Copilot', origin: 'terminal' })
    // #466: no Agent Inbox call is no evidence of no work, so a terminal session is Quiet, never Idle
    expect(cards['session:i']).toMatchObject({ state: 'idle', label: 'Quiet', text: 'Proofreading', historical: true,
      line: 'Last reported: Proofreading · 47m ago', recency: 'no Agent Inbox call for 47m' })
    expect(cards['session:h']).toMatchObject({ state: 'idle', label: 'Quiet', recency: 'no Agent Inbox call for 40m',
      line: 'Last reported: Claims work · 40m ago' })
    expect(cards['session:d']).toMatchObject({ state: 'dormant', place: 'dormant', host: 'Claude Code', recency: 'no Agent Inbox call for 9h',
      line: 'No task reported yet' })
  })

  it('reads the host\'s hook stamps: a running turn is Working with its task not reported, an ended one Idle (#466 PR 2)', () => {
    const board = { id: 'b1', project: 'alpha', stream: 'main', agent: 'copilot', title: 'Plan', updated_at: at(1000),
      progress: { done: 1, partial: 0, countable: 2 }, rows: [] }
    const cards = by(sessionCards({
      activity: [
        // said done, then went on with gh and a shell for 35 minutes
        row({ session: 'busy', project: 'alpha', doing: 'open', idle: true, last_doing: 'Filing issues', last_call_at: at(40 * MIN),
          host_turn_at: at(35 * MIN), host_tool_at: at(5000) }),
        row({ session: 'fresh', project: 'beta', doing: 'open', idle: true, host_turn_at: at(2 * MIN) }),
        row({ session: 'ended', project: 'alpha', doing: 'open', idle: true, last_call_at: at(20 * MIN), host_turn_at: at(15 * MIN), host_idle_at: at(12 * MIN) }),
        // a turn with no stamp for over an hour: an interrupt that fired no Stop
        row({ session: 'stale', project: 'alpha', doing: 'open', idle: true, last_call_at: at(3 * HOUR), host_turn_at: at(2 * HOUR), host_tool_at: at(61 * MIN) }),
        // the #473 review's repro: woken by the answer watcher (no UserPromptSubmit), working on
        row({ session: 'woken', project: 'gamma', doing: 'open', idle: true, last_call_at: at(20 * MIN),
          host_turn_at: at(40 * MIN), host_idle_at: at(29 * MIN), host_tool_at: at(12_000) }),
        // the last tool's async PostToolUse landing just after its Stop reopens nothing
        row({ session: 'late', project: 'gamma', doing: 'open', idle: true, last_call_at: at(10 * MIN),
          host_turn_at: at(9 * MIN), host_idle_at: at(5 * MIN), host_tool_at: at(5 * MIN - 2000) }),
        row({ session: 'late2', project: 'gamma', doing: 'open', idle: true, last_call_at: at(10 * MIN),
          host_turn_at: at(9 * MIN), host_idle_at: at(5 * MIN + 2000), host_tool_at: at(5 * MIN) }),
        // no call for 9 hours, but its host ran a tool 5 minutes ago: not dormant
        row({ session: 'old', project: 'alpha', doing: 'open', idle: true, last_call_at: at(9 * HOUR), host_turn_at: at(6 * MIN), host_idle_at: at(5 * MIN) }),
      ],
      boards: [board as never],
      nowMs: NOW,
    }))
    expect(cards['session:busy']).toMatchObject({ state: 'working', label: 'Working', unreported: true, quiet: false,
      line: 'Task not reported · last reported: Filing issues · 40m ago', recency: 'turn running 35m · last tool just now', plan: null })
    expect(cards['session:fresh']).toMatchObject({ state: 'working', line: 'Task not reported', recency: 'turn running 2m' })
    expect(cards['session:ended']).toMatchObject({ state: 'idle', label: 'Idle', recency: 'turn ended 12m ago' })
    expect(cards['session:stale']).toMatchObject({ state: 'idle', label: 'Quiet', recency: 'no Agent Inbox call for 3h' })
    expect(cards['session:old']).toMatchObject({ state: 'idle', label: 'Idle', place: 'main' })
    expect(cards['session:woken']).toMatchObject({ state: 'working', label: 'Working', line: 'Task not reported', recency: 'last tool just now' })
    expect(cards['session:late']).toMatchObject({ state: 'idle', label: 'Idle' })
    expect(cards['session:late2']).toMatchObject({ state: 'idle', label: 'Idle' })
    // a running host turn is in the Working lane; the turns that ended are Quiet (dashboard lanes design §3.3)
    expect(laneCounts(Object.values(cards))).toEqual({ working: 3, quiet: 5 })
  })

  it('says Quiet only when it cannot know: a driven row idles as Idle, and a session with no call says so (#466)', () => {
    const cards = by(sessionCards({
      activity: [
        driven('dr', 1, { doing: 'open', idle: true, last_doing: 'Fixing the build', last_call_at: at(12 * MIN) }),
        // its driver says a turn is running: no claim is no evidence of idling (#470 review)
        driven('busy', 2, { doing: 'open', idle: true, last_call_at: at(40 * MIN), driven_turn: { state: 'turn', since: at(35 * MIN) } }),
        row({ session: 'new', project: 'alpha', doing: 'open', idle: true, started_at: at(3 * MIN) }),
        row({ session: 'now', project: 'alpha', doing: 'open', idle: true, last_call_at: at(5000) }),
      ],
      nowMs: NOW,
    }))
    expect(cards['session:dr']).toMatchObject({ state: 'idle', label: 'Idle', recency: 'idle 12m', line: 'Last reported: Fixing the build · 12m ago' })
    expect(cards['session:busy']).toMatchObject({ state: 'idle', label: 'Quiet', recency: 'no Agent Inbox call for 40m' })
    expect(cards['session:new']).toMatchObject({ label: 'Quiet', recency: 'connected 3m · no Agent Inbox call yet', line: 'No task reported yet' })
    expect(cards['session:now']).toMatchObject({ label: 'Quiet', recency: 'last Agent Inbox call just now' })
    // a quiet card is still idle: the state key is unchanged, and it is in the Quiet lane
    expect(Object.values(cards).map((card) => card.state)).toEqual(['idle', 'idle', 'idle', 'idle'])
    expect(laneCounts(Object.values(cards))).toEqual({ working: 0, quiet: 4 })
  })

  it('reads a running launch as Idle only while its driver reports no turn (#466)', () => {
    const cards = by(sessionCards({
      activity: [
        driven('t1', 1, { doing: 'open', idle: true, last_doing: 'Migrating fixtures', last_call_at: at(40 * MIN),
          driven_turn: { state: 'approval', since: at(2 * MIN) } }),
        driven('t2', 2, { doing: 'open', idle: true, last_call_at: at(12 * MIN) }),
      ],
      launches: [launch(1), launch(2)],
      nowMs: NOW,
    }))
    expect(cards[`launch:${ID(1)}`]).toMatchObject({ state: 'idle', label: 'Quiet', quiet: true, recency: 'no Agent Inbox call for 40m',
      line: 'Last reported: Migrating fixtures · 40m ago' })
    expect(cards[`launch:${ID(2)}`]).toMatchObject({ state: 'idle', label: 'Idle', quiet: false, recency: 'idle 12m' })
  })

  it('carries what the lanes showed on a working card only: plan bar, subagents and the call trace', () => {
    const board = { id: 'b1', project: 'alpha', stream: 'main', agent: 'copilot', title: 'Composer states', updated_at: at(1000),
      progress: { done: 4, partial: 1, countable: 7 }, rows: [] }
    const [work, idle] = sessionCards({
      activity: [
        row({ session: 'w', project: 'alpha', doing: 'Writing', last_call_at: at(1000), calls: [2, 3], calls_at: minute,
          children: [{ name: 'tests', doing: 'Running' }] }),
        row({ session: 'i', project: 'beta', doing: 'open', idle: true, last_call_at: at(HOUR), calls: [1], calls_at: minute }),
      ],
      boards: [board as never],
      nowMs: NOW,
    })
    expect(work!.plan).toMatchObject({ id: 'b1', done: 4, countable: 7, segments: { done: 4, partial: 1, waiting: 0, todo: 2 } })
    expect(work!.children).toEqual([{ name: 'tests', doing: 'Running', state: '' }])
    expect(work!.trace!.slice(-2)).toEqual([2, 3])
    expect(idle).toMatchObject({ plan: null, children: [], trace: null })
  })

  it('joins a launch with its live driven session into one card, which a Message reaches', () => {
    const cards = sessionCards({
      activity: [driven('mcp-1', 1, { doing: 'Fixing the test', last_call_at: at(2000) }), driven('other', 9, { doing: 'Elsewhere', last_call_at: at(2000) })],
      launches: [launch(1, { sessions: ['mcp-1'], branch: 'ai/fix', worktree_path: '/w/fix', worktree_summary: { ahead: 2, behind: 0, files: 5, dirty: 1 } })],
      nowMs: NOW,
    })
    expect(cards.map((card) => card.id)).toEqual([`launch:${ID(1)}`, 'session:other'])
    expect(cards[0]).toMatchObject({ session: 'mcp-1', state: 'working', origin: 'started here', text: 'Fixing the test', branch: 'ai/fix',
      worktree: 'worktree · 2 ahead · 5 files · 1 uncommitted' })
    // another driver's session (#412): driven, with Message only
    expect(cards[1]).toMatchObject({ origin: 'driven', launch: null })
  })

  it('keeps a launch’s card through every state, from the launch alone when no session is live', () => {
    const cards = by(sessionCards({
      activity: [],
      launches: [
        launch(1, { status: 'parked', parked_at: at(2 * HOUR), tool_calls: 88 }),
        launch(2, { status: 'ended', end_reason: 'stopped', resumable: true, ended_at: at(HOUR) }),
        launch(3, { status: 'ended', end_reason: 'handed_off', ended_at: at(HOUR) }),
        launch(4, { status: 'ended', end_reason: 'error:start', end_detail: 'No model', ended_at: at(HOUR) }),
        launch(5, { updated_at: at(10 * MIN) }),
        launch(6, { updated_at: at(1000) }),
        launch(7, { stop_requested_at: at(1000) }),
      ],
      nowMs: NOW,
    }))
    expect(cards[`launch:${ID(1)}`]).toMatchObject({ state: 'parked', place: 'main', recency: 'parked 2h', session: null,
      text: 'Parked: idle, its session kept. · 88 of 500 tool calls', historical: true })
    // stopped with its session kept: listed with Parked, so Resume stays at hand, but it says Stopped (#478)
    expect(cards[`launch:${ID(1)}`]!.label).toBe('Parked')
    expect(cards[`launch:${ID(2)}`]).toMatchObject({ state: 'parked', label: 'Stopped', place: 'main', recency: 'stopped 1h' })
    expect(cards[`launch:${ID(3)}`]).toMatchObject({ state: 'terminal', label: 'In Terminal', place: 'ended' })
    expect(cards[`launch:${ID(4)}`]).toMatchObject({ state: 'failed', label: 'Didn’t start', place: 'ended', text: 'Didn’t start: No model' })
    expect(cards[`launch:${ID(5)}`]).toMatchObject({ state: 'lost', label: 'Not responding', place: 'main', recency: 'no word for 10m' })
    expect(cards[`launch:${ID(6)}`]).toMatchObject({ state: 'starting', place: 'main', text: 'Starting…', historical: false })
    expect(cards[`launch:${ID(7)}`]).toMatchObject({ state: 'stopping', place: 'main' })
  })

  it('folds the newest five ended launches as Ended, every one whose worktree is kept too, and the rest as Earlier', () => {
    const ended = Array.from({ length: 7 }, (_, i) => launch(i + 1, { status: 'ended', end_reason: 'stopped', ended_at: at((i + 1) * HOUR),
      ...(i === 6 ? { worktree_path: '/w/kept' } : {}) }))
    const cards = sessionCards({ activity: [], launches: ended, nowMs: NOW })
    const place = Object.fromEntries(cards.map((card) => [card.id.slice(-1), card.place]))
    expect(place).toEqual({ 1: 'ended', 2: 'ended', 3: 'ended', 4: 'ended', 5: 'ended', 6: 'earlier', 7: 'ended' })
    // a summary it cannot read says only that there is a worktree
    expect(cards.find((card) => card.id.endsWith('7'))?.worktree).toBe('worktree')
  })

  it('draws no launch card with the switch off (§9): a driven row is a card of its own', () => {
    const cards = sessionCards({ activity: [driven('mcp-1', 1, { doing: 'Fixing', last_call_at: at(1000) })], launches: null, nowMs: NOW })
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ id: 'session:mcp-1', origin: 'driven', launch: null })
  })

  it('puts a closed project’s sessions in their own fold, whatever their state', () => {
    const cards = sessionCards({
      activity: [row({ session: 's', project: 'shut', doing: 'Working', last_call_at: at(1000) })],
      launches: [launch(1, { project: 'shut', status: 'parked' })],
      closed: ['shut'],
      nowMs: NOW,
    })
    expect(cards.map((card) => card.place)).toEqual(['closed', 'closed'])
  })
})

// Dashboard lanes design §3.3, §3.4: a card holds its asks only to count them
// ("Asking you · N"); its state and place are its own, and the asks rise in
// the Needs you lane.
describe('sessionCards: asks', () => {
  const item = (id: string, o: Record<string, unknown>) => ({ kind: 'item', item: { id, created_at: at(5000), kind: 'question', ...o } })

  it('attributes an item by its session and a row by the plan its session stamped, keeping each card its own state', () => {
    const board = { id: 'b1', project: 'alpha', stream: 'main', agent: 'claude-code', title: 'Plan', updated_at: at(1000), rows: [], session: 'k' }
    const cards = by(sessionCards({
      activity: [
        row({ session: 'k', agent: 'claude-code', project: 'alpha', doing: 'open', idle: true, last_call_at: at(9 * HOUR) }),
        row({ session: 'c', project: 'beta', doing: 'Working', last_call_at: at(1000) }),
      ],
      launches: [launch(1, { status: 'parked', sessions: ['gone'] })],
      boards: [board as never],
      attention: [
        { kind: 'row', row: { id: 'r1', label: 'Approve the metric set', action_started_at: at(4000) }, board },
        item('i1', { project: '@sessions', session: 'gone', title: 'Allow shell: npm test' }),
        item('i2', { project: 'beta', title: 'No session named' }),
      ] as never,
      nowMs: NOW,
    }))
    // a dormant session with an ask keeps its base state and folds as Dormant
    expect(cards['session:k']).toMatchObject({ state: 'dormant', base: 'dormant', label: 'Dormant', place: 'dormant' })
    expect(cards['session:k']!.asks.map((entry) => (entry as unknown as { row: { id: string } }).row.id)).toEqual(['r1'])
    // the driver files its approval with the session's id, which the launch remembers once the session is gone
    expect(cards[`launch:${ID(1)}`]).toMatchObject({ state: 'parked', base: 'parked' })
    expect(cards[`launch:${ID(1)}`]!.asks).toHaveLength(1)
    // an item naming no session is no card's: it shows only in Needs you
    expect(cards['session:c']).toMatchObject({ state: 'working', asks: [] })
    expect(Object.keys(cards).filter((id) => id.startsWith('ask:'))).toEqual([])
  })

  it('gives a plan row’s ask to one card only (#458 review)', () => {
    const board = { id: 'b1', project: 'p', stream: 'main', agent: 'claude-code', title: 'Plan', updated_at: at(1000), rows: [], session: 'A' }
    const ask = { kind: 'row', row: { id: 'r1', label: 'Rotate the token', action_started_at: at(4000) }, board }
    const quiet = (session: string, ms: number) => row({ session, project: 'p', agent: 'claude-code', doing: 'open', idle: true, last_call_at: at(ms) })
    const activity = [quiet('A', 5 * MIN), quiet('B', 40 * MIN), quiet('C', 9 * HOUR), quiet('D', 30 * HOUR)]
    const cards = by(sessionCards({ activity, boards: [board as never], attention: [ask] as never, nowMs: NOW }))
    // the stamping session's card has it; every card keeps its own state and place
    expect(['A', 'B', 'C', 'D'].map((s) => [cards[`session:${s}`]!.state, cards[`session:${s}`]!.place, cards[`session:${s}`]!.asks.length]))
      .toEqual([['idle', 'main', 1], ['idle', 'main', 0], ['dormant', 'dormant', 0], ['dormant', 'dormant', 0]])

    // unstamped, the newest quiet session the join matches takes it (#454 A.1 step 2), so it never looks ended
    const loose = sessionCards({ activity, boards: [{ ...board, session: null } as never], attention: [{ ...ask, board: { ...board, session: null } }] as never, nowMs: NOW })
    expect(loose.filter((card) => card.asks.length).map((card) => card.id)).toEqual(['session:A'])
    // and with no quiet session on its branch, no card holds it
    const none = sessionCards({ activity: activity.map((r) => ({ ...(r as object), stream: 'other' }) as never), boards: [{ ...board, session: null } as never],
      attention: [{ ...ask, board: { ...board, session: null } }] as never, nowMs: NOW })
    expect(none.filter((card) => card.asks.length)).toEqual([])
    expect(none).toHaveLength(4)
    // and a working session joins it as its lane does, the newest one only
    const two = sessionCards({
      activity: [...activity, row({ session: 'W1', project: 'p', agent: 'claude-code', doing: 'Working', last_call_at: at(2 * MIN) }),
        row({ session: 'W2', project: 'p', agent: 'claude-code', doing: 'Working', last_call_at: at(MIN) })],
      boards: [{ ...board, session: null } as never], attention: [{ ...ask, board: { ...board, session: null } }] as never, nowMs: NOW,
    })
    expect(two.filter((card) => card.asks.length).map((card) => card.id)).toEqual(['session:W2'])
  })

  it('holds a card’s asks in rail order, and its asks never move it out of its lane', () => {
    const items = [item('newer', { project: 'alpha', session: 's', created_at: at(1000) }), item('older', { project: 'alpha', session: 's', created_at: at(9000) })]
    const cards = sessionCards({ activity: [row({ session: 's', project: 'alpha', doing: 'Working', last_call_at: at(1000) })], attention: items as never, nowMs: NOW })
    expect(cards[0]!.asks.map((entry) => (entry as unknown as { item: { id: string } }).item.id)).toEqual(['older', 'newer'])
    expect(cards[0]).toMatchObject({ state: 'working', label: 'Working' })
    expect(laneOf(cards[0]!)).toBe('working')
  })

  it('laneCounts counts main cards: Working by base working (a running host turn included), Quiet the rest', () => {
    const cards = sessionCards({
      activity: [
        row({ session: 'w', project: 'alpha', doing: 'Writing', last_call_at: at(1000) }),
        row({ session: 'turn', project: 'alpha', doing: 'open', idle: true, host_turn_at: at(2 * MIN) }),
        row({ session: 'i', project: 'alpha', doing: 'open', idle: true, last_call_at: at(47 * MIN) }),
        row({ session: 'd', project: 'alpha', doing: 'open', idle: true, last_call_at: at(9 * HOUR) }),
        row({ session: 'x', project: 'shut', doing: 'Working', last_call_at: at(1000) }),
      ],
      launches: [launch(1, { status: 'parked' })],
      closed: ['shut'],
      nowMs: NOW,
    })
    expect(laneCounts(cards)).toEqual({ working: 2, quiet: 2 })
    expect(laneCounts([])).toEqual({ working: 0, quiet: 0 })
    expect([hostLabel('copilot'), hostLabel('claude-code'), hostLabel('codex')]).toEqual(['Copilot', 'Claude Code', 'codex'])
  })
})

// The 11-04 amendment's invariant moved from the cards to the Needs you lane
// (dashboard lanes design §3.2, §8): every attention entry shows exactly once
// on the Dashboard, and a card holds at most one of them, to count it.
describe('every ask once: in the lane, on at most one card', () => {
  const q = (id: string, o: Record<string, unknown> = {}) => ({ id, kind: 'question', status: 'open', project: 'p', stream: 'main', agent: 'claude-code', created_at: at(10 * MIN), ...o })
  const plan = (id: string, o: Record<string, unknown>, rows: Array<Record<string, unknown>>) => ({
    id, project: 'p', stream: 'main', agent: 'claude-code', title: `Plan ${id}`, updated_at: at(30 * MIN), revision: 1,
    rows: rows.map((r, n) => ({ id: `${id}-r${n}`, label: `Step ${n}`, status: 'blocked', revision: 1, ...r })), ...o,
  })
  const ids = (entries: Array<{ kind: string; item?: { id: string }; row?: { id: string } }>) =>
    entries.map((entry) => (entry.kind === 'item' ? entry.item!.id : entry.row!.id)).sort()

  // live, ended and unknown sessions; stamped, joined and unstamped plans; a closed
  // project; snoozed, pinned and stale asks; an @sessions approval with the switch off
  const activity = [
    row({ session: 'live', project: 'p', agent: 'claude-code', doing: 'Working', last_call_at: at(1000) }),
    row({ session: 'quiet', project: 'q', stream: 'dev', agent: 'copilot', doing: 'open', idle: true, last_call_at: at(2 * HOUR) }),
    row({ session: 'shut-s', project: 'shut', doing: 'Working', last_call_at: at(1000) }),
  ]
  const items = [
    q('live-q', { session: 'live' }),
    q('gone-1', { session: 'gone', created_at: at(3 * HOUR) }),
    q('gone-2', { session: 'gone', created_at: at(4 * HOUR) }),
    q('loose-q', { project: 'r', agent: 'copilot' }),
    q('closed-q', { project: 'shut', session: 'shut-s' }),
    q('snoozed-q', { session: 'live', snoozed_until: at(-HOUR) }),
    q('pinned-q', { session: 'gone', pinned_at: at(MIN), created_at: at(5 * HOUR) }),
    q('stale-q', { session: 'long-gone', created_at: at(80 * HOUR) }),
    q('approval', { project: '@sessions', session: 'drv-1', agent: 'copilot', action_owner: 'approval', title: 'Allow shell: npm test' }),
  ]
  const boards = [
    plan('stamped', { session: 'live' }, [{}]),
    plan('ended', { session: 'gone', updated_at: at(5 * HOUR) }, [{}, { pinned_at: at(MIN) }]),
    plan('joined', { project: 'q', stream: 'dev', agent: 'copilot', session: null }, [{}]),
    plan('orphan', { project: 'r', stream: 'x', session: null, updated_at: at(20 * MIN) }, [{}, {}]),
    plan('closed', { project: 'shut', session: null }, [{}]),
  ]
  const live = activity.map((r) => (r as { session: string }).session)
  const attention = attentionEntries(items as never, boards as never, NOW, live, ['shut'])
  const cards = sessionCards({ activity, boards: boards as never, attention: attention as never, closed: ['shut'], launches: null, nowMs: NOW })
  const byId = by(cards)

  it('puts each attention entry in the lane once and on at most one card, and draws no ask-only card', () => {
    const lane = buildDashboard({ items: items as never, boards: boards as never, archived: [], activity: activity as never, nowMs: NOW, liveSessionIds: live, closedProjects: ['shut'] }).needsYou
    expect(ids(lane as never)).toEqual(ids(attention as never))
    expect(new Set(ids(lane as never)).size).toBe(attention.length)
    const held = ids(cards.flatMap((card) => card.asks) as never)
    expect(new Set(held).size).toBe(held.length)
    expect(held.every((id) => ids(attention as never).includes(id))).toBe(true)
    expect(cards.map((card) => card.id).filter((id) => id.startsWith('ask:'))).toEqual([])
    // snoozed, pinned, stale and closed asks stay out, because attentionEntries leaves them out
    for (const out of ['snoozed-q', 'pinned-q', 'stale-q', 'closed-q', 'closed-r0', 'ended-r1']) expect(ids(attention as never)).not.toContain(out)
  })

  it('leaves an ended session’s, an unstamped plan’s and a session-less ask on no card; a joined plan on its idle card', () => {
    expect(ids(byId['session:live']!.asks as never)).toEqual(['live-q', 'stamped-r0'])
    // the idle session on the plan's project, branch and agent takes its row (step 2), and stays idle
    expect(byId['session:quiet']).toMatchObject({ state: 'idle', place: 'main', base: 'idle' })
    expect(ids(byId['session:quiet']!.asks as never)).toEqual(['joined-r0'])
    const held = new Set(ids(cards.flatMap((card) => card.asks) as never))
    for (const id of ['gone-1', 'gone-2', 'ended-r0', 'loose-q', 'orphan-r0', 'orphan-r1', 'approval']) expect(held.has(id), id).toBe(false)
    // a closed project's session keeps its fold
    expect(byId['session:shut-s']).toMatchObject({ place: 'closed', asks: [] })
  })

  it('shows this session’s answers not picked up yet, never counted', () => {
    const answered = [
      { kind: 'item', item: q('replied', { session: 'live', reply: 'Yes' }) },
      { kind: 'item', item: q('seen', { session: 'live', reply: 'Yes', reply_seen_at: at(MIN) }) },
      { kind: 'row', row: { id: 'done-row', status: 'blocked', handled_at: at(MIN) }, board: boards[0] },
    ]
    const withAnswers = by(sessionCards({ activity, boards: boards as never, attention: attention as never, answered, nowMs: NOW }))
    expect(withAnswers['session:live']!.answered.map((entry) => needsId(entry as never))).toEqual(['replied', 'done-row'])
    expect(withAnswers['session:live']!.asks).toHaveLength(2)
  })
})

const needsId = (entry: { kind: string; item?: { id: string }; row?: { id: string } }) => (entry.kind === 'item' ? entry.item!.id : entry.row!.id)

describe('the lanes: Working, Quiet or a fold (dashboard lanes design §3.3, §3.4, §8)', () => {
  // working, a running host turn, idle, quiet, dormant, a working session in a closed
  // project, and the launch states: running idle, parked, stopped, ended, failed, starting
  const cards = sessionCards({
    activity: [
      row({ session: 'w', project: 'alpha', doing: 'Writing', last_call_at: at(1000) }),
      row({ session: 'turn', project: 'alpha', doing: 'open', idle: true, host_turn_at: at(2 * MIN) }),
      row({ session: 'i', project: 'beta', doing: 'open', idle: true, host_turn_at: at(15 * MIN), host_idle_at: at(12 * MIN), last_call_at: at(20 * MIN) }),
      row({ session: 'q', project: 'beta', doing: 'open', idle: true, last_call_at: at(47 * MIN) }),
      row({ session: 'd', project: 'alpha', doing: 'open', idle: true, last_call_at: at(9 * HOUR) }),
      row({ session: 'x', project: 'shut', doing: 'Working', last_call_at: at(1000) }),
      driven('run', 1, { doing: 'open', idle: true, last_call_at: at(12 * MIN) }),
    ],
    launches: [
      launch(1, { sessions: ['run'] }),
      launch(2, { status: 'parked', parked_at: at(MIN) }),
      launch(3, { status: 'ended', end_reason: 'stopped', copilot_session_id: 'cs-3', ended_at: at(MIN) }),
      launch(4, { status: 'ended', end_reason: 'exited', ended_at: at(2 * MIN) }),
      launch(5, { status: 'failed', ended_at: at(3 * MIN) }),
      launch(6, { status: 'starting' }),
    ],
    closed: ['shut'],
    nowMs: NOW,
  })

  it('puts each card in exactly one place: Working, Quiet or a fold', () => {
    for (const card of cards) {
      const lane = laneOf(card)
      if (card.place !== 'main') expect(lane, card.id).toBeNull()
      else expect(lane, card.id).toBe(card.base === 'working' ? 'working' : 'quiet')
    }
    const { working, quiet } = splitLanes(cards)
    const folded = cards.filter((card) => card.place !== 'main')
    const placed = [...working, ...quiet, ...folded].map((card) => card.id)
    expect(new Set(placed).size).toBe(placed.length)
    expect([...placed].sort()).toEqual(cards.map((card) => card.id).sort())
    expect(working.map((card) => card.id).sort()).toEqual(['session:turn', 'session:w'])
    // a working session in a closed project keeps its fold, out of both lanes
    expect(cards.find((card) => card.id === 'session:x')).toMatchObject({ base: 'working', place: 'closed' })
    expect(quiet.map((card) => card.id)).toContain('launch:' + ID(2))
    expect(quiet.map((card) => card.id)).toContain('launch:' + ID(6))
    // splitLanes keeps the order the cards come in
    expect(working.map((card) => card.id)).toEqual(cards.filter((card) => laneOf(card) === 'working').map((card) => card.id))
  })

  it('laneCounts equals the lanes', () => {
    const { working, quiet } = splitLanes(cards)
    expect(laneCounts(cards)).toEqual({ working: working.length, quiet: quiet.length })
    expect(laneCounts([])).toEqual({ working: 0, quiet: 0 })
  })

  it('groups Working by project, each group where its first card is', () => {
    const shown = sessionCards({
      activity: [
        row({ session: 'a', project: 'zeta', doing: 'Working', last_call_at: at(1000) }),
        row({ session: 'b', project: 'alpha', agent: 'claude-code', doing: 'Working', last_call_at: at(2000) }),
        row({ session: 'c', project: 'zeta', agent: 'claude-code', doing: 'Working', last_call_at: at(3000) }),
      ],
      nowMs: NOW,
    })
    expect(groupCards(shown).map((group) => [group.key, group.label, group.cards.map((card) => card.id)])).toEqual([
      ['zeta', 'zeta', ['session:a', 'session:c']], ['alpha', 'alpha', ['session:b']],
    ])
  })

  it('says when a message reaches the session', () => {
    expect(messageHint(row({ session: 'x', receives_messages: true }))).toBe('It sees a message when it next checks')
    expect(messageHint(row({ session: 'x', receives_messages: true, push_wake: true }))).toBe('A message arrives now')
    expect(messageHint(row({ session: 'x' }))).toBe('It can’t receive messages until it restarts')
    expect(messageHint(null)).toBe('')
  })
})
