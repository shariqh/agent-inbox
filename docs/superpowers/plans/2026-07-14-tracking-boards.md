# Tracking Boards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `board` entity (titled table of semantic rows) to agent-inbox beside the flag/note inbox — agent maintains rows via idempotent upsert; the viewer shows status pills + a progress rollup; the human pins per-row annotations.

**Architecture:** Additive. Two new SQLite tables (`boards`, `board_rows`) behind `store.ts` (the only DB door), three new MCP tools in `mcp.ts`, three new Hono routes in `viewer.ts`, and a new `Boards` section in the vanilla-JS viewer. The v1 `items`/flag/note path is untouched.

**Tech Stack:** Node 24, TypeScript ESM (`.js` import specifiers), `better-sqlite3`, `hono`, `zod`, `@modelcontextprotocol/sdk`, `vitest`. Viewer is plain HTML/CSS/JS (no build step).

## Global Constraints

- **Node 24 only** — `better-sqlite3` fails on newer. Run `fnm use 24` (or `eval "$(fnm env)" && fnm use 24`) before `npm test`; the MCP integration test spawns `npx tsx` and inherits shell PATH.
- **ESM with `.js` specifiers** even for `.ts` sources (`import { x } from './store.js'`).
- **`store.ts` is the ONLY door to the database.** No raw SQL in `mcp.ts` or `viewer.ts`.
- **Additive only** — do not change the `items` table, its functions, `group.ts`, `/api/items`, or the existing viewer sections.
- **stdio channel is sacred** — never `console.log` to stdout from server code.
- **Fail-open** — if inference fails the tool still writes with `project/agent = 'unknown'`.
- **Viewer escapes all agent-authored text** via `esc()` before `innerHTML`.
- **Status enum (verbatim):** `'done' | 'partial' | 'missing' | 'tracked' | 'na'` → glyphs ✅ ⚠️ ❌ 🔜 ➖, rollup weights `1 / 0.5 / 0 / 0 / excluded`.
- **Progress formula (verbatim):** `countable = total − na`; `fraction = countable > 0 ? (done + 0.5·partial) / countable : 0`.
- **Board identity:** `UNIQUE(project, title)` — project-level, excludes stream.
- Commands: `npm test` (full), `npx vitest run test/<file>` (one file), `npm run typecheck`.

---

## File Structure

- `src/store.ts` (modify) — add board/row types, migrate two tables, and the storage API (`findBoard`, `upsertBoard`, `updateBoardRow`, `archiveBoard`, `annotateBoardRow`, `computeProgress`, `listBoards`).
- `src/mcp.ts` (modify) — register `board_upsert`, `board_row`, `board_archive`.
- `src/viewer.ts` (modify) — add `GET /api/boards`, `POST /api/boards/:id/archive`, `POST /api/boards/:id/rows/:rowId/annotate`.
- `public/index.html` (modify) — add `<section id="boards">`.
- `public/app.js` (modify) — add `renderBoards()`, second fetch in `load()`.
- `public/style.css` (modify) — pills, progress bar, board table styling.
- Tests: `test/store.test.ts`, `test/mcp.integration.test.ts`, `test/viewer.test.ts` (all modify — append new `describe` blocks; leave existing ones untouched).

**Decision (owned, not a question):** `listBoards` returns a **flat** list (newest-updated first) with `project` shown in each board's header — boards are few, so client-side grouping is unnecessary (YAGNI). This overrides the "grouped by project" phrasing in the spec's API sketch.

---

### Task 1: Storage layer — tables, types, and API

**Files:**
- Modify: `src/store.ts` (append after line 101; also extend `migrate()` at lines 46-64)
- Test: `test/store.test.ts` (append a new `describe('boards', …)` block)

**Interfaces:**
- Consumes: existing `openDb`, `randomUUID` (already imported at `src/store.ts:2`).
- Produces (later tasks rely on these exact signatures):
  - `type RowStatus = 'done' | 'partial' | 'missing' | 'tracked' | 'na'`
  - `interface Board { id, project, stream, agent, title, status: 'active'|'archived', created_at, updated_at }`
  - `interface BoardRow { id, label, status: RowStatus, note, annotation: string|null, position: number }`
  - `interface Progress { done, partial, missing, tracked, na, total, countable, fraction }`
  - `interface BoardWithRows extends Board { rows: BoardRow[]; progress: Progress }`
  - `interface NewBoardRow { label: string; status: RowStatus; note?: string }`
  - `findBoard(db, project: string, title: string): Board | undefined`
  - `upsertBoard(db, input: { project, stream, agent, title, rows: NewBoardRow[] }): { boardId: string; rowCount: number }`
  - `updateBoardRow(db, input: { project, stream, agent, title, label, status?: RowStatus, note?: string }): { boardId: string; rowId: string }`
  - `archiveBoard(db, boardId: string): void`
  - `annotateBoardRow(db, rowId: string, text: string): void`
  - `computeProgress(rows: BoardRow[]): Progress`
  - `listBoards(db, opts?: { status?: 'active'|'archived' }): BoardWithRows[]`

- [ ] **Step 1: Write the failing tests**

Append to `test/store.test.ts`. Add the new imports to the existing import from `../src/store.js` (line 6): add `upsertBoard, updateBoardRow, findBoard, archiveBoard, annotateBoardRow, listBoards, computeProgress` and `import type { BoardRow } from '../src/store.js'`.

```ts
describe('boards', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  const rows = [
    { label: 'theme', status: 'done' as const, note: 'both modes' },
    { label: 'stems', status: 'partial' as const },
    { label: 'mobile', status: 'tracked' as const, note: '#29' },
    { label: 'multi', status: 'missing' as const },
    { label: 'legacy', status: 'na' as const },
  ]

  it('upsert creates a board with rows, defaults note to empty', () => {
    const { boardId, rowCount } = upsertBoard(db, { project: 'p', stream: 'main', agent: 'claude-code', title: 'coverage', rows })
    expect(boardId).toBeTruthy()
    expect(rowCount).toBe(5)
    const board = listBoards(db)[0]!
    expect(board.title).toBe('coverage')
    expect(board.status).toBe('active')
    expect(board.rows.map((r) => r.label)).toEqual(['theme', 'stems', 'mobile', 'multi', 'legacy'])
    expect(board.rows[1]!.note).toBe('') // partial had no note
    expect(board.rows[0]!.annotation).toBeNull()
  })

  it('upsert is idempotent by (project, title) and reconciles rows by label', () => {
    const first = upsertBoard(db, { project: 'p', stream: 'main', agent: 'claude-code', title: 'coverage', rows })
    const second = upsertBoard(db, {
      project: 'p', stream: 'other', agent: 'claude-code', title: 'coverage',
      rows: [
        { label: 'theme', status: 'done', note: 'still good' }, // updated note
        { label: 'stems', status: 'done' },                     // partial → done
        { label: 'new', status: 'missing' },                    // added
      ],                                                          // 'mobile','multi','legacy' dropped
    })
    expect(second.boardId).toBe(first.boardId)          // same board
    expect(listBoards(db)).toHaveLength(1)
    const board = listBoards(db)[0]!
    expect(board.rows.map((r) => r.label)).toEqual(['theme', 'stems', 'new'])
    expect(board.rows[0]!.note).toBe('still good')
    expect(board.rows[1]!.status).toBe('done')
    expect(board.stream).toBe('other')                  // last writer recorded
  })

  it('upsert preserves a human annotation on a surviving row', () => {
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows })
    const themeId = listBoards(db)[0]!.rows.find((r) => r.label === 'theme')!.id
    annotateBoardRow(db, themeId, 'look here')
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'theme', status: 'partial' }] })
    const theme = listBoards(db)[0]!.rows.find((r) => r.label === 'theme')!
    expect(theme.status).toBe('partial')      // agent content updated
    expect(theme.annotation).toBe('look here') // human note preserved
  })

  it('updateBoardRow updates one row, and creates board+row when absent (default status tracked)', () => {
    updateBoardRow(db, { project: 'p', stream: '', agent: 'a', title: 'fresh', label: 'deploy', note: 'pending' })
    const board = listBoards(db)[0]!
    expect(board.title).toBe('fresh')
    expect(board.rows[0]!.status).toBe('tracked') // default for a new row with no status
    expect(board.rows[0]!.note).toBe('pending')
    updateBoardRow(db, { project: 'p', stream: '', agent: 'a', title: 'fresh', label: 'deploy', status: 'done' })
    const after = listBoards(db)[0]!.rows[0]!
    expect(after.status).toBe('done')
    expect(after.note).toBe('pending') // note untouched when omitted
  })

  it('archive hides a board from the default (active) list', () => {
    const { boardId } = upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows })
    archiveBoard(db, boardId)
    expect(listBoards(db)).toHaveLength(0)
    expect(listBoards(db, { status: 'archived' })).toHaveLength(1)
  })

  it('computeProgress weights done=1, partial=0.5, missing/tracked=0, excludes na', () => {
    const board = (() => { upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows }); return listBoards(db)[0]! })()
    const p = board.progress
    expect(p.total).toBe(5)
    expect(p.na).toBe(1)
    expect(p.countable).toBe(4)                 // 5 - 1 na
    expect(p.done).toBe(1); expect(p.partial).toBe(1); expect(p.missing).toBe(1); expect(p.tracked).toBe(1)
    expect(p.fraction).toBeCloseTo((1 + 0.5) / 4) // 0.375
  })

  it('computeProgress of an empty board is fraction 0, not NaN', () => {
    expect(computeProgress([] as BoardRow[]).fraction).toBe(0)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `eval "$(fnm env)" && fnm use 24 && npx vitest run test/store.test.ts`
Expected: FAIL — `upsertBoard is not a function` (or import errors).

- [ ] **Step 3: Extend `migrate()` to create the two tables**

In `src/store.ts`, inside `migrate()` (currently lines 46-64), add these statements to the `db.exec(\`…\`)` block, after the existing `items` index lines:

```sql
    CREATE TABLE IF NOT EXISTS boards (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      stream TEXT NOT NULL DEFAULT '',
      agent TEXT NOT NULL DEFAULT 'unknown',
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project, title)
    );
    CREATE TABLE IF NOT EXISTS board_rows (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      label TEXT NOT NULL,
      status TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      annotation TEXT,
      position INTEGER NOT NULL,
      UNIQUE(board_id, label)
    );
    CREATE INDEX IF NOT EXISTS idx_boards_status_project ON boards(status, project);
    CREATE INDEX IF NOT EXISTS idx_board_rows_board ON board_rows(board_id, position);
```

(No foreign-key pragma needed: boards are archived, never deleted, so no cascade is exercised. Row deletion during upsert is an explicit `DELETE`.)

- [ ] **Step 4: Append the types and storage API to `src/store.ts`**

Append at the end of `src/store.ts` (after line 101):

```ts
export type RowStatus = 'done' | 'partial' | 'missing' | 'tracked' | 'na'

export interface Board {
  id: string
  project: string
  stream: string
  agent: string
  title: string
  status: 'active' | 'archived'
  created_at: string
  updated_at: string
}

export interface BoardRow {
  id: string
  label: string
  status: RowStatus
  note: string
  annotation: string | null
  position: number
}

export interface Progress {
  done: number
  partial: number
  missing: number
  tracked: number
  na: number
  total: number
  countable: number
  fraction: number
}

export interface BoardWithRows extends Board {
  rows: BoardRow[]
  progress: Progress
}

export interface NewBoardRow {
  label: string
  status: RowStatus
  note?: string
}

export function findBoard(db: Database.Database, project: string, title: string): Board | undefined {
  return db.prepare(`SELECT * FROM boards WHERE project = ? AND title = ?`).get(project, title) as Board | undefined
}

interface UpsertBoardInput {
  project: string
  stream: string
  agent: string
  title: string
  rows: NewBoardRow[]
}

export function upsertBoard(db: Database.Database, input: UpsertBoardInput): { boardId: string; rowCount: number } {
  const run = db.transaction((inp: UpsertBoardInput): { boardId: string; rowCount: number } => {
    const now = new Date().toISOString()
    const boardId = ensureBoard(db, inp, now)
    const existing = db.prepare(`SELECT id, label FROM board_rows WHERE board_id = ?`).all(boardId) as { id: string; label: string }[]
    const idByLabel = new Map(existing.map((r) => [r.label, r.id]))
    const incoming = new Set<string>()
    inp.rows.forEach((r, i) => {
      incoming.add(r.label)
      const existingId = idByLabel.get(r.label)
      if (existingId) {
        // annotation column is deliberately NOT touched — human notes survive
        db.prepare(`UPDATE board_rows SET status = ?, note = ?, position = ? WHERE id = ?`).run(r.status, r.note ?? '', i, existingId)
      } else {
        db.prepare(`INSERT INTO board_rows (id, board_id, label, status, note, position) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(randomUUID(), boardId, r.label, r.status, r.note ?? '', i)
      }
    })
    for (const r of existing) if (!incoming.has(r.label)) db.prepare(`DELETE FROM board_rows WHERE id = ?`).run(r.id)
    return { boardId, rowCount: inp.rows.length }
  })
  return run(input)
}

interface UpdateRowInput {
  project: string
  stream: string
  agent: string
  title: string
  label: string
  status?: RowStatus
  note?: string
}

export function updateBoardRow(db: Database.Database, input: UpdateRowInput): { boardId: string; rowId: string } {
  const run = db.transaction((inp: UpdateRowInput): { boardId: string; rowId: string } => {
    const now = new Date().toISOString()
    const boardId = ensureBoard(db, inp, now)
    const existing = db.prepare(`SELECT id FROM board_rows WHERE board_id = ? AND label = ?`).get(boardId, inp.label) as { id: string } | undefined
    if (existing) {
      if (inp.status !== undefined) db.prepare(`UPDATE board_rows SET status = ? WHERE id = ?`).run(inp.status, existing.id)
      if (inp.note !== undefined) db.prepare(`UPDATE board_rows SET note = ? WHERE id = ?`).run(inp.note, existing.id)
      return { boardId, rowId: existing.id }
    }
    const rowId = randomUUID()
    const pos = (db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM board_rows WHERE board_id = ?`).get(boardId) as { p: number }).p
    db.prepare(`INSERT INTO board_rows (id, board_id, label, status, note, position) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(rowId, boardId, inp.label, inp.status ?? 'tracked', inp.note ?? '', pos)
    return { boardId, rowId }
  })
  return run(input)
}

// Find-or-create the board row and stamp the last writer. Shared by upsertBoard/updateBoardRow.
function ensureBoard(db: Database.Database, inp: { project: string; stream: string; agent: string; title: string }, now: string): string {
  const board = findBoard(db, inp.project, inp.title)
  if (board) {
    db.prepare(`UPDATE boards SET stream = ?, agent = ?, updated_at = ? WHERE id = ?`).run(inp.stream, inp.agent, now, board.id)
    return board.id
  }
  const boardId = randomUUID()
  db.prepare(`INSERT INTO boards (id, project, stream, agent, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`)
    .run(boardId, inp.project, inp.stream, inp.agent, inp.title, now, now)
  return boardId
}

export function archiveBoard(db: Database.Database, boardId: string): void {
  db.prepare(`UPDATE boards SET status = 'archived', updated_at = ? WHERE id = ?`).run(new Date().toISOString(), boardId)
}

export function annotateBoardRow(db: Database.Database, rowId: string, text: string): void {
  db.prepare(`UPDATE board_rows SET annotation = ? WHERE id = ?`).run(text, rowId)
}

export function computeProgress(rows: BoardRow[]): Progress {
  const counts = { done: 0, partial: 0, missing: 0, tracked: 0, na: 0 }
  for (const r of rows) counts[r.status]++
  const total = rows.length
  const countable = total - counts.na
  const fraction = countable > 0 ? (counts.done + 0.5 * counts.partial) / countable : 0
  return { ...counts, total, countable, fraction }
}

export function listBoards(db: Database.Database, opts: { status?: 'active' | 'archived' } = {}): BoardWithRows[] {
  const status = opts.status ?? 'active'
  const boards = db.prepare(`SELECT * FROM boards WHERE status = ? ORDER BY updated_at DESC`).all(status) as Board[]
  const rowStmt = db.prepare(`SELECT id, label, status, note, annotation, position FROM board_rows WHERE board_id = ? ORDER BY position ASC`)
  return boards.map((b) => {
    const rows = rowStmt.all(b.id) as BoardRow[]
    return { ...b, rows, progress: computeProgress(rows) }
  })
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `eval "$(fnm env)" && fnm use 24 && npx vitest run test/store.test.ts && npm run typecheck`
Expected: PASS (all board tests + existing item tests), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/store.ts test/store.test.ts
git commit -m "feat(store): boards + board_rows tables and storage API"
```

---

### Task 2: MCP tools — board_upsert, board_row, board_archive

**Files:**
- Modify: `src/mcp.ts` (add three `server.registerTool` calls before `return server` at line 68; extend the import at line 4)
- Test: `test/mcp.integration.test.ts` (append a new `it(...)` inside the existing `describe`)

**Interfaces:**
- Consumes: `upsertBoard`, `updateBoardRow`, `findBoard`, `archiveBoard` from `./store.js`; existing `scope`, `clientName()` in `buildMcpServer`.
- Produces: MCP tools `board_upsert` → `{ boardId, rowCount }`, `board_row` → `{ boardId, rowId }`, `board_archive` → `{ ok: boolean }`.

- [ ] **Step 1: Write the failing test**

Append inside the `describe('mcp round-trip', …)` block in `test/mcp.integration.test.ts`. Extend the store import (line 7) to add `listBoards`.

```ts
it('board tools upsert, update a row, and archive a board', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'mcp-board-')), 'inbox.db')
  const transport = new StdioClientTransport({
    command: 'npx', args: ['tsx', 'src/mcp-server.ts'], env: { ...process.env, AGENT_INBOX_DB: dbPath },
  })
  const client = new Client({ name: 'claude-code', version: '1.0.0' })
  await client.connect(transport)

  const up = await client.callTool({ name: 'board_upsert', arguments: {
    title: 'coverage',
    rows: [{ label: 'theme', status: 'done', note: 'both modes' }, { label: 'stems', status: 'partial' }],
  } })
  const upOut = JSON.parse((up.content as Array<{ text: string }>)[0]!.text)
  expect(upOut.rowCount).toBe(2)

  await client.callTool({ name: 'board_row', arguments: { title: 'coverage', label: 'stems', status: 'done' } })
  await client.close()

  const db = openDb(dbPath)
  const board = listBoards(db)[0]!
  expect(board.title).toBe('coverage')
  expect(board.rows.find((r) => r.label === 'stems')!.status).toBe('done')

  // archive via a second short-lived client (same db path)
  const t2 = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/mcp-server.ts'], env: { ...process.env, AGENT_INBOX_DB: dbPath } })
  const c2 = new Client({ name: 'claude-code', version: '1.0.0' })
  await c2.connect(t2)
  const arch = await c2.callTool({ name: 'board_archive', arguments: { title: 'coverage' } })
  expect(JSON.parse((arch.content as Array<{ text: string }>)[0]!.text).ok).toBe(true)
  await c2.close()

  expect(listBoards(openDb(dbPath))).toHaveLength(0) // archived → not in active list
}, 20000)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `eval "$(fnm env)" && fnm use 24 && npx vitest run test/mcp.integration.test.ts`
Expected: FAIL — tool `board_upsert` not found.

- [ ] **Step 3: Register the three tools in `src/mcp.ts`**

Extend the import at `src/mcp.ts:4`:

```ts
import { insertItem, resolveItem, upsertBoard, updateBoardRow, findBoard, archiveBoard } from './store.js'
```

Insert these three `registerTool` calls just before `return server` (line 68):

```ts
  const rowStatus = z.enum(['done', 'partial', 'missing', 'tracked', 'na'])

  server.registerTool(
    'board_upsert',
    {
      description:
        'Create or replace a tracking board (a titled table the human watches). Idempotent by title within this project — re-send the whole table to refresh it. Rows are matched by label; the human’s per-row notes survive. status: done|partial|missing|tracked|na.',
      inputSchema: {
        title: z.string().min(1),
        rows: z.array(z.object({ label: z.string().min(1), status: rowStatus, note: z.string().optional() })),
      },
    },
    async ({ title, rows }) => {
      const s = scope.get(clientName())
      const out = upsertBoard(db, { project: s.project, stream: s.stream, agent: s.agent, title, rows })
      return { content: [{ type: 'text', text: JSON.stringify(out) }] }
    },
  )

  server.registerTool(
    'board_row',
    {
      description:
        'Update or add ONE row of a tracking board by label, without re-sending the whole table. Creates the board (and row) if missing; a new row defaults to status "tracked". Omitted status/note leave the existing value.',
      inputSchema: { title: z.string().min(1), label: z.string().min(1), status: rowStatus.optional(), note: z.string().optional() },
    },
    async ({ title, label, status, note }) => {
      const s = scope.get(clientName())
      const out = updateBoardRow(db, { project: s.project, stream: s.stream, agent: s.agent, title, label, status, note })
      return { content: [{ type: 'text', text: JSON.stringify(out) }] }
    },
  )

  server.registerTool(
    'board_archive',
    {
      description: 'Archive a finished tracking board so it drops off the human’s active view. Resolved by title within this project.',
      inputSchema: { title: z.string().min(1) },
    },
    async ({ title }) => {
      const s = scope.get(clientName())
      const board = findBoard(db, s.project, title)
      if (board) archiveBoard(db, board.id)
      return { content: [{ type: 'text', text: JSON.stringify({ ok: board !== undefined }) }] }
    },
  )
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `eval "$(fnm env)" && fnm use 24 && npx vitest run test/mcp.integration.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/mcp.ts test/mcp.integration.test.ts
git commit -m "feat(mcp): board_upsert / board_row / board_archive tools"
```

---

### Task 3: Viewer API — GET /api/boards, archive, row-annotate

**Files:**
- Modify: `src/viewer.ts` (add three routes before `return app` at line 27; extend the import at line 3)
- Test: `test/viewer.test.ts` (append a new `describe('boards api', …)` block)

**Interfaces:**
- Consumes: `listBoards`, `archiveBoard`, `annotateBoardRow` from `./store.js`; existing `createViewer(db)`.
- Produces: `GET /api/boards` → `BoardWithRows[]`; `POST /api/boards/:id/archive` → `{ ok: true }`; `POST /api/boards/:id/rows/:rowId/annotate` → `{ ok: true }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/viewer.test.ts`. Extend the store import (line 6) to add `upsertBoard, listBoards`.

```ts
describe('boards api', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  it('GET /api/boards returns active boards with rows + progress', async () => {
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'coverage', rows: [
      { label: 'theme', status: 'done' }, { label: 'stems', status: 'partial' }, { label: 'na-row', status: 'na' },
    ] })
    const res = await createViewer(db).request('/api/boards')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(1)
    expect(body[0].title).toBe('coverage')
    expect(body[0].rows.map((r: { label: string }) => r.label)).toEqual(['theme', 'stems', 'na-row'])
    expect(body[0].progress.countable).toBe(2)
    expect(body[0].progress.fraction).toBeCloseTo(0.75) // (1 + 0.5)/2
  })

  it('POST archive removes the board from the active list', async () => {
    const { boardId } = upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'done' }] })
    const app = createViewer(db)
    expect((await app.request(`/api/boards/${boardId}/archive`, { method: 'POST' })).status).toBe(200)
    expect(listBoards(db)).toHaveLength(0)
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
    upsertBoard(db, { project: 'p', stream: '', agent: 'a', title: 'c', rows: [{ label: 'x', status: 'done' }] })
    expect(listBoards(db)[0]!.rows[0]!.annotation).toBe('do this next')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `eval "$(fnm env)" && fnm use 24 && npx vitest run test/viewer.test.ts`
Expected: FAIL — 404 on `/api/boards` (route not registered).

- [ ] **Step 3: Add the routes in `src/viewer.ts`**

Extend the import at `src/viewer.ts:3`:

```ts
import { listItems, resolveItem, dismissItem, annotateItem, listBoards, archiveBoard, annotateBoardRow } from './store.js'
```

Insert before `return app` (line 27):

```ts
  app.get('/api/boards', (c) => c.json(listBoards(db)))

  app.post('/api/boards/:id/archive', (c) => {
    archiveBoard(db, c.req.param('id'))
    return c.json({ ok: true })
  })

  app.post('/api/boards/:id/rows/:rowId/annotate', async (c) => {
    const { text } = await c.req.json<{ text: string }>()
    annotateBoardRow(db, c.req.param('rowId'), text)
    return c.json({ ok: true })
  })
```

(The `:id` board segment isn't needed by `annotateBoardRow` — rows are addressed by their own id — but it keeps the URL hierarchy honest and matches the viewer's fetch path.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `eval "$(fnm env)" && fnm use 24 && npx vitest run test/viewer.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/viewer.ts test/viewer.test.ts
git commit -m "feat(viewer): /api/boards list, archive, row-annotate routes"
```

---

### Task 4: Viewer UI — Boards section, render, styling

> **HUMAN EYEBALL FLAGGED:** this is the surface the user interacts with. After it passes, the executor should start the viewer, open it in a browser, and let the user visually confirm the board table, pills, progress bar, archive, and row-annotate before the feature is called done. All prior decisions are internal; this one the user reviews.

**Files:**
- Modify: `public/index.html` (add a section), `public/app.js` (add render + fetch), `public/style.css` (add styles)
- Test: none automated (vanilla JS, no harness — verified via the API tests in Task 3 + the manual eyeball). Do not invent a JS test harness.

**Interfaces:**
- Consumes: `GET /api/boards`, `POST /api/boards/:id/archive`, `POST /api/boards/:id/rows/:rowId/annotate` (Task 3); existing `esc()`, `load()`, `btn()` in `app.js`.

- [ ] **Step 1: Add the Boards section to `public/index.html`**

Insert between the `needsYou` section (line 12) and the `notes` section (line 13):

```html
    <section id="boards"><h2>Tracking</h2><div class="boards"></div></section>
```

- [ ] **Step 2: Add rendering + fetch to `public/app.js`**

In `load()` (lines 1-11), after `const g = await (await fetch('/api/items')).json()`, add a second fetch and render call:

```js
    const boards = await (await fetch('/api/boards')).json()
    renderBoards(boards)
```

(Place `renderBoards(boards)` alongside the existing `renderGroups(...)` calls, before the `document.getElementById('status')` line.)

Add these functions to `app.js` (e.g. after `renderDone`, before `itemEl`):

```js
const GLYPH = { done: '✅', partial: '⚠️', missing: '❌', tracked: '🔜', na: '➖' }

function renderBoards(boards) {
  const host = document.querySelector('#boards .boards')
  host.innerHTML = boards.length ? '' : '<p class="empty">No boards.</p>'
  for (const b of boards) host.appendChild(boardEl(b))
}

function boardEl(b) {
  const el = document.createElement('article')
  el.className = 'board'
  const pct = Math.round(b.progress.fraction * 100)
  const stream = b.stream ? ` · ${esc(b.stream)}` : ''
  el.innerHTML = `
    <div class="board-head">
      <div class="board-title">${esc(b.title)}</div>
      <div class="board-meta">${esc(b.project)}${stream}</div>
    </div>
    <div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>
    <div class="bar-label">${b.progress.done}/${b.progress.countable} done · ${pct}%</div>`
  const table = document.createElement('table')
  table.className = 'board-table'
  for (const r of b.rows) {
    const tr = document.createElement('tr')
    tr.innerHTML = `
      <td class="pill ${r.status}">${GLYPH[r.status] || ''}</td>
      <td class="row-label">${esc(r.label)}</td>
      <td class="row-note">${esc(r.note)}${r.annotation ? `<div class="annotation">📝 ${esc(r.annotation)}</div>` : ''}</td>`
    const actionTd = document.createElement('td')
    actionTd.className = 'row-action'
    actionTd.appendChild(btn('📝', async () => {
      const text = prompt('Your note on this row:', r.annotation || '')
      if (text != null) { await fetch(`/api/boards/${b.id}/rows/${r.id}/annotate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }); load() }
    }))
    tr.appendChild(actionTd)
    table.appendChild(tr)
  }
  el.appendChild(table)
  const actions = document.createElement('div')
  actions.className = 'actions'
  actions.appendChild(btn('Archive', async () => { await fetch(`/api/boards/${b.id}/archive`, { method: 'POST' }); load() }))
  el.appendChild(actions)
  return el
}
```

- [ ] **Step 3: Add styling to `public/style.css`**

Append to `public/style.css`:

```css
.board { border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); border-radius: 8px; padding: 12px; margin-bottom: var(--gap); }
.board-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.board-title { font-weight: 600; }
.board-meta { font-size: 12px; opacity: .55; }
.bar { height: 6px; border-radius: 3px; background: color-mix(in srgb, CanvasText 12%, transparent); margin: 8px 0 4px; overflow: hidden; }
.bar-fill { height: 100%; background: seagreen; }
.bar-label { font-size: 12px; opacity: .6; margin-bottom: 6px; }
.board-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.board-table td { padding: 4px 6px; border-top: 1px solid color-mix(in srgb, CanvasText 8%, transparent); vertical-align: top; }
.board-table .pill { width: 1.5em; text-align: center; }
.board-table .row-label { font-weight: 500; white-space: nowrap; }
.board-table .row-note { opacity: .8; width: 100%; white-space: pre-wrap; }
.board-table .row-action { text-align: right; }
.board-table .row-action button { font-size: 12px; padding: 1px 6px; border-radius: 6px; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); background: transparent; cursor: pointer; }
/* status accents on the label text so state reads at a glance even past the glyph */
.board-table tr .missing ~ td, .board-table tr:has(.missing) .row-label { color: color-mix(in srgb, crimson 70%, CanvasText); }
```

- [ ] **Step 4: Manual verification (human eyeball)**

Run: `eval "$(fnm env)" && fnm use 24 && npm run view` then open `http://localhost:4319`.
Seed a board first (in another terminal, via the MCP integration path or a one-off `node` script that calls `upsertBoard` against `~/.agent-inbox/inbox.db`), or point the viewer at a test DB with `AGENT_INBOX_DB=… npm run view`.
Expected: a **Tracking** section shows the board as a table with status pills, a green progress bar + `X/Y done · N%`, per-row 📝 buttons, and an **Archive** button. Clicking 📝 pins a note (📝 line appears under the row's note and persists after the 3s poll); clicking **Archive** removes the board within one poll. **Get the user's visual sign-off here.**

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/app.js public/style.css
git commit -m "feat(viewer): Tracking section — board tables, pills, progress bar"
```

---

## Self-Review

**Spec coverage:** boards+board_rows schema (T1) · status enum + weights + progress formula (T1 `computeProgress`, verbatim) · project-level `UNIQUE(project,title)` keying (T1) · upsert reconcile-by-label + annotation-preserved + drop-missing (T1) · `board_row` default `tracked` (T1) · three MCP tools with exact input schemas (T2) · three API routes (T3) · viewer section + pills + progress + archive + row-annotate (T4) · fail-open, stdio-clean, esc(), Node-24, additive (Global Constraints + each task). All spec sections map to a task.

**Placeholder scan:** no TBD/TODO; every code step shows complete code; every run step gives an exact command + expected result.

**Type consistency:** `RowStatus`, `Board`, `BoardRow`, `Progress`, `BoardWithRows`, `NewBoardRow` defined in T1 and consumed unchanged in T2/T3/T4. Storage signatures (`upsertBoard`/`updateBoardRow`/`findBoard`/`archiveBoard`/`annotateBoardRow`/`listBoards`/`computeProgress`) are identical across the Interfaces blocks and the implementation. `GLYPH`/pill classes in T4 match the enum in T1.

**One-way-door note:** the only human-facing surface is Task 4; the plan flags it explicitly for a visual sign-off before the feature is done.
