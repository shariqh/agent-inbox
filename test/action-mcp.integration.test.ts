import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  annotateBoardRow,
  getBoard,
  listBoards,
  listItems,
  openDb,
  replyItem,
} from '../src/store.js'

async function connection(dbPath: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/mcp-server.ts'],
    env: { ...process.env, AGENT_INBOX_DB: dbPath },
  })
  const client = new Client({ name: 'claude-code', version: '1.0.0' })
  await client.connect(transport)
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args })
  return {
    result,
    body: JSON.parse((result.content as Array<{ text: string }>)[0]!.text),
  }
}

describe('MCP action lifecycle contract', () => {
  it('exposes ownership/impact fields and enforces decision-vs-task option shapes', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mcp-action-contract-')), 'inbox.db')
    const client = await connection(dbPath)
    const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]))

    const flag = tools.get('flag')!
    const flagSchema = flag.inputSchema as unknown as {
      properties: Record<string, { description?: string; enum?: string[] }>
    }
    expect(flagSchema.properties['action_owner']?.enum).toEqual(['decision', 'task', 'approval'])
    expect(flagSchema.properties['impact']?.description).toMatch(/why/i)
    expect(flagSchema.properties['next_after']?.description).toMatch(/after/i)

    const missing = await client.callTool({
      name: 'flag',
      arguments: {
        kind: 'question',
        title: 'Merge?',
        detail: 'All gates are green.',
        next_step: 'Choose whether to merge.',
      },
    })
    expect(missing.isError).toBe(true)

    const taskWithOptions = await client.callTool({
      name: 'flag',
      arguments: {
        kind: 'question',
        title: 'Upload the build',
        detail: 'The artifact is ready.',
        next_step: 'Upload the build.',
        action_owner: 'task',
        impact: 'Required for release.',
        options: [{ label: 'Do it' }, { label: 'Hold' }],
      },
    })
    expect(taskWithOptions.isError).toBe(true)

    const duplicateRows = await client.callTool({
      name: 'board_upsert',
      arguments: {
        title: 'Duplicates',
        rows: [
          { label: 'Same', status: 'tracked' },
          { label: 'Same', status: 'partial' },
        ],
      },
    })
    expect(duplicateRows.isError).toBe(true)

    const approval = await call(client, 'flag', {
      kind: 'question',
      title: 'Merge PR #42?',
      detail: 'All gates are green.',
      next_step: 'Choose whether to merge.',
      action_owner: 'approval',
      impact: 'Unblocks implementation.',
      next_after: 'The agent dispatches implementation.',
      options: [{ label: 'Merge', recommended: true }, { label: 'Hold' }],
    })
    expect(approval.result.isError).not.toBe(true)
    expect(listItems(openDb(dbPath))[0]).toMatchObject({
      action_owner: 'approval',
      impact: 'Unblocks implementation.',
      next_after: 'The agent dispatches implementation.',
    })
    await client.close()
  }, 20000)

  it('carries response kinds, outcomes, and atomic row advancement end to end', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mcp-action-flow-')), 'inbox.db')
    const client = await connection(dbPath)

    await call(client, 'board_upsert', {
      title: 'Launch',
      rows: [{
        label: 'Outreach',
        status: 'blocked',
        note: 'The kit is ready.',
        next_step: 'Choose the tracker.',
        action_owner: 'decision',
        impact: 'Required before outreach starts.',
        next_after: 'Send the first three messages.',
        options: [{ label: 'People Pipeline', recommended: true }, { label: 'Scratchpad' }],
      }],
    })
    const board = listBoards(openDb(dbPath))[0]!
    const row = board.rows[0]!
    annotateBoardRow(openDb(dbPath), row.id, 'Please clarify which Notion database.', 'clarify')

    const pending = (await call(client, 'pending', {})).body
    expect(pending.rows[0]).toMatchObject({
      annotation_kind: 'clarify',
      action_owner: 'decision',
      impact: 'Required before outreach starts.',
      action_version: 1,
      revision: 2,
    })

    const advanced = await call(client, 'board_advance', {
      title: 'Launch',
      label: 'Outreach',
      board_version: pending.rows[0].board_revision,
      expected_revision: pending.rows[0].revision,
      note: 'Use the existing People Pipeline database.',
      next_step: 'Send the first three personalized messages.',
      action_owner: 'task',
      impact: 'Starts the design-partner evidence loop.',
      next_after: 'Review replies and schedule interviews.',
    })
    expect(advanced.body).toEqual({ ok: true, action_version: 2, revision: 3 })
    const advancedBoard = getBoard(openDb(dbPath), board.project, 'Launch')!
    const next = advancedBoard.rows[0]!
    expect(next).toMatchObject({
      action_version: 2,
      action_owner: 'task',
      annotation: null,
      annotation_kind: null,
    })
    expect(next.history).toHaveLength(1)

    const staleRow = await client.callTool({
      name: 'board_row',
      arguments: {
        title: 'Launch',
        board_version: advancedBoard.revision,
        label: 'Outreach',
        expected_revision: 1,
        status: 'done',
        outcome: 'Stale completion.',
      },
    })
    expect(staleRow.isError).toBe(true)
    const staleUpsert = await client.callTool({
      name: 'board_upsert',
      arguments: {
        title: 'Launch',
        board_version: advancedBoard.revision,
        rows: [{
          label: 'Outreach',
          revision: 1,
          status: 'blocked',
          note: 'Stale action.',
          next_step: 'Do the old thing.',
          action_owner: 'task',
          impact: 'Wrong.',
        }],
      },
    })
    expect(staleUpsert.isError).toBe(true)
    expect(getBoard(openDb(dbPath), board.project, 'Launch')!.rows[0]!.note)
      .toBe('Use the existing People Pipeline database.')

    const addQa = await client.callTool({
      name: 'board_row',
      arguments: {
        title: 'Launch',
        board_version: advancedBoard.revision,
        label: 'QA',
        status: 'tracked',
        note: 'Verify the first batch.',
      },
    })
    expect(addQa.isError).not.toBe(true)
    const staleDeletion = await client.callTool({
      name: 'board_upsert',
      arguments: {
        title: 'Launch',
        board_version: advancedBoard.revision,
        rows: [{
          label: 'Outreach',
          revision: next.revision,
          status: 'blocked',
          note: next.note,
          next_step: next.next_step,
          action_owner: next.action_owner,
          impact: next.impact,
        }],
      },
    })
    expect(staleDeletion.isError).toBe(true)
    expect(getBoard(openDb(dbPath), board.project, 'Launch')!.rows.map((row) => row.label))
      .toContain('QA')

    const currentBoard = getBoard(openDb(dbPath), board.project, 'Launch')!
    const clearChoices = await client.callTool({
      name: 'board_row',
      arguments: {
        title: 'Launch',
        board_version: currentBoard.revision,
        label: 'Outreach',
        expected_revision: currentBoard.rows[0]!.revision,
        action_owner: 'task',
        options: [],
      },
    })
    expect(clearChoices.isError).not.toBe(true)
    expect(getBoard(openDb(dbPath), board.project, 'Launch')!.rows[0]!.options).toBeNull()

    const item = await call(client, 'flag', {
      kind: 'question',
      title: 'Ship?',
      detail: 'The build is green.',
      next_step: 'Choose whether to ship.',
      action_owner: 'approval',
      impact: 'Publishes the release.',
      options: [{ label: 'Ship', recommended: true }, { label: 'Hold' }],
    })
    replyItem(openDb(dbPath), item.body.id, 'Ship', undefined, 'answer')
    await call(client, 'pending', {})
    await call(client, 'resolve', { id: item.body.id, outcome: 'Release shipped successfully.' })
    expect(listItems(openDb(dbPath)).find((candidate) => candidate.id === item.body.id)).toMatchObject({
      status: 'resolved',
      outcome: 'Release shipped successfully.',
    })
    await client.close()
  }, 25000)

  it('reads an archived board by title so agents can obtain current CAS revisions', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mcp-archived-read-')), 'inbox.db')
    const client = await connection(dbPath)
    await call(client, 'board_upsert', {
      title: 'Completed rollout',
      rows: [{ label: 'Ship', status: 'done' }],
    })
    const read = await call(client, 'board_get', { title: 'Completed rollout' })
    expect(read.body).toMatchObject({ title: 'Completed rollout', status: 'archived', revision: 1 })
    expect(read.body.rows[0]).toMatchObject({ label: 'Ship', revision: 1 })
    await client.close()
  }, 20000)
})
