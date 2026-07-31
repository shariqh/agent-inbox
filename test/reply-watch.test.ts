import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
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
    options: [
      { label: 'Send me the link first' },
      { label: 'Use the Trust Center diagram', recommended: true },
    ],
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

describe('canned notification responses', () => {
  it('retains a shown notification until the user acts on or closes it', () => {
    const held = new Set()
    const timer = { unref: vi.fn() }
    const setTimeoutImpl = vi.fn(() => timer)
    const retainer = replyWatch.createNotificationRetainer({ held, setTimeoutImpl, retentionMs: 10_000 })
    const notification = Object.assign(new EventEmitter(), { show: vi.fn() })

    retainer.show(notification)
    expect(held.has(notification)).toBe(true)
    expect(notification.show).toHaveBeenCalledOnce()
    expect(setTimeoutImpl).toHaveBeenCalledWith(expect.any(Function), 10_000)
    expect(timer.unref).toHaveBeenCalledOnce()

    notification.emit('action', { actionIndex: 0 })
    expect(held.has(notification)).toBe(false)
  })

  it('turns ordered question options into native buttons and stable response labels', () => {
    expect(replyWatch.cannedResponseActions([
      { label: 'Use the Trust Center diagram', recommended: true },
      { label: 'Send me the link first' },
    ])).toEqual({
      actions: [
        { type: 'button', text: 'Use the Trust Center diagram' },
        { type: 'button', text: 'Send me the link first' },
      ],
      responses: ['Use the Trust Center diagram', 'Send me the link first'],
    })
  })

  it('maps both current and legacy Electron action events without guessing invalid indexes', () => {
    const responses = ['Recommended', 'Alternative']
    expect(replyWatch.responseForNotificationAction(responses, { actionIndex: 1 })).toBe('Alternative')
    expect(replyWatch.responseForNotificationAction(responses, {}, 0)).toBe('Recommended')
    expect(replyWatch.responseForNotificationAction(responses, { actionIndex: 9 })).toBeNull()
  })

  it('posts the selected label through the existing inbox reply route', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    }))

    await expect(replyWatch.submitCannedResponse(
      'http://localhost:4319/',
      'question/1',
      'Use the Trust Center diagram',
      fetchImpl,
    )).resolves.toBeUndefined()

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:4319/api/items/question%2F1/reply',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"text":"Use the Trust Center diagram"}',
      },
    )
  })

  it('surfaces HTTP and store refusals instead of reporting a successful response', async () => {
    await expect(replyWatch.submitCannedResponse(
      'http://localhost:4319/',
      'question-1',
      'Recommended',
      async () => ({ ok: false, status: 503, json: async () => ({ ok: false }) }),
    )).rejects.toThrow('HTTP 503')

    await expect(replyWatch.submitCannedResponse(
      'http://localhost:4319/',
      'question-1',
      'Recommended',
      async () => ({ ok: true, status: 200, json: async () => ({ ok: false }) }),
    )).rejects.toThrow('reply was refused')
  })

  it('is wired into the Electron notification action event', () => {
    const main = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8')
    expect(main).toContain('cannedResponseActions(question ? optionOrder(question.options) : [])')
    expect(main).toContain("note.on('action'")
    expect(main).toContain('submitCannedResponse(URL_BASE, question.id, answer)')
    expect(main).toContain('notificationRetainer.show(note)')
  })
})

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
