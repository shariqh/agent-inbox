// Issue #412 step 3, PR 2: the viewer routes Electron main uses to control a
// launch, as it already answers native notifications. None starts anything,
// takes a path, argv or env, or approves anything by itself: a same-origin page
// can stop a session (the human's own capability) but cannot forge an approval,
// which counts only with main's signature, checked by the driver.
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import {
  claimDriverSlot, createLaunch, fileLaunchAsk, getItem, getLaunch, insertItem, listLaunchAskReplies, openDb, parkLaunch,
  recordLaunchProgress,
} from '../src/store.js'
import type { NewLaunch } from '../src/store.js'
import { createViewer } from '../src/viewer.js'
import { startLocalViewer } from '../src/viewer-network.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

const ID = (n: number) => `11111111-2222-4333-8444-${String(n).padStart(12, '0')}`
const SIG = 'a'.repeat(64)
let db: Database.Database
let app: ReturnType<typeof createViewer>

const launch = (n: number, over: Partial<NewLaunch> = {}): NewLaunch => ({
  id: ID(n), host: 'copilot', project: 'alpha', stream: 'main', cwd: '/work/alpha', mode: 'ask', budgetActiveMs: 60_000,
  budgetToolCalls: 5, prompt: 'Fix it.', specVersion: 1, driverPid: 4000 + n, ...over,
})

function ask(launchId: string): string {
  return fileLaunchAsk(db, launchId, {
    project: '@sessions', stream: 'alpha · main', agent: 'copilot', kind: 'question', title: 'Allow?', action_owner: 'approval',
    options: [{ label: 'Allow once' }, { label: 'Deny' }],
  }, [{ optionId: 'allow_once', label: 'Allow once' }, { optionId: 'reject_once', label: 'Deny' }]).itemId
}

async function call(method: 'GET' | 'POST', path: string, body?: unknown) {
  const response = await app.request(path, {
    method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  return { status: response.status, json: await response.json() as Record<string, unknown> }
}

beforeEach(() => {
  db = openDb(join(scratchDir('launch-routes-'), 'inbox.db'))
  app = createViewer(db)
})

afterEach(() => {
  if (db.open) db.close()
  removeScratchDirs()
})

describe('the launch control routes (#412 step 3)', () => {
  it('folders: the repository folders items and plans recorded, newest project name first, never a reserved project', async () => {
    insertItem(db, { project: 'alpha', stream: '', agent: 'a', kind: 'note', title: 'x', repo_root: '/work/alpha' })
    insertItem(db, { project: 'beta', stream: '', agent: 'a', kind: 'note', title: 'y', repo_root: '/work/beta' })
    insertItem(db, { project: '@sessions', stream: '', agent: 'a', kind: 'note', title: 'z', repo_root: '/work/sessions' })
    insertItem(db, { project: 'gamma', stream: '', agent: 'a', kind: 'note', title: 'no folder' })
    const folders = await app.request('/api/launch-folders')
    expect(folders.headers.get('cache-control')).toBe('no-store')
    expect((await folders.json() as Array<{ root: string }>).map((f) => f.root).sort()).toEqual(['/work/alpha', '/work/beta'])
  })

  it('stop: asks a running launch’s driver to stop and ends a parked one, idempotently; anything else is ok:false', async () => {
    createLaunch(db, launch(1))
    createLaunch(db, launch(2))
    parkLaunch(db, ID(2), { acpSession: 'acp', activeMs: 0, toolCalls: 0 })
    expect(await call('POST', `/api/launches/${ID(1)}/stop`)).toEqual({ status: 200, json: { ok: true, status: 'stopping' } })
    expect(await call('POST', `/api/launches/${ID(1)}/stop`)).toEqual({ status: 200, json: { ok: true, status: 'stopping' } })
    expect(await call('POST', `/api/launches/${ID(2)}/stop`)).toEqual({ status: 200, json: { ok: true, status: 'ended' } })
    expect((await call('POST', `/api/launches/${ID(9)}/stop`)).json).toEqual({ ok: false })
    expect((await call('POST', '/api/launches/not-a-launch/stop')).json).toEqual({ ok: false })
  })

  it('close: ends only a running launch whose driver lease is stale, resolving its asks, and hands back the child to kill', async () => {
    createLaunch(db, launch(1))
    recordLaunchProgress(db, ID(1), { childPgid: 900, childStartedAt: 'darwin:Mon Nov  2 12:00:00 2026' })
    const item = ask(ID(1))
    claimDriverSlot(db, { launchId: ID(1), pid: 4001, nonce: 'n' }, 2)
    expect((await call('POST', `/api/launches/${ID(1)}/close`)).json).toEqual({ ok: false, reason: 'driver_alive' })
    expect(getLaunch(db, ID(1))!.status).toBe('running')
    db.prepare(`UPDATE hook_watch_claims SET claimed_at = ?`).run(new Date(Date.now() - 120_000).toISOString())
    expect((await call('POST', `/api/launches/${ID(1)}/close`)).json)
      .toEqual({ ok: true, childPgid: 900, childStartedAt: 'darwin:Mon Nov  2 12:00:00 2026' })
    expect(getLaunch(db, ID(1))).toMatchObject({ status: 'ended', end_reason: 'lost' })
    expect(getItem(db, item)).toMatchObject({ status: 'resolved', outcome: 'Session lost: its driver stopped.' })
    expect(listLaunchAskReplies(db, ID(1))).toEqual([])
    expect((await call('POST', `/api/launches/${ID(1)}/close`)).json).toEqual({ ok: false, reason: 'not_running' })
    expect((await call('POST', `/api/launches/${ID(9)}/close`)).json).toEqual({ ok: false, reason: 'unknown' })
  })

  it('an ask: what main signs over, then only a well-formed signed answer for an offered option at the shown revision', async () => {
    createLaunch(db, launch(1))
    const item = ask(ID(1))
    expect(await call('GET', `/api/launch-asks/${item}`)).toEqual({
      status: 200,
      json: {
        item_id: item, launch_id: ID(1), filed_revision: 0, response_revision: 0,
        options: [{ optionId: 'allow_once', label: 'Allow once' }, { optionId: 'reject_once', label: 'Deny' }],
      },
    })
    for (const body of [
      {}, { revision: 0, optionId: 'allow_once' }, { revision: 0, optionId: 'allow_once', signature: SIG.toUpperCase() },
      { revision: 0, optionId: 'allow_once', signature: SIG.slice(1) }, { revision: -1, optionId: 'allow_once', signature: SIG },
      { revision: 0, optionId: '../x', signature: SIG }, { revision: 0, optionId: 'allow_once', signature: SIG, path: '/bin/sh' },
      { revision: '0', optionId: 'allow_once', signature: SIG },
    ]) {
      expect((await call('POST', `/api/launch-asks/${item}/answer`, body)).status, JSON.stringify(body)).toBe(400)
    }
    expect((await call('POST', `/api/launch-asks/${item}/answer`, { revision: 1, optionId: 'allow_once', signature: SIG })).json)
      .toEqual({ ok: false, reason: 'revision' })
    expect((await call('POST', `/api/launch-asks/${item}/answer`, { revision: 0, optionId: 'allow_always', signature: SIG })).json)
      .toEqual({ ok: false, reason: 'option' })
    expect(getItem(db, item)!.reply).toBeNull()
    expect((await call('POST', `/api/launch-asks/${item}/answer`, { revision: 0, optionId: 'allow_once', signature: SIG })).json).toEqual({ ok: true })
    expect(getItem(db, item)).toMatchObject({ reply: 'allow_once', reply_context: SIG, reply_source: 'inbox', response_revision: 1 })
    // not a launch's ask, or settled: nothing to sign or answer
    const plain = insertItem(db, { project: 'alpha', stream: '', agent: 'a', kind: 'question', title: 'Plain?' })
    expect((await call('GET', `/api/launch-asks/${plain}`)).status).toBe(404)
    expect((await call('POST', `/api/launch-asks/${plain}/answer`, { revision: 0, optionId: 'allow_once', signature: SIG })).json)
      .toEqual({ ok: false, reason: 'unknown' })
  })

  it('refuses every control write without a trusted Origin at the network boundary', async () => {
    createLaunch(db, launch(1))
    const item = ask(ID(1))
    const server = startLocalViewer(createViewer(db), 0)
    if (!server.listening) await once(server, 'listening')
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const send = (path: string, body: unknown = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      expect((await send(`/api/launches/${ID(1)}/stop`)).status).toBe(403)
      expect((await send(`/api/launches/${ID(1)}/close`)).status).toBe(403)
      expect((await send(`/api/launch-asks/${item}/answer`, { revision: 0, optionId: 'allow_once', signature: SIG })).status).toBe(403)
      expect(getLaunch(db, ID(1))).toMatchObject({ status: 'running', stop_requested_at: null })
      expect(getItem(db, item)!.reply).toBeNull()
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
