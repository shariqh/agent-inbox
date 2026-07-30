import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import replyWatch from '../electron/reply-watch.cjs'

const NOW = Date.parse('2026-07-31T12:00:00.000Z')
const MINUTE = 60_000

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: 'question-1',
    project: 'email-triage',
    stream: 'drafts',
    agent: 'copilot',
    session: 'session-1',
    kind: 'question',
    title: 'Use the gated diagram?',
    status: 'open',
    reply: 'Send me the link first',
    reply_context: 'I want to verify the source.',
    replied_at: new Date(NOW - 2 * MINUTE).toISOString(),
    reply_seen_at: null,
    ...overrides,
  }
}

function grouped(items = [item()]) {
  return {
    needsYou: [{ project: 'email-triage', items }],
    notes: [],
    done: [],
  }
}

function boardRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    label: 'Supreme Court draft',
    status: 'blocked',
    annotation: 'Use the Trust Center diagram.',
    annotated_at: new Date(NOW - 3 * MINUTE).toISOString(),
    annotation_seen_at: new Date(NOW - 2 * MINUTE).toISOString(),
    handled_at: null,
    handled_seen_at: null,
    ...overrides,
  }
}

function board(rows = [boardRow()]) {
  return {
    id: 'board-1',
    project: 'email-triage',
    stream: 'drafts',
    agent: 'copilot',
    title: 'Email Draft Review',
    rows,
  }
}

describe('responseTargets', () => {
  it('returns answered questions that no agent has read, with routing metadata', () => {
    expect(replyWatch.responseTargets(grouped(), [])).toEqual([
      expect.objectContaining({
        key: 'item:question-1',
        source: 'item',
        focusId: 'question-1',
        session: 'session-1',
        project: 'email-triage',
        response: 'Send me the link first',
        responseContext: 'I want to verify the source.',
      }),
    ])
  })

  it('drops questions after pending() marks the answer read', () => {
    expect(replyWatch.responseTargets(grouped([item({ reply_seen_at: new Date(NOW).toISOString() })]), [])).toEqual([])
  })

  it('keeps human-acted rows until the agent changes the row status', () => {
    expect(replyWatch.responseTargets(grouped([]), [board()])).toEqual([
      expect.objectContaining({
        key: 'row:row-1',
        source: 'row',
        focusId: 'board-1',
        response: 'Use the Trust Center diagram.',
        humanMarkedDone: false,
      }),
    ])
    expect(replyWatch.responseTargets(grouped([]), [board([boardRow({ status: 'partial' })])])).toEqual([])
  })

  it('includes a human done mark even when the row has no annotation', () => {
    const actedAt = new Date(NOW - MINUTE).toISOString()
    const targets = replyWatch.responseTargets(grouped([]), [
      board([boardRow({ annotation: null, annotated_at: null, handled_at: actedAt })]),
    ])
    expect(targets).toEqual([
      expect.objectContaining({
        key: 'row:row-1',
        response: null,
        humanMarkedDone: true,
        actedAt,
      }),
    ])
  })
})

describe('createResponseWatch', () => {
  it('emits each new response once, then reminds on the configured cadence', () => {
    const watch = replyWatch.createResponseWatch({ initialDelayMs: MINUTE, repeatMs: 5 * MINUTE })

    const first = watch.scan(grouped(), [], NOW)
    expect(first.newTargets).toHaveLength(1)
    expect(first.reminders).toHaveLength(1)

    const quiet = watch.scan(grouped(), [], NOW + 4 * MINUTE)
    expect(quiet.newTargets).toEqual([])
    expect(quiet.reminders).toEqual([])

    const repeat = watch.scan(grouped(), [], NOW + 5 * MINUTE)
    expect(repeat.newTargets).toEqual([])
    expect(repeat.reminders).toHaveLength(1)
  })

  it('cleans resolved targets and treats a changed answer as a new wake event', () => {
    const watch = replyWatch.createResponseWatch({ initialDelayMs: MINUTE, repeatMs: 5 * MINUTE })
    watch.scan(grouped(), [], NOW)
    expect(watch.scan(grouped([]), [], NOW + MINUTE)).toEqual({ newTargets: [], reminders: [] })

    const changed = item({
      reply: 'Use the architecture diagram instead',
      replied_at: new Date(NOW + 2 * MINUTE).toISOString(),
    })
    expect(watch.scan(grouped([changed]), [], NOW + 2 * MINUTE).newTargets).toHaveLength(1)
  })
})

describe('wake adapter', () => {
  it('builds a stable adapter payload without watcher bookkeeping', () => {
    const target = replyWatch.responseTargets(grouped(), [])[0]!
    expect(replyWatch.wakeAdapterPayload([target])).toEqual({
      event: 'agent-inbox.response.waiting',
      targets: [
        expect.not.objectContaining({
          version: expect.anything(),
          actedAtMs: expect.anything(),
        }),
      ],
    })
  })

  it('accepts only an absolute executable and JSON string arguments', () => {
    const errors: string[] = []
    expect(replyWatch.wakeAdapterFromEnv({
      AGENT_INBOX_WAKE_COMMAND: '/usr/local/bin/inbox-wake',
      AGENT_INBOX_WAKE_ARGS: '["--host","copilot"]',
    }, { error: (message: string) => errors.push(message) })).toEqual({
      command: '/usr/local/bin/inbox-wake',
      args: ['--host', 'copilot'],
    })
    expect(replyWatch.wakeAdapterFromEnv({
      AGENT_INBOX_WAKE_COMMAND: 'inbox-wake',
    }, { error: (message: string) => errors.push(message) })).toBeNull()
    expect(errors).toHaveLength(1)
  })

  it('spawns without a shell and writes one newline-terminated JSON payload', async () => {
    class FakeChild extends EventEmitter {
      stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() })
      stdin = { end: vi.fn() }
      kill = vi.fn()
    }
    const child = new FakeChild()
    const spawnImpl = vi.fn(() => child)
    const promise = replyWatch.runWakeAdapter(
      { command: '/usr/local/bin/inbox-wake', args: ['--host', 'copilot'] },
      { event: 'agent-inbox.response.waiting', targets: [{ key: 'item:question-1' }] },
      { spawnImpl, timeoutMs: 1_000 },
    )
    child.emit('exit', 0)
    await expect(promise).resolves.toBeUndefined()
    expect(spawnImpl).toHaveBeenCalledWith(
      '/usr/local/bin/inbox-wake',
      ['--host', 'copilot'],
      expect.objectContaining({ shell: false, windowsHide: true }),
    )
    expect(child.stdin.end).toHaveBeenCalledWith(
      '{"event":"agent-inbox.response.waiting","targets":[{"key":"item:question-1"}]}\n',
    )
  })
})
