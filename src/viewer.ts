import { Hono } from 'hono'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type Database from 'better-sqlite3'
import { listItems, resolveItem, dismissItem, annotateItem, replyItem, listBoards, archiveBoard, unarchiveBoard, annotateBoardRow, listActivity, defaultDbPath } from './store.js'
import { groupItems } from './group.js'
import { hooksSettingsBlock } from './hook.js'

// Registration info for hooking new agents up to the MCP server. In a repo
// checkout the paths come from the running process; the packaged app instead
// ships a setup-info.json captured at package time (its own bundle cannot host
// the MCP server — the native module there is built for Electron, not Node).
function setupInfo(): { claudeCommand: string; copilotConfig: string; snippet: string; dbPath: string; note: string; hooksSettings: string; hooksNote: string } {
  let nodeBin = process.execPath
  let root = process.cwd()
  let note = ''
  // In a checkout the Node serving this request has demonstrably loaded
  // better-sqlite3 (it is holding the db open); in the packaged app the baked
  // path is whatever ran the packaging script and is NOT proven.
  let nodeProven = true
  const baked = resolve(process.cwd(), 'setup-info.json')
  if (existsSync(baked)) {
    const info = JSON.parse(readFileSync(baked, 'utf8')) as { repoRoot: string; nodeBin: string }
    root = info.repoRoot
    nodeBin = info.nodeBin
    nodeProven = false
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
    hooksSettings: JSON.stringify(hooksSettingsBlock(nodeBin, resolve(root, 'dist', 'hook-cli.js')), null, 2),
    // This panel cannot run `selftest`, so it cannot prove the baked Node can
    // load better-sqlite3 — and a hook spawned under the wrong Node dies
    // silently, forever. Say so instead of implying safety.
    hooksNote:
      (nodeProven
        ? 'Optional. Merge into ~/.claude/settings.json, then restart Claude Code. '
        : '⚠ The Node path below was captured when this app was packaged and has NOT been verified against better-sqlite3. ') +
      'Prefer `npm run install:hooks` from the repo — it proves the Node binary with a selftest before writing anything, backs the file up, and is a dry run by default. See docs/hooks.md.',
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
    const { text, context } = await c.req.json<{ text: string; context?: string }>()
    // false = refused: an already-picked-up reply cannot be silently blanked out (src/store.ts)
    const ok = replyItem(db, c.req.param('id'), text, context)
    return c.json({ ok })
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
