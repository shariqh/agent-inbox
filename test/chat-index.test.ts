import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, mkdirSync, readdirSync, readFileSync, lstatSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { chatsResponse, CHAT_WINDOW_BYTES, createChatIndex, MAX_CHATS } from '../src/chat-index.js'
import type { ChatEntry, ChatIndexOpts, ChatIndexRead } from '../src/chat-index.js'
import { createLaunch, endActivity, openDb, upsertActivity } from '../src/store.js'
import { createViewer } from '../src/viewer.js'
import { startLocalViewer } from '../src/viewer-network.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

afterEach(removeScratchDirs)

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const rec = (o: object) => JSON.stringify(o)
const at = (n: number) => `2026-11-14T10:00:${String(n).padStart(2, '0')}.000Z`
// A folder that exists and is not under a temp folder, so the hidden arrays below are exact. It sits in node_modules
// (not $TMPDIR, which is a temp folder) and has an empty .git, so the walk up for an origin stops here, reads nothing,
// and the project is named after the folder.
const FIXTURES = join(import.meta.dirname, '..', 'node_modules', '.cache', `chat-index-${process.pid}-${Date.now()}`)
const CWD = join(FIXTURES, 'widget')
mkdirSync(join(CWD, '.git'), { recursive: true })
afterAll(() => rmSync(FIXTURES, { recursive: true, force: true }))
// a folder that is not there (a test that wants it to appear makes it, inside FIXTURES)
const GONE = join(FIXTURES, 'gone')
const HOUR = 3_600_000

const home = () => scratchDir('chat-home-')
const put = (path: string, text: string) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

/** A Claude transcript: head records, then padBytes of filler (with a MIDDLE title in it), then tail records. */
function claude(h: string, slug: string, uuid: string, head: object[], tail: object[] = [], padBytes = 0): string {
  const filler = rec({ type: 'attachment', pad: 'x'.repeat(900) })
  const pad: string[] = []
  for (let n = 0; n * filler.length < padBytes; n++) {
    pad.push(filler)
    if (n === Math.floor(padBytes / filler.length / 2)) pad.push(rec({ type: 'ai-title', aiTitle: 'MIDDLE' }), rec({ type: 'user', cwd: '/Users/example/middle' }))
  }
  const path = join(h, '.claude', 'projects', slug, `${uuid}.jsonl`)
  put(path, [...head, ...tail].length ? `${[...head.map(rec), ...pad, ...tail.map(rec)].join('\n')}\n` : '')
  return path
}

function copilot(h: string, uuid: string, yaml: string[], opts: { events?: boolean; locks?: number[] } = {}): string {
  const dir = join(h, '.copilot', 'session-state', uuid)
  put(join(dir, 'workspace.yaml'), `${yaml.join('\n')}\n`)
  if (opts.events) put(join(dir, 'events.jsonl'), '{}\n')
  for (const pid of opts.locks ?? []) put(join(dir, `inuse.${pid}.lock`), '')
  return dir
}
const yaml = (uuid: string, extra: string[] = []) => [
  `id: ${uuid}`, `cwd: ${CWD}`, 'client_name: github/cli', 'created_at: 2026-11-14T09:00:00.000Z', 'updated_at: 2026-11-14T09:30:00.000Z', ...extra,
]
const session = (h: string, pid: number, doc: Record<string, unknown>) => put(join(h, '.claude', 'sessions', `${pid}.json`), JSON.stringify({ pid, ...doc }))

const open = (h: string, extra: Partial<ChatIndexOpts> = {}) =>
  createChatIndex({ home: h, isAlive: () => false, bootTimeMs: () => Date.now() - HOUR, ...extra })
const byId = (read: ChatIndexRead, uuid: string): ChatEntry => {
  const entry = read.chats.find((c) => c.id === uuid)
  expect(entry, `chat ${uuid} is listed`).toBeDefined()
  return entry!
}

const basicHead = [{ type: 'user', cwd: CWD, gitBranch: 'main', entrypoint: 'cli', timestamp: at(1) }]

describe('chat index: Claude Code transcripts (#586)', () => {
  it('lists a Claude chat from the head and tail', () => {
    const h = home()
    claude(h, '-Users-example-dev-widget', id(1), basicHead, [
      { type: 'ai-title', aiTitle: 'Fix the widget' },
      { type: 'pr-link', prNumber: 5, prRepository: 'example/widget', prUrl: 'https://github.com/example/widget/pull/5', timestamp: at(8) },
      { type: 'assistant', gitBranch: 'feature', timestamp: at(9) },
    ], 200_000)
    const read = open(h).read()
    expect(read.truncated).toBe(false)
    expect(byId(read, id(1))).toEqual({
      id: id(1), tool: 'claude', title: 'Fix the widget', titleAuto: false, project: 'widget', cwd: CWD, branch: 'feature', createdAt: at(1),
      lastActiveAt: expect.any(String), live: false, pr: { number: 5, repo: 'example/widget', url: 'https://github.com/example/widget/pull/5' }, hidden: [],
    })
  })

  it('reads a huge transcript by its head and tail only', () => {
    const h = home()
    const path = claude(h, '-Users-example-dev-widget', id(1), basicHead, [{ type: 'ai-title', aiTitle: 'Tail title' }, { type: 'user', timestamp: at(5) }], 5 * 1024 * 1024)
    expect(lstatSync(path).size).toBeGreaterThan(5 * 1024 * 1024)
    const read = open(h).read()
    const entry = byId(read, id(1))
    expect(entry.title).toBe('Tail title')
    expect(entry.cwd).toBe(CWD)
    expect(read.work.filesRead).toBe(1)
    // counted from what readSync returned: one head window and one tail window, not the 5 MiB file
    expect(read.work.bytesRead).toBe(2 * CHAT_WINDOW_BYTES)
  })

  it('a tail window with no complete record still sorts by the file mtime', () => {
    const h = home()
    const path = claude(h, '-Users-example-dev-widget', id(1), basicHead, [{ type: 'attachment', pad: 'y'.repeat(200_000) }])
    const recent = new Date(Date.now() - 60_000)
    utimesSync(path, recent, recent)
    // the last 64 KiB is the inside of one giant line, which the tail rule drops
    expect(byId(open(h).read(), id(1)).lastActiveAt).toBe(recent.toISOString())
  })

  it('a truncated transcript lists, and an empty one lists nothing', () => {
    const h = home()
    const cut = claude(h, '-Users-example-dev-widget', id(1), basicHead)
    appendFileSync(cut, '{"type":"user","cwd":"/Users/exa')
    put(join(h, '.claude', 'projects', '-Users-example-dev-widget', `${id(2)}.jsonl`), '')
    const read = open(h).read()
    expect(read.chats.map((c) => c.id)).toEqual([id(1)])
    expect(byId(read, id(1)).cwd).toBe(CWD)
  })

  it('applies the id rule to files and project folders', () => {
    const h = home()
    claude(h, '-Users-example-dev-widget', id(1), basicHead)
    const slugDir = join(h, '.claude', 'projects', '-Users-example-dev-widget')
    for (const name of ['notes.jsonl', `${id(2).replace(/^0/, 'A')}.jsonl`, `${id(3)}.JSONL`, `${id(4)}.jsonl.bak`]) put(join(slugDir, name), rec(basicHead[0]!))
    claude(h, '..x', id(5), basicHead)
    claude(h, 'has space', id(6), basicHead)
    expect(open(h).read().chats.map((c) => c.id)).toEqual([id(1)])
  })

  it('skips symlinks and special files without following or throwing', () => {
    const h = home()
    const dir = join(h, '.claude', 'projects', '-Users-example-dev-widget')
    const real = claude(h, 'real-one', id(1), basicHead)
    mkdirSync(dir, { recursive: true })
    symlinkSync(real, join(dir, `${id(2)}.jsonl`))
    mkdirSync(join(dir, `${id(3)}.jsonl`), { recursive: true })
    if (process.platform !== 'win32') spawnSync('mkfifo', [join(dir, `${id(4)}.jsonl`)])
    const locked = claude(h, '-Users-example-dev-widget', id(5), basicHead)
    chmodSync(locked, 0o000)
    // a symlinked project folder, and a symlinked Copilot folder and workspace.yaml
    symlinkSync(join(h, '.claude', 'projects', 'real-one'), join(h, '.claude', 'projects', 'linked'))
    const cop = copilot(h, id(6), yaml(id(6)))
    symlinkSync(cop, join(h, '.copilot', 'session-state', id(7)))
    const dir8 = join(h, '.copilot', 'session-state', id(8))
    mkdirSync(dir8)
    symlinkSync(join(cop, 'workspace.yaml'), join(dir8, 'workspace.yaml'))

    const started = Date.now()
    const read = open(h).read()
    chmodSync(locked, 0o600)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(read.chats.map((c) => c.id).sort()).toEqual([id(1), id(6)])
  })

  it('keeps a title found by an earlier read when the chat only grew past its windows', () => {
    const h = home()
    const path = claude(h, '-Users-example-dev-widget', id(1), basicHead, [{ type: 'ai-title', aiTitle: 'Kept title' }], 100_000)
    const index = open(h)
    expect(byId(index.read(), id(1)).title).toBe('Kept title')
    appendFileSync(path, `${Array.from({ length: 120 }, () => rec({ type: 'attachment', pad: 'z'.repeat(1000) })).join('\n')}\n`)
    expect(byId(index.read(), id(1)).title).toBe('Kept title')
  })

  const prLink = (n: number) => ({ type: 'pr-link', prNumber: n, prRepository: 'example/widget', prUrl: `https://github.com/example/widget/pull/${n}`, timestamp: at(n) })

  it('trusts a fresh read of a chat that fits in one window: a rename and a second PR show up', () => {
    const h = home()
    const path = claude(h, '-Users-example-dev-widget', id(1), basicHead, [{ type: 'ai-title', aiTitle: 'First' }, prLink(1)])
    const index = open(h)
    expect(byId(index.read(), id(1))).toMatchObject({ title: 'First', pr: { number: 1 } })
    appendFileSync(path, `${[rec({ type: 'custom-title', customTitle: 'Renamed' }), rec(prLink(2))].join('\n')}\n`)
    expect(byId(index.read(), id(1))).toMatchObject({ title: 'Renamed', pr: { number: 2 } })
  })

  it('does not merge a file replaced at the same size into the old entry', () => {
    const h = home()
    const slug = '-Users-example-dev-widget'
    const mk = (cwd: string, title: string) => claude(h, slug, id(1), [{ type: 'user', cwd, timestamp: at(1) }], [{ type: 'ai-title', aiTitle: title }, prLink(1)])
    const path = mk('/Users/example/dev/one', 'AAAAA')
    const index = open(h)
    expect(byId(index.read(), id(1)).title).toBe('AAAAA')
    const was = lstatSync(path)
    // the same byte length and a new first record, with no title and no PR of its own
    writeFileSync(path, `${rec({ type: 'user', cwd: '/Users/example/dev/two', timestamp: at(1) })}\n${' '.repeat(was.size - rec({ type: 'user', cwd: '/Users/example/dev/two', timestamp: at(1) }).length - 1)}`)
    expect(lstatSync(path).size).toBe(was.size)
    const later = new Date(Date.now() + 5_000)
    utimesSync(path, later, later)
    expect(byId(index.read(), id(1))).toMatchObject({ cwd: '/Users/example/dev/two', title: null, pr: null })
  })

  it('does not carry a title across a replaced large file whose first record changed', () => {
    const h = home()
    const slug = '-Users-example-dev-widget'
    const path = claude(h, slug, id(1), basicHead, [{ type: 'ai-title', aiTitle: 'Old chat' }], 100_000)
    const index = open(h)
    expect(byId(index.read(), id(1)).title).toBe('Old chat')
    claude(h, slug, id(1), [{ type: 'user', cwd: '/Users/example/dev/other', timestamp: at(2) }], [{ type: 'user', timestamp: at(9) }], 150_000)
    const later = new Date(Date.now() + 5_000)
    utimesSync(path, later, later)
    expect(byId(index.read(), id(1))).toMatchObject({ cwd: '/Users/example/dev/other', title: null })
  })
})

describe('chat index: Copilot CLI folders (#586)', () => {
  it('lists a Copilot chat from workspace.yaml, titled by the name Copilot shows for it', () => {
    const h = home()
    copilot(h, id(1), yaml(id(1), ['branch: main', 'repository: example/widget', 'user_named: true', 'name: A name I typed']), { events: true })
    copilot(h, id(2), [...yaml(id(2)), 'name: |-', '  Opening of the first prompt', '  SECRET-SECOND-LINE of the prompt'], { events: true })
    copilot(h, id(3), yaml(id(3)), { events: true })
    const read = open(h).read()
    expect(byId(read, id(1))).toEqual({
      id: id(1), tool: 'copilot', title: 'A name I typed', titleAuto: false, project: 'widget', cwd: CWD, branch: 'main', createdAt: '2026-11-14T09:00:00.000Z',
      lastActiveAt: expect.any(String), live: false, pr: null, hidden: [],
    })
    expect(byId(read, id(2))).toMatchObject({ title: 'Opening of the first prompt', titleAuto: true })
    expect(byId(read, id(3))).toMatchObject({ title: null, titleAuto: false })
    // the opening line of an automatic name is the only prompt text that comes back
    expect(JSON.stringify(read.chats)).not.toContain('SECRET')
  })

  it('titleAuto: user_named true or false, a long name, and a missing name', () => {
    const h = home()
    copilot(h, id(1), yaml(id(1), ['user_named: true', 'name: Typed']), { events: true })
    copilot(h, id(2), yaml(id(2), ['user_named: false', 'name: Automatic']), { events: true })
    copilot(h, id(3), yaml(id(3), [`name: ${'long '.repeat(60)}`]), { events: true })
    copilot(h, id(4), yaml(id(4), ['user_named: true']), { events: true })
    const read = open(h).read()
    expect([id(1), id(2), id(3), id(4)].map((n) => [byId(read, n).title === null ? null : Array.from(byId(read, n).title!).length, byId(read, n).titleAuto])).toEqual([
      [5, false], [9, true], [120, true], [null, false],
    ])
    expect(byId(read, id(3)).title!.endsWith('\u2026')).toBe(true)
  })

  it('a Claude title is never automatic, typed or generated', () => {
    const h = home()
    claude(h, 'a', id(1), basicHead, [{ type: 'ai-title', aiTitle: 'Generated' }])
    claude(h, 'a', id(2), basicHead, [{ type: 'custom-title', customTitle: 'Typed' }])
    claude(h, 'a', id(3), basicHead)
    const read = open(h).read()
    expect([1, 2, 3].map((n) => [byId(read, id(n)).title, byId(read, id(n)).titleAuto])).toEqual([['Generated', false], ['Typed', false], [null, false]])
  })

  it('skips a folder with no workspace.yaml, a mismatched id, or an oversized file', () => {
    const h = home()
    mkdirSync(join(h, '.copilot', 'session-state', id(1)), { recursive: true })
    copilot(h, id(2), yaml(id(3)))
    copilot(h, id(4), [...yaml(id(4)), `name: ${'x'.repeat(70_000)}`])
    copilot(h, id(5), yaml(id(5)))
    copilot(h, `pending-session:${id(6)}`, yaml(id(6)))
    copilot(h, `optimistic-${id(7)}`, yaml(id(7)))
    expect(open(h).read().chats.map((c) => c.id)).toEqual([id(5)])
  })

  it('uses the later of updated_at and the events.jsonl mtime, checked on every read', () => {
    const h = home()
    const dir = copilot(h, id(1), yaml(id(1)), { events: true })
    const index = open(h)
    expect(byId(index.read(), id(1)).lastActiveAt).not.toBe('2026-11-14T09:30:00.000Z')
    const resumed = new Date('2026-12-01T00:00:00.000Z')
    utimesSync(join(dir, 'events.jsonl'), resumed, resumed)
    expect(byId(index.read(), id(1)).lastActiveAt).toBe(resumed.toISOString())
  })

  it('a missing events.jsonl marks the chat empty, and one that appears later clears it', () => {
    const h = home()
    const dir = copilot(h, id(1), yaml(id(1)))
    const index = open(h)
    expect(byId(index.read(), id(1)).hidden).toEqual(['empty'])
    writeFileSync(join(dir, 'events.jsonl'), '{}\n')
    expect(byId(index.read(), id(1)).hidden).toEqual([])
  })
})

describe('chat index: hidden reasons (#586)', () => {
  it('hides temp folders, sdk runs and driver sessions, each with an exact reason list', () => {
    const h = home()
    // the temp folders are not on disk, so they are gone as well
    claude(h, 'a', id(1), [{ type: 'user', cwd: '/tmp/chat-index-never-there', entrypoint: 'cli', timestamp: at(1) }])
    claude(h, 'b', id(2), [{ type: 'user', cwd: CWD, entrypoint: 'sdk-cli', timestamp: at(1) }])
    claude(h, 'c', id(3), [{ type: 'user', cwd: '/private/var/folders/xy/T/run', entrypoint: 'sdk-cli', timestamp: at(1) }])
    claude(h, 'd', id(4), [{ type: 'user', cwd: CWD, entrypoint: 'claude-vscode', timestamp: at(1) }])
    copilot(h, id(5), [`id: ${id(5)}`, 'cwd: /var/folders/ab/T/x', 'client_name: agent-inbox-driver', 'updated_at: 2026-11-14T09:30:00.000Z'])
    copilot(h, id(6), yaml(id(6)), { events: true })
    const read = open(h).read()
    expect(Object.fromEntries(read.chats.map((c) => [c.id, c.hidden]))).toEqual({
      [id(1)]: ['temp', 'folder-gone'], [id(2)]: ['non-interactive'], [id(3)]: ['temp', 'non-interactive', 'folder-gone'], [id(4)]: [],
      [id(5)]: ['temp', 'non-interactive', 'empty', 'folder-gone'], [id(6)]: [],
    })
  })

  describe('folder-gone', () => {
    const reasons = (h: string, uuid: string) => byId(open(h).read(), uuid).hidden

    it('Claude: an existing folder is not gone, a deleted folder and a missing cwd are', () => {
      const h = home()
      const dir = scratchDir('chat-folder-')
      claude(h, 'a', id(1), [{ type: 'user', cwd: CWD, entrypoint: 'cli', timestamp: at(1) }])
      claude(h, 'a', id(2), [{ type: 'user', cwd: GONE, entrypoint: 'cli', timestamp: at(1) }])
      claude(h, 'a', id(3), [{ type: 'user', entrypoint: 'cli', timestamp: at(1) }])
      claude(h, 'a', id(4), [{ type: 'user', cwd: join(dir, 'file'), entrypoint: 'cli', timestamp: at(1) }])
      put(join(dir, 'file'), 'not a folder')
      claude(h, 'a', id(5), [{ type: 'user', cwd: join(dir, 'file', 'below'), entrypoint: 'cli', timestamp: at(1) }])
      // the file's folder is a scratch folder, so those two are also `temp`
      expect([1, 2, 3, 4, 5].map((n) => reasons(h, id(n)).filter((r) => r !== 'temp'))).toEqual([[], ['folder-gone'], ['folder-gone'], ['folder-gone'], ['folder-gone']])
    })

    it('Copilot: an existing folder is not gone, a deleted folder and a missing cwd are', () => {
      const h = home()
      copilot(h, id(1), yaml(id(1)), { events: true })
      copilot(h, id(2), [...yaml(id(2)).filter((l) => !l.startsWith('cwd:')), `cwd: ${GONE}`], { events: true })
      copilot(h, id(3), yaml(id(3)).filter((l) => !l.startsWith('cwd:')), { events: true })
      expect([1, 2, 3].map((n) => reasons(h, id(n)))).toEqual([[], ['folder-gone'], ['folder-gone']])
    })

    it('Copilot: it is the chat\'s cwd that counts, not the git root above it', () => {
      const h = home()
      const rooted = (n: number, cwd: string, root: string) => [...yaml(id(n)).filter((l) => !l.startsWith('cwd:')), `cwd: ${cwd}`, `git_root: ${root}`]
      copilot(h, id(1), rooted(1, GONE, CWD), { events: true })
      copilot(h, id(2), rooted(2, CWD, GONE), { events: true })
      const read = open(h).read()
      expect(byId(read, id(1)).hidden).toEqual(['folder-gone'])
      expect(byId(read, id(2)).hidden).toEqual([])
    })

    it('a folder that exists but cannot be read is not gone, for both tools', () => {
      const h = home()
      const locked = scratchDir('chat-locked-')
      chmodSync(locked, 0o000)
      try {
        claude(h, 'a', id(1), [{ type: 'user', cwd: locked, entrypoint: 'cli', timestamp: at(1) }])
        copilot(h, id(2), [...yaml(id(2)).filter((l) => !l.startsWith('cwd:')), `cwd: ${locked}`], { events: true })
        const read = open(h).read()
        expect(byId(read, id(1)).hidden).not.toContain('folder-gone')
        expect(byId(read, id(2)).hidden).not.toContain('folder-gone')
      } finally {
        chmodSync(locked, 0o700)
      }
    })

    it('a symlink loop and a path too long to exist are gone, for both tools', () => {
      const h = home()
      const dir = scratchDir('chat-loop-')
      const loop = join(dir, 'loop')
      symlinkSync(loop, loop)
      const long = `/${'a'.repeat(2000)}`
      claude(h, 'a', id(1), [{ type: 'user', cwd: loop, entrypoint: 'cli', timestamp: at(1) }])
      copilot(h, id(2), [...yaml(id(2)).filter((l) => !l.startsWith('cwd:')), `cwd: ${loop}`], { events: true })
      claude(h, 'a', id(3), [{ type: 'user', cwd: long, entrypoint: 'cli', timestamp: at(1) }])
      const read = open(h).read()
      for (const n of [1, 2, 3]) expect(byId(read, id(n)).hidden).toContain('folder-gone')
    })

    it('a folder whose parent cannot be searched is not gone either', () => {
      if (process.getuid?.() === 0) return // root searches every folder
      const h = home()
      const parent = scratchDir('chat-parent-')
      mkdirSync(join(parent, 'inner'))
      chmodSync(parent, 0o000)
      try {
        claude(h, 'a', id(1), [{ type: 'user', cwd: join(parent, 'inner'), entrypoint: 'cli', timestamp: at(1) }])
        expect(byId(open(h).read(), id(1)).hidden).not.toContain('folder-gone')
      } finally {
        chmodSync(parent, 0o700)
      }
    })

    it('caches whether a folder exists for 60 seconds', () => {
      const h = home()
      for (const n of [1, 2, 3]) claude(h, 'a', id(n), [{ type: 'user', cwd: GONE, entrypoint: 'cli', timestamp: at(1) }])
      for (const n of [4, 5]) copilot(h, id(n), [...yaml(id(n)).filter((l) => !l.startsWith('cwd:')), `cwd: ${GONE}`], { events: true })
      let clock = 1_700_000_000_000
      const index = open(h, { now: () => clock })
      expect(index.read().chats.every((c) => c.hidden.includes('folder-gone'))).toBe(true)
      // a folder that appears is seen once the 60 second cache is stale, not before
      mkdirSync(GONE, { recursive: true })
      try {
        clock += 1000
        expect(index.read().chats.every((c) => c.hidden.includes('folder-gone'))).toBe(true)
        clock += 61_000
        expect(index.read().chats.some((c) => c.hidden.includes('folder-gone'))).toBe(false)
      } finally {
        rmSync(GONE, { recursive: true, force: true })
      }
    })
  })
})

describe('chat index: live chats (#586)', () => {
  const alive = (...pids: number[]) => (pid: number) => pids.includes(pid)

  it('Claude: a live pid file makes the chat live, a dead one does not', () => {
    const h = home()
    claude(h, 'a', id(1), basicHead)
    claude(h, 'a', id(2), basicHead)
    session(h, 4001, { sessionId: id(1), cwd: CWD, status: 'idle', startedAt: Date.now() })
    session(h, 4002, { sessionId: id(2), cwd: CWD, status: 'idle', startedAt: Date.now() })
    const read = open(h, { isAlive: alive(4001) }).read()
    expect([byId(read, id(1)).live, byId(read, id(2)).live]).toEqual([true, false])
  })

  it('Claude: a pid reused after a reboot, or a file whose pid is not its name, is not live', () => {
    const h = home()
    for (const n of [1, 2, 3]) claude(h, 'a', id(n), basicHead)
    session(h, 4001, { sessionId: id(1), startedAt: Date.now() - 2 * HOUR })
    put(join(h, '.claude', 'sessions', '4002.json'), JSON.stringify({ pid: 9999, sessionId: id(2), startedAt: Date.now() }))
    session(h, 4003, { sessionId: id(3), startedAt: Date.now() })
    const read = open(h, { isAlive: alive(4001, 4002, 4003) }).read()
    expect([id(1), id(2), id(3)].map((n) => byId(read, n).live)).toEqual([false, false, true])
  })

  it('Copilot: a lock with a live pid makes the chat live, and stale locks do not', () => {
    const h = home()
    copilot(h, id(1), yaml(id(1)), { events: true, locks: [5001] })
    copilot(h, id(2), yaml(id(2)), { events: true, locks: [5002] })
    const read = open(h, { isAlive: alive(5001) }).read()
    expect([byId(read, id(1)).live, byId(read, id(2)).live]).toEqual([true, false])
  })

  it('Copilot: a lock older than this boot is not live, and one pid in two folders is live in the newer only', () => {
    const h = home()
    const old = copilot(h, id(1), yaml(id(1)), { events: true, locks: [5001] })
    const past = new Date(Date.now() - 2 * HOUR)
    utimesSync(join(old, 'inuse.5001.lock'), past, past)
    const a = copilot(h, id(2), yaml(id(2)), { events: true, locks: [5002] })
    const b = copilot(h, id(3), yaml(id(3)), { events: true, locks: [5002] })
    utimesSync(join(a, 'inuse.5002.lock'), new Date(Date.now() - 1000), new Date(Date.now() - 1000))
    utimesSync(join(b, 'inuse.5002.lock'), new Date(), new Date())
    const read = open(h, { isAlive: alive(5001, 5002) }).read()
    expect([id(1), id(2), id(3)].map((n) => byId(read, n).live)).toEqual([false, false, true])
  })

  it('without an injected isAlive it asks process.kill(pid, 0)', () => {
    const h = home()
    copilot(h, id(1), yaml(id(1)), { events: true, locks: [process.pid] })
    const finished = spawnSync(process.execPath, ['-e', '']).pid!
    copilot(h, id(2), yaml(id(2)), { events: true, locks: [finished] })
    const read = createChatIndex({ home: h }).read()
    expect([byId(read, id(1)).live, byId(read, id(2)).live]).toEqual([true, false])
  })

  // Jump to session (#586): the route joins a live chat to its session card by these, and never serves them
  it('names the processes that make a chat live, beside the entries and never in one', () => {
    const h = home()
    for (const n of [1, 2, 3]) claude(h, 'a', id(n), basicHead)
    session(h, 4001, { sessionId: id(1), startedAt: Date.now() })
    // one chat open in two processes, and one whose process is gone
    session(h, 4002, { sessionId: id(2), startedAt: Date.now() })
    session(h, 4003, { sessionId: id(2), startedAt: Date.now() })
    session(h, 4004, { sessionId: id(3), startedAt: Date.now() })
    copilot(h, id(4), yaml(id(4)), { events: true, locks: [5001, 5009] })
    // one pid in two folders holds only the newer
    const a = copilot(h, id(5), yaml(id(5)), { events: true, locks: [5002] })
    const b = copilot(h, id(6), yaml(id(6)), { events: true, locks: [5002] })
    utimesSync(join(a, 'inuse.5002.lock'), new Date(Date.now() - 1000), new Date(Date.now() - 1000))
    utimesSync(join(b, 'inuse.5002.lock'), new Date(), new Date())
    const read = open(h, { isAlive: alive(4001, 4002, 4003, 5001, 5002) }).read()
    const pids = Object.fromEntries([...read.livePids!].map(([key, list]) => [key, [...list].sort()]))
    expect(pids).toEqual({
      [`claude:${id(1)}`]: [4001],
      [`claude:${id(2)}`]: [4002, 4003],
      [`copilot:${id(4)}`]: [5001],
      [`copilot:${id(6)}`]: [5002],
    })
    // exactly the live chats have one
    expect(read.chats.filter((c) => c.live).map((c) => `${c.tool}:${c.id}`).sort()).toEqual(Object.keys(pids).sort())
    for (const chat of read.chats) expect(Object.keys(chat)).not.toContain('pid')
    expect(JSON.stringify(read.chats)).not.toMatch(/"pids?"/)
  })
})

describe('chat index: cache and bounds (#586)', () => {
  it('rereads only what changed', () => {
    const h = home()
    const one = claude(h, 'a', id(1), basicHead, [{ type: 'ai-title', aiTitle: 'One' }])
    claude(h, 'a', id(2), basicHead)
    copilot(h, id(3), yaml(id(3)), { events: true })
    const index = open(h, { now: () => 1_700_000_000_000 })
    const first = index.read()
    expect(first.work.filesRead).toBe(3)
    const second = index.read()
    expect(second.work).toEqual({ filesRead: 0, bytesRead: 0 })
    expect(second.chats).toEqual(first.chats)
    appendFileSync(one, `${rec({ type: 'assistant', timestamp: at(30) })}\n`)
    expect(index.read().work.filesRead).toBe(1)
  })

  it('stops at the file cap and reports truncated', () => {
    const h = home()
    for (const n of [1, 2, 3]) claude(h, 'a', id(n), basicHead)
    const read = open(h, { limits: { claudeFiles: 2 } }).read()
    expect(read.chats).toHaveLength(2)
    expect(read.truncated).toBe(true)
  })

  it('spends the fresh-read budget on the newest chats and finishes the rest on the next read', () => {
    const h = home()
    const paths = [1, 2, 3].map((n) => claude(h, 'a', id(n), basicHead, [{ type: 'user', timestamp: at(n) }], 200_000))
    paths.forEach((p, i) => utimesSync(p, new Date(Date.now() - (3 - i) * 60_000), new Date(Date.now() - (3 - i) * 60_000)))
    const index = open(h, { limits: { freshBytes: 2 * CHAT_WINDOW_BYTES + 1 } })
    const first = index.read()
    expect(first.truncated).toBe(true)
    expect(first.chats.map((c) => c.id)).toEqual([id(3)])
    const second = index.read()
    expect(second.chats.map((c) => c.id).sort()).toEqual([id(2), id(3)])
    expect(index.read().chats).toHaveLength(3)
    expect(index.read().truncated).toBe(false)
  })

  it('stops at the Copilot folder cap and reports truncated', () => {
    const h = home()
    copilot(h, id(1), yaml(id(1)))
    copilot(h, id(2), yaml(id(2)))
    const read = open(h, { limits: { copilotDirs: 1 } }).read()
    expect(read.chats).toHaveLength(1)
    expect(read.truncated).toBe(true)
  })

  it('reads nothing when created, and sees chats written afterwards on the first read', () => {
    const h = join(scratchDir('chat-lazy-'), 'later')
    const index = open(h)
    claude(h, 'a', id(1), basicHead)
    expect(index.read().chats.map((c) => c.id)).toEqual([id(1)])
  })

  it('returns an empty list on Windows, where the index is POSIX-only for now', () => {
    const h = home()
    claude(h, 'a', id(1), basicHead)
    expect(open(h, { platform: 'win32' }).read()).toEqual({ chats: [], truncated: false, work: { filesRead: 0, bytesRead: 0 } })
  })

  it('never writes to either tool folder', () => {
    const h = home()
    claude(h, 'a', id(1), basicHead, [{ type: 'ai-title', aiTitle: 'T' }], 200_000)
    copilot(h, id(2), yaml(id(2)), { events: true, locks: [5001] })
    session(h, 4001, { sessionId: id(1), startedAt: Date.now() })
    const snapshot = (dir: string): string[] => readdirSync(dir, { withFileTypes: true, recursive: true })
      .map((d) => { const p = join(d.parentPath, d.name); const s = lstatSync(p); return `${p}|${s.size}|${s.mtimeMs}|${s.mode}` }).sort()
    const before = snapshot(h)
    const index = open(h, { isAlive: () => true })
    index.read()
    index.read()
    index.claudeDays()
    expect(snapshot(h)).toEqual(before)
  })
})

describe('chat index: project names without spawning git (#586)', () => {
  const widget = (h: string) => {
    const repo = join(h, 'repo')
    put(join(repo, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:example/widget.git\n')
    return repo
  }

  it('uses the repository for a folder that no longer exists, and the folder name when nothing else is known', () => {
    const h = home()
    copilot(h, id(1), [...yaml(id(1)), 'repository: example/widget'], { events: true })
    copilot(h, id(2), yaml(id(2)), { events: true })
    const read = open(h).read()
    expect([byId(read, id(1)).project, byId(read, id(2)).project]).toEqual(['widget', 'widget'])
    copilot(h, id(3), [`id: ${id(3)}`, 'cwd: /Users/example/dev/other-thing'], { events: true })
    expect(byId(open(h).read(), id(3)).project).toBe('other-thing')
  })

  it('names a worktree after its repository, through the .git file and commondir', () => {
    const h = home()
    const repo = widget(h)
    put(join(repo, '.git', 'worktrees', 'x', 'commondir'), '../..\n')
    const tree = join(h, 'widget-wt-feature')
    put(join(tree, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'x')}\n`)
    copilot(h, id(1), [`id: ${id(1)}`, `cwd: ${tree}`, `git_root: ${tree}`], { events: true })
    expect(byId(open(h).read(), id(1)).project).toBe('widget')
  })

  it('walks up from a subfolder of a repository', () => {
    const h = home()
    const sub = join(widget(h), 'src', 'deep')
    mkdirSync(sub, { recursive: true })
    claude(h, 'a', id(1), [{ type: 'user', cwd: sub, timestamp: at(1) }])
    expect(byId(open(h).read(), id(1)).project).toBe('widget')
  })

  it('names a Claude chat in an existing non-git folder after the folder, not after its PR repository', () => {
    const h = home()
    const plain = join(h, 'scratch-notes')
    mkdirSync(plain, { recursive: true })
    const pr = { type: 'pr-link', prNumber: 4, prRepository: 'example/elsewhere', prUrl: 'https://github.com/example/elsewhere/pull/4', timestamp: at(4) }
    claude(h, 'a', id(1), [{ type: 'user', cwd: plain, timestamp: at(1) }], [pr])
    claude(h, 'b', id(2), [{ type: 'user', cwd: join(h, 'gone-folder'), timestamp: at(1) }], [pr])
    const read = open(h).read()
    expect(byId(read, id(1)).project).toBe('scratch-notes')
    // the folder is gone, so the PR's repository is the best name left
    expect(byId(read, id(2)).project).toBe('elsewhere')
  })

  it('does not walk up from a folder that is gone', () => {
    const h = home()
    const repo = widget(h)
    claude(h, 'a', id(1), [{ type: 'user', cwd: join(repo, 'deleted', 'folder'), timestamp: at(1) }])
    expect(byId(open(h).read(), id(1)).project).toBe('folder')
  })

  it('imports only what it may, so it can never run git', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'chat-index.ts'), 'utf8')
    const imports = [...src.matchAll(/^import (type )?\{([^}]*)\} from '([^']+)'/gm)].map((m) => `${m[1] ? 'type ' : ''}${m[3]}: ${m[2]!.split(',').map((s) => s.trim()).filter(Boolean).sort().join(',')}`)
    expect(imports).toEqual([
      'node:fs: closeSync,constants,fstatSync,lstatSync,openSync,readSync,readdirSync,statSync',
      'type node:fs: Dirent',
      'node:os: uptime',
      'node:path: dirname,join,resolve',
      './infer.js: inferProject',
      './chat-parse.js: BOOT_SLACK_MS,hiddenReasons,isChatId,lockHeld,lockPid,parseClaudeLiveFile,parseClaudeWindows,parseGitOrigin,parseGitdirPointer,parseWorkspaceYaml,retentionDays,sessionFilePid',
      'type ./chat-parse.js: ChatHiddenReason,ChatPr,ChatTool,ClaudeMeta,CopilotMeta',
    ])
    const code = src.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n')
    expect(code).not.toMatch(/child_process|execFile|execSync|spawn|remoteUrl|inferStream|inferRepo/)
    const calls = src.split('\n').filter((line) => /inferProject\(/.test(line) && !/^\s*(\/\/|\*)/.test(line))
    expect(calls).toHaveLength(1)
    // the second argument is explicit, so inferProject never reads an origin itself
    expect(calls[0]).toMatch(/inferProject\([^,]+, [^)]*\?\? null\)/)
  })
})

describe('GET /api/chats (#586)', () => {
  const viewer = (h: string, extra: Partial<ChatIndexOpts> = {}) =>
    createViewer(openDb(join(scratchDir('chat-db-'), 'inbox.db')), { agentHome: h, setupInfoPath: join(h, 'none.json'), chatIndex: open(h, extra) })

  const entry = (n: number, over: Partial<ChatEntry> = {}): ChatEntry => ({
    id: id(n), tool: 'claude', title: null, titleAuto: false, project: 'p', cwd: null, branch: null, createdAt: null, lastActiveAt: at(n), live: false, pr: null, hidden: [], ...over,
  })
  const read = (chats: ChatEntry[], truncated = false): ChatIndexRead => ({ chats, truncated, work: { filesRead: 0, bytesRead: 0 } })

  it('chatsResponse sorts by last activity, drops hidden unless all, caps, and counts the whole index', () => {
    const chats = [entry(1), entry(2, { hidden: ['temp'] }), entry(3, { lastActiveAt: null, tool: 'copilot', live: true }), entry(4, { lastActiveAt: at(1) }), entry(5)]
    const res = chatsResponse(read(chats), { all: false, claudeDays: 30 })
    expect(res.chats.map((c) => c.id)).toEqual([id(5), id(1), id(4), id(3)])
    expect(res.counts).toEqual({ total: 5, hidden: 1, claude: 4, copilot: 1, live: 1 })
    expect(res.truncated).toBe(false)
    expect(chatsResponse(read(chats), { all: true, claudeDays: 30 }).chats).toHaveLength(5)
    const capped = chatsResponse(read(chats), { all: false, claudeDays: 30, maxChats: 2 })
    expect(capped.chats).toHaveLength(2)
    expect(capped.truncated).toBe(true)
    expect(capped.counts.total).toBe(5)
    expect(MAX_CHATS).toBe(2000)
  })

  it('chatsResponse gives a shown live chat its session, asked by its processes, and no other entry a key', () => {
    const chats = [
      entry(1, { live: true }), entry(2, { live: true }), entry(3), entry(4, { live: true, hidden: ['temp'] }), entry(5, { live: true, tool: 'copilot' }),
    ]
    const livePids = new Map([
      [`claude:${id(1)}`, [4001]], [`claude:${id(2)}`, [4002]], [`claude:${id(3)}`, [4003]], [`claude:${id(4)}`, [4004]],
    ])
    const asked: number[][] = []
    const sessionFor = (pids: readonly number[]) => {
      asked.push([...pids])
      return pids[0] === 4001 ? 'session-one' : null
    }
    const res = chatsResponse({ ...read(chats), livePids }, { all: false, claudeDays: 30, sessionFor })
    expect(res.chats.map((c) => [c.id, c.session])).toEqual([[id(5), undefined], [id(3), undefined], [id(2), undefined], [id(1), 'session-one']])
    // a chat with no session carries no key at all, so every other entry is the one phase 1 served
    expect(res.chats.filter((c) => 'session' in c).map((c) => c.id)).toEqual([id(1)])
    // asked only for live chats that are shown and have a process: not the one that is not live, hidden, or without pids
    expect(asked.sort()).toEqual([[4001], [4002]])
    expect(JSON.stringify(res)).not.toMatch(/"pids?"|4001|4002/)
    // without the lookup, or without the index's pids, nothing is added
    expect(chatsResponse({ ...read(chats), livePids }, { all: true, claudeDays: 30 }).chats.some((c) => 'session' in c)).toBe(false)
    expect(chatsResponse(read(chats), { all: true, claudeDays: 30, sessionFor: () => 'x' }).chats.some((c) => 'session' in c)).toBe(false)
  })

  it('returns { chats, counts, truncated, retention } without the hidden chats', async () => {
    const h = home()
    claude(h, 'a', id(1), basicHead, [{ type: 'ai-title', aiTitle: 'Shown' }])
    claude(h, 'b', id(2), [{ type: 'user', cwd: CWD, entrypoint: 'sdk-cli', timestamp: at(1) }])
    const res = await viewer(h).request('/api/chats')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json() as ReturnType<typeof chatsResponse>
    expect(Object.keys(body).sort()).toEqual(['chats', 'counts', 'retention', 'truncated'])
    expect(body.chats.map((c) => c.id)).toEqual([id(1)])
    expect(Object.keys(body.chats[0]!).sort()).toEqual(['branch', 'createdAt', 'cwd', 'hidden', 'id', 'lastActiveAt', 'live', 'pr', 'project', 'title', 'titleAuto', 'tool'])
    expect(body.counts).toEqual({ total: 2, hidden: 1, claude: 2, copilot: 0, live: 0 })
    expect(body.retention).toEqual({ claudeDays: 30 })
  })

  describe('a live chat’s session (Jump to session)', () => {
    const presence = (db: ReturnType<typeof openDb>, sessionId: string, hostPid: number, serverPid: number) =>
      upsertActivity(db, { session: sessionId, project: 'widget', stream: 'main', agent: 'claude-code', doing: 'open', idle: true, claim: false, host_pid: hostPid, server_pid: serverPid })
    const setup = () => {
      const h = home()
      const db = openDb(join(scratchDir('chat-db-'), 'inbox.db'))
      const v = createViewer(db, { agentHome: h, setupInfoPath: join(h, 'none.json'), chatIndex: open(h, { isAlive: (pid) => pid === 4001 || pid === 5001 }) })
      const chats = async () => (await (await v.request('/api/chats')).json() as ReturnType<typeof chatsResponse>).chats
      return { h, db, chats }
    }
    // a process that has exited: its pid is not running now
    const gone = () => spawnSync(process.execPath, ['-e', '']).pid!

    it('is the presence row whose host is the process that holds the chat, for either tool', async () => {
      const { h, db, chats } = setup()
      claude(h, 'a', id(1), basicHead)
      claude(h, 'a', id(2), basicHead)
      session(h, 4001, { sessionId: id(1), startedAt: Date.now() })
      copilot(h, id(3), yaml(id(3)), { events: true, locks: [5001] })
      presence(db, 'session-claude', 4001, process.pid)
      presence(db, 'session-copilot', 5001, process.pid)
      presence(db, 'session-other', 4444, process.pid)
      const list = await chats()
      expect(Object.fromEntries(list.map((c) => [c.id, c.session]))).toEqual({ [id(1)]: 'session-claude', [id(2)]: undefined, [id(3)]: 'session-copilot' })
      // the chat that is not live keeps exactly phase 1's keys, and no process id is served
      expect(Object.keys(list.find((c) => c.id === id(2))!).sort()).toEqual(['branch', 'createdAt', 'cwd', 'hidden', 'id', 'lastActiveAt', 'live', 'pr', 'project', 'title', 'titleAuto', 'tool'])
      expect(list.flatMap((c) => Object.keys(c)).filter((key) => /pid/i.test(key))).toEqual([])
    })

    it('is none for a live chat with no presence row, an ended one, or one whose server no longer runs', async () => {
      const { h, db, chats } = setup()
      claude(h, 'a', id(1), basicHead)
      session(h, 4001, { sessionId: id(1), startedAt: Date.now() })
      const live = async () => (await chats()).find((c) => c.id === id(1))!
      expect(await live()).toMatchObject({ live: true })
      expect('session' in await live()).toBe(false)
      // a row a reused pid left behind: its server is gone
      presence(db, 'session-dead', 4001, gone())
      expect('session' in await live()).toBe(false)
      presence(db, 'session-ended', 4001, process.pid)
      endActivity(db, 'session-ended')
      expect('session' in await live()).toBe(false)
      // a row that stopped heartbeating is no longer a session card
      presence(db, 'session-stale', 4001, process.pid)
      db.prepare(`UPDATE activity SET updated_at = ? WHERE session = 'session-stale'`).run(new Date(Date.now() - HOUR).toISOString())
      expect('session' in await live()).toBe(false)
    })

    it('is the newest of two rows for one host, so a restarted server answers', async () => {
      const { h, db, chats } = setup()
      claude(h, 'a', id(1), basicHead)
      session(h, 4001, { sessionId: id(1), startedAt: Date.now() })
      presence(db, 'session-first', 4001, process.pid)
      presence(db, 'session-second', 4001, process.pid)
      db.prepare(`UPDATE activity SET started_at = ? WHERE session = 'session-first'`).run(new Date(Date.now() - HOUR).toISOString())
      expect((await chats())[0]!.session).toBe('session-second')
      db.prepare(`UPDATE activity SET started_at = ? WHERE session = 'session-second'`).run(new Date(Date.now() - 2 * HOUR).toISOString())
      expect((await chats())[0]!.session).toBe('session-first')
    })
  })

  it('?all=1 includes hidden chats with their reasons, and any other value is a 400', async () => {
    const h = home()
    claude(h, 'b', id(2), [{ type: 'user', cwd: CWD, entrypoint: 'sdk-cli', timestamp: at(1) }])
    const v = viewer(h)
    const all = await (await v.request('/api/chats?all=1')).json() as ReturnType<typeof chatsResponse>
    expect(all.chats.map((c) => [c.id, c.hidden])).toEqual([[id(2), ['non-interactive']]])
    const bad = await v.request('/api/chats?all=yes')
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ ok: false, error: 'expected ?all=1' })
  })

  it('folder-gone chats are left out by default, listed with ?all=1, and counted as hidden', async () => {
    const h = home()
    claude(h, 'a', id(1), basicHead)
    claude(h, 'b', id(2), [{ type: 'user', cwd: GONE, entrypoint: 'cli', timestamp: at(1) }])
    copilot(h, id(3), yaml(id(3)), { events: true })
    copilot(h, id(4), [...yaml(id(4)).filter((l) => !l.startsWith('cwd:')), `cwd: ${GONE}`], { events: true })
    copilot(h, id(5), yaml(id(5)).filter((l) => !l.startsWith('cwd:')), { events: true })
    const v = viewer(h)
    const body = async (q: string) => await (await v.request(`/api/chats${q}`)).json() as ReturnType<typeof chatsResponse>
    const shown = await body('')
    expect(shown.chats.map((c) => c.id).sort()).toEqual([id(1), id(3)])
    expect(shown.counts).toEqual({ total: 5, hidden: 3, claude: 2, copilot: 3, live: 0 })
    const all = await body('?all=1')
    expect(all.chats.map((c) => [c.id, c.hidden]).sort()).toEqual([[id(1), []], [id(2), ['folder-gone']], [id(3), []], [id(4), ['folder-gone']], [id(5), ['folder-gone']]])
    expect(all.counts).toEqual(shown.counts)
  })

  it('retention.claudeDays is cleanupPeriodDays when positive, else 30', async () => {
    const h = home()
    const days = async () => ((await (await viewer(h).request('/api/chats')).json()) as ReturnType<typeof chatsResponse>).retention.claudeDays
    expect(await days()).toBe(30)
    put(join(h, '.claude', 'settings.json'), '{"cleanupPeriodDays":14}')
    expect(await days()).toBe(14)
    put(join(h, '.claude', 'settings.json'), '{"cleanupPeriodDays":0}')
    expect(await days()).toBe(30)
  })

  it('follows a symlinked settings.json, as Claude Code does', async () => {
    const h = home()
    put(join(h, 'dotfiles', 'settings.json'), '{"cleanupPeriodDays":7}')
    mkdirSync(join(h, '.claude'), { recursive: true })
    symlinkSync(join(h, 'dotfiles', 'settings.json'), join(h, '.claude', 'settings.json'))
    expect(open(h).claudeDays()).toBe(7)
  })
})

// a UUID with hex letters in capitals: the ids above are all digits, which have no case
const UPPER = 'ABCDEF01-0000-4000-8000-ABCDEF012345'

describe('chat index: one Copilot chat, read fresh (#586 phase 2)', () => {
  const alive = (...pids: number[]) => (pid: number) => pids.includes(pid)
  const FIXED = new Date('2026-11-14T09:45:00.000Z')
  /** Pin a path's mtime, so an edit that keeps the size also keeps the cache stamp the list read keyed it by. */
  const pin = (path: string) => utimesSync(path, FIXED, FIXED)

  it('answers the entry the list gives for that chat, hidden ones included', () => {
    const h = home()
    copilot(h, id(1), yaml(id(1), ['name: Alpha chat', 'branch: main']), { events: true })
    copilot(h, id(2), yaml(id(2)), { events: false })
    copilot(h, id(3), [...yaml(id(3)).filter((l) => !l.startsWith('cwd:')), `cwd: ${GONE}`], { events: true })
    copilot(h, id(4), yaml(id(4)), { events: true, locks: [5001] })
    const index = open(h, { isAlive: alive(5001) })
    const listed = index.read()
    for (const n of [1, 2, 3, 4]) expect(index.readCopilot(id(n))).toEqual(byId(listed, id(n)))
    expect(index.readCopilot(id(2))!.hidden).toEqual(['empty'])
    expect(index.readCopilot(id(3))!.hidden).toEqual(['folder-gone'])
    expect(index.readCopilot(id(4))!.live).toBe(true)
  })

  it('reads workspace.yaml and the lock list again, past the cache the list read keeps', () => {
    const h = home()
    const dir = copilot(h, id(1), yaml(id(1), ['name: Alpha one']), { events: true })
    pin(join(dir, 'workspace.yaml'))
    pin(dir)
    const index = open(h, { isAlive: alive(5001) })
    expect(byId(index.read(), id(1))).toMatchObject({ title: 'Alpha one', live: false })
    // the same size and the same mtime: the list's stamp cannot tell, so it keeps what it read
    put(join(dir, 'workspace.yaml'), `${yaml(id(1), ['name: Alpha two']).join('\n')}\n`)
    pin(join(dir, 'workspace.yaml'))
    put(join(dir, 'inuse.5001.lock'), '')
    pin(dir)
    expect(byId(index.read(), id(1))).toMatchObject({ title: 'Alpha one', live: false })
    expect(index.readCopilot(id(1))).toMatchObject({ title: 'Alpha two', live: true })
    // and a lock that went away is seen at once
    rmSync(join(dir, 'inuse.5001.lock'))
    pin(dir)
    expect(index.readCopilot(id(1))!.live).toBe(false)
  })

  it('reads a folder that appeared or vanished since the list read, not the 60-second cache of it', () => {
    const h = home()
    const later = join(FIXTURES, 'appears-later')
    rmSync(later, { recursive: true, force: true })
    copilot(h, id(1), [...yaml(id(1)).filter((l) => !l.startsWith('cwd:')), `cwd: ${later}`], { events: true })
    const index = open(h)
    expect(byId(index.read(), id(1)).hidden).toEqual(['folder-gone'])
    mkdirSync(join(later, '.git'), { recursive: true })
    expect(byId(index.read(), id(1)).hidden).toEqual(['folder-gone'])
    expect(index.readCopilot(id(1))!.hidden).toEqual([])
    rmSync(later, { recursive: true, force: true })
  })

  it('finds a chat the list left out: past the scan cap and past the fresh-read budget', () => {
    const h = home()
    copilot(h, id(1), yaml(id(1)), { events: true })
    copilot(h, id(2), yaml(id(2)), { events: true })
    const capped = open(h, { limits: { copilotDirs: 1 } })
    const listed = capped.read()
    expect(listed.truncated).toBe(true)
    expect(listed.chats).toHaveLength(1)
    for (const n of [1, 2]) expect(capped.readCopilot(id(n))).toMatchObject({ id: id(n), tool: 'copilot' })
    const broke = open(h, { limits: { freshBytes: 0 } })
    expect(broke.read().chats).toEqual([])
    expect(broke.readCopilot(id(2))).toMatchObject({ id: id(2) })
  })

  it('says live by the driver\'s one-folder rule: where the list did not, never the reverse', () => {
    const h = home()
    const old = copilot(h, id(1), yaml(id(1)), { events: true, locks: [5002] })
    const fresh = copilot(h, id(2), yaml(id(2)), { events: true, locks: [5002] })
    utimesSync(join(old, 'inuse.5002.lock'), new Date(Date.now() - 1000), new Date(Date.now() - 1000))
    utimesSync(join(fresh, 'inuse.5002.lock'), new Date(), new Date())
    const stale = copilot(h, id(3), yaml(id(3)), { events: true, locks: [5003] })
    utimesSync(join(stale, 'inuse.5003.lock'), new Date(Date.now() - 2 * HOUR), new Date(Date.now() - 2 * HOUR))
    copilot(h, id(4), yaml(id(4)), { events: true, locks: [5004] })
    const index = open(h, { isAlive: alive(5002, 5003) })
    const listed = index.read()
    expect([1, 2, 3, 4].map((n) => byId(listed, id(n)).live)).toEqual([false, true, false, false])
    // chat 1 shares its pid with a newer lock in chat 2: only the one-folder rule calls it live
    expect([1, 2, 3, 4].map((n) => index.readCopilot(id(n))!.live)).toEqual([true, true, false, false])
    for (const n of [1, 2, 3, 4]) expect(!byId(listed, id(n)).live || index.readCopilot(id(n))!.live).toBe(true)
  })

  it('is null for an unknown chat, a bad id, a link, another chat\'s files and an unreadable folder', () => {
    const h = home()
    copilot(h, id(1), yaml(id(1)), { events: true })
    copilot(h, id(2), yaml(id(1)), { events: true })
    const elsewhere = copilot(h, 'elsewhere', yaml(id(3)), { events: true })
    symlinkSync(elsewhere, join(h, '.copilot', 'session-state', id(3)))
    const index = open(h)
    expect(index.readCopilot(id(9))).toBeNull()
    // a folder whose workspace.yaml names another id is not this chat
    expect(index.readCopilot(id(2))).toBeNull()
    // a link in place of the chat's folder is never followed
    expect(index.readCopilot(id(3))).toBeNull()
    for (const bad of ['', '..', '../..', `../${id(1)}`, UPPER, `${id(1)}\n`, `${id(1)}/`, `${id(1)}/../${id(1)}`, 'elsewhere', `pending-session:${id(1)}`]) {
      expect(index.readCopilot(bad), JSON.stringify(bad)).toBeNull()
    }
    expect(index.readCopilot(id(1))).not.toBeNull()
    expect(open(scratchDir('chat-empty-home-')).readCopilot(id(1))).toBeNull()
    expect(open(h, { platform: 'win32' }).readCopilot(id(1))).toBeNull()
  })

  it('touches nothing outside the chat\'s own folder and leaves the last read\'s counters alone', () => {
    const h = home()
    copilot(h, id(1), yaml(id(1)), { events: true })
    // a decoy beside it that a loose path join would reach
    put(join(h, '.copilot', 'session-state', `${id(1)}x`, 'workspace.yaml'), `${yaml(id(1)).join('\n')}\n`)
    const index = open(h)
    const listed = index.read()
    const work = { ...listed.work }
    expect(index.readCopilot(id(1))).not.toBeNull()
    expect(listed.work).toEqual(work)
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'chat-index.ts'), 'utf8')
    const body = src.slice(src.indexOf('    readCopilot(id) {'), src.indexOf('    claudeDays() {'))
    // the id is checked before the first path is built from it
    expect(body.indexOf('isChatId(id)')).toBeGreaterThan(-1)
    expect(body.indexOf('isChatId(id)')).toBeLessThan(body.indexOf('join(copilotRoot, id)'))
    expect(body).not.toMatch(/writeFile|appendFile|mkdir|rmSync|unlink|rename|spawn|exec/)
  })
})

describe('GET /api/chats/copilot/:id (#586 phase 2)', () => {
  const LID = (n: number) => `22222222-3333-4444-8555-${String(n).padStart(12, '0')}`
  const alive = (...pids: number[]) => (pid: number) => pids.includes(pid)
  const rig = (h: string, extra: Partial<ChatIndexOpts> = {}) => {
    const db = openDb(join(scratchDir('chat-db-'), 'inbox.db'))
    const app = createViewer(db, { agentHome: h, setupInfoPath: join(h, 'none.json'), chatIndex: open(h, extra) })
    const launch = (n: number, chatId: string | null = null) => createLaunch(db, {
      id: LID(n), host: 'copilot', project: 'p', stream: 's', cwd: CWD, mode: 'ask', budgetActiveMs: null, budgetToolCalls: null,
      prompt: 'secret first message', specVersion: 1, driverPid: 4242, ...(chatId ? { chatId } : {}),
    })
    const stamp = (n: number, createdAt: string, acp: string | null = null) =>
      db.prepare('UPDATE launches SET created_at = ?, acp_session = ? WHERE id = ?').run(createdAt, acp, LID(n))
    const end = (n: number) => db.prepare(`UPDATE launches SET status = 'ended', end_reason = 'error:start', ended_at = created_at WHERE id = ?`).run(LID(n))
    return { db, app, launch, stamp, end }
  }
  const get = async (app: ReturnType<typeof rig>['app'], path: string) => {
    const res = await app.request(path)
    const text = await res.text()
    const body = (() => { try { return JSON.parse(text) } catch { return null } })() as { chat: ChatEntry | null; launch: Record<string, unknown> | null; ok?: boolean; error?: string }
    return { res, body, text }
  }

  it('answers { chat, launch } with the index entry and no cache header to reuse', async () => {
    const h = home()
    copilot(h, id(1), yaml(id(1), ['name: Alpha chat', 'branch: main']), { events: true })
    copilot(h, id(2), yaml(id(2)), { events: false })
    const { app } = rig(h)
    const all = await (await app.request('/api/chats?all=1')).json() as ReturnType<typeof chatsResponse>
    for (const n of [1, 2]) {
      const { res, body } = await get(app, `/api/chats/copilot/${id(n)}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(Object.keys(body).sort()).toEqual(['chat', 'launch'])
      expect(body.chat).toEqual(all.chats.find((c) => c.id === id(n)))
      expect(body.launch).toBeNull()
    }
    // the hidden chat is answered too: the route is how a caller learns why it is hidden
    expect((await get(app, `/api/chats/copilot/${id(2)}`)).body.chat!.hidden).toEqual(['empty'])
  })

  it('reads the chat fresh: the route sees a change the cached list has not caught up with', async () => {
    const h = home()
    const dir = copilot(h, id(1), yaml(id(1), ['name: Alpha one']), { events: true })
    const FIXED = new Date('2026-11-14T09:45:00.000Z')
    utimesSync(join(dir, 'workspace.yaml'), FIXED, FIXED)
    utimesSync(dir, FIXED, FIXED)
    const { app } = rig(h, { isAlive: alive(5001) })
    const list = async () => ((await (await app.request('/api/chats')).json()) as ReturnType<typeof chatsResponse>).chats.find((c) => c.id === id(1))!
    expect(await list()).toMatchObject({ title: 'Alpha one', live: false })
    put(join(dir, 'workspace.yaml'), `${yaml(id(1), ['name: Alpha two']).join('\n')}\n`)
    put(join(dir, 'inuse.5001.lock'), '')
    utimesSync(join(dir, 'workspace.yaml'), FIXED, FIXED)
    utimesSync(dir, FIXED, FIXED)
    expect(await list()).toMatchObject({ title: 'Alpha one', live: false })
    expect((await get(app, `/api/chats/copilot/${id(1)}`)).body.chat).toMatchObject({ title: 'Alpha two', live: true })
  })

  it('finds a chat the list leaves out past its cap', async () => {
    const h = home()
    copilot(h, id(1), yaml(id(1)), { events: true })
    copilot(h, id(2), yaml(id(2)), { events: true })
    const { app } = rig(h, { limits: { copilotDirs: 1 } })
    const all = await (await app.request('/api/chats?all=1')).json() as ReturnType<typeof chatsResponse>
    expect(all.chats).toHaveLength(1)
    expect(all.truncated).toBe(true)
    for (const n of [1, 2]) expect((await get(app, `/api/chats/copilot/${id(n)}`)).body.chat).toMatchObject({ id: id(n) })
  })

  it('links the launch that holds the chat, else the newest, by chat_id or acp_session, as /api/launches serves it', async () => {
    const h = home()
    copilot(h, id(1), yaml(id(1)), { events: true })
    const { app, launch, stamp, end } = rig(h)
    const link = async () => (await get(app, `/api/chats/copilot/${id(1)}`)).body.launch
    expect(await link()).toBeNull()
    // an unrelated launch, whose session is another chat's, is never the link
    launch(1)
    stamp(1, '2026-11-14T10:00:00.000Z', id(2))
    expect(await link()).toBeNull()
    // by chat_id
    launch(2, id(1))
    stamp(2, '2026-11-14T10:01:00.000Z')
    expect(await link()).toMatchObject({ id: LID(2), chat_id: id(1), status: 'running' })
    end(2)
    // by acp_session, newer than the chat_id one
    launch(3)
    stamp(3, '2026-11-14T10:02:00.000Z', id(1))
    expect(await link()).toMatchObject({ id: LID(3), chat_id: null })
    // a running launch that holds the chat beats a newer ended one
    stamp(2, '2026-11-14T10:03:00.000Z')
    expect(await link()).toMatchObject({ id: LID(3), status: 'running' })
    // with both ended, the newer is the link
    end(3)
    expect(await link()).toMatchObject({ id: LID(2) })
    // the shape is launchView's: the same object /api/launches/:id serves, less its `driver` field
    const served = await (await app.request(`/api/launches/${LID(2)}`)).json() as Record<string, unknown>
    delete served.driver
    expect(await link()).toEqual(served)
    expect(Object.keys((await link())!)).not.toEqual(expect.arrayContaining(['prompt', 'acp_session', 'driver_pid']))
    expect(JSON.stringify(await link())).not.toContain('secret first message')
  })

  it('links a launch even when Copilot has no such chat any more', async () => {
    const h = home()
    const { app, launch } = rig(h)
    launch(1, id(5))
    expect(await get(app, `/api/chats/copilot/${id(5)}`)).toMatchObject({ body: { chat: null, launch: { id: LID(1), chat_id: id(5) } } })
  })

  it('is a 400 for an id that is not a lowercase UUID and null for an unknown chat', async () => {
    const h = home()
    copilot(h, id(1), yaml(id(1)), { events: true })
    const { app } = rig(h)
    for (const bad of ['abc', UPPER, `${id(1)}%0a`, `..%2f${id(1)}`, `${id(1)}%2f..%2f${id(1)}`, `${id(1)}.json`, 'x'.repeat(300)]) {
      const { res, body } = await get(app, `/api/chats/copilot/${bad}`)
      expect(res.status, bad).toBe(400)
      expect(body, bad).toEqual({ ok: false, error: 'expected a chat id' })
    }
    // a path the URL parser folds away never reaches the route with a chat in it
    for (const folded of ['/api/chats/copilot/', '/api/chats/copilot/..', `/api/chats/copilot/${id(1)}/..`, `/api/chats/copilot/%2e%2e`]) {
      const { res, body } = await get(app, folded)
      expect(res.status === 200 && body?.chat != null, folded).toBe(false)
    }
    const unknown = await get(app, `/api/chats/copilot/${id(9)}`)
    expect(unknown.res.status).toBe(200)
    expect(unknown.body).toEqual({ chat: null, launch: null })
  })

  it('is GET only and writes nothing: no file under the home, no row in the store', async () => {
    const h = home()
    copilot(h, id(1), yaml(id(1)), { events: true, locks: [5001] })
    const { app, db, launch } = rig(h)
    launch(1, id(1))
    const tree = () => {
      const out: string[] = []
      const walk = (dir: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name)
          if (e.isDirectory()) walk(p)
          else out.push(`${p}:${lstatSync(p).mtimeMs}:${lstatSync(p).size}`)
        }
      }
      walk(h)
      return out.sort()
    }
    const dump = () => JSON.stringify(db.prepare('SELECT * FROM launches').all())
    const before = [tree(), dump(), (db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version]
    for (const path of [`/api/chats/copilot/${id(1)}`, `/api/chats/copilot/${id(9)}`, '/api/chats/copilot/bad']) await app.request(path)
    expect([tree(), dump(), (db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version]).toEqual(before)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect((await app.request(`/api/chats/copilot/${id(1)}`, { method })).status, method).toBe(404)
    }
    expect(dump()).toBe(before[1])
  })

  it('calling the route changes nothing GET /api/chats answers for the same folders', async () => {
    const h = home()
    claude(h, 'a', id(1), basicHead, [{ type: 'ai-title', aiTitle: 'Shown' }])
    copilot(h, id(2), yaml(id(2), ['name: Alpha chat']), { events: true })
    copilot(h, id(3), yaml(id(3)), { events: false })
    copilot(h, id(4), yaml(id(4)), { events: true, locks: [5001] })
    const { app } = rig(h, { isAlive: alive(5001) })
    const text = async (q: string) => await (await app.request(`/api/chats${q}`)).text()
    const before = [await text(''), await text('?all=1')]
    for (const n of [1, 2, 3, 4, 9]) await app.request(`/api/chats/copilot/${n === 9 ? id(9) : id(n)}`)
    expect([await text(''), await text('?all=1')]).toEqual(before)
    // the route adds no field to the list's entries, and the list carries no launch
    const body = JSON.parse(before[1]!) as ReturnType<typeof chatsResponse>
    expect(Object.keys(body).sort()).toEqual(['chats', 'counts', 'retention', 'truncated'])
    for (const c of body.chats) expect(Object.keys(c).sort()).toEqual(['branch', 'createdAt', 'cwd', 'hidden', 'id', 'lastActiveAt', 'live', 'pr', 'project', 'title', 'titleAuto', 'tool'])
  })

  describe('behind the local boundary (Host and Origin)', () => {
    const send = (port: number, path: string, headers: Record<string, string>, method = 'GET') => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      req.on('error', reject)
      req.end()
    })

    it('refuses a foreign Host and a hostile or opaque Origin, as /api/chats does, and serves no other method', async () => {
      const h = home()
      copilot(h, id(1), yaml(id(1), ['name: Alpha chat']), { events: true })
      const { app } = rig(h)
      const server = startLocalViewer(app, 0)
      if (!server.listening) await once(server, 'listening')
      const { port } = server.address() as AddressInfo
      try {
        const route = `/api/chats/copilot/${id(1)}`
        for (const path of [route, '/api/chats']) {
          const ok = await send(port, path, { host: `127.0.0.1:${port}` })
          expect(ok.status, path).toBe(200)
          expect((await send(port, path, { host: `localhost:${port}`, origin: `http://localhost:${port}`, 'sec-fetch-site': 'same-origin' })).status, path).toBe(200)
          for (const headers of <Array<Record<string, string>>>[
            { host: `inbox.attacker.example:${port}` },
            { host: `127.0.0.1:${port}`, origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' },
            { host: `127.0.0.1:${port}`, origin: 'null', 'sec-fetch-site': 'cross-site' },
          ]) {
            const refused = await send(port, path, headers)
            expect(refused.status, `${path} ${JSON.stringify(headers)}`).toBe(403)
            expect(refused.body).not.toContain('Alpha chat')
          }
        }
        // a POST with a trusted Origin reaches the app and finds no such route
        expect((await send(port, route, { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }, 'POST')).status).toBe(404)
        expect((await send(port, route, { host: `127.0.0.1:${port}` }, 'POST')).status).toBe(403)
        expect((await send(port, route, { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'cross-site' }, 'POST')).status).toBe(403)
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
      }
    })
  })
})
