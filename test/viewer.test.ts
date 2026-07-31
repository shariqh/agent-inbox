import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openDb, insertItem, listItems, answerItem, markReplySeen, upsertBoard, listBoards, annotateBoardRow, markHandledDelivered, upsertActivity, closeProject, closedProjects, upsertSourceLink } from '../src/store.js'
import { createViewer } from '../src/viewer.js'

function freshDb(): Database.Database {
  return openDb(join(mkdtempSync(join(tmpdir(), 'view-')), 'inbox.db'))
}

describe('viewer api', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  it('stamps a stable boot id header so stale tabs can self-reload', async () => {
    const app = createViewer(db)
    const a = await app.request('/api/items')
    const b = await app.request('/api/boards')
    expect(a.headers.get('x-inbox-boot')).toBeTruthy()
    expect(a.headers.get('x-inbox-boot')).toBe(b.headers.get('x-inbox-boot')) // stable within one server
    expect(createViewer(db) === app).toBe(false)
  })

  it('GET /api/setup returns agent-registration commands and the reporting snippet', async () => {
    const app = createViewer(db)
    const res = await app.request('/api/setup')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.claudeCommand).toContain('claude mcp add --scope user agent-inbox')
    expect(body.claudeCommand).toContain('dist/mcp-server.js')
    expect(body.copilotConfig).toContain('mcp-server.js')
    expect(body.agentInstallCommand).toContain('npm run install:agents -- --apply')
    expect(body.claudeInstallCommand).toContain('--target claude')
    expect(body.copilotInstallCommand).toContain('--target copilot')
    expect(body.snippet).toContain('flag')          // the reporting snippet text
    expect(body.snippet).toContain('board_upsert')
    // the Setup pane serves docs/reporting-snippet.md verbatim, so the shipped
    // emit contract and the pane cannot drift apart on the dual-channel rule (#29).
    // Pin the tool token only, never the prose around it.
    expect(body.snippet).toContain('answer(')
    expect(body.dbPath).toContain('.agent-inbox')
  })

  it('exposes an Electron ownership capability only when explicitly configured', async () => {
    expect((await createViewer(db).request('/api/owner')).status).toBe(404)
    const res = await createViewer(db, { ownerToken: 'private-ready-token' }).request('/api/owner')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ token: 'private-ready-token' })
  })

  it('GET /api/setup carries a hand-mergeable backstop-hooks block (#10 / #21)', async () => {
    const body = await (await createViewer(db).request('/api/setup')).json()
    expect(typeof body.hooksSettings).toBe('string')
    const parsed = JSON.parse(body.hooksSettings)
    expect(Object.keys(parsed.hooks).sort()).toEqual(
      ['Notification', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'],
    )
    // exec form: no shell tokenisation, so a repo path with a quote or a $ is safe
    expect(parsed.hooks.Notification[0].hooks[0].args[0]).toMatch(/dist\/hook-cli\.js$/)
    expect(parsed.hooks.Notification[0].hooks[0].command.startsWith('/')).toBe(true)
    // no matcher: the CLI's Notification matcher matches notification_type, and
    // AGENT_INBOX_HOOK_NOTIFY_TYPES is the single gate (docs/hooks.md)
    expect(parsed.hooks.Notification[0].matcher).toBeUndefined()
    expect(parsed.hooks.SessionStart[0].matcher).toBe('startup|resume')
    // Stop carries BOTH halves of #21: the synchronous bounce and the watcher
    expect(parsed.hooks.Stop[0].hooks).toHaveLength(2)
    expect(parsed.hooks.Stop[0].hooks.map((h: { args: string[] }) => h.args[1])).toEqual(['stop', 'watch'])
    expect(parsed.hooks.Stop[0].hooks[1].asyncRewake).toBe(true)
    // the panel cannot run selftest, so it must say so rather than imply safety
    expect(body.hooksNote).toContain('install:hooks')
  })

  it('GET /api/activity returns live sessions with children', async () => {
    upsertActivity(db, { session: 's1', project: 'p', stream: 'main', agent: 'claude-code', doing: 'reviewing', children: [{ name: 'kid', doing: 'grep' }] })
    const res = await createViewer(db).request('/api/activity')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(1)
    expect(body[0].doing).toBe('reviewing')
    expect(body[0].children[0].name).toBe('kid')
  })

  it('GET /api/items returns grouped items', async () => {
    insertItem(db, { project: 'p', stream: '', agent: 'claude-code', kind: 'question', title: 'q' })
    const app = createViewer(db)
    const res = await app.request('/api/items')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.needsYou[0].items[0].title).toBe('q')
  })

  it('POST resolve, dismiss, annotate mutate the row', async () => {
    const a = insertItem(db, { project: 'p', stream: '', agent: 'claude-code', kind: 'question', title: 'a' })
    const b = insertItem(db, { project: 'p', stream: '', agent: 'claude-code', kind: 'note', title: 'b' })
    const app = createViewer(db)
    expect((await app.request(`/api/items/${a}/resolve`, { method: 'POST' })).status).toBe(200)
    expect((await app.request(`/api/items/${b}/dismiss`, { method: 'POST' })).status).toBe(200)
    const annRes = await app.request(`/api/items/${a}/annotate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'noted' }),
    })
    expect(annRes.status).toBe(200)
    const rows = listItems(db)
    expect(rows.find((r) => r.id === a)!.status).toBe('resolved')
    expect(rows.find((r) => r.id === a)!.annotation).toBe('noted')
    expect(rows.find((r) => r.id === b)!.status).toBe('dismissed')
  })

  it('POST reply writes the answer + context and resets pickup; options surface in GET', async () => {
    const id = insertItem(db, {
      project: 'p', stream: '', agent: 'claude-code', kind: 'question', title: 'which auth?',
      options: [{ label: 'clerk', recommended: true }, { label: 'auth0', detail: 'more setup' }],
    })
    const app = createViewer(db)
    const got = await (await app.request('/api/items')).json()
    expect(got.needsYou[0].items[0].options).toHaveLength(2)
    markReplySeen(db, id, null) // pretend a stale pickup exists; a new reply must reset it
    const res = await app.request(`/api/items/${id}/reply`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'clerk', context: 'start with the TMCC thread' }),
    })
    expect(res.status).toBe(200)
    const item = listItems(db)[0]!
    expect(item.reply).toBe('clerk')
    expect(item.reply_context).toBe('start with the TMCC thread')
    expect(item.reply_seen_at).toBeNull()
    expect(item.status).toBe('open') // replying is not resolving — the agent still has to act
  })

  // #29: the channel is stamped inside the store, so the viewer needs no code of its
  // own — SELECT * already carries reply_source out through GET /api/items, which is
  // where the card's "via chat" provenance chip reads it from.
  it('the answer channel is stamped by the store and surfaces unchanged through GET /api/items', async () => {
    const viaInbox = insertItem(db, { project: 'p', stream: '', agent: 'claude-code', kind: 'question', title: 'which auth?' })
    const viaChat = insertItem(db, { project: 'p', stream: '', agent: 'claude-code', kind: 'question', title: 'which db?' })
    const app = createViewer(db)
    const res = await app.request(`/api/items/${viaInbox}/reply`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'clerk' }),
    })
    expect(res.status).toBe(200)
    expect(answerItem(db, viaChat, 'sqlite').ok).toBe(true)

    const body = await (await app.request('/api/items')).json()
    const rendered: Record<string, string | null> = {}
    for (const group of body.needsYou) for (const it of group.items) rendered[it.title] = it.reply_source
    expect(rendered['which auth?']).toBe('inbox')
    expect(rendered['which db?']).toBe('agent')
  })

  it('GET /api/items exposes the asking session so the viewer can judge liveness', async () => {
    insertItem(db, { project: 'p', stream: '', agent: 'claude-code', kind: 'question', title: 'q', session: 'sess-1' })
    insertItem(db, { project: 'p', stream: '', agent: 'claude-code', kind: 'note', title: 'n' })
    const body = await (await createViewer(db).request('/api/items')).json()
    expect(body.needsYou[0].items[0].session).toBe('sess-1')
    expect(body.notes[0].items[0].session).toBeNull()
  })
})

// issue #40 — "which build is this" must be answerable in one glance, and a
// packaged bundle must say when the checkout it was built from has moved on.
// These run END TO END: a real setup-info.json over a real temp git repo, through
// the real /api/setup handler, with the real git subprocess doing the comparing.
describe('GET /api/setup carries the build stamp (issue #40)', () => {
  function tmpRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'setup-repo-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 't@t.dev'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir })
    return dir
  }
  function commitIn(dir: string): string {
    execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'x'], { cwd: dir })
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
  }
  function bakedFile(body: unknown): string {
    const p = join(mkdtempSync(join(tmpdir(), 'setup-info-')), 'setup-info.json')
    writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
    return p
  }
  const setup = async (path?: string): Promise<Record<string, never> & { build: { drift: string; commit: string | null; head: string | null; builtAt: string | null; repoRoot: string | null }; note: string; claudeCommand: string }> => {
    const res = await createViewer(freshDb(), path ? { setupInfoPath: path } : {}).request('/api/setup')
    expect(res.status).toBe(200)
    return await res.json()
  }

  it('a checkout reports its own live HEAD and never claims staleness against itself', async () => {
    const body = await setup(join(tmpdir(), 'no-such-setup-info-40.json'))

    expect(body.build.drift).toBe('dev')
    expect(body.build.commit).toBeNull()
    // this repo IS a checkout, so the viewer process can read its HEAD
    expect(body.build.head).toBe(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim())
  })

  it('a packaged bundle reports the commit and time it was built from', async () => {
    const dir = tmpRepo()
    const sha = commitIn(dir)
    const path = bakedFile({ repoRoot: dir, nodeBin: '/opt/node', commit: sha, builtAt: '2026-07-25T12:00:00.000Z' })

    const body = await setup(path)

    expect(body.build).toMatchObject({ drift: 'current', commit: sha, head: sha, builtAt: '2026-07-25T12:00:00.000Z', repoRoot: dir })
    // …and it still serves the registration paths it always did
    expect(body.claudeCommand).toContain('/opt/node')
    expect(body.note).toContain(dir)
  })

  it('says "stale" once the checkout has moved on past the baked commit', async () => {
    const dir = tmpRepo()
    const sha = commitIn(dir)
    const moved = commitIn(dir)

    const body = await setup(bakedFile({ repoRoot: dir, nodeBin: '/opt/node', commit: sha, builtAt: '2026-07-25T12:00:00.000Z' }))

    expect(body.build.drift).toBe('stale')
    expect(body.build.head).toBe(moved)
  })

  it('a corrupt setup-info.json fails open: 200, dev paths, exactly as before #40', async () => {
    // BEFORE #40 this threw straight out of the handler (JSON.parse on an
    // unguarded readFileSync) and took the whole Setup panel with it.
    const body = await setup(bakedFile('{ this is not json'))

    expect(body.note).toBe('')
    expect(body.claudeCommand).toContain('dist/mcp-server.js')
    expect(body.build.drift).toBe('dev')
  })

  it('a bundle packaged before #40 keeps working and simply has nothing to say', async () => {
    const body = await setup(bakedFile({ repoRoot: '/gone/repo', nodeBin: '/opt/node' }))

    expect(body.build).toMatchObject({ drift: 'unknown', commit: null, builtAt: null, head: null })
    expect(body.claudeCommand).toContain('/opt/node')
  })
})

// issue #30 — read-only by design: the 3s frontend poll hits this freely and it
// never triggers a gh fetch. Only the poller in src/viewer-server.ts writes here.
describe('source links api (issue #30)', () => {
  it('GET /api/links returns the cached PR state per (repo, branch)', async () => {
    const db = freshDb()
    upsertSourceLink(db, {
      repo: 'shariqh/agent-inbox', branch: '30-x', pr_number: 41,
      pr_url: 'https://github.com/shariqh/agent-inbox/pull/41', pr_title: 'source + PR links',
      pr_state: 'OPEN', pr_draft: true, review_decision: 'APPROVED', checks: 'passing',
      issue_number: 30, issue_url: 'https://github.com/shariqh/agent-inbox/issues/30',
      tldr: 'links the inbox to its PR',
    })
    const res = await createViewer(db).request('/api/links')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(1)
    expect(body[0].repo).toBe('shariqh/agent-inbox')
    expect(body[0].branch).toBe('30-x')
    expect(body[0].pr_number).toBe(41)
    expect(body[0].pr_state).toBe('OPEN')
    expect(body[0].checks).toBe('passing')
    expect(body[0].tldr).toBe('links the inbox to its PR')
    // a boolean over the wire, never SQLite's 0/1 — the frontend branches on it
    expect(body[0].pr_draft).toBe(true)
  })

  it('is empty and 200 on a fresh db, so the frontend renders exactly as it does today', async () => {
    const res = await createViewer(freshDb()).request('/api/links')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})

describe('boards api', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  it('GET /api/boards returns active boards with rows + progress', async () => {
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'coverage', rows: [
      { label: 'theme', status: 'done', context: 'shipped in dark-mode PR' }, { label: 'stems', status: 'partial' }, { label: 'na-row', status: 'na' },
    ] })
    const res = await createViewer(db).request('/api/boards')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(1)
    expect(body[0].title).toBe('coverage')
    expect(body[0].rows.map((r: { label: string }) => r.label)).toEqual(['theme', 'stems', 'na-row'])
    expect(body[0].rows[0].context).toBe('shipped in dark-mode PR')
    expect(body[0].progress.countable).toBe(2)
    expect(body[0].progress.fraction).toBeCloseTo(0.75) // (1 + 0.5)/2
  })

  it('POST archive removes the board from the active list', async () => {
    const { boardId } = upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'done' }] })
    const app = createViewer(db)
    expect((await app.request(`/api/boards/${boardId}/archive`, { method: 'POST' })).status).toBe(200)
    expect(listBoards(db)).toHaveLength(0)
  })

  it('POST unarchive returns the board to the active list', async () => {
    const { boardId } = upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'done' }] })
    const app = createViewer(db)
    expect((await app.request(`/api/boards/${boardId}/archive`, { method: 'POST' })).status).toBe(200)
    expect((await app.request(`/api/boards/${boardId}/unarchive`, { method: 'POST' })).status).toBe(200)
    expect(listBoards(db)).toHaveLength(1)
    expect(listBoards(db, { status: 'archived' })).toHaveLength(0)
  })

  it('GET /api/boards/archived returns archived boards with rows + progress', async () => {
    const { boardId } = upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'old effort', rows: [{ label: 'x', status: 'done' }] })
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'still active', rows: [{ label: 'y', status: 'tracked' }] })
    const app = createViewer(db)
    await app.request(`/api/boards/${boardId}/archive`, { method: 'POST' })
    const res = await app.request('/api/boards/archived')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(1)
    expect(body[0].title).toBe('old effort')
    expect(body[0].status).toBe('archived')
    expect(body[0].rows[0].label).toBe('x')
    expect(body[0].progress.done).toBe(1)
    // active list is untouched by the archived endpoint
    const active = await (await app.request('/api/boards')).json()
    expect(active).toHaveLength(1)
    expect(active[0].title).toBe('still active')
  })

  it('POST row annotate sets the human note and survives a re-upsert', async () => {
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'missing' }] })
    const board = listBoards(db)[0]!
    const rowId = board.rows[0]!.id
    const app = createViewer(db)
    const res = await app.request(`/api/boards/${board.id}/rows/${rowId}/annotate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'do this next' }),
    })
    expect(res.status).toBe(200)
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'partial' }] })
    expect(listBoards(db)[0]!.rows[0]!.annotation).toBe('do this next')
  })

  // issue #36 — the human's other exit from a blocked row. Every assertion here
  // is about the ROUTE: the store's own rules are pinned in test/store.test.ts.
  describe('POST row handled (#36)', () => {
    function seed(): { boardId: string; rowId: string } {
      upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'Paddle', status: 'blocked' }] })
      const board = listBoards(db)[0]!
      return { boardId: board.id, rowId: board.rows[0]!.id }
    }
    const post = (boardId: string, rowId: string, body?: unknown) =>
      createViewer(db).request(`/api/boards/${boardId}/rows/${rowId}/handled`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })

    it('marks the row and reports ok', async () => {
      const { boardId, rowId } = seed()
      const res = await post(boardId, rowId, { handled: true })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(listBoards(db)[0]!.rows[0]!.handled_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('a body-less POST marks rather than un-marks — the affirmative action is the default', async () => {
      const { boardId, rowId } = seed()
      expect(await (await post(boardId, rowId)).json()).toEqual({ ok: true })
      expect(listBoards(db)[0]!.rows[0]!.handled_at).not.toBeNull()
    })

    it('handled:false takes the mark back off', async () => {
      const { boardId, rowId } = seed()
      await post(boardId, rowId, { handled: true })
      expect(await (await post(boardId, rowId, { handled: false })).json()).toEqual({ ok: true })
      expect(listBoards(db)[0]!.rows[0]!.handled_at).toBeNull()
    })

    it('refuses to un-mark once an agent has been handed it — 200 with ok:false, mark intact', async () => {
      const { boardId, rowId } = seed()
      await post(boardId, rowId, { handled: true })
      markHandledDelivered(db, rowId, listBoards(db)[0]!.rows[0]!.handled_at, 'claude-code')
      const res = await post(boardId, rowId, { handled: false })
      expect(res.status, 'a refusal is not an error — the caller has to read the body').toBe(200)
      expect(await res.json()).toEqual({ ok: false })
      expect(listBoards(db)[0]!.rows[0]!.handled_at).not.toBeNull()
    })

    it('reports ok:false for a row id that does not exist', async () => {
      const { boardId } = seed()
      expect(await (await post(boardId, 'no-such-row', { handled: true })).json()).toEqual({ ok: false })
    })

    it('the mark survives an agent re-upsert that leaves the row blocked', async () => {
      const { boardId, rowId } = seed()
      await post(boardId, rowId, { handled: true })
      upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'Paddle', status: 'blocked', note: 'still waiting' }] })
      expect(listBoards(db)[0]!.rows[0]!.handled_at).not.toBeNull()
    })

    it('GET /api/boards carries the mark and its delivery state to the viewer', async () => {
      const { boardId, rowId } = seed()
      await post(boardId, rowId, { handled: true })
      const before = (await (await createViewer(db).request('/api/boards')).json())[0].rows[0]
      expect(before.handled_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(before.handled_seen_at).toBeNull()
      markHandledDelivered(db, rowId, listBoards(db)[0]!.rows[0]!.handled_at, 'claude-code')
      const after = (await (await createViewer(db).request('/api/boards')).json())[0].rows[0]
      expect(after.handled_seen_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(after.handled_seen_by).toBe('claude-code')
    })
  })

  it('GET /api/boards exposes annotation_unseen and does not mark the board read', async () => {
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'missing' }] })
    annotateBoardRow(db, listBoards(db)[0]!.rows[0]!.id, 'new note')
    const app = createViewer(db)
    const first = await (await app.request('/api/boards')).json()
    expect(first[0].rows[0].annotation_unseen).toBe(true)
    const second = await (await app.request('/api/boards')).json() // human watching ≠ agent reading
    expect(second[0].rows[0].annotation_unseen).toBe(true)
  })
})

// ── issue #32: close / reopen a project ──────────────────────────────────────
// The HTTP surface both consumers read: public/app.js (title badge, rail) and
// electron/main.cjs (dock badge). Tenet 3 — one attention set — is why closure
// has to be server state at all: the main process cannot read the renderer's
// localStorage, so a client-side close would make the two badges disagree.
describe('project close/reopen api (issue #32)', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  const post = (app: ReturnType<typeof createViewer>, path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  it('POST /api/projects/close closes it and GET /api/projects/closed lists it', async () => {
    const app = createViewer(db)
    insertItem(db, { project: 'dead', stream: '', agent: 'a', kind: 'question', title: 'q' })
    const res = await post(app, '/api/projects/close', { project: 'dead' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(await (await app.request('/api/projects/closed')).json()).toEqual(['dead'])
  })

  it('POST /api/projects/reopen removes it from the closed list', async () => {
    const app = createViewer(db)
    closeProject(db, 'dead')
    const res = await post(app, '/api/projects/reopen', { project: 'dead' })
    expect(res.status).toBe(200)
    expect(await (await app.request('/api/projects/closed')).json()).toEqual([])
  })

  it('GET /api/projects/closed omits a project an agent flagged into after it was closed', async () => {
    const app = createViewer(db)
    closeProject(db, 'dead')
    await new Promise((r) => setTimeout(r, 5))
    insertItem(db, { project: 'dead', stream: '', agent: 'a', kind: 'question', title: 'back from the dead' })
    expect(await (await app.request('/api/projects/closed')).json()).toEqual([])
  })

  it('accepts a project name containing a slash — names are agent-authored, hence a body not a path param', async () => {
    const app = createViewer(db)
    const res = await post(app, '/api/projects/close', { project: 'org/repo name' })
    expect(res.status).toBe(200)
    expect(await (await app.request('/api/projects/closed')).json()).toEqual(['org/repo name'])
  })

  it('rejects a blank or missing project name with 400, so app.js surfaces it instead of swallowing it', async () => {
    const app = createViewer(db)
    for (const body of [{ project: '   ' }, { project: '' }, {}, { project: 42 }]) {
      const res = await post(app, '/api/projects/close', body)
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect(closedProjects(db)).toEqual([])
    const reopen = await post(app, '/api/projects/reopen', {})
    expect(reopen.status).toBe(400)
  })

  it('rejects an unparseable body with 400 rather than throwing a 500', async () => {
    const app = createViewer(db)
    const res = await app.request('/api/projects/close', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json',
    })
    expect(res.status).toBe(400)
  })

  it('closing is presentation only — the /api/items and /api/boards payloads are byte-identical', async () => {
    const app = createViewer(db)
    insertItem(db, { project: 'dead', stream: '', agent: 'a', kind: 'question', title: 'q' })
    upsertBoard(db, { project: 'dead', stream: '', agent: 'a', title: 'b', rows: [{ label: 'x', status: 'blocked' }] })
    const itemsBefore = await (await app.request('/api/items')).json()
    const boardsBefore = await (await app.request('/api/boards')).json()
    await post(app, '/api/projects/close', { project: 'dead' })
    expect(await (await app.request('/api/items')).json()).toEqual(itemsBefore)
    expect(await (await app.request('/api/boards')).json()).toEqual(boardsBefore)
  })
})

// ── issue #42, constraint B: the viewer is untouched ─────────────────────────
// #42 trims agent-authored `context` out of the MCP READ payloads, because it is
// written for the human and the agent that wrote it pays to read it back. The
// human's surface is the one place that text is FOR: /api/boards and /api/items
// must keep carrying it verbatim, and the viewer must not route through
// src/shape.ts at all. Two pins — the payload, and the wiring that produces it.
describe('the human’s payloads never route through the agent-side shaping (#42)', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  it('GET /api/boards still carries full row context — and no context_chars', async () => {
    const long = 'the backstory the human reads in the collapsed dropdown. '.repeat(10)
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'blocked', note: 'n', context: long }] })
    annotateBoardRow(db, listBoards(db)[0]!.rows[0]!.id, 'human note')
    const body = await (await createViewer(db).request('/api/boards')).json()
    expect(body[0].rows[0].context).toBe(long)
    expect(body[0].rows[0]).not.toHaveProperty('context_chars')
    expect(body[0].rows[0].annotation).toBe('human note')
    // byte-identical to what the store returns: the route is a passthrough
    expect(body).toEqual(JSON.parse(JSON.stringify(listBoards(db))))
  })

  it('GET /api/items still carries the item’s full context', async () => {
    const long = 'background a human returning cold needs. '.repeat(10)
    insertItem(db, { project: 'p', stream: '', agent: 'a', kind: 'question', title: 'q', context: long })
    const body = await (await createViewer(db).request('/api/items')).json()
    expect(JSON.stringify(body)).toContain(long)
    expect(JSON.stringify(body)).not.toContain('context_chars')
  })

  it('src/viewer.ts does not import the shaping module', () => {
    const src = readFileSync(new URL('../src/viewer.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/from '\.\/shape\.js'/)
    expect(src).not.toContain('context_chars')
  })
})
