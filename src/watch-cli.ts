#!/usr/bin/env node
import { openDb } from './store.js'
import { WATCH_STOPPED_EXIT, waitForBoardResponse, waitForQuestionResponse, waitForSessionMessage } from './watch.js'

function boundedEnv(name: string, fallback: number | undefined, min: number, max: number): number | undefined {
  const raw = process.env[name]
  const parsed = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

const USAGE = 'usage: agent-inbox-watch <item-id> <database-path>\n'
  + '       agent-inbox-watch --row <row-id> <action-version> <database-path>\n'
  + '       agent-inbox-watch --messages <session-id> <issued-at> <database-path> [<seen-message-id>...]\n'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const args = process.argv.slice(2)
const options = {
  pollMs: boundedEnv('AGENT_INBOX_WATCH_POLL_MS', 1_000, 50, 60_000),
  // Unset: the wait backs off from the ask's own age (issue #217).
  timeoutMs: boundedEnv('AGENT_INBOX_WATCH_TIMEOUT_MS', undefined, 1_000, 24 * 60 * 60_000),
}

// Issue #477 — wait for a message to this MCP session. Never prints its text.
if (args[0] === '--messages') {
  const [, session, since, dbPath, ...seen] = args
  if (!session || !UUID.test(session) || !since || !Number.isFinite(Date.parse(since)) || !dbPath || !seen.every((id) => UUID.test(id))) {
    process.stderr.write(USAGE)
    process.exit(64)
  }
  const db = openDb(dbPath)
  try {
    const result = await waitForSessionMessage(db, session, { ...options, since, seen })
    if (result === 'message') {
      process.stdout.write('Agent Inbox message ready. Call pending().\n')
    } else if (result === 'timeout') {
      process.stderr.write('Agent Inbox message watch timed out.\n')
      process.exitCode = 124
    } else {
      process.stdout.write(result === 'running'
        ? 'Agent Inbox: a message watch for this session is already running; do not re-run this one.\n'
        : 'Agent Inbox: this session\'s server has ended; do not re-run this message watch.\n')
      process.exitCode = WATCH_STOPPED_EXIT
    }
  } finally {
    db.close()
  }
  process.exit()
}

const rowMode = args[0] === '--row'
const id = args[rowMode ? 1 : 0]
const versionText = args[2]
const actionVersion = rowMode ? Number(versionText) : undefined
const dbPath = args[rowMode ? 3 : 1]
if (
  args.length !== (rowMode ? 4 : 2) || !id || !dbPath
  || (rowMode && (!/^[1-9]\d*$/.test(versionText ?? '') || !Number.isSafeInteger(actionVersion)))
) {
  process.stderr.write(USAGE)
  process.exit(64)
}

const db = openDb(dbPath)
try {
  const result = actionVersion === undefined
    ? await waitForQuestionResponse(db, id, options)
    : await waitForBoardResponse(db, id, actionVersion, options)
  if (result === 'reply') {
    process.stdout.write('Agent Inbox reply ready. Call pending().\n')
  } else if (result === 'closed') {
    process.stdout.write(rowMode ? 'Agent Inbox row action closed.\n' : 'Agent Inbox question closed.\n')
  } else if (result === 'stopped') {
    process.stdout.write('Agent Inbox: the human asked you to stop waiting; do not re-arm. Their answer will arrive via pending().\n')
    process.exitCode = WATCH_STOPPED_EXIT
  } else {
    process.stderr.write('Agent Inbox watcher timed out.\n')
    process.exitCode = 124
  }
} finally {
  db.close()
}
