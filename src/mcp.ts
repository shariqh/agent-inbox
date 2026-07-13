import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type Database from 'better-sqlite3'
import { insertItem, resolveItem } from './store.js'
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

  return server
}
