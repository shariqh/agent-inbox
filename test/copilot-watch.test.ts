import { describe, expect, it, vi } from 'vitest'
import {
  getItem, insertItem, markReplySeen, openDb, replyItem, resolveItem,
  upsertBoard, getBoard, annotateBoardRow, markRowHandled, markAnnotationDelivered,
  archiveBoard, advanceBoardRow, snoozeBoardRow, snoozeItem, stopBoardRowWatch, stopItemWatch,
} from '../src/store.js'
import {
  boardResponseState, copilotWatchLaunch, waitForQuestionResponse, waitForBoardResponse, watchTimeoutMs,
} from '../src/watch.js'
import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { EventEmitter } from 'node:events'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildMcpServer } from '../src/mcp.js'
import { scratchDir } from './scratch.js'

const AGENT = { project: 'agent-inbox', stream: 'main', agent: 'copilot' } as const

function fresh() {
  return openDb(join(scratchDir('copilot-watch-'), 'inbox.db'))
}

function waitingRow(db: ReturnType<typeof openDb>, label = 'Upload') {
  const before = getBoard(db, AGENT.project, 'Release')
  upsertBoard(db, {
    ...AGENT, title: 'Release', expectedVersion: before?.revision,
    rows: [
      ...(before?.rows.map(({ label, status, revision }) => ({ label, status, revision })) ?? []),
      { label, status: 'blocked', action_owner: 'task' },
    ],
  })
  return getBoard(db, AGENT.project, 'Release')!.rows.find((row) => row.label === label)!
}

describe('waitForQuestionResponse', () => {
  it('returns reply for the exact item when its Inbox answer lands', async () => {
    const db = fresh()
    const id = insertItem(db, { ...AGENT, kind: 'question', title: 'which?' })
    const waiting = waitForQuestionResponse(db, id, { pollMs: 10, timeoutMs: 1_000 })
    setTimeout(() => replyItem(db, id, 'the second one'), 30)
    await expect(waiting).resolves.toBe('reply')
    db.close()
  })

  it('does not wake for a different answered question', async () => {
    const db = fresh()
    const target = insertItem(db, { ...AGENT, kind: 'question', title: 'target' })
    const other = insertItem(db, { ...AGENT, kind: 'question', title: 'other' })
    const waiting = waitForQuestionResponse(db, target, { pollMs: 10, timeoutMs: 1_000 })
    setTimeout(() => replyItem(db, other, 'not for you'), 20)
    setTimeout(() => resolveItem(db, target), 60)
    await expect(waiting).resolves.toBe('closed')
    db.close()
  })

  it('still wakes after a sibling process stamped the reply as seen', async () => {
    const db = fresh()
    const id = insertItem(db, { ...AGENT, kind: 'question', title: 'which?' })
    replyItem(db, id, 'the second one')
    const item = getItem(db, id)!
    markReplySeen(db, id, item.replied_at)
    await expect(waitForQuestionResponse(db, id, { pollMs: 10, timeoutMs: 100 })).resolves.toBe('reply')
    db.close()
  })

  it('returns closed when the target is resolved or missing', async () => {
    const db = fresh()
    const id = insertItem(db, { ...AGENT, kind: 'question', title: 'which?' })
    resolveItem(db, id)
    await expect(waitForQuestionResponse(db, id, { pollMs: 10, timeoutMs: 100 })).resolves.toBe('closed')
    await expect(waitForQuestionResponse(db, 'missing', { pollMs: 10, timeoutMs: 100 })).resolves.toBe('closed')
    db.close()
  })

  it('times out without claiming an answer arrived', async () => {
    const db = fresh()
    const id = insertItem(db, { ...AGENT, kind: 'question', title: 'which?' })
    await expect(waitForQuestionResponse(db, id, { pollMs: 10, timeoutMs: 30 })).resolves.toBe('timeout')
    db.close()
  })
})

describe('waitForBoardResponse', () => {
  it.each(['annotation', 'handled'] as const)('wakes for the exact row %s, without stamping pickup', async (response) => {
    const db = fresh()
    const row = waitingRow(db)
    const waiting = waitForBoardResponse(db, row.id, row.action_version, { pollMs: 10, timeoutMs: 1_000 })
    const timer = setTimeout(() => {
      if (response === 'annotation') annotateBoardRow(db, row.id, 'Continue')
      else markRowHandled(db, row.id)
    }, 20)
    await expect(waiting).resolves.toBe('reply')
    clearTimeout(timer)
    const answered = getBoard(db, AGENT.project, 'Release')!.rows[0]!
    expect(answered.annotation_seen_at).toBeNull()
    expect(answered.handled_seen_at).toBeNull()
    db.close()
  })

  it('does not wake for another row', async () => {
    const db = fresh()
    const target = waitingRow(db)
    const other = waitingRow(db, 'Choose date')
    annotateBoardRow(db, other.id, 'Tomorrow')
    await expect(waitForBoardResponse(db, target.id, target.action_version, { pollMs: 5, timeoutMs: 20 }))
      .resolves.toBe('timeout')
    db.close()
  })

  it('still wakes after a sibling has received the answer', async () => {
    const db = fresh()
    const row = waitingRow(db)
    annotateBoardRow(db, row.id, 'Continue')
    const answered = getBoard(db, AGENT.project, 'Release')!.rows[0]!
    markAnnotationDelivered(db, row.id, answered.annotated_at, 'sibling')
    await expect(waitForBoardResponse(db, row.id, row.action_version)).resolves.toBe('reply')
    db.close()
  })

  it('does not confuse a later action on the same row with the watched request', async () => {
    const db = fresh()
    const row = waitingRow(db)
    const board = getBoard(db, AGENT.project, 'Release')!
    advanceBoardRow(db, {
      project: AGENT.project, title: board.title, label: row.label,
      expectedBoardVersion: board.revision, expectedRevision: row.revision,
      note: 'A new release is ready.', next_step: 'Upload the next build.', action_owner: 'task', impact: 'Makes it available.',
    })
    annotateBoardRow(db, row.id, 'Answer to the next action')
    await expect(waitForBoardResponse(db, row.id, row.action_version)).resolves.toBe('closed')
    db.close()
  })

  it('stands down when the board is archived or the row is absent', async () => {
    const db = fresh()
    const row = waitingRow(db)
    const board = getBoard(db, AGENT.project, 'Release')!
    archiveBoard(db, board.id, board.revision)
    await expect(waitForBoardResponse(db, row.id, row.action_version)).resolves.toBe('closed')
    await expect(waitForBoardResponse(db, 'missing', 1)).resolves.toBe('closed')
    db.close()
  })
})

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const WATCH_CLI = fileURLToPath(new URL('../src/watch-cli.ts', import.meta.url))
const STOPPED = 'Agent Inbox: the human asked you to stop waiting; do not re-arm. Their answer will arrive via pending().\n'

// The real CLI through Node's own tsx loader, so `during` runs while it waits.
async function runWatchCli(args: string[], env: Record<string, string>, during?: () => void) {
  const started = Date.now()
  const child = spawn(process.execPath, ['--import', 'tsx', WATCH_CLI, ...args], {
    env: { ...process.env, AGENT_INBOX_WATCH_POLL_MS: '50', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  during?.()
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  return { code, stdout, stderr, elapsedMs: Date.now() - started }
}

// Issue #217 — a timeout is not an answer, so every timeout costs the agent a
// full model turn just to re-arm. The wait now grows with the ask's own age,
// and the human can stop it or ask it to wait quietly until a time.
describe('answer-watcher backoff (#217)', () => {
  it('doubles from 30 minutes on each re-arm of an unchanged ask, capped at 4 hours', () => {
    const start = '2026-10-19T12:00:00.000Z'
    const waits: number[] = []
    let waited = 0
    for (let rearm = 0; rearm < 6; rearm++) {
      const wait = watchTimeoutMs(start, Date.parse(start) + waited)
      waits.push(wait / MINUTE)
      waited += wait
    }
    expect(waits).toEqual([30, 60, 120, 240, 240, 240])
  })

  it('starts a fresh, unknown, future-dated or sub-minute-old ask at 30 minutes', () => {
    const now = Date.parse('2026-10-19T12:00:00.000Z')
    expect(watchTimeoutMs(undefined, now)).toBe(30 * MINUTE)
    expect(watchTimeoutMs('not a date', now)).toBe(30 * MINUTE)
    expect(watchTimeoutMs(new Date(now + HOUR).toISOString(), now)).toBe(30 * MINUTE)
    expect(watchTimeoutMs(new Date(now - MINUTE + 1).toISOString(), now)).toBe(30 * MINUTE)
  })

  it('a watcher with no forced timeout waits as long as its ask has already waited, plus 30 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.parse('2026-10-19T12:00:00.000Z')
    vi.setSystemTime(start)
    const db = fresh()
    try {
      const id = insertItem(db, { ...AGENT, kind: 'question', title: 'which?' })
      vi.setSystemTime(start + 2 * HOUR)
      let settled: string | undefined
      const waiting = waitForQuestionResponse(db, id, { pollMs: 5 }).then((result) => (settled = result))
      vi.setSystemTime(start + 4 * HOUR + 29 * MINUTE)
      await sleep(40)
      expect(settled).toBeUndefined()
      vi.setSystemTime(start + 4 * HOUR + 30 * MINUTE)
      await expect(waiting).resolves.toBe('timeout')
    } finally {
      db.close()
      vi.useRealTimers()
    }
  })
})

describe('the human stops a watcher (#217)', () => {
  it('ends a question watcher at once, including one already waiting, while an answer still wins', async () => {
    const db = fresh()
    const id = insertItem(db, { ...AGENT, kind: 'question', title: 'which?' })
    const waiting = waitForQuestionResponse(db, id, { pollMs: 10, timeoutMs: 5_000 })
    setTimeout(() => stopItemWatch(db, id, null), 30)
    await expect(waiting).resolves.toBe('stopped')
    await expect(waitForQuestionResponse(db, id, { pollMs: 10, timeoutMs: 5_000 })).resolves.toBe('stopped')
    replyItem(db, id, 'the second one')
    await expect(waitForQuestionResponse(db, id, { pollMs: 10, timeoutMs: 5_000 })).resolves.toBe('reply')
    db.close()
  })

  it.each(['stop until', 'snooze'] as const)('waits quietly past its own timeout through a %s, and an answer still ends it', async (kind) => {
    const db = fresh()
    const defer = (id: string, until: string) => kind === 'snooze' ? snoozeItem(db, id, until) : stopItemWatch(db, id, until)
    const quiet = insertItem(db, { ...AGENT, kind: 'question', title: 'quiet' })
    const until = new Date(Date.now() + 300).toISOString()
    expect(defer(quiet, until)).toBe(true)
    await expect(waitForQuestionResponse(db, quiet, { pollMs: 10, timeoutMs: 20 })).resolves.toBe('timeout')
    expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(until))

    const answered = insertItem(db, { ...AGENT, kind: 'question', title: 'answered' })
    expect(defer(answered, new Date(Date.now() + HOUR).toISOString())).toBe(true)
    const started = Date.now()
    const waiting = waitForQuestionResponse(db, answered, { pollMs: 10, timeoutMs: 20 })
    setTimeout(() => replyItem(db, answered, 'done'), 80)
    await expect(waiting).resolves.toBe('reply')
    expect(Date.now() - started).toBeLessThan(5_000)
    db.close()
  })

  it('ends only the stopped row action; the next ask on the row watches again, and the Claude hook still waits', async () => {
    const db = fresh()
    const row = waitingRow(db)
    let board = getBoard(db, AGENT.project, 'Release')!
    expect(stopBoardRowWatch(db, row.id, null, row.revision, board.revision)).toBe(true)
    await expect(waitForBoardResponse(db, row.id, row.action_version, { pollMs: 5, timeoutMs: 1_000 })).resolves.toBe('stopped')
    // The hook's watch never wakes on a timeout, so it has nothing to stop: it
    // keeps the ask open and an answer still wakes Claude.
    expect(boardResponseState(db, row.id, row.action_version)).toBeUndefined()

    board = getBoard(db, AGENT.project, 'Release')!
    advanceBoardRow(db, {
      project: AGENT.project, title: board.title, label: row.label,
      expectedBoardVersion: board.revision, expectedRevision: board.rows[0]!.revision,
      note: 'A new release is ready.', next_step: 'Upload the next build.', action_owner: 'task', impact: 'Makes it available.',
    })
    await expect(waitForBoardResponse(db, row.id, row.action_version + 1, { pollMs: 5, timeoutMs: 20 })).resolves.toBe('timeout')

    board = getBoard(db, AGENT.project, 'Release')!
    const next = board.rows[0]!
    const until = new Date(Date.now() + 300).toISOString()
    expect(snoozeBoardRow(db, next.id, until, next.revision, board.revision)).toBe(true)
    await expect(waitForBoardResponse(db, next.id, next.action_version, { pollMs: 10, timeoutMs: 20 })).resolves.toBe('timeout')
    expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(until))
    db.close()
  })

  // A "back in a while" promise is kept from when the human made it: a running
  // watcher's day-long ceiling counts from that choice, not from its launch.
  it('honours a "back tomorrow" chosen hours after launch, while a long snooze still rechecks a day after launch', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.parse('2026-10-19T12:00:00.000Z')
    vi.setSystemTime(start)
    const db = fresh()
    try {
      const back = insertItem(db, { ...AGENT, kind: 'question', title: 'back tomorrow' })
      const snoozed = insertItem(db, { ...AGENT, kind: 'question', title: 'snoozed a week' })
      let backResult: string | undefined
      let snoozeResult: string | undefined
      const backWaiting = waitForQuestionResponse(db, back, { pollMs: 5, timeoutMs: 4 * HOUR }).then((result) => (backResult = result))
      void waitForQuestionResponse(db, snoozed, { pollMs: 5, timeoutMs: 4 * HOUR }).then((result) => (snoozeResult = result))
      await sleep(20)
      vi.setSystemTime(start + 3 * HOUR)
      expect(stopItemWatch(db, back, new Date(start + 27 * HOUR).toISOString())).toBe(true)
      expect(snoozeItem(db, snoozed, new Date(start + 7 * 24 * HOUR).toISOString())).toBe(true)
      vi.setSystemTime(start + 24 * HOUR + MINUTE)
      await sleep(40)
      expect(backResult).toBeUndefined()
      expect(snoozeResult).toBe('timeout')
      vi.setSystemTime(start + 27 * HOUR)
      await expect(backWaiting).resolves.toBe('timeout')
    } finally {
      db.close()
      vi.useRealTimers()
    }
  })

  // The upgrade window: an older server's re-block or board_advance knows
  // nothing of the stop, and must not hand the next action a stop the human
  // never chose. This is origin/main's beginNewRowAction statement.
  it('the next action an older server starts is watched again, not stopped', async () => {
    const dbPath = join(scratchDir('copilot-watch-older-'), 'custom.db')
    const db = openDb(dbPath)
    const row = waitingRow(db)
    const board = getBoard(db, AGENT.project, 'Release')!
    expect(stopBoardRowWatch(db, row.id, null, row.revision, board.revision)).toBe(true)
    const older = new Database(dbPath)
    const now = new Date().toISOString()
    older.prepare(`UPDATE board_rows
                      SET note = '', next_step = '', action_owner = NULL, impact = '', next_after = '', options = NULL,
                          annotation = NULL, annotation_kind = NULL, annotated_at = NULL, annotation_seen_at = NULL,
                          annotation_seen_by = NULL, handled_at = NULL, handled_seen_at = NULL, handled_seen_by = NULL,
                          snoozed_until = NULL, outcome = '', outcome_at = NULL, action_started_at = ?, action_version = ?,
                          revision = revision + 1, history = ?, updated_at = ?
                    WHERE id = ?`).run(now, row.action_version + 1, '[]', now, row.id)
    older.close()
    expect(await runWatchCli(['--row', row.id, String(row.action_version + 1), dbPath], { AGENT_INBOX_WATCH_TIMEOUT_MS: '1000' }))
      .toMatchObject({ code: 124, stdout: '', stderr: 'Agent Inbox watcher timed out.\n' })
    db.close()
  }, 20_000)

  it('the CLI exits 3 with a do-not-re-arm line for a stopped ask, and keeps the timeout exit', async () => {
    const dbPath = join(scratchDir('copilot-watch-stop-'), 'custom.db')
    const db = openDb(dbPath)
    const stopped = insertItem(db, { ...AGENT, kind: 'question', title: 'stopped' })
    stopItemWatch(db, stopped, null)
    expect(await runWatchCli([stopped, dbPath], {})).toMatchObject({ code: 3, stdout: STOPPED, stderr: '' })

    const row = waitingRow(db)
    const board = getBoard(db, AGENT.project, 'Release')!
    stopBoardRowWatch(db, row.id, null, row.revision, board.revision)
    expect(await runWatchCli(['--row', row.id, String(row.action_version), dbPath], {}))
      .toMatchObject({ code: 3, stdout: STOPPED, stderr: '' })

    const waiting = insertItem(db, { ...AGENT, kind: 'question', title: 'waiting' })
    expect(await runWatchCli([waiting, dbPath], { AGENT_INBOX_WATCH_TIMEOUT_MS: '1000' }))
      .toMatchObject({ code: 124, stdout: '', stderr: 'Agent Inbox watcher timed out.\n' })
    db.close()
  }, 20_000)

  it('the CLI outlives its own timeout through a "back in a while" and exits promptly on the answer', async () => {
    const dbPath = join(scratchDir('copilot-watch-defer-'), 'custom.db')
    const db = openDb(dbPath)
    const id = insertItem(db, { ...AGENT, kind: 'question', title: 'deferred' })
    stopItemWatch(db, id, new Date(Date.now() + 20_000).toISOString())
    const result = await runWatchCli([id, dbPath], { AGENT_INBOX_WATCH_TIMEOUT_MS: '1000' }, () => {
      setTimeout(() => replyItem(db, id, 'back now'), 3_000)
    })
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('Call pending()')
    expect(result.elapsedMs).toBeGreaterThanOrEqual(3_000)
    expect(result.elapsedMs).toBeLessThan(10_000)
    db.close()
  }, 20_000)
})

describe('copilotWatchLaunch', () => {
  it('returns a detached-background launch contract with shell-safe paths', () => {
    expect(copilotWatchLaunch('item-1', {
      execPath: "/Node 24/bin/node's",
      execArgv: [],
      moduleUrl: 'file:///repo%20path/dist/watch.js',
      dbPath: '/custom db/inbox.db',
    })).toEqual({
      shell_command: `'/Node 24/bin/node'\\''s' '/repo path/dist/watch-cli.js' 'item-1' '/custom db/inbox.db'`,
      mode: 'async',
      detach: true,
      shell_id: 'agent-inbox-item-1',
      timeout_seconds: 1800,
      on_completion: 'Call pending() immediately, act on the reply, then resolve the question. '
        + 'A timeout (exit 124) is not an answer: if still waiting, re-run this same command; it waits longer each time. '
        + 'Exit 3 means the human asked you to stop waiting: do not re-arm; their answer still arrives through pending() or chat.',
    })
  })

  it('includes the exact board action and response project in a row launch contract', () => {
    const launch = copilotWatchLaunch('row-1', {
      execPath: '/node', execArgv: [], moduleUrl: 'file:///repo/dist/watch.js',
      dbPath: '/custom db/inbox.db', rowActionVersion: 2, project: 'another-project',
    })
    expect(launch.shell_command).toBe("'/node' '/repo/dist/watch-cli.js' '--row' 'row-1' '2' '/custom db/inbox.db'")
    expect(launch.shell_id).toBe('agent-inbox-row-row-1-2')
    expect(launch.on_completion).toContain('pending({project:"another-project"})')
    expect(launch.on_completion).toContain('outcome')
    expect(launch.on_completion).toContain('re-arm with board_get({title, watch:true}); it waits longer each time')
    expect(launch.on_completion).toContain('Exit 3 means the human asked you to stop waiting: do not re-arm')
  })

  it('the CLI can watch a board row in the explicit database', async () => {
    const dbPath = join(scratchDir('copilot-row-watch-cli-'), 'custom.db')
    const db = openDb(dbPath)
    const row = waitingRow(db)
    markRowHandled(db, row.id)
    const entry = fileURLToPath(new URL('../src/watch-cli.ts', import.meta.url))
    const child = spawn('npx', ['tsx', entry, '--row', row.id, String(row.action_version), dbPath], {
      env: { ...process.env, AGENT_INBOX_WATCH_TIMEOUT_MS: '1000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    expect(code, stderr).toBe(0)
    expect(stdout).toContain('Call pending()')
    expect(getBoard(db, AGENT.project, 'Release')!.rows[0]!.handled_seen_at).toBeNull()
    db.close()
  })

  it.each(['0', '-1', '01', '2x', '9007199254740992'])('the CLI refuses action version %s before opening a database', (version) => {
    const dbPath = join(scratchDir('copilot-watch-invalid-'), 'must-not-exist.db')
    const entry = fileURLToPath(new URL('../src/watch-cli.ts', import.meta.url))
    const result = spawnSync(process.execPath, ['--import', 'tsx', entry, '--row', 'row-1', version, dbPath], {
      encoding: 'utf8', timeout: 5_000,
    })
    expect(result.status, result.stderr).toBe(64)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('usage:')
    expect(existsSync(dbPath)).toBe(false)
  })

  it('the CLI watches the explicit non-default database path', async () => {
    const dbPath = join(scratchDir('copilot-watch-cli-'), 'custom.db')
    const db = openDb(dbPath)
    const id = insertItem(db, { ...AGENT, kind: 'question', title: 'which?' })
    const entry = fileURLToPath(new URL('../src/watch-cli.ts', import.meta.url))
    const child = spawn('npx', ['tsx', entry, id, dbPath], {
      env: {
        ...process.env,
        AGENT_INBOX_DB: join(tmpdir(), 'deliberately-wrong.db'),
        AGENT_INBOX_WATCH_POLL_MS: '10',
        AGENT_INBOX_WATCH_TIMEOUT_MS: '1000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    setTimeout(() => replyItem(db, id, 'the second one'), 50)
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    expect(code, stderr).toBe(0)
    expect(stdout).toContain('Call pending()')
    db.close()
  })
})

// The contract the MCP server hands out sizes the same wait the watcher will
// take, from the ask's age on an injected clock, so a re-arm reports it too.
describe('Copilot watch contracts size their wait (#217)', () => {
  it('re-arms an unchanged row with a longer wait, honours quiet time up to a day, and skips a stopped row', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.parse('2026-10-19T12:00:00.000Z')
    vi.setSystemTime(start)
    const db = fresh()
    const events: EventEmitter = process
    const listeners = new Map((['exit', 'SIGHUP', 'SIGINT', 'SIGTERM'] as const).map((signal) => [signal, events.listeners(signal)]))
    const server = buildMcpServer(db, process.cwd())
    const client = new Client({ name: 'copilot', version: 'test' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args })
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      return JSON.parse((result.content as Array<{ text: string }>)[0]!.text)
    }
    const ask = (label: string) => ({
      label, status: 'blocked', note: 'Human input is required.', next_step: 'Do it.',
      action_owner: 'task', impact: 'Unblocks the release.',
    })
    const waits = async () => ((await call('board_get', { title: 'Release', watch: true })).watches as Array<{ label: string; timeout_seconds: number }>)
      .map((watch) => [watch.label, watch.timeout_seconds])
    try {
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      await call('register', { project: 'backoff' })
      const created = await call('board_upsert', { title: 'Release', rows: [ask('Upload'), ask('Sign')] })
      expect(created.watches.map((watch: { timeout_seconds: number }) => watch.timeout_seconds)).toEqual([1800, 1800])

      vi.setSystemTime(start + 90 * MINUTE)
      expect(await waits()).toEqual([['Upload', 7200], ['Sign', 7200]])
      vi.setSystemTime(start + 10 * HOUR)
      expect(await waits()).toEqual([['Upload', 14400], ['Sign', 14400]])

      const board = getBoard(db, 'backoff', 'Release')!
      const [upload, sign] = board.rows
      expect(stopBoardRowWatch(db, upload!.id, null, upload!.revision, board.revision)).toBe(true)
      expect(snoozeBoardRow(db, sign!.id, new Date(start + 58 * HOUR).toISOString(), sign!.revision, board.revision)).toBe(true)
      expect(await waits()).toEqual([['Sign', 24 * 3600]])

      // A new ask on the stopped row starts fresh, not from the old action's start.
      const current = getBoard(db, 'backoff', 'Release')!
      expect(current.rows.map((row) => row.action_agent)).toEqual(['copilot', 'copilot'])
      const advanced = await call('board_advance', {
        title: 'Release', label: 'Upload', board_version: current.revision, expected_revision: current.rows[0]!.revision,
        note: 'The signed build is ready.', next_step: 'Upload it.', action_owner: 'task', impact: 'Unblocks the release.',
      })
      expect(advanced.watch).toMatchObject({ label: 'Upload', action_version: 2, timeout_seconds: 1800 })
      expect(getBoard(db, 'backoff', 'Release')!.rows[0]).toMatchObject({ action_version: 2, action_agent: 'copilot' })
      expect(await waits()).toEqual([['Upload', 1800], ['Sign', 24 * 3600]])

      const question = await call('flag', {
        kind: 'question', title: 'Which build?', detail: 'Two builds are ready.', next_step: 'Pick one.',
        action_owner: 'decision', impact: 'Picks the release.', options: [{ label: 'A' }, { label: 'B' }],
      })
      expect(question.watch.timeout_seconds).toBe(1800)
      expect(question.watch.on_completion).toContain('re-run this same command; it waits longer each time')
    } finally {
      await client.close()
      await server.close()
      for (const [signal, before] of listeners) {
        for (const listener of events.listeners(signal)) {
          if (!before.includes(listener)) events.removeListener(signal, listener as (...args: unknown[]) => void)
        }
      }
      db.close()
      vi.useRealTimers()
    }
  })
})
