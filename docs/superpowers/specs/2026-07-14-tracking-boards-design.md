# Tracking Boards — Design

**Goal:** Add a second entity type to agent-inbox — a **board**: a titled table of semantic rows (label + status + note) that an agent maintains by upserting the whole table, and that the human observes in the viewer with status pills + a progress rollup, pinning notes to individual rows.

**One-liner:** Boards live *beside* the existing flag/note inbox (they do not replace or reshape it). The agent is the source of truth for row content; the human observes and annotates.

**Status:** Approved (design). User delegated all internal/technical decisions; only viewer/interaction surfaces need human eyeballing.

---

## Why / grounding

The flag/note inbox (`items` table, `kind ∈ {question,note}`) is for **ephemeral attention** — one-shot questions and notes that get resolved/dismissed. It's a poor fit for **standing status** an agent wants to keep current: a test-coverage matrix, a rollout checklist, a "what's tested vs not" board. Those want structured rows, a status per row, a progress rollup, and idempotent refresh — none of which the flat `items` table models.

A GitHub ticket is durable but static (you'd hand-edit a markdown table in a comment). The agent-inbox is the right home *because* the human already treats it as "what the agent surfaces for me," and it already has a live-polling viewer. This feature makes that surface hold a live, agent-maintained table.

## Scope

**In:**
- Two new SQLite tables (`boards`, `board_rows`) in `store.ts`.
- Three new MCP tools: `board_upsert`, `board_row`, `board_archive`.
- Viewer: a new `Boards` section (HTML table per board, progress bar, colored status pills), plus per-board archive and per-row human annotation.
- `GET /api/boards`, `POST /api/boards/:id/archive`, `POST /api/boards/:id/rows/:rowId/annotate`.

**Out / unchanged:**
- The entire `items` / flag / note path — untouched (schema, tools, grouping, viewer sections, API).
- No auth / remote mode (stays local, zero-config — v2 backlog concern).
- No cross-project board aggregation, no board history/versioning, no charts beyond one progress bar. YAGNI.

---

## Architecture

Additive, following every v1 invariant: `store.ts` is the only DB door; ESM `.js` specifiers; Node 24 + `better-sqlite3`; stdio channel stays clean (no stdout logging from server code); fail-open (inference failure → `unknown`, still write); all agent-authored text escaped via `esc()` before `innerHTML`.

### Data model (`store.ts`)

```
boards
  id          TEXT PRIMARY KEY        -- uuid (randomUUID at write time)
  project     TEXT NOT NULL           -- inferProject(cwd), same as items
  stream      TEXT NOT NULL DEFAULT ''-- last writer's branch (informational only)
  agent       TEXT NOT NULL           -- last writer (inferAgent)
  title       TEXT NOT NULL
  status      TEXT NOT NULL DEFAULT 'active'   -- 'active' | 'archived'
  created_at  TEXT NOT NULL           -- ISO 8601
  updated_at  TEXT NOT NULL           -- ISO 8601, bumped on every upsert/row change
  UNIQUE(project, title)              -- board is PROJECT-level; survives branch switches

board_rows
  id          TEXT PRIMARY KEY        -- uuid
  board_id    TEXT NOT NULL           -- references boards.id (no FK enforcement; boards are archived, never deleted, so no cascade is exercised)
  label       TEXT NOT NULL           -- stable row key within a board
  status      TEXT NOT NULL           -- 'done'|'partial'|'missing'|'tracked'|'na'
  note        TEXT NOT NULL DEFAULT ''-- agent's note (cell content)
  annotation  TEXT                    -- human's pinned note; NULL if none
  position    INTEGER NOT NULL        -- display order within board
  UNIQUE(board_id, label)

INDEX idx_boards_status_project ON boards(status, project)
INDEX idx_board_rows_board      ON board_rows(board_id, position)
```

**Keying decision:** boards are unique by `(project, title)`, deliberately *excluding* stream — a coverage board should persist as work moves across branches. `stream`/`agent` record the last writer for display, not identity.

**Status enum → presentation:**

| status    | glyph | meaning                    | rollup weight |
|-----------|-------|----------------------------|---------------|
| `done`    | ✅    | complete / verified        | 1.0           |
| `partial` | ⚠️    | partially covered          | 0.5           |
| `missing` | ❌    | not done / not tested      | 0.0           |
| `tracked` | 🔜    | deferred (e.g. a follow-up)| 0.0           |
| `na`      | ➖    | not applicable             | excluded      |

**Progress rollup** (computed, not stored): `countable = total rows − na rows`; `fraction = (done + 0.5·partial) / countable` (0 when `countable == 0`); label shown as `${done}/${countable} done`. `tracked` and `missing` both weigh 0 but are visually distinct (deferred vs. gap).

### Storage API (new exports in `store.ts`)

- `upsertBoard(db, {project, stream, agent, title, rows}) → {boardId, rowCount}` — inside a `db.transaction`:
  1. Find board by `(project, title)`. Insert if absent (status `active`, timestamps set); else update `stream/agent/updated_at`.
  2. Reconcile `board_rows` by `label`: for each incoming row (index = position) upsert status/note/position, **preserving existing `annotation`**; delete rows whose label is absent from the incoming set.
- `updateBoardRow(db, {project, title, label, status?, note?}) → {boardId, rowId}` — upsert a single row by label (creates the board if it doesn't exist yet, appending the row at `max(position)+1`); preserves annotation; bumps `updated_at`. For an **existing** row, undefined `status`/`note` leave the current value. For a **new** row, undefined `status` defaults to `'tracked'` (it's being noted, not yet done) and undefined `note` defaults to `''`.
- `findBoard(db, project, title) → Board | undefined` — lookup by the `(project, title)` unique key (used by the archive tool to resolve a title to an id).
- `archiveBoard(db, boardId) → {ok}` — set board `status='archived'` by id. Used directly by the viewer route; the `board_archive` MCP tool resolves `(project, title)` → id via `findBoard` first.
- `annotateBoardRow(db, rowId, text) → {ok}` — set a row's human `annotation` (from the viewer).
- `listBoards(db, {status='active'}) → BoardWithRows[]` — boards + their rows (ordered by position) + computed progress, newest-updated first.

Types (shared shape, mirrors the `Item` discipline):

```ts
export type RowStatus = 'done' | 'partial' | 'missing' | 'tracked' | 'na'
export interface BoardRow { id: string; label: string; status: RowStatus; note: string; annotation: string | null; position: number }
export interface Board { id: string; project: string; stream: string; agent: string; title: string; status: 'active'|'archived'; created_at: string; updated_at: string }
export interface Progress { done: number; partial: number; missing: number; tracked: number; na: number; total: number; countable: number; fraction: number }
export interface BoardWithRows extends Board { rows: BoardRow[]; progress: Progress }
export interface NewBoardRow { label: string; status: RowStatus; note?: string }
```

### MCP tools (`mcp.ts`)

All read scope the v1 way: lazy `clientName()` → `scope.get(clientName())` for `{project, stream, agent}`. All write only through `store.ts`. All return `{ content: [{ type:'text', text: JSON.stringify(result) }] }`. Fail-open on inference.

- **`board_upsert`** — create or replace a board (idempotent by `(project, title)`).
  `inputSchema: { title: z.string(), rows: z.array(z.object({ label: z.string(), status: z.enum(['done','partial','missing','tracked','na']), note: z.string().optional() })) }`
  → `{ boardId, rowCount }`. This is the primary tool: the agent re-sends the whole table to refresh it.
- **`board_row`** — update/add one row without re-sending the table.
  `inputSchema: { title: z.string(), label: z.string(), status: z.enum([...]).optional(), note: z.string().optional() }`
  → `{ boardId, rowId }`.
- **`board_archive`** — archive a finished board.
  `inputSchema: { title: z.string() }` → `{ ok: true }`.

### HTTP API (`viewer.ts`)

- `GET /api/boards` → `listBoards(db, {status:'active'})` (JSON: `BoardWithRows[]`). Kept as a **separate endpoint** from `/api/items` so `group.ts` stays items-only; the frontend fetches both in `load()`.
- `POST /api/boards/:id/archive` → `archiveBoard(db, id)` by id. → `{ ok }`.
- `POST /api/boards/:id/rows/:rowId/annotate` → `annotateBoardRow(db, rowId, text)`. → `{ ok }`.

### Viewer UI (`public/`)

- New `<section id="boards"><h2>Tracking</h2>…</section>` placed **below `needsYou`** (open questions remain the most urgent thing) and above `notes`.
- `renderBoards(boards)` in `app.js`: for each board, an `<article class="board">` with:
  - header: title + progress bar (`fraction` fill) + `${done}/${countable} done` + an **Archive** button.
  - an HTML `<table>`: one row per `BoardRow` — a colored **status pill** (`.pill.done/.partial/.missing/.tracked/.na` with the glyph), the label, the agent `note`, and the human `annotation` (shown as a distinct sub-line). An **Annotate** button per row reuses the existing `prompt()`-based annotate flow, POSTing to the row annotate endpoint.
  - Every interpolated field escaped via `esc()`.
- `load()` gains a second fetch (`/api/boards` alongside `/api/items`) and a `renderBoards()` call. The existing 3s poll drives live updates.
- `style.css`: pill colors (done→green, partial→amber, missing→red, tracked→slate, na→muted), a thin progress bar, and table styling consistent with the existing system-ui / light-dark-aware aesthetic.

---

## Data flow

1. Agent calls `board_upsert({title, rows})` (or `board_row` for a single flip). Scope inferred from cwd/git. `store.ts` reconciles rows by label inside a transaction, preserving human annotations.
2. Viewer polls `GET /api/boards` every 3s → renders the table with pills + progress.
3. Human clicks **Annotate** on a row → `POST …/rows/:rowId/annotate` → annotation stored, shown on next poll, and preserved when the agent next upserts (matched by label).
4. Human clicks **Archive** on a finished board → it drops out of the active view (`status='archived'`).

## Error handling (fail-open, v1 parity)

- Inference failure → `project/agent = 'unknown'`, still write.
- `board_upsert`/`board_row`/`archive` are transactional — a board and its rows update atomically or not at all (WAL + `busy_timeout=5000` already handle multi-process writes).
- A row whose label is dropped from an upsert is deleted (its human annotation goes with it — acceptable: the row no longer exists). Documented, not silent.
- Viewer never trusts agent text — `esc()` everywhere before `innerHTML`.
- A malformed status from an agent is rejected by the Zod enum at the tool boundary (never reaches storage).

## Testing

- **`store.test.ts`**: create board; upsert idempotency (same title → same board id); rows reconciled by label (add/update/drop); **annotation preserved across upsert**; `board_row` single-row upsert (incl. auto-create board); archive; progress rollup math (done/partial/missing/tracked/na weighting, `na` excluded, empty board → fraction 0).
- **`mcp.integration.test.ts`**: spawn the stdio server; `board_upsert` → `board_row` → `board_archive` round-trip; assert DB state via `store.ts`.
- **`viewer.test.ts`**: `GET /api/boards` shape + computed progress; `POST …/archive` flips status; `POST …/rows/:rowId/annotate` sets annotation and survives a subsequent `board_upsert`.

## Invariants preserved (from v1 CLAUDE.md)

`store.ts` is the only DB door · one process per session, shared file, WAL + busy_timeout · stdio sacred (no stdout from server code) · fail-open, never lose a write · viewer escapes all agent text · Node 24 pin (absolute node path when registering) · everything additive — v1's local, zero-config, no-auth items path is untouched.
