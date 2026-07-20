import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { openDb, listItems, listBoards, getBoard, annotateBoardRow, replyItem } from '../src/store.js'

describe('mcp round-trip', () => {
  it('flag writes a row attributed to this session, and whoami reflects register', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mcp-')), 'inbox.db')
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', 'src/mcp-server.ts'],
      env: { ...process.env, AGENT_INBOX_DB: dbPath },
    })
    const client = new Client({ name: 'claude-code', version: '1.0.0' })
    await client.connect(transport)

    const flagRes = await client.callTool({ name: 'flag', arguments: { kind: 'question', title: 'which storage?' } })
    const { id } = JSON.parse((flagRes.content as Array<{ text: string }>)[0]!.text)
    expect(id).toBeTruthy()

    // kind=done milestone round-trips too
    const doneRes = await client.callTool({ name: 'flag', arguments: { kind: 'done', title: 'shipped v2' } })
    expect(JSON.parse((doneRes.content as Array<{ text: string }>)[0]!.text).id).toBeTruthy()

    const who = await client.callTool({ name: 'register', arguments: { project: 'overridden' } })
    expect(JSON.parse((who.content as Array<{ text: string }>)[0]!.text).project).toBe('overridden')

    await client.close()

    const db = openDb(dbPath)
    const items = listItems(db)
    expect(items).toHaveLength(2)
    const q = items.find((i) => i.kind === 'question')!
    expect(q.title).toBe('which storage?')
    expect(q.agent).toBe('claude-code')
    const d = items.find((i) => i.kind === 'done')!
    expect(d.title).toBe('shipped v2')
    expect(d.status).toBe('open')
  })

  it('flag accepts options; pending returns the human reply and stamps pickup', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mcp-pending-')), 'inbox.db')
    const conn = async () => {
      const t = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/mcp-server.ts'], env: { ...process.env, AGENT_INBOX_DB: dbPath } })
      const c = new Client({ name: 'claude-code', version: '1.0.0' }); await c.connect(t); return c
    }
    const c1 = await conn()
    const flagRes = await c1.callTool({ name: 'flag', arguments: {
      kind: 'question', title: 'flags or branch?',
      context: 'Mid-rollout of the checkout revamp; hit this at the deploy step. See PR #42.',
      options: [{ label: 'flags', detail: 'safer rollback', recommended: true }, { label: 'branch' }],
    } })
    const { id } = JSON.parse((flagRes.content as Array<{ text: string }>)[0]!.text)

    // no reply yet — pending shows the open question unanswered
    const p1 = await c1.callTool({ name: 'pending', arguments: {} })
    const items1 = JSON.parse((p1.content as Array<{ text: string }>)[0]!.text).items
    expect(items1).toHaveLength(1)
    expect(items1[0].reply).toBeNull()
    expect(items1[0].options[0].label).toBe('flags')
    expect(items1[0].context).toMatch(/checkout revamp/)

    // human answers (viewer path)
    replyItem(openDb(dbPath), id, 'flags — but canary first')

    const p2 = await c1.callTool({ name: 'pending', arguments: {} })
    const items2 = JSON.parse((p2.content as Array<{ text: string }>)[0]!.text).items
    expect(items2[0].reply).toBe('flags — but canary first')
    await c1.close()
    expect(listItems(openDb(dbPath))[0]!.reply_seen_at).toMatch(/^\d{4}-\d{2}-\d{2}T/) // pickup stamped
  }, 20000)

  it('board tools upsert, update a row, and archive a board', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mcp-board-')), 'inbox.db')
    const transport = new StdioClientTransport({
      command: 'npx', args: ['tsx', 'src/mcp-server.ts'], env: { ...process.env, AGENT_INBOX_DB: dbPath },
    })
    const client = new Client({ name: 'claude-code', version: '1.0.0' })
    await client.connect(transport)

    const up = await client.callTool({ name: 'board_upsert', arguments: {
      title: 'coverage',
      rows: [{ label: 'theme', status: 'done', note: 'both modes', context: 'landed across three PRs' }, { label: 'stems', status: 'partial' }],
    } })
    const upOut = JSON.parse((up.content as Array<{ text: string }>)[0]!.text)
    expect(upOut.rowCount).toBe(2)

    await client.callTool({ name: 'board_row', arguments: { title: 'coverage', label: 'stems', status: 'partial', context: 'the long story' } })
    await client.close()

    const db = openDb(dbPath)
    const board = listBoards(db)[0]!
    expect(board.title).toBe('coverage')
    expect(board.rows.find((r) => r.label === 'theme')!.context).toBe('landed across three PRs')
    expect(board.rows.find((r) => r.label === 'stems')!.status).toBe('partial')
    expect(board.rows.find((r) => r.label === 'stems')!.context).toBe('the long story')

    // archive via a second short-lived client (same db path)
    const t2 = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/mcp-server.ts'], env: { ...process.env, AGENT_INBOX_DB: dbPath } })
    const c2 = new Client({ name: 'claude-code', version: '1.0.0' })
    await c2.connect(t2)
    const arch = await c2.callTool({ name: 'board_archive', arguments: { title: 'coverage' } })
    expect(JSON.parse((arch.content as Array<{ text: string }>)[0]!.text).ok).toBe(true)
    await c2.close()

    expect(listBoards(openDb(dbPath))).toHaveLength(0) // archived → not in active list
  }, 20000)

  it('board_get reads a board back including a human annotation', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mcp-get-')), 'inbox.db')
    const conn = async () => {
      const t = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/mcp-server.ts'], env: { ...process.env, AGENT_INBOX_DB: dbPath } })
      const c = new Client({ name: 'claude-code', version: '1.0.0' }); await c.connect(t); return c
    }
    const c1 = await conn()
    await c1.callTool({ name: 'board_upsert', arguments: { title: 'cov', rows: [{ label: 'x', status: 'missing' }] } })
    await c1.close()

    // Read the stored project (inference-derived), then annotate the row via the store (viewer path)
    const project = listBoards(openDb(dbPath))[0]!.project
    const rowId = getBoard(openDb(dbPath), project, 'cov')!.rows[0]!.id
    annotateBoardRow(openDb(dbPath), rowId, 'human note')

    const c2 = await conn()
    const got = await c2.callTool({ name: 'board_get', arguments: { title: 'cov' } })
    const board = JSON.parse((got.content as Array<{ text: string }>)[0]!.text)
    expect(board.rows[0].annotation).toBe('human note')
    expect(board.rows[0].annotation_unseen).toBe(true) // first read since the annotation

    // reading marks the board read, so a second read sees nothing new
    const again = await c2.callTool({ name: 'board_get', arguments: { title: 'cov' } })
    await c2.close()
    const board2 = JSON.parse((again.content as Array<{ text: string }>)[0]!.text)
    expect(board2.rows[0].annotation_unseen).toBe(false)
  }, 20000)
})
