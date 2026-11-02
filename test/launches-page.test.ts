// Issue #412 step 3, PR 3: the page's pure launch rules (public/launches.js):
// the New session request main checks again, what a launch's state reads as,
// and the transcript's lines.
import { describe, expect, it } from 'vitest'
import { launchStatus, newSessionRequest, transcriptLines } from '../public/launches.js'

const BASE = { root: '/work/alpha', mode: 'ask', model: '', reasoningEffort: '', activeHours: '2', toolCalls: '500', prompt: 'Fix it.' }

describe('the New session request', () => {
  it('names only the fields main accepts, with budgets in its units', () => {
    expect(newSessionRequest(BASE)).toEqual({ request: { root: '/work/alpha', mode: 'ask', budgets: { activeMs: 7_200_000, toolCalls: 500 }, prompt: 'Fix it.' } })
    expect(newSessionRequest({ ...BASE, root: null, model: ' claude-haiku-4.5 ', reasoningEffort: 'none' })).toEqual({
      request: { root: null, mode: 'ask', model: 'claude-haiku-4.5', reasoningEffort: 'none', budgets: { activeMs: 7_200_000, toolCalls: 500 }, prompt: 'Fix it.' },
    })
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
    expect(launchStatus(launch(), [session], NOW)).toMatchObject({ state: 'running', actions: ['stop', 'transcript'] })
    expect(launchStatus(launch(), [], NOW)).toMatchObject({ state: 'starting' })
    expect(launchStatus(launch({ updated_at: '2026-11-02T11:57:00.000Z' }), [], NOW)).toMatchObject({ state: 'lost', actions: ['close', 'stop', 'transcript'] })
    expect(launchStatus(launch({ stop_requested_at: '2026-11-02T11:59:50.000Z' }), [session], NOW)).toMatchObject({ state: 'stopping', actions: ['transcript'] })
    expect(launchStatus(launch({ status: 'parked', park_reason: 'Its session could not be loaded.' }), [], NOW)).toMatchObject({
      state: 'parked', text: 'Parked: idle, its session kept. Its session could not be loaded.', actions: ['resume', 'stop', 'transcript'],
    })
    expect(launchStatus(launch({ status: 'ended', end_reason: 'budget:tool_calls' }), [], NOW)).toMatchObject({ state: 'ended', text: 'Ended: tool-call budget used' })
    expect(launchStatus(launch({ status: 'ended', end_reason: 'something_new' }), [], NOW).text).toBe('Ended (something_new)')
  })
})

describe('the transcript', () => {
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
    ])
  })
})
