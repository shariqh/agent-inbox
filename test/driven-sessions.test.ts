// Issue #412, step 2 (hub side): the reserved projects a driver files its
// approval alerts in, and the `driven` presence flag a driver's lease in
// hook_watch_claims turns on. Design:
// docs/superpowers/specs/2026-10-31-driven-sessions-design.md §4.2, §5.1 and §6.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import {
  claimHookWatch, closeProject, closedProjects, getItem, insertItem, isDrivenSession, isReservedProject, listActivity,
  listPending, listPendingRows, listSessionQuestions, listUnansweredBoardRows, openDb, releaseHookWatch, replyItem,
  upsertActivity, upsertBoard,
} from '../src/store.js'
import { createViewer } from '../src/viewer.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

// a driver's lease token: `<launch id>:<driver pid>:<nonce>` (§5.1)
const TOKEN = '11111111-2222-4333-8444-555555555555:4242:n1'

let db: Database.Database

beforeEach(() => {
  db = openDb(join(scratchDir('driven-'), 'inbox.db'))
})

afterEach(() => {
  db.close()
  vi.useRealTimers()
  removeScratchDirs()
})

function presence(session: string, over: { host_pid?: number; server_pid?: number; project?: string } = {}): void {
  upsertActivity(db, {
    session, project: over.project ?? 'agent-inbox', stream: 'main', agent: 'copilot', doing: 'open', idle: true, claim: false,
    receives_messages: true, host_pid: over.host_pid ?? 76681, server_pid: over.server_pid ?? 76734,
  })
}

// A driver's approval alert: a question in `@sessions` carrying the agent's own
// MCP session, so it classifies as waiting (§4.2).
function alert(session: string): string {
  return insertItem(db, {
    project: '@sessions', stream: 'agent-inbox · main', agent: 'copilot', session, kind: 'question',
    title: 'Allow copilot to run `git push origin ai/x`?', action_owner: 'task',
    next_step: 'Answer in the terminal running the driver.',
  })
}

describe('reserved projects (#412 §4.2)', () => {
  it('reserves exactly @sessions and @mesh, not every @ project', () => {
    expect(['@sessions', '@mesh', '@scratch', 'sessions', '@Sessions'].map(isReservedProject))
      .toEqual([true, true, false, false, false])
  })

  it('no project-scoped reader returns an @sessions ask, answered or not, while its real project still reads its own', () => {
    presence('mcp-1')
    const ask = alert('mcp-1')
    replyItem(db, ask, 'allow_once')
    const own = insertItem(db, { project: 'agent-inbox', stream: 'main', agent: 'copilot', session: 'mcp-1', kind: 'question', title: 'Ship it?' })
    upsertBoard(db, {
      project: '@sessions', stream: '', agent: 'copilot', title: 'Approvals',
      rows: [{ label: 'Push', status: 'blocked', action_owner: 'task', note: 'Waiting on the human.', next_step: 'Answer in the terminal.' }],
    })
    for (const project of ['@sessions', '@mesh']) {
      expect(listPending(db, project, { includeInformational: true })).toEqual([])
      expect(listPending(db, project, { itemId: ask })).toEqual([])
      expect(listPendingRows(db, project)).toEqual([])
      expect(listUnansweredBoardRows(db, project)).toEqual([])
    }
    // the hook's read of its linked servers' questions skips the alert too
    expect(listSessionQuestions(db, ['mcp-1']).map((q) => q.id)).toEqual([own])
    expect(listPending(db, 'agent-inbox').map((q) => q.id)).toEqual([own])
    // the human still sees it: the item is stored and open
    expect(getItem(db, ask)).toMatchObject({ project: '@sessions', status: 'open', session: 'mcp-1' })
  })

  it('refuses to close a reserved project, so approvals cannot be muted; the viewer route says so with a 200', async () => {
    expect(closeProject(db, '@sessions')).toBe(false)
    expect(closeProject(db, '@mesh')).toBe(false)
    expect(closeProject(db, 'agent-inbox')).toBe(true)
    expect(closedProjects(db)).toEqual(['agent-inbox'])
    const viewer = createViewer(db)
    const post = (project: string) => viewer.request('/api/projects/close', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project }),
    })
    const refused = await post('@sessions')
    expect(refused.status).toBe(200)
    expect(await refused.json()).toEqual({ ok: false, reason: 'reserved_project' })
    expect(await (await post('@scratch')).json()).toEqual({ ok: true })
    expect(closedProjects(db).sort()).toEqual(['@scratch', 'agent-inbox'])
  })
})

describe('driven sessions (#412 §5.1, §6)', () => {
  it('serves `driven` and isDrivenSession only while a driver’s lease on the session is under 90 s old', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse('2026-10-31T12:00:00.000Z'))
    presence('mcp-1')
    presence('mcp-2')
    // a Claude hook's watch lease on the same host is not a driver's
    claimHookWatch(db, 'host:76681', 'm1:1-watch')
    claimHookWatch(db, 'driven:mcp-1', TOKEN)
    const driven = () => listActivity(db).filter((row) => row.driven).map((row) => row.session)
    expect(driven()).toEqual(['mcp-1'])
    expect([isDrivenSession(db, 'mcp-1'), isDrivenSession(db, 'mcp-2')]).toEqual([true, false])
    vi.setSystemTime(Date.parse('2026-10-31T12:01:29.000Z'))
    expect(driven()).toEqual(['mcp-1'])
    vi.setSystemTime(Date.parse('2026-10-31T12:01:31.000Z'))
    expect(driven()).toEqual([])
    expect(isDrivenSession(db, 'mcp-1')).toBe(false)
    // a refresh brings it back; a release ends it at once
    claimHookWatch(db, 'driven:mcp-1', TOKEN)
    expect(driven()).toEqual(['mcp-1'])
    releaseHookWatch(db, 'driven:mcp-1', TOKEN)
    expect(driven()).toEqual([])
    expect(listActivity(db).every((row) => !('driven' in row))).toBe(true)
  })
})
