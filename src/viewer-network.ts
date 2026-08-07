import type { Server } from 'node:http'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'

const LOOPBACK_HOST = '127.0.0.1'
const BOUNDARY_HEADER = 'x-agent-inbox-local-boundary'
const BOUNDARY_VERSION = 'loopback-v1'
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function listenerPort(server: Server | null, configuredPort: number): number {
  const address = server?.address()
  return address && typeof address !== 'string' ? address.port : configuredPort
}

function trustedAuthorities(port: number): Set<string> {
  const authorities = new Set([
    `${LOOPBACK_HOST}:${port}`,
    `localhost:${port}`,
  ])
  if (port === 80) {
    authorities.add(LOOPBACK_HOST)
    authorities.add('localhost')
  }
  return authorities
}

function trustedOrigins(port: number): Set<string> {
  const origins = new Set([
    `http://${LOOPBACK_HOST}:${port}`,
    `http://localhost:${port}`,
  ])
  if (port === 80) {
    origins.add(`http://${LOOPBACK_HOST}`)
    origins.add('http://localhost')
  }
  return origins
}

export function startLocalViewer(app: Hono, port: number): Server {
  let server: Server | null = null
  const guarded = new Hono()

  // This gate must precede app.route(). Adding middleware to createViewer after
  // its routes are registered would let Hono match those routes first.
  guarded.use('*', async (c, next) => {
    const activePort = listenerPort(server, port)
    const host = c.req.header('host')?.trim().toLowerCase()
    if (!host || !trustedAuthorities(activePort).has(host)) {
      return c.text('Forbidden', 403)
    }

    const origin = c.req.header('origin')
    if (origin !== undefined && !trustedOrigins(activePort).has(origin)) {
      return c.text('Forbidden', 403)
    }

    const fetchSite = c.req.header('sec-fetch-site')?.toLowerCase()
    if (
      !SAFE_METHODS.has(c.req.method)
      && origin === undefined
      && fetchSite !== undefined
      && fetchSite !== 'same-origin'
      && fetchSite !== 'same-site'
      && fetchSite !== 'none'
    ) {
      return c.text('Forbidden', 403)
    }

    await next()
    c.header(BOUNDARY_HEADER, BOUNDARY_VERSION)
    c.header('Content-Security-Policy', "frame-ancestors 'none'")
    c.header('X-Frame-Options', 'DENY')
  })

  guarded.route('/', app)
  server = serve({
    fetch: guarded.fetch,
    hostname: LOOPBACK_HOST,
    port,
  }) as Server
  return server
}
