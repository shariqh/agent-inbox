import { describe, expect, it } from 'vitest'
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
  upsertBoard,
} from '../src/store.js'
import { scratchDir } from './scratch.js'

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
    const dbPath = join(scratchDir('mcp-action-contract-'), 'inbox.db')
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
    const dbPath = join(scratchDir('mcp-action-flow-'), 'inbox.db')
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
    const answered = (await call(client, 'pending', {})).body.items
      .find((candidate: { id: string }) => candidate.id === item.body.id)
    await call(client, 'resolve', {
      id: item.body.id,
      expected_response_revision: answered.response_revision,
      outcome: 'Release shipped successfully.',
    })
    expect(listItems(openDb(dbPath)).find((candidate) => candidate.id === item.body.id)).toMatchObject({
      status: 'resolved',
      outcome: 'Release shipped successfully.',
    })
    await client.close()
  }, 25000)

  it('reads an archived board by title so agents can obtain current CAS revisions', async () => {
    const dbPath = join(scratchDir('mcp-archived-read-'), 'inbox.db')
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

  // Issue #159 — board_get, board_row and board_upsert each name ONE board, yet
  // an archived or brand-new title used to load and parse every archived board
  // in EVERY project. The other projects' archived boards below hold a row whose
  // history is not JSON: a tripwire no store write can produce, so any path that
  // still loads them fails loudly here instead of merely slowly in production.
  it('resolves archived and new titles exactly as before without loading other projects’ archived boards', async () => {
    const dbPath = join(scratchDir('mcp-archived-titles-'), 'inbox.db')
    const store = openDb(dbPath)
    for (const project of ['decoy-a', 'decoy-b']) {
      const { boardId } = upsertBoard(store, {
        project, stream: '', agent: 'test', title: 'Completed rollout', rows: [{ label: 'Ship', status: 'done' }],
      })
      store.prepare(`UPDATE board_rows SET history = 'tripwire: not JSON' WHERE board_id = ?`).run(boardId)
    }
    const text = (result: Awaited<ReturnType<Client['callTool']>>) =>
      (result.content as Array<{ text: string }>)[0]!.text
    const client = await connection(dbPath)
    await call(client, 'register', { project: 'home' })

    const created = await client.callTool({
      name: 'board_upsert',
      arguments: { title: 'Completed rollout', rows: [{ label: 'Ship', status: 'done' }] },
    })
    expect(created.isError, text(created)).not.toBe(true)
    expect((await call(client, 'board_get', { title: 'Never written' })).body).toEqual({ found: false })
    const read = await call(client, 'board_get', { title: 'Completed rollout' })
    expect(read.body).toMatchObject({ project: 'home', status: 'archived', revision: 1 })
    expect(read.body.rows).toMatchObject([{ label: 'Ship', revision: 1 }])

    // an archived board still demands its CAS versions before a write reactivates it
    const unversioned = await client.callTool({
      name: 'board_row',
      arguments: { title: 'Completed rollout', label: 'Follow-up', status: 'tracked' },
    })
    expect(unversioned.isError).toBe(true)
    expect(text(unversioned)).toContain('existing board "Completed rollout" requires board_version 1')
    const unrevised = await client.callTool({
      name: 'board_upsert',
      arguments: {
        title: 'Completed rollout',
        board_version: 1,
        rows: [{ label: 'Ship', status: 'done' }, { label: 'Follow-up', status: 'tracked' }],
      },
    })
    expect(unrevised.isError).toBe(true)
    expect(text(unrevised)).toContain('existing row "Ship" requires revision 1')

    const reopened = await client.callTool({
      name: 'board_row',
      arguments: { title: 'Completed rollout', board_version: 1, label: 'Follow-up', status: 'tracked' },
    })
    expect(reopened.isError, text(reopened)).not.toBe(true)
    expect(getBoard(openDb(dbPath), 'home', 'Completed rollout')!.rows.map((row) => row.label))
      .toEqual(['Ship', 'Follow-up'])
    await client.close()
  }, 20000)
})
