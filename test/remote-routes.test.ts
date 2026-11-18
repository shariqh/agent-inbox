// The remote entry's allowlist (#617, PR 2a; design docs/superpowers/specs/2026-11-17-remote-inbox-design.md
// §3.2 "What it serves"). Every route createViewer registers is classified here, allowed or refused,
// so a route added later fails this file until someone decides which it is.
//
// The rule: a route is refused when it can change the hub's processes or files, hands out a
// credential, or returns something only useful on the hub. Everything else the page uses is the
// owner's own data shown to the owner's paired device, and is allowed.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import type { Server } from 'node:http'
import { openDb } from '../src/store.js'
import { createViewer } from '../src/viewer.js'
import { startLocalViewer } from '../src/viewer-network.js'
import { REMOTE_ROUTES, startRemoteEntry } from '../src/viewer-remote.js'
import type { RemoteEntry } from '../src/viewer-remote.js'
import { scratchDir } from './scratch.js'
import { waitUntil } from './wait.js'
import { ORIGIN, device, deviceHeaders, freePort, newSecret, rawRequest, setting, writeSetting } from './remote-fixtures.js'

const REPO = join(import.meta.dirname, '..')

// Each refused route with the part of the rule that refuses it.
const REFUSED = new Map<string, string>([
  ['GET /api/setup', 'install paths, registration commands and runtimes: only useful on the hub'],
  ['GET /api/owner', 'hands out the owner token, a credential (and is never registered on the remote app)'],
  ['GET /api/launches', 'driven launches: their folders and processes live on the hub'],
  ['GET /api/launches/:id', 'one driven launch: its folder and process live on the hub'],
  ['GET /api/launches/:id/prompt', 'a launch\'s prompt: only useful on the hub'],
  ['GET /api/launches/:id/events', 'a driven launch\'s event log on the hub'],
  ['GET /api/launch-folders', 'the hub\'s folders: only useful on the hub'],
  ['GET /api/launch-asks/:id', 'a driven launch\'s approval ask: answering it runs commands on the hub'],
  ['GET /api/chats/copilot/:id', 'one chat read from the hub\'s folders, for Continue here on the hub'],
  ['POST /api/launches/:id/stop', 'changes the hub\'s processes'],
  ['POST /api/launches/:id/close', 'changes a launch the hub runs'],
  ['POST /api/launches/:id/interrupt', 'changes the hub\'s processes'],
  ['POST /api/launches/:id/park', 'changes the hub\'s processes'],
  ['POST /api/launches/:id/hand-off', 'changes the hub\'s processes'],
  ['POST /api/launches/:id/hand-off/withdraw', 'changes the hub\'s processes'],
  ['POST /api/launches/:id/forget', 'deletes log folders on the hub'],
  ['POST /api/launch-asks/:id/answer', 'approves a command a driven session runs on the hub'],
])

describe('REMOTE_ROUTES', () => {
  let db: Database.Database
  let dir: string

  beforeAll(() => {
    dir = scratchDir('remote-routes-')
    db = openDb(join(dir, 'inbox.db'))
  })
  afterAll(() => db.close())

  const key = (method: string, path: string) => `${method} ${path}`

  it('is exactly the design\'s list', () => {
    const items = ['resolve', 'acknowledge', 'dismiss', 'annotate', 'reply', 'snooze', 'stop-waiting', 'later'].map((a) => `POST /api/items/:id/${a}`)
    const rows = ['annotate', 'snooze', 'stop-waiting', 'later', 'handled'].map((a) => `POST /api/boards/:id/rows/:rowId/${a}`)
    expect(REMOTE_ROUTES.map((r) => key(r.method, r.path)).sort()).toEqual([
      ...['/api/items', '/api/items/history', '/api/boards', '/api/boards/archived', '/api/boards/archived/summary',
        '/api/boards/archived/plans', '/api/activity', '/api/activity/history', '/api/version', '/api/links', '/api/issues',
        '/api/messages', '/api/projects/closed', '/api/chats', '/api/mesh/agents', '/api/mesh/agents/runs'].map((p) => `GET ${p}`),
      ...items,
      'POST /api/boards/:id/archive', 'POST /api/boards/:id/unarchive',
      ...rows,
      'POST /api/projects/close', 'POST /api/projects/reopen',
      'POST /api/sessions/:session/messages', 'POST /api/messages/:id/withdraw', 'POST /api/mesh/agents/refresh',
    ].sort())
  })

  it('classifies every route createViewer registers, owner token included, as allowed or refused', () => {
    const app = createViewer(db, { ownerToken: 'owner-token-for-the-test', agentHome: dir, runtimeRoot: join(dir, 'runtime') })
    const allowed = new Set(REMOTE_ROUTES.map((r) => key(r.method, r.path)))
    const seen = new Set<string>()
    for (const route of app.routes) {
      // createViewer's one middleware (the x-inbox-boot header) is not a route
      if (route.method === 'ALL' && route.path === '/*') continue
      const name = key(route.method, route.path)
      seen.add(name)
      // static files are the only thing served outside /api/, and they come from viewer-server.ts
      expect(route.path.startsWith('/api/'), `${name} is outside /api/, where the gate allows every GET: classify it on purpose`).toBe(true)
      const isAllowed = allowed.has(name)
      const isRefused = REFUSED.has(name)
      expect(isAllowed || isRefused, `${name} is not classified: add it to REMOTE_ROUTES (src/viewer-remote.ts) or to REFUSED here, by the rule`).toBe(true)
      expect(isAllowed && isRefused, `${name} is both allowed and refused`).toBe(false)
    }
    for (const name of allowed) expect(seen, `REMOTE_ROUTES names ${name}, which createViewer does not register`).toContain(name)
    for (const name of REFUSED.keys()) expect(seen, `REFUSED names ${name}, which createViewer does not register`).toContain(name)
  })

  it('names no route that the rule refuses', () => {
    for (const route of REMOTE_ROUTES) {
      expect(route.path, 'launch routes change the hub\'s processes').not.toMatch(/launch/)
      expect(route.path).not.toMatch(/^\/api\/(setup|owner|remote)/)
      expect(route.path).not.toMatch(/copilot/)
    }
  })
})

describe('the remote app', () => {
  it('has no /api/owner: src/viewer-server.ts builds it with no owner token', () => {
    const dir = scratchDir('remote-routes-')
    const db = openDb(join(dir, 'inbox.db'))
    try {
      const remoteApp = createViewer(db, {})
      expect(remoteApp.routes.map((r) => r.path)).not.toContain('/api/owner')
      expect(createViewer(db, { ownerToken: 't' }).routes.map((r) => r.path)).toContain('/api/owner')
    } finally {
      db.close()
    }
    const server = readFileSync(join(REPO, 'src/viewer-server.ts'), 'utf8')
    const remote = /const remoteApp = createViewer\(db, (\{[^}]*\})\)/.exec(server)
    expect(remote, 'viewer-server.ts builds the remote app with createViewer(db, {...})').not.toBeNull()
    expect(remote![1]).not.toMatch(/owner/i)
    expect(server).toMatch(/startRemoteEntry\(\{ app: remoteApp, dir: meshDir\(\), viewerPort: port \}\)/)
  })

  describe('over the real listener', () => {
    let dir: string
    let db: Database.Database
    let entry: RemoteEntry
    let port: number
    const secret = newSecret()

    beforeAll(async () => {
      dir = scratchDir('remote-routes-')
      db = openDb(join(dir, 'inbox.db'))
      port = await freePort()
      writeSetting(dir, setting(port, [device(secret)]))
      const remoteApp = createViewer(db, { agentHome: dir, runtimeRoot: join(dir, 'runtime') })
      remoteApp.get('/*', serveStatic({ root: './public' }))
      entry = startRemoteEntry({ app: remoteApp, dir, viewerPort: 4319 })
      await waitUntil(() => entry.status().listening, 'the remote entry')
    })
    afterAll(async () => {
      await entry.close()
      db.close()
    })

    it.each(['/api/owner', '/api/remote-entry', '/api/setup'])('refuses GET %s with a paired device', async (target) => {
      const response = await rawRequest(port, { target, headers: deviceHeaders(secret, [['Origin', ORIGIN]]) })
      expect(response.status).toBe(403)
    })

    it.each(REMOTE_ROUTES.filter((r) => r.method === 'GET').map((r) => r.path))('serves GET %s past the gate', async (path) => {
      const target = path === '/api/mesh/agents/runs' ? `${path}?name=unslop` : path === '/api/boards/archived/plans' ? `${path}?ids=x` : path
      const response = await rawRequest(port, { target, headers: deviceHeaders(secret) })
      expect(response.status, response.body.slice(0, 200)).toBeLessThan(500)
      expect(response.status).not.toBe(403)
      expect(response.headers['x-agent-inbox-remote-boundary']).toBe('tailnet-v1')
    })
  })
})

// §6: "startLocalViewer's gate and headers are byte-identical to the build before PR 2a. The loopback
// app's responses change only where §3.6's last row says": this PR adds GET /api/remote-entry, nothing else.
describe('the loopback entry is unchanged but for GET /api/remote-entry', () => {
  let dir: string
  let db: Database.Database
  let before: Server
  let after: Server
  let entry: RemoteEntry
  let beforePort: number
  let afterPort: number

  beforeAll(async () => {
    dir = scratchDir('remote-loopback-')
    db = openDb(join(dir, 'inbox.db'))
    const opts = { ownerToken: 'owner-token-for-the-test', agentHome: dir, runtimeRoot: join(dir, 'runtime'), setupInfoPath: join(dir, 'setup-info.json') }
    // as src/viewer-server.ts composed the loopback app before this PR
    const old = createViewer(db, opts)
    old.get('/*', serveStatic({ root: './public' }))
    // and as it composes it now
    const app = createViewer(db, opts)
    writeSetting(dir, setting(await freePort(), []))
    const remoteApp = createViewer(db, { agentHome: dir, runtimeRoot: join(dir, 'runtime') })
    remoteApp.get('/*', serveStatic({ root: './public' }))
    entry = startRemoteEntry({ app: remoteApp, dir, viewerPort: 4319 })
    app.get('/api/remote-entry', (c) => c.json(entry.status()))
    app.get('/*', serveStatic({ root: './public' }))
    before = startLocalViewer(old, 0)
    after = startLocalViewer(app, 0)
    await waitUntil(() => before.listening && after.listening, 'both loopback viewers')
    beforePort = (before.address() as { port: number }).port
    afterPort = (after.address() as { port: number }).port
  })
  afterAll(async () => {
    before.close()
    after.close()
    await entry.close()
    db.close()
  })

  it('composes the loopback app in src/viewer-server.ts with the status route before the static files', () => {
    const server = readFileSync(join(REPO, 'src/viewer-server.ts'), 'utf8')
    const status = server.indexOf("app.get('/api/remote-entry', (c) => c.json(remote.status()))")
    const statics = server.indexOf("app.get('/*', serveStatic({ root: './public' }))")
    expect(status).toBeGreaterThan(0)
    expect(statics).toBeGreaterThan(status)
    expect(server).toContain('startLocalViewer(app, port)')
  })

  const IGNORED = new Set(['date', 'x-inbox-boot'])
  const same = (a: Record<string, string>, b: Record<string, string>) => {
    const strip = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).filter(([k]) => !IGNORED.has(k)))
    expect(strip(b)).toEqual(strip(a))
  }

  it.each([
    ['GET', '/api/items', [], undefined],
    ['GET', '/api/items?scope=attention', [], undefined],
    ['GET', '/api/owner', [], undefined],
    ['GET', '/api/activity', [], undefined],
    ['GET', '/api/launches', [], undefined],
    ['GET', '/index.html', [], undefined],
    ['HEAD', '/index.html', [], undefined],
    ['GET', '/missing-module.js', [], undefined],
    ['GET', '/api/no-such-route', [], undefined],
    ['GET', '/api/items', [['Origin', 'https://evil.example']], undefined],
    ['POST', '/api/projects/close', [], '{}'],
    ['POST', '/api/projects/close', [['Origin', 'ORIGIN']], '{}'],
    ['POST', '/api/projects/close', [['Origin', 'ORIGIN'], ['Sec-Fetch-Site', 'same-site']], '{}'],
  ] as Array<[string, string, Array<[string, string]>, string | undefined]>)('%s %s answers as before', async (method, target, extra, body) => {
    const send = (port: number) => rawRequest(port, {
      method,
      target,
      body,
      headers: [['Host', `127.0.0.1:${port}`], ...extra.map(([k, v]): [string, string] => [k, v === 'ORIGIN' ? `http://127.0.0.1:${port}` : v])],
    })
    const old = await send(beforePort)
    const now = await send(afterPort)
    expect(now.status).toBe(old.status)
    expect(now.body).toBe(old.body)
    same(old.headers, now.headers)
    expect(now.headers['x-agent-inbox-remote-boundary']).toBeUndefined()
  })

  it('a wrong Host is refused the same way', async () => {
    const old = await rawRequest(beforePort, { target: '/api/items', headers: [['Host', 'hub.example.ts.net']] })
    const now = await rawRequest(afterPort, { target: '/api/items', headers: [['Host', 'hub.example.ts.net']] })
    expect([old.status, now.status]).toEqual([403, 403])
    same(old.headers, now.headers)
  })

  it('keeps the loopback headers pinned', async () => {
    const now = await rawRequest(afterPort, { target: '/api/items', headers: [['Host', `127.0.0.1:${afterPort}`]] })
    expect(now.headers['x-agent-inbox-local-boundary']).toBe('loopback-v1')
    expect(now.headers['content-security-policy']).toBe("script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
    expect(now.headers['x-frame-options']).toBe('DENY')
    expect(now.headers['cache-control']).toBe('no-store')
  })

  it('adds GET /api/remote-entry, counts only, on the loopback entry', async () => {
    const old = await rawRequest(beforePort, { target: '/api/remote-entry', headers: [['Host', `127.0.0.1:${beforePort}`]] })
    expect(old.status).toBe(404)
    const now = await rawRequest(afterPort, { target: '/api/remote-entry', headers: [['Host', `127.0.0.1:${afterPort}`]] })
    expect(now.status).toBe(200)
    expect(now.headers['x-agent-inbox-local-boundary']).toBe('loopback-v1')
    expect(JSON.parse(now.body)).toEqual({
      on: true, listening: expect.any(Boolean), port: expect.any(Number), host: 'hub.example.ts.net', error: null,
      refused: { host: 0, funnel: 0, login: 0, path: 0, origin: 0, device: 0, route: 0 },
    })
  })
})
