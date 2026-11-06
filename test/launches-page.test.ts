// Issue #412 step 3, PR 3: the page's pure launch rules (public/launches.js):
// the New session request main checks again, what a launch's state reads as,
// and the transcript's lines.
import { describe, expect, it } from 'vitest'
import { budgetAllowance, launchStatus, newSessionRequest, transcriptLines } from '../public/launches.js'

const BASE = { root: '/work/alpha', mode: 'ask', model: '', reasoningEffort: '', activeHours: '2', toolCalls: '500', prompt: 'Fix it.' }

describe('the New session request', () => {
  it('names only the fields main accepts, with budgets in its units', () => {
    expect(newSessionRequest(BASE)).toEqual({ request: { root: '/work/alpha', mode: 'ask', budgets: { activeMs: 7_200_000, toolCalls: 500 }, prompt: 'Fix it.' } })
    expect(newSessionRequest({ ...BASE, root: null, model: ' claude-haiku-4.5 ', reasoningEffort: 'none' })).toEqual({
      request: { root: null, mode: 'ask', model: 'claude-haiku-4.5', reasoningEffort: 'none', budgets: { activeMs: 7_200_000, toolCalls: 500 }, prompt: 'Fix it.' },
    })
    // #479: an empty limit is no limit, the default
    expect(newSessionRequest({ ...BASE, activeHours: '', toolCalls: ' ' })).toMatchObject({ request: { budgets: { activeMs: null, toolCalls: null } } })
    expect(newSessionRequest({ ...BASE, activeHours: '' })).toMatchObject({ request: { budgets: { activeMs: null, toolCalls: 500 } } })
    expect(newSessionRequest({ ...BASE, toolCalls: '' })).toMatchObject({ request: { budgets: { activeMs: 7_200_000, toolCalls: null } } })
  })

  it.each([
    [{ root: 'work' }, /project or a folder/],
    [{ mode: 'autopilot' }, /mode/],
    [{ model: 'gpt 5; rm' }, /model id/],
    [{ reasoningEffort: 'huge' }, /reasoning effort/],
    [{ activeHours: '0.01' }, /1 minute and 8 hours/],
    [{ activeHours: '9' }, /1 minute and 8 hours/],
    [{ toolCalls: '0' }, /1 and 2000/],
    [{ toolCalls: '2001' }, /1 and 2000/],
    [{ toolCalls: '1.5' }, /1 and 2000/],
    [{ prompt: '  ' }, /Describe the task/],
    [{ prompt: 'x'.repeat(65_537) }, /longer than/],
  ])('refuses %o', (change, error) => {
    expect(newSessionRequest({ ...BASE, ...change } as typeof BASE)).toEqual({ error: expect.stringMatching(error) })
  })
})

describe('a launch’s state', () => {
  const NOW = Date.parse('2026-11-02T12:00:00.000Z')
  const launch = (over: Record<string, unknown> = {}) => ({
    id: 'L', status: 'running', updated_at: '2026-11-02T11:59:30.000Z', created_at: '2026-11-02T11:59:00.000Z', stop_requested_at: null, ...over,
  })
  const session = { driven: true, driven_launch: 'L', session: 'mcp-1' }

  it('reads running, starting, not responding, stopping, parked and ended, each with its actions', () => {
    expect(launchStatus(launch(), [session], NOW)).toMatchObject({ state: 'running', actions: ['stop', 'park', 'takeover', 'transcript'] })
    expect(launchStatus(launch(), [], NOW)).toMatchObject({ state: 'starting' })
    expect(launchStatus(launch({ updated_at: '2026-11-02T11:57:00.000Z' }), [], NOW)).toMatchObject({ state: 'lost', actions: ['close', 'stop', 'transcript'] })
    expect(launchStatus(launch({ stop_requested_at: '2026-11-02T11:59:50.000Z' }), [session], NOW)).toMatchObject({ state: 'stopping', actions: ['transcript'] })
    expect(launchStatus(launch({ status: 'parked', park_reason: 'Its session could not be loaded.' }), [], NOW)).toMatchObject({
      state: 'parked', text: 'Parked: idle, its session kept. Its session could not be loaded.', actions: ['resume', 'stop', 'transcript'],
    })
    // step 5: only a parked session Copilot persisted can be taken over in a terminal
    expect(launchStatus(launch({ status: 'parked', resumable: true }), [], NOW).actions).toEqual(['resume', 'takeover', 'stop', 'transcript'])
    // full resume: only a launch the human stopped, with its session, and its worktree still there
    expect(launchStatus(launch({ status: 'ended', end_reason: 'stopped', resumable: true }), [], NOW)).toEqual({
      state: 'ended', text: 'Stopped: its session is kept, so it can be resumed.', actions: ['resume', 'takeover', 'transcript'],
    })
    // #451: a budget-ended launch with its session resumes only with more budget
    expect(launchStatus(launch({ status: 'ended', end_reason: 'budget:active_time', resumable: true }), [], NOW)).toEqual({
      state: 'ended', text: 'Ended: active-time budget used. Its session is kept: add budget to resume it.', actions: ['resume', 'transcript'], budget: true,
    })
    for (const over of [
      { end_reason: 'stopped', resumable: false }, { end_reason: 'budget:tool_calls', resumable: false }, { end_reason: 'lost', resumable: true },
      { end_reason: 'stopped', resumable: true, worktree_path: '/w/a', worktree_removed_at: '2026-11-03T12:00:00.000Z' },
      { end_reason: 'budget:tool_calls', resumable: true, worktree_path: '/w/a', worktree_removed_at: '2026-11-03T12:00:00.000Z' },
    ]) expect(launchStatus(launch({ status: 'ended', ...over }), [], NOW).actions, JSON.stringify(over)).toEqual(['transcript'])
    expect(launchStatus(launch({ status: 'ended', end_reason: 'handed_off', resumable: true }), [], NOW)).toEqual({
      state: 'handed_off', text: 'Handed off to a terminal: it goes on in Copilot there.', actions: ['terminal', 'transcript'],
    })
    expect(launchStatus(launch({ status: 'ended', end_reason: 'budget:tool_calls' }), [], NOW)).toMatchObject({ state: 'ended', text: 'Ended: tool-call budget used' })
    expect(launchStatus(launch({ status: 'ended', end_reason: 'something_new' }), [], NOW).text).toBe('Ended (something_new)')
    // #432 PR 5: ended before its session was ready
    expect(launchStatus(launch({ status: 'ended', end_reason: 'error:setup', end_detail: 'Copilot exited before the session started.' }), [], NOW))
      .toEqual({ state: 'failed', text: 'Didn’t start: Copilot exited before the session started.', actions: ['transcript'] })
    expect(launchStatus(launch({ status: 'ended', end_reason: 'error:start' }), [], NOW)).toMatchObject({ state: 'failed', text: 'Didn’t start.' })
  })
})

describe('Resume with more budget… (#451)', () => {
  it('asks for whole minutes and calls within a new launch’s bounds, enough that the launch is not spent at once', () => {
    const spent = { budget_active_ms: 7_200_000, budget_tool_calls: 500, active_ms: 2_000_000, tool_calls: 500 }
    expect(budgetAllowance(spent, { activeHours: '0.5', toolCalls: '250' })).toEqual({ add: { activeMs: 1_800_000, toolCalls: 250 } })
    expect(budgetAllowance(spent, { activeHours: '1', toolCalls: '0' })).toEqual({ error: 'Add tool calls: it has used all of them.' })
    expect(budgetAllowance({ ...spent, active_ms: 7_300_000, tool_calls: 1 }, { activeHours: '0', toolCalls: '9' })).toEqual({ error: 'Add active time: it has used all of it.' })
    expect(budgetAllowance(spent, { activeHours: '8.5', toolCalls: '1' })).toMatchObject({ error: expect.stringMatching(/0 and 8 hours/) })
    expect(budgetAllowance(spent, { activeHours: '1', toolCalls: '2.5' })).toMatchObject({ error: expect.stringMatching(/0 and 2000/) })
    expect(transcriptLines([{ event: 'budget_raised', from: { activeMs: 7_200_000, toolCalls: 500 }, to: { activeMs: 9_000_000, toolCalls: 750 } }]))
      .toEqual([{ kind: 'note', text: 'You added budget: 2 h 30 min of active time and 750 tool calls in all.' }])
  })

  it('#479: adds nothing to a budget with no limit, whatever its field says, and checks only the other', () => {
    const spent = { budget_active_ms: null, budget_tool_calls: 500, active_ms: 9_000_000, tool_calls: 500 }
    expect(budgetAllowance(spent, { activeHours: undefined, toolCalls: '250' })).toEqual({ add: { activeMs: 0, toolCalls: 250 } })
    expect(budgetAllowance(spent, { activeHours: '3', toolCalls: '0' })).toEqual({ error: 'Add tool calls: it has used all of them.' })
    expect(budgetAllowance({ budget_active_ms: 60_000, budget_tool_calls: null, active_ms: 60_000, tool_calls: 900 }, { activeHours: '1', toolCalls: undefined }))
      .toEqual({ add: { activeMs: 3_600_000, toolCalls: 0 } })
    expect(transcriptLines([{ event: 'budget_raised', from: { activeMs: null, toolCalls: 500 }, to: { activeMs: null, toolCalls: 750 } }]))
      .toEqual([{ kind: 'note', text: 'You added budget: no limit on active time and 750 tool calls in all.' }])
  })
})

describe('the transcript', () => {
  it('names the effort fallback once, and not the first Copilot’s end (#432 PR 5)', () => {
    expect(transcriptLines([
      { event: 'ended', reason: 'error:setup', retry: 'effort' },
      { event: 'effort_fallback', model: 'claude-haiku-4.5' },
      { event: 'prompt', kind: 'task' },
    ])).toEqual([
      { kind: 'note', text: 'This model takes no reasoning effort, so Agent Inbox started it with none.' },
      { kind: 'note', text: 'The task was sent.' },
    ])
  })

  it('names a Take over and its end (step 5)', () => {
    expect(transcriptLines([
      { event: 'agent_text', text: 'Working.' },
      { event: 'handoff_requested', turn: 4 },
      { event: 'ended', reason: 'handed_off' },
    ])).toEqual([
      { kind: 'text', text: 'Working.' },
      { kind: 'note', text: 'You took it over: Agent Inbox stopped driving it.' },
      { kind: 'note', text: 'Handed off to a terminal: copilot --resume goes on with it there.' },
    ])
  })

  it('joins agent text per turn and names tool calls, asks and answers, skipping what it does not show', () => {
    expect(transcriptLines([
      { event: 'prompt', kind: 'task' },
      { event: 'agent_text', text: 'Hello ' },
      { event: 'agent_text', text: 'there.' },
      { event: 'tool_call', title: 'Read file', input: 'src/a.ts' },
      { event: 'linked', sessions: ['mcp-1'] },
      { event: 'permission_request', id: 3, tool: 'npm test', allow: 'proceed_once' },
      { event: 'permission_answer', id: 3, answer: 'proceed_once' },
      { event: 'permission_request', id: 4, tool: 'rm', allow: 'proceed_once' },
      { event: 'permission_answer', id: 4, answer: 'cancel', why: 'ask closed' },
      { event: 'turn_end', stopReason: 'end_turn' },
      { event: 'park_requested', turn: null },
      { event: 'ended', reason: 'park' },
      null,
    ])).toEqual([
      { kind: 'note', text: 'The task was sent.' },
      { kind: 'text', text: 'Hello there.' },
      { kind: 'tool', text: 'Read file\nsrc/a.ts' },
      { kind: 'ask', text: 'Asked to allow npm test' },
      { kind: 'answer', text: 'Allowed once' },
      { kind: 'ask', text: 'Asked to allow rm' },
      { kind: 'answer', text: 'Declined: the approval was closed' },
      { kind: 'note', text: 'Turn ended (end_turn).' },
      { kind: 'note', text: 'You asked it to park: it parks once its turn ends.' },
      { kind: 'note', text: 'Parked: Copilot stopped, its session kept to resume.' },
    ])
  })
})
