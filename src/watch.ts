import type Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defaultDbPath, getActiveBoardRow, getItem } from './store.js'

export type WatchResult = 'reply' | 'closed' | 'timeout'

export interface WatchOptions {
  pollMs?: number
  timeoutMs?: number
}

const DEFAULT_POLL_MS = 1_000
const DEFAULT_TIMEOUT_MS = 30 * 60_000

export async function waitForQuestionResponse(
  db: Database.Database,
  id: string,
  options: WatchOptions = {},
): Promise<WatchResult> {
  return waitForResponse(() => {
    const item = getItem(db, id)
    if (!item || item.kind !== 'question' || item.status !== 'open') return 'closed'
    // A sibling may stamp pickup first; the asking session still needs its wake.
    if (item.reply?.trim() || item.annotation?.trim()) return 'reply'
    return undefined
  }, options)
}

export function boardResponseState(
  db: Database.Database,
  rowId: string,
  actionVersion: number,
): 'reply' | 'closed' | undefined {
  const row = getActiveBoardRow(db, rowId)
  if (!row || row.status !== 'blocked' || row.action_version !== actionVersion) return 'closed'
  if (row.annotation?.trim() || row.annotation_kind || row.handled_at) return 'reply'
  return undefined
}

export async function waitForBoardResponse(
  db: Database.Database,
  rowId: string,
  actionVersion: number,
  options: WatchOptions = {},
): Promise<WatchResult> {
  return waitForResponse(() => boardResponseState(db, rowId, actionVersion), options)
}

async function waitForResponse(
  state: () => 'reply' | 'closed' | undefined,
  options: WatchOptions,
): Promise<WatchResult> {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  for (;;) {
    const result = state()
    if (result) return result
    if (Date.now() >= deadline) return 'timeout'
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

  return {
    shell_command: argv.map(shellQuote).join(' '),
    mode: 'async' as const,
    detach: true,
    shell_id: version === undefined ? `agent-inbox-${id}` : `agent-inbox-row-${id}-${version}`,
    timeout_seconds: DEFAULT_TIMEOUT_MS / 1_000,
    on_completion: version === undefined
      ? `Call ${pending} immediately, act on the reply, then resolve the question.`
      : `Call ${pending} immediately, act on the response, then change the row status and record an outcome. Use the row's project for board updates. A timeout is not an answer; if still waiting, re-arm with board_get({title, watch:true}).`,
  }
}
