import { Hono } from 'hono'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type Database from 'better-sqlite3'
import { listItems, resolveItem, dismissItem, annotateItem, replyItem, listBoards, archiveBoard, unarchiveBoard, annotateBoardRow, listActivity, defaultDbPath } from './store.js'
import { groupItems } from './group.js'

// Registration info for hooking new agents up to the MCP server. In a repo
// checkout the paths come from the running process; the packaged app instead
// ships a setup-info.json captured at package time (its own bundle cannot host
// the MCP server — the native module there is built for Electron, not Node).
function setupInfo(): { claudeCommand: string; copilotConfig: string; snippet: string; dbPath: string; note: string } {
  let nodeBin = process.execPath
  let root = process.cwd()
  let note = ''
  const baked = resolve(process.cwd(), 'setup-info.json')
  if (existsSync(baked)) {
    const info = JSON.parse(readFileSync(baked, 'utf8')) as { repoRoot: string; nodeBin: string }
    root = info.repoRoot
    nodeBin = info.nodeBin
    note = `Paths were captured when this app was packaged and assume the agent-inbox repo still lives at ${root} (agents run the MCP server from the repo, not from this app).`
  }
  const entry = resolve(root, 'dist', 'mcp-server.js')
  const snippetPath = resolve(process.cwd(), 'docs', 'reporting-snippet.md')
  return {
    claudeCommand: `claude mcp add --scope user agent-inbox -- ${nodeBin} ${entry}`,
    copilotConfig: JSON.stringify(
      { mcpServers: { 'agent-inbox': { command: nodeBin, args: [entry] } } },
      null,
      2,
    ),
    snippet: existsSync(snippetPath) ? readFileSync(snippetPath, 'utf8') : '',
    dbPath: defaultDbPath(),
    note,
  }
}

export function createViewer(db: Database.Database): Hono {
  const app = new Hono()

  // boot id lets a long-lived tab detect a server restart (= likely deploy)
  // and reload itself instead of polling forever with stale frontend code
  const boot = new Date().toISOString()
  app.use('*', async (c, next) => {
    await next()
    c.res.headers.set('x-inbox-boot', boot)
  })

  app.get('/api/items', (c) => c.json(groupItems(listItems(db))))

  app.get('/api/setup', (c) => c.json(setupInfo()))

  app.get('/api/activity', (c) => c.json(listActivity(db)))

  app.post('/api/items/:id/resolve', (c) => {
    resolveItem(db, c.req.param('id'))
    return c.json({ ok: true })
  })

  app.post('/api/items/:id/dismiss', (c) => {
    dismissItem(db, c.req.param('id'))
    return c.json({ ok: true })
  })

  app.post('/api/items/:id/annotate', async (c) => {
    const { text } = await c.req.json<{ text: string }>()
    annotateItem(db, c.req.param('id'), text)
    return c.json({ ok: true })
  })

  app.post('/api/items/:id/reply', async (c) => {
    const { text } = await c.req.json<{ text: string }>()
    replyItem(db, c.req.param('id'), text)
    return c.json({ ok: true })
  })

  app.get('/api/boards', (c) => c.json(listBoards(db)))

  app.get('/api/boards/archived', (c) => c.json(listBoards(db, { status: 'archived' })))

  app.post('/api/boards/:id/archive', (c) => {
    archiveBoard(db, c.req.param('id'))
    return c.json({ ok: true })
  })

  app.post('/api/boards/:id/unarchive', (c) => {
    unarchiveBoard(db, c.req.param('id'))
    return c.json({ ok: true })
  })

  app.post('/api/boards/:id/rows/:rowId/annotate', async (c) => {
    const { text } = await c.req.json<{ text: string }>()
    annotateBoardRow(db, c.req.param('rowId'), text)
    return c.json({ ok: true })
  })

  return app
}
