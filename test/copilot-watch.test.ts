import { describe, expect, it } from 'vitest'
import {
  getItem, insertItem, markReplySeen, openDb, replyItem, resolveItem,
  upsertBoard, getBoard, annotateBoardRow, markRowHandled, markAnnotationDelivered,
  archiveBoard, advanceBoardRow,
} from '../src/store.js'
import { copilotWatchLaunch, waitForQuestionResponse, waitForBoardResponse } from '../src/watch.js'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const AGENT = { project: 'agent-inbox', stream: 'main', agent: 'copilot' } as const

function fresh() {
  return openDb(join(mkdtempSync(join(tmpdir(), 'copilot-watch-')), 'inbox.db'))
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
      on_completion: 'Call pending() immediately, act on the reply, then resolve the question.',
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
  })

  it('the CLI can watch a board row in the explicit database', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'copilot-row-watch-cli-')), 'custom.db')
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
    const dbPath = join(mkdtempSync(join(tmpdir(), 'copilot-watch-invalid-')), 'must-not-exist.db')
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
    const dbPath = join(mkdtempSync(join(tmpdir(), 'copilot-watch-cli-')), 'custom.db')
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
