import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { openDb, listItems } from '../src/store.js'

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
})
