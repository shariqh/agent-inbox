import { homedir } from 'node:os'
import { openDb } from './store.js'
import { createViewer } from './viewer.js'
import { staticFiles } from './viewer-static.js'
import { startGithubPoller } from './issue-poller.js'
import { startLocalViewer } from './viewer-network.js'
import { remoteDir, startRemoteEntry } from './viewer-remote.js'
import { remoteCodeRoute } from './remote-pair.js'
import { createRemoteUpdate, remoteUpdateReportRoute } from './remote-update.js'
import { linkedFiles } from './remote-file.js'
import { AGENT_INBOX_VERSION } from './version.js'
import { meshDir } from './mesh-config.js'
import { meshAgents } from './mesh-agents.js'

const port = Number(process.env.AGENT_INBOX_PORT ?? 4319)
const db = openDb()
const mesh = meshAgents({ dir: meshDir() })
// read once, now: the desktop app sets it only while it imports this module in-process
const ownerToken = process.env.AGENT_INBOX_OWNER_TOKEN
const app = createViewer(db, { ownerToken, mesh })
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
// #637: what a paired device may see of this hub's update, and its request to start it, relayed to
// the desktop app's main, which reports here (src/remote-update.ts)
// #634: a file a card links, read-only, for a paired device: the card's file links from this database,
// `~/` under this user's home (src/remote-file.ts)
const update = createRemoteUpdate({ version: AGENT_INBOX_VERSION })
const remoteApp = createViewer(db, { mesh })
remoteApp.get('/*', staticFiles('./public'))
const remote = startRemoteEntry({ app: remoteApp, dir: remoteDir(), viewerPort: port, update, files: { linked: linkedFiles(db), home: homedir() } })
// loopback only, and never on the remote allowlist: counts since start, no login or secret
app.get('/api/remote-entry', (c) => c.json(remote.status()))
// loopback only, and only for the desktop app that started this viewer with an owner token: a
// pairing code (src/remote-pair.ts). Without a token the route does not exist.
if (ownerToken) app.post('/api/remote-entry/code', remoteCodeRoute(remote, ownerToken))
// #637: main's report of its update state, and the request a paired device made since; loopback only,
// only with the owner token. It starts nothing: main decides on its own state.
if (ownerToken) app.post('/api/remote-entry/update', remoteUpdateReportRoute(update, ownerToken))

app.get('/*', staticFiles('./public'))

startLocalViewer(app, port)
console.log(`agent-inbox viewer on http://127.0.0.1:${port}`)
