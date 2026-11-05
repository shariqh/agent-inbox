import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { request } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { startLocalViewer } from '../src/viewer-network.js'

// #412: scripts only from this origin, no plugins, <base> or form submissions, no framing.
const CSP = "script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

interface HttpResult {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

describe('local viewer network boundary', () => {
  let server: Server
  let port: number

  beforeAll(async () => {
    const app = new Hono()
    app.get('/', (c) => c.text('viewer'))
    app.get('/api/secret', (c) => c.json({ secret: true }))
    app.post('/api/mutate', (c) => c.json({ mutated: true }))
    app.get('/*', serveStatic({ root: './public' }))

    server = startLocalViewer(app, 0)
    if (!server.listening) await once(server, 'listening')
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    if (!server.listening) return
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  })

  function send(
    path: string,
    {
      method = 'GET',
      host = `127.0.0.1:${port}`,
      origin,
      fetchSite,
    }: {
      method?: string
      host?: string
      origin?: string
      fetchSite?: string
    } = {},
  ): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { host }
      if (origin !== undefined) headers.origin = origin
      if (fetchSite !== undefined) headers['sec-fetch-site'] = fetchSite
      const req = request(
        { hostname: '127.0.0.1', port, path, method, headers },
        (res) => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => { body += chunk })
          res.on('end', () => resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
          }))
        },
      )
      req.on('error', reject)
      req.end()
    })
  }

  it('opens a real IPv4 socket on 127.0.0.1 rather than a wildcard interface', () => {
    expect(server.address()).toMatchObject({
      address: '127.0.0.1',
      family: 'IPv4',
      port,
    })
  })

  it('serves the canonical authority and attests the hardened boundary', async () => {
    const response = await send('/')
    expect(response.status).toBe(200)
    expect(response.body).toBe('viewer')
    expect(response.headers['x-agent-inbox-local-boundary']).toBe('loopback-v1')
    expect(response.headers['content-security-policy']).toBe(CSP)
    expect(response.headers['x-frame-options']).toBe('DENY')
  })

  it.each([
    ['GET', '/index.html', 200, 'text/html'],
    ['HEAD', '/index.html', 200, 'text/html'],
    ['GET', '/app.js', 200, 'javascript'],
    ['GET', '/api/secret', 200, 'application/json'],
    ['GET', '/missing-module.js', 404, undefined],
  ] as const)('sends the full CSP on %s %s', async (method, path, status, type) => {
    const response = await send(path, { method })
    expect(response.status).toBe(status)
    if (type) expect(String(response.headers['content-type'])).toContain(type)
    expect(response.headers['content-security-policy']).toBe(CSP)
    expect(response.headers['x-frame-options']).toBe('DENY')
  })

  it('keeps Electron reuse independent of the CSP string', () => {
    // An older app (v2.2.0) accepts a newer viewer, and a newer app an older one,
    // because reuse and ownership compare only the boundary marker. Never bump the
    // marker or make main read the CSP to tighten the policy.
    const main = readFileSync(join(process.cwd(), 'electron/main.cjs'), 'utf8')
    const network = readFileSync(join(process.cwd(), 'src/viewer-network.ts'), 'utf8')
    expect(main).toContain("const BOUNDARY_VERSION = 'loopback-v1'")
    expect(network).toContain("const BOUNDARY_VERSION = 'loopback-v1'")
    expect(main.toLowerCase()).not.toContain('content-security-policy')
  })

  describe.each(['GET', 'HEAD'])('%s cache policy', (method) => {
    it.each(['/index.html', '/app.js', '/card.js', '/rowview.js', '/style.css'])(
      'prevents heuristic caching of the unversioned resource %s',
      async (path) => {
        const response = await send(path, { method })
        expect(response.status).toBe(200)
        expect(response.headers['last-modified']).toBeDefined()
        expect(response.headers['cache-control']).toBe('no-store')
        if (method === 'HEAD') expect(response.body).toBe('')
      },
    )
  })

  it.each([
    ['/', 200],
    ['/api/secret', 200],
    ['/missing-module.js', 404],
  ] as const)('keeps the cache policy on viewer response %s', async (path, status) => {
    const response = await send(path)
    expect(response.status).toBe(status)
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('keeps localhost as an exact browser alias', async () => {
    const response = await send('/api/mutate', {
      method: 'POST',
      host: `localhost:${port}`,
      origin: `http://localhost:${port}`,
      fetchSite: 'same-origin',
    })
    expect(response.status).toBe(200)
    expect(response.body).toContain('"mutated":true')
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('rejects attacker-controlled Host before the viewer app', async () => {
    const response = await send('/api/secret', { host: `inbox.attacker.example:${port}` })
    expect(response.status).toBe(403)
    expect(response.body).not.toContain('secret')
  })

  it('rejects hostile and opaque browser origins', async () => {
    expect((await send('/api/secret', {
      origin: 'https://attacker.example',
      fetchSite: 'cross-site',
    })).status).toBe(403)
    expect((await send('/api/mutate', {
      method: 'POST',
      origin: 'null',
      fetchSite: 'cross-site',
    })).status).toBe(403)
  })

  it('rejects cross-site Fetch Metadata even when Origin is forged as trusted', async () => {
    const response = await send('/api/mutate', {
      method: 'POST',
      origin: `http://127.0.0.1:${port}`,
      fetchSite: 'cross-site',
    })
    expect(response.status).toBe(403)
  })

  it('requires a trusted Origin for every browser or native loopback mutation', async () => {
    expect((await send('/api/mutate', {
      method: 'POST',
      origin: `http://127.0.0.1:${port}`,
      fetchSite: 'same-origin',
    })).status).toBe(200)
    expect((await send('/api/mutate', {
      method: 'POST',
      origin: `http://127.0.0.1:${port}`,
    })).status).toBe(200)
    expect((await send('/api/mutate', { method: 'POST' })).status).toBe(403)
  })
})
