import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openDb, insertItem, listItems, answerItem, markReplySeen, upsertBoard, listBoards, annotateBoardRow, upsertActivity, closeProject, closedProjects, upsertSourceLink } from '../src/store.js'
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
    expect(body.snippet).toContain('flag')          // the reporting snippet text
    expect(body.snippet).toContain('board_upsert')
    // the Setup pane serves docs/reporting-snippet.md verbatim, so the shipped
    // emit contract and the pane cannot drift apart on the dual-channel rule (#29).
    // Pin the tool token only, never the prose around it.
    expect(body.snippet).toContain('answer(')
    expect(body.dbPath).toContain('.agent-inbox')
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
