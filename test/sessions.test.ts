// #454: the Agents home's session cards (design
// docs/superpowers/specs/2026-11-04-agents-home-design.md §2). Pure, so plain
// objects in, cards out; the clock is NOW.
import { describe, expect, it } from 'vitest'
import { cardMatches, filterCounts, groupCards, messageHint, sessionCards } from '../public/sessions.js'

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
    expect(cards['session:i']).toMatchObject({ state: 'idle', text: 'Proofreading', historical: true, recency: 'idle 47m' })
    expect(cards['session:h']).toMatchObject({ state: 'idle', recency: 'idle 40m' })
    expect(cards['session:d']).toMatchObject({ state: 'dormant', place: 'dormant', host: 'Claude Code', recency: 'idle 9h' })
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
    expect(work!.children).toEqual([{ name: 'tests', doing: 'Running' }])
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
    // stopped with its session kept: Parked, so Resume stays at hand
    expect(cards[`launch:${ID(2)}`]).toMatchObject({ state: 'parked', place: 'main', recency: 'stopped 1h' })
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

describe('sessionCards: asks', () => {
  const item = (id: string, o: Record<string, unknown>) => ({ kind: 'item', item: { id, created_at: at(5000), kind: 'question', ...o } })

  it('attributes an item by its session and a row by the card’s linked plan, and Needs you wins over every state', () => {
    const board = { id: 'b1', project: 'alpha', stream: 'main', agent: 'claude-code', title: 'Plan', updated_at: at(1000), rows: [] }
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
    // a dormant session with an ask leaves the Dormant fold
    expect(cards['session:k']).toMatchObject({ state: 'ask', label: 'Needs you', base: 'dormant', place: 'main', approval: false })
    expect(cards['session:k']!.asks.map((entry) => (entry as unknown as { row: { id: string } }).row.id)).toEqual(['r1'])
    // the driver files its approval with the session's id, which the launch remembers once the session is gone
    expect(cards[`launch:${ID(1)}`]).toMatchObject({ state: 'ask', base: 'parked', approval: true })
    // an item naming no session is the rail's alone
    expect(cards['session:c']).toMatchObject({ state: 'working', asks: [] })
  })
})

describe('filters, groups and the Message hint', () => {
  const cards = sessionCards({
    activity: [
      row({ session: 'a', project: 'zeta', doing: 'Working', last_call_at: at(1000) }),
      row({ session: 'b', project: 'alpha', agent: 'claude-code', doing: 'Working', last_call_at: at(2000) }),
      row({ session: 'c', project: 'zeta', agent: 'claude-code', doing: 'open', idle: true, last_call_at: at(HOUR) }),
    ],
    nowMs: NOW,
  })

  it('counts the states, and a filter shows its own', () => {
    expect(filterCounts(cards)).toEqual({ all: 3, ask: 0, working: 2, idle: 1, parked: 0 })
    expect(cards.filter((card) => cardMatches(card, 'idle')).map((card) => card.id)).toEqual(['session:c'])
    expect(cards.filter((card) => cardMatches(card, 'all'))).toHaveLength(3)
  })

  it('groups by project or by agent kind, each group where its first card is', () => {
    expect(groupCards(cards).map((group) => [group.label, group.cards.map((card) => card.id)])).toEqual([
      ['zeta', ['session:a', 'session:c']], ['alpha', ['session:b']],
    ])
    expect(groupCards(cards, 'agent').map((group) => [group.label, group.cards.length])).toEqual([['Copilot', 1], ['Claude Code', 2]])
  })

  it('says when a message reaches the session', () => {
    expect(messageHint(row({ session: 'x', receives_messages: true }))).toBe('It sees a message when it next checks')
    expect(messageHint(row({ session: 'x', receives_messages: true, push_wake: true }))).toBe('A message arrives now')
    expect(messageHint(row({ session: 'x' }))).toBe('It can’t receive messages until it restarts')
    expect(messageHint(null)).toBe('')
  })
})
