import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { request } from 'node:http'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let child: ChildProcess
let baseUrl: string

beforeAll(async () => {
  child = spawn(process.execPath, [resolve('scripts/serve-marketing.mjs'), '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  baseUrl = await new Promise<string>((resolveUrl, reject) => {
    let output = ''
    let stderr = ''
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', code => reject(new Error(`Marketing server exited ${code}: ${stderr}`)))
    child.stdout?.on('data', chunk => {
      output += String(chunk)
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/)
      if (match) resolveUrl(match[0])
    })
  })
})

afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await exited
  }
})

describe('isolated marketing preview server', () => {
  it('serves the marketing page with no caching and a restricted content policy', async () => {
    const response = await fetch(baseUrl)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'none'")
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(await response.text()).toContain('every terminal.')
  })

  it('serves HEAD without a body', async () => {
    const response = await fetch(baseUrl, { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
  })

  it.each(['/api/items', '/api/boards', '/package.json', '/.git/config', '/src/store.ts'])(
    'does not expose the app or checkout through %s',
    async pathname => {
      expect((await fetch(baseUrl + pathname)).status).toBe(404)
    },
  )

  it('refuses mutations', async () => {
    const response = await fetch(baseUrl, { method: 'POST', body: 'sample' })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, HEAD')
  })

  it('refuses a non-loopback Host', async () => {
    const status = await new Promise<number | undefined>((resolveStatus, reject) => {
      const req = request(baseUrl, { headers: { Host: 'example.com' } }, response => {
        response.resume()
        resolveStatus(response.statusCode)
      })
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(403)
  })

  it('rejects an invalid port instead of silently using a fallback', async () => {
    const invalid = spawn(process.execPath, [resolve('scripts/serve-marketing.mjs'), '--port', 'invalid'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    invalid.stderr?.on('data', chunk => { stderr += String(chunk) })
    const [code] = await once(invalid, 'exit')
    expect(code).toBe(1)
    expect(stderr).toContain('port')
  })
})
