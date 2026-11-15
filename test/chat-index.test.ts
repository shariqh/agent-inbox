import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, mkdirSync, readdirSync, readFileSync, lstatSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { chatsResponse, CHAT_WINDOW_BYTES, createChatIndex, MAX_CHATS } from '../src/chat-index.js'
import type { ChatEntry, ChatIndexOpts, ChatIndexRead } from '../src/chat-index.js'
import { openDb } from '../src/store.js'
import { createViewer } from '../src/viewer.js'
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
      './chat-parse.js: hiddenReasons,isChatId,lockPid,parseClaudeLiveFile,parseClaudeWindows,parseGitOrigin,parseGitdirPointer,parseWorkspaceYaml,retentionDays,sessionFilePid',
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
