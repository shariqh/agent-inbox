import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EventEmitter } from 'node:events'
import Database from 'better-sqlite3'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  annotateBoardRow, annotateItem, dismissItem, getBoard, getItem, insertItem, listItems, listPending,
  markItemAnnotationDelivered, openDb, replyItem, resolveItem, upsertBoard,
} from '../src/store.js'
import { buildMcpServer } from '../src/mcp.js'
import { createViewer } from '../src/viewer.js'
import { inferProject } from '../src/infer.js'
import { runHook } from '../src/hook.js'
import { waitForQuestionResponse } from '../src/watch.js'
import { attentionEntries } from '../public/attention.js'

const PROJECT = inferProject(process.cwd())
const NOW = new Date('2026-09-20T16:00:00.000Z')
const HUMAN_TEXT = '  Correction: keep the rollback.\n\n```sh\ncheck --dry-run\n```\nDo not send yet. 😀  '
const CONTEXT = 'Agent-authored background. '.repeat(40)

describe('item annotation delivery', () => {
  let directory: string
  let path: string
  let agent: Database.Database
  let human: Database.Database
  let server: McpServer | undefined
  let client: Client | undefined
  let removeListeners: Array<() => void>

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    directory = mkdtempSync(join(tmpdir(), 'item-annotations-'))
    path = join(directory, 'inbox.db')
    agent = openDb(path)
    human = openDb(path)
    removeListeners = []
  })

  afterEach(async () => {
    await client?.close()
    await server?.close()
    client = undefined
    server = undefined
    for (const remove of removeListeners) remove()
    human.close()
    agent.close()
    rmSync(directory, { recursive: true, force: true })
    vi.useRealTimers()
  })

  function item(kind: 'question' | 'note' | 'done', project = PROJECT) {
    return insertItem(agent, {
      project, stream: 'topic', agent: 'copilot', session: 'asking-session',
      kind, title: `${kind} with feedback`, context: CONTEXT,
    })
  }

  async function connect() {
    const events: EventEmitter = process
    for (const signal of ['exit', 'SIGINT', 'SIGTERM'] as const) {
      const previous = events.listeners(signal)
      removeListeners.push(() => {
        for (const listener of events.listeners(signal)) {
          if (!previous.includes(listener)) events.removeListener(signal, listener as (...args: unknown[]) => void)
        }
      })
    }
    server = buildMcpServer(agent, process.cwd())
    client = new Client({ name: 'claude-code', version: 'test' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    await call('register', { project: PROJECT, stream: 'topic', repo: 'test/example' })
  }

  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client!.callTool({ name, arguments: args })
    expect(result.isError, JSON.stringify(result)).not.toBe(true)
    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text)
  }

  async function annotateViaViewer(id: string, text: string) {
    return createViewer(human).request(`/api/items/${id}/annotate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })
  }

  async function raceAnnotationPickup(write: () => void) {
    const prepare = agent.prepare.bind(agent)
    let injected = false
    agent.prepare = ((sql: string) => {
      const statement = prepare(sql)
      if (/UPDATE items SET/.test(sql) && sql.includes('annotation_seen_at =')) {
        const run = statement.run.bind(statement)
        statement.run = ((...args: unknown[]) => {
          if (!injected) {
            injected = true
            write()
          }
          return run(...args)
        }) as typeof statement.run
      }
      return statement
    }) as typeof agent.prepare
    try {
      const result = await call('pending')
      expect(injected).toBe(true)
      return result
    } finally {
      agent.prepare = prepare
    }
  }

  it.each(['note', 'done'] as const)('delivers full human feedback on an open %s once, without attention or auto-resolution', async (kind) => {
    await connect()
    const id = item(kind)
    const saved = await annotateViaViewer(id, HUMAN_TEXT)
    expect(await saved.json()).toEqual({ ok: true })
    const before = getItem(human, id)!
    expect(before).toMatchObject({
      annotation: HUMAN_TEXT,
      annotated_at: NOW.toISOString(),
      annotation_seen_at: null,
      annotation_seen_by: null,
      response_revision: 1,
    })
    vi.setSystemTime(new Date(NOW.getTime() + 1000))
    const pending = await call('pending')
    expect(pending.items).toHaveLength(1)
    expect(pending.items[0]).toMatchObject({
      id, kind, project: PROJECT, stream: 'topic', agent: 'copilot', session: 'asking-session',
      annotation: HUMAN_TEXT, response_revision: before.response_revision, context: CONTEXT,
    })
    expect(getItem(human, id)).toMatchObject({
      status: 'open', annotation: HUMAN_TEXT,
      annotation_seen_at: new Date(NOW.getTime() + 1000).toISOString(),
      annotation_seen_by: 'claude-code', updated_at: before.updated_at,
      response_revision: before.response_revision,
    })
    expect((await call('pending')).items).toHaveLength(0)
    expect(attentionEntries(listItems(human), [], Date.now(), new Set(['asking-session']))).toEqual([])
  })

  it('explicitly rereads picked-up feedback and its current token without trimming human text or moving the receipt', async () => {
    await connect()
    const id = item('note')
    annotateItem(human, id, HUMAN_TEXT)
    await call('pending')
    const pickedUp = getItem(human, id)!
    vi.setSystemTime(new Date(NOW.getTime() + 60_000))
    const reread = await call('pending', { item_id: id })
    expect(reread.items).toHaveLength(1)
    expect(reread.items[0]).toMatchObject({
      id, annotation: HUMAN_TEXT, response_revision: pickedUp.response_revision,
      annotated_at: pickedUp.annotated_at,
      annotation_seen_at: pickedUp.annotation_seen_at,
      annotation_seen_by: 'claude-code',
      context_chars: CONTEXT.length,
    })
    expect(reread.items[0].context).toBeUndefined()
    expect((await call('pending', { item_id: id, full: true })).items[0].context).toBe(CONTEXT)
    expect(getItem(human, id)).toEqual(pickedUp)
    expect((await call('pending')).items).toHaveLength(0)
  })

  it('preserves the first pickup age and reader on same-version delivery by another connection', () => {
    const id = item('note')
    annotateItem(human, id, HUMAN_TEXT)
    const snapshot = getItem(agent, id)!
    vi.setSystemTime(new Date(NOW.getTime() + 1000))
    expect(markItemAnnotationDelivered(human, id, snapshot.response_revision, 'first-reader')).toBe(true)
    const first = getItem(human, id)!
    vi.setSystemTime(new Date(NOW.getTime() + 60_000))
    expect(markItemAnnotationDelivered(agent, id, snapshot.response_revision, 'second-reader')).toBe(true)
    expect(getItem(agent, id)).toEqual(first)
    expect(first).toMatchObject({
      annotation_seen_at: new Date(NOW.getTime() + 1000).toISOString(),
      annotation_seen_by: 'first-reader', updated_at: snapshot.updated_at,
      response_revision: snapshot.response_revision,
    })
  })

  it('does not stamp unrelated questions or board responses during targeted recovery', async () => {
    await connect()
    const noteId = item('note')
    const questionId = item('question')
    annotateItem(human, noteId, 'Target feedback')
    replyItem(human, questionId, 'Unrelated reply')
    annotateItem(human, questionId, 'Unrelated feedback')
    upsertBoard(human, {
      project: PROJECT, stream: 'topic', agent: 'test', title: 'Unrelated plan',
      rows: [{ label: 'Approval', status: 'blocked' }],
    })
    const row = getBoard(human, PROJECT, 'Unrelated plan')!.rows[0]!
    annotateBoardRow(human, row.id, 'Unrelated row response')
    const response = await call('pending', { item_id: noteId })
    expect(response.items.map((entry: { id: string }) => entry.id)).toEqual([noteId])
    expect(response.rows).toEqual([])
    expect(getItem(human, questionId)).toMatchObject({ reply_seen_at: null, annotation_seen_at: null })
    expect(getBoard(human, PROJECT, 'Unrelated plan')!.rows[0]!.annotation_seen_at).toBeNull()
  })

  it.each(['question', 'note', 'done'] as const)('drops a same-millisecond superseded %s annotation snapshot', async (kind) => {
    await connect()
    const id = item(kind)
    annotateItem(human, id, 'Proceed')
    const before = getItem(human, id)!
    const pending = await raceAnnotationPickup(() => annotateItem(human, id, 'Stop'))
    expect(pending.items.some((candidate: { id: string }) => candidate.id === id)).toBe(false)
    expect(getItem(human, id)).toMatchObject({
      annotation: 'Stop', annotated_at: before.annotated_at, annotation_seen_at: null,
    })
    expect(getItem(human, id)!.response_revision).toBeGreaterThan(before.response_revision)
    expect((await call('pending')).items.find((candidate: { id: string }) => candidate.id === id).annotation).toBe('Stop')
  })

  it('treats returning to the same words in one millisecond as a new response version', async () => {
    await connect()
    const id = item('note')
    annotateItem(human, id, 'Proceed')
    const before = getItem(human, id)!
    const pending = await raceAnnotationPickup(() => {
      annotateItem(human, id, 'Stop')
      annotateItem(human, id, 'Proceed')
    })
    expect(pending.items).toHaveLength(0)
    expect(getItem(human, id)!.response_revision).toBe(before.response_revision + 2)
    expect(getItem(human, id)!.annotation_seen_at).toBeNull()
  })

  it('delivers a clear as a recoverable versioned state, never the text cleared mid-poll', async () => {
    await connect()
    const id = item('done')
    annotateItem(human, id, 'Proceed')
    const first = await raceAnnotationPickup(() => annotateItem(human, id, ''))
    expect(first.items).toHaveLength(0)
    expect(getItem(human, id)!.annotation_seen_at).toBeNull()
    const cleared = (await call('pending')).items[0]
    expect(cleared).toMatchObject({ id, annotation: '', annotated_at: NOW.toISOString(), response_revision: 2 })
    expect((await call('pending')).items).toHaveLength(0)
    expect(await call('resolve', { id })).toEqual({ ok: false, reason: 'response_revision_required' })
    const recovered = (await call('pending', { item_id: id })).items[0]
    expect(recovered.annotation).toBe('')
    expect(await call('resolve', { id, expected_response_revision: recovered.response_revision })).toEqual({ ok: true })
  })

  it('retains open-question replies and annotation redelivery until resolution', async () => {
    await connect()
    const id = item('question')
    replyItem(human, id, 'Proceed', 'Keep the rollback.')
    annotateItem(human, id, HUMAN_TEXT)
    const first = await call('pending')
    expect(first.items[0]).toMatchObject({ id, reply: 'Proceed', reply_context: 'Keep the rollback.', annotation: HUMAN_TEXT })
    const after = getItem(human, id)!
    expect(after.reply_seen_at).not.toBeNull()
    expect(after.annotation_seen_at).not.toBeNull()
    vi.setSystemTime(new Date(NOW.getTime() + 10_000))
    expect((await call('pending')).items[0].annotation).toBe(HUMAN_TEXT)
    expect(getItem(human, id)).toEqual(after)
  })

  it('does not mark a question reply picked up when its annotation snapshot is withheld', async () => {
    await connect()
    const id = item('question')
    replyItem(human, id, 'Proceed')
    annotateItem(human, id, 'Original conditions')
    const pending = await raceAnnotationPickup(() => annotateItem(human, id, 'Corrected conditions'))
    expect(pending.items).toEqual([])
    expect(getItem(human, id)).toMatchObject({
      reply: 'Proceed', reply_seen_at: null,
      annotation: 'Corrected conditions', annotation_seen_at: null,
    })
    const delivered = (await call('pending')).items[0]
    expect(delivered).toMatchObject({ reply: 'Proceed', annotation: 'Corrected conditions' })
  })

  it('drops an informational snapshot when the item closes before pickup', async () => {
    await connect()
    const id = item('note')
    annotateItem(human, id, 'No longer current')
    const pending = await raceAnnotationPickup(() => { resolveItem(human, id) })
    expect(pending.items).toEqual([])
    expect(getItem(human, id)).toMatchObject({ status: 'resolved', annotation_seen_at: null })
  })

  it('rejects an old informational resolve even after another caller picked up the newer correction', async () => {
    await connect()
    const id = item('note')
    annotateItem(human, id, 'Proceed')
    const first = (await call('pending')).items[0]
    annotateItem(human, id, 'Stop')
    const sibling = (await call('pending')).items[0]
    expect((await call('pending')).items).toHaveLength(0)
    expect(await call('resolve', {
      id, expected_response_revision: first.response_revision, outcome: 'Stale completion.',
    })).toEqual({ ok: false, reason: 'response_changed' })
    expect(await call('resolve', { id })).toEqual({ ok: false, reason: 'response_revision_required' })
    expect(getItem(human, id)).toMatchObject({ status: 'open', annotation: 'Stop', outcome: '' })
    const recovered = (await call('pending', { item_id: id })).items[0]
    expect(recovered.response_revision).toBe(sibling.response_revision)
    expect(await call('resolve', {
      id, expected_response_revision: recovered.response_revision, outcome: 'Handled the correction.',
    })).toEqual({ ok: true })
  })

  it('keeps ordinary no-feedback note and milestone resolution compatible', async () => {
    await connect()
    for (const kind of ['note', 'done'] as const) {
      const id = item(kind)
      expect((await call('pending')).items).toHaveLength(0)
      expect(await call('resolve', { id })).toEqual({ ok: true })
    }
  })

  it('refuses an ordinary note resolution when feedback arrives inside its guarded write', async () => {
    await connect()
    const id = item('note')
    const prepare = agent.prepare.bind(agent)
    let injected = false
    agent.prepare = ((sql: string) => {
      const statement = prepare(sql)
      if (!injected && /SET status = 'resolved'/.test(sql)) {
        const run = statement.run.bind(statement)
        statement.run = ((...args: unknown[]) => {
          injected = true
          annotateItem(human, id, 'A new correction must be handled.')
          return run(...args)
        }) as typeof statement.run
      }
      return statement
    }) as typeof agent.prepare
    try {
      expect(await call('resolve', { id })).toEqual({ ok: false, reason: 'response_revision_required' })
      expect(injected).toBe(true)
      expect(getItem(human, id)).toMatchObject({ status: 'open', annotation_seen_at: null })
    } finally {
      agent.prepare = prepare
    }
    expect((await call('pending')).items[0].annotation).toBe('A new correction must be handled.')
  })

  it.each(['resolved', 'dismissed', 'missing'] as const)('refuses late annotation edits and clears on %s targets without rewriting history', async (target) => {
    const id = target === 'missing' ? 'absent' : item('note')
    if (target !== 'missing') annotateItem(human, id, 'Preserve this historical feedback.')
    if (target === 'resolved') resolveItem(agent, id, 'Finished.')
    if (target === 'dismissed') dismissItem(agent, id)
    const before = getItem(agent, id)
    for (const text of ['Late rewrite', '']) {
      expect(annotateItem(human, id, text)).toBe(false)
      const response = await annotateViaViewer(id, text)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: false })
      expect(getItem(agent, id)).toEqual(before)
    }
  })

  it('exposes saved and picked-up metadata through the unshaped viewer API', async () => {
    await connect()
    const id = item('note')
    const viewer = createViewer(human)
    annotateItem(human, id, HUMAN_TEXT)
    const before = await (await viewer.request('/api/items')).json()
    expect(before.notes[0].items[0]).toMatchObject({
      id, annotation: HUMAN_TEXT, annotated_at: NOW.toISOString(),
      annotation_seen_at: null, annotation_seen_by: null,
    })
    await call('pending')
    const after = await (await viewer.request('/api/items')).json()
    expect(after.notes[0].items[0]).toMatchObject({
      id, annotation: HUMAN_TEXT, context: CONTEXT,
      annotation_seen_at: NOW.toISOString(), annotation_seen_by: 'claude-code',
    })
    expect(after.needsYou).toEqual([])
  })

  it('makes late older-process annotation writes reset pickup and advance response identity', async () => {
    await connect()
    const id = item('note')
    annotateItem(human, id, 'Original feedback')
    await call('pending')
    const seen = getItem(human, id)!
    vi.setSystemTime(new Date(NOW.getTime() + 1000))
    // The older viewer only knows the original annotation/updated_at columns.
    human.prepare(`UPDATE items SET annotation = ?, updated_at = ? WHERE id = ?`)
      .run('Correction from an older viewer', new Date().toISOString(), id)
    const corrected = getItem(human, id)!
    expect(corrected).toMatchObject({
      annotation: 'Correction from an older viewer', annotated_at: new Date().toISOString(),
      annotation_seen_at: null, annotation_seen_by: null,
    })
    expect(corrected.response_revision).toBeGreaterThan(seen.response_revision)
    expect((await call('pending')).items[0].annotation).toBe(corrected.annotation)
  })

  it('also refuses an older writer attempting to rewrite a closed annotation', () => {
    const id = item('note')
    annotateItem(human, id, 'Historical feedback')
    resolveItem(agent, id, 'Finished.')
    const before = getItem(agent, id)
    const write = human.prepare(`UPDATE items SET annotation = ?, updated_at = ? WHERE id = ?`)
      .run('Late rewrite', new Date().toISOString(), id)
    expect(write.changes).toBe(0)
    expect(getItem(agent, id)).toEqual(before)
  })

  it('keeps hook and exact-question watch consumers question-only instead of treating feedback as an unanswered ask', async () => {
    const id = item('note')
    annotateItem(human, id, 'Informational feedback')
    expect(listPending(agent, PROJECT)).toEqual([])
    const hook = await runHook(['watch'], JSON.stringify({ cwd: process.cwd(), session_id: 'test-hook' }), {
      AGENT_INBOX_DB: path, AGENT_INBOX_WATCH_SECS: '0',
    })
    expect(hook).toEqual({ stdout: '' })
    expect(await waitForQuestionResponse(agent, id, { timeoutMs: 0 })).toBe('closed')
  })

  it('scopes targeted recovery to the requested project and never returns closed items', async () => {
    await connect()
    const id = item('note', 'other-project')
    annotateItem(human, id, 'Other project feedback')
    expect((await call('pending', { item_id: id })).items).toEqual([])
    expect((await call('pending', { item_id: id, project: 'other-project' })).items[0].id).toBe(id)
    resolveItem(human, id)
    expect((await call('pending', { item_id: id, project: 'other-project' })).items).toEqual([])
    expect((await call('pending', { item_id: 'absent' })).items).toEqual([])
  })

  it('migrates old annotations without inventing an edit time or pickup receipt', () => {
    const legacyPath = join(directory, 'legacy.db')
    const legacy = new Database(legacyPath)
    legacy.exec(`
      CREATE TABLE items (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, stream TEXT NOT NULL DEFAULT '',
        agent TEXT NOT NULL DEFAULT 'unknown', kind TEXT NOT NULL, title TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open',
        annotation TEXT, created_at TEXT NOT NULL, resolved_at TEXT,
        response_revision INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO items (id, project, kind, title, status, annotation, created_at, response_revision)
      VALUES
        ('old-open', 'legacy', 'note', 'Legacy note', 'open', 'Keep this feedback.', '2025-01-01T00:00:00.000Z', 0),
        ('old-closed', 'legacy', 'done', 'Legacy milestone', 'resolved', 'Historical text.', '2025-01-01T00:00:00.000Z', 0),
        ('old-cleared', 'legacy', 'note', 'Cleared feedback', 'open', '', '2025-01-01T00:00:00.000Z', 1);
    `)
    legacy.close()
    const migrated = openDb(legacyPath)
    try {
      expect(getItem(migrated, 'old-open')).toMatchObject({
        annotation: 'Keep this feedback.', annotated_at: null,
        annotation_seen_at: null, annotation_seen_by: null, response_revision: 1,
      })
      expect(listPending(migrated, 'legacy', { includeInformational: true }).map((entry) => entry.id)).toEqual(['old-open'])
      expect(getItem(migrated, 'old-closed')!.annotation).toBe('Historical text.')
      expect(resolveItem(migrated, 'old-cleared', undefined, {}))
        .toEqual({ ok: false, reason: 'response_revision_required' })
      const cleared = listPending(migrated, 'legacy', { includeInformational: true, itemId: 'old-cleared' })[0]!
      expect(cleared).toMatchObject({ annotation: '', response_revision: 1, annotated_at: null })
      expect(resolveItem(migrated, cleared.id, undefined, { expectedRevision: cleared.response_revision }))
        .toEqual({ ok: true })
      expect(markItemAnnotationDelivered(migrated, 'old-open', 1, 'reader')).toBe(true)
      const beforeReopen = getItem(migrated, 'old-open')
      const reopened = openDb(legacyPath)
      try {
        expect(getItem(reopened, 'old-open')).toEqual(beforeReopen)
        expect(listPending(reopened, 'legacy', { includeInformational: true })).toEqual([])
      } finally {
        reopened.close()
      }
    } finally {
      migrated.close()
    }
  })
})
