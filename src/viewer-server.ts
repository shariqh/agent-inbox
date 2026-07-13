import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { openDb } from './store.js'
import { createViewer } from './viewer.js'

const db = openDb()
const app = createViewer(db)
app.get('/*', serveStatic({ root: './public' }))

const port = Number(process.env.AGENT_INBOX_PORT ?? 4319)
serve({ fetch: app.fetch, port })
console.log(`agent-inbox viewer on http://localhost:${port}`)
