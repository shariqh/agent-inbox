import { serveStatic } from '@hono/node-server/serve-static'
import { openDb } from './store.js'
import { createViewer } from './viewer.js'
import { startGithubPoller } from './issue-poller.js'
import { startLocalViewer } from './viewer-network.js'
import { remoteDir, startRemoteEntry } from './viewer-remote.js'
import { meshDir } from './mesh-config.js'
import { meshAgents } from './mesh-agents.js'

const port = Number(process.env.AGENT_INBOX_PORT ?? 4319)
const db = openDb()
const mesh = meshAgents({ dir: meshDir() })
const app = createViewer(db, { ownerToken: process.env.AGENT_INBOX_OWNER_TOKEN, mesh })
// issue #30 — this is the ONE process allowed to run `gh` (the stdio MCP server
// never may). Started here rather than inside createViewer because every viewer
// test constructs the app with app.request(...) and a timer there would leak
// into all of them. NOTE: Electron loads the COMPILED dist/viewer-server.js, so
// the poller only reaches the packaged app after `npm run build`. Issue #103:
// one tick runs the issue class (sub-issues) first, then the PR class.
startGithubPoller(db)

// #617: the remote entry, off unless remote.json beside the hub database turns it on
// (src/viewer-remote.ts, docs/architecture/remote-inbox.md). remoteDir() is the database's
// folder, never AGENT_INBOX_MESH_DIR. Its app is a second createViewer built with no owner
// token, so /api/owner does not exist on it; createViewer starts no timers, so building it
// twice is safe. The entry copies the app's routes when it starts: add nothing to it after.
const remoteApp = createViewer(db, { mesh })
remoteApp.get('/*', serveStatic({ root: './public' }))
const remote = startRemoteEntry({ app: remoteApp, dir: remoteDir(), viewerPort: port })
// loopback only, and never on the remote allowlist: counts since start, no login or secret
app.get('/api/remote-entry', (c) => c.json(remote.status()))

app.get('/*', serveStatic({ root: './public' }))

startLocalViewer(app, port)
console.log(`agent-inbox viewer on http://127.0.0.1:${port}`)
