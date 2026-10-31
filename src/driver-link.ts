// Issue #412 — linking a launch's MCP sessions by process ancestry. Design:
// docs/superpowers/specs/2026-10-31-driven-sessions-design.md §5.1 and the
// spike's recorded process chains (2026-10-31-copilot-acp-spike.md §5).
//
// The driver spawns the npm loader (`node …/bin/copilot`), which starts the
// native host (`…/@github/copilot-darwin-arm64/copilot`); every MCP server is a
// child of that host and records it as `host_pid`. A presence row joins the
// launch only when all four rules hold:
//   1. its server_pid is alive now;
//   2. its current parent is its host_pid;
//   3. its start time is at or after the driver's child's;
//   4. its host_pid EQUALS the launch's recorded native host pid.
// Rule 4 is exact equality with no walk: a nested `copilot -p` the agent starts
// has its own host, so its server stays its own session (76817 ≠ 76681 in the
// recorded chain). The store's listHostSessions(db, nativeHost) is rule 4.
import { execFile } from 'node:child_process'

/** A presence row as linking needs it (`listHostSessions` plus the host it was read for). */
export interface PresenceRow {
  session: string
  host_pid: number | null
  server_pid: number | null
}

export interface ProcessInfo {
  pid: number
  ppid: number
  /** Start time in ms since the epoch, at ps's one-second precision. */
  startMs: number
  /** The executable's basename (`ucomm`). */
  ucomm: string
  command: string
}

// `ps -o lstart=` prints e.g. "Sat Oct 31 09:38:12 2026" (five fields, local time, LC_ALL=C).
const LINE = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s?(.*)$/

/** Parses `ps -A -ww -o pid=,ppid=,lstart=,ucomm=,command=`; unreadable lines are skipped. */
export function parsePs(text: string): Map<number, ProcessInfo> {
  const out = new Map<number, ProcessInfo>()
  for (const line of text.split('\n')) {
    const match = LINE.exec(line)
    if (!match) continue
    const startMs = Date.parse(match[3]!.replace(/\s+/g, ' '))
    if (!Number.isFinite(startMs)) continue
    const pid = Number(match[1])
    out.set(pid, { pid, ppid: Number(match[2]), startMs, ucomm: match[4]!, command: match[5] ?? '' })
  }
  return out
}

/** One process table read: argv only, stdout captured, never a shell. */
export function readProcesses(): Promise<Map<number, ProcessInfo>> {
  return new Promise((resolve, reject) => {
    execFile('/bin/ps', ['-A', '-ww', '-o', 'pid=,ppid=,lstart=,ucomm=,command='], {
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10_000,
    }, (error, stdout) => {
      if (error) reject(error)
      else resolve(parsePs(stdout))
    })
  })
}

/** An agent host: `ucomm` copilot, claude or claude-agent-acp, or `@github/copilot` in its command. */
export function isAgentHost(info: ProcessInfo): boolean {
  return ['copilot', 'claude', 'claude-agent-acp'].includes(info.ucomm) || info.command.includes('@github/copilot')
}

/**
 * The launch's native host: the spawned child itself when it is the native
 * binary, else the loader's child that is an agent host. The npm loader's own
 * command line names `…/bin/copilot` but its ucomm is `node`, so a child of it
 * is preferred over it. Null until the host has started.
 */
export function findNativeHost(procs: ReadonlyMap<number, ProcessInfo>, childPid: number): number | null {
  const child = procs.get(childPid)
  if (!child) return null
  if (child.ucomm === 'copilot') return childPid
  for (const info of procs.values()) {
    if (info.ppid === childPid && isAgentHost(info)) return info.pid
  }
  return null
}

export interface LinkResult {
  /** Presence rows that belong to the launch now. */
  linked: string[]
  /** Rows of the launch's host whose server process is gone: ended, whatever presence says. */
  dead: string[]
}

/**
 * Applies the four rules. The driver reads the rows with
 * listHostSessions(db, hostPid), which is rule 4 as a query; it is checked
 * again here. `childStartMs` is the spawned child's start as ps reports it.
 */
export function linkSessions(
  rows: readonly PresenceRow[],
  procs: ReadonlyMap<number, ProcessInfo>,
  launch: { hostPid: number; childStartMs: number },
): LinkResult {
  const linked: string[] = []
  const dead: string[] = []
  for (const row of rows) {
    if (row.host_pid !== launch.hostPid) continue
    const server = row.server_pid === null ? undefined : procs.get(row.server_pid)
    if (!server) {
      dead.push(row.session)
      continue
    }
    if (server.ppid !== launch.hostPid) continue
    if (server.startMs < launch.childStartMs) continue
    linked.push(row.session)
  }
  return { linked, dead }
}
