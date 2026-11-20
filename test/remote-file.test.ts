// A card's files from the connecting Mac (#634), the hub's half: GET /api/remote/file on the remote
// entry serves a file a card already links, read-only, as a download, to a paired device. Every rule
// here is a table of hostile inputs: the request's form, the path's whole-path rule in a card's text,
// the file checks after symbolic links are resolved (a link to a directory, to a type off the list, a
// file swapped between the check and the read), the size limit while reading, and the route through
// the real gate and listener. Fixtures are synthetic (hub.example.ts.net, owner@example.com, laptop).
import { serveStatic } from '@hono/node-server/serve-static'
import type Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { chmodSync, closeSync, mkdirSync, openSync, renameSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { archiveBoard, getBoardRow, insertItem, listBoards, openDb, upsertBoard } from '../src/store.js'
import { createViewer } from '../src/viewer.js'
import { startLocalViewer } from '../src/viewer-network.js'
import { GUARDED_ROUTES, remoteRouteAllowed, startRemoteEntry } from '../src/viewer-remote.js'
import type { RemoteEntry } from '../src/viewer-remote.js'
import {
  DOCUMENT_EXTENSIONS, FILE_MAX, FILE_PATH, documentName, entityTexts, fileStream, linkedPathForm, linkedTexts,
  linksPath, openLinkedFile, readFileQuery, remoteFileRoute,
} from '../src/remote-file.js'
import { removeScratchDirs, scratchDir } from './scratch.js'
import { waitUntil } from './wait.js'
import { HOST, LOGIN, deviceHeaders, freePort, newSecret, rawRequest, setting, writeSetting, device } from './remote-fixtures.js'

const b64 = (path: string) => Buffer.from(path, 'utf8').toString('base64url')
const target = (kind: string, id: string, path: string) => `${FILE_PATH}?kind=${kind}&id=${id}&path=${b64(path)}`
const ITEM = '6f1c2d3e-4a5b-4c6d-8e7f-001122334455'

describe('the document list', () => {
  it('is exactly the inert documents and images the brief names: no HTML, no SVG, nothing executable', () => {
    expect([...DOCUMENT_EXTENSIONS].sort()).toEqual(
      ['.csv', '.gif', '.jpeg', '.jpg', '.json', '.log', '.markdown', '.md', '.pdf', '.png', '.tsv', '.txt', '.webp', '.yaml', '.yml'],
    )
  })

  it.each([
    ['spec.md', true], ['notes.markdown', true], ['run.log', true], ['LOGO.PNG', true], ['a.b.json', true], ['.hidden.md', true],
    ['page.html', false], ['page.htm', false], ['icon.svg', false], ['tool.command', false], ['run.sh', false], ['app.app', false],
    ['spec.md.exe', false], ['md', false], ['.md', false], ['spec.', false], ['spec', false], ['report.pdf ', false], ['x.mdx', false],
  ])('%s is a document: %s', (name, expected) => {
    expect(documentName(name)).toBe(expected)
  })
})

describe('linkedPathForm: what a request may name', () => {
  it.each([
    '/Users/owner/docs/spec.md', '~/docs/spec.md', '/tmp/ü-notes.md', '/Users/owner/My notes.md', '/Users/owner/%2e%2e/x.md',
    '/Users/owner/a?x=1.md', '/Volumes/disk/report.pdf',
  ])('takes %s', (path) => {
    expect(linkedPathForm(path)).toBe(true)
  })

  it.each([
    ['empty', ''],
    ['relative', 'docs/spec.md'],
    ['a bare tilde', '~'],
    ['another user\'s home', '~other/spec.md'],
    ['the root', '/'],
    ['a .. segment', '/Users/owner/../etc/spec.md'],
    ['a leading .. after the home', '~/../other/spec.md'],
    ['a . segment', '/Users/./owner/spec.md'],
    ['an empty segment', '/Users//owner/spec.md'],
    ['a trailing slash', '/Users/owner/docs/'],
    ['a NUL', '/Users/owner/spec\u0000.md'],
    ['a newline', '/Users/owner/spec\n.md'],
    ['a C1 control', '/Users/owner/spec\u0085.md'],
    ['DEL', '/Users/owner/spec\u007f.md'],
    ['too long', `/${'a'.repeat(4096)}.md`],
    ['not text', 42],
  ])('refuses %s', (_name, path) => {
    expect(linkedPathForm(path)).toBe(false)
  })
})

describe('readFileQuery: the raw request target, exactly', () => {
  it('reads kind, id and a base64url path, in any order', () => {
    expect(readFileQuery(target('item', ITEM, '/Users/owner/spec.md'))).toEqual({ kind: 'item', id: ITEM, path: '/Users/owner/spec.md' })
    expect(readFileQuery(`${FILE_PATH}?path=${b64('~/a.md')}&kind=row&id=r1`)).toEqual({ kind: 'row', id: 'r1', path: '~/a.md' })
    expect(readFileQuery(target('item', ITEM, '/tmp/ü-notes.md'))).toEqual({ kind: 'item', id: ITEM, path: '/tmp/ü-notes.md' })
  })

  it.each([
    ['no query', FILE_PATH],
    ['an empty query', `${FILE_PATH}?`],
    ['a missing key', `${FILE_PATH}?kind=item&id=${ITEM}`],
    ['a repeated key', `${target('item', ITEM, '/Users/owner/spec.md')}&path=${b64('/etc/hosts.txt')}`],
    ['an extra key', `${target('item', ITEM, '/Users/owner/spec.md')}&x=1`],
    ['an empty pair', `${target('item', ITEM, '/Users/owner/spec.md')}&`],
    ['a key with no value', `${FILE_PATH}?kind&id=${ITEM}&path=${b64('/a/b.md')}`],
    ['two equals signs', `${FILE_PATH}?kind=item=row&id=${ITEM}&path=${b64('/Users/o/b.md')}`],
    ['an unknown kind', target('message', ITEM, '/Users/owner/spec.md')],
    ['an id with a slash', target('item', 'a/b', '/Users/owner/spec.md')],
    ['an id with a dot', target('item', '..', '/Users/owner/spec.md')],
    ['a plain path', `${FILE_PATH}?kind=item&id=${ITEM}&path=/Users/owner/spec.md`],
    ['padded base64', `${FILE_PATH}?kind=item&id=${ITEM}&path=${Buffer.from('/Users/o/a.md').toString('base64')}=`],
    ['standard base64', `${FILE_PATH}?kind=item&id=${ITEM}&path=${Buffer.from('/Users/o/??>.md').toString('base64')}`],
    ['base64 that is not canonical', `${FILE_PATH}?kind=item&id=${ITEM}&path=${b64('/Users/o/a.md').slice(0, -1)}B`],
    ['bytes that are not UTF-8', `${FILE_PATH}?kind=item&id=${ITEM}&path=${Buffer.from([0x2f, 0xff, 0x2e, 0x6d, 0x64]).toString('base64url')}`],
    ['a decoded path that fails the form', target('item', ITEM, '/Users/owner/../spec.md')],
    ['a fragment', `${target('item', ITEM, '/Users/owner/spec.md')}#x`],
    ['another route', `/api/remote/files?kind=item&id=${ITEM}&path=${b64('/a/b.md')}`],
    ['not text', null],
  ])('refuses %s', (_name, raw) => {
    expect(readFileQuery(raw)).toBeNull()
  })
})

describe('linksPath: the path as a whole path in the card\'s text', () => {
  const P = '/Users/owner/docs/spec.md'
  it.each([
    ['alone', P],
    ['after a space, before a space', `read ${P} first`],
    ['in backticks', `read \`${P}\` first`],
    ['in quotes', `"${P}" and '${P}'`],
    ['in parentheses', `(see ${P})`],
    ['in brackets', `[${P}]`],
    ['in angle brackets', `<${P}>`],
    ['before a comma', `${P}, then`],
    ['before a semicolon', `${P}; then`],
    ['with a line', `${P}:12 is where`],
    ['with a line in backticks', `\`${P}:12\``],
    ['at the end of a sentence', `Read ${P}.`],
    ['before a sentence', `Read ${P}. Then`],
    ['after a newline', `line one\n${P}`],
    ['after a tab', `\t${P}`],
  ])('links it %s', (_name, text) => {
    expect(linksPath(text, P)).toBe(true)
  })

  it.each([
    ['nowhere', 'nothing here', P],
    ['as a prefix of a longer name', `${P}x`, P],
    ['as a prefix of a longer path', `${P}/more`, P],
    ['as a prefix with a second extension', `${P}.bak`, P],
    ['as a suffix of a longer path', `/Volumes/x${P}`, P],
    ['as the tail of another path', '/Users/owner/docs/spec.md', '/docs/spec.md'],
    ['glued to a word before it', `see:${P}`, P],
    ['glued to an equals sign', `file=${P}`, P],
    ['followed by a colon and no line', `${P}: it says`, P],
    ['with a line range', `${P}:12-20`, P],
    ['with a line and a column', `${P}:12:3`, P],
    ['followed by a dot and a letter', `${P}.x`, P],
    ['with a query-like tail', `${P}?raw=1`, P],
    ['shorter than what the text names', '/Users/owner/docs/spec.mdx', '/Users/owner/docs/spec.md'],
    ['percent-encoded in the text', '/Users/owner/docs/%73pec.md', P],
    ['as the plain path when the text has it encoded', P, '/Users/owner/docs/%73pec.md'],
    ['the home form when the text names the full path', '/Users/owner/docs/spec.md', '~/docs/spec.md'],
  ])('does not link it %s', (_name, text, path) => {
    expect(linksPath(text, path)).toBe(false)
  })

  it('finds a later whole occurrence after an earlier glued one', () => {
    expect(linksPath(`x${P} and ${P}`, P)).toBe(true)
  })
})

describe('entityTexts: the stored fields that may link a file', () => {
  it('reads an item\'s title, detail, context, next step, impact, next-after, outcome and options', () => {
    const item = {
      title: 't', detail: 'd', context: 'c', next_step: 'n', impact: 'i', next_after: 'a', outcome: 'o',
      options: [{ label: 'ol', detail: 'od' }, { label: 'only' }], reply: 'never', annotation: 'never', reply_context: 'never',
    }
    expect(entityTexts('item', item).sort()).toEqual(['a', 'c', 'd', 'i', 'n', 'o', 'od', 'ol', 'only', 't'].sort())
  })

  it('reads a row\'s label, note, context, next step, impact, next-after, outcome and options, never the human\'s words or history', () => {
    const row = {
      label: 'l', note: 'no', context: 'c', next_step: 'n', impact: 'i', next_after: 'a', outcome: 'o', options: [{ label: 'x', detail: 'y' }],
      annotation: 'never', history: [{ note: 'never' }],
    }
    expect(entityTexts('row', row).sort()).toEqual(['a', 'c', 'i', 'l', 'n', 'no', 'o', 'x', 'y'].sort())
  })
})

describe('linkedTexts and getBoardRow: the entity from the store', () => {
  let db: Database.Database
  beforeAll(() => {
    db = openDb(join(scratchDir('remote-file-store-'), 'inbox.db'))
  })
  afterAll(() => db.close())

  it('finds an item, a row of an active plan and a row of an archived plan; an unknown id is null', () => {
    const id = insertItem(db, { project: 'p', stream: 's', agent: 'a', kind: 'note', title: 'Read /Users/owner/a.md', context: 'and ~/b.txt' })
    const read = linkedTexts(db)
    expect(read('item', id)).toEqual(expect.arrayContaining(['Read /Users/owner/a.md', 'and ~/b.txt']))
    upsertBoard(db, { project: 'p', stream: 's', agent: 'a', title: 'Plan', rows: [{ label: 'one', status: 'tracked', note: 'see /Users/owner/c.md' }] })
    const board = listBoards(db)[0]!
    const rowId = board.rows[0]!.id
    expect(read('row', rowId)).toEqual(expect.arrayContaining(['one', 'see /Users/owner/c.md']))
    expect(archiveBoard(db, board.id, board.revision)).toBe(true)
    expect(getBoardRow(db, rowId)?.note).toBe('see /Users/owner/c.md')
    expect(read('row', rowId)).toEqual(expect.arrayContaining(['see /Users/owner/c.md']))
    expect(read('item', 'no-such-item')).toBeNull()
    expect(read('row', 'no-such-row')).toBeNull()
    // an item id never names a row, nor the other way round
    expect(read('row', id)).toBeNull()
    expect(read('item', rowId)).toBeNull()
  })
})

describe('openLinkedFile: the file checks after links are resolved', () => {
  afterEach(() => removeScratchDirs())
  const home = () => scratchDir('remote-file-home-')
  const close = (opened: ReturnType<typeof openLinkedFile>) => { if (opened.ok) closeSync(opened.fd) }

  it('opens a regular listed file, by its path or under the home for ~/', () => {
    const dir = home()
    mkdirSync(join(dir, 'docs'))
    writeFileSync(join(dir, 'docs', 'spec.md'), '# spec\n')
    const full = openLinkedFile(join(dir, 'docs', 'spec.md'), '/nonexistent-home')
    expect(full).toMatchObject({ ok: true, size: 7 })
    close(full)
    const tilde = openLinkedFile('~/docs/spec.md', dir)
    expect(tilde).toMatchObject({ ok: true, size: 7 })
    close(tilde)
  })

  it('follows a link to a listed regular file', () => {
    const dir = home()
    writeFileSync(join(dir, 'real.txt'), 'hello')
    symlinkSync(join(dir, 'real.txt'), join(dir, 'alias.md'))
    const opened = openLinkedFile(join(dir, 'alias.md'), dir)
    expect(opened).toMatchObject({ ok: true, size: 5 })
    close(opened)
  })

  it.each([
    ['a missing file', (dir: string) => join(dir, 'missing.md'), 'not_found'],
    ['a missing folder on the way', (dir: string) => join(dir, 'nope', 'missing.md'), 'not_found'],
    ['a folder named like a document', (dir: string) => { mkdirSync(join(dir, 'folder.md')); return join(dir, 'folder.md') }, 'not_found'],
    ['a link to a folder named like a document', (dir: string) => { mkdirSync(join(dir, 'real.md')); symlinkSync(join(dir, 'real.md'), join(dir, 'dir.md')); return join(dir, 'dir.md') }, 'not_found'],
    // the resolved target's own name is checked first
    ['a link to a folder', (dir: string) => { mkdirSync(join(dir, 'real')); symlinkSync(join(dir, 'real'), join(dir, 'dir.md')); return join(dir, 'dir.md') }, 'not_a_document'],
    ['a path through a linked folder to a type off the list', (dir: string) => { mkdirSync(join(dir, 'real')); writeFileSync(join(dir, 'real', 'x.sh'), 'x'); symlinkSync(join(dir, 'real', 'x.sh'), join(dir, 'real', 'x.md')); symlinkSync(join(dir, 'real'), join(dir, 'via')); return join(dir, 'via', 'x.md') }, 'not_a_document'],
    ['a link to a type off the list', (dir: string) => { writeFileSync(join(dir, 'page.html'), '<p>'); symlinkSync(join(dir, 'page.html'), join(dir, 'page.md')); return join(dir, 'page.md') }, 'not_a_document'],
    ['a link to a file with no extension', (dir: string) => { writeFileSync(join(dir, 'secret'), 'x'); symlinkSync(join(dir, 'secret'), join(dir, 'note.txt')); return join(dir, 'note.txt') }, 'not_a_document'],
    ['a dangling link', (dir: string) => { symlinkSync(join(dir, 'gone.md'), join(dir, 'dangling.md')); return join(dir, 'dangling.md') }, 'not_found'],
    ['a link loop', (dir: string) => { symlinkSync(join(dir, 'b.md'), join(dir, 'a.md')); symlinkSync(join(dir, 'a.md'), join(dir, 'b.md')); return join(dir, 'a.md') }, 'not_found'],
    ['a named pipe', (dir: string) => { execFileSync('/usr/bin/mkfifo', [join(dir, 'pipe.log')]); return join(dir, 'pipe.log') }, 'not_found'],
    ['a file over 25 MB', (dir: string) => { writeFileSync(join(dir, 'big.log'), ''); truncateSync(join(dir, 'big.log'), FILE_MAX + 1); return join(dir, 'big.log') }, 'too_large'],
  ])('refuses %s', (_name, make, reason) => {
    const dir = home()
    expect(openLinkedFile(make(dir), dir)).toEqual({ ok: false, reason })
  })

  it('takes a file of exactly 25 MB', () => {
    const dir = home()
    writeFileSync(join(dir, 'edge.log'), '')
    truncateSync(join(dir, 'edge.log'), FILE_MAX)
    const opened = openLinkedFile(join(dir, 'edge.log'), dir)
    expect(opened).toMatchObject({ ok: true, size: FILE_MAX })
    close(opened)
  })

  it.skipIf(process.getuid?.() === 0)('refuses a file it may not read as unreadable', () => {
    const dir = home()
    writeFileSync(join(dir, 'locked.md'), 'x')
    chmodSync(join(dir, 'locked.md'), 0o000)
    expect(openLinkedFile(join(dir, 'locked.md'), dir)).toEqual({ ok: false, reason: 'unreadable' })
    chmodSync(join(dir, 'locked.md'), 0o600)
  })

  it('refuses a file replaced by a link between the check and the open', () => {
    const dir = home()
    writeFileSync(join(dir, 'spec.md'), 'fine')
    writeFileSync(join(dir, 'other.md'), 'other')
    const opened = openLinkedFile(join(dir, 'spec.md'), dir, {
      beforeOpen: () => {
        renameSync(join(dir, 'spec.md'), join(dir, 'moved.md'))
        symlinkSync(join(dir, 'other.md'), join(dir, 'spec.md'))
      },
    })
    expect(opened).toEqual({ ok: false, reason: 'not_found' })
  })

  it('refuses a file replaced by another file between the check and the open', () => {
    const dir = home()
    writeFileSync(join(dir, 'spec.md'), 'fine')
    writeFileSync(join(dir, 'other.md'), 'other')
    const opened = openLinkedFile(join(dir, 'spec.md'), dir, { beforeOpen: () => renameSync(join(dir, 'other.md'), join(dir, 'spec.md')) })
    expect(opened).toEqual({ ok: false, reason: 'not_found' })
  })
})

describe('fileStream: the size held while reading', () => {
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const chunks: Uint8Array[] = []
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
    return Buffer.concat(chunks)
  }
  // a fake file of `bytes`, read at a position; `grow` adds bytes once the first read is done
  const fake = (bytes: Buffer, grow = 0) => {
    let content = bytes
    let reads = 0
    const closed: number[] = []
    return {
      closed,
      read: async (_fd: number, length: number, position: number) => {
        reads += 1
        const chunk = content.subarray(position, position + length)
        if (reads === 1 && grow > 0) content = Buffer.concat([content, Buffer.alloc(grow, 0x41)])
        return Buffer.from(chunk)
      },
      close: (fd: number) => { closed.push(fd) },
      shrink: () => { content = content.subarray(0, 2) },
    }
  }

  it('reads exactly the size and closes the file', async () => {
    const file = fake(Buffer.from('hello world'))
    const changed = vi.fn()
    expect((await collect(fileStream(7, 11, { read: file.read, close: file.close, onChanged: changed }))).toString()).toBe('hello world')
    expect(file.closed).toEqual([7])
    expect(changed).not.toHaveBeenCalled()
  })

  it('serves an empty file', async () => {
    const file = fake(Buffer.alloc(0))
    expect((await collect(fileStream(7, 0, { read: file.read, close: file.close }))).length).toBe(0)
    expect(file.closed).toEqual([7])
  })

  it('fails a file that grows while it is read, before its last bytes go out', async () => {
    const file = fake(Buffer.alloc(200_000, 0x61), 10)
    const changed = vi.fn()
    const sent: number[] = []
    const reader = fileStream(7, 200_000, { read: file.read, close: file.close, onChanged: changed }).getReader()
    await expect((async () => {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        sent.push(value.length)
      }
    })()).rejects.toThrow('the file changed while it was read')
    // what went out is short of the length the response promised
    expect(sent.reduce((a, b) => a + b, 0)).toBeLessThan(200_000)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(file.closed).toEqual([7])
  })

  it('fails a file that shrinks while it is read', async () => {
    const file = fake(Buffer.alloc(200_000, 0x61))
    const changed = vi.fn()
    const stream = fileStream(7, 200_000, { read: async (fd, length, position) => { if (position > 0) file.shrink(); return file.read(fd, length, position) }, close: file.close, onChanged: changed })
    await expect(collect(stream)).rejects.toThrow('the file changed while it was read')
    expect(changed).toHaveBeenCalledTimes(1)
    expect(file.closed).toEqual([7])
  })

  it('fails a read error, and closes the file', async () => {
    const closed: number[] = []
    const stream = fileStream(7, 10, { read: async () => { throw new Error('EIO') }, close: (fd) => closed.push(fd) })
    await expect(collect(stream)).rejects.toThrow()
    expect(closed).toEqual([7])
  })

  it('never takes a size over the limit', async () => {
    const file = fake(Buffer.alloc(1))
    await expect(collect(fileStream(7, FILE_MAX + 1, { read: file.read, close: file.close }))).rejects.toThrow()
    expect(file.closed).toEqual([7])
  })

  it('closes the file when the reader cancels', async () => {
    const file = fake(Buffer.alloc(200_000))
    const reader = fileStream(7, 200_000, { read: file.read, close: file.close }).getReader()
    await reader.read()
    await reader.cancel()
    expect(file.closed).toEqual([7])
  })
})

// the handler by itself, behind a gate that is not the real one
describe('remoteFileRoute: the handler on its own', () => {
  afterEach(() => removeScratchDirs())

  const build = (device: string | null) => {
    const dir = scratchDir('remote-file-route-')
    writeFileSync(join(dir, 'spec.md'), 'the spec')
    const texts = vi.fn(() => [`read ${join(dir, 'spec.md')}`])
    const app = new Hono()
    app.get(FILE_PATH, remoteFileRoute({ texts, deviceOf: () => device, home: dir }))
    const url = target('item', ITEM, join(dir, 'spec.md'))
    const call = (headers: Record<string, string> = {}) => app.request(url, { method: 'GET' }, { incoming: { url, headers } })
    return { call, texts }
  }

  it('refuses a request that carries no matched device with a bare 403, reading nothing', async () => {
    const { call, texts } = build(null)
    const response = await call()
    expect(response.status).toBe(403)
    expect(await response.text()).toBe('Forbidden')
    expect(texts).not.toHaveBeenCalled()
  })

  // the name a download is offered under: ASCII letters, digits, `.`, `_` and `-`, no leading dot, at most 120 characters
  it.each([
    ['spec.md', 'spec.md'],
    ['ü-plan.md', '_-plan.md'],
    ['My notes "draft".txt', 'My_notes__draft_.txt'],
    ['..hidden.md', 'hidden.md'],
    [`${'a'.repeat(200)}.md`, `${'a'.repeat(117)}.md`],
  ])('offers %s as %s', async (name, offered) => {
    const dir = scratchDir('remote-file-name-')
    writeFileSync(join(dir, name), 'x')
    const app = new Hono()
    app.get(FILE_PATH, remoteFileRoute({ texts: () => [join(dir, name)], deviceOf: () => '3f9c0a1b2d4e5f60', home: dir }))
    const url = target('item', ITEM, join(dir, name))
    const response = await app.request(url, { method: 'GET' }, { incoming: { url, headers: {} } })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="${offered}"`)
    await response.text()
  })

  it('refuses a request that carries a body', async () => {
    const { call } = build('3f9c0a1b2d4e5f60')
    for (const headers of [{ 'content-length': '2' }, { 'transfer-encoding': 'chunked' }] as Array<Record<string, string>>) {
      const response = await call(headers)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ ok: false, reason: 'bad_request' })
    }
    const fine = await call({ 'content-length': '0' })
    expect(fine.status).toBe(200)
    expect(await fine.text()).toBe('the spec')
  })
})

// ── through the real gate and listener ─────────────────────────────────────

describe('GET /api/remote/file through the remote entry', () => {
  const laptop = newSecret()
  let dir: string
  let home: string
  let db: Database.Database
  let port: number
  let localPort: number
  let entry: RemoteEntry
  let local: Server
  let itemId: string
  let rowId: string
  let docs: string

  beforeAll(async () => {
    dir = scratchDir('remote-file-entry-')
    home = scratchDir('remote-file-entry-home-')
    docs = join(home, 'docs')
    mkdirSync(docs)
    writeFileSync(join(docs, 'spec.md'), '# The spec\n')
    writeFileSync(join(docs, 'page.html'), '<script>alert(1)</script>')
    writeFileSync(join(docs, 'big.log'), '')
    truncateSync(join(docs, 'big.log'), FILE_MAX + 1)
    writeFileSync(join(docs, 'plan.txt'), 'row file')
    db = openDb(join(dir, 'inbox.db'))
    itemId = insertItem(db, {
      project: 'p', stream: 's', agent: 'a', kind: 'note',
      title: `Read ${join(docs, 'spec.md')}`,
      context: `Also ${join(docs, 'page.html')}, ${join(docs, 'big.log')}, ${join(docs, 'gone.md')} and ~/docs/spec.md:3`,
    })
    upsertBoard(db, { project: 'p', stream: 's', agent: 'a', title: 'Plan', rows: [{ label: 'one', status: 'tracked', note: `see \`${join(docs, 'plan.txt')}\`` }] })
    rowId = listBoards(db)[0]!.rows[0]!.id
    port = await freePort()
    writeSetting(dir, setting(port, [device(laptop)]))
    const remoteApp = createViewer(db, { agentHome: dir, runtimeRoot: join(dir, 'runtime') })
    remoteApp.get('/*', serveStatic({ root: './public' }))
    entry = startRemoteEntry({ app: remoteApp, dir, viewerPort: 4319, files: { texts: linkedTexts(db), home } })
    const app = createViewer(db, { agentHome: dir, runtimeRoot: join(dir, 'runtime') })
    app.get('/*', serveStatic({ root: './public' }))
    local = startLocalViewer(app, 0)
    await waitUntil(() => entry.status().listening && local.listening, 'both listeners')
    localPort = (local.address() as { port: number }).port
  })
  afterAll(async () => {
    local.close()
    await entry.close()
    db.close()
  })

  const get = (path: string, kind = 'item', id = itemId, extra: Array<[string, string]> = []) =>
    rawRequest(port, { target: target(kind, id, path), headers: deviceHeaders(laptop, extra) })
  const refusal = async (response: Awaited<ReturnType<typeof get>>) => ({ status: response.status, body: JSON.parse(response.body) as unknown })

  it('is one of the guarded app\'s own routes, never on the allowlist the wrapped app serves', () => {
    expect(GUARDED_ROUTES).toContainEqual({ method: 'GET', path: FILE_PATH })
    expect(GUARDED_ROUTES).not.toContainEqual({ method: 'POST', path: FILE_PATH })
    expect(remoteRouteAllowed('GET', FILE_PATH)).toBe(false)
  })

  it('serves a linked document as a download, never as a page, with the remote marker', async () => {
    const response = await get(join(docs, 'spec.md'))
    expect(response.status).toBe(200)
    expect(response.body).toBe('# The spec\n')
    expect(response.headers['content-type']).toBe('application/octet-stream')
    expect(response.headers['content-disposition']).toBe('attachment; filename="spec.md"')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['content-length']).toBe('11')
    expect(response.headers['x-agent-inbox-remote-boundary']).toBe('tailnet-v1')
  })

  it('serves a ~/ path the card names under the hub user\'s home, and a row\'s file', async () => {
    const tilde = await get('~/docs/spec.md')
    expect(tilde.status).toBe(200)
    expect(tilde.body).toBe('# The spec\n')
    const row = await get(join(docs, 'plan.txt'), 'row', rowId)
    expect(row.status).toBe(200)
    expect(row.body).toBe('row file')
  })

  it('answers each refusal with one word and nothing else', async () => {
    expect(await refusal(await get(join(docs, 'page.html')))).toEqual({ status: 415, body: { ok: false, reason: 'not_a_document' } })
    expect(await refusal(await get(join(docs, 'big.log')))).toEqual({ status: 413, body: { ok: false, reason: 'too_large' } })
    expect(await refusal(await get(join(docs, 'gone.md')))).toEqual({ status: 404, body: { ok: false, reason: 'not_found' } })
    // a file that exists but this card does not link, and an entity that does not exist, read the same
    expect(await refusal(await get(join(docs, 'plan.txt')))).toEqual({ status: 404, body: { ok: false, reason: 'not_linked' } })
    expect(await refusal(await get(join(docs, 'spec.md'), 'item', 'no-such-item'))).toEqual({ status: 404, body: { ok: false, reason: 'not_linked' } })
    expect(await refusal(await get(join(docs, 'spec.md'), 'row', rowId))).toEqual({ status: 404, body: { ok: false, reason: 'not_linked' } })
    expect(await refusal(await get('/etc/hosts.txt'))).toEqual({ status: 404, body: { ok: false, reason: 'not_linked' } })
    const bad = await rawRequest(port, { target: `${FILE_PATH}?kind=item&id=${itemId}`, headers: deviceHeaders(laptop) })
    expect(await refusal(bad)).toEqual({ status: 400, body: { ok: false, reason: 'bad_request' } })
  })

  it('refuses a HEAD before it opens anything', async () => {
    const response = await rawRequest(port, { method: 'HEAD', target: target('item', itemId, join(docs, 'spec.md')), headers: deviceHeaders(laptop) })
    expect(response.status).toBe(400)
  })

  it('refuses at the gate without a paired device\'s secret, and a percent-encoded target', async () => {
    const before = entry.status().refused
    const none = await rawRequest(port, { target: target('item', itemId, join(docs, 'spec.md')), headers: [['Host', HOST], ['Tailscale-User-Login', LOGIN]] })
    expect(none.status).toBe(403)
    expect(none.body).toBe('Forbidden')
    const encoded = await rawRequest(port, { target: `${FILE_PATH}?kind=item&id=${itemId}&path=%2F`, headers: deviceHeaders(laptop) })
    expect(encoded.status).toBe(403)
    const post = await rawRequest(port, { method: 'POST', target: target('item', itemId, join(docs, 'spec.md')), headers: deviceHeaders(laptop, [['Origin', `https://${HOST}`]]), body: '' })
    expect(post.status).toBe(403)
    const after = entry.status().refused
    expect(after.device).toBe(before.device + 1)
    expect(after.path).toBe(before.path + 1)
    expect(after.route).toBe(before.route + 1)
  })

  it('does not exist on the loopback app', async () => {
    const response = await rawRequest(localPort, { target: target('item', itemId, join(docs, 'spec.md')), headers: [['Host', `127.0.0.1:${localPort}`]] })
    expect(response.status).toBe(404)
    expect(response.body).not.toContain('The spec')
  })
})
