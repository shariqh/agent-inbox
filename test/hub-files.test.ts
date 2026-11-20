// A card's files from the connecting Mac (#634), main's half on the connecting Mac: the hub's page
// asks through agentInboxDesk.openFile({ kind, id, path }); main checks the sender, the request, a
// fresh press and the rate, fetches the file through the connection's hub fetch only, saves a private
// copy and opens it. Each check runs here in order, the copy goes through the real private writer in
// a scratch folder, and the hub's answers are fakes: nothing here fetches, and no app is opened (the
// opener is recorded). Fixtures are synthetic (hub.example.ts.net, studio).
import { createHash } from 'node:crypto'
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { readFileSync as readText } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import hubFilesModule from '../electron/hub-files.cjs'
import { removeScratchDirs, scratchDir } from './scratch.js'

const { DOCUMENT_EXTENSIONS, FILES_FROM, FILE_MAX, KEEP_MS, REASONS, copyName, createHubFiles, fileRequest } = hubFilesModule

afterEach(() => {
  removeScratchDirs()
  vi.restoreAllMocks()
})

const HUB = '0a1b2c3d'
const BASE = 'https://hub.example.ts.net/'
const ITEM = '6f1c2d3e-4a5b-4c6d-8e7f-001122334455'
const SPEC = '/Users/owner/docs/spec.md'
const MARKER = { 'x-agent-inbox-remote-boundary': 'tailnet-v1' }
const HUB_EVENT = { sender: 'hub' }
const OFFLINE_EVENT = { sender: 'offline' }
const LOCAL_EVENT = { sender: 'local' }
const key = (path: string) => createHash('sha256').update(path, 'utf8').digest('hex').slice(0, 16)

const fileResponse = (body: string, headers: Record<string, string> = {}) => new Response(body, {
  status: 200,
  headers: { 'content-type': 'application/octet-stream', 'content-length': String(Buffer.byteLength(body)), ...MARKER, ...headers },
})
const refusalResponse = (status: number, reason: string, marked = true) =>
  new Response(JSON.stringify({ ok: false, reason }), { status, headers: { 'content-type': 'application/json', ...(marked ? MARKER : {}) } })

function harness(options: { platform?: string; version?: string | null; respond?: (url: string) => Response | Promise<Response>; openPath?: (file: string) => Promise<string> } = {}) {
  const dir = join(scratchDir('hub-files-'), 'hub-files')
  const calls: Array<{ url: string; init: Record<string, unknown> }> = []
  const opened: string[] = []
  const logs: string[] = []
  const clock = { now: Date.now() }
  let press = 0
  const view = {
    trusts: (event: unknown) => (event === HUB_EVENT ? 'hub' : event === OFFLINE_EVENT ? 'offline' : null),
    // one press, one open: a press is used up here, as hub-view's takeGesture does
    takeGesture: (event: unknown) => {
      if (event !== HUB_EVENT || press === 0) return null
      press -= 1
      return HUB
    },
  }
  const connection = { mode: 'hub', id: HUB, label: 'studio', state: 'online', reason: null, version: options.version === undefined ? '2.16.0' : options.version }
  let respond = options.respond ?? (() => fileResponse('# The spec\n'))
  const connect = {
    connection: () => connection,
    hubBase: (id: unknown) => (id === HUB ? BASE : null),
    hubFetch: () => async (url: string, init?: Record<string, unknown>) => {
      calls.push({ url, init: init ?? {} })
      return respond(url)
    },
  }
  let connectValue: typeof connect | null = connect
  const files = createHubFiles({
    platform: options.platform ?? 'darwin',
    hubView: () => view,
    connect: () => connectValue,
    dir,
    openPath: options.openPath ?? (async (file: string) => { opened.push(file); return '' }),
    now: () => clock.now,
    log: (line: string) => logs.push(line),
  })
  return {
    dir, calls, opened, logs, clock, files, connection,
    press: (n = 1) => { press += n },
    setRespond: (fn: typeof respond) => { respond = fn },
    dropConnect: () => { connectValue = null },
    open: (request: unknown = { kind: 'item', id: ITEM, path: SPEC }, event: unknown = HUB_EVENT) => files.open(event, [request]),
  }
}

// ── the rules ────────────────────────────────────────────────────────────────

describe('the document list', () => {
  it('is the hub\'s list exactly', () => {
    expect([...DOCUMENT_EXTENSIONS]).toEqual(['.md', '.markdown', '.txt', '.log', '.json', '.yaml', '.yml', '.csv', '.tsv', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp'])
    const hub = readText(join(import.meta.dirname, '..', 'src', 'remote-file.ts'), 'utf8')
    const listed = /DOCUMENT_EXTENSIONS: readonly string\[\] = Object\.freeze\(\[\s*([^\]]+)\]/.exec(hub)?.[1]
    expect(listed?.split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean)).toEqual([...DOCUMENT_EXTENSIONS])
    expect(FILE_MAX).toBe(25 * 1024 * 1024)
  })
})

describe('fileRequest: exactly [{ kind, id, path }]', () => {
  it('reads an item or a row, with an absolute or a ~/ path', () => {
    expect(fileRequest([{ kind: 'item', id: ITEM, path: SPEC }])).toEqual({ kind: 'item', id: ITEM, path: SPEC })
    expect(fileRequest([{ path: '~/notes/a.txt', id: 'r1', kind: 'row' }])).toEqual({ kind: 'row', id: 'r1', path: '~/notes/a.txt' })
  })

  it.each([
    ['nothing', []],
    ['two arguments', [{ kind: 'item', id: ITEM, path: SPEC }, 'x']],
    ['a string', ['x']],
    ['an array', [[{ kind: 'item', id: ITEM, path: SPEC }]]],
    ['an extra key', [{ kind: 'item', id: ITEM, path: SPEC, root: '/Users/owner' }]],
    ['a missing key', [{ kind: 'item', path: SPEC }]],
    ['another kind', [{ kind: 'message', id: ITEM, path: SPEC }]],
    ['an id with a slash', [{ kind: 'item', id: 'a/b', path: SPEC }]],
    ['an id with an ampersand', [{ kind: 'item', id: 'a&path=x', path: SPEC }]],
    ['a relative path', [{ kind: 'item', id: ITEM, path: 'docs/spec.md' }]],
    ['a .. segment', [{ kind: 'item', id: ITEM, path: '/Users/owner/../x.md' }]],
    ['a control character', [{ kind: 'item', id: ITEM, path: '/Users/owner/x\u0007.md' }]],
    ['a type off the list', [{ kind: 'item', id: ITEM, path: '/Users/owner/page.html' }]],
    ['an SVG', [{ kind: 'item', id: ITEM, path: '/Users/owner/icon.svg' }]],
    ['a script', [{ kind: 'item', id: ITEM, path: '/Users/owner/run.command' }]],
    ['a name that is only a dot and an extension', [{ kind: 'item', id: ITEM, path: '/Users/owner/.md' }]],
    ['a class instance', [new (class { kind = 'item'; id = ITEM; path = SPEC })()]],
  ])('refuses %s', (_name, args) => {
    expect(fileRequest(args)).toBeNull()
  })
})

describe('copyName: the cleaned last segment', () => {
  it.each([
    ['/Users/owner/docs/spec.md', 'spec.md'],
    ['~/notes/ü-plan.md', 'ü-plan.md'],
    ['/Users/owner/..hidden.md', 'hidden.md'],
    ['/Users/owner/a\\b.md', 'a_b.md'],
    ['/Users/owner/a:b.md', 'a_b.md'],
    // a right-to-left override would make Finder show another extension
    ['/Users/owner/report\u202Etxt.md', 'report_txt.md'],
    ['/Users/owner/zero\u200Bwidth.md', 'zero_width.md'],
    ['/Users/owner/line\u2028break.md', 'line_break.md'],
    [`/Users/owner/${'a'.repeat(300)}.md`, `${'a'.repeat(117)}.md`],
    [`/Users/owner/${'é'.repeat(200)}.pdf`, `${'é'.repeat(116)}.pdf`],
  ])('%s is saved as %s', (path, name) => {
    expect(copyName(path)).toBe(name)
    expect(Array.from(copyName(path)!).length).toBeLessThanOrEqual(120)
  })

  it('keeps a long name of wide letters within what a file name may hold', () => {
    const name = copyName(`/Users/owner/${'😀'.repeat(200)}.md`)!
    expect(name.endsWith('.md')).toBe(true)
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255)
  })

  it.each(['/Users/owner/page.html', '/Users/owner/...', '/Users/owner/.md', '/Users/owner/x.md.command'])('has no name for %s', (path) => {
    expect(copyName(path)).toBeNull()
  })
})

// ── an open that works ───────────────────────────────────────────────────────

describe('createHubFiles: an open that works', () => {
  it('fetches the file through the hub fetch only, saves a private copy and opens it', async () => {
    const h = harness()
    h.press()
    expect(await h.open()).toEqual({ ok: true })
    expect(h.calls).toHaveLength(1)
    const path = Buffer.from(SPEC, 'utf8').toString('base64url')
    expect(h.calls[0]!.url).toBe(`${BASE}api/remote/file?kind=item&id=${ITEM}&path=${path}`)
    expect(h.calls[0]!.init).toEqual({ method: 'GET', timeoutMs: 60_000 })
    const file = join(h.dir, HUB, key(SPEC), 'spec.md')
    expect(h.opened).toEqual([file])
    expect(readFileSync(file, 'utf8')).toBe('# The spec\n')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    for (const folder of [h.dir, join(h.dir, HUB), join(h.dir, HUB, key(SPEC))]) expect(statSync(folder).mode & 0o777).toBe(0o700)
    expect(readdirSync(join(h.dir, HUB, key(SPEC)))).toEqual(['spec.md'])
    expect(h.logs).toEqual(['hub-files: opened'])
  })

  it('opens a row\'s file and a ~/ path, each in a folder of its own', async () => {
    const h = harness()
    h.press(2)
    expect(await h.open({ kind: 'row', id: 'r1', path: '~/notes/plan.txt' })).toEqual({ ok: true })
    h.clock.now += 1_000
    expect(await h.open({ kind: 'item', id: ITEM, path: '/Users/owner/other/plan.txt' })).toEqual({ ok: true })
    expect(h.opened).toEqual([join(h.dir, HUB, key('~/notes/plan.txt'), 'plan.txt'), join(h.dir, HUB, key('/Users/owner/other/plan.txt'), 'plan.txt')])
  })

  it('replaces an earlier copy of the same file with the hub\'s bytes now', async () => {
    const h = harness()
    h.press(2)
    await h.open()
    h.setRespond(() => fileResponse('# The spec, edited\n'))
    h.clock.now += 1_000
    expect(await h.open()).toEqual({ ok: true })
    const file = join(h.dir, HUB, key(SPEC), 'spec.md')
    expect(readFileSync(file, 'utf8')).toBe('# The spec, edited\n')
    expect(readdirSync(join(h.dir, HUB, key(SPEC)))).toEqual(['spec.md'])
  })

  it('names the copy from the path the page named, never from the hub\'s headers', async () => {
    const h = harness({ respond: () => fileResponse('x', { 'content-disposition': 'attachment; filename="evil.command"' }) })
    h.press()
    expect(await h.open()).toEqual({ ok: true })
    expect(h.opened).toEqual([join(h.dir, HUB, key(SPEC), 'spec.md')])
  })
})

// ── each check, in order ─────────────────────────────────────────────────────

describe('createHubFiles: each check, in order', () => {
  it('1. the sender: anything but the hub view on the hub\'s page is unavailable, before anything else', async () => {
    for (const event of [LOCAL_EVENT, OFFLINE_EVENT, { sender: 'stranger' }]) {
      const h = harness()
      h.press()
      expect(await h.open(undefined, event)).toEqual({ ok: false, reason: 'unavailable' })
      expect(h.calls).toEqual([])
    }
    const linux = harness({ platform: 'linux' })
    linux.press()
    expect(await linux.open()).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('1. the request: anything but exactly { kind, id, path } is bad_request, and uses no press', async () => {
    const h = harness()
    h.press()
    expect(await h.open({ kind: 'item', id: ITEM, path: '/Users/owner/page.html' })).toEqual({ ok: false, reason: 'bad_request' })
    expect(await h.files.open(HUB_EVENT, [])).toEqual({ ok: false, reason: 'bad_request' })
    expect(await h.open()).toEqual({ ok: true })
  })

  it('2. the gesture: no fresh press is no_gesture, and one press opens one file', async () => {
    const h = harness()
    expect(await h.open()).toEqual({ ok: false, reason: 'no_gesture' })
    h.press()
    expect(await h.open()).toEqual({ ok: true })
    h.clock.now += 5_000
    expect(await h.open()).toEqual({ ok: false, reason: 'no_gesture' })
    expect(h.calls).toHaveLength(1)
  })

  it('3. the rate: one open a second, twenty a minute', async () => {
    const h = harness()
    h.press(30)
    expect(await h.open()).toEqual({ ok: true })
    h.clock.now += 999
    expect(await h.open()).toEqual({ ok: false, reason: 'busy' })
    for (let i = 0; i < 19; i += 1) {
      h.clock.now += 1_000
      expect(await h.open(), String(i)).toEqual({ ok: true })
    }
    h.clock.now += 1_000
    expect(await h.open()).toEqual({ ok: false, reason: 'busy' })
    h.clock.now += 60_000
    expect(await h.open()).toEqual({ ok: true })
  })

  it('3. the rate: never two at once', async () => {
    let release: () => void = () => {}
    const h = harness({ respond: () => new Promise((resolve) => { release = () => resolve(fileResponse('x')) }) })
    h.press(2)
    const first = h.open()
    await new Promise((resolve) => setImmediate(resolve))
    h.clock.now += 5_000
    expect(await h.open()).toEqual({ ok: false, reason: 'busy' })
    release()
    expect(await first).toEqual({ ok: true })
  })

  it('4. no hub to fetch from, or a fetch that fails, is unreachable', async () => {
    const none = harness()
    none.dropConnect()
    none.press()
    expect(await none.open()).toEqual({ ok: false, reason: 'unreachable' })
    const failing = harness({ respond: () => { throw new Error('offline') } })
    failing.press()
    expect(await failing.open()).toEqual({ ok: false, reason: 'unreachable' })
    // an answer without the remote entry's marker is not the hub's
    const unmarked = harness({ respond: () => new Response('x', { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': '1' } }) })
    unmarked.press()
    expect(await unmarked.open()).toEqual({ ok: false, reason: 'unreachable' })
    for (const h of [none, failing, unmarked]) expect(h.opened).toEqual([])
  })

  it('5. a 403 from a hub older than the route is old_hub; from any other hub, refused', async () => {
    for (const [version, reason] of [['2.15.0', 'old_hub'], ['2.15.9', 'old_hub'], [FILES_FROM, 'refused'], ['3.0.0', 'refused'], [null, 'refused'], ['not a version', 'refused']] as const) {
      const h = harness({ version, respond: () => new Response('Forbidden', { status: 403 }) })
      h.press()
      expect(await h.open(), String(version)).toEqual({ ok: false, reason })
      expect(h.opened).toEqual([])
    }
  })

  it('6. the hub\'s own refusal word passes on; any other answer is failed', async () => {
    for (const [status, word] of [[400, 'bad_request'], [404, 'not_linked'], [415, 'not_a_document'], [413, 'too_large'], [404, 'not_found'], [422, 'unreadable']] as const) {
      const h = harness({ respond: () => refusalResponse(status, word) })
      h.press()
      expect(await h.open(), word).toEqual({ ok: false, reason: word })
    }
    for (const respond of [
      () => refusalResponse(404, 'something_else'),
      () => refusalResponse(500, 'open_failed'),
      () => new Response('x'.repeat(2_000), { status: 404, headers: MARKER }),
      () => new Response('not json', { status: 404, headers: MARKER }),
    ]) {
      const h = harness({ respond })
      h.press()
      expect(await h.open()).toEqual({ ok: false, reason: 'failed' })
      expect(h.opened).toEqual([])
    }
  })

  it('7. a 200 must be a download with its length: anything else is failed, a length over 25 MB too_large', async () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ 'content-type': 'text/html' }, 'failed'],
      [{ 'content-type': 'application/octet-stream; charset=utf-8' }, 'failed'],
      [{ 'content-length': '' }, 'failed'],
      [{ 'content-length': '-1' }, 'failed'],
      [{ 'content-length': '1e3' }, 'failed'],
      [{ 'content-length': String(FILE_MAX + 1) }, 'too_large'],
    ]
    for (const [headers, reason] of cases) {
      const h = harness({ respond: () => fileResponse('x', headers) })
      h.press()
      expect(await h.open(), JSON.stringify(headers)).toEqual({ ok: false, reason })
      expect(h.opened).toEqual([])
    }
  })

  it('7. a body longer or shorter than its length, or one that breaks off, is failed and leaves nothing behind', async () => {
    const longer = () => fileResponse('more than promised', { 'content-length': '4' })
    const shorter = () => fileResponse('ab', { 'content-length': '10' })
    const broken = () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('half'))
        controller.error(new Error('cut off'))
      },
    }), { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': '8', ...MARKER } })
    for (const respond of [longer, shorter, broken]) {
      const h = harness({ respond })
      h.press()
      expect(await h.open()).toEqual({ ok: false, reason: 'failed' })
      expect(h.opened).toEqual([])
      const folder = join(h.dir, HUB, key(SPEC))
      expect(existsSync(folder) ? readdirSync(folder) : []).toEqual([])
    }
  })

  it('8. a copy that cannot be opened is open_failed', async () => {
    const h = harness({ openPath: async () => 'No application knows how to open this file.' })
    h.press()
    expect(await h.open()).toEqual({ ok: false, reason: 'open_failed' })
    const throwing = harness({ openPath: async () => { throw new Error('gone') } })
    throwing.press()
    expect(await throwing.open()).toEqual({ ok: false, reason: 'open_failed' })
  })

  it('logs only the reason word: no host, path, id or file', async () => {
    const h = harness({ respond: () => refusalResponse(404, 'not_linked') })
    h.press()
    await h.open()
    expect(h.logs).toEqual(['hub-files: not_linked'])
    expect(REASONS).toContain('not_linked')
  })

  it('logs nothing for the three refusals before the gesture check, however often a page calls', async () => {
    const h = harness()
    for (let i = 0; i < 50; i += 1) {
      await h.open(undefined, LOCAL_EVENT)
      await h.open({ kind: 'nope' })
      await h.open()
    }
    expect(h.logs).toEqual([])
  })
})

describe('createHubFiles: available()', () => {
  it('says files only for the hub\'s page, on macOS, with no argument, while the connection has a hub', async () => {
    const h = harness()
    expect(await h.files.available(HUB_EVENT, [])).toEqual({ files: true })
    expect(await h.files.available(HUB_EVENT, ['x'])).toEqual({ files: false })
    for (const event of [LOCAL_EVENT, OFFLINE_EVENT]) expect(await h.files.available(event, [])).toEqual({ files: false })
    h.connection.id = 'ffffffff'
    expect(await h.files.available(HUB_EVENT, [])).toEqual({ files: false })
    const linux = harness({ platform: 'linux' })
    expect(await linux.files.available(HUB_EVENT, [])).toEqual({ files: false })
    const none = harness()
    none.dropConnect()
    expect(await none.files.available(HUB_EVENT, [])).toEqual({ files: false })
    // it uses no press and fetches nothing
    h.connection.id = HUB
    h.press()
    await h.files.available(HUB_EVENT, [])
    expect(await h.open()).toEqual({ ok: true })
  })
})

// ── the private copy ─────────────────────────────────────────────────────────

describe('the private copy on disk', () => {
  it('refuses a hub-files folder that is a link, and writes nothing through it', async () => {
    const h = harness()
    const elsewhere = scratchDir('hub-files-elsewhere-')
    mkdirSync(join(h.dir, '..'), { recursive: true })
    symlinkSync(elsewhere, h.dir)
    h.press()
    expect(await h.open()).toEqual({ ok: false, reason: 'failed' })
    expect(readdirSync(elsewhere)).toEqual([])
    expect(h.opened).toEqual([])
  })

  it('refuses a hub or copy folder that is a link', async () => {
    for (const depth of [1, 2]) {
      const h = harness()
      const elsewhere = scratchDir('hub-files-elsewhere-')
      mkdirSync(depth === 1 ? h.dir : join(h.dir, HUB), { recursive: true, mode: 0o700 })
      symlinkSync(elsewhere, depth === 1 ? join(h.dir, HUB) : join(h.dir, HUB, key(SPEC)))
      h.press()
      expect(await h.open(), String(depth)).toEqual({ ok: false, reason: 'failed' })
      expect(readdirSync(elsewhere)).toEqual([])
    }
  })

  it('replaces a link at the copy\'s name, never writing through it', async () => {
    const h = harness()
    const folder = join(h.dir, HUB, key(SPEC))
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    const target = join(scratchDir('hub-files-target-'), 'victim.md')
    writeFileSync(target, 'untouched')
    symlinkSync(target, join(folder, 'spec.md'))
    h.press()
    expect(await h.open()).toEqual({ ok: true })
    expect(readFileSync(target, 'utf8')).toBe('untouched')
    expect(lstatSync(join(folder, 'spec.md')).isFile()).toBe(true)
    expect(readFileSync(join(folder, 'spec.md'), 'utf8')).toBe('# The spec\n')
  })

  it('tightens folders that are too open', async () => {
    const h = harness()
    mkdirSync(join(h.dir, HUB), { recursive: true, mode: 0o755 })
    h.press()
    expect(await h.open()).toEqual({ ok: true })
    expect(statSync(h.dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(h.dir, HUB)).mode & 0o777).toBe(0o700)
  })

  it('sweeps copies older than a day at the start of an open: not fresh ones, not links, not other names', async () => {
    const h = harness()
    const old = join(h.dir, HUB, 'aaaaaaaaaaaaaaaa')
    const fresh = join(h.dir, HUB, 'bbbbbbbbbbbbbbbb')
    const odd = join(h.dir, HUB, 'not-a-copy')
    for (const folder of [old, fresh, odd]) mkdirSync(folder, { recursive: true, mode: 0o700 })
    writeFileSync(join(old, 'a.md'), 'old')
    writeFileSync(join(old, '.0123456789abcdef.part'), 'old part')
    writeFileSync(join(fresh, 'b.md'), 'fresh')
    writeFileSync(join(odd, 'c.md'), 'odd')
    const outside = join(scratchDir('hub-files-outside-'), 'keep.md')
    writeFileSync(outside, 'keep')
    symlinkSync(outside, join(fresh, 'link.md'))
    const dayAgo = (h.clock.now - KEEP_MS - 1_000) / 1_000
    for (const file of [join(old, 'a.md'), join(old, '.0123456789abcdef.part'), join(odd, 'c.md'), outside]) utimesSync(file, dayAgo, dayAgo)
    h.press()
    expect(await h.open()).toEqual({ ok: true })
    expect(existsSync(old)).toBe(false)
    expect(readdirSync(fresh).sort()).toEqual(['b.md', 'link.md'])
    expect(readlinkSync(join(fresh, 'link.md'))).toBe(outside)
    expect(readFileSync(outside, 'utf8')).toBe('keep')
    expect(readdirSync(odd)).toEqual(['c.md'])
  })
})

describe('the source', () => {
  const source = readText(join(import.meta.dirname, '..', 'electron', 'hub-files.cjs'), 'utf8')
  it('fetches nothing itself and runs nothing: the hub fetch and the opener are injected', () => {
    expect(source).not.toMatch(/\bfetch\(/)
    expect(source).not.toMatch(/child_process|require\('electron'\)|\beval\b|new Function/)
    expect(source).toContain('hubFetch()')
  })
})
