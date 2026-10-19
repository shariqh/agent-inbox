import type Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defaultDbPath, getActiveBoardRow, getItem } from './store.js'
import type { BoardRow } from './store.js'

export type WatchResult = 'reply' | 'closed' | 'stopped' | 'timeout'

export interface WatchOptions {
  pollMs?: number
  // A forced wait (the CLI's AGENT_INBOX_WATCH_TIMEOUT_MS). Otherwise the wait
  // backs off from the ask's own age (watchTimeoutMs).
  timeoutMs?: number
}

// The watcher's exit status when the human asked it to stop (issue #217). Not
// 0 (an answer or a closed ask) and not 124 (a timeout, which agents re-arm).
export const WATCH_STOPPED_EXIT = 3

const DEFAULT_POLL_MS = 1_000
const MINUTE_MS = 60_000
const WATCH_BASE_MS = 30 * MINUTE_MS
const WATCH_BACKOFF_CAP_MS = 4 * 60 * MINUTE_MS
// The longest any one watcher lives, even through a longer quiet time the human
// asked for: an orphaned watcher whose session ended stops polling within a day.
const WATCH_MAX_MS = 24 * 60 * MINUTE_MS

// Issue #217 — a timeout is not an answer, so each one costs the asking agent a
// whole turn just to re-arm. Wait as long as the ask has already waited plus
// one base period: re-arms of an unchanged ask then double, 30 min → 1 h → 2 h
// → 4 h, and the cap keeps an orphaned watcher from outliving its session by
// more than four hours. Stateless: the age comes from the ask itself. Whole
// minutes, so a contract and the watcher launched moments later agree.
export function watchTimeoutMs(startedAt: string | null | undefined, nowMs: number): number {
  const started = startedAt ? Date.parse(startedAt) : Number.NaN
  const age = Number.isFinite(started) ? Math.max(0, nowMs - started) : 0
  return Math.min(WATCH_BACKOFF_CAP_MS, WATCH_BASE_MS + Math.floor(age / MINUTE_MS) * MINUTE_MS)
}

// What a watcher needs from either kind of ask: when it started waiting, and
// the human's snooze and stop (issue #217).
export interface WatchedAsk extends Pick<BoardRow, 'snoozed_until' | 'watch_stopped_at' | 'watch_stopped_until'> {
  startedAt: string
}

// A stop with no time ends the watcher for good, and a re-arm contract for it
// would only cost the agent another wake.
export function watchStoppedForGood(ask: WatchedAsk): boolean {
  return ask.watch_stopped_at !== null && ask.watch_stopped_until === null
}

// The latest time the human asked the watcher to wait through quietly: a snooze
// or a "back in a while" stop. Past or unparseable times simply never extend.
function quietUntilMs(ask: WatchedAsk): number {
  const times = [ask.snoozed_until, ask.watch_stopped_at === null ? null : ask.watch_stopped_until]
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter(Number.isFinite)
  return times.length ? Math.max(...times) : 0
}

// The wait a watcher launched now would take: the backoff, or the human's quiet
// time when that is longer, never past WATCH_MAX_MS. A brand-new ask passes none.
function watchWaitMs(ask: WatchedAsk | undefined, nowMs: number): number {
  const backoff = watchTimeoutMs(ask?.startedAt, nowMs)
  return Math.min(WATCH_MAX_MS, Math.max(backoff, ask ? quietUntilMs(ask) - nowMs : 0))
}

export function rowWatchedAsk(row: BoardRow): WatchedAsk {
  return {
    startedAt: row.action_started_at,
    snoozed_until: row.snoozed_until,
    watch_stopped_at: row.watch_stopped_at,
    watch_stopped_until: row.watch_stopped_until,
  }
}

type AskState = { result: 'reply' | 'closed' } | { result?: undefined; ask: WatchedAsk }

export async function waitForQuestionResponse(
  db: Database.Database,
  id: string,
  options: WatchOptions = {},
): Promise<WatchResult> {
  return waitForResponse((): AskState => {
    const item = getItem(db, id)
    if (!item || item.kind !== 'question' || item.status !== 'open') return { result: 'closed' }
    // A sibling may stamp pickup first; the asking session still needs its wake.
    if (item.reply?.trim() || item.annotation?.trim()) return { result: 'reply' }
    return {
      ask: {
        startedAt: item.created_at,
        snoozed_until: item.snoozed_until,
        watch_stopped_at: item.watch_stopped_at,
        watch_stopped_until: item.watch_stopped_until,
      },
    }
  }, options)
}

// Shared with the Claude hook's watch, which never wakes on a timeout and so
// has nothing for the human's stop to save: a stopped row is still open here.
export function boardResponseState(
  db: Database.Database,
  rowId: string,
  actionVersion: number,
): 'reply' | 'closed' | undefined {
  return boardAskState(db, rowId, actionVersion).result
}

function boardAskState(db: Database.Database, rowId: string, actionVersion: number): AskState {
  const row = getActiveBoardRow(db, rowId)
  if (!row || row.status !== 'blocked' || row.action_version !== actionVersion) return { result: 'closed' }
  if (row.annotation?.trim() || row.annotation_kind || row.handled_at) return { result: 'reply' }
  return { ask: rowWatchedAsk(row) }
}

export async function waitForBoardResponse(
  db: Database.Database,
  rowId: string,
  actionVersion: number,
  options: WatchOptions = {},
): Promise<WatchResult> {
  return waitForResponse(() => boardAskState(db, rowId, actionVersion), options)
}

// An answer or a closed ask always ends the wait first. A stop for good ends it
// next; otherwise the human's quiet time can only push the deadline out.
async function waitForResponse(
  read: () => AskState,
  options: WatchOptions,
): Promise<WatchResult> {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const launchedAt = Date.now()
  let base: number | undefined
  for (;;) {
    const state = read()
    if (state.result) return state.result
    if (watchStoppedForGood(state.ask)) return 'stopped'
    const now = Date.now()
    base ??= launchedAt + (options.timeoutMs ?? watchTimeoutMs(state.ask.startedAt, launchedAt))
    if (now >= Math.min(launchedAt + WATCH_MAX_MS, Math.max(base, quietUntilMs(state.ask)))) return 'timeout'
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

export interface WatchLaunchOptions {
  execPath?: string
  execArgv?: string[]
  moduleUrl?: string
  dbPath?: string
  rowActionVersion?: number
  project?: string
  // The ask being re-armed, which sizes timeout_seconds; a brand-new ask has none.
  ask?: WatchedAsk
  nowMs?: number
}

function shellQuote(value: string): string {
  return `'${value.replaceAll(`'`, `'\\''`)}'`
}

export function copilotWatchLaunch(id: string, options: WatchLaunchOptions = {}) {
  const execPath = options.execPath ?? process.execPath
  const execArgv = options.execArgv ?? process.execArgv
  const moduleUrl = options.moduleUrl ?? import.meta.url
  const dbPath = options.dbPath ?? defaultDbPath()
  const modulePath = fileURLToPath(moduleUrl)
  const sourceEntry = new URL('./watch-cli.ts', moduleUrl)
  const builtEntry = new URL('./watch-cli.js', moduleUrl)
  const entry = modulePath.endsWith('.ts') && !existsSync(fileURLToPath(builtEntry))
    ? fileURLToPath(sourceEntry)
    : fileURLToPath(builtEntry)
  const version = options.rowActionVersion
  if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) {
    throw new Error('rowActionVersion must be a positive safe integer')
  }
  const targetArgs = version === undefined ? [id] : ['--row', id, String(version)]
  const argv = [execPath, ...execArgv, entry, ...targetArgs, dbPath]
  const pending = options.project === undefined ? 'pending()' : `pending({project:${JSON.stringify(options.project)}})`
  const stopped = `Exit ${WATCH_STOPPED_EXIT} means the human asked you to stop waiting: do not re-arm; their answer still arrives through ${pending} or chat.`

  return {
    shell_command: argv.map(shellQuote).join(' '),
    mode: 'async' as const,
    detach: true,
    shell_id: version === undefined ? `agent-inbox-${id}` : `agent-inbox-row-${id}-${version}`,
    // The wait the watcher itself will take: it re-derives the same backoff from
    // the ask at launch, so re-running this exact command also waits longer.
    timeout_seconds: Math.ceil(watchWaitMs(options.ask, options.nowMs ?? Date.now()) / 1_000),
    on_completion: version === undefined
      ? `Call ${pending} immediately, act on the reply, then resolve the question. A timeout (exit 124) is not an answer: if still waiting, re-run this same command; it waits longer each time. ${stopped}`
      : `Call ${pending} immediately, act on the response, then change the row status and record an outcome. Use the row's project for board updates. A timeout (exit 124) is not an answer: if still waiting, re-arm with board_get({title, watch:true}); it waits longer each time. ${stopped}`,
  }
}
