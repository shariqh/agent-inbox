// Slow links, step 1, the server half: both listeners compress answers (hono/compress) and the
// page's own files can be revalidated (src/viewer-static.ts). Real HTTP against the real loopback
// listener and the real remote entry, each wrapping a createViewer app built as
// src/viewer-server.ts builds it. Fixtures are synthetic (hub.example.ts.net, owner@example.com, laptop).
import type Database from 'better-sqlite3'
import { request } from 'node:http'
import type { Server } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync, inflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertItem, openDb, upsertBoard } from '../src/store.js'
import { createViewer } from '../src/viewer.js'
import { startLocalViewer } from '../src/viewer-network.js'
import { startRemoteEntry } from '../src/viewer-remote.js'
import type { RemoteEntry } from '../src/viewer-remote.js'
import { staticFiles } from '../src/viewer-static.js'
import { FILE_PATH, linkedFiles } from '../src/remote-file.js'
import { scratchDir } from './scratch.js'
import { waitUntil } from './wait.js'
import { HOST, LOGIN, device, deviceHeaders, freePort, newSecret, setting, writeSetting } from './remote-fixtures.js'

interface Answer {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

let dir: string
let root: string
let db: Database.Database
let local: Server
let localPort: number
let entry: RemoteEntry
let remotePort: number
let itemId: string
const laptop = newSecret()

// a script long enough to compress, and an image that is not text
const script = (version: number) => `// page script ${version}\n${'export const line = "the same line again and again"\n'.repeat(80)}`
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(4096, 7)])

beforeAll(async () => {
  dir = scratchDir('slow-link-server-')
  root = join(dir, 'public')
  mkdirSync(root)
  writeFileSync(join(root, 'page.js'), script(1))
  writeFileSync(join(root, 'picture.png'), PNG)
  writeFileSync(join(dir, 'spec.md'), '# The spec\n'.repeat(200))
  db = openDb(join(dir, 'inbox.db'))
  for (let n = 0; n < 6; n++) {
    upsertBoard(db, { project: 'p', stream: 's', agent: 'a', title: `Plan ${n}`, rows: Array.from({ length: 8 }, (_, i) => ({ label: `step ${i}`, status: 'tracked', note: `the note of step ${i}` })) })
  }
  itemId = insertItem(db, { project: 'p', stream: 's', agent: 'a', kind: 'note', title: `Read ${join(dir, 'spec.md')}` })
  const opts = { agentHome: dir, runtimeRoot: join(dir, 'runtime'), setupInfoPath: join(dir, 'setup-info.json'), stamp: async () => ({ commit: null, dirty: false }) as never }

  const app = createViewer(db, opts)
  app.get('/*', staticFiles(root))
  local = startLocalViewer(app, 0)

  remotePort = await freePort()
  writeSetting(dir, setting(remotePort, [device(laptop)]))
  const remoteApp = createViewer(db, opts)
  remoteApp.get('/*', staticFiles(root))
  entry = startRemoteEntry({ app: remoteApp, dir, viewerPort: 4319, intervalMs: 3_600_000, files: { linked: linkedFiles(db), home: dir } })
  await waitUntil(() => entry.status().listening && local.listening, 'both listeners')
  localPort = (local.address() as { port: number }).port
})

afterAll(async () => {
  local.close()
  await entry.close()
  db.close()
})

function send(port: number, path: string, headers: Array<[string, string]>, method = 'GET'): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, agent: false, headers: Object.fromEntries(headers) }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
}

const LISTENERS = [
  { name: 'the loopback viewer', port: () => localPort, headers: (): Array<[string, string]> => [['Host', `127.0.0.1:${localPort}`]] },
  { name: 'the remote entry', port: () => remotePort, headers: (): Array<[string, string]> => deviceHeaders(laptop) },
] as const

const decoded = (answer: Answer): Buffer => {
  const encoding = answer.headers['content-encoding']
  if (encoding === 'gzip') return gunzipSync(answer.body)
  if (encoding === 'deflate') return inflateSync(answer.body)
  return answer.body
}

describe.each(LISTENERS)('$name', ({ port, headers }) => {
  const get = (path: string, extra: Array<[string, string]> = [], method = 'GET') => send(port(), path, [...headers(), ...extra], method)
  const GZIP: Array<[string, string]> = [['Accept-Encoding', 'gzip']]

  describe('compression', () => {
    it('compresses /api/boards, weakens its tag, and a weak tag still revalidates', async () => {
      const plain = await get('/api/boards')
      const zipped = await get('/api/boards', GZIP)
      expect(zipped.status).toBe(200)
      expect(zipped.headers['content-encoding']).toBe('gzip')
      expect(String(zipped.headers['vary'])).toMatch(/accept-encoding/i)
      expect(zipped.headers['etag']).toMatch(/^W\/"boards-[0-9a-f]{64}"$/)
      expect(zipped.body.length).toBeLessThan(plain.body.length)
      // the decompressed body is the uncompressed body, byte for byte
      expect(decoded(zipped).equals(plain.body)).toBe(true)

      const again = await get('/api/boards', [...GZIP, ['If-None-Match', String(zipped.headers['etag'])]])
      expect(again.status).toBe(304)
      expect(again.body.length).toBe(0)
      expect(again.headers['content-encoding']).toBeUndefined()
      expect(again.headers['cache-control']).toBe('no-store')
    })

    it('sends the same bytes as before with the strong tag to a client that asks for no encoding', async () => {
      const plain = await get('/api/boards')
      expect(plain.status).toBe(200)
      expect(plain.headers['content-encoding']).toBeUndefined()
      expect(plain.headers['etag']).toMatch(/^"boards-[0-9a-f]{64}"$/)
      expect(JSON.parse(plain.body.toString('utf8'))).toHaveLength(6)
    })

    it('compresses with deflate when only deflate is accepted', async () => {
      const plain = await get('/page.js')
      const deflated = await get('/page.js', [['Accept-Encoding', 'deflate']])
      expect(deflated.headers['content-encoding']).toBe('deflate')
      expect(decoded(deflated).equals(plain.body)).toBe(true)
    })

    it('leaves a HEAD, a 206 and a file that is not text alone', async () => {
      const head = await get('/page.js', GZIP, 'HEAD')
      expect(head.status).toBe(200)
      expect(head.headers['content-encoding']).toBeUndefined()
      expect(head.body.length).toBe(0)

      const range = await get('/page.js', [...GZIP, ['Range', 'bytes=0-99']])
      expect(range.status).toBe(206)
      expect(range.headers['content-encoding']).toBeUndefined()
      expect(range.body.toString('utf8')).toBe(script(1).slice(0, 100))
      expect(range.headers['etag']).toBeUndefined()
      expect(range.headers['cache-control']).toBe('no-store')

      const picture = await get('/picture.png', GZIP)
      expect(picture.status).toBe(200)
      expect(picture.headers['content-encoding']).toBeUndefined()
      expect(picture.headers['content-length']).toBe(String(PNG.length))
      expect(picture.body.equals(PNG)).toBe(true)
    })
  })

  describe('the page\'s own files', () => {
    it.each([[[] as Array<[string, string]>], [[['Accept-Encoding', 'gzip']] as Array<[string, string]>]])(
      'answer with a content tag and no-cache, and 304 to that tag (headers %j)',
      async (extra) => {
        for (const method of ['GET', 'HEAD']) {
          const first = await get('/page.js', extra, method)
          expect(first.status, method).toBe(200)
          expect(first.headers['cache-control'], method).toBe('no-cache')
          const tag = String(first.headers['etag'])
          expect(tag, method).toMatch(/^(W\/)?"[A-Za-z0-9_-]{43}"$/)

          const again = await get('/page.js', [...extra, ['If-None-Match', tag]], method)
          expect(again.status, method).toBe(304)
          expect(again.body.length, method).toBe(0)
          expect(again.headers['cache-control'], method).toBe('no-cache')
          expect(String(again.headers['etag']).replace(/^W\//, ''), method).toBe(tag.replace(/^W\//, ''))
        }
      },
    )

    it('the compressed answer\'s weak tag and the plain strong tag name the same file', async () => {
      const plain = await get('/page.js')
      const zipped = await get('/page.js', GZIP)
      expect(zipped.headers['content-encoding']).toBe('gzip')
      expect(zipped.headers['etag']).toBe(`W/${String(plain.headers['etag'])}`)
      // each tag revalidates the other answer
      expect((await get('/page.js', [['If-None-Match', String(zipped.headers['etag'])]])).status).toBe(304)
      expect((await get('/page.js', [...GZIP, ['If-None-Match', String(plain.headers['etag'])]])).status).toBe(304)
    })

    it('a changed file answers 200 with a new tag', async () => {
      const before = await get('/page.js')
      writeFileSync(join(root, 'page.js'), script(2))
      try {
        const after = await get('/page.js', [['If-None-Match', String(before.headers['etag'])]])
        expect(after.status).toBe(200)
        expect(after.body.toString('utf8')).toBe(script(2))
        expect(after.headers['etag']).not.toBe(before.headers['etag'])
        expect(after.headers['cache-control']).toBe('no-cache')
      } finally {
        writeFileSync(join(root, 'page.js'), script(1))
      }
    })

    it('a missing file is a 404 with no-store', async () => {
      const missing = await get('/missing-module.js', GZIP)
      expect(missing.status).toBe(404)
      expect(missing.headers['cache-control']).toBe('no-store')
      expect(missing.headers['etag']).toBeUndefined()
    })
  })

  it.each(['/api/items', '/api/boards', '/api/version', '/api/activity'])('%s still says no-store', async (path) => {
    for (const extra of [[], GZIP]) {
      const answer = await get(path, extra)
      expect(answer.status).toBe(200)
      expect(answer.headers['cache-control']).toBe('no-store')
    }
  })
})

describe('the guards\' refusals are as they were', () => {
  it('a 403 at the loopback guard carries no Cache-Control and no encoding', async () => {
    const refused = await send(localPort, '/page.js', [['Host', 'inbox.attacker.example'], ['Accept-Encoding', 'gzip']])
    expect(refused.status).toBe(403)
    expect(refused.body.toString('utf8')).toBe('Forbidden')
    expect(refused.headers['cache-control']).toBeUndefined()
    expect(refused.headers['content-encoding']).toBeUndefined()
  })

  it('a 403 at the remote gate carries no Cache-Control and no encoding', async () => {
    const refused = await send(remotePort, '/page.js', [['Host', HOST], ['Tailscale-User-Login', LOGIN], ['Accept-Encoding', 'gzip']])
    expect(refused.status).toBe(403)
    expect(refused.body.toString('utf8')).toBe('Forbidden')
    expect(refused.headers['cache-control']).toBeUndefined()
    expect(refused.headers['content-encoding']).toBeUndefined()
  })
})

describe('the remote file route', () => {
  it('streams a linked file untouched, its length kept, to a client that accepts gzip', async () => {
    const path = Buffer.from(join(dir, 'spec.md'), 'utf8').toString('base64url')
    const answer = await send(remotePort, `${FILE_PATH}?kind=item&id=${itemId}&path=${path}`, [...deviceHeaders(laptop), ['Accept-Encoding', 'gzip']])
    expect(answer.status).toBe(200)
    expect(answer.headers['content-type']).toBe('application/octet-stream')
    expect(answer.headers['content-encoding']).toBeUndefined()
    expect(answer.headers['content-length']).toBe(String('# The spec\n'.length * 200))
    expect(answer.body.toString('utf8')).toBe('# The spec\n'.repeat(200))
    expect(answer.headers['cache-control']).toBe('no-store')
  })
})
