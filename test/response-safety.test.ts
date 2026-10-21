import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { EventEmitter } from 'node:events'
import type Database from 'better-sqlite3'
import {
  annotateBoardRow, annotateItem, dismissItem, getBoard, getItem,
  insertItem, markReplySeen, markRowHandled, openDb, replyItem, resolveItem,
  upsertBoard,
} from '../src/store.js'
import { buildMcpServer } from '../src/mcp.js'
import { createViewer } from '../src/viewer.js'
import replyWatch from '../electron/reply-watch.cjs'
import { scratchDir } from './scratch.js'

const NOW = new Date('2026-09-20T12:00:00.000Z')
const PROJECT = 'response-safety'
const APPROVAL = {
  kind: 'question',
  title: 'Proceed?',
  detail: 'The work needs approval.',
  next_step: 'Choose whether to proceed.',
  action_owner: 'approval',
  impact: 'Determines the next action.',
  options: [{ label: 'Proceed' }, { label: 'Stop' }],
}

describe('response lifecycle safety', () => {
  let directory: string
  let agent: Database.Database
  let human: Database.Database
  let server: McpServer | undefined
  let client: Client | undefined
  let removeListeners: Array<() => void>

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    directory = scratchDir('response-safety-')
    const path = join(directory, 'inbox.db')
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

  const item = (kind: 'question' | 'note' | 'done' = 'question') =>
    insertItem(agent, { project: PROJECT, stream: '', agent: 'test', kind, title: kind })

  async function connect() {
    const events: EventEmitter = process
    for (const signal of ['exit', 'SIGHUP', 'SIGINT', 'SIGTERM'] as const) {
      const before = events.listeners(signal)
      removeListeners.push(() => {
        for (const listener of events.listeners(signal)) {
          if (!before.includes(listener)) events.removeListener(signal, listener as (...args: unknown[]) => void)
        }
      })
    }
    server = buildMcpServer(agent, process.cwd())
    client = new Client({ name: 'claude-code', version: 'test' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    await call('register', { project: PROJECT, stream: '', repo: 'test/example' })
  }

  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client!.callTool({ name, arguments: args })
    expect(result.isError, JSON.stringify(result)).not.toBe(true)
    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text)
  }

  // The real write on the second connection lands after the MCP snapshot but
  // immediately before its conditioned write; the store itself is never mocked.
  async function race(statement: RegExp, write: () => void, read: () => Promise<unknown>) {
    const prepare = agent.prepare.bind(agent)
    let injected = false
    agent.prepare = ((sql: string) => {
      const query = prepare(sql)
      if (statement.test(sql)) {
        const run = query.run.bind(query)
        query.run = ((...args: unknown[]) => {
          if (!injected) {
            injected = true
            write()
          }
          return run(...args)
        }) as typeof query.run
      }
      return query
    }) as typeof agent.prepare
    try {
      const result = await read()
      expect(injected).toBe(true)
      return result
    } finally {
      agent.prepare = prepare
    }
  }

  it.each(['resolved', 'dismissed', 'note', 'done', 'missing'] as const)(
    'refuses corrections and clears against %s items without changing history',
    (target) => {
      const id = target === 'missing' ? 'absent'
        : item(target === 'note' || target === 'done' ? target : 'question')
      if (target === 'resolved' || target === 'dismissed') {
        replyItem(agent, id, 'Original approval', 'Original context')
        if (target === 'resolved') resolveItem(agent, id, 'Already completed.')
        else dismissItem(agent, id)
      }
      const before = getItem(agent, id)
      for (const text of ['Late correction', '']) {
        expect(replyItem(human, id, text)).toBe(false)
        expect(replyItem(human, id, text, undefined, 'answer', {
          clientId: 'window', sequence: text ? 1 : 2, actionId: text || 'clear',
        })).toBe(false)
        expect(getItem(agent, id)).toEqual(before)
      }
    },
  )

  it('refuses a previously successful reply-intent retry once its question is closed', () => {
    const id = item()
    const intent = { clientId: 'window', sequence: 1, actionId: 'original' }
    expect(replyItem(human, id, 'Proceed', undefined, 'answer', intent)).toBe(true)
    expect(replyItem(human, id, 'Proceed', undefined, 'answer', intent)).toBe(true)
    resolveItem(agent, id, 'Completed.')
    const before = getItem(agent, id)
    expect(replyItem(human, id, 'Proceed', undefined, 'answer', intent)).toBe(false)
    expect(getItem(agent, id)).toEqual(before)
  })

  it('uses the existing native refusal path for a closed notification target', async () => {
    const viewer = createViewer(human)
    const fetch = async (url: string, init: RequestInit) => viewer.request(url, init)
    const id = item()
    const target = { source: 'item' as const, id }
    await expect(replyWatch.submitNotificationResponse(
      'http://127.0.0.1:4319/', target, 'Proceed', fetch,
    )).resolves.toBeUndefined()
    resolveItem(agent, id, 'Completed.')
    const before = getItem(agent, id)
    await expect(replyWatch.submitNotificationResponse(
      'http://127.0.0.1:4319/', target, 'Cancel instead', fetch,
    )).rejects.toThrow('notification reply was refused')
    expect(getItem(agent, id)).toEqual(before)
  })

  it.each(['resolved', 'dismissed', 'note', 'done', 'missing'] as const)(
    'the viewer refuses a stale %s reply and clear',
    async (target) => {
      const viewer = createViewer(human)
      const id = target === 'missing' ? 'absent'
        : item(target === 'note' || target === 'done' ? target : 'question')
      if (target === 'resolved') resolveItem(agent, id)
      if (target === 'dismissed') dismissItem(agent, id)
      const before = getItem(agent, id)
      for (const text of ['Correction', '']) {
        const response = await viewer.request(`/api/items/${id}/reply`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: false })
        expect(getItem(agent, id)).toEqual(before)
      }
    },
  )

  it.each(['changed answer', 'changed context', 'same answer after another correction'] as const)(
    'pending drops a superseded item snapshot with a same-millisecond %s',
    async (change) => {
      await connect()
      const { id } = await call('flag', APPROVAL)
      replyItem(human, id, 'Proceed', 'Old context')
      const before = getItem(human, id)!
      let first: { items: Array<{ id: string }> } | undefined
      await race(/UPDATE items SET reply_seen_at/, () => {
        replyItem(human, id, change === 'changed context' ? 'Proceed' : 'Stop', 'New context')
        if (change === 'same answer after another correction') replyItem(human, id, 'Proceed', 'Old context')
      }, async () => { first = await call('pending') })
      expect(getItem(human, id)!.replied_at).toBe(before.replied_at)
      expect(first!.items.some((candidate) => candidate.id === id)).toBe(false)
      expect(getItem(human, id)!.reply_seen_at).toBeNull()
      const next = (await call('pending')).items.find((candidate: { id: string }) => candidate.id === id)
      expect(next.reply).toBe(getItem(human, id)!.reply)
      expect(next.response_revision).toBeGreaterThan(before.response_revision)
    },
  )

  it('retains same-version sibling pickup and repeated delivery without moving the receipt age', async () => {
    await connect()
    const { id } = await call('flag', APPROVAL)
    replyItem(human, id, 'Proceed')
    const before = getItem(human, id)!
    let first: { items: Array<{ id: string; reply: string }> } | undefined
    await race(/UPDATE items SET reply_seen_at/, () => {
      expect(markReplySeen(human, id, before.replied_at)).toBe(true)
    }, async () => { first = await call('pending') })
    expect(first!.items.find((candidate) => candidate.id === id)!.reply).toBe('Proceed')
    const pickedUp = getItem(human, id)!
    vi.setSystemTime(new Date(NOW.getTime() + 60_000))
    expect((await call('pending')).items.find((candidate: { id: string }) => candidate.id === id).reply).toBe('Proceed')
    expect(getItem(human, id)).toMatchObject({
      reply_seen_at: pickedUp.reply_seen_at,
      updated_at: before.updated_at,
      response_revision: before.response_revision,
    })
  })

  it('revalidates an already-delivered item before handing it over again', async () => {
    await connect()
    const { id } = await call('flag', APPROVAL)
    replyItem(human, id, 'Proceed')
    await call('pending')
    expect(getItem(human, id)!.reply_seen_at).not.toBeNull()
    let next: { items: unknown[] } | undefined
    await race(/UPDATE items SET reply_seen_at/, () => {
      replyItem(human, id, 'Stop', undefined, 'decline')
    }, async () => { next = await call('pending') })
    expect(next!.items).toHaveLength(0)
    expect(getItem(human, id)).toMatchObject({ reply: 'Stop', reply_seen_at: null })
  })

  it.each([true, false])('board_get (titled=%s) retries a superseded same-millisecond annotation without omitting rows', async (titled) => {
    await connect()
    upsertBoard(human, {
      project: PROJECT, stream: '', agent: 'test', title: 'Approval',
      rows: [{ label: 'Choice', status: 'blocked' }, { label: 'Keep me', status: 'tracked' }],
    })
    let board = getBoard(human, PROJECT, 'Approval')!
    const rowId = board.rows[0]!.id
    annotateBoardRow(human, rowId, 'Proceed')
    const before = getBoard(human, PROJECT, 'Approval')!.rows[0]!
    let result: Record<string, any> | undefined
    await race(/UPDATE board_rows SET annotation_seen_at/, () => {
      board = getBoard(human, PROJECT, 'Approval')!
      annotateBoardRow(human, rowId, 'Stop', 'decline', board.rows[0]!.revision, board.revision)
    }, async () => { result = await call('board_get', titled ? { title: 'Approval' } : {}) })
    const returned = titled ? result : result!.boards[0]
    expect(returned.rows).toHaveLength(2)
    expect(returned.rows[0].annotation).toBe('Stop')
    expect(getBoard(human, PROJECT, 'Approval')!.rows[0]!.annotated_at).toBe(before.annotated_at)
  })

  it('pending drops a handled mark replaced in the same millisecond', async () => {
    await connect()
    upsertBoard(human, {
      project: PROJECT, stream: '', agent: 'test', title: 'Task',
      rows: [{ label: 'Upload', status: 'blocked' }],
    })
    const rowId = getBoard(human, PROJECT, 'Task')!.rows[0]!.id
    markRowHandled(human, rowId)
    let first: { rows: unknown[] } | undefined
    await race(/UPDATE board_rows SET handled_seen_at/, () => {
      markRowHandled(human, rowId)
    }, async () => { first = await call('pending') })
    expect(first!.rows).toHaveLength(0)
    expect(getBoard(human, PROJECT, 'Task')!.rows[0]!.handled_seen_at).toBeNull()
    expect((await call('pending')).rows[0].row_id).toBe(rowId)
  })

  it('revalidates an already-delivered board annotation before returning another snapshot', async () => {
    await connect()
    upsertBoard(human, {
      project: PROJECT, stream: '', agent: 'test', title: 'Previously read',
      rows: [{ label: 'Choice', status: 'blocked' }],
    })
    const rowId = getBoard(human, PROJECT, 'Previously read')!.rows[0]!.id
    annotateBoardRow(human, rowId, 'Proceed')
    await call('board_get', { title: 'Previously read' })
    expect(getBoard(human, PROJECT, 'Previously read')!.rows[0]!.annotation_seen_at).not.toBeNull()
    let next: Record<string, any> | undefined
    await race(/UPDATE board_rows SET annotation_seen_at/, () => {
      annotateBoardRow(human, rowId, 'Stop', 'decline')
    }, async () => { next = await call('board_get', { title: 'Previously read' }) })
    expect(next!.rows[0].annotation).toBe('Stop')
  })

  it('bounds board snapshot retries and never returns a partial board during continuing corrections', async () => {
    await connect()
    upsertBoard(human, {
      project: PROJECT, stream: '', agent: 'test', title: 'Changing',
      rows: [{ label: 'Choice', status: 'blocked' }, { label: 'Keep me', status: 'tracked' }],
    })
    const rowId = getBoard(human, PROJECT, 'Changing')!.rows[0]!.id
    annotateBoardRow(human, rowId, 'Proceed')
    const prepare = agent.prepare.bind(agent)
    let attempts = 0
    agent.prepare = ((sql: string) => {
      const statement = prepare(sql)
      if (/UPDATE board_rows SET annotation_seen_at/.test(sql)) {
        const run = statement.run.bind(statement)
        statement.run = ((...args: unknown[]) => {
          annotateBoardRow(human, rowId, `Correction ${++attempts}`)
          return run(...args)
        }) as typeof statement.run
      }
      return statement
    }) as typeof agent.prepare
    try {
      const result = await client!.callTool({ name: 'board_get', arguments: { title: 'Changing' } })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('retry board_get')
      expect(JSON.stringify(result.content)).not.toContain('Proceed')
      expect(attempts).toBe(2)
      expect(getBoard(human, PROJECT, 'Changing')!.rows).toHaveLength(2)
    } finally {
      agent.prepare = prepare
    }
  })

  it('requires the caller’s exact response revision even after a sibling reads the newer correction', async () => {
    await connect()
    const { id } = await call('flag', APPROVAL)
    replyItem(human, id, 'Proceed')
    const first = (await call('pending')).items[0]
    replyItem(human, id, 'Stop', undefined, 'decline')
    const sibling = (await call('pending')).items[0]
    expect(sibling.response_revision).toBeGreaterThan(first.response_revision)
    expect(await call('resolve', {
      id, expected_response_revision: first.response_revision, outcome: 'Stale completion.',
    })).toEqual({ ok: false, reason: 'response_changed' })
    expect(await call('resolve', { id })).toEqual({ ok: false, reason: 'response_revision_required' })
    expect(getItem(human, id)).toMatchObject({ status: 'open', reply: 'Stop', outcome: '' })
    expect(await call('resolve', {
      id, expected_response_revision: sibling.response_revision, outcome: 'Stopped as requested.',
    })).toEqual({ ok: true })
  })

  it('refuses a correction arriving inside the resolution write', async () => {
    await connect()
    const { id } = await call('flag', APPROVAL)
    replyItem(human, id, 'Proceed')
    const read = (await call('pending')).items[0]
    let result: unknown
    await race(/SET status = 'resolved'/, () => {
      replyItem(human, id, 'Stop', undefined, 'decline')
    }, async () => {
      result = await call('resolve', { id, expected_response_revision: read.response_revision })
    })
    expect(result).toEqual({ ok: false, reason: 'response_changed' })
    expect(getItem(human, id)).toMatchObject({ status: 'open', reply: 'Stop', reply_seen_at: null })
  })

  it('pins annotations and cleared responses too, while retaining ordinary no-response resolution', async () => {
    await connect()
    const { id } = await call('flag', APPROVAL)
    expect(await call('resolve', { id, outcome: 'The question became moot.' })).toEqual({ ok: true })
    const note = await call('flag', { kind: 'note', title: 'FYI', detail: 'No action.', next_step: 'No action' })
    expect(await call('resolve', { id: note.id })).toEqual({ ok: true })

    const annotated = await call('flag', APPROVAL)
    const original = (await call('pending')).items.find((candidate: { id: string }) => candidate.id === annotated.id)
    annotateItem(human, annotated.id, 'Please stop.')
    expect(await call('resolve', {
      id: annotated.id, expected_response_revision: original.response_revision,
    })).toEqual({ ok: false, reason: 'response_changed' })
    const corrected = (await call('pending')).items.find((candidate: { id: string }) => candidate.id === annotated.id)
    expect(corrected.annotation).toBe('Please stop.')
    expect(await call('resolve', {
      id: annotated.id, expected_response_revision: corrected.response_revision,
    })).toEqual({ ok: true })

    const cleared = await call('flag', APPROVAL)
    replyItem(human, cleared.id, 'Proceed')
    expect(replyItem(human, cleared.id, '')).toBe(true)
    expect(await call('resolve', { id: cleared.id })).toEqual({ ok: false, reason: 'response_revision_required' })
  })

  it('returns the atomically written chat-answer revision for explicit resolution', async () => {
    await connect()
    const { id } = await call('flag', APPROVAL)
    const answer = await call('answer', { id, text: 'Proceed' })
    expect(answer).toMatchObject({ ok: true, response_revision: 1 })
    expect(answer.response_revision).toBe(getItem(human, id)!.response_revision)
    expect(await call('resolve', { id, expected_response_revision: answer.response_revision })).toEqual({ ok: true })
  })
})
