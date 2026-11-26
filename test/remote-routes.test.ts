// The remote entry's allowlist (#617, PR 2a; design docs/superpowers/specs/2026-11-17-remote-inbox-design.md
// §3.2 "What it serves"). Every route createViewer registers is classified here, allowed or refused,
// so a route added later fails this file until someone decides which it is.
//
// The rule: a route is ALLOWED only when the page needs it to show or answer the Inbox. It is REFUSED
// when it acts on the hub's processes or files, hands out a credential, or belongs to setup or
// launching, which only make sense at the hub. GET /api/chats, GET /api/mesh/agents and
// GET /api/mesh/agents/runs carry the owner's own hub-side details (a folder path, command hints) to
// the owner's paired device, by decision.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import type Database from 'better-sqlite3'
import type { Server } from 'node:http'
import { openDb } from '../src/store.js'
import { createViewer } from '../src/viewer.js'
import { startLocalViewer } from '../src/viewer-network.js'
import { staticFiles } from '../src/viewer-static.js'
import { GUARDED_ROUTES, REMOTE_ROUTES, guardRemoteApp, remoteRouteAllowed, startRemoteEntry } from '../src/viewer-remote.js'
import { remoteCodeRoute } from '../src/remote-pair.js'
import type { Handler } from 'hono'
import type { RemoteEntry } from '../src/viewer-remote.js'
import { scratchDir } from './scratch.js'
import { waitUntil } from './wait.js'
import { ORIGIN, device, deviceHeaders, freePort, newSecret, rawRequest, setting, writeSetting } from './remote-fixtures.js'

const REPO = join(import.meta.dirname, '..')

// Each refused route with the part of the rule that refuses it.
const REFUSED = new Map<string, string>([
  ['GET /api/setup', 'belongs to setup: install paths, registration commands and runtimes'],
  ['GET /api/owner', 'hands out the owner token, a credential (and is never registered on the remote app)'],
  ['GET /api/launches', 'belongs to launching: driven sessions the hub runs'],
  ['GET /api/launches/:id', 'belongs to launching: one driven session the hub runs'],
  ['GET /api/launches/:id/prompt', 'belongs to launching: a launch\'s prompt'],
  ['GET /api/launches/:id/events', 'belongs to launching: a driven session\'s event log'],
  ['GET /api/launch-folders', 'belongs to launching: the hub\'s folders to start in'],
  ['GET /api/launch-asks/:id', 'belongs to launching: a driven session\'s approval ask'],
  ['GET /api/chats/copilot/:id', 'belongs to launching: Continue here starts a driven session on the hub'],
  ['POST /api/launches/:id/stop', 'acts on the hub\'s processes'],
  ['POST /api/launches/:id/close', 'acts on a launch the hub runs'],
  ['POST /api/launches/:id/interrupt', 'acts on the hub\'s processes'],
  ['POST /api/launches/:id/park', 'acts on the hub\'s processes'],
  ['POST /api/launches/:id/hand-off', 'acts on the hub\'s processes'],
  ['POST /api/launches/:id/hand-off/withdraw', 'acts on the hub\'s processes'],
  ['POST /api/launches/:id/forget', 'acts on the hub\'s files: deletes log folders'],
  ['POST /api/launch-asks/:id/answer', 'acts on the hub\'s processes: approves a command a driven session runs'],
])

// Routes src/viewer-server.ts adds to the LOOPBACK app only (not createViewer's), each refused remotely.
const LOOPBACK_ONLY = new Map<string, string>([
  ['GET /api/remote-entry', 'the remote entry\'s own status: setup, which only makes sense at the hub'],
  ['POST /api/remote-entry/code', 'makes a pairing code, which hands out a credential: only main, with the owner token, at the hub'],
  ['POST /api/remote-entry/update', 'main\'s report of the hub\'s update (#637): only main, with the owner token, at the hub'],
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
      ...['/api/items', '/api/items/history', '/api/boards', '/api/boards/tags', '/api/boards/plans', '/api/boards/archived', '/api/boards/archived/summary',
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

  it('refuses the loopback-only routes src/viewer-server.ts adds, and classifies each one it adds', () => {
    for (const name of LOOPBACK_ONLY.keys()) {
      const [method, path] = name.split(' ') as [string, string]
      expect(remoteRouteAllowed(method, path), name).toBe(false)
    }
    const server = readFileSync(join(REPO, 'src/viewer-server.ts'), 'utf8')
    const added = [...server.matchAll(/\bapp\.(get|post|put|delete|patch)\('(\/api\/[^']+)'/g)].map((m) => `${m[1]!.toUpperCase()} ${m[2]}`)
    expect(added.sort()).toEqual([...LOOPBACK_ONLY.keys()].sort())
  })

  // #634: and the file route, GET only
  it('lists the guarded app\'s own update routes apart (#637): never createViewer\'s, never on REMOTE_ROUTES', () => {
    expect(GUARDED_ROUTES.map((r) => key(r.method, r.path))).toEqual(['GET /api/remote/update', 'POST /api/remote/update', 'GET /api/remote/file'])
    for (const route of GUARDED_ROUTES) expect(remoteRouteAllowed(route.method, route.path)).toBe(false)
  })

  it('never lets createViewer register the pairing route: only the guarded app serves it', () => {
    const app = createViewer(db, { ownerToken: 'owner-token-for-the-test', agentHome: dir, runtimeRoot: join(dir, 'runtime') })
    expect(app.routes.filter((route) => route.path.startsWith('/api/remote'))).toEqual([])
    // and it is not on the allowlist: it reaches its handler only through the gate's step 7
    expect(remoteRouteAllowed('POST', '/api/remote/pair')).toBe(false)
  })
})

// The gate allows by concrete path, but the classification above is by registered pattern. So for
// every allowed pattern, check what Hono would actually run for a concrete path, on the app as the
// entry wraps it: the gate, createViewer's own wildcard middleware, the one handler registered with
// that pattern and method, and (for GET) the static handler after it. A broader route registered
// anywhere (`/api/items/:id/:action`, `/api/boards/*`) shows up here and fails.
type RouteRecord = { method: string; path: string; handler: unknown }

function runChain(app: Hono<never>, method: string, path: string): RouteRecord[] {
  const [matched] = app.router.match(method, path) as unknown as [Array<[[unknown, RouteRecord], unknown]>]
  return matched.map(([[, route]]) => route)
}

const samplePath = (pattern: string) => pattern.replace(/:[A-Za-z]+/g, 'sample0')

const pairHandler: Handler = (c) => c.text('pair')
const updateHandlers: { get: Handler; post: Handler } = { get: (c) => c.text('update'), post: (c) => c.text('start') }
const fileHandler: Handler = (c) => c.text('file')

function chainProblems(app: Hono, gate: MiddlewareHandler): string[] {
  const guarded = guardRemoteApp(app, gate, pairHandler, updateHandlers, fileHandler) as unknown as Hono<never>
  const problems: string[] = []
  // #637: the update routes, the same way: the gate, then the guarded app's own handler, which answers;
  // #634: the file route too
  for (const route of GUARDED_ROUTES) {
    const chain = runChain(guarded, route.method, route.path)
    const got = chain.map((r) => `${r.method} ${r.path}`)
    const own = route.path === '/api/remote/file' ? fileHandler : route.method === 'GET' ? updateHandlers.get : updateHandlers.post
    if (got[0] !== 'ALL /*' || got[1] !== `${route.method} ${route.path}` || chain[0]!.handler !== gate || chain[1]!.handler !== own) {
      problems.push(`${route.method} ${route.path}: ${got.join(', ')}`)
    }
    if (runChain(app as unknown as Hono<never>, route.method, route.path).some((r) => r.path !== '/*')) problems.push(`the wrapped app serves ${route.method} ${route.path}`)
  }
  // pairing: the gate, then the guarded app's own handler, which answers; never a handler of the wrapped app
  // (the compression middleware and createViewer's x-inbox-boot middleware match too, but never run)
  const pair = runChain(guarded, 'POST', '/api/remote/pair')
  const pairGot = pair.map((r) => `${r.method} ${r.path}`)
  if (JSON.stringify(pairGot) !== JSON.stringify(['ALL /*', 'POST /api/remote/pair', 'ALL /*', 'ALL /*'])) problems.push(`POST /api/remote/pair: ${pairGot.join(', ')}`)
  else if (pair[0]!.handler !== gate || pair[1]!.handler !== pairHandler) problems.push('POST /api/remote/pair: not the gate, then the guarded app\'s pairing handler')
  if (runChain(app as unknown as Hono<never>, 'POST', '/api/remote/pair').some((r) => r.path !== '/*')) problems.push('the wrapped app serves POST /api/remote/pair')
  for (const route of REMOTE_ROUTES) {
    const chain = runChain(guarded, route.method, samplePath(route.path))
    const expected = [
      'ALL /*', // the gate
      'ALL /*', // hono/compress, for what the wrapped app serves
      'ALL /*', // createViewer's x-inbox-boot middleware
      `${route.method} ${route.path}`,
      ...(route.method === 'GET' ? ['GET /*'] : []), // the static files, reached only if the handler passes on
    ]
    const got = chain.map((r) => `${r.method} ${r.path}`)
    if (JSON.stringify(got) !== JSON.stringify(expected)) problems.push(`${route.method} ${route.path}: ${got.join(', ')}`)
    else if (chain[0]!.handler !== gate) problems.push(`${route.method} ${route.path}: the gate does not run first`)
    else if ((chain[1]!.handler as { name?: string }).name !== 'compress') problems.push(`${route.method} ${route.path}: compression does not run second`)
  }
  return problems
}

describe('what Hono runs for each allowed path', () => {
  let db: Database.Database
  let dir: string
  const gate: MiddlewareHandler = async (_c, next) => { await next() }

  beforeAll(() => {
    dir = scratchDir('remote-routes-')
    db = openDb(join(dir, 'inbox.db'))
  })
  afterAll(() => db.close())

  // built as src/viewer-server.ts builds it
  const remoteApp = () => {
    const app = createViewer(db, { agentHome: dir, runtimeRoot: join(dir, 'runtime') })
    app.get('/*', staticFiles('./public'))
    return app
  }

  it('is exactly the gate, the wildcard middleware and the route\'s own handler', () => {
    expect(chainProblems(remoteApp(), gate)).toEqual([])
  })

  it('catches a broader route registered before the specific ones', () => {
    const scratch = new Hono()
    scratch.post('/api/items/:id/:action', (c) => c.text('broad'))
    scratch.route('/', remoteApp())
    expect(chainProblems(scratch, gate)).toContain('POST /api/items/:id/resolve: ALL /*, ALL /*, POST /api/items/:id/:action, ALL /*, POST /api/items/:id/resolve')
  })

  it('catches a wildcard registered after them, with app.on', () => {
    const app = remoteApp()
    app.on(['GET', 'POST'], '/api/boards/*', (c) => c.text('broad'))
    expect(chainProblems(app, gate).some((problem) => problem.startsWith('POST /api/boards/:id/archive'))).toBe(true)
  })

  it('catches a pairing route on the wrapped app, which would run behind the guarded one', () => {
    const app = remoteApp()
    app.post('/api/remote/pair', (c) => c.text('wrapped'))
    expect(chainProblems(app, gate)).toEqual(expect.arrayContaining([
      'POST /api/remote/pair: ALL /*, POST /api/remote/pair, ALL /*, ALL /*, POST /api/remote/pair',
      'the wrapped app serves POST /api/remote/pair',
    ]))
  })

  it('catches an update route on the wrapped app (#637)', () => {
    const app = remoteApp()
    app.post('/api/remote/update', (c) => c.text('wrapped'))
    expect(chainProblems(app, gate)).toContain('the wrapped app serves POST /api/remote/update')
  })
})

describe('the remote app', () => {
  it('is built in src/viewer-server.ts with no owner token, one static route, then the entry, and nothing after', () => {
    const server = readFileSync(join(REPO, 'src/viewer-server.ts'), 'utf8')
    expect(server).toContain([
      'const remoteApp = createViewer(db, { mesh })',
      "remoteApp.get('/*', staticFiles('./public'))",
      'const remote = startRemoteEntry({ app: remoteApp, dir: remoteDir(), viewerPort: port, update, files: { linked: linkedFiles(db), home: homedir() } })',
    ].join('\n'))
    // Hono copies the routes when the entry wraps the app: anything added to it later is never served
    expect(server.match(/\bremoteApp\b/g)).toHaveLength(3)
    expect(server).not.toMatch(/meshDir\(\)[^\n]*startRemoteEntry|startRemoteEntry[^\n]*meshDir/)
  })

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
      remoteApp.get('/*', staticFiles('./public'))
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

    // slow links, step 2: the plans list's two pieces go through the gate as /api/boards does
    it.each(['/api/boards', '/api/boards/tags', '/api/boards/plans?ids=x'])('serves GET %s to a paired device and refuses it without one', async (target) => {
      const paired = await rawRequest(port, { target, headers: deviceHeaders(secret) })
      expect(paired.status).toBe(200)
      expect(paired.headers['x-agent-inbox-remote-boundary']).toBe('tailnet-v1')
      const before = entry.status().refused.device
      const unpaired = await rawRequest(port, { target, headers: deviceHeaders(newSecret()) })
      expect(unpaired.status).toBe(403)
      expect(entry.status().refused.device).toBe(before + 1)
      const none = await rawRequest(port, { target, headers: deviceHeaders(secret).filter(([name]) => name !== 'X-Agent-Inbox-Device') })
      expect(none.status).toBe(403)
    })

    it('refuses POST /api/remote-entry/code with a paired device and the owner header', async () => {
      const before = entry.status().refused.route
      const response = await rawRequest(port, { method: 'POST', target: '/api/remote-entry/code', headers: deviceHeaders(secret, [['Origin', ORIGIN], ['X-Agent-Inbox-Owner', 'owner-token-for-the-test']]), body: '{}' })
      expect(response.status).toBe(403)
      expect(entry.status().refused.route).toBe(before + 1)
      expect(entry.status().codePending).toBe(false)
    })

    it.each(REMOTE_ROUTES.filter((r) => r.method === 'GET').map((r) => r.path))('serves GET %s past the gate', async (path) => {
      const target = path === '/api/mesh/agents/runs' ? `${path}?name=unslop` : path.endsWith('/plans') ? `${path}?ids=x` : path
      const response = await rawRequest(port, { target, headers: deviceHeaders(secret) })
      expect(response.status, response.body.slice(0, 200)).toBeLessThan(500)
      expect(response.status).not.toBe(403)
      expect(response.headers['x-agent-inbox-remote-boundary']).toBe('tailnet-v1')
    })
  })
})

// §6: "startLocalViewer's gate and headers are byte-identical to the build before PR 2a. The loopback
// app's responses change only where §3.6's last row says": PR 2a adds GET /api/remote-entry and PR 2b
// POST /api/remote-entry/code, nothing else.
describe('the loopback entry is unchanged but for GET /api/remote-entry and POST /api/remote-entry/code', () => {
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
    old.get('/*', staticFiles('./public'))
    // and as it composes it now
    const app = createViewer(db, opts)
    writeSetting(dir, setting(await freePort(), []))
    const remoteApp = createViewer(db, { agentHome: dir, runtimeRoot: join(dir, 'runtime') })
    remoteApp.get('/*', staticFiles('./public'))
    entry = startRemoteEntry({ app: remoteApp, dir, viewerPort: 4319 })
    app.get('/api/remote-entry', (c) => c.json(entry.status()))
    app.post('/api/remote-entry/code', remoteCodeRoute(entry, opts.ownerToken))
    app.get('/*', staticFiles('./public'))
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

  it('composes the loopback app in src/viewer-server.ts with the status and code routes before the static files', () => {
    const server = readFileSync(join(REPO, 'src/viewer-server.ts'), 'utf8')
    const status = server.indexOf("app.get('/api/remote-entry', (c) => c.json(remote.status()))")
    // the code route exists only with an owner token, and uses the one the loopback app was built with
    const code = server.indexOf("if (ownerToken) app.post('/api/remote-entry/code', remoteCodeRoute(remote, ownerToken))")
    const statics = server.indexOf("app.get('/*', staticFiles('./public'))")
    expect(status).toBeGreaterThan(0)
    expect(code).toBeGreaterThan(status)
    expect(statics).toBeGreaterThan(code)
    expect(server).toContain('const ownerToken = process.env.AGENT_INBOX_OWNER_TOKEN\nconst app = createViewer(db, { ownerToken, mesh })')
    expect(server.match(/AGENT_INBOX_OWNER_TOKEN/g)).toHaveLength(1)
    expect(server).toContain('startLocalViewer(app, port)')
  })

  it('adds POST /api/remote-entry/code, behind the owner token, on the loopback entry', async () => {
    const send = (port: number, extra: Array<[string, string]>) => rawRequest(port, {
      method: 'POST', target: '/api/remote-entry/code', body: '', contentType: null,
      headers: [['Host', `127.0.0.1:${port}`], ['Origin', `http://127.0.0.1:${port}`], ...extra],
    })
    await waitUntil(() => entry.status().listening, 'the remote entry')
    expect((await send(beforePort, [['X-Agent-Inbox-Owner', 'owner-token-for-the-test']])).status).toBe(404)
    expect((await send(afterPort, [])).status).toBe(403)
    const made = await send(afterPort, [['X-Agent-Inbox-Owner', 'owner-token-for-the-test']])
    expect(made.status).toBe(200)
    expect(made.headers['x-agent-inbox-local-boundary']).toBe('loopback-v1')
    expect(made.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(made.body).code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/)
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
      codePending: expect.any(Boolean), paired: [],
      refused: { host: 0, funnel: 0, login: 0, path: 0, origin: 0, device: 0, route: 0, pair: 0 },
    })
  })
})
