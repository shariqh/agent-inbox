// Where a session runs (#617, PR 1; design 2026-11-17-remote-inbox-design.md §3.1).
//
// src/session-place.ts is the one place a machine, a tmux session name, a tmux
// pane and a Remote Control id are read and checked. The PATTERNS ARE THE SAFETY:
// a later change hands a stored `desk` to a shell, so a value that fails its
// pattern is never stored by the product's writer, and is never trimmed or cut to
// fit. Every fixture here is synthetic: no real host, folder or session id.
//
// A reading has three answers: a value, null ("absent": the thing is cleanly not
// there) and undefined ("failed": the read itself did not work, so nothing is known
// and the stored value must stay). See readDesk and readRemoteSession.
//
// Not tested: the owner check in readRemoteSession (`st_uid` must be this user's).
// A file owned by another user cannot be made without another user, or root.
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readDesk, readPlace, readRemoteSession, startPlaceRefresh } from '../src/session-place.js'
import type { PlaceReading } from '../src/session-place.js'
import { listActivity, openDb, setActivityPlace, upsertActivity } from '../src/store.js'
import { createViewer } from '../src/viewer.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

afterEach(() => {
  removeScratchDirs()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const NAME_64 = `a${'b'.repeat(63)}`

describe('readPlace: machine and pane, read once at start', () => {
  it('takes the machine from AGENT_INBOX_MACHINE, else the host name up to its first dot', () => {
    expect(readPlace({ AGENT_INBOX_MACHINE: 'laptop' }, 'hub.example.ts.net')).toEqual({ machine: 'laptop' })
    expect(readPlace({}, 'hub.example.ts.net')).toEqual({ machine: 'hub' })
    expect(readPlace({}, 'hub')).toEqual({ machine: 'hub' })
    // an empty override is no override
    expect(readPlace({ AGENT_INBOX_MACHINE: '' }, 'hub.local')).toEqual({ machine: 'hub' })
  })

  it('accepts exactly the machine pattern: a first word character, then word characters, dots and hyphens, 64 at most', () => {
    for (const ok of ['a', '_x', '0', 'Hub-2', 'a.b', 'a_b-c.d', NAME_64]) expect(readPlace({ AGENT_INBOX_MACHINE: ok }, 'h'), ok).toEqual({ machine: ok })
    for (const bad of ['-x', '.x', 'a b', 'a/b', "it's", '$(id)', 'a;b', 'a\nb', 'a b\n', ' a', 'a ', `${NAME_64}c`, 'é', '`x`']) {
      expect(readPlace({ AGENT_INBOX_MACHINE: bad }, 'h'), JSON.stringify(bad)).toEqual({})
    }
  })

  it('never trims or cuts a value to fit, and a bad override does not fall back to the host name', () => {
    expect(readPlace({ AGENT_INBOX_MACHINE: ' laptop' }, 'hub')).toEqual({})
    expect(readPlace({ AGENT_INBOX_MACHINE: 'a'.repeat(100) }, 'hub')).toEqual({})
  })

  it('stores no machine when the host name is not a valid name either', () => {
    expect(readPlace({}, 'weird host.local')).toEqual({})
    expect(readPlace({}, '.local')).toEqual({})
    expect(readPlace({}, '')).toEqual({})
  })

  it('takes the pane from TMUX_PANE only as a percent sign and one to six digits', () => {
    for (const ok of ['%0', '%3', '%123456']) expect(readPlace({ TMUX_PANE: ok }, 'h'), ok).toEqual({ machine: 'h', pane: ok })
    for (const bad of ['3', '%', '%a', '%1234567', '%1 ', ' %1', '%1\n', '%-1', '%1;', '$(id)', '%１']) {
      expect(readPlace({ TMUX_PANE: bad }, 'h'), JSON.stringify(bad)).toEqual({ machine: 'h' })
    }
    expect(readPlace({}, 'h')).toEqual({ machine: 'h' })
  })
})


describe('readDesk: the tmux session name of a pane', () => {
  const env = { TMUX: '/private/tmp/tmux-501/default,123,0', TMUX_PANE: '%3' }
  type Run = (file: string, args: string[], opts: { timeout: number; maxBuffer: number }) => Promise<string>
  const runner = (out: string) => vi.fn<Run>(async () => out)
  const rejecting = (error: unknown) => vi.fn<Run>(async () => { throw error })
  const exited = (stderr: string, code = 1) => Object.assign(new Error(`Command failed: tmux\n${stderr}`), { code, stderr })

  it('asks tmux with an argument list, a one second timeout and a 1 KiB buffer', async () => {
    const run = runner('work\n')
    expect(await readDesk('%3', { env, run })).toBe('work')
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('tmux', ['display-message', '-p', '-t', '%3', '#{session_name}'], { timeout: 1000, maxBuffer: 1024 })
  })

  it('accepts a name that matches the pattern, and drops only the newline tmux ends its output with', async () => {
    for (const ok of ['api', 'api-2', '_scratch', 'a.b', '0', NAME_64]) expect(await readDesk('%3', { env, run: runner(`${ok}\n`) }), ok).toBe(ok)
    expect(await readDesk('%3', { env, run: runner('api') })).toBe('api')
  })

  it('answers absent (null), not failed, for a hostile name: the real name is one we will not store, so the stored one is stale', async () => {
    const hostile = [
      'my desk', "it's", '"q"', '$(id)', '`id`', 'a;b', 'a&b', 'a|b', 'a>b', '*', '-t', '--help', '-x', '.hidden', '..', '.',
      `${NAME_64}c`, 'a'.repeat(65), '', '\n', 'a\nb', 'a\n\n', ' a', 'a ', '\ta', 'a\r', 'é', 'a\u0000b', 'a\\b', 'a/b', '=a', '%1',
    ]
    for (const name of hostile) expect(await readDesk('%3', { env, run: runner(`${name}\n`) }), JSON.stringify(name)).toBeNull()
  })

  it('answers absent (null) with no TMUX or a bad pane, and never runs tmux', async () => {
    const run = runner('work\n')
    expect(await readDesk('%3', { env: { TMUX_PANE: '%3' }, run })).toBeNull()
    expect(await readDesk('%3', { env: { TMUX: '', TMUX_PANE: '%3' }, run })).toBeNull()
    expect(await readDesk('%3', { env: {}, run })).toBeNull()
    for (const bad of ['', '3', '%', '%a', '%1234567', '-t', '%1 ', '%1;id']) expect(await readDesk(bad, { env, run }), bad).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  it('answers absent (null) when tmux ran and says there is no such pane, session or server, or is not installed', async () => {
    for (const stderr of ["can't find pane: %3", "can't find session: api", "can't find window: 2", 'no server running on /private/tmp/tmux-501/default',
      'error connecting to /private/tmp/tmux-501/default (No such file or directory)', 'no current client']) {
      expect(await readDesk('%3', { env, run: rejecting(exited(`${stderr}\n`)) }), stderr).toBeNull()
    }
    expect(await readDesk('%3', { env, run: rejecting(Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' })) })).toBeNull()
  })

  it('answers failed (undefined) for anything else, so the refresh keeps what it stored: an unexplained exit, a timeout, a signal, too much output', async () => {
    const failures = [
      exited(''), exited('server exited unexpectedly'), exited('', 2),
      Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', code: null }),
      Object.assign(new RangeError('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }),
      Object.assign(new Error('spawn tmux EAGAIN'), { code: 'EAGAIN' }),
      new Error('boom'), 'a string', null,
    ]
    for (const error of failures) expect(await readDesk('%3', { env, run: rejecting(error) }), String(error)).toBeUndefined()
  })

  describe('with a stand-in tmux program on PATH, never a real tmux server', () => {
    let bin: string
    let path: string | undefined
    beforeEach(() => {
      bin = scratchDir('place-bin-')
      path = process.env['PATH']
    })
    afterEach(() => { process.env['PATH'] = path })
    const fake = (body: string): void => {
      const file = join(bin, 'tmux')
      writeFileSync(file, `#!/bin/sh\n${body}\n`)
      chmodSync(file, 0o755)
      process.env['PATH'] = bin
    }

    it('reads the name the program prints, given the exact arguments', async () => {
      fake(`[ "$1" = display-message ] && [ "$2" = -p ] && [ "$3" = -t ] && [ "$4" = %3 ] && [ "$5" = '#{session_name}' ] && [ "$#" = 5 ] && echo api-2`)
      expect(await readDesk('%3', { env })).toBe('api-2')
    })

    it('answers null for a hostile name the program prints', async () => {
      fake(`echo '$(touch ${join(bin, 'pwned')})'`)
      expect(await readDesk('%3', { env })).toBeNull()
      fake(`echo '-x'`)
      expect(await readDesk('%3', { env })).toBeNull()
    })

    it('answers null when there is no tmux on PATH', async () => {
      process.env['PATH'] = bin
      expect(await readDesk('%3', { env })).toBeNull()
    })

    it('answers null when tmux says there is no such pane, and undefined for an unexplained error', async () => {
      fake(`echo "can't find pane: %3" >&2; exit 1`)
      expect(await readDesk('%3', { env })).toBeNull()
      fake('echo work; exit 1')
      expect(await readDesk('%3', { env })).toBeUndefined()
    })

    it('answers undefined after the one second timeout, when tmux hangs', async () => {
      fake('exec /bin/sleep 5')
      const started = Date.now()
      expect(await readDesk('%3', { env })).toBeUndefined()
      // it waited for the timeout (and no longer), not for the program or an early failure
      expect(Date.now() - started).toBeGreaterThanOrEqual(900)
      expect(Date.now() - started).toBeLessThan(4000)
    })

    it('answers undefined when tmux prints more than 1 KiB', async () => {
      fake('i=0; while [ $i -lt 2000 ]; do printf a; i=$((i+1)); done; echo')
      expect(await readDesk('%3', { env })).toBeUndefined()
    })
  })
})

describe('readRemoteSession: the Remote Control id in the host’s live file', () => {
  const PID = 4242
  const ID = 'session_01AbCdEfGh'
  let home: string
  let sessions: string
  beforeEach(() => {
    home = scratchDir('place-home-')
    sessions = join(home, '.claude', 'sessions')
    mkdirSync(sessions, { recursive: true })
  })
  const live = (doc: unknown, pid = PID): string => {
    const file = join(sessions, `${pid}.json`)
    writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc))
    return file
  }

  it('returns the id when the file is the host’s own', () => {
    live({ pid: PID, sessionId: '00000000-0000-4000-8000-000000000001', bridgeSessionId: ID })
    expect(readRemoteSession(home, PID)).toBe(ID)
  })

  it('answers absent (null) with no file, no folder and no home', () => {
    expect(readRemoteSession(home, PID)).toBeNull()
    expect(readRemoteSession(join(home, 'nowhere'), PID)).toBeNull()
    expect(readRemoteSession('', PID)).toBeNull()
  })

  it('answers absent (null) when the file has no id, or one that is not a string', () => {
    for (const doc of [{ pid: PID }, { pid: PID, bridgeSessionId: null }, { pid: PID, bridgeSessionId: 42 }, { pid: PID, bridgeSessionId: [ID] }, { pid: PID, bridgeSessionId: { id: ID } }]) {
      live(doc)
      expect(readRemoteSession(home, PID), JSON.stringify(doc)).toBeNull()
    }
  })

  it('accepts exactly session_ and one to 64 letters and digits, and cuts nothing to fit', () => {
    for (const ok of ['session_a', 'session_9', `session_${'x'.repeat(64)}`]) {
      live({ pid: PID, bridgeSessionId: ok })
      expect(readRemoteSession(home, PID), ok).toBe(ok)
    }
    const bad = ['', 'session_', 'session', 'Session_a', 'session_a-b', 'session_a_b', 'session_a.b', 'session_a b', 'session_a\n', ' session_a', `session_${'x'.repeat(65)}`,
      '../session_a', 'session_/x', 'session_é', 'https://claude.ai/code/session_a', 'x'.repeat(10)]
    for (const id of bad) {
      live({ pid: PID, bridgeSessionId: id })
      expect(readRemoteSession(home, PID), JSON.stringify(id)).toBeNull()
    }
  })

  it('answers absent (null) when the file’s own pid is not the host’s', () => {
    live({ pid: PID + 1, bridgeSessionId: ID })
    expect(readRemoteSession(home, PID)).toBeNull()
    for (const pid of ['4242', null, undefined, 4242.5]) {
      live({ pid, bridgeSessionId: ID })
      expect(readRemoteSession(home, PID), String(pid)).toBeNull()
    }
    // another host's file, asked for by its own name, answers for that host alone
    live({ pid: 7, bridgeSessionId: ID }, 7)
    expect(readRemoteSession(home, 7)).toBe(ID)
    expect(readRemoteSession(home, PID)).toBeNull()
  })

  it('never follows a symbolic link as the file itself, to a good file or anywhere else', () => {
    const real = join(home, 'elsewhere.json')
    writeFileSync(real, JSON.stringify({ pid: PID, bridgeSessionId: ID }))
    symlinkSync(real, join(sessions, `${PID}.json`))
    expect(readRemoteSession(home, PID)).toBeNull()
  })

  it('follows a symbolic link in a folder above the file: O_NOFOLLOW covers the last component only, and the pid check still holds', () => {
    const real = join(home, 'real-sessions')
    mkdirSync(real)
    writeFileSync(join(real, `${PID}.json`), JSON.stringify({ pid: PID, bridgeSessionId: ID }))
    writeFileSync(join(real, '9.json'), JSON.stringify({ pid: PID, bridgeSessionId: ID }))
    const linked = scratchDir('place-linked-home-')
    mkdirSync(join(linked, '.claude'))
    symlinkSync(real, join(linked, '.claude', 'sessions'))
    expect(readRemoteSession(linked, PID)).toBe(ID)
    // a file whose own pid is not the name's is refused wherever the folder points
    expect(readRemoteSession(linked, 9)).toBeNull()
  })

  it('answers absent (null) for a file that is not a regular file', () => {
    mkdirSync(join(sessions, `${PID}.json`))
    expect(readRemoteSession(home, PID)).toBeNull()
    // a named pipe is neither opened for long nor read
    execFileSync('mkfifo', [join(sessions, '77.json')])
    expect(readRemoteSession(home, 77)).toBeNull()
  })

  it('reads at most 16 KiB: a good document of that size passes, one byte more is absent', () => {
    const doc = JSON.stringify({ pid: PID, bridgeSessionId: ID })
    live(doc + ' '.repeat(16 * 1024 - doc.length))
    expect(readRemoteSession(home, PID)).toBe(ID)
    live(doc + ' '.repeat(16 * 1024 - doc.length + 1))
    expect(readRemoteSession(home, PID)).toBeNull()
    live(JSON.stringify({ pid: PID, bridgeSessionId: ID, pad: 'x'.repeat(100_000) }))
    expect(readRemoteSession(home, PID)).toBeNull()
  })

  it('answers failed (undefined) for a file caught mid-rewrite: empty, or partial JSON', () => {
    for (const text of ['', ' ', '{', `{"pid":${PID},"bridgeSessionId":"${ID}"`, `{"pid":${PID},"bridgeSessionId":"sess`, 'not json']) {
      live(text)
      expect(readRemoteSession(home, PID), JSON.stringify(text)).toBeUndefined()
    }
  })

  it('answers failed (undefined) for a file it cannot read, and absent for JSON that is complete but not an object', () => {
    const file = live({ pid: PID, bridgeSessionId: ID })
    chmodSync(file, 0o000)
    try {
      // running as root would read it anyway: then the read simply works
      expect([undefined, ID]).toContain(readRemoteSession(home, PID))
    } finally {
      chmodSync(file, 0o600)
    }
    for (const text of ['[]', 'null', '42', '"session_a"', `[{"pid":${PID},"bridgeSessionId":"${ID}"}]`]) {
      live(text)
      expect(readRemoteSession(home, PID), text).toBeNull()
    }
  })

  it('answers absent (null) for a pid that cannot name a process, without reading anything', () => {
    live({ pid: 0, bridgeSessionId: ID }, 0)
    for (const pid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(readRemoteSession(home, pid), String(pid)).toBeNull()
  })
})

describe('startPlaceRefresh: its own timer, and every reading written (SQL decides whether it changed)', () => {
  const none: PlaceReading = { desk: null, remote_session: null }
  const reading = (desk: string | null | undefined, ...rest: [remote_session?: string | null | undefined]): PlaceReading => ({ desk, remote_session: rest.length ? rest[0] : null })
  const tick = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms) }

  function setup(first: PlaceReading = none) {
    vi.useFakeTimers()
    const state = { value: first }
    const read = vi.fn(async () => state.value)
    const write = vi.fn((_: PlaceReading) => true)
    return { state, read, write, refresh: startPlaceRefresh(read, write) }
  }

  it('reads at once, again 30 seconds later, then every five minutes', async () => {
    const { read } = setup()
    await tick(0)
    expect(read).toHaveBeenCalledTimes(1)
    await tick(29_999)
    expect(read).toHaveBeenCalledTimes(1)
    await tick(1)
    expect(read).toHaveBeenCalledTimes(2)
    await tick(5 * 60_000 - 1)
    expect(read).toHaveBeenCalledTimes(2)
    await tick(1)
    expect(read).toHaveBeenCalledTimes(3)
    await tick(5 * 60_000)
    expect(read).toHaveBeenCalledTimes(4)
  })

  it('hands every reading to the writer, changed or not, nulls included: it keeps no memory of what it wrote', async () => {
    const { state, write } = setup(reading('api', 'session_a'))
    await tick(0)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenLastCalledWith({ desk: 'api', remote_session: 'session_a' })
    await tick(30_000)
    await tick(5 * 60_000)
    expect(write).toHaveBeenCalledTimes(3)
    expect(write).toHaveBeenLastCalledWith({ desk: 'api', remote_session: 'session_a' })
    state.value = none
    await tick(5 * 60_000)
    expect(write).toHaveBeenLastCalledWith(none)
  })

  it('passes a failed field (undefined) on as it is, so the writer keeps the stored value, and the other field still goes', async () => {
    const { state, write } = setup(reading(undefined, 'session_a'))
    await tick(0)
    expect(write).toHaveBeenLastCalledWith({ desk: undefined, remote_session: 'session_a' })
    state.value = reading('api', undefined)
    await tick(30_000)
    expect(write).toHaveBeenLastCalledWith({ desk: 'api', remote_session: undefined })
  })

  it('flush writes the latest reading again (the row may not have existed the first time), and has nothing before the first reading', async () => {
    const { write, refresh } = setup(reading('api'))
    refresh.flush()
    expect(write).not.toHaveBeenCalled()
    await tick(0)
    expect(write).toHaveBeenCalledTimes(1)
    refresh.flush()
    expect(write).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenLastCalledWith(reading('api'))
  })

  it('survives a read that rejects and a write that throws, and tries again', async () => {
    vi.useFakeTimers()
    let calls = 0
    const read = vi.fn(async () => { if (++calls === 1) throw new Error('boom'); return reading('api') })
    const write = vi.fn((_: PlaceReading): boolean => { if (write.mock.calls.length === 1) throw new Error('locked'); return true })
    startPlaceRefresh(read, write)
    await tick(0)
    expect(write).not.toHaveBeenCalled()
    await tick(30_000)
    expect(write).toHaveBeenCalledTimes(1)
    await tick(5 * 60_000)
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('never reads twice at once', async () => {
    vi.useFakeTimers()
    let running = 0
    let most = 0
    const read = vi.fn(async () => {
      most = Math.max(most, ++running)
      await new Promise((resolve) => setTimeout(resolve, 40_000))
      running--
      return reading('api')
    })
    startPlaceRefresh(read, () => true)
    await tick(0)
    await tick(30_000) // the second reading's turn comes while the first still runs
    await tick(20_000)
    expect(most).toBe(1)
  })

  it('stops for good', async () => {
    const { read, refresh } = setup()
    await tick(0)
    refresh.stop()
    await tick(10 * 60_000)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('holds no timer that keeps the process alive', async () => {
    vi.useFakeTimers()
    const made: Array<{ hasRef(): boolean }> = []
    for (const name of ['setTimeout', 'setInterval'] as const) {
      const original = globalThis[name]
      vi.spyOn(globalThis, name).mockImplementation(((...args: Parameters<typeof setTimeout>) => {
        const timer = (original as (...a: unknown[]) => { hasRef(): boolean })(...args)
        made.push(timer)
        return timer
      }) as never)
    }
    startPlaceRefresh(async () => none, () => true)
    await tick(30_000)
    expect(made.length).toBeGreaterThanOrEqual(2)
    expect(made.map((timer) => timer.hasRef())).toEqual(made.map(() => false))
  })

  describe('against the store: a row that is swept and recreated gets its place back', () => {
    const SCOPE = { session: 's1', project: 'p', stream: 'main', agent: 'claude-code', doing: 'open', idle: true, claim: false } as const
    const row = (db: ReturnType<typeof openDb>) => listActivity(db).find((r) => r.session === 's1')

    it('writes a place, loses the row to the day-old sweep, and writes it again when the row is recreated with nulls', async () => {
      vi.useFakeTimers()
      const db = openDb(join(scratchDir('place-sweep-'), 'inbox.db'))
      upsertActivity(db, SCOPE)
      startPlaceRefresh(async () => reading('api', 'session_abc'), (live) => setActivityPlace(db, 's1', live))
      await tick(0)
      expect(row(db)).toMatchObject({ desk: 'api', remote_session: 'session_abc' })
      // the sweep deletes the row; the next status or register call recreates it, with neither value
      db.prepare('DELETE FROM activity WHERE session = ?').run('s1')
      upsertActivity(db, SCOPE)
      expect(Object.keys(row(db)!)).not.toContain('desk')
      // the reading is the same as before: it must still be written
      await tick(30_000)
      expect(row(db)).toMatchObject({ desk: 'api', remote_session: 'session_abc' })
      db.close()
    })

    it('writes a reading taken before the row existed once the row does (flush), and a failed field keeps what is stored', async () => {
      vi.useFakeTimers()
      const db = openDb(join(scratchDir('place-flush-'), 'inbox.db'))
      const state = { value: reading('api', 'session_abc') }
      const place = startPlaceRefresh(async () => state.value, (live) => setActivityPlace(db, 's1', live))
      await tick(0) // read and written into no row at all
      upsertActivity(db, SCOPE)
      expect(Object.keys(row(db)!)).not.toContain('desk')
      place.flush()
      expect(row(db)).toMatchObject({ desk: 'api', remote_session: 'session_abc' })
      // a read that failed for one field leaves it; the clean absence of the other clears it
      state.value = reading(undefined, null)
      await tick(30_000)
      expect(row(db)).toMatchObject({ desk: 'api' })
      expect(Object.keys(row(db)!)).not.toContain('remote_session')
      db.close()
    })
  })
})


describe('served by the viewer: /api/activity and /api/version', () => {
  const SCOPE = { project: 'p', stream: 'main', agent: 'claude-code', doing: 'open', idle: true, claim: false } as const
  const setup = () => {
    const dir = scratchDir('place-viewer-')
    const db = openDb(join(dir, 'inbox.db'))
    const app = createViewer(db, { agentHome: scratchDir('place-agent-home-'), setupInfoPath: join(dir, 'none.json') })
    return { db, app }
  }
  const activity = async (app: ReturnType<typeof createViewer>) => (await (await app.request('/api/activity')).json()) as Array<Record<string, unknown>>
  const find = (rows: Array<Record<string, unknown>>, session: string) => rows.find((r) => r['session'] === session)!
  let machine: string | undefined
  beforeEach(() => { machine = process.env['AGENT_INBOX_MACHINE'] })
  afterEach(() => {
    if (machine === undefined) delete process.env['AGENT_INBOX_MACHINE']
    else process.env['AGENT_INBOX_MACHINE'] = machine
  })

  it('/api/activity serves each of the four only when it is set; an older server’s row has none', async () => {
    const { db, app } = setup()
    upsertActivity(db, { ...SCOPE, session: 'old' })
    upsertActivity(db, { ...SCOPE, session: 'new', machine: 'hub', pane: '%3' })
    setActivityPlace(db, 'new', { desk: 'api', remote_session: 'session_abc' })
    const rows = await activity(app)
    for (const key of ['machine', 'desk', 'pane', 'remote_session']) expect(Object.keys(find(rows, 'old')), key).not.toContain(key)
    expect(find(rows, 'new')).toMatchObject({ machine: 'hub', pane: '%3', desk: 'api', remote_session: 'session_abc' })
    db.close()
  })

  it('/api/activity leaves out a stored value that fails its pattern, as if it were null, and still serves the others', async () => {
    const { db, app } = setup()
    const hostile = [
      ['machine', 'a b'], ['machine', '-x'], ['machine', '$(id)'], ['machine', 'a'.repeat(65)],
      ['desk', "it's"], ['desk', '.hidden'], ['desk', '--help'], ['desk', 'a\nb'], ['desk', '<img src=x onerror=alert(1)>'],
      ['pane', '3'], ['pane', '%1234567'], ['pane', '%1;id'],
      ['remote_session', 'javascript:alert(1)'], ['remote_session', 'https://evil.example/session_a'], ['remote_session', 'session_'], ['remote_session', `session_${'x'.repeat(65)}`],
    ] as const
    for (const [column, value] of hostile) {
      upsertActivity(db, { ...SCOPE, session: 'h', machine: 'hub', pane: '%3' })
      setActivityPlace(db, 'h', { desk: 'api', remote_session: 'session_abc' })
      db.prepare(`UPDATE activity SET ${column} = ? WHERE session = 'h'`).run(value)
      const served = find(await activity(app), 'h')
      expect(Object.keys(served), `${column} = ${JSON.stringify(value)}`).not.toContain(column)
      const others = { machine: 'hub', pane: '%3', desk: 'api', remote_session: 'session_abc' } as Record<string, string>
      delete others[column]
      expect(served).toMatchObject(others)
      db.prepare(`DELETE FROM activity`).run()
    }
    db.close()
  })

  it('/api/version carries machine: the override, else the short host name, and none when it is not a valid name', async () => {
    const get = async () => {
      const { db, app } = setup()
      const body = (await (await app.request('/api/version')).json()) as Record<string, unknown>
      db.close()
      return body
    }
    process.env['AGENT_INBOX_MACHINE'] = 'hubbox'
    expect((await get())['machine']).toBe('hubbox')
    process.env['AGENT_INBOX_MACHINE'] = 'not a name'
    expect(Object.keys(await get())).not.toContain('machine')
    delete process.env['AGENT_INBOX_MACHINE']
    expect((await get())['machine']).toBe(readPlace({}).machine)
  })

  it('/api/version reads the machine once, when the viewer starts, as each session’s server does: a later change does not move it', async () => {
    process.env['AGENT_INBOX_MACHINE'] = 'first'
    const { db, app } = setup()
    process.env['AGENT_INBOX_MACHINE'] = 'second'
    expect(((await (await app.request('/api/version')).json()) as Record<string, unknown>)['machine']).toBe('first')
    db.close()
  })
})
