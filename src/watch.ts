import type Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defaultDbPath, getItem } from './store.js'

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
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  for (;;) {
    const item = getItem(db, id)
    if (!item || item.kind !== 'question' || item.status !== 'open') return 'closed'
    // A sibling may stamp pickup first; the asking session still needs its wake.
    if (item.reply?.trim() || item.annotation?.trim()) return 'reply'
    if (Date.now() >= deadline) return 'timeout'
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

export interface WatchLaunchOptions {
  execPath?: string
  execArgv?: string[]
  moduleUrl?: string
  dbPath?: string
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
  const argv = [execPath, ...execArgv, entry, id, dbPath]

  return {
    shell_command: argv.map(shellQuote).join(' '),
    mode: 'async' as const,
    detach: true,
    shell_id: `agent-inbox-${id}`,
    timeout_seconds: DEFAULT_TIMEOUT_MS / 1_000,
    on_completion: 'Call pending() immediately, act on the reply, then resolve the question.',
  }
}
