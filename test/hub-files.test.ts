// A card's files from the connecting Mac (#634), main's half on the connecting Mac: the hub's page
// asks through agentInboxDesk.openFile({ kind, id, path }); main checks the sender, the request, a
// fresh press and the rate, fetches the file through the connection's hub fetch only, saves a private
// copy and opens it. Each check runs here in order, the copy goes through the real private writer in
// a scratch folder, and the hub's answers are fakes: nothing here fetches, and no app is opened (the
// opener is recorded). Fixtures are synthetic (hub.example.ts.net, studio).
import { createHash } from 'node:crypto'
import fs, {
  constants, existsSync, lstatSync, lutimesSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { readFileSync as readText } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import hubFilesModule from '../electron/hub-files.cjs'
import linkOpenModule from '../electron/link-open.cjs'
import { removeScratchDirs, scratchDir } from './scratch.js'

const { HUB_COPY_EXTENSIONS, openHubCopy } = linkOpenModule
const { DOCUMENT_EXTENSIONS, FILES_FROM, FILE_MAX, KEEP_MS, REASONS, SWEEP_FIRST_MS, SWEEP_EVERY_MS, copyName, createHubFiles, fileRequest, scheduleCopySweep, servablePath } = hubFilesModule

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

function harness(options: { platform?: string; version?: string | null; respond?: (url: string) => Response | Promise<Response>; openCopy?: (file: string) => Promise<{ ok: boolean; reason?: string }>; randomBytes?: (n: number) => Buffer } = {}) {
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
    openCopy: options.openCopy ?? (async (file: string) => { opened.push(file); return { ok: true } }),
    now: () => clock.now,
    log: (line: string) => logs.push(line),
    ...(options.randomBytes ? { randomBytes: options.randomBytes } : {}),
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
    ['a class instance', [new (class { kind = 'item'; id = ITEM; path = SPEC })()]],
  ])('refuses %s', (_name, args) => {
    expect(fileRequest(args)).toBeNull()
  })
})

describe('servablePath: the hub\'s rule, applied before anything is asked', () => {
  it.each([
    ['/Users/owner/docs/spec.md', true], ['~/notes/a.TXT', true],
    ['/Users/owner/page.html', false], ['/Users/owner/icon.svg', false], ['/Users/owner/run.command', false], ['/Users/owner/.md', false],
    ['~/.ssh/config.json', false], ['/Users/owner/.config/gh/hosts.yml', false], ['/Users/owner/repo/.env.json', false],
    ['/Users/owner/repo/.git/HEAD.txt', false], ['~/notes/.draft.md', false],
    // system locations stay on the hub
    ['/etc/hosts.txt', false], ['/private/etc/x.json', false], ['/Library/Logs/x.log', false], ['/var/log/system.log', false],
    ['/Applications/X.app/Contents/Info.json', false], ['/tmp/a.md', true], ['/private/tmp/a.md', true], ['/var/folders/ab/T/a.md', true],
    // a network or removable volume can hang the hub's viewer: volumes stay on the hub
    ['/Volumes/Disk/a.md', false], ['/Volumes/Macintosh HD/Users/owner/a.md', false],
  ])('%s: %s', (path, expected) => {
    expect(servablePath(path)).toBe(expected)
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
    expect(await h.open({ kind: 'item', id: ITEM, path: '/Users/owner/../x.md' })).toEqual({ ok: false, reason: 'bad_request' })
    expect(await h.files.open(HUB_EVENT, [])).toEqual({ ok: false, reason: 'bad_request' })
    expect(await h.open()).toEqual({ ok: true })
  })

  it('1. the document: a type off the list, a hidden file or folder, or a system location is not_a_document, asks nothing and uses no press', async () => {
    const h = harness()
    h.press()
    for (const path of ['/Users/owner/page.html', '~/.ssh/config.json', '/Users/owner/repo/.git/HEAD.txt', '/Users/owner/repo/.env.json', '/etc/hosts.txt', '/var/log/system.log']) {
      expect(await h.open({ kind: 'item', id: ITEM, path }), path).toEqual({ ok: false, reason: 'not_a_document' })
    }
    expect(h.calls).toEqual([])
    expect(h.logs).toEqual([])
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
    for (const [status, word] of [[400, 'bad_request'], [404, 'not_linked'], [415, 'not_a_document'], [413, 'too_large'], [404, 'not_found'], [422, 'unreadable'], [429, 'busy']] as const) {
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
    const h = harness({ openCopy: async () => ({ ok: false, reason: 'failed' }) })
    h.press()
    expect(await h.open()).toEqual({ ok: false, reason: 'open_failed' })
    const throwing = harness({ openCopy: async () => { throw new Error('gone') } })
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

  // The sweep removes only what this app made: old regular files in a copy folder (16 hex) of a hub
  // folder (8 hex), reached with lstat, never a link followed and never a tree it did not make.
  describe('the sweep, edge by edge', () => {
    const dayAgo = (h: { clock: { now: number } }) => (h.clock.now - KEEP_MS - 1_000) / 1_000
    const run = async (h: ReturnType<typeof harness>) => {
      h.press()
      expect(await h.open()).toEqual({ ok: true })
    }

    it('removes an old regular file only: a folder it did not make, with its contents, stays', async () => {
      const h = harness()
      const copy = join(h.dir, HUB, 'aaaaaaaaaaaaaaaa')
      mkdirSync(join(copy, 'tree', 'deeper'), { recursive: true, mode: 0o700 })
      writeFileSync(join(copy, 'tree', 'deeper', 'inside.md'), 'inside')
      writeFileSync(join(copy, 'old.md'), 'old')
      const old = dayAgo(h)
      for (const path of [join(copy, 'tree'), join(copy, 'tree', 'deeper', 'inside.md'), join(copy, 'old.md')]) utimesSync(path, old, old)
      await run(h)
      expect(existsSync(join(copy, 'old.md'))).toBe(false)
      expect(readFileSync(join(copy, 'tree', 'deeper', 'inside.md'), 'utf8')).toBe('inside')
    })

    it('leaves an old link in a copy folder alone, and the file it points at', async () => {
      const h = harness()
      const copy = join(h.dir, HUB, 'aaaaaaaaaaaaaaaa')
      mkdirSync(copy, { recursive: true, mode: 0o700 })
      const target = join(scratchDir('hub-files-target-'), 'keep.md')
      writeFileSync(target, 'keep')
      symlinkSync(target, join(copy, 'link.md'))
      lutimesSync(join(copy, 'link.md'), dayAgo(h), dayAgo(h))
      utimesSync(target, dayAgo(h), dayAgo(h))
      await run(h)
      expect(readlinkSync(join(copy, 'link.md'))).toBe(target)
      expect(readFileSync(target, 'utf8')).toBe('keep')
    })

    it('looks only in a hub folder named by 8 hex digits and a copy folder by 16', async () => {
      const h = harness()
      const kept = [join(h.dir, 'not-a-hub', 'aaaaaaaaaaaaaaaa', 'a.md'), join(h.dir, 'ffffffff', 'not-a-copy', 'b.md')]
      for (const file of kept) {
        mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
        writeFileSync(file, 'x')
        utimesSync(file, dayAgo(h), dayAgo(h))
      }
      await run(h)
      for (const file of kept) expect(existsSync(file), file).toBe(true)
    })

    it('never follows a link to a folder, at the hub level or the copy level', async () => {
      const h = harness()
      const outside = scratchDir('hub-files-outside-')
      mkdirSync(join(outside, 'aaaaaaaaaaaaaaaa'), { recursive: true })
      writeFileSync(join(outside, 'aaaaaaaaaaaaaaaa', 'a.md'), 'outside a')
      writeFileSync(join(outside, 'b.md'), 'outside b')
      for (const path of [join(outside, 'aaaaaaaaaaaaaaaa', 'a.md'), join(outside, 'b.md')]) utimesSync(path, dayAgo(h), dayAgo(h))
      mkdirSync(join(h.dir, HUB), { recursive: true, mode: 0o700 })
      symlinkSync(outside, join(h.dir, '11223344'))
      symlinkSync(outside, join(h.dir, HUB, 'bbbbbbbbbbbbbbbb'))
      await run(h)
      expect(readFileSync(join(outside, 'aaaaaaaaaaaaaaaa', 'a.md'), 'utf8')).toBe('outside a')
      expect(readFileSync(join(outside, 'b.md'), 'utf8')).toBe('outside b')
    })
  })

  // The private writer owns the folders it writes in: a folder another user owns is not used.
  it('refuses a folder owned by someone else', async () => {
    const h = harness()
    const uid = process.getuid!()
    vi.spyOn(process, 'getuid').mockReturnValue(uid + 1)
    h.press()
    expect(await h.open()).toEqual({ ok: false, reason: 'failed' })
    expect(h.opened).toEqual([])
    expect(existsSync(join(h.dir, HUB, key(SPEC), 'spec.md'))).toBe(false)
  })

  describe('the partial file', () => {
    const RANDOM = Buffer.from('0123456789abcdef', 'hex')
    const partialName = `.${RANDOM.toString('hex')}.part`

    it('is created exclusively and without following a link, at 0600', async () => {
      const h = harness({ randomBytes: () => RANDOM })
      const open = vi.spyOn(fs, 'openSync')
      h.press()
      expect(await h.open()).toEqual({ ok: true })
      const partial = open.mock.calls.filter(([path]) => String(path).endsWith(partialName))
      expect(partial).toHaveLength(1)
      const [, flags, mode] = partial[0]!
      const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = constants
      expect(flags).toBe(O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW)
      expect(mode).toBe(0o600)
    })

    it('is never written through a file planted at its name', async () => {
      const h = harness({ randomBytes: () => RANDOM })
      const folder = join(h.dir, HUB, key(SPEC))
      mkdirSync(folder, { recursive: true, mode: 0o700 })
      writeFileSync(join(folder, partialName), 'PLANTED-CONTENT-THAT-STAYS')
      h.press()
      expect(await h.open()).toEqual({ ok: false, reason: 'failed' })
      // the failed open may clear the name, but never leaves a write through it
      expect(existsSync(join(folder, partialName)) ? readFileSync(join(folder, partialName), 'utf8') : 'PLANTED-CONTENT-THAT-STAYS').toBe('PLANTED-CONTENT-THAT-STAYS')
      expect(existsSync(join(folder, 'spec.md'))).toBe(false)
      expect(h.opened).toEqual([])
    })

    it('is never written through a link planted at its name', async () => {
      const h = harness({ randomBytes: () => RANDOM })
      const folder = join(h.dir, HUB, key(SPEC))
      mkdirSync(folder, { recursive: true, mode: 0o700 })
      const victim = join(scratchDir('hub-files-victim-'), 'victim.md')
      writeFileSync(victim, 'untouched')
      symlinkSync(victim, join(folder, partialName))
      h.press()
      expect(await h.open()).toEqual({ ok: false, reason: 'failed' })
      expect(readFileSync(victim, 'utf8')).toBe('untouched')
    })
  })

  it('stops reading and writing as soon as the body is longer than its length', async () => {
    let pulls = 0
    const chunk = new Uint8Array(64 * 1024).fill(0x61)
    const endless = new Response(new ReadableStream({
      pull(controller) {
        pulls += 1
        controller.enqueue(pulls === 1 ? new TextEncoder().encode('abcd') : chunk)
      },
    }), { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': '4', ...MARKER } })
    const h = harness({ respond: () => endless })
    const write = vi.spyOn(fs, 'writeSync')
    h.press()
    expect(await h.open()).toEqual({ ok: false, reason: 'failed' })
    // the first chunk fills the length; the second goes past it and ends the read before it is written
    expect(write.mock.calls.reduce((sum, call) => sum + Number(call[3] ?? 0), 0)).toBe(4)
    expect(pulls).toBeLessThan(6)
    expect(h.opened).toEqual([])
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

// ── the opener, in electron/link-open.cjs ─────────────────────────────────────

describe('openHubCopy: the one opener for a fetched copy (electron/link-open.cjs)', () => {
  const setup = () => {
    const root = scratchDir('hub-copy-')
    const dir = join(root, 'hub-files')
    const copy = join(dir, HUB, key(SPEC))
    mkdirSync(copy, { recursive: true, mode: 0o700 })
    writeFileSync(join(copy, 'spec.md'), '# spec')
    const opened: string[] = []
    const shell = { openPath: async (file: string) => { opened.push(file); return '' } }
    return { root, dir, copy, opened, shell }
  }

  it('opens a regular listed file inside the hub-files folder', async () => {
    const { dir, copy, opened, shell } = setup()
    expect(await openHubCopy(join(copy, 'spec.md'), { dir, shell })).toEqual({ ok: true })
    expect(opened).toEqual([join(copy, 'spec.md')].map((file) => realpathSync(file)))
  })

  it('refuses a path outside the folder, a link inside it that points outside, an unlisted extension and a directory', async () => {
    const { root, dir, copy, opened, shell } = setup()
    writeFileSync(join(root, 'outside.md'), 'x')
    symlinkSync(join(root, 'outside.md'), join(copy, 'escape.md'))
    writeFileSync(join(copy, 'page.html'), '<p>')
    mkdirSync(join(copy, 'folder.md'))
    writeFileSync(join(root, 'hub-files-evil.md'), 'x')
    expect(await openHubCopy(join(root, 'outside.md'), { dir, shell })).toEqual({ ok: false, reason: 'outside' })
    // a sibling folder whose name starts with the folder's name is still outside
    expect(await openHubCopy(join(root, 'hub-files-evil.md'), { dir, shell })).toEqual({ ok: false, reason: 'outside' })
    expect(await openHubCopy(join(copy, 'escape.md'), { dir, shell })).toEqual({ ok: false, reason: 'outside' })
    expect(await openHubCopy(join(copy, 'page.html'), { dir, shell })).toEqual({ ok: false, reason: 'type' })
    expect(await openHubCopy(join(copy, 'folder.md'), { dir, shell })).toEqual({ ok: false, reason: 'not_file' })
    expect(await openHubCopy(join(copy, 'missing.md'), { dir, shell })).toEqual({ ok: false, reason: 'not_file' })
    expect(await openHubCopy(dir, { dir, shell })).toEqual({ ok: false, reason: 'outside' })
    expect(await openHubCopy('spec.md', { dir, shell })).toEqual({ ok: false, reason: 'outside' })
    expect(opened).toEqual([])
  })

  it('refuses a dotfile, even with a listed extension', async () => {
    const { copy, dir, opened, shell } = setup()
    writeFileSync(join(copy, '.hidden.md'), 'x')
    expect(await openHubCopy(join(copy, '.hidden.md'), { dir, shell })).toEqual({ ok: false, reason: 'type' })
    expect(opened).toEqual([])
  })

  it('reads a folder that is itself reached through a link at its real place', async () => {
    const { root, dir, copy, opened, shell } = setup()
    symlinkSync(dir, join(root, 'via'))
    expect(await openHubCopy(join(root, 'via', HUB, key(SPEC), 'spec.md'), { dir, shell })).toEqual({ ok: true })
    expect(opened).toEqual([realpathSync(join(copy, 'spec.md'))])
  })

  it('says failed when the default app does not open it, or the shell throws', async () => {
    const { dir, copy } = setup()
    expect(await openHubCopy(join(copy, 'spec.md'), { dir, shell: { openPath: async () => 'No application' } })).toEqual({ ok: false, reason: 'failed' })
    expect(await openHubCopy(join(copy, 'spec.md'), { dir, shell: { openPath: async () => { throw new Error('x') } } })).toEqual({ ok: false, reason: 'failed' })
  })

  it('lists the same extensions as the hub', () => {
    expect([...HUB_COPY_EXTENSIONS]).toEqual([...DOCUMENT_EXTENSIONS])
  })
})

// #645: old copies are removed without opening anything: once soon after start and then every hour,
// on macOS only, whether or not a hub is connected. The timers are injected, so nothing here waits.
describe('the scheduled sweep of old copies', () => {
  function timers() {
    const unref = vi.fn()
    const world = {
      clock: { now: Date.UTC(2026, 10, 20) },
      first: null as null | { fn: () => void; ms: number },
      every: null as null | { fn: () => void; ms: number },
      unref,
      cleared: [] as unknown[],
      setTimeout: vi.fn((fn: () => void, ms: number) => { world.first = { fn, ms }; return { unref, kind: 'timeout' } }),
      setInterval: vi.fn((fn: () => void, ms: number) => { world.every = { fn, ms }; return { unref, kind: 'interval' } }),
      clearTimeout: vi.fn((handle: unknown) => { world.cleared.push(handle) }),
      clearInterval: vi.fn((handle: unknown) => { world.cleared.push(handle) }),
    }
    return world
  }
  const options = (world: ReturnType<typeof timers>, dir: string, extra: Record<string, unknown> = {}) => ({
    platform: 'darwin', dir, now: () => world.clock.now,
    setTimeout: world.setTimeout, setInterval: world.setInterval, clearTimeout: world.clearTimeout, clearInterval: world.clearInterval, ...extra,
  })
  const oldCopy = (dir: string, world: ReturnType<typeof timers>, copy = 'aaaaaaaaaaaaaaaa') => {
    const folder = join(dir, HUB, copy)
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    writeFileSync(join(folder, 'a.md'), 'old')
    const then = (world.clock.now - KEEP_MS - 1_000) / 1_000
    utimesSync(join(folder, 'a.md'), then, then)
    return folder
  }

  it('is ten seconds after start and then every hour', () => {
    expect(SWEEP_FIRST_MS).toBe(10_000)
    expect(SWEEP_EVERY_MS).toBe(60 * 60_000)
    const world = timers()
    scheduleCopySweep(options(world, join(scratchDir('hub-files-'), 'hub-files')))
    expect(world.first?.ms).toBe(10_000)
    expect(world.every).toBeNull()
  })

  it('removes an old copy at the first tick, and one that grew old later at an interval tick', () => {
    const world = timers()
    const dir = join(scratchDir('hub-files-'), 'hub-files')
    const first = oldCopy(dir, world)
    scheduleCopySweep(options(world, dir))
    expect(existsSync(first)).toBe(true)
    world.first!.fn()
    expect(existsSync(first)).toBe(false)
    expect(world.every?.ms).toBe(60 * 60_000)
    const later = oldCopy(dir, world, 'bbbbbbbbbbbbbbbb')
    world.every!.fn()
    expect(existsSync(later)).toBe(false)
  })

  it('keeps a copy younger than a day', () => {
    const world = timers()
    const dir = join(scratchDir('hub-files-'), 'hub-files')
    const fresh = join(dir, HUB, 'cccccccccccccccc')
    mkdirSync(fresh, { recursive: true, mode: 0o700 })
    writeFileSync(join(fresh, 'c.md'), 'fresh')
    scheduleCopySweep(options(world, dir))
    world.first!.fn()
    world.clock.now += 60 * 60_000
    world.every!.fn()
    expect(readdirSync(fresh)).toEqual(['c.md'])
  })

  it('leaves a missing folder missing, and never creates it', () => {
    const world = timers()
    const dir = join(scratchDir('hub-files-'), 'hub-files')
    scheduleCopySweep(options(world, dir))
    world.first!.fn()
    world.every!.fn()
    expect(existsSync(dir)).toBe(false)
    expect(existsSync(join(dir, '..'))).toBe(true)
  })

  it('does not follow a folder that is a link', () => {
    const world = timers()
    const real = join(scratchDir('hub-files-'), 'real')
    const copy = oldCopy(real, world)
    const dir = join(scratchDir('hub-files-link-'), 'hub-files')
    symlinkSync(real, dir)
    scheduleCopySweep(options(world, dir))
    world.first!.fn()
    expect(existsSync(copy)).toBe(true)
  })

  it('does nothing on another platform', () => {
    for (const platform of ['linux', 'win32']) {
      const world = timers()
      const dir = join(scratchDir('hub-files-'), 'hub-files')
      const copy = oldCopy(dir, world)
      expect(scheduleCopySweep(options(world, dir, { platform }))).toBeNull()
      expect(world.setTimeout).not.toHaveBeenCalled()
      expect(world.setInterval).not.toHaveBeenCalled()
      expect(existsSync(copy)).toBe(true)
    }
  })

  it('unrefs both timers, so they never keep the app alive', () => {
    const world = timers()
    scheduleCopySweep(options(world, join(scratchDir('hub-files-'), 'hub-files')))
    world.first!.fn()
    expect(world.unref).toHaveBeenCalledTimes(2)
  })

  it('can never throw into main: a sweep, a clock or a timer that throws is swallowed', () => {
    const world = timers()
    const dir = join(scratchDir('hub-files-'), 'hub-files')
    scheduleCopySweep(options(world, dir, { now: () => { throw new Error('clock') } }))
    expect(() => world.first!.fn()).not.toThrow()
    expect(() => world.every!.fn()).not.toThrow()
    const broken = timers()
    broken.setTimeout.mockImplementation(() => { throw new Error('timer') })
    expect(() => scheduleCopySweep(options(broken, dir))).not.toThrow()
    expect(() => scheduleCopySweep(options(timers(), dir, { sweep: () => { throw new Error('sweep') } }))).not.toThrow()
  })

  it('stops when told to: both timers are cleared', () => {
    const world = timers()
    const dir = join(scratchDir('hub-files-'), 'hub-files')
    const stop = scheduleCopySweep(options(world, dir))!
    world.first!.fn()
    stop()
    expect(world.cleared).toEqual([expect.objectContaining({ kind: 'interval' })])
    const early = timers()
    scheduleCopySweep(options(early, dir))!()
    expect(early.cleared).toEqual([expect.objectContaining({ kind: 'timeout' })])
  })

  it('reads no connection file and calls no safeStorage: the module still has neither', () => {
    expect(readText(join(import.meta.dirname, '..', 'electron', 'hub-files.cjs'), 'utf8')).not.toMatch(/safeStorage|remote-connection|connection\.json/)
  })
})
