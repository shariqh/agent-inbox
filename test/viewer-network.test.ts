import { once } from 'node:events'
import { request } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { startLocalViewer } from '../src/viewer-network.js'

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
    expect(response.headers['content-security-policy']).toBe("frame-ancestors 'none'")
    expect(response.headers['x-frame-options']).toBe('DENY')
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
