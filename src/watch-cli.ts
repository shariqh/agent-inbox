#!/usr/bin/env node
import { openDb } from './store.js'
import { waitForQuestionResponse } from './watch.js'

function boundedEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name])
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

const id = process.argv[2]
const dbPath = process.argv[3]
if (!id || !dbPath) {
  process.stderr.write('usage: agent-inbox-watch <item-id> <database-path>\n')
  process.exit(64)
}

const db = openDb(dbPath)
try {
  const result = await waitForQuestionResponse(db, id, {
    pollMs: boundedEnv('AGENT_INBOX_WATCH_POLL_MS', 1_000, 50, 60_000),
    timeoutMs: boundedEnv('AGENT_INBOX_WATCH_TIMEOUT_MS', 30 * 60_000, 1_000, 24 * 60 * 60_000),
  })
  if (result === 'reply') {
    process.stdout.write('Agent Inbox reply ready. Call pending().\n')
  } else if (result === 'closed') {
    process.stdout.write('Agent Inbox question closed.\n')
  } else {
    process.stderr.write('Agent Inbox watcher timed out.\n')
    process.exitCode = 124
  }
} finally {
  db.close()
}
