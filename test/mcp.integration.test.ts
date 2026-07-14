import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { openDb, listItems, listBoards, getBoard, annotateBoardRow } from '../src/store.js'

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

    const who = await client.callTool({ name: 'register', arguments: { project: 'overridden' } })
    expect(JSON.parse((who.content as Array<{ text: string }>)[0]!.text).project).toBe('overridden')

    await client.close()

    const db = openDb(dbPath)
    const items = listItems(db)
    expect(items).toHaveLength(1)
    expect(items[0]!.title).toBe('which storage?')
    expect(items[0]!.agent).toBe('claude-code')
    expect(items[0]!.kind).toBe('question')
  })

  it('board tools upsert, update a row, and archive a board', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mcp-board-')), 'inbox.db')
    const transport = new StdioClientTransport({
      command: 'npx', args: ['tsx', 'src/mcp-server.ts'], env: { ...process.env, AGENT_INBOX_DB: dbPath },
    })
    const client = new Client({ name: 'claude-code', version: '1.0.0' })
    await client.connect(transport)

    const up = await client.callTool({ name: 'board_upsert', arguments: {
      title: 'coverage',
      rows: [{ label: 'theme', status: 'done', note: 'both modes' }, { label: 'stems', status: 'partial' }],
    } })
    const upOut = JSON.parse((up.content as Array<{ text: string }>)[0]!.text)
    expect(upOut.rowCount).toBe(2)

    await client.callTool({ name: 'board_row', arguments: { title: 'coverage', label: 'stems', status: 'done' } })
    await client.close()

    const db = openDb(dbPath)
    const board = listBoards(db)[0]!
    expect(board.title).toBe('coverage')
    expect(board.rows.find((r) => r.label === 'stems')!.status).toBe('done')

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
    await c2.close()
    const board = JSON.parse((got.content as Array<{ text: string }>)[0]!.text)
    expect(board.rows[0].annotation).toBe('human note')
  }, 20000)
})
