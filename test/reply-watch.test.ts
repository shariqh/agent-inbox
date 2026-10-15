import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import replyWatch from '../electron/reply-watch.cjs'
import { attentionEntries } from '../public/attention.js'
import type { AttentionBoard, AttentionItem } from '../public/attention.js'
import { getBoard, insertItem, openDb, upsertBoard } from '../src/store.js'
import type { NewBoardRow } from '../src/store.js'
import { createViewer } from '../src/viewer.js'

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
      'http://127.0.0.1:4319/',
      'question/1',
      'Use the Trust Center diagram',
      fetchImpl,
    )).resolves.toBeUndefined()

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:4319/api/items/question%2F1/reply',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://127.0.0.1:4319',
        },
        body: '{"text":"Use the Trust Center diagram"}',
      },
    )
  })

  it('posts a blocked-row choice through the row annotation route', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    }))
    await expect(replyWatch.submitNotificationResponse(
      'http://127.0.0.1:4319/',
      { source: 'row', boardId: 'board/1', rowId: 'row/1', revision: 3, boardRevision: 7 },
      'Merge PR #42',
      fetchImpl,
    )).resolves.toBeUndefined()

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:4319/api/boards/board%2F1/rows/row%2F1/annotate',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://127.0.0.1:4319',
        },
        body: '{"text":"Merge PR #42","kind":"answer","expected_revision":3,"expected_board_version":7}',
      },
    )
  })

  it('refreshes only the board revision when the row action itself is unchanged', () => {
    const target = { source: 'row' as const, boardId: 'board-1', rowId: 'row-1', revision: 3, boardRevision: 7 }
    expect(replyWatch.refreshNotificationTarget([{
      id: 'board-1',
      revision: 8,
      rows: [{ id: 'row-1', revision: 3 }],
    }], target)).toEqual({ ...target, boardRevision: 8 })
    expect(replyWatch.refreshNotificationTarget([{
      id: 'board-1',
      revision: 8,
      rows: [{ id: 'row-1', revision: 4 }],
    }], target)).toBeNull()
  })

  it('surfaces HTTP and store refusals instead of reporting a successful response', async () => {
    await expect(replyWatch.submitCannedResponse(
      'http://127.0.0.1:4319/',
      'question-1',
      'Recommended',
      async () => ({ ok: false, status: 503, json: async () => ({ ok: false }) }),
    )).rejects.toThrow('HTTP 503')

    await expect(replyWatch.submitCannedResponse(
      'http://127.0.0.1:4319/',
      'question-1',
      'Recommended',
      async () => ({ ok: true, status: 200, json: async () => ({ ok: false }) }),
    )).rejects.toThrow('reply was refused')
  })

  it('is wired into the Electron notification action event', () => {
    const main = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8')
    expect(main).toContain('cannedResponseActions(actionable ? optionOrder(actionable.item.options) : [])')
    expect(main).toContain('const entries = attn.map(attentionNotification)')
    expect(main).toContain('const fresh = freshAttentionNotifications(known, entries)')
    expect(main).toContain('known = new Set(everything.map(attentionNotification).map((e) => e.id))')
    expect(main).toContain("note.on('action'")
    expect(main).toContain('submitNotificationResponse(URL_BASE, actionable.target, answer)')
    expect(main).toContain('refreshNotificationTarget')
    expect(main).toContain('Response not applied')
    expect(main).toContain('if (polling) return')
    expect(main).toContain("poll().finally(() => { polling = false })")
    expect(main).toContain('notificationRetainer.show(note)')
  })
})

// #158. Drives the identity helpers main.cjs uses over real viewer routes, the
// real store and the shared attention predicate, so the store's revision rules
// and the notification identity are exercised together.
describe('native attention notifications', () => {
  const BASE = 'http://127.0.0.1:4319/'
  const PROJECT = 'release'
  const TITLE = 'Release plan'
  const ASK = {
    label: 'Deploy window',
    status: 'blocked' as const,
    note: 'The release candidate is ready.',
    next_step: 'Choose the deploy window.',
    action_owner: 'decision' as const,
    impact: 'Schedules the release.',
    options: [{ label: 'Today', recommended: true }, { label: 'Tomorrow' }],
  }
  let directory: string
  let db: Database.Database
  let viewer: ReturnType<typeof createViewer>
  const request = async (url: string, init?: RequestInit) => viewer.request(url, init)
  const latestBoards = async () => (await request(`${BASE}api/boards`)).json() as Promise<AttentionBoard[]>
  const askRow = () => getBoard(db, PROJECT, TITLE)!.rows.find((row) => row.label === ASK.label)!

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'notification-identity-'))
    db = openDb(join(directory, 'inbox.db'))
    viewer = createViewer(db)
  })

  afterEach(() => {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })

  // One startAttentionWatch poll without the Electron side effects.
  function watch() {
    let known: Set<string> | null = null
    return async () => {
      const grouped = await (await request(`${BASE}api/items`)).json() as {
        needsYou: Array<{ items: AttentionItem[] }>
        notes: Array<{ items: AttentionItem[] }>
        done: AttentionItem[]
      }
      const items = [
        ...grouped.needsYou.flatMap((group) => group.items),
        ...grouped.notes.flatMap((group) => group.items),
        ...grouped.done,
      ]
      const entries = attentionEntries(items, await latestBoards(), Date.now(), []).map(replyWatch.attentionNotification)
      const fresh = replyWatch.freshAttentionNotifications(known, entries)
      known = new Set(entries.map((entry) => entry.id))
      return fresh
    }
  }

  async function announceAsk(poll: ReturnType<typeof watch>) {
    expect(await poll()).toEqual([])
    upsertBoard(db, { project: PROJECT, stream: '', agent: 'copilot', title: TITLE, rows: [ASK] })
    const fresh = await poll()
    expect(fresh).toHaveLength(1)
    expect(fresh[0]!.text).toBe(`🚧 ${TITLE} · ${ASK.label}`)
    return fresh[0]!
  }

  it('does not re-announce an unchanged ask after rows move around it, and its buttons still apply', async () => {
    const poll = watch()
    const shown = await announceAsk(poll)
    const before = getBoard(db, PROJECT, TITLE)!
    upsertBoard(db, {
      project: PROJECT,
      stream: '',
      agent: 'copilot',
      title: TITLE,
      expectedVersion: before.revision,
      rows: [
        { label: 'Build', status: 'partial', note: 'CI is green.' },
        { label: ASK.label, revision: askRow().revision, status: 'blocked' },
      ],
    })
    expect(await poll()).toEqual([])

    // The move changed the board token, so main.cjs's first attempt is refused…
    await expect(replyWatch.submitNotificationResponse(BASE, shown.target, 'Tomorrow', request))
      .rejects.toThrow('refused')
    // …and its board-token refresh applies the original choice.
    const refreshed = replyWatch.refreshNotificationTarget(await latestBoards(), shown.target)
    expect(refreshed).not.toBeNull()
    await replyWatch.submitNotificationResponse(BASE, refreshed!, 'Tomorrow', request)
    expect(askRow()).toMatchObject({ annotation: 'Tomorrow', annotation_kind: 'answer' })
  })

  it.each<[string, Partial<NewBoardRow>]>([
    ['note', { note: 'The window moved to Friday.' }],
    ['next step', { next_step: 'Choose a window after the freeze.' }],
    ['options', { options: [{ label: 'Friday', recommended: true }, { label: 'Monday' }] }],
    ['context', { context: 'Legal asked for a later window.' }],
  ])('re-announces a changed %s with fresh buttons a stale choice cannot answer', async (_field, change) => {
    const poll = watch()
    const shown = await announceAsk(poll)
    const before = getBoard(db, PROJECT, TITLE)!
    upsertBoard(db, {
      project: PROJECT,
      stream: '',
      agent: 'copilot',
      title: TITLE,
      expectedVersion: before.revision,
      rows: [{ label: ASK.label, revision: askRow().revision, status: 'blocked', ...change }],
    })
    const after = getBoard(db, PROJECT, TITLE)!
    const fresh = await poll()
    expect(fresh).toHaveLength(1)
    expect(fresh[0]!.id).not.toBe(shown.id)
    expect(fresh[0]!.item).toMatchObject(change)
    expect(fresh[0]!.target).toEqual({
      source: 'row',
      boardId: after.id,
      rowId: askRow().id,
      revision: askRow().revision,
      boardRevision: after.revision,
    })

    await expect(replyWatch.submitNotificationResponse(BASE, shown.target, 'Today', request))
      .rejects.toThrow('refused')
    expect(replyWatch.refreshNotificationTarget(await latestBoards(), shown.target)).toBeNull()
    expect(askRow().annotation).toBeNull()

    const choice = askRow().options![1]!.label
    await replyWatch.submitNotificationResponse(BASE, fresh[0]!.target, choice, request)
    expect(askRow().annotation).toBe(choice)
  })

  it('keys a question by its id alone', async () => {
    const poll = watch()
    expect(await poll()).toEqual([])
    const id = insertItem(db, { project: PROJECT, stream: '', agent: 'copilot', kind: 'question', title: 'Ship it?' })
    expect(await poll()).toEqual([expect.objectContaining({
      id: `q:${id}`,
      itemId: id,
      text: 'Ship it?',
      target: { source: 'item', id },
    })])
    expect(await poll()).toEqual([])
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
