// Where a session runs (#617, PR 1; design 2026-11-17-remote-inbox-design.md §3.1).
//
// src/session-place.ts is the one place a machine, a tmux session name, a tmux
// pane and a Remote Control id are read and checked. The PATTERNS ARE THE SAFETY:
// a later change hands a stored `desk` to a shell, so a value that fails its
// pattern is never stored, and is never trimmed or cut to fit. Every fixture here
// is synthetic: no real host, folder or session id.
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readDesk, readPlace, readRemoteSession, startPlaceRefresh } from '../src/session-place.js'
import type { PlaceLive } from '../src/session-place.js'
import { openDb, setActivityPlace, upsertActivity } from '../src/store.js'
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
  const runner = (out: string) => vi.fn(async (_file: string, _args: string[], _opts: { timeout: number; maxBuffer: number }) => out)

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

  it('refuses a hostile name instead of fixing it', async () => {
    const hostile = [
      'my desk', "it's", '"q"', '$(id)', '`id`', 'a;b', 'a&b', 'a|b', 'a>b', '*', '-t', '--help', '-x', '.hidden', '..', '.',
      `${NAME_64}c`, 'a'.repeat(65), '', '\n', 'a\nb', 'a\n\n', ' a', 'a ', '\ta', 'a\r', 'é', 'a\u0000b', 'a\\b', 'a/b', '=a', '%1',
    ]
    for (const name of hostile) expect(await readDesk('%3', { env, run: runner(`${name}\n`) }), JSON.stringify(name)).toBeNull()
  })

  it('runs only when TMUX is set and the pane is valid', async () => {
    const run = runner('work\n')
    expect(await readDesk('%3', { env: { TMUX_PANE: '%3' }, run })).toBeNull()
    expect(await readDesk('%3', { env: { TMUX: '', TMUX_PANE: '%3' }, run })).toBeNull()
    expect(await readDesk('%3', { env: {}, run })).toBeNull()
    for (const bad of ['', '3', '%', '%a', '%1234567', '-t', '%1 ', '%1;id']) expect(await readDesk(bad, { env, run }), bad).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  it('answers null when the runner fails', async () => {
    expect(await readDesk('%3', { env, run: async () => { throw new Error('spawn tmux ENOENT') } })).toBeNull()
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

    it('answers null when tmux exits with an error', async () => {
      fake('echo work; exit 1')
      expect(await readDesk('%3', { env })).toBeNull()
    })

    it('answers null after the one second timeout, when tmux hangs', async () => {
      fake('exec /bin/sleep 5')
      const started = Date.now()
      expect(await readDesk('%3', { env })).toBeNull()
      // it waited for the timeout (and no longer), not for the program or an early failure
      expect(Date.now() - started).toBeGreaterThanOrEqual(900)
      expect(Date.now() - started).toBeLessThan(4000)
    })

    it('answers null when tmux prints more than 1 KiB', async () => {
      fake('i=0; while [ $i -lt 2000 ]; do printf a; i=$((i+1)); done; echo')
      expect(await readDesk('%3', { env })).toBeNull()
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

  it('answers null with no file, no folder and no home', () => {
    expect(readRemoteSession(home, PID)).toBeNull()
    expect(readRemoteSession(join(home, 'nowhere'), PID)).toBeNull()
    expect(readRemoteSession('', PID)).toBeNull()
  })

  it('answers null when the file has no id, or one that is not a string', () => {
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

  it('answers null when the file’s own pid is not the host’s', () => {
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

  it('never follows a symbolic link, to a good file or anywhere else', () => {
    const real = join(home, 'elsewhere.json')
    writeFileSync(real, JSON.stringify({ pid: PID, bridgeSessionId: ID }))
    symlinkSync(real, join(sessions, `${PID}.json`))
    expect(readRemoteSession(home, PID)).toBeNull()
  })

  it('answers null for a file that is not a regular file', () => {
    mkdirSync(join(sessions, `${PID}.json`))
    expect(readRemoteSession(home, PID)).toBeNull()
    // a named pipe is neither opened for long nor read
    execFileSync('mkfifo', [join(sessions, '77.json')])
    expect(readRemoteSession(home, 77)).toBeNull()
  })

  it('reads at most 16 KiB: a good document of that size passes, one byte more does not', () => {
    const doc = JSON.stringify({ pid: PID, bridgeSessionId: ID })
    live(doc + ' '.repeat(16 * 1024 - doc.length))
    expect(readRemoteSession(home, PID)).toBe(ID)
    live(doc + ' '.repeat(16 * 1024 - doc.length + 1))
    expect(readRemoteSession(home, PID)).toBeNull()
    live(JSON.stringify({ pid: PID, bridgeSessionId: ID, pad: 'x'.repeat(100_000) }))
    expect(readRemoteSession(home, PID)).toBeNull()
  })

  it('answers null for text that is not one JSON object', () => {
    for (const text of ['', 'not json', '[]', 'null', '42', '"session_a"', `[{"pid":${PID},"bridgeSessionId":"${ID}"}]`, `{"pid":${PID},"bridgeSessionId":"${ID}"`]) {
      live(text)
      expect(readRemoteSession(home, PID), text).toBeNull()
    }
  })

  it('answers null for a pid that cannot name a process, without reading anything', () => {
    live({ pid: 0, bridgeSessionId: ID }, 0)
    for (const pid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(readRemoteSession(home, pid), String(pid)).toBeNull()
  })
})

describe('startPlaceRefresh: its own timer, and a write only on a change', () => {
  const none: PlaceLive = { desk: null, remote_session: null }
  const live = (desk: string | null, remote_session: string | null = null): PlaceLive => ({ desk, remote_session })
  const tick = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms) }

  function setup(first: PlaceLive = none, rowThere = true) {
    vi.useFakeTimers()
    const state = { value: first, rowThere }
    const read = vi.fn(async () => state.value)
    const write = vi.fn((_: PlaceLive) => state.rowThere)
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

  it('writes the first reading, then only when a value differs from the last one written', async () => {
    const { state, write } = setup(live('api', 'session_a'))
    await tick(0)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenLastCalledWith({ desk: 'api', remote_session: 'session_a' })
    await tick(30_000)
    await tick(5 * 60_000)
    expect(write).toHaveBeenCalledTimes(1)
    state.value = live('api2', 'session_a')
    await tick(5 * 60_000)
    expect(write).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenLastCalledWith({ desk: 'api2', remote_session: 'session_a' })
    // a name gone away is a write of nulls, not a kept name
    state.value = none
    await tick(5 * 60_000)
    expect(write).toHaveBeenCalledTimes(3)
    expect(write).toHaveBeenLastCalledWith(none)
    state.value = live(null, 'session_b')
    await tick(5 * 60_000)
    expect(write).toHaveBeenLastCalledWith(live(null, 'session_b'))
  })

  it('writes nothing for a session that has neither value and never had one', async () => {
    const { write } = setup(none)
    await tick(0)
    await tick(30_000)
    expect(write).not.toHaveBeenCalled()
  })

  it('keeps a reading the row was not there for, and writes it when the row exists (flush)', async () => {
    const { state, write, refresh } = setup(live('api'), false)
    await tick(0)
    expect(write).toHaveBeenCalledTimes(1)
    state.rowThere = true
    refresh.flush()
    expect(write).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenLastCalledWith(live('api'))
    refresh.flush()
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('has nothing to flush before the first reading', () => {
    const { write, refresh } = setup(live('api'))
    refresh.flush()
    expect(write).not.toHaveBeenCalled()
  })

  it('survives a read that rejects and a write that throws, and tries again', async () => {
    vi.useFakeTimers()
    let calls = 0
    const read = vi.fn(async () => { if (++calls === 1) throw new Error('boom'); return live('api') })
    const write = vi.fn((_: PlaceLive): boolean => { if (write.mock.calls.length === 1) throw new Error('locked'); return true })
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
      return live('api')
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
})

describe('served by the viewer: /api/activity and /api/version', () => {
  const setup = () => {
    const dir = scratchDir('place-viewer-')
    const db = openDb(join(dir, 'inbox.db'))
    const app = createViewer(db, { agentHome: scratchDir('place-agent-home-'), setupInfoPath: join(dir, 'none.json') })
    return { db, app }
  }
  const SCOPE = { project: 'p', stream: 'main', agent: 'claude-code', doing: 'open', idle: true, claim: false } as const
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
    const rows = (await (await app.request('/api/activity')).json()) as Array<Record<string, unknown>>
    const old = rows.find((r) => r['session'] === 'old')!
    for (const key of ['machine', 'desk', 'pane', 'remote_session']) expect(Object.keys(old), key).not.toContain(key)
    expect(rows.find((r) => r['session'] === 'new')).toMatchObject({ machine: 'hub', pane: '%3', desk: 'api', remote_session: 'session_abc' })
    db.close()
  })

  it('/api/version carries machine: the override, else the short host name, and none when it is not a valid name', async () => {
    const { db, app } = setup()
    const get = async () => (await (await app.request('/api/version')).json()) as Record<string, unknown>
    process.env['AGENT_INBOX_MACHINE'] = 'hubbox'
    expect((await get())['machine']).toBe('hubbox')
    process.env['AGENT_INBOX_MACHINE'] = 'not a name'
    expect(Object.keys(await get())).not.toContain('machine')
    delete process.env['AGENT_INBOX_MACHINE']
    expect((await get())['machine']).toBe(readPlace({}).machine)
    db.close()
  })
})
