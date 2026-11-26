// The remote entry's gate (#617, PR 2a; design docs/superpowers/specs/2026-11-17-remote-inbox-design.md
// §3.2 "The gate, in order"). Real HTTP over a raw socket against the real listener on a
// scratch port, wrapping a real createViewer app built as src/viewer-server.ts builds it.
import crypto from 'node:crypto'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { openDb } from '../src/store.js'
import { createViewer } from '../src/viewer.js'
import { startLocalViewer } from '../src/viewer-network.js'
import { pathFormOk, remoteRouteAllowed, startRemoteEntry } from '../src/viewer-remote.js'
import { staticFiles } from '../src/viewer-static.js'
import type { RemoteEntry } from '../src/viewer-remote.js'
import { scratchDir } from './scratch.js'
import { waitUntil } from './wait.js'
import {
  HOST, LOGIN, ORIGIN, device, deviceHeaders, freePort, newSecret, rawRequest, secretSha256, setting, writeSetting,
} from './remote-fixtures.js'
import type { RawResponse } from './remote-fixtures.js'

type Reason = 'host' | 'funnel' | 'login' | 'path' | 'origin' | 'device' | 'route' | 'pair'

let dir: string
let db: Database.Database
let entry: RemoteEntry
let port: number
const first = newSecret()
const second = newSecret()
const third = newSecret()

function viewerOpts(home: string) {
  return { agentHome: home, runtimeRoot: join(home, 'runtime'), setupInfoPath: join(home, 'setup-info.json'), stamp: async () => ({ commit: null, dirty: false }) as never }
}

beforeAll(async () => {
  dir = scratchDir('viewer-remote-')
  db = openDb(join(dir, 'inbox.db'))
  port = await freePort()
  writeSetting(dir, setting(port, [device(first, '1111111111111111'), device(second, '2222222222222222', 'desk')]))
  // as src/viewer-server.ts builds it: a second createViewer, no owner token
  const remoteApp = createViewer(db, viewerOpts(dir))
  remoteApp.get('/*', staticFiles('./public'))
  entry = startRemoteEntry({ app: remoteApp, dir, viewerPort: 4319, intervalMs: 3_600_000 })
  await waitUntil(() => entry.status().listening, 'the remote entry to listen')
})

afterAll(async () => {
  await entry.close()
  db.close()
})

afterEach(() => {
  vi.restoreAllMocks()
})

const get = (target: string, headers: Array<[string, string]>, method = 'GET') => rawRequest(port, { method, target, headers })

/** Send, and say which counter rose (exactly one may rise on a refusal, none on success). */
async function attempt(request: () => Promise<RawResponse>): Promise<{ response: RawResponse; rose: Reason[] }> {
  const before = { ...entry.status().refused }
  const response = await request()
  const after = entry.status().refused
  const rose = (Object.keys(after) as Reason[]).filter((key) => after[key] !== before[key])
  for (const key of rose) expect(after[key] - before[key], key).toBe(1)
  return { response, rose }
}

async function expectRefused(reason: Reason, request: () => Promise<RawResponse>, method = 'GET') {
  const { response, rose } = await attempt(request)
  expect(response.status).toBe(403)
  // a HEAD answer has no body
  expect(response.body).toBe(method === 'HEAD' ? '' : 'Forbidden')
  expect(rose).toEqual([reason])
  // a refusal carries neither marker, and nothing from the app behind the gate
  expect(response.headers['x-agent-inbox-remote-boundary']).toBeUndefined()
  expect(response.headers['x-agent-inbox-local-boundary']).toBeUndefined()
  expect(response.headers['x-inbox-boot']).toBeUndefined()
}

async function expectPassed(request: () => Promise<RawResponse>, status = 200) {
  const { response, rose } = await attempt(request)
  expect(response.status).toBe(status)
  expect(rose).toEqual([])
  return response
}

describe('an accepted request', () => {
  it('answers with the remote marker, no-store, the loopback CSP and framing denial, never the loopback marker', async () => {
    const response = await expectPassed(() => get('/api/items', deviceHeaders(first)))
    expect(JSON.parse(response.body)).toHaveProperty('needsYou')
    expect(response.headers['x-agent-inbox-remote-boundary']).toBe('tailnet-v1')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['x-frame-options']).toBe('DENY')
    expect(response.headers['x-agent-inbox-local-boundary']).toBeUndefined()

    // the same CSP string the loopback entry sends, read from the loopback entry itself
    const local = startLocalViewer(createViewer(db, viewerOpts(dir)), 0)
    await waitUntil(() => local.listening, 'the loopback viewer')
    try {
      const localPort = (local.address() as { port: number }).port
      const loopback = await rawRequest(localPort, { target: '/api/items', headers: [['Host', `127.0.0.1:${localPort}`]] })
      expect(loopback.status).toBe(200)
      expect(response.headers['content-security-policy']).toBe(loopback.headers['content-security-policy'])
      expect(loopback.headers['x-agent-inbox-remote-boundary']).toBeUndefined()
    } finally {
      local.close()
    }
  })

  it('serves static files with the same headers, GET and HEAD', async () => {
    for (const method of ['GET', 'HEAD']) {
      const response = await expectPassed(() => get('/index.html', deviceHeaders(first), method))
      expect(response.headers['content-type']).toContain('text/html')
      expect(response.headers['x-agent-inbox-remote-boundary']).toBe('tailnet-v1')
      expect(response.headers['content-security-policy']).toContain("script-src 'self'")
      expect(response.headers['x-frame-options']).toBe('DENY')
      // a file of the page revalidates before each use; every /api/ answer stays no-store
      expect(response.headers['cache-control']).toBe('no-cache')
      expect(response.headers['etag']).toMatch(/^"[A-Za-z0-9_-]{43}"$/)
    }
    await expectPassed(() => get('/', deviceHeaders(first)))
    await expectPassed(() => get('/app.js', deviceHeaders(first)))
  })

  it('accepts any paired device, not only the first', async () => {
    await expectPassed(() => get('/api/items', deviceHeaders(second)))
  })

  it('a missing static file is a 404 that still carries the remote headers', async () => {
    const response = await expectPassed(() => get('/missing-module.js', deviceHeaders(first)), 404)
    expect(response.headers['x-agent-inbox-remote-boundary']).toBe('tailnet-v1')
  })
})

describe('step 1: Host', () => {
  it('is the setting host, any case, with or without :443', async () => {
    await expectPassed(() => get('/api/items', [['Host', 'HUB.Example.TS.NET'], ['Tailscale-User-Login', LOGIN], ['X-Agent-Inbox-Device', first]]))
    await expectPassed(() => get('/api/items', [['Host', `${HOST}:443`], ['Tailscale-User-Login', LOGIN], ['X-Agent-Inbox-Device', first]]))
  })

  it.each([
    ['another host', 'evil.example'],
    ['another port', `${HOST}:8443`],
    ['the loopback address (a direct request)', '127.0.0.1'],
    ['the loopback authority', `127.0.0.1:${4320}`],
    ['localhost', 'localhost'],
    ['a trailing dot', `${HOST}.`],
    ['a sibling node', 'laptop.example.ts.net'],
  ])('refuses %s', async (_name, host) => {
    await expectRefused('host', () => get('/api/items', [['Host', host], ['Tailscale-User-Login', LOGIN], ['X-Agent-Inbox-Device', first]]))
  })

  it('refuses the right host sent twice', async () => {
    await expectRefused('host', () => get('/api/items', [['Host', HOST], ['Host', HOST], ['Tailscale-User-Login', LOGIN], ['X-Agent-Inbox-Device', first]]))
  })

  it('a request with no Host never reaches the app', async () => {
    const response = await get('/api/items', [['Tailscale-User-Login', LOGIN], ['X-Agent-Inbox-Device', first]])
    expect([400, 403]).toContain(response.status)
    expect(response.headers['x-agent-inbox-remote-boundary']).toBeUndefined()
  })
})

describe('step 2: Funnel', () => {
  it.each(['?1', '', 'false', '0'])('refuses any Tailscale-Funnel-Request header (%j), whatever its case', async (value) => {
    await expectRefused('funnel', () => get('/api/items', deviceHeaders(first, [['Tailscale-Funnel-Request', value]])))
    await expectRefused('funnel', () => get('/api/items', deviceHeaders(first, [['tailscale-funnel-request', value]])))
  })
})

describe('step 3: the login', () => {
  it('is required', async () => {
    await expectRefused('login', () => get('/api/items', [['Host', HOST], ['X-Agent-Inbox-Device', first]]))
  })

  it('must be one of the logins, ignoring case', async () => {
    await expectPassed(() => get('/api/items', [['Host', HOST], ['Tailscale-User-Login', 'OWNER@Example.COM'], ['X-Agent-Inbox-Device', first]]))
    for (const login of ['other@example.com', 'owner@example.com.evil', ' owner@example.com x', '']) {
      await expectRefused('login', () => get('/api/items', [['Host', HOST], ['Tailscale-User-Login', login], ['X-Agent-Inbox-Device', first]]))
    }
  })

  it('refuses a duplicated or comma-joined header, even when every value is right', async () => {
    await expectRefused('login', () => get('/api/items', [['Host', HOST], ['Tailscale-User-Login', LOGIN], ['tailscale-user-login', LOGIN], ['X-Agent-Inbox-Device', first]]))
    await expectRefused('login', () => get('/api/items', [['Host', HOST], ['Tailscale-User-Login', `${LOGIN}, ${LOGIN}`], ['X-Agent-Inbox-Device', first]]))
    await expectRefused('login', () => get('/api/items', [['Host', HOST], ['Tailscale-User-Login', `${LOGIN},other@example.com`], ['X-Agent-Inbox-Device', first]]))
  })
})

describe('step 4: the path form, read from the raw request target', () => {
  it.each([
    ['an encoded letter', '/%61pi/setup'],
    ['an encoded letter in a static path', '/%69ndex.html'],
    ['encoded dots', '/static/%2e%2e/api/setup'],
    ['encoded dots under /api/', '/api/items/%2e%2e/setup'],
    ['a percent in the query', '/api/items?scope=%61ttention'],
    ['a double slash', '/api//items'],
    ['a leading double slash', '//api/items'],
    ['a double slash in the query', '/api/items?x=//y'],
    ['a backslash', '/api\\setup'],
    ['a backslash in a static path', '/static\\..\\api\\setup'],
    ['a dot-dot segment', '/static/../api/setup'],
    ['a dot-dot segment at the end', '/api/items/..'],
    ['a dot segment', '/./index.html'],
    ['a dot segment under /api/', '/api/./items'],
    ['a trailing slash on an API route', '/api/items/'],
    ['a trailing slash on /api', '/api/'],
    ['a fragment', '/api/items#x'],
    ['an absolute-form target', `http://${HOST}/api/items`],
  ])('refuses %s: %s', async (_name, target) => {
    await expectRefused('path', () => get(target, deviceHeaders(first)))
  })

  it('a non-ASCII byte never reaches the gate: Node\'s parser answers 400', async () => {
    const response = await get('/indexé.html', deviceHeaders(first))
    expect(response.status).toBe(400)
    expect(response.headers['x-agent-inbox-remote-boundary']).toBeUndefined()
  })

  it('allows a trailing slash outside /api/ and a plain query', async () => {
    await expectPassed(() => get('/api/items?scope=attention', deviceHeaders(first)))
    await expectPassed(() => get('/', deviceHeaders(first)))
  })

  // Over HTTP most of these are caught twice: node-server and Hono normalise the routed path, so
  // byte-equality refuses them as well. Here the routed path is the raw one, so each check stands alone.
  it.each([
    ['a percent', '/api/items%20'],
    ['a backslash', '/api\\setup'],
    ['a double slash', '/api//items'],
    ['a fragment', '/api/items#x'],
    ['a fragment in the query', '/api/items?x#y'],
    ['a dot segment', '/./index.html'],
    ['a dot-dot segment', '/static/../api/setup'],
    ['a trailing slash under /api/', '/api/items/'],
    ['no leading slash', 'api/items'],
    ['a space', '/index .html'],
    ['a control character', '/index\t.html'],
    ['an empty target', ''],
  ])('pathFormOk refuses %s even when the router agrees', (_name, raw) => {
    expect(pathFormOk(raw, raw.split('?')[0]!)).toBe(false)
  })

  it('pathFormOk refuses a path the router changed, and passes a plain one', () => {
    expect(pathFormOk('/api/items', '/api/setup')).toBe(false)
    expect(pathFormOk('/API/items', '/api/items')).toBe(false)
    expect(pathFormOk(undefined, '/api/items')).toBe(false)
    expect(pathFormOk('/api/items?scope=attention', '/api/items')).toBe(true)
    expect(pathFormOk('/static/', '/static/')).toBe(true)
  })

  it('reads the target as received: Hono itself would route these to an allowed path', async () => {
    // Without the raw-target check, `/api//items` would not reach the handler but `/%61pi/items`
    // decodes to /api/items in Hono's own path: proof the gate does not trust c.req.path alone.
    await expectRefused('path', () => get('/%61pi/items', deviceHeaders(first)))
    await expectRefused('path', () => get('/x/../api/items', deviceHeaders(first)))
  })
})

describe('step 5: Origin', () => {
  it('when present, must be https://<host>', async () => {
    await expectPassed(() => get('/api/items', deviceHeaders(first, [['Origin', ORIGIN]])))
    for (const origin of ['https://evil.example', `http://${HOST}`, `https://${HOST}:443`, `https://${HOST}/`, 'null', `https://HUB.example.ts.net`, 'https://laptop.example.ts.net']) {
      await expectRefused('origin', () => get('/api/items', deviceHeaders(first, [['Origin', origin]])))
    }
  })

  it('refuses the right origin sent twice', async () => {
    await expectRefused('origin', () => get('/api/items', deviceHeaders(first, [['Origin', ORIGIN], ['Origin', ORIGIN]])))
  })
})

describe('step 6: unsafe methods', () => {
  const close = (headers: Array<[string, string]>) => rawRequest(port, { method: 'POST', target: '/api/projects/close', headers, body: '{}' })

  it('need the Origin', async () => {
    await expectRefused('origin', () => close(deviceHeaders(first)))
  })

  it.each(['same-site', 'cross-site', 'SAME-SITE', 'garbage'])('refuse Sec-Fetch-Site %s', async (site) => {
    await expectRefused('origin', () => close(deviceHeaders(first, [['Origin', ORIGIN], ['Sec-Fetch-Site', site]])))
  })

  it('refuse a duplicated Sec-Fetch-Site', async () => {
    await expectRefused('origin', () => close(deviceHeaders(first, [['Origin', ORIGIN], ['Sec-Fetch-Site', 'same-origin'], ['Sec-Fetch-Site', 'same-origin']])))
  })

  it.each([['same-origin'], ['none'], [undefined]])('pass with the Origin and Sec-Fetch-Site %s (the handler answers 400 for the empty body)', async (site) => {
    const extra: Array<[string, string]> = [['Origin', ORIGIN]]
    if (site) extra.push(['Sec-Fetch-Site', site])
    const response = await expectPassed(() => close(deviceHeaders(first, extra)), 400)
    expect(response.headers['x-agent-inbox-remote-boundary']).toBe('tailnet-v1')
  })
})

describe('step 6: Fetch Metadata on every method', () => {
  // A later PR has the laptop app add the device header by URL filter, so a no-cors GET from another
  // page in that session would carry it: Sec-Fetch-Site is checked on safe methods too.
  it.each([
    ['GET', 'cross-site'], ['GET', 'same-site'], ['GET', ''], ['GET', 'SAME-SITE'],
    ['HEAD', 'cross-site'], ['HEAD', 'same-site'], ['OPTIONS', 'cross-site'],
  ])('%s with Sec-Fetch-Site %j is refused', async (method, site) => {
    await expectRefused('origin', () => get('/api/items', deviceHeaders(first, [['Sec-Fetch-Site', site]]), method), method)
  })

  it.each(['GET', 'HEAD'])('%s with a repeated Sec-Fetch-Site is refused', async (method) => {
    await expectRefused('origin', () => get('/index.html', deviceHeaders(first, [['Sec-Fetch-Site', 'same-origin'], ['Sec-Fetch-Site', 'same-origin']]), method), method)
  })

  it.each([['GET', 'same-origin'], ['GET', 'none'], ['HEAD', 'same-origin'], ['GET', 'Same-Origin']])('%s with Sec-Fetch-Site %s passes', async (method, site) => {
    await expectPassed(() => get('/api/items', deviceHeaders(first, [['Sec-Fetch-Site', site]]), method))
  })
})

describe('step 7: pairing (PR 2b; test/remote-pair.test.ts covers it in full)', () => {
  it('POST /api/remote/pair passes with the login alone to the pairing handler, which refuses with no code pending', async () => {
    const pair = (headers: Array<[string, string]>) => rawRequest(port, { method: 'POST', target: '/api/remote/pair', headers, body: '{"code":"7K3QX-9M2PD","label":"laptop"}' })
    await expectRefused('pair', () => pair([['Host', HOST], ['Tailscale-User-Login', LOGIN], ['Origin', ORIGIN]]))
    // a device header is ignored on it
    await expectRefused('pair', () => pair(deviceHeaders(first, [['Origin', ORIGIN]])))
  })

  it('a query string gets no login-only pass', async () => {
    const pair = (headers: Array<[string, string]>) => rawRequest(port, { method: 'POST', target: '/api/remote/pair?x=1', headers, body: '{"code":"7K3QX-9M2PD","label":"laptop"}' })
    await expectRefused('device', () => pair([['Host', HOST], ['Tailscale-User-Login', LOGIN], ['Origin', ORIGIN]]))
    await expectRefused('route', () => pair(deviceHeaders(first, [['Origin', ORIGIN]])))
  })
})

describe('step 8: the device', () => {
  const headers = (value?: string | string[]): Array<[string, string]> => {
    const base: Array<[string, string]> = [['Host', HOST], ['Tailscale-User-Login', LOGIN]]
    for (const v of value === undefined ? [] : Array.isArray(value) ? value : [value]) base.push(['X-Agent-Inbox-Device', v])
    return base
  }

  it('is required', async () => {
    await expectRefused('device', () => get('/api/items', headers()))
  })

  it('refuses a well-formed secret no device holds', async () => {
    await expectRefused('device', () => get('/api/items', headers(newSecret())))
  })

  it('refuses the hash sent in place of the secret', async () => {
    await expectRefused('device', () => get('/api/items', headers(secretSha256(first))))
  })

  it.each([
    ['42 characters', () => first.slice(0, 42)],
    ['44 characters', () => `${first}A`],
    ['base64 padding', () => `${first.slice(0, 42)}=`],
    ['a plus', () => `${first.slice(0, 42)}+`],
    ['a slash', () => `${first.slice(0, 42)}/`],
    ['a space inside', () => `${first.slice(0, 20)} ${first.slice(21)}`],
    ['empty', () => ''],
  ])('refuses a malformed value: %s', async (_name, value) => {
    await expectRefused('device', () => get('/api/items', headers(value())))
  })

  it('refuses a duplicated header, even with a right value in it', async () => {
    await expectRefused('device', () => get('/api/items', headers([first, first])))
    await expectRefused('device', () => get('/api/items', headers([newSecret(), first])))
  })

  it('compares with every paired device by timingSafeEqual, with no early exit', async () => {
    const timing = vi.spyOn(crypto, 'timingSafeEqual')
    await expectPassed(() => get('/api/items', headers(first)))
    expect(timing).toHaveBeenCalledTimes(2)
    for (const [a, b] of timing.mock.calls) {
      expect((a as Buffer).length).toBe(32)
      expect((b as Buffer).length).toBe(32)
    }
    timing.mockClear()
    await expectRefused('device', () => get('/api/items', headers(third)))
    expect(timing).toHaveBeenCalledTimes(2)
    // a malformed value is refused on its form, before any hash or compare
    timing.mockClear()
    await expectRefused('device', () => get('/api/items', headers(`${first.slice(0, 42)}=`)))
    expect(timing).not.toHaveBeenCalled()
  })
})

describe('step 9: the route', () => {
  it.each([
    ['GET', '/api/setup'],
    ['HEAD', '/api/setup'],
    ['GET', '/api/owner'],
    ['GET', '/api/remote-entry'],
    ['GET', '/api/launches'],
    ['GET', '/api/launch-folders'],
    ['GET', '/api/chats/copilot/00000000-0000-4000-8000-000000000000'],
    ['GET', '/api/no-such-route'],
    ['GET', '/api'],
    ['OPTIONS', '/api/items'],
    ['PUT', '/api/items'],
    ['GET', '/api/items/x/resolve'],
  ])('refuses %s %s', async (method, target) => {
    await expectRefused('route', () => get(target, deviceHeaders(first, [['Origin', ORIGIN]]), method), method)
  })

  it.each([
    ['/api/launches/x/stop'],
    ['/api/launches/x/forget'],
    ['/api/launch-asks/x/answer'],
    ['/api/items/x/resolve/extra'],
  ])('refuses POST %s', async (target) => {
    await expectRefused('route', () => rawRequest(port, { method: 'POST', target, headers: deviceHeaders(first, [['Origin', ORIGIN], ['Sec-Fetch-Site', 'same-origin']]), body: '{}' }))
  })

  // The static rule is case-sensitive on purpose: /API/setup is not an /api/ path, so the gate lets
  // it through as a static GET. That is safe because Hono's routing is case-sensitive: no API
  // handler matches it, and the static handler finds no such file and answers 404.
  it.each(['/API/setup', '/Api/owner', '/API/items'])('lets %s through as a static path, which answers 404, never an API handler', async (target) => {
    const response = await expectPassed(() => get(target, deviceHeaders(first)), 404)
    expect(response.headers['content-type'] ?? '').not.toContain('application/json')
    expect(response.body).not.toMatch(/"(token|needsYou|agents|build)"/)
    expect(response.headers['x-agent-inbox-remote-boundary']).toBe('tailnet-v1')
  })

  it('remoteRouteAllowed matches a :param to one non-empty segment, and static files only outside /api', () => {
    expect(remoteRouteAllowed('POST', '/api/items/x/resolve')).toBe(true)
    expect(remoteRouteAllowed('POST', '/api/items//resolve')).toBe(false)
    expect(remoteRouteAllowed('POST', '/api/items/x/y/resolve')).toBe(false)
    expect(remoteRouteAllowed('GET', '/api/items/x/resolve')).toBe(false)
    expect(remoteRouteAllowed('GET', '/apix.js')).toBe(true)
    expect(remoteRouteAllowed('GET', '/api')).toBe(false)
    expect(remoteRouteAllowed('POST', '/index.html')).toBe(false)
    // the gate reads HEAD as GET before it asks
    expect(remoteRouteAllowed('HEAD', '/index.html')).toBe(false)
  })
})

describe('the order of the steps', () => {
  // each request fails every step from the named one on; only the first is counted
  it('counts only the first failing step', async () => {
    const all: Array<[string, string]> = [['Tailscale-Funnel-Request', '?1'], ['Origin', 'https://evil.example']]
    await expectRefused('host', () => get('/api//setup', [['Host', 'evil.example'], ...all]))
    await expectRefused('funnel', () => get('/api//setup', [['Host', HOST], ...all]))
    await expectRefused('login', () => get('/api//setup', [['Host', HOST], ['Origin', 'https://evil.example']]))
    await expectRefused('path', () => get('/api//setup', [['Host', HOST], ['Tailscale-User-Login', LOGIN], ['Origin', 'https://evil.example']]))
    await expectRefused('origin', () => get('/api/setup', [['Host', HOST], ['Tailscale-User-Login', LOGIN], ['Origin', 'https://evil.example']]))
    await expectRefused('origin', () => rawRequest(port, { method: 'POST', target: '/api/launches/x/stop', headers: [['Host', HOST], ['Tailscale-User-Login', LOGIN]], body: '{}' }))
    await expectRefused('device', () => get('/api/setup', [['Host', HOST], ['Tailscale-User-Login', LOGIN], ['Origin', ORIGIN]]))
    await expectRefused('route', () => get('/api/setup', deviceHeaders(first, [['Origin', ORIGIN]])))
  })
})

describe('nothing sensitive reaches a log', () => {
  it('logs no login, header value, secret, hash or query', async () => {
    const lines: string[] = []
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')) })
    }
    await get('/api/items?scope=attention', deviceHeaders(first))
    await get('/api/items', deviceHeaders(newSecret()))
    await get('/api/setup?x=1', deviceHeaders(first))
    await get('/api/items', [['Host', HOST], ['Tailscale-User-Login', 'other@example.com']])
    const text = lines.join('\n')
    for (const secret of [LOGIN, 'other@example.com', first, secretSha256(first), 'scope=attention', 'x=1', HOST]) {
      expect(text).not.toContain(secret)
    }
  })
})

describe('the status', () => {
  it('holds counts only: no login, header value, hash, label or device not paired here', () => {
    const status = entry.status()
    expect(Object.keys(status).sort()).toEqual(['codePending', 'error', 'host', 'listening', 'on', 'paired', 'port', 'refused'])
    expect(Object.keys(status.refused).sort()).toEqual(['device', 'funnel', 'host', 'login', 'origin', 'pair', 'path', 'route'])
    // only devices this viewer paired are listed (PR 2b); the file's own are not
    expect(status.paired).toEqual([])
    const text = JSON.stringify(status)
    for (const secret of [LOGIN, first, secretSha256(first), '1111111111111111', 'laptop']) expect(text).not.toContain(secret)
  })
})
