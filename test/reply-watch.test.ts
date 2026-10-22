import { EventEmitter } from 'node:events'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import replyWatch from '../electron/reply-watch.cjs'
import { attentionEntries, laterEntries } from '../public/attention.js'
import type { AttentionBoard, AttentionItem } from '../public/attention.js'
import { optionOrder } from '../public/card.js'
import type { CardOption } from '../public/card.js'
import {
  advanceBoardRow, annotateBoardRow, annotateItem, closeProject, dismissItem, getBoard, getItem, insertItem,
  markReplySeen, openDb, pinBoardRow, pinItem, replyItem, resolveItem, snoozeItem, upsertBoard,
} from '../src/store.js'
import type { NewBoardRow } from '../src/store.js'
import { createViewer } from '../src/viewer.js'
import { scratchDir } from './scratch.js'

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
    expect(main).toContain('known = knownNotificationIds(everything, laterEntries(items, boards, Date.now()))')
    expect(main).toContain("note.on('action'")
    expect(main).toContain('submitNotificationResponse(URL_BASE, actionable.target, answer)')
    expect(main).toContain('refreshNotificationTarget')
    expect(main).toContain('Response not applied')
    expect(main).toContain('if (polling) return')
    expect(main).toContain("poll().finally(() => { polling = false })")
    expect(main).toContain('notificationRetainer.show(note)')
  })
})

describe('knownNotificationIds (#247)', () => {
  const question = (id: string, over: Record<string, unknown> = {}) => ({
    id, project: 'p', kind: 'question', status: 'open', reply: null, created_at: new Date(NOW).toISOString(), ...over,
  })

  it('counts every ask in attention plus the pinned asks, never a snoozed one', () => {
    const pinnedRow = { id: 'r-pinned', status: 'blocked', annotation: null, annotation_unseen: false, revision: 4, pinned_at: new Date(NOW).toISOString() }
    const snoozedRow = { id: 'r-snoozed', status: 'blocked', annotation: null, annotation_unseen: false, revision: 7, snoozed_until: new Date(NOW + MINUTE).toISOString() }
    const open = { id: 'r-open', status: 'blocked', annotation: null, annotation_unseen: false, revision: 2 }
    const boards = [{ id: 'b', project: 'p', title: 'Plan', revision: 9, rows: [open, pinnedRow, snoozedRow] }]
    const items = [
      question('q-open'),
      question('q-pinned', { pinned_at: new Date(NOW).toISOString() }),
      question('q-snoozed', { snoozed_until: new Date(NOW + MINUTE).toISOString() }),
    ]
    const known = replyWatch.knownNotificationIds(
      attentionEntries(items, boards, NOW, []),
      laterEntries(items, boards, NOW),
    )
    expect([...known].sort()).toEqual(['q:q-open', 'q:q-pinned', 'r:r-open:v2', 'r:r-pinned:v4'])
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
    directory = scratchDir('notification-identity-')
    db = openDb(join(directory, 'inbox.db'))
    viewer = createViewer(db)
  })

  afterEach(() => {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })

  // One startAttentionWatch poll without the Electron side effects, reading what
  // main.cjs reads: the lean item projection (#156) and the active boards.
  function watch() {
    let known: Set<string> | null = null
    return async () => {
      const grouped = await (await request(`${BASE}api/items?scope=attention`)).json() as {
        needsYou: Array<{ items: AttentionItem[] }>
      }
      const items = grouped.needsYou.flatMap((group) => group.items)
      const boards = await latestBoards()
      const everything = attentionEntries(items, boards, Date.now(), [])
      const fresh = replyWatch.freshAttentionNotifications(known, everything.map(replyWatch.attentionNotification))
      known = replyWatch.knownNotificationIds(everything, laterEntries(items, boards, Date.now()))
      return fresh
    }
  }

  const post = async (route: string, body: unknown) => (await request(`${BASE}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })).json()

  const pinAsk = async (pinned: boolean) => {
    const board = getBoard(db, PROJECT, TITLE)!
    expect(await post(`api/boards/${board.id}/rows/${askRow().id}/later`, {
      pinned, expected_revision: askRow().revision, expected_board_version: board.revision,
    })).toEqual({ ok: true })
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

  // #247: a pin moves no revision, and `known` keeps pinned asks, so bringing
  // one back — the human's own move — announces nothing, and the buttons on
  // the notification already shown still apply.
  it('does not re-announce a row the human pinned and brought back', async () => {
    const poll = watch()
    const shown = await announceAsk(poll)
    await pinAsk(true)
    expect(await poll()).toEqual([])
    await pinAsk(false)
    expect(await poll()).toEqual([])

    await replyWatch.submitNotificationResponse(BASE, shown.target, 'Tomorrow', request)
    expect(askRow()).toMatchObject({ annotation: 'Tomorrow', pinned_at: null })
  })

  it('announces a new action on a pinned row as a new ask', async () => {
    const poll = watch()
    const shown = await announceAsk(poll)
    await pinAsk(true)
    expect(await poll()).toEqual([])

    const board = getBoard(db, PROJECT, TITLE)!
    expect(advanceBoardRow(db, {
      project: PROJECT, title: TITLE, label: ASK.label, agent: 'copilot',
      expectedBoardVersion: board.revision, expectedRevision: askRow().revision,
      note: 'The freeze moved.', next_step: 'Choose a window after the freeze.', action_owner: 'decision',
      impact: 'Schedules the release.', options: [{ label: 'Friday', recommended: true }, { label: 'Monday' }],
    })).toMatchObject({ ok: true })
    expect(askRow().pinned_at).toBeNull()
    const fresh = await poll()
    expect(fresh).toHaveLength(1)
    expect(fresh[0]!.id).not.toBe(shown.id)
    expect(fresh[0]!.target).toMatchObject({ rowId: askRow().id, revision: askRow().revision })
  })

  it('announces a question again when its snooze ends, never when the human unpins it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(NOW)
      const poll = watch()
      expect(await poll()).toEqual([])
      const id = insertItem(db, { project: PROJECT, stream: '', agent: 'copilot', kind: 'question', title: 'Ship it?' })
      expect(await poll()).toEqual([expect.objectContaining({ id: `q:${id}` })])

      expect(await post(`api/items/${id}/later`, { pinned: true })).toEqual({ ok: true })
      expect(await poll()).toEqual([])
      expect(await post(`api/items/${id}/later`, { pinned: false })).toEqual({ ok: true })
      expect(await poll()).toEqual([])

      expect(await post(`api/items/${id}/snooze`, { until: new Date(NOW + 60 * MINUTE).toISOString() })).toEqual({ ok: true })
      expect(await poll()).toEqual([])
      vi.setSystemTime(NOW + 2 * 60 * MINUTE)
      expect(await poll()).toEqual([expect.objectContaining({ id: `q:${id}` })])
    } finally {
      vi.useRealTimers()
    }
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

// issue #156: electron/main.cjs cannot be imported here, so this pins the two
// inputs it switched between. It used to feed attentionEntries the whole history
// (needsYou + notes + done) and responseWatch.scan the full payload; it now reads
// ?scope=attention and feeds them needsYou and that lean payload. Everything the
// watcher derives must come out identical.
describe('the dock watcher lean item read (issue #156)', () => {
  const HOUR = 60 * MINUTE

  it('derives the same attention sets, response targets and reminders as the full payload', async () => {
    const directory = scratchDir('dock-watch-')
    const db = openDb(join(directory, 'inbox.db'))
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const scope = (project: string) => ({ project, stream: 'drafts', agent: 'copilot' })
      vi.setSystemTime(NOW - 96 * HOUR)
      insertItem(db, { ...scope('alpha'), kind: 'question', title: 'Nobody listening any more' })
      // One frozen millisecond from here on, so tie order is exercised as well.
      vi.setSystemTime(NOW - 10 * MINUTE)
      const waiting = insertItem(db, {
        ...scope('alpha'), session: 'live', kind: 'question', title: 'Waiting on you',
        options: [{ label: 'Hold' }, { label: 'Ship it', recommended: true }],
      })
      insertItem(db, { ...scope('alpha'), kind: 'question', title: 'Parked' })
      replyItem(db, insertItem(db, { ...scope('alpha'), session: 'live', kind: 'question', title: 'Answered' }), 'Go')
      const read = insertItem(db, { ...scope('beta'), kind: 'question', title: 'Answered and read' })
      replyItem(db, read, 'Done')
      expect(markReplySeen(db, read, getItem(db, read)!.replied_at)).toBe(true)
      snoozeItem(db, insertItem(db, { ...scope('beta'), kind: 'question', title: 'Snoozed' }), new Date(NOW + HOUR).toISOString())
      expect(pinItem(db, insertItem(db, { ...scope('beta'), kind: 'question', title: 'Pinned' }), true)).toBe(true)
      resolveItem(db, insertItem(db, { ...scope('beta'), kind: 'question', title: 'Resolved' }), 'Finished.')
      dismissItem(db, insertItem(db, { ...scope('beta'), kind: 'question', title: 'Dismissed' }))
      annotateItem(db, insertItem(db, { ...scope('beta'), kind: 'note', title: 'Open note' }), 'Noted')
      resolveItem(db, insertItem(db, { ...scope('beta'), kind: 'note', title: 'Closed note' }))
      insertItem(db, { ...scope('beta'), kind: 'done', title: 'Shipped' })
      insertItem(db, { ...scope('gamma'), session: 'live', kind: 'question', title: 'In a closed project' })
      closeProject(db, 'gamma')
      upsertBoard(db, {
        ...scope('alpha'),
        title: 'Release',
        rows: [
          { label: 'Approve', status: 'blocked' },
          { label: 'Choose', status: 'blocked' },
          { label: 'Track', status: 'tracked' },
          { label: 'Set aside', status: 'blocked' },
        ],
      })
      annotateBoardRow(db, getBoard(db, 'alpha', 'Release')!.rows[1]!.id, 'Option B')
      const release = getBoard(db, 'alpha', 'Release')!
      expect(pinBoardRow(db, release.rows[3]!.id, true, release.rows[3]!.revision, release.revision)).toBe(true)
      vi.setSystemTime(NOW)

      const app = createViewer(db)
      const get = async (route: string) => (await app.request(route)).json()
      const full = await get('/api/items')
      const lean = await get('/api/items?scope=attention')
      const boards = await get('/api/boards')
      const closed = await get('/api/projects/closed')
      type Group = { items: AttentionItem[] }
      const before: AttentionItem[] = [
        ...full.needsYou.flatMap((group: Group) => group.items),
        ...full.notes.flatMap((group: Group) => group.items),
        ...full.done,
      ]
      const after: AttentionItem[] = lean.needsYou.flatMap((group: Group) => group.items)
      expect(full.notes).not.toEqual([])
      expect(full.done).not.toEqual([])
      expect(lean.notes).toEqual([])
      expect(lean.done).toEqual([])
      expect(closed).toEqual(['gamma'])

      for (const nowMs of [NOW, NOW + 2 * HOUR]) {
        const visible = attentionEntries(after, boards, nowMs, ['live'], closed)
        const everything = attentionEntries(after, boards, nowMs, ['live'])
        expect(visible).toEqual(attentionEntries(before, boards, nowMs, ['live'], closed))
        expect(everything).toEqual(attentionEntries(before, boards, nowMs, ['live']))
        expect(new Set(visible.map((entry) => entry.kind))).toEqual(new Set(['item', 'row']))
        expect(everything.length).toBeGreaterThan(visible.length)
        // #247: the pins ride the lean read too, so the dock's known set agrees.
        const later = laterEntries(after, boards, nowMs)
        expect(later).toEqual(laterEntries(before, boards, nowMs))
        expect(later.filter((entry) => entry.later === 'pinned')).toHaveLength(2)
        expect(replyWatch.knownNotificationIds(everything, later))
          .toEqual(replyWatch.knownNotificationIds(attentionEntries(before, boards, nowMs, ['live']), laterEntries(before, boards, nowMs)))
      }
      expect(attentionEntries(after, boards, NOW + 2 * HOUR, ['live']).length)
        .toBeGreaterThan(attentionEntries(after, boards, NOW, ['live']).length)

      // main.cjs builds native notifications from these entries (#179): each
      // question's id and title, and its options as the action buttons.
      const notifications = attentionEntries(after, boards, NOW, ['live'], closed).map(replyWatch.attentionNotification)
      const ask = notifications.find((notification) => notification.itemId === waiting)!
      expect(ask).toMatchObject({ id: `q:${waiting}`, text: 'Waiting on you', target: { source: 'item', id: waiting } })
      expect(replyWatch.cannedResponseActions(optionOrder((ask.item as { options: CardOption[] }).options)).responses)
        .toEqual(['Ship it', 'Hold'])

      expect(replyWatch.responseTargets(lean, boards)).toEqual(replyWatch.responseTargets(full, boards))
      const fromFull = replyWatch.createResponseWatch()
      const fromLean = replyWatch.createResponseWatch()
      for (const nowMs of [NOW, NOW + 2 * MINUTE, NOW + 20 * MINUTE]) {
        const expected = fromFull.scan(full, boards, nowMs)
        const actual = fromLean.scan(lean, boards, nowMs)
        expect(actual).toEqual(expected)
        expect(replyWatch.wakeAdapterPayload([...actual.newTargets, ...actual.reminders]))
          .toEqual(replyWatch.wakeAdapterPayload([...expected.newTargets, ...expected.reminders]))
        if (nowMs === NOW) {
          expect(actual.newTargets.map((target) => target.source).sort()).toEqual(['item', 'row'])
          expect(actual.reminders).toHaveLength(2)
        }
      }
    } finally {
      vi.useRealTimers()
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
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
