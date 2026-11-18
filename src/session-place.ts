// Where a session runs (#617, PR 1; docs/architecture/activity-and-live.md).
//
// The one place a machine, a tmux session name ("desk"), a tmux pane and a Remote
// Control id are read and checked. THE PATTERNS ARE THE SAFETY: a stored desk is
// later put in a command, so a value that fails its pattern is never stored, and
// it is never trimmed or cut to fit. No accepted name starts with `-`, so none can
// read as an option where a command uses it.
//
// This module is in the stdio MCP server's import graph, so it holds Node core
// imports only: no network, no viewer, no chat index (test/prstate.test.ts pins it).
import { execFile } from 'node:child_process'
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { hostname as osHostname } from 'node:os'
import { join } from 'node:path'

const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/
const PANE = /^%[0-9]{1,6}$/
const REMOTE_SESSION = /^session_[A-Za-z0-9]{1,64}$/

/** A live file is a few hundred bytes; anything past this is not one. */
const MAX_LIVE_FILE_BYTES = 16 * 1024
const TMUX_TIMEOUT_MS = 1000
const TMUX_MAX_BUFFER = 1024

const nonEmpty = (value: string | undefined): value is string => typeof value === 'string' && value !== ''

/**
 * The machine and the tmux pane, read once when the server starts: neither changes
 * while it runs. `machine` is AGENT_INBOX_MACHINE, else the host name up to its
 * first dot; a bad override is dropped, not replaced by the host name. `pane` is
 * TMUX_PANE. A missing or failing value is absent from the result.
 */
export function readPlace(env: NodeJS.ProcessEnv = process.env, hostname: string = osHostname()): { machine?: string; pane?: string } {
  const override = env['AGENT_INBOX_MACHINE']
  const machine = nonEmpty(override) ? override : hostname.split('.')[0]!
  const pane = env['TMUX_PANE']
  return {
    ...(NAME.test(machine) ? { machine } : {}),
    ...(nonEmpty(pane) && PANE.test(pane) ? { pane } : {}),
  }
}

/**
 * The host's Remote Control id: `bridgeSessionId` in `<home>/.claude/sessions/<hostPid>.json`.
 * Opened with O_NOFOLLOW (never through a symbolic link, and O_NONBLOCK so a named pipe
 * cannot hold the server), and it must be a regular file this user owns, of at most
 * 16 KiB, whose own `pid` is the host's. Anything else, or any error, is null.
 *
 * The id is read from the file because the server starts before its session registers
 * for Remote Control, so the environment variable is mostly absent when it matters.
 */
export function readRemoteSession(home: string, hostPid: number): string | null {
  if (!nonEmpty(home) || !Number.isSafeInteger(hostPid) || hostPid <= 0) return null
  let fd: number | null = null
  try {
    fd = openSync(join(home, '.claude', 'sessions', `${hostPid}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_LIVE_FILE_BYTES || (process.getuid && stat.uid !== process.getuid())) return null
    // one byte past the limit, so a file that grew since fstat still fails the size rule
    const buffer = Buffer.alloc(MAX_LIVE_FILE_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, length)
      if (n === 0) break
      length += n
    }
    if (length > MAX_LIVE_FILE_BYTES) return null
    const doc: unknown = JSON.parse(buffer.toString('utf8', 0, length))
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return null
    const record = doc as Record<string, unknown>
    const id = record['bridgeSessionId']
    return record['pid'] === hostPid && typeof id === 'string' && REMOTE_SESSION.test(id) ? id : null
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* nothing to do */ }
    }
  }
}

type TmuxRunner = (file: string, args: string[], opts: { timeout: number; maxBuffer: number }) => Promise<string>

const runTmux: TmuxRunner = (file, args, opts) => new Promise((resolve, reject) => {
  // an argument list, never a shell
  execFile(file, args, { ...opts, encoding: 'utf8', windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
})

/**
 * The tmux session name of `pane`, or null. Runs only when TMUX is set and the pane
 * is valid. A missing tmux, a timeout, too much output, any error and any name that
 * fails the pattern all give null. Only the newline tmux ends its output with goes.
 */
export async function readDesk(pane: string, opts: { env?: NodeJS.ProcessEnv; run?: TmuxRunner } = {}): Promise<string | null> {
  const env = opts.env ?? process.env
  if (!nonEmpty(env['TMUX']) || !PANE.test(pane)) return null
  try {
    const out = await (opts.run ?? runTmux)('tmux', ['display-message', '-p', '-t', pane, '#{session_name}'], { timeout: TMUX_TIMEOUT_MS, maxBuffer: TMUX_MAX_BUFFER })
    const name = out.endsWith('\n') ? out.slice(0, -1) : out
    return NAME.test(name) ? name : null
  } catch {
    return null
  }
}

/** The two values that can change or go away while a session runs. */
export interface PlaceLive {
  desk: string | null
  remote_session: string | null
}

export interface PlaceRefresh {
  /** Read now, unless a reading is already running (the server asks once it knows its agent). */
  refresh(): Promise<void>
  /** Write the latest reading if it has not been written yet (the row may not have existed before). */
  flush(): void
  stop(): void
}

const FIRST_AGAIN_MS = 30_000
const EVERY_MS = 5 * 60_000

/**
 * Re-reads `desk` and `remote_session` on a timer of its own (never the liveness tick,
 * which must stay one call): at once, again 30 seconds later (Remote Control may
 * register just after the server starts), then every five minutes. `write` is called
 * only when a reading differs from the last one written, and returns whether the row
 * took it: a reading made before the row existed is kept and written by the next
 * `flush()` or reading. A failing read or write is ignored; it must never break the server.
 */
export function startPlaceRefresh(read: () => Promise<PlaceLive>, write: (place: PlaceLive) => boolean): PlaceRefresh {
  let latest: PlaceLive | null = null
  // a new row holds neither value, so a reading with neither needs no write
  let written: PlaceLive = { desk: null, remote_session: null }
  let interval: NodeJS.Timeout | undefined
  let running = false
  let stopped = false
  const flush = (): void => {
    const now = latest
    if (stopped || now === null || (written.desk === now.desk && written.remote_session === now.remote_session)) return
    try {
      if (write(now)) written = now
    } catch { /* presence must never break the server */ }
  }
  const refresh = async (): Promise<void> => {
    if (running || stopped) return
    running = true
    try {
      latest = await read()
      flush()
    } catch { /* a failed reading changes nothing */ } finally {
      running = false
    }
  }
  void refresh()
  const second = setTimeout(() => {
    void refresh()
    interval = setInterval(() => void refresh(), EVERY_MS)
    interval.unref()
  }, FIRST_AGAIN_MS)
  second.unref()
  return {
    refresh,
    flush,
    stop() {
      stopped = true
      clearTimeout(second)
      if (interval) clearInterval(interval)
    },
  }
}
