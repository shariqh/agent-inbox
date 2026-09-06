#!/usr/bin/env node
import { openDb } from './store.js'
import { waitForBoardResponse, waitForQuestionResponse } from './watch.js'

function boundedEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name])
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

const args = process.argv.slice(2)
const rowMode = args[0] === '--row'
const id = args[rowMode ? 1 : 0]
const versionText = args[2]
const actionVersion = rowMode ? Number(versionText) : undefined
const dbPath = args[rowMode ? 3 : 1]
if (
  args.length !== (rowMode ? 4 : 2) || !id || !dbPath
  || (rowMode && (!/^[1-9]\d*$/.test(versionText ?? '') || !Number.isSafeInteger(actionVersion)))
) {
  process.stderr.write('usage: agent-inbox-watch <item-id> <database-path>\n       agent-inbox-watch --row <row-id> <action-version> <database-path>\n')
  process.exit(64)
}

const db = openDb(dbPath)
try {
  const options = {
    pollMs: boundedEnv('AGENT_INBOX_WATCH_POLL_MS', 1_000, 50, 60_000),
    timeoutMs: boundedEnv('AGENT_INBOX_WATCH_TIMEOUT_MS', 30 * 60_000, 1_000, 24 * 60 * 60_000),
  }
  const result = actionVersion === undefined
    ? await waitForQuestionResponse(db, id, options)
    : await waitForBoardResponse(db, id, actionVersion, options)
  if (result === 'reply') {
    process.stdout.write('Agent Inbox reply ready. Call pending().\n')
  } else if (result === 'closed') {
    process.stdout.write(rowMode ? 'Agent Inbox row action closed.\n' : 'Agent Inbox question closed.\n')
  } else {
    process.stderr.write('Agent Inbox watcher timed out.\n')
    process.exitCode = 124
  }
} finally {
  db.close()
}
