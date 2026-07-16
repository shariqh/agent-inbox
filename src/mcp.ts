import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type Database from 'better-sqlite3'
import { insertItem, resolveItem, upsertBoard, updateBoardRow, findBoard, archiveBoard, getBoard, listBoards, markBoardRead } from './store.js'
import { makeScope } from './scope.js'

export function buildMcpServer(db: Database.Database, cwd: string): McpServer {
  const server = new McpServer({ name: 'agent-inbox', version: '0.1.0' })
  const scope = makeScope(cwd)
  const clientName = (): string | undefined => server.server.getClientVersion()?.name

  server.registerTool(
    'flag',
    {
      description:
        'Raise an item for the human. kind="question" when you would otherwise pause to ask in the terminal; kind="note" for a non-blocking assumption, caveat, or workaround they should see. project/stream/agent are inferred automatically.',
      inputSchema: {
        kind: z.enum(['question', 'note']),
        title: z.string().min(1),
        detail: z.string().optional(),
        stream: z.string().optional(),
      },
    },
    async ({ kind, title, detail, stream }) => {
      const s = scope.get(clientName())
      const id = insertItem(db, {
        project: s.project,
        stream: stream ?? s.stream,
        agent: s.agent,
        kind,
        title,
        detail,
      })
      return { content: [{ type: 'text', text: JSON.stringify({ id }) }] }
    },
  )

  server.registerTool(
    'resolve',
    {
      description: 'Mark one of your own inbox items resolved once it is moot (you answered it yourself, or the caveat no longer applies).',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      resolveItem(db, id)
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }
    },
  )

  server.registerTool(
    'register',
    {
      description: 'Override the auto-inferred project/stream for this session when detection is wrong.',
      inputSchema: { project: z.string().optional(), stream: z.string().optional() },
    },
    async ({ project, stream }) => {
      scope.override({ project, stream })
      return { content: [{ type: 'text', text: JSON.stringify(scope.get(clientName())) }] }
    },
  )

  server.registerTool(
    'whoami',
    { description: 'Report this session’s current project/stream/agent scope.', inputSchema: {} },
    async () => ({ content: [{ type: 'text', text: JSON.stringify(scope.get(clientName())) }] }),
  )

  const rowStatus = z.enum(['done', 'partial', 'missing', 'tracked', 'na'])

  server.registerTool(
    'board_upsert',
    {
      description:
        'Create or replace a tracking board (a titled table the human watches). Idempotent by title within this project — re-send the whole table to refresh it. Rows are matched by label; the human’s per-row notes survive. status: done|partial|missing|tracked|na. note is the one-line summary; context is optional long-form backstory (reasoning, history) shown collapsed.',
      inputSchema: {
        title: z.string().min(1),
        rows: z.array(z.object({ label: z.string().min(1), status: rowStatus, note: z.string().optional(), context: z.string().optional() })),
      },
    },
    async ({ title, rows }) => {
      const s = scope.get(clientName())
      const out = upsertBoard(db, { project: s.project, stream: s.stream, agent: s.agent, title, rows })
      return { content: [{ type: 'text', text: JSON.stringify(out) }] }
    },
  )

  server.registerTool(
    'board_row',
    {
      description:
        'Update or add ONE row of a tracking board by label, without re-sending the whole table. Creates the board (and row) if missing; a new row defaults to status "tracked". Omitted status/note/context leave the existing value. context is optional long-form backstory shown collapsed.',
      inputSchema: { title: z.string().min(1), label: z.string().min(1), status: rowStatus.optional(), note: z.string().optional(), context: z.string().optional() },
    },
    async ({ title, label, status, note, context }) => {
      const s = scope.get(clientName())
      const out = updateBoardRow(db, { project: s.project, stream: s.stream, agent: s.agent, title, label, status, note, context })
      return { content: [{ type: 'text', text: JSON.stringify(out) }] }
    },
  )

  server.registerTool(
    'board_archive',
    {
      description: 'Archive a finished tracking board so it drops off the human’s active view. Resolved by title within this project.',
      inputSchema: { title: z.string().min(1) },
    },
    async ({ title }) => {
      const s = scope.get(clientName())
      const board = findBoard(db, s.project, title)
      if (board) archiveBoard(db, board.id)
      return { content: [{ type: 'text', text: JSON.stringify({ ok: board !== undefined }) }] }
    },
  )

  server.registerTool(
    'board_get',
    {
      description:
        'Read a tracking board back, INCLUDING the human’s per-row notes (annotations). Call this to see whether the human left you any notes, or to re-read a board’s state before updating it. Rows carry annotation_unseen: true on annotations written since your last read — act on those. Reading marks the board read. With a title: that board. Without: all your active boards in this project. Returns {found:false} if the titled board does not exist.',
      inputSchema: { title: z.string().optional() },
    },
    async ({ title }) => {
      const s = scope.get(clientName())
      if (title === undefined) {
        const boards = listBoards(db).filter((b) => b.project === s.project)
        for (const b of boards) markBoardRead(db, b.id)
        return { content: [{ type: 'text', text: JSON.stringify({ boards }) }] }
      }
      const board = getBoard(db, s.project, title)
      if (board) markBoardRead(db, board.id)
      return { content: [{ type: 'text', text: JSON.stringify(board ?? { found: false }) }] }
    },
  )

  return server
}
