// Where a session runs (#617, PR 1; docs/architecture/activity-and-live.md).
//
// The one place a machine, a tmux session name ("desk"), a tmux pane and a Remote
// Control id are read and checked. THE PATTERNS ARE THE SAFETY: a stored desk is
// later put in a command, so the product's writer stores only a value that matches
// its pattern, `listActivity` serves only a value that matches it again, and the page
// checks a third time. The store itself checks nothing on write. A value that fails is
// never trimmed or cut to fit. No accepted name starts with `-`, so none can read as an
// option where a command uses it.
//
// A reading has three answers: a value, null and undefined. null is "absent": the thing is
// cleanly not there, so a stored value is stale and is cleared. undefined is "failed": the
// read itself did not work (tmux timed out, a file was caught mid-rewrite), so nothing is
// known and the stored value is kept.
//
// The patterns live in public/place.js, which the page uses too. This module is in the stdio MCP
// server's import graph, so it holds Node core imports and that pure module only: no network, no
// viewer, no chat index (test/prstate.test.ts pins it).
import { execFile } from 'node:child_process'
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { homedir, hostname as osHostname } from 'node:os'
import { join } from 'node:path'
import { PLACE_NAME, PLACE_PANE, PLACE_REMOTE_SESSION } from '../public/place.js'

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
    ...(PLACE_NAME.test(machine) ? { machine } : {}),
    ...(nonEmpty(pane) && PLACE_PANE.test(pane) ? { pane } : {}),
  }
}

const errorCode = (error: unknown): unknown => (error !== null && typeof error === 'object' ? (error as { code?: unknown }).code : undefined)

/**
 * The host's Remote Control id: `bridgeSessionId` in `<home>/.claude/sessions/<hostPid>.json`.
 * The file is opened with O_NOFOLLOW, so it is never opened if the file ITSELF is a symbolic
 * link; the folders above it are followed (a symlinked `sessions` folder works), and the owner
 * and pid checks still hold. O_NONBLOCK keeps a named pipe from holding the server. It must be a
 * regular file this user owns whose own `pid` is the host's, and at most 16 KiB: at most 16 KiB +
 * 1 byte is read, and one more than 16 KiB is refused, which covers a file that is big now and
 * one that grew after it was opened.
 *
 * The answer is the id, null (absent) or undefined (failed):
 * - absent (null): no file or folder (ENOENT, ENOTDIR), a symbolic link (ELOOP), not a regular
 *   file, not ours, over 16 KiB, complete JSON that is not an object, another pid's, no
 *   `bridgeSessionId`, or one that fails its pattern;
 * - failed (undefined): any other error opening, statting or reading, and text that does not
 *   parse as JSON: an empty or partial file, as Claude Code leaves it while it rewrites.
 *
 * The id is read from the file because the server starts before its session registers for
 * Remote Control, so the environment variable is mostly absent when it matters.
 */
export function readRemoteSession(home: string, hostPid: number): string | null | undefined {
  if (!nonEmpty(home) || !Number.isSafeInteger(hostPid) || hostPid <= 0) return null
  let fd: number | null = null
  try {
    try {
      fd = openSync(join(home, '.claude', 'sessions', `${hostPid}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    } catch (error) {
      const code = errorCode(error)
      return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP' ? null : undefined
    }
    const stat = fstatSync(fd)
    if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid())) return null
    // one byte past the limit, so a file over it fails whether it was big when opened or grew since
    const buffer = Buffer.alloc(MAX_LIVE_FILE_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, length)
      if (n === 0) break
      length += n
    }
    if (length > MAX_LIVE_FILE_BYTES) return null
    let doc: unknown
    try {
      doc = JSON.parse(buffer.toString('utf8', 0, length))
    } catch {
      return undefined
    }
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return null
    const record = doc as Record<string, unknown>
    const id = record['bridgeSessionId']
    return record['pid'] === hostPid && typeof id === 'string' && PLACE_REMOTE_SESSION.test(id) ? id : null
  } catch {
    return undefined
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* nothing to do */ }
    }
  }
}

type TmuxRunner = (file: string, args: string[], opts: { timeout: number; maxBuffer: number }) => Promise<string>

const runTmux: TmuxRunner = (file, args, opts) => new Promise((resolve, reject) => {
  // an argument list, never a shell
  execFile(file, args, { ...opts, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr })) : resolve(stdout)))
})

/** What tmux says when the pane, its session or its server is gone: the name is cleanly not there. */
const TMUX_GONE = /can't find (pane|session|window)|no server running|error connecting to|no current (client|session)/i

/** A tmux that ran and said the pane is gone, or is not installed. Everything else is a failed read. */
function tmuxAbsent(error: unknown): boolean {
  const code = errorCode(error)
  if (code === 'ENOENT') return true
  const stderr = error !== null && typeof error === 'object' ? (error as { stderr?: unknown }).stderr : undefined
  return typeof code === 'number' && typeof stderr === 'string' && TMUX_GONE.test(stderr)
}

/**
 * The tmux session name of `pane`: a name, null (absent) or undefined (failed). Runs only
 * when TMUX is set and the pane is valid; otherwise null. Only the newline tmux ends its
 * output with goes.
 * - absent (null): no TMUX or a bad pane; tmux is not installed (ENOENT); tmux ran and says there
 *   is no such pane, session or server (a non-zero exit whose message says so); and a name that
 *   fails the pattern, because the session's real name is then one we will not store, so a stored
 *   name is stale;
 * - failed (undefined): a timeout or a signal, more than 1 KiB of output, an exit that does not
 *   say the pane is gone, and any other error.
 */
export async function readDesk(pane: string, opts: { env?: NodeJS.ProcessEnv; run?: TmuxRunner } = {}): Promise<string | null | undefined> {
  const env = opts.env ?? process.env
  if (!nonEmpty(env['TMUX']) || !PLACE_PANE.test(pane)) return null
  try {
    const out = await (opts.run ?? runTmux)('tmux', ['display-message', '-p', '-t', pane, '#{session_name}'], { timeout: TMUX_TIMEOUT_MS, maxBuffer: TMUX_MAX_BUFFER })
    const name = out.endsWith('\n') ? out.slice(0, -1) : out
    return PLACE_NAME.test(name) ? name : null
  } catch (error) {
    return tmuxAbsent(error) ? null : undefined
  }
}

/** The two values that can change or go away while a session runs; undefined means the read failed. */
export interface PlaceReading {
  desk: string | null | undefined
  remote_session: string | null | undefined
}

/** Where a server reads its place from: what it was started with, and the two readers. */
export interface PlaceSource {
  place: { machine?: string; pane?: string }
  desk(pane: string): Promise<string | null | undefined>
  remoteSession(hostPid: number): string | null | undefined
}

/** The real readers: this process's environment, the real tmux and the real home. Tests pass their own. */
export function realPlaceSource(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): PlaceSource {
  return {
    place: readPlace(env),
    desk: (pane) => readDesk(pane, { env }),
    remoteSession: (hostPid) => readRemoteSession(home, hostPid),
  }
}

export interface PlaceRefresh {
  /** Read now, unless a reading is already running (the server asks once it knows its agent). */
  refresh(): Promise<void>
  /** Write the latest reading again: the row may not have existed when it was taken. */
  flush(): void
  stop(): void
}

const FIRST_AGAIN_MS = 30_000
const EVERY_MS = 5 * 60_000

/**
 * Re-reads `desk` and `remote_session` on a timer of its own (never the liveness tick,
 * which must stay one call): at once, again 30 seconds later (Remote Control may
 * register just after the server starts), then every five minutes. It remembers nothing
 * about what was written: every reading goes to `write`, and the writer (`setActivityPlace`)
 * changes the row only when a value differs, so a row that was swept and recreated with nulls
 * gets its place back. A field that failed to read is passed on as undefined, which the writer
 * keeps as stored. A failing read or write is ignored; it must never break the server.
 */
export function startPlaceRefresh(read: () => Promise<PlaceReading>, write: (place: PlaceReading) => unknown): PlaceRefresh {
  let latest: PlaceReading | null = null
  let running = false
  let stopped = false
  let interval: NodeJS.Timeout | undefined
  const flush = (): void => {
    if (stopped || latest === null) return
    try {
      write(latest)
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
