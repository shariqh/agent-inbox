import { describe, expect, it } from 'vitest'
import { getItem, insertItem, markReplySeen, openDb, replyItem, resolveItem } from '../src/store.js'
import { copilotWatchLaunch, waitForQuestionResponse } from '../src/watch.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const AGENT = { project: 'agent-inbox', stream: 'main', agent: 'copilot' } as const

function fresh() {
  return openDb(join(mkdtempSync(join(tmpdir(), 'copilot-watch-')), 'inbox.db'))
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
