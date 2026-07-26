import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { openDb } from './store.js'
import { createViewer } from './viewer.js'
import { startPrPoller } from './prstate.js'

const db = openDb()
const app = createViewer(db)
// issue #30 — this is the ONE process allowed to run `gh` (the stdio MCP server
// never may). Started here rather than inside createViewer because every viewer
// test constructs the app with app.request(...) and a timer there would leak
// into all of them. NOTE: Electron loads the COMPILED dist/viewer-server.js, so
// the poller only reaches the packaged app after `npm run build`.
startPrPoller(db)
app.get('/*', serveStatic({ root: './public' }))

const port = Number(process.env.AGENT_INBOX_PORT ?? 4319)
serve({ fetch: app.fetch, port })
console.log(`agent-inbox viewer on http://localhost:${port}`)
