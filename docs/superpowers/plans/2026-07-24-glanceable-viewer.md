# Glanceable Viewer (Track B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the agent-inbox viewer so the thing that needs you is seeable at a glance, actionable in one tap, and understandable without reading paragraphs — while remaining completely ignorable.

**Architecture:** A left project rail + top content tabs replace the seven-section stack and the outline sidebar. Pure logic moves out of `public/app.js` into small, unit-tested browser ES modules (`attention.js`, `colors.js`, `star.js`, `poll.js`, `tabs.js`, `badge.js`) following the existing `public/search.js` + `test/search.test.ts` precedent. The Needs-you panel is a flat list of two-line compact rows that expand inline into the same card component the triage lightbox mounts. Everything is computed client-side from the three existing polled payloads; the only backend change is one additive `items.session` column so the viewer can tell whether the agent that asked is still alive.

**Tech Stack:** Node 24, TypeScript ESM (`.js` import specifiers, NodeNext), strict `tsc` with `noUncheckedIndexedAccess`, vitest against real temp SQLite DBs, better-sqlite3, Hono viewer, plain browser ES modules in `public/` with **no build step** (deliberate — so the Electron shell can lift-and-drop them).

**Spec:** [`docs/superpowers/specs/2026-07-24-glanceable-viewer-design.md`](../specs/2026-07-24-glanceable-viewer-design.md)

## Global Constraints

Every task's requirements implicitly include this section. It exists because the tasks below were
drafted independently and then reconciled; these are the contracts that keep them from colliding.

**Repo invariants (from CLAUDE.md — do not regress):**
- Node 24 only. Run everything via `fnm exec --using=24 -- …`. The integration test spawns the MCP server as a child process and inherits your PATH.
- `src/store.ts` is the **only** door to the database. No raw SQL anywhere else.
- **stdio is sacred**: never `console.log` to stdout from MCP server code.
- **Fail open**: never lose a flag. Inference failure attributes to `unknown` and still inserts.
- **The viewer escapes all agent-authored text** through `esc()` before `innerHTML`. Every new render path must keep doing this — flags and boards are attacker-influenced text.
- TDD: failing test → red → implement → green → commit. Tests use real temp SQLite DBs (`AGENT_INBOX_DB` + `mkdtempSync`), never mocks of the store.
- Imports use `.js` specifiers even for `.ts` sources.

**File ownership (exclusive — no other task edits these):**
| File / region | Owner |
|---|---|
| `public/index.html` (all structure) | Task 6 |
| `public/style.css` shell + layout | Task 6 |
| `public/style.css` `@media` rules | Task 18 (appended at EOF) |
| Boards tab chrome (header, hide-completed toggle, archived fold) | Task 13 |
| The `app.js` bottom init block | Task 8 |

**The init block** is written once, in full, by Task 8, in this order:
`initTabs, initTriage, initSearch, initAgentSelect, initGear, initListStaging, initKeys, initFocusHash, initResponsive, renderSetup, load, setInterval`.
Every later task inserts **exactly one line** ("insert `initKeys()` after `initSearch()`") and never re-quotes the block.

**Imports:** one `import` statement per module in `app.js`. Later tasks **edit** the existing line to add a name — never add a second import from the same module (re-binding an imported name is a `SyntaxError` that blanks the whole viewer).

**DOM contract:**
- Needs-you host: `<section class="panel" id="needsYou"><div id="needsYouList" class="rows"></div></section>`
- Rail: `#rail` → `button.rail-tab[data-project][role=tab]` → `span.rail-dot` + `span.rail-name` + `span.rail-badge` + `span.rail-match`; `input.rail-filter` at the head when >12 projects
- Row: `.nrow[data-card-id]`; inline expanded body: `.nrow-card`
- Tab strip: `#tabs`; pause hint: `#pauseHint` (next to `#status`)

**Shared symbols — declared once by their owner; everyone else consumes:**
| Symbol | Owner |
|---|---|
| `liveSessionIds()`, `themeName()`, `pcolor(name)`, `railProjects(...)`, `filterRailEntries(...)` | Task 7 |
| `selectTab(id)`, `activeTab`, `tabCounts(...)` | Task 8 |
| `openRowId`, `setOpenRow(id)`, `suspendState()`, `renderIfIdle()` | Task 9 |
| `staleEntries(...)`, `attentionEntries(...)`, `attentionCount(...)`, `countsByProject(...)`, `sortNeedsYou(...)`, `classifyLiveness(...)` | Task 3 |
| `titleWithBadge(base, count)` | Task 16 |

**Deleted permanently** by Tasks 6–7 — never call, patch, or re-anchor an edit to them:
`renderSub`, `renderPills`, `collectProjects`, `initSections`, `COLLAPSE_KEY`, `renderNow`.
(`renderRowToggle` survives until Task 13 deletes it.)

**Thresholds** (from the spec, exact values): `STALE_MS` = 72h · `ESCALATE_MS` = 1h · `NOTE_AGE_MS` = 7d · staged-send undo window = 5s · responsive breakpoint = 900px · rail filter appears above 12 projects.

**The attention predicate is the product.** It is defined once in Task 3 and consumed by the dock badge, the rail badges, the Needs-you tab count, and the triage deck. It counts unanswered questions (`kind === 'question' && !reply && status === 'open'`) plus blocked board rows that the human has not already seen (`blocked && !(annotation && !annotation_unseen)`), minus stale items. **It must be able to reach zero** — a count that can only grow is the failure mode that kills this product.

**Filter-blindness invariant:** the rail narrows the *list*, never the *global signal*. The dock badge and the Needs-you tab count are always computed over unfiltered, unsearched data; per-project counts appear on the rail tabs.

---

### Task 1: Store — additive `items.session` column

**Files:**
- Modify: `src/store.ts:18-36` (add `session` to `Item`)
- Modify: `src/store.ts:38-47` (add `session` to `NewItem`)
- Modify: `src/store.ts:123-128` (add the `ensureColumn` line for `items.session`)
- Modify: `src/store.ts:137-163` (`insertItem` persists `session`)
- Modify: `test/group.test.ts:5-12` (the full-`Item` factory needs the new field to keep `tsc` green)
- Test: `test/store.test.ts` (append a new `describe` after the final `})` at line 533)

**Interfaces:**
- Consumes: nothing (first task in the chain)
- Produces:
  - `Item.session: string | null` — the MCP session id that raised the item (`null` for legacy rows and non-agent inserts)
  - `NewItem.session?: string`
  - `insertItem(db: Database.Database, item: NewItem): string` — unchanged signature, now persists `item.session`
  - DB: `items.session TEXT` (nullable, `ensureColumn`-migrated)

- [ ] **Step 1: Write the failing test**

Append to `test/store.test.ts` (after the closing `})` of `describe('getBoard (agent read)', …)` on line 533). Every import it uses (`Database`, `mkdtempSync`, `tmpdir`, `join`, `openDb`, `insertItem`, `listItems`, `listPending`, `beforeEach`, `freshDb`) is already at the top of the file.

```ts
describe('item session (liveness)', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  it('items record the asking session; absent session is null', () => {
    const asked = insertItem(db, { project: 'p', stream: '', agent: 'a', kind: 'question', title: 'which db?', session: 'sess-42' })
    const anon = insertItem(db, { project: 'p', stream: '', agent: 'a', kind: 'note', title: 'no session' })
    const items = listItems(db)
    expect(items.find((i) => i.id === asked)!.session).toBe('sess-42')
    expect(items.find((i) => i.id === anon)!.session).toBeNull()
  })

  it('listPending surfaces the session on open questions', () => {
    insertItem(db, { project: 'p', stream: '', agent: 'a', kind: 'question', title: 'q', session: 'sess-7' })
    expect(listPending(db, 'p')[0]!.session).toBe('sess-7')
  })

  it('openDb migrates a legacy items table missing the session column', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'inbox-legacy4-')), 'inbox.db')
    const legacy = new Database(path)
    legacy.exec(`
      CREATE TABLE items (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, stream TEXT NOT NULL DEFAULT '',
        agent TEXT NOT NULL DEFAULT 'unknown', kind TEXT NOT NULL, title TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open',
        annotation TEXT, created_at TEXT NOT NULL, resolved_at TEXT
      );
    `)
    legacy.close()
    const db2 = openDb(path)
    insertItem(db2, { project: 'p', stream: '', agent: 'a', kind: 'question', title: 'q', session: 'sess-legacy' })
    expect(listItems(db2)[0]!.session).toBe('sess-legacy')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `fnm exec --using=24 -- npx vitest run test/store.test.ts -t 'items record the asking session'`
Expected: FAIL with `AssertionError: expected undefined to be 'sess-42' // Object.is equality` (the column does not exist, so `SELECT *` returns no `session` key)

- [ ] **Step 3: Write minimal implementation**

Edit 1 — `src/store.ts:18-36`, add the field to `Item` (right after `agent`):

```ts
export interface Item {
  id: string
  project: string
  stream: string
  agent: string
  // the MCP session that raised this item — lets the viewer tell whether the
  // asking agent is still alive (null on legacy rows and non-agent inserts)
  session: string | null
  kind: Kind
  title: string
  detail: string
  context: string
  status: Status
  annotation: string | null
  options: QuestionOption[] | null
  reply: string | null
  reply_context: string | null
  replied_at: string | null
  reply_seen_at: string | null
  created_at: string
  resolved_at: string | null
}
```

Edit 2 — `src/store.ts:38-47`, add it to `NewItem` (after `agent`):

```ts
export interface NewItem {
  project: string
  stream: string
  agent: string
  session?: string
  kind: Kind
  title: string
  detail?: string
  context?: string
  options?: QuestionOption[]
}
```

Edit 3 — `src/store.ts:128`, append one line to the `items` ensureColumn block (immediately after the `reply_seen_at` line, before the closing `}` of `migrate`):

```ts
  ensureColumn(db, 'items', 'reply_seen_at', 'TEXT')
  ensureColumn(db, 'items', 'session', 'TEXT')
```

Edit 4 — `src/store.ts:147-161`, persist it in `insertItem`:

```ts
  const id = randomUUID()
  db.prepare(
    `INSERT INTO items (id, project, stream, agent, session, kind, title, detail, context, options, status, created_at)
     VALUES (@id, @project, @stream, @agent, @session, @kind, @title, @detail, @context, @options, 'open', @created_at)`,
  ).run({
    id,
    project: item.project,
    stream: item.stream,
    agent: item.agent,
    session: item.session ?? null,
    kind: item.kind,
    title: item.title,
    detail: item.detail ?? '',
    context: item.context ?? '',
    options: item.options?.length ? JSON.stringify(item.options) : null,
    created_at: new Date().toISOString(),
  })
  return id
```

Edit 5 — `test/group.test.ts:5-12`, the factory builds a complete `Item`, so it needs the new field or `tsc --noEmit` fails:

```ts
function item(p: Partial<Item>): Item {
  return {
    id: p.id ?? 'x', project: p.project ?? 'p', stream: p.stream ?? '', agent: p.agent ?? 'claude-code',
    session: p.session ?? null,
    kind: p.kind ?? 'note', title: p.title ?? 't', detail: p.detail ?? '', context: p.context ?? '', status: p.status ?? 'open',
    annotation: p.annotation ?? null, created_at: p.created_at ?? '2026-07-12T00:00:00.000Z', resolved_at: p.resolved_at ?? null,
    options: p.options ?? null, reply: p.reply ?? null, reply_context: p.reply_context ?? null, replied_at: p.replied_at ?? null, reply_seen_at: p.reply_seen_at ?? null,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `fnm exec --using=24 -- npx vitest run test/store.test.ts test/group.test.ts && fnm exec --using=24 -- npm run typecheck`
Expected: PASS (all store + group tests green, `tsc --noEmit` clean)

- [ ] **Step 5: Commit**

```bash
git add src/store.ts test/store.test.ts test/group.test.ts
git commit -m "feat(store): record the session that raised an item

Additive items.session column (ensureColumn-migrated, nullable) so the
viewer can classify an item as waiting/parked/stale by whether the asking
session is still live.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: MCP `flag` stamps its session; viewer exposes it

**Files:**
- Modify: `src/mcp.ts:62-71` (pass `sessionId` into `insertItem`)
- Test: `test/mcp.integration.test.ts` (append an `it` before the file-closing `})` on line 175)
- Test: `test/viewer.test.ts` (append an `it` inside `describe('viewer api', …)`, before its closing `})` on line 93)

**Interfaces:**
- Consumes: `insertItem(db, { project, stream, agent, session?, kind, title, detail?, context?, options? }): string` and `Item.session: string | null` from Task 1; `listActivity(db, opts?): Activity[]` with `Activity.session: string` (`src/store.ts:469`)
- Produces: every item written by the `flag` tool carries `session === ` the MCP server's own `sessionId` (`src/mcp.ts:14`) — the same id its row in `GET /api/activity` uses. `GET /api/items` already serialises `Item` wholesale (`groupItems(listItems(db))`, `src/viewer.ts:49`), so `needsYou[].items[].session` / `notes[].items[].session` / `done[].session` are available to `public/attention.js` with no endpoint change.

- [ ] **Step 1: Write the failing test**

Append to `test/mcp.integration.test.ts`, inside `describe('mcp round-trip', …)` before its closing `})` on line 175. Add `listPending`-free imports only — the file already imports `openDb`, `listItems`, `listActivity` on line 7.

```ts
  it('a flagged item records the asking session, matching its live activity row', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mcp-session-')), 'inbox.db')
    const transport = new StdioClientTransport({
      command: 'npx', args: ['tsx', 'src/mcp-server.ts'], env: { ...process.env, AGENT_INBOX_DB: dbPath },
    })
    const client = new Client({ name: 'claude-code', version: '1.0.0' })
    await client.connect(transport)
    await new Promise((r) => setTimeout(r, 500)) // presence registers on the initialized notification

    await client.callTool({ name: 'flag', arguments: { kind: 'question', title: 'which storage?' } })

    // read BEFORE closing — process exit ends the activity row
    const db = openDb(dbPath)
    const live = listActivity(db)
    expect(live).toHaveLength(1)
    const item = listItems(db).find((i) => i.title === 'which storage?')!
    expect(item.session).toBe(live[0]!.session)
    expect(item.session).toMatch(/^[0-9a-f-]{36}$/)

    await client.close()
  }, 20000)
```

Append to `test/viewer.test.ts`, inside `describe('viewer api', …)` before its closing `})` on line 93:

```ts
  it('GET /api/items exposes the asking session so the viewer can judge liveness', async () => {
    insertItem(db, { project: 'p', stream: '', agent: 'claude-code', kind: 'question', title: 'q', session: 'sess-1' })
    insertItem(db, { project: 'p', stream: '', agent: 'claude-code', kind: 'note', title: 'n' })
    const body = await (await createViewer(db).request('/api/items')).json()
    expect(body.needsYou[0].items[0].session).toBe('sess-1')
    expect(body.notes[0].items[0].session).toBeNull()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `fnm exec --using=24 -- npx vitest run test/mcp.integration.test.ts -t 'a flagged item records the asking session'`
Expected: FAIL with `AssertionError: expected null to be '<uuid>' // Object.is equality` (Task 1 stores the column but `flag` never passes a session, so the row is `null`)

- [ ] **Step 3: Write minimal implementation**

`src/mcp.ts:62-71` — pass the server's own session id (declared at `src/mcp.ts:14`) into the insert:

```ts
      const id = insertItem(db, {
        project: s.project,
        stream: stream ?? s.stream,
        agent: s.agent,
        // stamp the asking session so the viewer can tell "waiting" (this
        // session is still in /api/activity) from "parked" (agent long gone)
        session: sessionId,
        kind,
        title,
        detail,
        context,
        options,
      })
```

No `src/viewer.ts` change is needed: `/api/items` returns `groupItems(listItems(db))` (`src/viewer.ts:49`) and `listItems` does `SELECT *` → `parseItem` spreads the whole row, so `session` serialises automatically. The viewer test above is the guard that keeps it true.

- [ ] **Step 4: Run test to verify it passes**

Run: `fnm exec --using=24 -- npx vitest run test/mcp.integration.test.ts test/viewer.test.ts && fnm exec --using=24 -- npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp.ts test/mcp.integration.test.ts test/viewer.test.ts
git commit -m "feat(mcp): stamp flagged items with the asking session

flag now records the stdio server's own session id, which is the same id
its /api/activity presence row uses — the viewer joins the two to classify
waiting vs parked. /api/items already serialises Item wholesale, so the
field surfaces with no endpoint change (now covered by a test).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Attention predicate + liveness (`public/attention.js`)

**Files:**
- Create: `public/attention.js`
- Create: `public/attention.d.ts`
- Test: `test/attention.test.ts`
- Modify: none (Tasks 7-10 wire this into `public/app.js`, replacing the buggy predicate at `public/app.js:139` and the counts at `public/app.js:111`)

**Interfaces:**
- Consumes: from Task 1/2's store change — `Item.session: string | null` (the session id that created the item, surfaced by `/api/items`) and `/api/activity` entries carrying `session`. Nothing else from earlier tasks; this module is pure and takes `liveSessionIds` as an argument.
- Produces:
  - `classifyLiveness(item, nowMs, liveSessionIds) -> 'waiting'|'parked'|'stale'`
  - `isBlockedRowAttention(row) -> boolean`
  - `attentionEntries(items, boards, nowMs, liveSessionIds) -> Array<{kind:'item',item,liveness}|{kind:'row',row,board}>`
  - `staleEntries(items, nowMs, liveSessionIds) -> Array<{kind:'item',item,liveness:'stale'}>` — the demoted set the collapsed stale fold renders (spec §6 demotes, it does not delete)
  - `attentionCount(items, boards, nowMs, liveSessionIds) -> number`
  - `countsByProject(items, boards, nowMs, liveSessionIds) -> Map<string,{total:number,escalated:number}>`
  - `sortNeedsYou(entries, nowMs) -> Entry[]`
  - `STALE_MS = 259200000`, `ESCALATE_MS = 3600000`, `NOTE_AGE_MS = 604800000`
  - Types from `public/attention.d.ts`: `Liveness`, `AttentionItem`, `AttentionRow`, `AttentionBoard`, `AttentionEntry`

- [ ] **Step 1: Write the failing test**

```ts
// test/attention.test.ts
import { describe, it, expect } from 'vitest'
import {
  classifyLiveness,
  isBlockedRowAttention,
  attentionEntries,
  staleEntries,
  attentionCount,
  countsByProject,
  sortNeedsYou,
  STALE_MS,
  ESCALATE_MS,
  NOTE_AGE_MS,
} from '../public/attention.js'
import type { AttentionEntry, AttentionItem, AttentionBoard } from '../public/attention.js'

const NOW = Date.parse('2026-07-24T12:00:00Z')

function item(id: string, over: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id,
    project: 'api',
    kind: 'question',
    reply: null,
    session: null,
    created_at: '2026-07-24T11:00:00Z',
    ...over,
  }
}

const board: AttentionBoard = {
  id: 'b1',
  project: 'web',
  title: 'Rollout',
  rows: [
    { id: 'r1', label: 'deploy', status: 'blocked', annotation: null, annotation_unseen: false },
    { id: 'r2', label: 'dns', status: 'blocked', annotation: 'use cloudflare', annotation_unseen: false },
    { id: 'r3', label: 'certs', status: 'blocked', annotation: 'wildcard please', annotation_unseen: true },
    { id: 'r4', label: 'smoke', status: 'done', annotation: null, annotation_unseen: false },
  ],
}

describe('constants', () => {
  it('are the spec durations', () => {
    expect(STALE_MS).toBe(72 * 60 * 60 * 1000)
    expect(ESCALATE_MS).toBe(60 * 60 * 1000)
    expect(NOTE_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })
})

describe('classifyLiveness', () => {
  it('is waiting when the asking session is still live', () => {
    expect(classifyLiveness(item('a', { session: 's1' }), NOW, new Set(['s1']))).toBe('waiting')
  })
  it('is parked when no live session but younger than 72h', () => {
    expect(classifyLiveness(item('a', { session: 's1' }), NOW, new Set(['s2']))).toBe('parked')
    expect(classifyLiveness(item('a', { session: null }), NOW, new Set())).toBe('parked')
  })
  it('is stale when no live session and older than 72h', () => {
    const old = item('a', { created_at: new Date(NOW - STALE_MS - 1000).toISOString() })
    expect(classifyLiveness(old, NOW, new Set())).toBe('stale')
  })
  it('exactly 72h old is still parked, not stale', () => {
    const edge = item('a', { created_at: new Date(NOW - STALE_MS).toISOString() })
    expect(classifyLiveness(edge, NOW, new Set())).toBe('parked')
  })
  it('a live session beats age — an old item with a live agent is waiting', () => {
    const old = item('a', { session: 's1', created_at: new Date(NOW - STALE_MS - 1000).toISOString() })
    expect(classifyLiveness(old, NOW, new Set(['s1']))).toBe('waiting')
  })
  it('accepts an array of session ids as well as a Set', () => {
    expect(classifyLiveness(item('a', { session: 's1' }), NOW, ['s1'])).toBe('waiting')
  })
})

describe('isBlockedRowAttention', () => {
  it('counts a blocked row with no annotation', () => {
    expect(isBlockedRowAttention(board.rows[0]!)).toBe(true)
  })
  it('REGRESSION: does NOT count a blocked row the human already annotated and the agent has seen', () => {
    // today's predicate (app.js:139) counts every blocked row, so the badge can
    // never return to zero. An already-seen annotation clears the escalation.
    expect(isBlockedRowAttention(board.rows[1]!)).toBe(false)
  })
  it('still counts a blocked row whose annotation the agent has not seen yet', () => {
    expect(isBlockedRowAttention(board.rows[2]!)).toBe(true)
  })
  it('ignores non-blocked rows', () => {
    expect(isBlockedRowAttention(board.rows[3]!)).toBe(false)
  })
  it('treats an empty-string annotation as no annotation', () => {
    expect(isBlockedRowAttention({ id: 'x', label: 'x', status: 'blocked', annotation: '', annotation_unseen: false })).toBe(true)
  })
})

describe('attentionEntries', () => {
  const items = [
    item('q1', { session: 's1', created_at: '2026-07-24T10:00:00Z' }),
    item('q2', { created_at: '2026-07-24T09:00:00Z' }),
    item('qStale', { created_at: '2026-07-20T00:00:00Z' }),
    item('qAnswered', { reply: 'yes' }),
    item('n1', { kind: 'note' }),
  ]
  const live = new Set(['s1'])

  it('includes unanswered non-stale questions with their liveness, plus blocked rows', () => {
    const e = attentionEntries(items, [board], NOW, live)
    expect(e.map((x) => (x.kind === 'row' ? `row:${x.row.id}` : x.item.id))).toEqual(['q1', 'q2', 'row:r1', 'row:r3'])
    const first = e[0]!
    expect(first.kind).toBe('item')
    if (first.kind === 'item') expect(first.liveness).toBe('waiting')
  })
  it('excludes stale, answered, and non-question items', () => {
    const ids = attentionEntries(items, [board], NOW, live).map((x) => (x.kind === 'item' ? x.item.id : ''))
    expect(ids).not.toContain('qStale')
    expect(ids).not.toContain('qAnswered')
    expect(ids).not.toContain('n1')
  })
  it('REGRESSION: a resolved question with no reply is not attention', () => {
    // resolve() closes an item without ever writing a reply. Keying only on
    // `reply` counts it forever and the badge can never reach zero.
    const resolved = [item('qResolved', { session: 's1', status: 'resolved' })]
    expect(attentionEntries(resolved, [], NOW, live)).toEqual([])
    expect(attentionCount(resolved, [], NOW, live)).toBe(0)
  })
  it('a dismissed question is not attention either', () => {
    expect(attentionCount([item('qDismissed', { status: 'dismissed' })], [], NOW, live)).toBe(0)
  })
  it('an explicitly open question still counts, and so does one with no status field', () => {
    expect(attentionCount([item('qOpen', { status: 'open' })], [], NOW, live)).toBe(1)
    expect(attentionCount([item('qNoStatus')], [], NOW, live)).toBe(1)
  })
  it('carries the owning board on row entries', () => {
    const rowEntry = attentionEntries([], [board], NOW, live)[0]!
    expect(rowEntry.kind).toBe('row')
    if (rowEntry.kind === 'row') expect(rowEntry.board.title).toBe('Rollout')
  })
  it('attentionCount matches the entry count', () => {
    expect(attentionCount(items, [board], NOW, live)).toBe(4)
  })
  it('returns zero when the only blocked row is already annotated and seen', () => {
    const settled: AttentionBoard = { id: 'b2', project: 'web', title: 'Done deal', rows: [board.rows[1]!] }
    expect(attentionCount([], [settled], NOW, live)).toBe(0)
  })
})

describe('staleEntries', () => {
  const ancient = item('qStale', { created_at: new Date(NOW - STALE_MS - 60_000).toISOString() })

  it('a >72h question with no live session is ABSENT from attentionEntries but PRESENT in staleEntries', () => {
    expect(attentionEntries([ancient], [], NOW, new Set())).toEqual([])
    const fold = staleEntries([ancient], NOW, new Set())
    expect(fold).toHaveLength(1)
    expect(fold[0]!.item.id).toBe('qStale')
    expect(fold[0]!.liveness).toBe('stale')
  })
  it('a live session keeps an old question out of the stale fold and in the attention set', () => {
    const alive = item('qOld', { session: 's1', created_at: new Date(NOW - STALE_MS - 60_000).toISOString() })
    expect(staleEntries([alive], NOW, new Set(['s1']))).toEqual([])
    expect(attentionCount([alive], [], NOW, new Set(['s1']))).toBe(1)
  })
  it('never demotes a young question', () => {
    expect(staleEntries([item('q1')], NOW, new Set())).toEqual([])
  })
  it('never returns answered, resolved, or non-question items however old', () => {
    const old = new Date(NOW - STALE_MS - 60_000).toISOString()
    const noise = [
      item('answered', { reply: 'yes', created_at: old }),
      item('resolved', { status: 'resolved', created_at: old }),
      item('note', { kind: 'note', created_at: old }),
    ]
    expect(staleEntries(noise, NOW, new Set())).toEqual([])
  })
})

describe('countsByProject', () => {
  it('totals per project and escalates blocked rows and >1h waiting items', () => {
    const items = [
      item('q1', { session: 's1', created_at: '2026-07-24T10:00:00Z' }), // waiting 2h → escalated
      item('q2', { session: 's1', created_at: '2026-07-24T11:45:00Z' }), // waiting 15m → not escalated
      item('q3', { created_at: '2026-07-23T00:00:00Z' }),                // parked, old → never escalates
    ]
    const m = countsByProject(items, [board], NOW, new Set(['s1']))
    expect(m.get('api')).toEqual({ total: 3, escalated: 1 })
    expect(m.get('web')).toEqual({ total: 2, escalated: 2 })
  })
  it('a parked item never escalates however old it is', () => {
    const parked = [item('p', { created_at: new Date(NOW - ESCALATE_MS * 10).toISOString() })]
    expect(countsByProject(parked, [], NOW, new Set())).toEqual(new Map([['api', { total: 1, escalated: 0 }]]))
  })
})

describe('sortNeedsYou', () => {
  it('orders blocked rows, then waiting oldest-first, then parked oldest-first, then answered at the foot', () => {
    const entries: AttentionEntry[] = [
      { kind: 'item', item: item('parkedNew', { created_at: '2026-07-24T11:30:00Z' }), liveness: 'parked' },
      { kind: 'item', item: item('answered', { reply: 'ok' }), liveness: 'parked' },
      { kind: 'item', item: item('waitNew', { created_at: '2026-07-24T11:00:00Z' }), liveness: 'waiting' },
      { kind: 'row', row: board.rows[0]!, board },
      { kind: 'item', item: item('parkedOld', { created_at: '2026-07-24T08:00:00Z' }), liveness: 'parked' },
      { kind: 'item', item: item('waitOld', { created_at: '2026-07-24T09:00:00Z' }), liveness: 'waiting' },
      { kind: 'row', row: board.rows[2]!, board },
    ]
    const out = sortNeedsYou(entries, NOW).map((e) => (e.kind === 'row' ? `row:${e.row.id}` : e.item.id))
    expect(out).toEqual(['row:r1', 'row:r3', 'waitOld', 'waitNew', 'parkedOld', 'parkedNew', 'answered'])
  })
  it('is stable for entries in the same bucket with equal timestamps', () => {
    const entries: AttentionEntry[] = [
      { kind: 'item', item: item('a'), liveness: 'parked' },
      { kind: 'item', item: item('b'), liveness: 'parked' },
      { kind: 'item', item: item('c'), liveness: 'parked' },
    ]
    expect(sortNeedsYou(entries, NOW).map((e) => (e.kind === 'item' ? e.item.id : ''))).toEqual(['a', 'b', 'c'])
  })
  it('does not mutate the input array', () => {
    const entries: AttentionEntry[] = [
      { kind: 'item', item: item('a', { created_at: '2026-07-24T11:00:00Z' }), liveness: 'parked' },
      { kind: 'row', row: board.rows[0]!, board },
    ]
    sortNeedsYou(entries, NOW)
    expect(entries[0]!.kind).toBe('item')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `fnm exec --using=24 -- npx vitest run test/attention.test.ts`
Expected: FAIL — `Error: Failed to load url ../public/attention.js (resolved id: /Users/shariqhirani/Development/agent-inbox/public/attention.js). Does the file exist?`

- [ ] **Step 3: Write minimal implementation**

`public/attention.js`:

```js
// The attention set, liveness classification and Needs-you ordering — one
// predicate, used by the dock badge, the rail badges, the tab count and the
// triage deck (design §6, §7, §3). Pure: no DOM, no fetch, clock injected as
// `nowMs` and live sessions injected as `liveSessionIds`.

export const STALE_MS = 72 * 60 * 60 * 1000     // no live session + older than this → stale fold
export const ESCALATE_MS = 60 * 60 * 1000       // a *waiting* item older than this turns the rail badge red
export const NOTE_AGE_MS = 7 * 24 * 60 * 60 * 1000 // notes auto-age into Done (§8)

// accepts a Set (browser) or a plain array (tests / JSON) without copying a Set
function asSet(sessions) {
  return sessions instanceof Set ? sessions : new Set(sessions ?? [])
}

// unparseable timestamps sort as maximally old rather than throwing NaN into a
// comparator — fail-open, never drop an item
function createdMs(entity) {
  const t = Date.parse(entity.created_at)
  return Number.isFinite(t) ? t : 0
}

// A question is still asking only while it is OPEN and unanswered. `resolve`
// closes an item without ever writing a reply, so keying on `reply` alone
// counts a resolved question forever and the badge can never reach zero.
// Absent status (hand-built fixtures, legacy rows) is treated as open.
function isAskingQuestion(item) {
  if (!item || item.kind !== 'question' || item.reply) return false
  return item.status === undefined || item.status === null || item.status === 'open'
}

// waiting = an agent is blocked on you *right now*; parked = answer whenever;
// stale = nobody is listening and it has been >72h (demoted to the fold, §6)
export function classifyLiveness(item, nowMs, liveSessionIds) {
  if (item.session && asSet(liveSessionIds).has(item.session)) return 'waiting'
  return nowMs - createdMs(item) > STALE_MS ? 'stale' : 'parked'
}

// A blocked row stops asking once the human has annotated it AND the agent has
// seen that annotation. Counting every blocked row (the old app.js:139 rule)
// makes the badge unable to return to zero.
export function isBlockedRowAttention(row) {
  if (row.status !== 'blocked') return false
  return !(row.annotation && !row.annotation_unseen)
}

// attention = open unanswered questions (minus the stale fold) ∪ escalating
// blocked rows. Nothing else: not notes, not milestones, not resolved, not
// answered-awaiting-pickup.
export function attentionEntries(items, boards, nowMs, liveSessionIds) {
  const live = asSet(liveSessionIds)
  const out = []
  for (const it of items ?? []) {
    if (!isAskingQuestion(it)) continue
    const liveness = classifyLiveness(it, nowMs, live)
    if (liveness === 'stale') continue
    out.push({ kind: 'item', item: it, liveness })
  }
  for (const b of boards ?? []) {
    for (const r of b.rows ?? []) if (isBlockedRowAttention(r)) out.push({ kind: 'row', row: r, board: b })
  }
  return out
}

// The other half of the split: questions the attention set drops because nobody
// is listening any more. §6 DEMOTES these into a collapsed fold — it does not
// delete them, so the fold needs its own accessor.
export function staleEntries(items, nowMs, liveSessionIds) {
  const live = asSet(liveSessionIds)
  const out = []
  for (const it of items ?? []) {
    if (!isAskingQuestion(it)) continue
    if (classifyLiveness(it, nowMs, live) === 'stale') out.push({ kind: 'item', item: it, liveness: 'stale' })
  }
  return out
}

export function attentionCount(items, boards, nowMs, liveSessionIds) {
  return attentionEntries(items, boards, nowMs, liveSessionIds).length
}

// per-project totals for the rail. `escalated` is the red subset: blocked rows,
// or waiting items (live agent blocked) older than an hour. A rail of all-red
// badges is a rail of no information.
export function countsByProject(items, boards, nowMs, liveSessionIds) {
  const map = new Map()
  for (const e of attentionEntries(items, boards, nowMs, liveSessionIds)) {
    const project = e.kind === 'row' ? e.board.project : e.item.project
    const cur = map.get(project) ?? { total: 0, escalated: 0 }
    cur.total += 1
    if (e.kind === 'row') cur.escalated += 1
    else if (e.liveness === 'waiting' && nowMs - createdMs(e.item) > ESCALATE_MS) cur.escalated += 1
    map.set(project, cur)
  }
  return map
}

// 0 blocked rows · 1 waiting · 2 parked · 3 answered-awaiting-pickup (dimmed foot)
function bucket(e) {
  if (e.kind === 'row') return 0
  if (e.item.reply) return 3
  return e.liveness === 'waiting' ? 1 : 2
}

// Stable: equal keys keep input order, so a poll rebuild does not reshuffle the
// list under the pointer.
export function sortNeedsYou(entries, nowMs) {
  return entries
    .map((e, i) => ({ e, i, b: bucket(e) }))
    .sort((a, b) => {
      if (a.b !== b.b) return a.b - b.b
      if (a.b === 1 || a.b === 2) {
        const age = (nowMs - createdMs(a.e.item)) - (nowMs - createdMs(b.e.item))
        if (age !== 0) return -age // oldest (largest age) first
      }
      return a.i - b.i
    })
    .map((k) => k.e)
}
```

`public/attention.d.ts` (mirrors `public/search.d.ts` — `public/` has no build step, so the types for the `.ts` tests live in a hand-written declaration file):

```ts
export type Liveness = 'waiting' | 'parked' | 'stale'

export interface AttentionItem {
  id: string
  project: string
  kind?: string
  /** 'open' | 'resolved' | 'dismissed'; absent is treated as open */
  status?: string
  reply?: string | null
  session?: string | null
  created_at: string
  title?: string
  detail?: string
  reply_seen_at?: string | null
}

export interface AttentionRow {
  id: string
  label?: string
  status: string
  annotation?: string | null
  annotation_unseen?: boolean
  note?: string
}

export interface AttentionBoard {
  id: string
  project: string
  title?: string
  rows: AttentionRow[]
}

export type AttentionEntry =
  | { kind: 'item'; item: AttentionItem; liveness: Liveness }
  | { kind: 'row'; row: AttentionRow; board: AttentionBoard }

export interface StaleEntry {
  kind: 'item'
  item: AttentionItem
  liveness: 'stale'
}

export type LiveSessionIds = Set<string> | readonly string[]

export const STALE_MS: number
export const ESCALATE_MS: number
export const NOTE_AGE_MS: number

export function classifyLiveness(item: AttentionItem, nowMs: number, liveSessionIds: LiveSessionIds): Liveness
export function isBlockedRowAttention(row: AttentionRow): boolean
export function attentionEntries(
  items: AttentionItem[],
  boards: AttentionBoard[],
  nowMs: number,
  liveSessionIds: LiveSessionIds,
): AttentionEntry[]
export function staleEntries(
  items: AttentionItem[],
  nowMs: number,
  liveSessionIds: LiveSessionIds,
): StaleEntry[]
export function attentionCount(
  items: AttentionItem[],
  boards: AttentionBoard[],
  nowMs: number,
  liveSessionIds: LiveSessionIds,
): number
export function countsByProject(
  items: AttentionItem[],
  boards: AttentionBoard[],
  nowMs: number,
  liveSessionIds: LiveSessionIds,
): Map<string, { total: number; escalated: number }>
export function sortNeedsYou(entries: AttentionEntry[], nowMs: number): AttentionEntry[]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `fnm exec --using=24 -- sh -c 'npx vitest run test/attention.test.ts && npx tsc --noEmit'`
Expected: PASS — every attention test green (including the resolved-question regression and the stale-fold split), `tsc --noEmit` silent

- [ ] **Step 5: Commit**

```bash
git add public/attention.js public/attention.d.ts test/attention.test.ts
git commit -m "feat(viewer): pure attention predicate, liveness and Needs-you sort

Blocked rows the human already annotated (and the agent has seen) no
longer count, and a resolved-without-reply question stops counting, so
the badge can return to zero. Stale questions are split out into
staleEntries for the collapsed fold rather than dropped."
```

---

### Task 4: Project colors (`public/colors.js`)

**Files:**
- Create: `public/colors.js`
- Create: `public/colors.d.ts`
- Test: `test/colors.test.ts`
- Modify: none (Task 7 consumes it for the rail dots and the selected-project wash in `public/app.js` / `public/style.css`)

**Interfaces:**
- Consumes: nothing (fully self-contained; no imports, no globals — the persistence store is injected).
- Produces:
  - `projectColor(name, theme: 'light'|'dark', store?) -> { dot: string, wash: string }` (OKLCH css strings, `oklch(L C H)`; with a `store` the hue comes from `assignedHue`, without it from the pure hash)
  - `projectMonogram(name) -> string` (≤2 chars, uppercase, `'?'` for empty)
  - `projectHue(name) -> number` (the pure hashed palette hue)
  - `assignedHue(name, store) -> number` — the persisted hue, derived from `projectHue` on first sight and written back
  - `overrideHue(name, hue, store) -> number` — pin a project to a palette hue; throws for a hue outside `PROJECT_HUES`
  - `PROJECT_HUES: readonly number[]`, `RESERVED_HUE: { start: number, end: number }`, `HUE_STORE_KEY: string`

- [ ] **Step 1: Write the failing test**

```ts
// test/colors.test.ts
import { describe, it, expect } from 'vitest'
import {
  projectColor,
  projectMonogram,
  projectHue,
  assignedHue,
  overrideHue,
  PROJECT_HUES,
  RESERVED_HUE,
  HUE_STORE_KEY,
} from '../public/colors.js'

const OKLCH = /^oklch\((0|1|0\.\d+) (0|0\.\d+) (\d+(?:\.\d+)?)\)$/

function parts(css: string): { l: number; c: number; h: number } {
  const m = OKLCH.exec(css)
  expect(m, `not an oklch() triple: ${css}`).not.toBeNull()
  return { l: Number(m![1]), c: Number(m![2]), h: Number(m![3]) }
}

// OKLCH → linear sRGB → WCAG relative luminance. Real math, no library: the
// legibility claim has to be COMPUTED, not eyeballed. Out-of-gamut components
// are clamped exactly as a browser clamps them.
function linearRgb(l: number, c: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180
  const a = c * Math.cos(h)
  const b = c * Math.sin(h)
  const lc = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const mc = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const sc = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  const clamp = (x: number) => Math.min(1, Math.max(0, x))
  return [
    clamp(4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc),
    clamp(-1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc),
    clamp(-0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc),
  ]
}

function luminance(css: string): number {
  const { l, c, h } = parts(css)
  const [r, g, b] = linearRgb(l, c, h)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(x: string, y: string): number {
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p)
  return (hi! + 0.05) / (lo! + 0.05)
}

// what the page sits on in each theme, so "contrast" means something concrete
const BG = { light: 'oklch(1 0 0)', dark: 'oklch(0.18 0 0)' } as const
const MIN_HUE_STEP = 15 // adjacent palette entries must be this far apart
// a hair under the WCAG 3:1 non-text floor: the dot is never the sole carrier
// (the monogram is, §2) and gamut clamping costs a little on the greens
const MIN_CONTRAST = 2.5

describe('projectColor', () => {
  it('returns oklch dot and wash strings', () => {
    const c = projectColor('agent-inbox', 'light')
    expect(c.dot).toMatch(OKLCH)
    expect(c.wash).toMatch(OKLCH)
  })
  it('is deterministic — same name, same colors', () => {
    expect(projectColor('agent-inbox', 'light')).toEqual(projectColor('agent-inbox', 'light'))
    expect(projectColor('agent-inbox', 'dark')).toEqual(projectColor('agent-inbox', 'dark'))
  })
  it('gives different names different hues (no global collapse)', () => {
    const hues = new Set(['api', 'web', 'agent-inbox', 'solo', 'ubi', 'billing'].map(projectHue))
    expect(hues.size).toBeGreaterThan(1)
  })
  it('keeps the same hue across themes but changes lightness/chroma', () => {
    const light = parts(projectColor('agent-inbox', 'light').dot)
    const dark = parts(projectColor('agent-inbox', 'dark').dot)
    expect(dark.h).toBe(light.h)
    expect(dark.l).not.toBe(light.l)
    expect(projectColor('agent-inbox', 'dark')).not.toEqual(projectColor('agent-inbox', 'light'))
  })
  it('uses one fixed lightness/chroma per theme for every project', () => {
    const a = parts(projectColor('api', 'light').dot)
    const b = parts(projectColor('billing', 'light').dot)
    expect(a.l).toBe(b.l)
    expect(a.c).toBe(b.c)
  })
  it('the wash is far lighter than the dot in light theme and far darker in dark theme', () => {
    expect(parts(projectColor('api', 'light').wash).l).toBeGreaterThan(parts(projectColor('api', 'light').dot).l)
    expect(parts(projectColor('api', 'dark').wash).l).toBeLessThan(parts(projectColor('api', 'dark').dot).l)
  })
  it('the dot and the wash share the project hue', () => {
    const c = projectColor('agent-inbox', 'light')
    expect(parts(c.wash).h).toBe(parts(c.dot).h)
  })
  it('NEVER generates a hue in the reserved red/amber/orange band', () => {
    for (const h of PROJECT_HUES) {
      expect(h < RESERVED_HUE.start || h > RESERVED_HUE.end, `palette hue ${h} is in the reserved band`).toBe(true)
    }
    for (let i = 0; i < 500; i++) {
      for (const theme of ['light', 'dark'] as const) {
        const c = projectColor(`project-${i}`, theme)
        for (const css of [c.dot, c.wash]) {
          const { h } = parts(css)
          expect(h < RESERVED_HUE.start || h > RESERVED_HUE.end, `${css} is in the reserved band`).toBe(true)
        }
      }
    }
  })
  it('spreads names across the whole palette', () => {
    const used = new Set<number>()
    for (let i = 0; i < 500; i++) used.add(projectHue(`project-${i}`))
    expect(used.size).toBe(PROJECT_HUES.length)
  })
  it('falls back to the light theme for an unknown theme string', () => {
    // @ts-expect-error deliberately passing an invalid theme
    expect(projectColor('api', 'sepia')).toEqual(projectColor('api', 'light'))
  })
})

describe('assignedHue / overrideHue', () => {
  it('assigns the hashed hue on first sight and persists it', () => {
    const store: Record<string, string> = {}
    const first = assignedHue('agent-inbox', store)
    expect(first).toBe(projectHue('agent-inbox'))
    expect(store[HUE_STORE_KEY], 'nothing was written back').toBeDefined()
    expect(JSON.parse(store[HUE_STORE_KEY]!)['agent-inbox']).toBe(first)
    expect(assignedHue('agent-inbox', store)).toBe(first)
  })
  it('a stored assignment beats the hash, so a project never changes color', () => {
    const other = PROJECT_HUES.find((h) => h !== projectHue('api'))!
    const store: Record<string, string> = { [HUE_STORE_KEY]: JSON.stringify({ api: other }) }
    expect(assignedHue('api', store)).toBe(other)
  })
  it('an override wins over both the hash and an earlier assignment', () => {
    const store: Record<string, string> = {}
    assignedHue('api', store)
    const pinned = PROJECT_HUES.find((h) => h !== projectHue('api'))!
    expect(overrideHue('api', pinned, store)).toBe(pinned)
    expect(assignedHue('api', store)).toBe(pinned)
    expect(parts(projectColor('api', 'light', store).dot).h).toBe(pinned)
    expect(parts(projectColor('api', 'dark', store).wash).h).toBe(pinned)
  })
  it('rejects a hue outside the palette — the reserved band stays state-only', () => {
    expect(() => overrideHue('api', 40, {})).toThrow(/PROJECT_HUES/)
  })
  it('a cleared store re-derives from the hash', () => {
    const store: Record<string, string> = {}
    overrideHue('api', PROJECT_HUES.find((h) => h !== projectHue('api'))!, store)
    delete store[HUE_STORE_KEY]
    expect(assignedHue('api', store)).toBe(projectHue('api'))
  })
  it('works with a localStorage-shaped store', () => {
    const backing = new Map<string, string>()
    const store = {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => { backing.set(k, v) },
    }
    const h = assignedHue('web', store)
    expect(h).toBe(projectHue('web'))
    expect(JSON.parse(backing.get(HUE_STORE_KEY)!).web).toBe(h)
    expect(assignedHue('web', store)).toBe(h)
  })
  it('survives corrupt storage by falling back to the hash', () => {
    const store: Record<string, string> = { [HUE_STORE_KEY]: '{not json' }
    expect(assignedHue('api', store)).toBe(projectHue('api'))
  })
  it('ignores a stored hue that is no longer in the palette', () => {
    const store: Record<string, string> = { [HUE_STORE_KEY]: JSON.stringify({ api: 7 }) }
    expect(assignedHue('api', store)).toBe(projectHue('api'))
  })
  it('projectColor without a store never touches persistence', () => {
    const store: Record<string, string> = {}
    projectColor('api', 'light')
    expect(store[HUE_STORE_KEY]).toBeUndefined()
  })
})

describe('palette legibility', () => {
  it('separates adjacent palette entries by at least 15° of hue', () => {
    for (let i = 1; i < PROJECT_HUES.length; i++) {
      const step = PROJECT_HUES[i]! - PROJECT_HUES[i - 1]!
      expect(step, `hues ${PROJECT_HUES[i - 1]} and ${PROJECT_HUES[i]} are too close`).toBeGreaterThanOrEqual(MIN_HUE_STEP)
    }
  })
  it('holds lightness and chroma constant per theme, so hue is the only variable', () => {
    for (const theme of ['light', 'dark'] as const) {
      const store: Record<string, string> = {}
      const dots = PROJECT_HUES.map((hue) => {
        overrideHue('probe', hue, store)
        return parts(projectColor('probe', theme, store).dot)
      })
      expect(new Set(dots.map((d) => d.l)).size, `${theme} dots vary in lightness`).toBe(1)
      expect(new Set(dots.map((d) => d.c)).size, `${theme} dots vary in chroma`).toBe(1)
    }
  })
  it('clears the contrast floor for dot vs wash AND dot vs page in both themes', () => {
    for (const theme of ['light', 'dark'] as const) {
      const store: Record<string, string> = {}
      for (const hue of PROJECT_HUES) {
        overrideHue('probe', hue, store)
        const c = projectColor('probe', theme, store)
        expect(contrast(c.dot, c.wash), `${theme} hue ${hue}: dot on wash`).toBeGreaterThanOrEqual(MIN_CONTRAST)
        expect(contrast(c.dot, BG[theme]), `${theme} hue ${hue}: dot on page`).toBeGreaterThanOrEqual(MIN_CONTRAST)
      }
    }
  })
})

describe('projectMonogram', () => {
  it('takes the initials of the first two words', () => {
    expect(projectMonogram('agent-inbox')).toBe('AI')
    expect(projectMonogram('my project x')).toBe('MP')
    expect(projectMonogram('coreworx/ubi')).toBe('CU')
  })
  it('takes the first two letters of a single word', () => {
    expect(projectMonogram('solo')).toBe('SO')
    expect(projectMonogram('unknown')).toBe('UN')
  })
  it('never exceeds two characters', () => {
    for (const n of ['a b c d', 'averyverylongprojectname', 'x', '', '---']) {
      expect(projectMonogram(n).length).toBeLessThanOrEqual(2)
    }
  })
  it('falls back to ? when there is nothing alphanumeric', () => {
    expect(projectMonogram('')).toBe('?')
    expect(projectMonogram('---')).toBe('?')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `fnm exec --using=24 -- npx vitest run test/colors.test.ts`
Expected: FAIL — `Error: Failed to load url ../public/colors.js (resolved id: /Users/shariqhirani/Development/agent-inbox/public/colors.js). Does the file exist?`

- [ ] **Step 3: Write minimal implementation**

`public/colors.js`:

```js
// Deterministic per-project color (design §2). Zero-config: the hue is hashed
// from the project name, then PERSISTED on first sight so a project keeps its
// color for good; the human can pin a different palette hue. Lightness and
// chroma are fixed per theme so every project is legible in light and dark.
// Pure apart from the injected key-value store — no DOM, no global localStorage.

// The red/amber/orange band is reserved for STATE (blocked, urgency): a project
// must never look like an alarm. Palette hues live strictly outside it.
export const RESERVED_HUE = { start: 15, end: 95 }

export const PROJECT_HUES = [120, 145, 165, 185, 200, 220, 240, 260, 280, 300, 320, 340]

// one storage key holds the whole { project: hue } map
export const HUE_STORE_KEY = 'agent-inbox-hues'

// one fixed L/C pair per theme per role — color identifies, it never signals
const THEME = {
  light: { dot: { l: 0.62, c: 0.15 }, wash: { l: 0.96, c: 0.03 } },
  dark: { dot: { l: 0.72, c: 0.14 }, wash: { l: 0.28, c: 0.045 } },
}

// djb2-xor: stable across reloads and processes, unlike anything seeded
function hash(name) {
  const s = String(name ?? '')
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h
}

// the store is either localStorage-shaped (getItem/setItem) or a plain object;
// corrupt or unreadable storage degrades to "no assignments yet", never throws
function readMap(store) {
  if (!store) return {}
  try {
    const raw = typeof store.getItem === 'function' ? store.getItem(HUE_STORE_KEY) : store[HUE_STORE_KEY]
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeMap(store, map) {
  if (!store) return
  const json = JSON.stringify(map)
  try {
    if (typeof store.setItem === 'function') store.setItem(HUE_STORE_KEY, json)
    else store[HUE_STORE_KEY] = json
  } catch {
    /* storage full or blocked — the hash still gives a usable color */
  }
}

export function projectHue(name) {
  return PROJECT_HUES[hash(name) % PROJECT_HUES.length]
}

// first sight derives from the hash and writes it back, so a project's color
// survives a palette reshuffle or a name-collision rehash
export function assignedHue(name, store) {
  const key = String(name ?? '')
  const map = readMap(store)
  if (PROJECT_HUES.includes(map[key])) return map[key]
  const hue = projectHue(key)
  map[key] = hue
  writeMap(store, map)
  return hue
}

// the human pins a project to a palette hue; it is just an assignment written
// into the same map, so every later read (including projectColor) honours it
export function overrideHue(name, hue, store) {
  if (!PROJECT_HUES.includes(hue)) throw new Error(`hue ${hue} is not one of PROJECT_HUES`)
  const map = readMap(store)
  map[String(name ?? '')] = hue
  writeMap(store, map)
  return hue
}

export function projectColor(name, theme, store) {
  const t = theme === 'dark' ? THEME.dark : THEME.light
  const h = store ? assignedHue(name, store) : projectHue(name)
  return { dot: `oklch(${t.dot.l} ${t.dot.c} ${h})`, wash: `oklch(${t.wash.l} ${t.wash.c} ${h})` }
}

// Color is never the only carrier (§2): the All view puts this label beside the
// dot so a deuteranope reads the project without the hue.
export function projectMonogram(name) {
  const words = String(name ?? '').split(/[^a-zA-Z0-9]+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}
```

`public/colors.d.ts`:

```ts
export type Theme = 'light' | 'dark'

/** localStorage in the browser; a plain object in tests */
export type HueStore =
  | { getItem(key: string): string | null; setItem(key: string, value: string): void }
  | Record<string, string>

export interface ProjectColor {
  /** OKLCH css color for the project dot */
  dot: string
  /** OKLCH css color for the selected-project background wash */
  wash: string
}

export const RESERVED_HUE: { start: number; end: number }
export const PROJECT_HUES: readonly number[]
export const HUE_STORE_KEY: string

export function projectHue(name: string): number
export function assignedHue(name: string, store: HueStore): number
export function overrideHue(name: string, hue: number, store: HueStore): number
export function projectColor(name: string, theme: Theme, store?: HueStore): ProjectColor
export function projectMonogram(name: string): string
```

- [ ] **Step 4: Verify the palette is separable and legible**

Run: `fnm exec --using=24 -- npx vitest run test/colors.test.ts -t 'palette legibility'`
Expected: PASS — 3 tests green: adjacent palette entries are ≥15° apart, lightness/chroma are constant within a theme (hue is the only variable), and every hue clears a computed 2.5:1 luminance contrast for dot-on-wash and dot-on-page in BOTH themes. This is the deuteranopia/contrast guarantee: hue separation plus a real contrast floor, with `projectMonogram` as the non-color carrier.

- [ ] **Step 5: Run test to verify it passes**

Run: `fnm exec --using=24 -- sh -c 'npx vitest run test/colors.test.ts && npx tsc --noEmit'`
Expected: PASS — every colors test green (palette, persistence/override, legibility, monogram), `tsc --noEmit` silent

- [ ] **Step 6: Commit**

```bash
git add public/colors.js public/colors.d.ts test/colors.test.ts
git commit -m "feat(viewer): deterministic OKLCH project colors, persisted and overridable

Hues come from a fixed palette that excludes the red/amber/orange band,
which stays reserved for state. First sight persists the assignment into
an injected key-value store so a project never changes color, and the
human can pin one. Palette separation and dot/wash contrast are verified
in both themes by computed luminance, not by eye."
```

---

### Task 5: The safe star — gating, staged send, undo (`public/star.js`)

**Files:**
- Create: `public/star.js`
- Create: `public/star.d.ts`
- Test: `test/star.test.ts`
- Modify: none (Task 10 wires the star button into the Needs-you row in `public/app.js`, reusing `sendReply` at `public/app.js:700-712` as the `send` callback and `window.setTimeout`/`window.clearTimeout` as the injected timers)

**Interfaces:**
- Consumes: nothing at runtime. The `send` callback the caller injects is `sendReply(id, text, context)` from `public/app.js:700`; the payload shape is the caller's business.
- Produces:
  - `starOption(item) -> QuestionOption | null` (the single `recommended === true` option; `null` for 0 or 2+)
  - `createStagedSend({ delayMs, setTimeoutFn, clearTimeoutFn, send }) -> { stage(key, payload), undo(key) -> boolean, flush(), pending(key) -> boolean }`
  - `canUndo(item) -> boolean` (false once `reply_seen_at` is set)

- [ ] **Step 1: Write the failing test**

```ts
// test/star.test.ts
import { describe, it, expect } from 'vitest'
import { starOption, createStagedSend, canUndo } from '../public/star.js'

// hand-driven clock: nothing fires until the test says so, so "5 seconds" costs
// zero milliseconds of test time
function fakeTimers() {
  let nextId = 0
  const timers = new Map<number, () => void>()
  return {
    setTimeoutFn: (fn: () => void) => { const id = ++nextId; timers.set(id, fn); return id },
    clearTimeoutFn: (id: number) => { timers.delete(id) },
    runAll: () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn() } },
    outstanding: () => timers.size,
  }
}

describe('starOption', () => {
  it('returns the single recommended option', () => {
    const it_ = { options: [{ label: 'Ship it', recommended: true }, { label: 'Wait' }] }
    expect(starOption(it_)?.label).toBe('Ship it')
  })
  it('is null when nothing is recommended', () => {
    expect(starOption({ options: [{ label: 'A' }, { label: 'B' }] })).toBeNull()
  })
  it('is null when TWO options are recommended (the store does not validate this)', () => {
    expect(starOption({ options: [{ label: 'A', recommended: true }, { label: 'B', recommended: true }] })).toBeNull()
  })
  it('is null when there are no options at all', () => {
    expect(starOption({ options: [] })).toBeNull()
    expect(starOption({ options: null })).toBeNull()
    expect(starOption({})).toBeNull()
  })
  it('only a literal true recommends — truthy junk does not', () => {
    // @ts-expect-error the API contract is boolean; guard against loose JSON
    expect(starOption({ options: [{ label: 'A', recommended: 'yes' }] })).toBeNull()
  })
})

describe('createStagedSend', () => {
  it('does not send before the delay elapses', () => {
    const t = fakeTimers()
    const sent: unknown[] = []
    const s = createStagedSend({ delayMs: 5000, ...t, send: (p) => sent.push(p) })
    s.stage('i1', { id: 'i1', text: 'Ship it' })
    expect(sent).toEqual([])
    expect(s.pending('i1')).toBe(true)
  })
  it('sends after the delay elapses', () => {
    const t = fakeTimers()
    const sent: unknown[] = []
    const s = createStagedSend({ delayMs: 5000, ...t, send: (p) => sent.push(p) })
    s.stage('i1', { id: 'i1', text: 'Ship it' })
    t.runAll()
    expect(sent).toEqual([{ id: 'i1', text: 'Ship it' }])
    expect(s.pending('i1')).toBe(false)
  })
  it('undo before the delay cancels outright and returns true', () => {
    const t = fakeTimers()
    const sent: unknown[] = []
    const s = createStagedSend({ delayMs: 5000, ...t, send: (p) => sent.push(p) })
    s.stage('i1', { id: 'i1', text: 'Ship it' })
    expect(s.undo('i1')).toBe(true)
    expect(s.pending('i1')).toBe(false)
    expect(t.outstanding()).toBe(0)
    t.runAll()
    expect(sent).toEqual([])
  })
  it('undo after the send returns false and sends nothing extra', () => {
    const t = fakeTimers()
    const sent: unknown[] = []
    const s = createStagedSend({ delayMs: 5000, ...t, send: (p) => sent.push(p) })
    s.stage('i1', { id: 'i1', text: 'Ship it' })
    t.runAll()
    expect(s.undo('i1')).toBe(false)
    expect(sent).toHaveLength(1)
  })
  it('undo for a key that was never staged returns false', () => {
    const t = fakeTimers()
    const s = createStagedSend({ delayMs: 5000, ...t, send: () => {} })
    expect(s.undo('nope')).toBe(false)
  })
  it('flush sends every pending payload immediately and clears the timers', () => {
    const t = fakeTimers()
    const sent: unknown[] = []
    const s = createStagedSend({ delayMs: 5000, ...t, send: (p) => sent.push(p) })
    s.stage('i1', { id: 'i1', text: 'A' })
    s.stage('i2', { id: 'i2', text: 'B' })
    s.flush()
    expect(sent).toEqual([{ id: 'i1', text: 'A' }, { id: 'i2', text: 'B' }])
    expect(t.outstanding()).toBe(0)
    expect(s.pending('i1')).toBe(false)
    t.runAll()
    expect(sent).toHaveLength(2) // the elapsed timer must not double-send
  })
  it('re-staging the same key replaces the payload and sends once', () => {
    const t = fakeTimers()
    const sent: unknown[] = []
    const s = createStagedSend({ delayMs: 5000, ...t, send: (p) => sent.push(p) })
    s.stage('i1', { id: 'i1', text: 'A' })
    s.stage('i1', { id: 'i1', text: 'B' })
    t.runAll()
    expect(sent).toEqual([{ id: 'i1', text: 'B' }])
  })
  it('tracks keys independently', () => {
    const t = fakeTimers()
    const sent: unknown[] = []
    const s = createStagedSend({ delayMs: 5000, ...t, send: (p) => sent.push(p) })
    s.stage('i1', { id: 'i1', text: 'A' })
    s.stage('i2', { id: 'i2', text: 'B' })
    expect(s.undo('i1')).toBe(true)
    t.runAll()
    expect(sent).toEqual([{ id: 'i2', text: 'B' }])
  })
})

describe('canUndo', () => {
  it('is true while the agent has not picked the reply up', () => {
    expect(canUndo({ reply_seen_at: null })).toBe(true)
    expect(canUndo({})).toBe(true)
  })
  it('is false once reply_seen_at is set — that race cannot be won', () => {
    expect(canUndo({ reply_seen_at: '2026-07-24T11:59:00Z' })).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `fnm exec --using=24 -- npx vitest run test/star.test.ts`
Expected: FAIL — `Error: Failed to load url ../public/star.js (resolved id: /Users/shariqhirani/Development/agent-inbox/public/star.js). Does the file exist?`

- [ ] **Step 3: Write minimal implementation**

`public/star.js`:

```js
// The safe ★ (one-tap accept, design §5). Pure: the gating rule, the staged
// send with undo (timers injected so it is unit-testable), and the rule that
// undo is refused once the agent has picked the reply up.

// Gate 1: the star renders only when EXACTLY ONE option is recommended. Zero →
// nothing to accept. Two or more → the flag is ambiguous and the store does not
// validate it, so refuse rather than pick. Absence of a star is neutral.
export function starOption(item) {
  const options = item?.options ?? []
  const recommended = options.filter((o) => o && o.recommended === true)
  return recommended.length === 1 ? recommended[0] : null
}

// Gate 3: the tap stages the reply; it fires after `delayMs` (or immediately on
// flush — tab blur/close), and undo within the window cancels it outright so no
// request is ever made.
export function createStagedSend({ delayMs, setTimeoutFn, clearTimeoutFn, send }) {
  const pending = new Map() // key → { handle, payload }

  function fire(key) {
    const entry = pending.get(key)
    if (!entry) return
    pending.delete(key)
    send(entry.payload)
  }

  return {
    stage(key, payload) {
      const existing = pending.get(key)
      if (existing) clearTimeoutFn(existing.handle)
      const handle = setTimeoutFn(() => fire(key), delayMs)
      pending.set(key, { handle, payload })
    },
    undo(key) {
      const entry = pending.get(key)
      if (!entry) return false // already sent (or never staged) — cannot be undone
      clearTimeoutFn(entry.handle)
      pending.delete(key)
      return true
    },
    flush() {
      for (const [key, entry] of [...pending]) {
        clearTimeoutFn(entry.handle)
        pending.delete(key)
        send(entry.payload)
      }
    },
    pending(key) {
      return pending.has(key)
    },
  }
}

// Once the agent has read the reply, un-sending it is a lie: the UI must refuse
// with an explanation rather than pretend it worked.
export function canUndo(item) {
  return !item?.reply_seen_at
}
```

`public/star.d.ts`:

```ts
export interface StarOption {
  label: string
  detail?: string
  recommended?: boolean
}

export interface StarItem {
  options?: StarOption[] | null
  reply_seen_at?: string | null
}

export interface StagedSend<P> {
  /** schedule send(payload) after delayMs, replacing any pending payload for key */
  stage(key: string, payload: P): void
  /** cancel a still-pending send; false when it already fired or was never staged */
  undo(key: string): boolean
  /** send every pending payload now (tab blur/close) */
  flush(): void
  pending(key: string): boolean
}

export function starOption(item: StarItem): StarOption | null
export function createStagedSend<P>(opts: {
  delayMs: number
  setTimeoutFn: (fn: () => void, ms: number) => number
  clearTimeoutFn: (handle: number) => void
  send: (payload: P) => void
}): StagedSend<P>
export function canUndo(item: StarItem): boolean
```

- [ ] **Step 4: Run test to verify it passes**

Run: `fnm exec --using=24 -- sh -c 'npx vitest run test/star.test.ts && npx tsc --noEmit'`
Expected: PASS — 15 tests green, `tsc --noEmit` silent

- [ ] **Step 5: Commit**

```bash
git add public/star.js public/star.d.ts test/star.test.ts
git commit -m "feat(viewer): safe one-tap star — gating, staged send, undo

Exactly one recommended option or no star; the send is staged with a
cancellable window and refused-undo once reply_seen_at is set."
```

---

### Task 6: Shell skeleton — index.html + style.css (delete the old IA)

This task is the **sole owner of `public/index.html`**. Every downstream requirement is
folded into the markup here — the Needs-you row host, the pause hint, the panel set — so
no later task ever reopens this file. Boards chrome (row toggle, archived fold) is built
in JS by Task 13; the responsive `@media` layer is appended at EOF by Task 18.

**Files:**
- Create: `test/shell.test.ts`
- Modify: `public/index.html:10-39` (replace the header `10-18`, the `#now` strip `19`, the `.layout` wrapper `20`, the sidebar nav `21-29` and the `<details class="section">` stack `30-38` in one block)
- Modify: `public/style.css` — delete lines `8-15` (`.layout` + `#sidebar`), `17` (`.section, [data-card-id]`), `23-25` (`.section > summary`, its `::marker`, the sidebar media query), `29` (`#now`), `47-49` (`.now-head`, `.triage-btn` ×2), `67-71` (`.now-items` ×3, `#now.attention`, `#now.calm`), `85` (`.item.answered`), `93-96` (`#filters`, `#filters .tabs`, `.tab-label`, `#agentTabs/#rowTabs`), `104-106` (`#filters button` ×3), `107-110` (`.item` + the three kind stripes); then append the shell block at EOF
- Modify: `public/app.js` — render head `69-92` and render tail `105-118`; delete `renderNow` (`133-184`); rewrite `jumpToCard` (`312-331`) in place — the filter-clearing fallback is dropped and the function now routes through `selectTab` (Task 8), which is `jumpToCard`'s only real caller (Task 10's board glyph); guard `renderRowToggle` (`381-383`); delete `renderPills` (`402-422`); repoint `renderGroups` (`489-490`); delete `renderSub` (`566-590`) and its four call sites (`517`, `526`, `598`, `607`); delete `renderArchived` (`601-608`); replace `setCount` (`333-340`); add the triage keyboard opener in `initTriage` (`303-305`); delete `COLLAPSE_KEY` + `initSections` (`842-862`); replace the init block (`913-918`)
- Test: `test/shell.test.ts`

Apply the `public/app.js` deletions **bottom-up** (init block first, then `initSections`,
then `renderArchived`, …) so earlier line numbers stay valid while you work.

**Interfaces:**
- Consumes: nothing from earlier tasks (markup only; `public/attention.js`, `public/colors.js` and `public/star.js` are wired in by Tasks 7-10).
- Produces — the DOM contract every later task binds to:
  - `<nav id="rail" role="tablist">` — empty rail host, filled by Task 7
  - `#tabs.tabstrip` containing `button.tab[data-tab]` with `data-tab` ∈ `needsYou|boards|live|notes|done`, each carrying `.tab-count` (`.tab-dot` on `live`)
  - `main > section.panel#<tab>` for all five tabs plus `#setup`
  - `#needsYou > #needsYouList.rows` — the Needs-you row host (Task 10 renders `.nrow` cards into it)
  - `#boards > .boards`, `#live > .live-list`, `#notes > .groups`, `#done > .items`, `#setup > .setup-body`
  - `#status` and, beside it, `#pauseHint` — the poll-suspension hint Task 9 writes into
  - `#agentSelect`, `#search.search-box`, `#gear`
  - JS: `renderAgentSelect(agents: string[]): void`, `initAgentSelect(): void`, `showPanel(id: string): void`, `initGear(): void`, `setCount(id: string, n: number): void`, `jumpToCard(tabId: string, cardId: string): void`
- Deletes for good: `#sidebar`, the `.section` stack, `#now`, `renderNow`, `renderSub`, `renderPills`, `renderArchived`, `initSections`, `COLLAPSE_KEY`. `renderRowToggle` stays (guarded) until Task 13 replaces it with the boards header. `jumpToCard` also stays — rewritten, not deleted (see Step 3).

- [ ] **Step 1: Write the failing test**

```ts
// test/shell.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8')
const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')

describe('shell markup', () => {
  it('drops the section stack and the outline sidebar', () => {
    expect(html).not.toContain('id="sidebar"')
    expect(html).not.toContain('class="section"')
    expect(html).not.toContain('data-sub=')
  })

  it('has the top bar: brand, status + pause hint, agent select, search, gear', () => {
    expect(html).toContain('id="topbar"')
    expect(html).toContain('class="brand"')
    expect(html).toContain('id="status"')
    expect(html).toContain('id="pauseHint"')
    expect(html).toContain('id="agentSelect"')
    expect(html).toContain('id="search"')
    expect(html).toContain('id="gear"')
  })

  it('has a project rail and the five content tabs in spec order', () => {
    expect(html).toContain('id="rail"')
    const tabs = [...html.matchAll(/<button class="tab"[^>]*data-tab="(\w+)"/g)].map((m) => m[1])
    expect(tabs).toEqual(['needsYou', 'boards', 'live', 'notes', 'done'])
  })

  it('gives Live a presence dot and every other tab a count slot', () => {
    expect(html).toMatch(/data-tab="live"[^>]*>[^<]*<span class="tab-dot"/)
    for (const t of ['needsYou', 'boards', 'notes', 'done']) {
      expect(html, t).toMatch(new RegExp(`data-tab="${t}"[^>]*>[^<]*<span class="tab-count"`))
    }
  })

  it('keeps every render host the viewer writes into', () => {
    for (const host of [
      'id="needsYou"', 'id="boards"', 'id="live"', 'id="notes"', 'id="done"', 'id="setup"',
      'id="needsYouList"', 'class="rows"', 'class="live-list"', 'class="groups"',
      'class="boards"', 'class="items"', 'class="setup-body"',
    ]) expect(html, host).toContain(host)
  })

  it('leaves the pieces later tasks build in JS out of the static markup', () => {
    // Task 9 owns the pause hint's text, Task 13 the boards header and the
    // archived fold, Task 18 the responsive layer — none of them reopen this file
    expect(html).not.toContain('id="now"')
    expect(html).not.toContain('id="rowTabs"')
    expect(html).not.toContain('panel-tools')
    expect(html).not.toContain('id="archived"')
    expect(html).not.toContain('archived-fold')
  })
})

describe('shell css', () => {
  it('drops the sidebar, section, now-strip and pill-strip rules', () => {
    expect(css).not.toContain('#sidebar')
    expect(css).not.toContain('#filters')
    expect(css).not.toContain('.section')
    expect(css).not.toContain('#now')
    expect(css).not.toContain('.now-head')
  })

  it('drops the kind-based left stripe', () => {
    expect(css).not.toContain('.item.question')
    expect(css).not.toContain('.item.note')
    expect(css).not.toContain('.item.answered')
    expect(css).not.toContain('border-left-width')
  })

  it('keeps the search box and adds the rail + tabstrip', () => {
    expect(css).toContain('.search-box')
    expect(css).toContain('#rail')
    expect(css).toContain('.tabstrip')
    expect(css).toContain('.panel[hidden]')
  })
})

describe('shell script', () => {
  it('deletes every sidebar-era render path, so nothing calls a symbol that is gone', () => {
    for (const dead of ['renderSub', 'renderPills', 'renderNow', 'initSections', 'COLLAPSE_KEY', 'renderArchived']) {
      expect(js, `${dead} survives`).not.toContain(dead)
    }
  })

  it('keeps the triage deck reachable now that the Now strip is gone', () => {
    expect(js).toContain("e.key === 't'")
    expect(js).toContain('openTriage()')
  })

  it('wires the new shell entry points', () => {
    expect(js).toContain('function renderAgentSelect')
    expect(js).toContain('function showPanel')
    expect(js).toContain('initAgentSelect()')
    expect(js).toContain('initGear()')
    expect(js).toContain('function jumpToCard')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `fnm exec --using=24 -- npx vitest run test/shell.test.ts`
Expected: FAIL — the first assertion blows up with `AssertionError: expected '<!doctype html>…' not to contain 'id="sidebar"'`, and the CSS/JS suites fail with `expected … to contain '#rail'` / `expected … not to contain 'renderSub'`.

- [ ] **Step 3: Write minimal implementation**

Replace `public/index.html:10-39` (everything from `<header>` through the `</div>` that closes `.layout`) with:

```html
  <header id="topbar">
    <div class="brand">Agent Inbox</div>
    <span id="status"></span>
    <span id="pauseHint"></span>
    <label class="agent-pick"><span class="tab-label">agent</span>
      <select id="agentSelect" aria-label="Filter by agent"><option value="">all</option></select>
    </label>
    <input id="search" class="search-box" type="search" placeholder="Search everything…" aria-label="Search items and boards" autocomplete="off" />
    <button id="gear" class="gear" type="button" title="Setup" aria-label="Setup">⚙</button>
  </header>
  <div class="layout">
    <nav id="rail" role="tablist" aria-orientation="vertical" aria-label="Projects"></nav>
    <div class="content">
      <div id="tabs" class="tabstrip" role="tablist" aria-label="Content">
        <button class="tab" type="button" role="tab" data-tab="needsYou" aria-selected="true">Needs you<span class="tab-count" hidden></span></button>
        <button class="tab" type="button" role="tab" data-tab="boards" aria-selected="false">Boards<span class="tab-count" hidden></span></button>
        <button class="tab" type="button" role="tab" data-tab="live" aria-selected="false">Live<span class="tab-dot" hidden></span></button>
        <button class="tab" type="button" role="tab" data-tab="notes" aria-selected="false">Notes<span class="tab-count" hidden></span></button>
        <button class="tab" type="button" role="tab" data-tab="done" aria-selected="false">Done<span class="tab-count" hidden></span></button>
      </div>
      <main>
        <section class="panel" id="needsYou" role="tabpanel"><div id="needsYouList" class="rows"></div></section>
        <section class="panel" id="boards" role="tabpanel" hidden><div class="boards"></div></section>
        <section class="panel" id="live" role="tabpanel" hidden><div class="live-list"></div></section>
        <section class="panel" id="notes" role="tabpanel" hidden><div class="groups"></div></section>
        <section class="panel" id="done" role="tabpanel" hidden><div class="items"></div></section>
        <section class="panel" id="setup" role="tabpanel" hidden><div class="setup-body"></div></section>
      </main>
    </div>
  </div>
```

In `public/style.css`, delete these exact lines:

```css
.layout { display: flex; gap: 28px; align-items: flex-start; }
#sidebar { position: sticky; top: 60px; display: flex; flex-direction: column; gap: 8px; width: 170px; flex-shrink: 0; padding-top: 24px; max-height: calc(100vh - 84px); overflow-y: auto; }
#sidebar a { font-size: 13px; text-decoration: none; color: inherit; opacity: .6; }
#sidebar a:hover { opacity: 1; }
#sidebar .nav-group { display: flex; flex-direction: column; }
#sidebar .sub { display: flex; flex-direction: column; gap: 2px; margin: 3px 0 2px 5px; padding-left: 8px; border-left: 1px solid color-mix(in srgb, CanvasText 15%, transparent); }
#sidebar .sub a { font-size: 12px; opacity: .45; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#sidebar .sub:empty { display: none; }
.section, [data-card-id] { scroll-margin-top: 60px; }
.section > summary { cursor: pointer; margin: 24px 0 8px; list-style-position: outside; }
.section > summary::marker { color: color-mix(in srgb, CanvasText 40%, transparent); font-size: 11px; }
@media (max-width: 700px) { #sidebar { display: none; } }
#now { font-size: 13.5px; padding: 8px 14px; border-radius: 8px; margin-bottom: 6px; }
.now-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.triage-btn { font-size: 12px; padding: 3px 14px; border-radius: 999px; border: 1px solid color-mix(in srgb, crimson 45%, transparent); background: transparent; color: inherit; cursor: pointer; font-weight: 600; white-space: nowrap; }
.triage-btn:hover { border-color: crimson; }
.now-items { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-top: 4px; }
.now-items a { color: inherit; font-size: 12.5px; text-decoration: underline dotted; text-underline-offset: 3px; opacity: .85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 46ch; }
.now-items a:hover { opacity: 1; }
#now.attention { background: color-mix(in srgb, crimson 12%, transparent); border: 1px solid color-mix(in srgb, crimson 35%, transparent); color: color-mix(in srgb, crimson 72%, CanvasText); }
#now.calm { background: color-mix(in srgb, seagreen 8%, transparent); border: 1px solid color-mix(in srgb, seagreen 22%, transparent); opacity: .8; }
.item.answered { border-left-color: seagreen; opacity: .85; }
#filters { display: flex; gap: 12px; margin-left: auto; align-items: center; flex-wrap: wrap; }
#filters .tabs { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.tab-label { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; opacity: .45; margin-right: 2px; }
#agentTabs:not(:empty), #rowTabs:not(:empty) { border-left: 1px solid color-mix(in srgb, CanvasText 20%, transparent); padding-left: 12px; }
#filters button { font-size: 12px; padding: 2px 11px; border-radius: 999px; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); background: transparent; cursor: pointer; opacity: .6; }
#filters button:hover { opacity: 1; }
#filters button.active { opacity: 1; border-color: LinkText; color: LinkText; }
.item { border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); border-left-width: 3px; border-radius: 8px; padding: 10px 12px; margin-bottom: var(--gap); }
.item.question { border-left-color: crimson; }
.item.note { border-left-color: goldenrod; }
.item.done { border-left-color: seagreen; }
```

Then append the shell block to `public/style.css` (it re-homes `.tab-label`, the `[data-card-id]` scroll margin and the stripe-less `.item`). No `@media` block here — Task 18 appends the whole responsive layer at EOF:

```css
/* ── shell: top bar · project rail · content tabs ── */
#topbar { display: flex; align-items: center; gap: 12px; padding: 12px 0; }
.brand { font-size: 15px; font-weight: 700; }
#pauseHint { font-size: 12px; opacity: .55; }
.tab-label { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; opacity: .45; margin-right: 2px; }
.agent-pick { display: flex; align-items: center; gap: 6px; margin-left: auto; }
#agentSelect { font: inherit; font-size: 12.5px; padding: 3px 8px; border-radius: 6px; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); background: Canvas; color: inherit; }
.gear { font-size: 15px; line-height: 1; padding: 4px 8px; border-radius: 6px; border: 1px solid transparent; background: transparent; color: inherit; cursor: pointer; opacity: .55; }
.gear:hover, .gear.active { opacity: 1; border-color: color-mix(in srgb, CanvasText 25%, transparent); }
.layout { display: flex; gap: 24px; align-items: flex-start; }
#rail { position: sticky; top: 56px; width: 176px; flex-shrink: 0; display: flex; flex-direction: column; gap: 2px; padding-top: 8px; max-height: calc(100vh - 72px); overflow-y: auto; }
.content { flex: 1; min-width: 0; }
.tabstrip { display: flex; gap: 4px; border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent); margin-bottom: 10px; overflow-x: auto; }
.tab { font: inherit; font-size: 13px; padding: 7px 12px; border: none; border-bottom: 2px solid transparent; background: transparent; color: inherit; opacity: .55; cursor: pointer; white-space: nowrap; }
.tab:hover { opacity: .85; }
.tab[aria-selected="true"] { opacity: 1; font-weight: 600; border-bottom-color: LinkText; }
.tab-count { margin-left: 6px; font-size: 11.5px; font-variant-numeric: tabular-nums; padding: 0 6px; border-radius: 999px; background: color-mix(in srgb, CanvasText 12%, transparent); }
.tab-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-left: 7px; background: seagreen; vertical-align: middle; }
.tab-count[hidden], .tab-dot[hidden] { display: none; }
.panel[hidden] { display: none; }
.rows { display: flex; flex-direction: column; gap: 6px; }
[data-card-id] { scroll-margin-top: 64px; }
.item { border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); border-radius: 8px; padding: 10px 12px; margin-bottom: var(--gap); }
```

In `public/app.js`, the render head (`app.js:69-92`) loses both pill strips and the Now strip:

```js
function render() {
  const projects = collectProjects(lastData)
  if (projectFilter && !projects.includes(projectFilter)) projectFilter = null
  const agents = collectAgents(projectScoped(lastData))
  if (agentFilter && !agents.includes(agentFilter)) agentFilter = null
  renderAgentSelect(agents)
  renderRowToggle()
  // prune collapse state against ALL cards, not the filtered view, so
  // switching tabs never drops state for cards the filter is hiding
  liveCardIds = new Set([...allItems(lastData.g).map((i) => i.id), ...lastData.boards.map((b) => b.id), ...lastData.archived.map((b) => b.id)])
```

and the render tail (`app.js:105-118`) drops the archived render + count — Task 13 rebuilds the archived fold inside the Boards panel and re-adds both:

```js
  renderLive(live)
  setCount('live', live.filter((a) => !a.idle).length)
  renderGroups('needsYou', g.needsYou)
  renderGroups('notes', g.notes)
  renderDone(g.done)
  renderBoards(boards)
  setCount('needsYou', g.needsYou.reduce((n, gr) => n + gr.items.filter((i) => !i.reply).length, 0))
  setCount('notes', g.notes.reduce((n, gr) => n + gr.items.length, 0))
  setCount('done', g.done.length)
  setCount('boards', boards.length)
  pruneCollapsedCards()
  renderTriage() // keep the open lightbox in sync with fresh data
}
```

Delete `renderNow` (`app.js:133-184`) outright — the `#now` strip it served is gone. `jumpToCard` (`app.js:312-331`) survives: it is the only address a caller needs to land on a `[data-card-id]` element, and Task 10's board glyph calls it.

`renderNow` also held the only "Triage →" button, so give the deck a keyboard door. Replace the `keydown` listener inside `initTriage` (`app.js:303-308`):

```js
  document.addEventListener('keydown', (e) => {
    const typing = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA'
    // 't' opens the triage deck — the Now strip's button went with the strip
    if (!triageDeck && !typing && e.key === 't') { openTriage(); return }
    if (!triageDeck) return
    if (e.key === 'Escape') closeTriage()
    else if (!typing && e.key === 'ArrowLeft' && triageDeck.index > 0) { triageDeck.index--; renderTriage() }
    else if (!typing && e.key === 'ArrowRight' && triageDeck.index < triageDeck.entries.length - 1) { triageDeck.index++; renderTriage() }
  })
```

Rewrite `jumpToCard` (`app.js:312-331`) in place — the filter-clearing fallback is
dropped (with a rail, silently resetting the user's project filter is wrong) and it
routes through `selectTab` instead. `selectTab` is Task 8's function; nothing calls
`jumpToCard` until Task 10's board glyph, so the forward reference resolves by the
time it is ever invoked at runtime:

```js
function jumpToCard(tabId, cardId) {
  selectTab(tabId)
  const card = document.querySelector(`[data-card-id="${CSS.escape(cardId)}"]`)
  if (!card) return
  if (card instanceof HTMLDetailsElement) card.open = true
  card.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
```

Replace `setCount` (`app.js:333-340`) — counts now live on the tab strip, and there is no `archived` branch because the fold is Task 13's, built in JS:

```js
function setCount(id, n) {
  const el = document.querySelector(`.tab[data-tab="${id}"] .tab-count`)
  if (!el) return // Live carries a presence dot, not a number
  el.textContent = n ? String(n) : ''
  el.hidden = !n
}
```

Guard `renderRowToggle` (`app.js:381-383`) so it no-ops until Task 13 gives it a home — `#rowTabs` is not in the markup any more:

```js
function renderRowToggle() {
  const host = document.getElementById('rowTabs')
  if (!host) return // the boards header that hosts this arrives in Task 13
  const sig = String(hideCompleted)
```

Delete `renderPills` (`app.js:402-422`) — the project strip becomes the rail (Task 7) and the agent strip becomes the select below.

Repoint `renderGroups` (`app.js:489-490`) at the Needs-you row host:

```js
function renderGroups(sectionId, groups) {
  // Needs-you owns a dedicated row host; Notes keeps the grouped layout
  const host = sectionId === 'needsYou'
    ? document.getElementById('needsYouList')
    : document.querySelector(`#${sectionId} .groups`)
```

Delete `renderSub` (`app.js:566-590`) and its four call sites (`app.js:517`, `app.js:526`, `app.js:598`, `app.js:607`) — the `#sidebar .sub` outline it rendered no longer exists. Delete `renderArchived` (`app.js:601-608`) with them: it wrote into `#archived .boards`, which Task 13 recreates in JS.

Add next to `renderRowToggle` (before `app.js:402`):

```js
// the top bar's agent filter — a demoted dropdown scoped to the selected project.
// option text goes through textContent, never innerHTML: agent names are agent-authored.
function renderAgentSelect(agents) {
  const sel = document.getElementById('agentSelect')
  const sig = JSON.stringify([agents, agentFilter])
  if (sel.dataset.sig === sig) return
  sel.dataset.sig = sig
  sel.innerHTML = ''
  for (const v of [null, ...agents]) {
    const o = document.createElement('option')
    o.value = v ?? ''
    o.textContent = v ?? 'all'
    if (v === agentFilter) o.selected = true
    sel.appendChild(o)
  }
}

function initAgentSelect() {
  document.getElementById('agentSelect').addEventListener('change', (e) => {
    agentFilter = e.target.value || null
    if (agentFilter) localStorage.setItem(FILTER_KEY, agentFilter)
    else localStorage.removeItem(FILTER_KEY)
    resetPaging()
    render()
  })
}

// which content panel is visible; the tab strip drives this in Task 8
function showPanel(id) {
  for (const p of document.querySelectorAll('main > .panel')) p.hidden = p.id !== id
  for (const t of document.querySelectorAll('#tabs .tab')) t.setAttribute('aria-selected', String(t.dataset.tab === id))
  document.getElementById('gear').classList.toggle('active', id === 'setup')
}

function initGear() {
  document.getElementById('gear').addEventListener('click', () => showPanel('setup'))
}
```

Delete `COLLAPSE_KEY` and `initSections` (`app.js:842-862`): both the `details.section` stack and the `#sidebar` links they wired are gone. Per-card collapse (`collapsedCards`, `pruneCollapsedCards`) is a separate mechanism and stays.

Replace the init block (`app.js:913-918`) — note `initSections()` is gone, not merely reordered; calling it would throw `ReferenceError`:

```js
initTriage()
initSearch()
initAgentSelect()
initGear()
renderSetup()
load()
setInterval(load, 3000)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `fnm exec --using=24 -- npx vitest run test/shell.test.ts test/search.test.ts test/group.test.ts`
Expected: PASS — the shell suite is green and the existing viewer-module suites are untouched.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/style.css public/app.js test/shell.test.ts
git commit -m "feat(viewer): replace the section stack and sidebar with a rail + tabs shell

index.html gets its final shape here — rail host, five panels, the
Needs-you row host and the pause hint — so no later task reopens it.
The Now strip, the sidebar outline and the pill strips are deleted along
with renderNow/renderSub/renderPills/initSections; jumpToCard is rewritten
to route through the tab system instead of clearing filters; the triage
deck moves to a 't' shortcut."
```

---
### Task 7: Project rail rendering

**Files:**
- Create: `public/rail.js`
- Modify: `public/app.js:1` (imports — edit the existing `/attention.js` import line rather than adding a second one), `public/app.js:69-71` (render head — project list → `renderRail()`), `public/app.js:402-422` (delete `renderPills`), `public/app.js:49-55` (delete `collectProjects` — superseded by `railProjects`)
- Modify: `public/style.css` (append rail rules at EOF — plain rules only, **no `@media` block**: responsive is Task 18's exclusive append)
- Test: `test/rail.test.ts`

**Interfaces:**
- Consumes: `countsByProject(items, boards, nowMs, liveSessionIds) -> Map<string, {total:number, escalated:number}>` from `public/attention.js`; `projectColor(name, theme) -> { dot, wash }` from `public/colors.js`; the `<nav id="rail">` host and `PROJECT_KEY` / `resetPaging()` / `render()` from Task 6.
- Produces (module `public/rail.js`): `railProjects({ items, boards, archived, activity }) -> string[]` (unique, sorted, `'unknown'` last); `railEntries(projects, counts) -> Array<{ key, label, total, escalated, unknown }>` (`key === '__all__'` first); `filterRailEntries(entries, query) -> entries` (`'__all__'` always retained); `shouldShowRailFilter(projects) -> boolean` (more than 12 projects).
- Produces (app.js, declared **once here** and consumed by later tasks): `liveSessionIds(): Set<string>`, `themeName(): 'dark'|'light'`, `pcolor(name: string) -> { dot, wash }` (the persisted-color call path — every renderer that paints a project dot/wash goes through this, never `projectColor()` directly, so a project's hue survives a reload; `overrideHue` is exported by `public/colors.js` and reachable for a future override UI — none is built here), `renderRail(): void`.
- Produces (DOM contract — later tasks bind to exactly this, nothing else):
  - `#rail > button.rail-tab[data-project="<key>"][role="tab"][aria-selected]`, where `<key>` is the project name or `__all__`.
  - Each `button.rail-tab` contains, in order: `span.rail-dot`, `span.rail-name`, `span.rail-badge`, `span.rail-match`.
  - `span.rail-match` is always present and empty here — Task 15's search paints the per-project match count into it.
  - `input.rail-filter` is rendered as the FIRST child of `#rail` when `shouldShowRailFilter(projects)` is true.
- Deletes permanently: `collectProjects`, `renderPills`. No later task may call or re-anchor an edit to them.

- [ ] **Step 1: Write the failing test**

```ts
// test/rail.test.ts
import { describe, it, expect } from 'vitest'
import { railProjects, railEntries, filterRailEntries, shouldShowRailFilter } from '../public/rail.js'

describe('railProjects', () => {
  it('includes a project whose only trace is a live session', () => {
    const projects = railProjects({
      items: [{ project: 'api' }],
      boards: [],
      archived: [],
      activity: [{ session: 's1', project: 'ghost' }],
    })
    expect(projects).toEqual(['api', 'ghost'])
  })

  it('dedupes across items, boards, archived and activity', () => {
    const projects = railProjects({
      items: [{ project: 'web' }, { project: 'web' }],
      boards: [{ project: 'web' }],
      archived: [{ project: 'api' }],
      activity: [{ session: 's1', project: 'api' }],
    })
    expect(projects).toEqual(['api', 'web'])
  })

  it('pins unknown to the bottom even though it sorts mid-alphabet', () => {
    const projects = railProjects({ items: [{ project: 'zeta' }, { project: 'unknown' }, { project: 'api' }] })
    expect(projects).toEqual(['api', 'zeta', 'unknown'])
  })

  it('tolerates missing collections', () => {
    expect(railProjects({})).toEqual([])
    expect(railProjects()).toEqual([])
  })
})

describe('railEntries', () => {
  const counts = new Map([
    ['api', { total: 3, escalated: 1 }],
    ['web', { total: 2, escalated: 0 }],
  ])

  it('pins All first with the summed global totals', () => {
    const entries = railEntries(['api', 'web'], counts)
    expect(entries[0]).toEqual({ key: '__all__', label: 'All', total: 5, escalated: 1, unknown: false })
    expect(entries.map((e) => e.key)).toEqual(['__all__', 'api', 'web'])
  })

  it('gives projects with no attention a zero badge rather than dropping them', () => {
    const entries = railEntries(['api', 'quiet'], counts)
    expect(entries.find((e) => e.key === 'quiet')).toEqual({ key: 'quiet', label: 'quiet', total: 0, escalated: 0, unknown: false })
  })

  it('flags the unknown pseudo-project', () => {
    const entries = railEntries(['api', 'unknown'], counts)
    expect(entries.at(-1)!.unknown).toBe(true)
    expect(entries.find((e) => e.key === 'api')!.unknown).toBe(false)
  })
})

describe('shouldShowRailFilter', () => {
  const names = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`)

  it('stays hidden at twelve projects and appears at thirteen', () => {
    expect(shouldShowRailFilter(names(12))).toBe(false)
    expect(shouldShowRailFilter(names(13))).toBe(true)
  })

  it('is hidden for an empty or missing list', () => {
    expect(shouldShowRailFilter([])).toBe(false)
    expect(shouldShowRailFilter(undefined)).toBe(false)
  })
})

describe('filterRailEntries', () => {
  const entries = [
    { key: '__all__', label: 'All', total: 5, escalated: 1, unknown: false },
    { key: 'agent-inbox', label: 'agent-inbox', total: 3, escalated: 1, unknown: false },
    { key: 'web', label: 'web', total: 2, escalated: 0, unknown: false },
  ]

  it('returns everything for an empty or whitespace query', () => {
    expect(filterRailEntries(entries, '')).toEqual(entries)
    expect(filterRailEntries(entries, '   ')).toEqual(entries)
    expect(filterRailEntries(entries, undefined)).toEqual(entries)
  })

  it('matches case-insensitively on a substring of the label', () => {
    expect(filterRailEntries(entries, 'INBOX').map((e) => e.key)).toEqual(['__all__', 'agent-inbox'])
  })

  it('always retains All, even when nothing else matches', () => {
    expect(filterRailEntries(entries, 'zzz').map((e) => e.key)).toEqual(['__all__'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `fnm exec --using=24 -- npx vitest run test/rail.test.ts`
Expected: FAIL — `Error: Failed to load url ../public/rail.js` (Cannot find module `public/rail.js`).

- [ ] **Step 3: Write minimal implementation**

Create `public/rail.js`:

```js
// Pure rail helpers: which projects get a vertical tab, in what order, what
// badge each carries, and how the typed filter narrows them. No DOM and no
// imports, so this is unit-testable in Node.

// Every project the user can filter by. `activity` matters: a project whose only
// trace is a LIVE session still deserves a rail tab — the old pill strip dropped
// it, which is a bug once the rail is the primary navigation.
// 'unknown' always sorts last so the viewer can pin it to the foot.
export function railProjects({ items = [], boards = [], archived = [], activity = [] } = {}) {
  const names = new Set()
  for (const x of [...items, ...boards, ...archived, ...activity]) if (x && x.project) names.add(x.project)
  const rest = [...names].filter((n) => n !== 'unknown').sort()
  return names.has('unknown') ? [...rest, 'unknown'] : rest
}

// Rail rows: an All pseudo-project pinned top carrying the GLOBAL totals, then
// each project in railProjects order. `counts` is the Map from countsByProject().
export function railEntries(projects, counts) {
  const rows = projects.map((p) => {
    const c = counts.get(p) ?? { total: 0, escalated: 0 }
    return { key: p, label: p, total: c.total, escalated: c.escalated, unknown: p === 'unknown' }
  })
  return [{
    key: '__all__',
    label: 'All',
    total: rows.reduce((n, r) => n + r.total, 0),
    escalated: rows.reduce((n, r) => n + r.escalated, 0),
    unknown: false,
  }, ...rows]
}

// A rail longer than a dozen projects stops being scannable; past that we offer
// a type-to-narrow box. Twelve fits a laptop viewport without scrolling.
export const RAIL_FILTER_THRESHOLD = 12

export function shouldShowRailFilter(projects) {
  return (projects?.length ?? 0) > RAIL_FILTER_THRESHOLD
}

// Narrow the rail by typed query. 'All' is never filtered out — losing the
// escape hatch back to the unfiltered view would strand the user.
export function filterRailEntries(entries, query) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return entries
  return entries.filter((e) => e.key === '__all__' || String(e.label).toLowerCase().includes(q))
}
```

In `public/app.js:1`, add the rail/colors imports and EXTEND the existing `/attention.js` import line (one import statement per module — never a second one):

```js
import { paginate, paginateGroups, searchMatches } from '/search.js'
import { filterRailEntries, railEntries, railProjects, shouldShowRailFilter } from '/rail.js'
import { countsByProject } from '/attention.js'
import { projectColor } from '/colors.js'
```

Delete `collectProjects` (`app.js:49-55`) and `renderPills` (`app.js:402-422`) — both are superseded — and replace the render head's project lines (`app.js:69-71`) with:

```js
function render() {
  renderRail()
```

Add `renderRail` and the two shared session helpers next to `renderAgentSelect`. `liveSessionIds` and `themeName` are declared HERE and nowhere else; later tasks consume these bindings:

```js
const liveSessionIds = () => new Set((lastData.activity ?? []).map((a) => a.session))
const themeName = () => (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')

// spec §2: color persistence. Every caller that paints a project dot/wash goes
// through THIS, never projectColor() directly — passing localStorage is what
// lets assignedHue() persist a hue across reloads and nudge a collision once,
// instead of re-hashing (and potentially re-colliding) on every render.
const pcolor = (name) => projectColor(name, themeName(), localStorage)

// typed rail filter; only rendered when the rail is long enough to need it
let railQuery = ''

// Projects as vertical tabs: color dot · name · per-project attention badge ·
// an empty match slot the search fills in later. The badges are per-project by
// design; the dock badge and the Needs-you tab count stay global (spec §7
// filter-blindness).
function renderRail() {
  const host = document.getElementById('rail')
  if (!host) return
  const projects = railProjects({
    items: allItems(lastData.g),
    boards: lastData.boards,
    archived: lastData.archived,
    activity: lastData.activity ?? [],
  })
  if (projectFilter && !projects.includes(projectFilter)) {
    projectFilter = null
    localStorage.removeItem(PROJECT_KEY)
  }
  const counts = countsByProject(allItems(lastData.g), lastData.boards, Date.now(), liveSessionIds())
  const withFilter = shouldShowRailFilter(projects)
  if (!withFilter) railQuery = ''
  const entries = filterRailEntries(railEntries(projects, counts), railQuery)
  const th = themeName()
  const sig = JSON.stringify([entries, projectFilter, th, withFilter, railQuery])
  if (host.dataset.sig === sig) return
  // rebuilding blows away focus; remember the caret so typing in the filter survives
  const active = document.activeElement
  const caret = active && active.classList.contains('rail-filter') ? active.selectionStart : null
  host.dataset.sig = sig
  host.innerHTML = ''
  if (withFilter) {
    const f = document.createElement('input')
    f.type = 'search'
    f.className = 'rail-filter'
    f.placeholder = 'Filter projects'
    f.setAttribute('aria-label', 'Filter projects')
    f.value = railQuery
    f.addEventListener('input', () => { railQuery = f.value; renderRail() })
    host.appendChild(f)
    if (caret !== null) { f.focus(); f.setSelectionRange(caret, caret) }
  }
  for (const e of entries) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'rail-tab'
    b.dataset.project = e.key // '__all__' for the unfiltered view
    b.setAttribute('role', 'tab')
    const selected = e.key === '__all__' ? !projectFilter : projectFilter === e.key
    b.setAttribute('aria-selected', String(selected))
    if (!e.total) b.classList.add('quiet')
    const color = e.key === '__all__' || e.unknown ? null : pcolor(e.key)
    if (e.unknown) {
      b.classList.add('unknown')
      b.title = 'Project inference failed for these agents — a register() call fixes their scope.'
    }
    // selection is a soft wash of the project's own color; no stripe anywhere
    if (selected && color) b.style.background = color.wash
    const dot = document.createElement('span')
    dot.className = e.key === '__all__' ? 'rail-dot all' : 'rail-dot'
    if (color) dot.style.background = color.dot
    const name = document.createElement('span')
    name.className = 'rail-name'
    name.textContent = e.label // agent-authored: textContent, never innerHTML
    name.title = e.label
    const badge = document.createElement('span')
    badge.className = e.escalated ? 'rail-badge escalated' : 'rail-badge'
    badge.textContent = e.total ? String(e.total) : ''
    badge.hidden = !e.total
    badge.title = e.escalated ? `${e.escalated} escalated` : `${e.total} waiting on you`
    // always present, always empty here — Task 15's search paints match counts in
    const match = document.createElement('span')
    match.className = 'rail-match'
    b.append(dot, name, badge, match)
    b.addEventListener('click', () => {
      projectFilter = e.key === '__all__' ? null : e.key
      if (projectFilter) localStorage.setItem(PROJECT_KEY, projectFilter)
      else localStorage.removeItem(PROJECT_KEY)
      resetPaging()
      render()
    })
    host.appendChild(b)
  }
}
```

Append to `public/style.css` (plain rules at EOF — no `@media` block here):

```css
.rail-filter { width: 100%; margin-bottom: 6px; padding: 4px 8px; border: 1px solid color-mix(in srgb, CanvasText 14%, transparent); border-radius: 7px; background: transparent; color: inherit; font: inherit; font-size: 12px; }
.rail-tab { display: flex; align-items: center; gap: 8px; width: 100%; padding: 5px 9px; border: none; border-radius: 7px; background: transparent; color: inherit; font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.rail-tab:hover { background: color-mix(in srgb, CanvasText 6%, transparent); }
.rail-tab.quiet { opacity: .5; }
.rail-tab[aria-selected="true"] { opacity: 1; font-weight: 600; }
.rail-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; background: color-mix(in srgb, CanvasText 35%, transparent); }
.rail-dot.all { background: linear-gradient(135deg, color-mix(in srgb, CanvasText 55%, transparent), color-mix(in srgb, CanvasText 18%, transparent)); }
.rail-tab.unknown .rail-dot { background: color-mix(in srgb, CanvasText 28%, transparent); }
.rail-tab.unknown .rail-name { font-style: italic; opacity: .75; }
.rail-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rail-badge { font-size: 11px; font-variant-numeric: tabular-nums; padding: 0 6px; border-radius: 999px; background: color-mix(in srgb, CanvasText 12%, transparent); }
.rail-badge.escalated { background: color-mix(in srgb, crimson 18%, transparent); color: color-mix(in srgb, crimson 80%, CanvasText); font-weight: 600; }
.rail-match { font-size: 11px; font-variant-numeric: tabular-nums; opacity: .6; }
.rail-match:empty { display: none; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `fnm exec --using=24 -- npx vitest run test/rail.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add public/rail.js public/app.js public/style.css test/rail.test.ts
git commit -m "feat(viewer): render projects as a color-coded rail with attention badges

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Content tabs, routing and the filter-blind counts

**Files:**
- Create: `public/tabs.js`
- Modify: `public/app.js:1` (imports — EDIT the existing `/attention.js` import line, add one `/tabs.js` line), `public/app.js:104-115` (count wiring in `render`), `public/app.js:333-340` (`setCount` null guard — `jumpToCard` is Task 6's function, not touched here), the app.js bottom init block (rewritten in full here — **this task owns it**)
- Test: `test/tabs.test.ts`

**Interfaces:**
- Consumes: `attentionCount(items, boards, nowMs, liveSessionIds) -> number` from `public/attention.js`; the private `showPanel(id)` helper, `setCount(id, n)` and the `#tabs .tab[data-tab]` markup from Task 6; `liveSessionIds()` from Task 7.
- Produces (module `public/tabs.js`): `TAB_IDS: string[]`, `DEFAULT_TAB: 'needsYou'`, `tabCounts({ globalAttention, unreadNotes, scoped }) -> { needsYou:number, boards:number, live:null, notes:number, done:number }`, `livePresence(activity) -> boolean`. **No `titlePrefix`** — the dock/document badge belongs to `titleWithBadge()` in Task 16, and `public/tabs.js` must never export a second title helper.
- Produces (app.js, declared **once here**): `activeTab`, `selectTab(id)` — the single routing entry point, it sets `activeTab` AND shows the panel — plus `initTabs()`, `setPresence(present)`. `showPanel` stays private to Task 6's shell; every later task routes through `selectTab`.
- Owns: the bottom init block of `public/app.js`. Later tasks insert **exactly one line** into it and never re-quote it.

- [ ] **Step 1: Write the failing test**

```ts
// test/tabs.test.ts
import { describe, it, expect } from 'vitest'
import { TAB_IDS, DEFAULT_TAB, tabCounts, livePresence } from '../public/tabs.js'
import { attentionCount } from '../public/attention.js'

const NOW = Date.parse('2026-07-24T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

const items = [
  { id: 'q1', kind: 'question', status: 'open', project: 'api', session: 's1', created_at: ago(10 * 60000), reply: null },
  { id: 'q2', kind: 'question', status: 'open', project: 'web', session: 's2', created_at: ago(10 * 60000), reply: null },
]
const boards = [
  { id: 'b1', project: 'api', title: 'Rollout', rows: [{ id: 'r1', label: 'deploy', status: 'blocked' }] },
]

describe('tab model', () => {
  it('boots to Needs you and lists the five content tabs in order', () => {
    expect(DEFAULT_TAB).toBe('needsYou')
    expect(TAB_IDS).toEqual(['needsYou', 'boards', 'live', 'notes', 'done'])
    expect(TAB_IDS[0]).toBe(DEFAULT_TAB)
  })

  it('gives Live no number — presence is a dot', () => {
    const c = tabCounts({ globalAttention: 0, unreadNotes: 0, scoped: { boards: [], done: [] } })
    expect(c.live).toBeNull()
    expect(livePresence([{ session: 's1', idle: true }])).toBe(false)
    expect(livePresence([{ session: 's1', idle: true }, { session: 's2', idle: false }])).toBe(true)
    expect(livePresence(undefined)).toBe(false)
  })

  it('counts the scoped view for boards and done, and takes notes as a precomputed number', () => {
    const c = tabCounts({
      globalAttention: 7,
      unreadNotes: 2,
      scoped: { boards: [{ id: 'b1' }], done: [{ id: 'd1' }] },
    })
    expect(c).toEqual({ needsYou: 7, boards: 1, live: null, notes: 2, done: 1 })
  })

  it('treats a missing notes number as zero rather than NaN', () => {
    expect(tabCounts({ globalAttention: 0, scoped: { boards: [], done: [] } }).notes).toBe(0)
  })
})

describe('filter-blindness invariant (spec §7)', () => {
  const live = new Set(['s1'])
  const global = attentionCount(items as never, boards as never, NOW, live)

  it('the Needs-you tab count ignores the project filter that empties the list', () => {
    const scopedToApi = { boards: boards.filter((b) => b.project === 'api'), done: [] }
    const scopedToNothing = { boards: [], done: [] }
    expect(global).toBeGreaterThan(1) // api + web both contribute
    expect(tabCounts({ globalAttention: global, unreadNotes: 0, scoped: scopedToApi }).needsYou).toBe(global)
    expect(tabCounts({ globalAttention: global, unreadNotes: 0, scoped: scopedToNothing }).needsYou).toBe(global)
    expect(tabCounts({ globalAttention: global, unreadNotes: 0, scoped: scopedToNothing }).boards).toBe(0)
  })

  it('scoping to one project still narrows every non-global count', () => {
    const apiOnly = tabCounts({ globalAttention: global, unreadNotes: 1, scoped: { boards: boards.filter((b) => b.project === 'api'), done: [] } })
    expect(apiOnly.boards).toBe(1)
    expect(apiOnly.notes).toBe(1)
    expect(apiOnly.done).toBe(0)
    expect(apiOnly.needsYou).toBe(global) // the one count the filter may never touch
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `fnm exec --using=24 -- npx vitest run test/tabs.test.ts -t 'boots to Needs you'`
Expected: FAIL — `Error: Failed to load url ../public/tabs.js` (Cannot find module `public/tabs.js`).

- [ ] **Step 3: Write minimal implementation**

Create `public/tabs.js`:

```js
// Pure tab model for the content tabs. Dependency-free (Node-testable): the
// attention count is INJECTED rather than imported, so the filter-blindness
// rule is stated here instead of hiding inside a call site.

export const TAB_IDS = ['needsYou', 'boards', 'live', 'notes', 'done']

// the active tab is never persisted — the app always opens where the action is
export const DEFAULT_TAB = 'needsYou'

// `globalAttention` is the §7 predicate over UNFILTERED data; `scoped` is the
// project/agent/search-narrowed view; `unreadNotes` is an ALREADY-COMPUTED
// number (the caller decides what "unread" means). Needs-you is filter-blind by
// construction: selecting a project narrows the list, never the global signal.
// `live` is null on purpose — Live gets a presence dot; numbers are reserved for
// things that actually want you.
export function tabCounts({ globalAttention, unreadNotes, scoped }) {
  return {
    needsYou: globalAttention,
    boards: scoped.boards.length,
    live: null,
    notes: unreadNotes ?? 0,
    done: scoped.done.length,
  }
}

export function livePresence(activity) {
  return (activity ?? []).some((a) => !a.idle)
}
```

In `public/app.js:1`, EDIT the existing attention import to add `attentionCount`, and add the tabs import:

```js
import { attentionCount, countsByProject } from '/attention.js'
import { DEFAULT_TAB, TAB_IDS, livePresence, tabCounts } from '/tabs.js'
```

Replace the count wiring in `render()` (`app.js:104-115`, keeping `renderLive`/`renderGroups`/`renderDone`/`renderBoards` in place — Task 6 already deleted `renderArchived`, and no task re-adds it until Task 13 folds archived boards into `renderBoards` itself):

```js
  renderLive(live)
  renderGroups('needsYou', g.needsYou)
  renderGroups('notes', g.notes)
  renderDone(g.done)
  renderBoards(boards)
  // Needs-you counts the GLOBAL attention set; every other tab counts the
  // filtered view the user is actually looking at (spec §7)
  const counts = tabCounts({
    globalAttention: attentionCount(allItems(lastData.g), lastData.boards, Date.now(), liveSessionIds()),
    unreadNotes: g.notes.reduce((n, gr) => n + gr.items.length, 0),
    scoped: { boards, done: g.done },
  })
  for (const id of TAB_IDS) setCount(id, counts[id])
  setPresence(livePresence(live))
```

The document/dock badge is deliberately NOT set here — Task 16 owns it via `titleWithBadge()`.
There is no `setCount('archived', …)` call — the archived fold has no tab of its own; Task 13
builds it inside the Boards panel.

Add the null guard as the FIRST line of Task 6's `setCount` body, above the existing
`const el = document.querySelector(...)` line (Task 6 already ships this function with no
`archived` branch, so there is nothing to delete here):

```js
function setCount(id, n) {
  if (n == null) return // Live carries a presence dot, not a number
  const el = document.querySelector(`.tab[data-tab="${id}"] .tab-count`)
```

Add the presence + routing helpers beside it. `selectTab` is the ONLY way anything changes tabs — it owns `activeTab` and delegates the DOM swap to Task 6's private `showPanel`:

```js
function setPresence(present) {
  const dot = document.querySelector('.tab[data-tab="live"] .tab-dot')
  if (dot) dot.hidden = !present
}

// project selection persists (Task 7); the active tab deliberately does not
let activeTab = DEFAULT_TAB

// single routing entry point: state + DOM together, so no caller can set one
// without the other
function selectTab(id) {
  if (!TAB_IDS.includes(id)) return
  activeTab = id
  for (const t of document.querySelectorAll('#tabs .tab')) {
    t.setAttribute('aria-selected', String(t.dataset.tab === id))
  }
  showPanel(id)
}

function initTabs() {
  for (const t of document.querySelectorAll('#tabs .tab')) {
    t.addEventListener('click', () => selectTab(t.dataset.tab))
  }
  selectTab(activeTab)
}
```

`jumpToCard` is not touched here — Task 6 owns it and already routes it through `selectTab`.

- [ ] **Step 4: Write the canonical init block (this task owns it)**

Replace the whole bottom init block of `public/app.js` with the block below. `initSections` and `COLLAPSE_KEY` are already gone (deleted in Task 6) — do not re-add or re-anchor to them.

The comment states the FINAL canonical order for the whole plan. Every later task inserts **exactly one line** at its slot in that order and re-quotes nothing:

```js
// ── init ────────────────────────────────────────────────────────────────────
// Canonical order for the finished app; later tasks add their one line at the
// slot named here and never rewrite this block:
//   initTabs → initTriage → initSearch → initAgentSelect → initGear →
//   initListStaging (Task 9) → initKeys (Task 17) → initFocusHash (Task 17) →
//   initResponsive (Task 18) → renderSetup → load → setInterval(load, 3000)
initTabs()
initTriage()
initSearch()
initAgentSelect()
initGear()
renderSetup()
load()
setInterval(load, 3000)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `fnm exec --using=24 -- npx vitest run test/tabs.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add public/tabs.js public/app.js test/tabs.test.ts
git commit -m "feat(viewer): content tabs with a filter-blind Needs-you count

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: Poll suspension (spec §10)

Ordered here, before the list work, because §10 calls it a prerequisite: Tasks 10-12 render rows that must not move under the cursor, and Tasks 11/16/17 consume the open-row state this task owns.

**Files:**
- Create: `public/poll.js`
- Create: `public/poll.d.ts`
- Test: `test/poll.test.ts`
- Modify: `public/app.js:1` (add one import line), `public/app.js:21` (suspension state block), `public/app.js:34` (`render()` inside `load()`), `public/app.js:244` (rowDrafts input listener), `public/app.js:750` (draftReplies input listener), `public/app.js:762` (draftReplyContexts input listener), the init block (**one inserted line**, see Step 5)
- Modify: `public/style.css` (append one `#pauseHint` rule at EOF — Task 6 ships the span unstyled; no `@media` block here)

**Interfaces:**
- Consumes: nothing from Tasks 1-8 at the module level. At the wiring level it consumes the shell's `#pauseHint` span and Needs-you list host `#needsYouList` (both from Task 6) and the existing draft maps `draftReplies` / `draftReplyContexts` (`app.js:696-697`) and `rowDrafts` (`app.js:188`).
- Produces (module `public/poll.js`): `suspendReason(state) -> 'expanded'|'draft'|null`, `shouldSuspendRender(state) -> boolean`, `suspendHint(state) -> string|null`, `pinOrder(current: string[], incoming: string[]) -> string[]`, `pendingCount(current: string[], incoming: string[]) -> number`, `applyListUpdate({current, incoming, hovering}) -> { ids: string[], staged: string[]|null, pending: number }`.
- Produces (app.js, declared **once here**, consumed by Tasks 11/16/17): the module-level `openRowId`, `setOpenRow(id: string|null) -> void`, `suspendState() -> SuspendState`, `renderIfIdle() -> void` (the poll's ONLY entry into `render()`), plus `resumeRender() -> void`, `orderedIds(ids: string[]) -> string[]`, `initListStaging() -> void`.

- [ ] **Step 1: Write the failing test**

```ts
// test/poll.test.ts
import { describe, it, expect } from 'vitest'
import {
  suspendReason,
  shouldSuspendRender,
  suspendHint,
  pinOrder,
  pendingCount,
  applyListUpdate,
} from '../public/poll.js'

describe('suspendReason', () => {
  it('is null when nothing is open and no draft has content', () => {
    expect(suspendReason({ expanded: [], drafts: { a: '', b: '   ' } })).toBeNull()
    expect(shouldSuspendRender({ expanded: [], drafts: {} })).toBe(false)
  })
  it('reports an expanded card', () => {
    expect(suspendReason({ expanded: ['i1'], drafts: {} })).toBe('expanded')
    expect(shouldSuspendRender({ expanded: new Set(['i1']), drafts: {} })).toBe(true)
  })
  it('reports a non-empty draft even with nothing expanded', () => {
    expect(suspendReason({ expanded: [], drafts: { 'i1:answer': 'ship it' } })).toBe('draft')
    expect(shouldSuspendRender({ expanded: [], drafts: { 'i1:answer': 'ship it' } })).toBe(true)
  })
  it('an expanded card outranks a draft — both suspend', () => {
    expect(suspendReason({ expanded: ['i1'], drafts: { x: 'hi' } })).toBe('expanded')
  })
  it('tolerates a state with no fields at all', () => {
    expect(shouldSuspendRender({})).toBe(false)
    expect(suspendReason({})).toBeNull()
  })
})

describe('suspendHint', () => {
  it('is the quiet paused copy while suspended, null otherwise', () => {
    expect(suspendHint({ expanded: ['i1'], drafts: {} })).toBe("paused — updating when you're done")
    expect(suspendHint({ expanded: [], drafts: {} })).toBeNull()
  })
})

describe('pinOrder', () => {
  it('keeps the on-screen order however the server re-sorts', () => {
    expect(pinOrder(['a', 'b', 'c'], ['c', 'b', 'a'])).toEqual(['a', 'b', 'c'])
  })
  it('appends genuinely new ids at the foot, in incoming order', () => {
    expect(pinOrder(['a', 'b'], ['d', 'a', 'c', 'b'])).toEqual(['a', 'b', 'd', 'c'])
  })
  it('drops ids that are gone', () => {
    expect(pinOrder(['a', 'b', 'c'], ['a', 'c'])).toEqual(['a', 'c'])
  })
  it('starts from empty', () => {
    expect(pinOrder([], ['a', 'b'])).toEqual(['a', 'b'])
  })
})

describe('pendingCount', () => {
  it('counts additions and removals', () => {
    expect(pendingCount(['a', 'b'], ['b', 'c'])).toBe(2)
    expect(pendingCount(['a'], ['a'])).toBe(0)
    expect(pendingCount([], ['a', 'b'])).toBe(2)
  })
})

describe('applyListUpdate', () => {
  it('applies, pinned, when the pointer is away from the list', () => {
    expect(applyListUpdate({ current: ['a', 'b'], incoming: ['b', 'a', 'c'], hovering: false }))
      .toEqual({ ids: ['a', 'b', 'c'], staged: null, pending: 0 })
  })
  it('stages while the pointer is over the list — rows never move under a click', () => {
    const r = applyListUpdate({ current: ['a', 'b'], incoming: ['b', 'c'], hovering: true })
    expect(r.ids).toEqual(['a', 'b'])
    expect(r.staged).toEqual(['b', 'c'])
    expect(r.pending).toBe(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `fnm exec --using=24 -- npx vitest run test/poll.test.ts`
Expected: FAIL with `Error: Failed to load url ../public/poll.js (resolved id: /Users/shariqhirani/Development/agent-inbox/public/poll.js)`

- [ ] **Step 3: Write minimal implementation**

```js
// public/poll.js
// Pure poll-suspension decisions for the viewer (spec §10). No DOM, no timers:
// the caller hands in the current UI state and gets back what the 3s poll is
// allowed to do. Unit-tested from test/poll.test.ts.

// Any expanded card or any non-empty draft freezes the re-render — the poll
// must never eat a half-typed answer or collapse a card under the cursor.
export function suspendReason(state) {
  const expanded = (state && state.expanded) || []
  const size = expanded instanceof Set ? expanded.size : expanded.length
  if (size > 0) return 'expanded'
  const drafts = (state && state.drafts) || {}
  for (const v of Object.values(drafts)) {
    if (String(v ?? '').trim() !== '') return 'draft'
  }
  return null
}

export function shouldSuspendRender(state) {
  return suspendReason(state) !== null
}

// The quiet hint a paused viewer shows; null when nothing is suspended.
export function suspendHint(state) {
  return shouldSuspendRender(state) ? "paused — updating when you're done" : null
}

// Sort order pins per render session: ids already on screen keep their relative
// order however the server re-sorts them; genuinely new ids append at the foot.
export function pinOrder(current, incoming) {
  const next = new Set(incoming)
  const kept = current.filter((id) => next.has(id))
  const seen = new Set(kept)
  return [...kept, ...incoming.filter((id) => !seen.has(id))]
}

// How many rows would appear/disappear if a staged update were applied.
export function pendingCount(current, incoming) {
  const now = new Set(current)
  const next = new Set(incoming)
  let n = 0
  for (const id of next) if (!now.has(id)) n++
  for (const id of now) if (!next.has(id)) n++
  return n
}

// While the pointer is over the list, membership changes STAGE instead of
// applying — rows must not move out from under a click. `staged` is replayed on
// mouse-leave.
export function applyListUpdate({ current, incoming, hovering }) {
  if (hovering) return { ids: current, staged: incoming, pending: pendingCount(current, incoming) }
  return { ids: pinOrder(current, incoming), staged: null, pending: 0 }
}
```

```ts
// public/poll.d.ts
export type SuspendReason = 'expanded' | 'draft'

export interface SuspendState {
  expanded?: string[] | Set<string>
  drafts?: Record<string, string | undefined>
}

export function suspendReason(state: SuspendState): SuspendReason | null
export function shouldSuspendRender(state: SuspendState): boolean
export function suspendHint(state: SuspendState): string | null
export function pinOrder(current: string[], incoming: string[]): string[]
export function pendingCount(current: string[], incoming: string[]): number
export function applyListUpdate(args: {
  current: string[]
  incoming: string[]
  hovering: boolean
}): { ids: string[]; staged: string[] | null; pending: number }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `fnm exec --using=24 -- npx vitest run test/poll.test.ts`
Expected: PASS (17 assertions across 6 describes)

- [ ] **Step 5: Wire the suspension into the viewer**

Add one import line at `public/app.js:1` (a new module, so a new statement — do not touch the other import lines):

```js
import { shouldSuspendRender, suspendHint, pinOrder, applyListUpdate } from '/poll.js'
```

Add this block immediately after the `let bootId = null` line (`public/app.js:21`). `openRowId`, `setOpenRow`, `suspendState` and `renderIfIdle` are declared HERE and nowhere else; Tasks 11/16/17 consume these bindings:

```js
// ── poll suspension (spec §10) ──────────────────────────────────────────────
// The 3s rebuild is the enemy of every in-progress interaction. It holds while
// a card is open or a draft has content, and lands the moment the user is done.
let openRowId = null    // the single inline-expanded Needs-you row (§4)
let renderDirty = false // fresh data arrived while suspended
let listHover = false   // pointer is over the Needs-you list
let pinnedIds = []      // sort order pinned for this render session
let stagedIds = null    // list membership waiting for mouse-leave

function suspendState() {
  return {
    expanded: openRowId ? [openRowId] : [],
    drafts: { ...draftReplies, ...draftReplyContexts, ...rowDrafts },
  }
}

// #pauseHint is emitted by the shell (Task 6); this is the only writer
function showPauseHint() {
  const el = document.getElementById('pauseHint')
  if (!el) return
  const hint = renderDirty ? suspendHint(suspendState()) : null
  el.textContent = hint ?? ''
  el.hidden = !hint
}

// the poll's ONLY entry into render()
function renderIfIdle() {
  if (shouldSuspendRender(suspendState())) {
    renderDirty = true
    showPauseHint()
    return
  }
  renderDirty = false
  showPauseHint()
  render()
}

// called whenever a suspending condition may have cleared (collapse, draft
// emptied, reply sent)
function resumeRender() {
  if (renderDirty) renderIfIdle()
  else showPauseHint()
}

// the single writer of openRowId — Tasks 11/16/17 call this, never assign
function setOpenRow(id) {
  openRowId = id
  resumeRender()
}

// render() runs its Needs-you entry ids through this: order pins for the
// session, membership stages while the pointer is over the list
function orderedIds(ids) {
  const r = applyListUpdate({ current: pinnedIds, incoming: ids, hovering: listHover })
  pinnedIds = r.ids
  stagedIds = r.staged
  return r.ids
}

function initListStaging() {
  showPauseHint()
  const list = document.getElementById('needsYouList')
  if (!list) return
  list.addEventListener('mouseenter', () => { listHover = true })
  list.addEventListener('mouseleave', () => {
    listHover = false
    if (stagedIds) {
      pinnedIds = pinOrder(pinnedIds, stagedIds)
      stagedIds = null
      render()
    } else {
      resumeRender()
    }
  })
}
```

Then make these five edits:

1. `public/app.js:34` — `render()` → `renderIfIdle()` inside `load()`.
2. `public/app.js:244` — `input.addEventListener('input', () => { rowDrafts[r.id] = input.value })` → `input.addEventListener('input', () => { rowDrafts[r.id] = input.value; resumeRender() })`
3. `public/app.js:750` — `input.addEventListener('input', () => { draftReplies[it.id] = input.value })` → `input.addEventListener('input', () => { draftReplies[it.id] = input.value; resumeRender() })`
4. `public/app.js:762` — `ctxInput.addEventListener('input', () => { draftReplyContexts[it.id] = ctxInput.value })` → `ctxInput.addEventListener('input', () => { draftReplyContexts[it.id] = ctxInput.value; resumeRender() })`
5. Init block (owned by Task 8) — insert **exactly one line**, `initListStaging()`, immediately after `initSearch()`. Do not re-quote or reorder the block.

`public/style.css` — append at EOF (Task 6 ships `<span id="pauseHint">` unstyled):

```css
#pauseHint { font-size: 12px; opacity: .5; font-style: italic; white-space: nowrap; }
```

- [ ] **Step 6: Run the full suite and typecheck**

Run: `fnm exec --using=24 -- npm test && fnm exec --using=24 -- npm run typecheck`
Expected: PASS — whole suite green, tsc clean

- [ ] **Step 7: Commit**

```bash
git add public/poll.js public/poll.d.ts test/poll.test.ts public/app.js public/style.css
git commit -m "feat(viewer): suspend the poll while a card is open or a draft is live

Spec §10: the 3s full-DOM rebuild must not eat a half-typed answer or
collapse a card under the cursor. Suspension is a pure decision
(public/poll.js) so it is unit-tested; list membership stages while the
pointer is over the list and sort order pins per render session.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: Needs-you two-line compact rows (flat list)

**Files:**
- Create: `public/rowview.js`
- Create: `public/rowview.d.ts`
- Test: `test/rowview.test.ts`
- Modify: `public/app.js:1` (extend the existing `/attention.js` and `/colors.js` import lines; add one new import line for `/star.js` and one for `/rowview.js` — one import statement per module)
- Modify: `public/app.js:106-111` (render wiring: `renderGroups('needsYou', …)` → `renderNeedsYou(g, boards, Date.now())`)
- Modify: `public/app.js:121-128` (`rel` delegates to the shared age formatter)
- Modify: `public/app.js:437-438` and `public/app.js:485-486` (`renderLive` — freshness tone from the shared helper, §6 one system)
- Modify: `public/app.js:489-518` (`renderGroups` — delete the project `h3` / agent `h4` nesting at 493-515, drop the `paginateGroups` call, add `renderNeedsYou` / `needsRowEl` / `staleFoldEl` / `stageDismiss`)
- Modify: `public/app.js:777-783` (`itemEl` — delete the `underAgentHead` param and its `meta` branch)
- Modify: `public/style.css` (append row styles at EOF — no `@media` block; Task 18 owns those)

`public/index.html` is **not** touched by this task — Task 6 owns it and already emits
`<section class="panel" id="needsYou"><div id="needsYouList" class="rows"></div></section>`.

**Interfaces:**
- Consumes: `attentionEntries(items, boards, nowMs, liveSessionIds)`, `sortNeedsYou(entries, nowMs)`, `staleEntries(items, nowMs, liveSessionIds)`, `ESCALATE_MS` from `/attention.js`; `starOption(item)`, `createStagedSend({delayMs,setTimeoutFn,clearTimeoutFn,send})` from `/star.js`; `projectMonogram(name)` from `/colors.js`; `paginate(items, limit)` from `/search.js`; `liveSessionIds()`, `themeName()` and `pcolor(name)` from Task 7 (this task declares none of them); `orderedIds(ids: string[]) -> string[]` from Task 9 — every render of the Needs-you list must run through it so sort order pins per session and membership stages under the pointer; the existing `projectFilter`, `shown`, `emptyMsg`, `moreButton`, `esc`, `btn`, `act`, `jumpToCard` in app.js. Tab counts belong to Task 8's `tabCounts` loop — this task sets no counts.
- Produces (module `public/rowview.js`): `secondaryLine(item) -> string`, `streamCounts(entities) -> Map<string,number>`, `agentCounts(entities) -> Map<string,number>`, `rowModel(entry, { streams, agents, showProject }) -> RowModel`, `urgencyChip(model, nowMs) -> { text, tone }`, `relMs(ms) -> string`, `FRESH_MS`, `AGING_MS`, `freshnessTone(ageMs) -> 'fresh'|'aging'|'quiet'`, `ageChip(ageMs) -> { tone, text }`, `needsYouEntries(items, boards, nowMs, liveSessionIds, extra?) -> Entry[]`, `staleFoldLabel(n) -> string`
- Produces (app.js): `renderNeedsYou(g, boardsInView, nowMs)`, `needsRowEl(model, entry, nowMs)`, `staleFoldEl(entries, opts, nowMs)`, `stageDismiss(id)` and `undoDismiss(id)` — **Task 17's keyboard `x` routes through `stageDismiss(id)`** so mouse and keyboard share the same 5s staged undo.

- [ ] **Step 1: Write the failing test**

```ts
// test/rowview.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  secondaryLine, streamCounts, agentCounts, rowModel, urgencyChip, relMs,
  FRESH_MS, AGING_MS, freshnessTone, ageChip, needsYouEntries, staleFoldLabel,
} from '../public/rowview.js'
import type { RowItem, Entry } from '../public/rowview.js'
import { attentionCount } from '../public/attention.js'
import type { AttentionBoard } from '../public/attention.js'

const T0 = Date.parse('2026-07-24T12:00:00.000Z')
const base: RowItem = {
  id: 'i1', project: 'api', stream: '', agent: 'claude', kind: 'question',
  title: 'Ship it?', detail: '', status: 'open', options: null, session: null,
  reply: null, reply_seen_at: null, created_at: new Date(T0).toISOString(),
}
const item = (over: Partial<RowItem> = {}): RowItem => ({ ...base, ...over })

describe('secondaryLine', () => {
  it('prefers the item detail', () => {
    expect(secondaryLine(item({ detail: 'one glanceable line' }))).toBe('one glanceable line')
  })
  it('falls back to the single recommended option detail', () => {
    const it2 = item({ options: [{ label: 'A', detail: 'cheap', recommended: true }, { label: 'B', detail: 'slow' }] })
    expect(secondaryLine(it2)).toBe('cheap')
  })
  it('is empty when there is no detail and no single recommendation', () => {
    expect(secondaryLine(item({ options: [{ label: 'A', recommended: true }, { label: 'B', recommended: true }] }))).toBe('')
    expect(secondaryLine(item())).toBe('')
  })
})

describe('streamCounts', () => {
  it('counts distinct streams per project', () => {
    const m = streamCounts([
      { project: 'api', stream: 'auth' },
      { project: 'api', stream: 'billing' },
      { project: 'web', stream: 'ui' },
      { project: 'web', stream: 'ui' },
    ])
    expect(m.get('api')).toBe(2)
    expect(m.get('web')).toBe(1)
  })
})

describe('agentCounts', () => {
  it('counts distinct agents per project', () => {
    const m = agentCounts([
      { project: 'api', agent: 'claude' },
      { project: 'api', agent: 'codex' },
      { project: 'api', agent: 'claude' },
      { project: 'web', agent: 'claude' },
    ])
    expect(m.get('api')).toBe(2)
    expect(m.get('web')).toBe(1)
  })
})

describe('rowModel', () => {
  const entry = (over: Partial<RowItem> = {}): Entry => ({ kind: 'item', item: item(over), liveness: 'waiting' })

  it('maps an item entry to title + secondary + liveness', () => {
    const m = rowModel(entry({ detail: 'about to drop the column' }))
    expect(m).toMatchObject({
      kind: 'item', id: 'i1', project: 'api', title: 'Ship it?',
      secondary: 'about to drop the column', liveness: 'waiting', boardId: null, answered: false,
    })
  })
  it('hides stream when the project has only one, shows it when it has more', () => {
    const e = entry({ stream: 'auth' })
    expect(rowModel(e, { streams: new Map([['api', 1]]) }).stream).toBe('')
    expect(rowModel(e, { streams: new Map([['api', 2]]) }).stream).toBe('auth')
  })
  // §15: multi-agent attribution survives the flattening as a row-level chip
  it('hides the agent chip for a single-agent project and shows it for a multi-agent one', () => {
    const e = entry({ agent: 'codex' })
    expect(rowModel(e, { agents: new Map([['api', 1]]) }).agent).toBe('')
    expect(rowModel(e, { agents: new Map([['api', 2]]) }).agent).toBe('codex')
  })
  it('carries the agent chip on a blocked board row too', () => {
    const m = rowModel({
      kind: 'row',
      row: { id: 'r1', label: 'Deploy staging', note: 'needs a prod token', status: 'blocked' },
      board: { id: 'b1', project: 'web', stream: '', agent: 'codex', title: 'Rollout' },
    }, { agents: new Map([['web', 3]]) })
    expect(m.agent).toBe('codex')
  })
  // §2: color is never the only carrier — the All view labels the dot
  it('carries a project monogram only while no project filter is active', () => {
    expect(rowModel(entry(), { showProject: true }).projectLabel).toBe('AP')
    expect(rowModel(entry(), { showProject: false }).projectLabel).toBe('')
    expect(rowModel(entry()).projectLabel).toBe('AP')
  })
  it('maps a blocked board row to a row model carrying the board link', () => {
    const m = rowModel({
      kind: 'row',
      row: { id: 'r1', label: 'Deploy staging', note: 'needs a prod token', status: 'blocked' },
      board: { id: 'b1', project: 'web', stream: '', title: 'Rollout' },
    })
    expect(m).toMatchObject({
      kind: 'row', id: 'r1', project: 'web', title: 'Deploy staging',
      secondary: 'needs a prod token', boardId: 'b1', boardTitle: 'Rollout', liveness: 'blocked',
    })
  })
  it('marks a replied item answered', () => {
    expect(rowModel({ kind: 'item', item: item({ reply: 'go' }), liveness: 'parked' }).answered).toBe(true)
  })
})

describe('urgencyChip', () => {
  const model = (over: Record<string, unknown> = {}) =>
    ({ ...rowModel({ kind: 'item', item: item(), liveness: 'waiting' }), ...over })

  it('is warm for a young waiting item and hot past the escalation age', () => {
    expect(urgencyChip(model(), T0 + 10 * 60_000)).toEqual({ text: 'waiting 10m', tone: 'warm' })
    expect(urgencyChip(model(), T0 + 90 * 60_000)).toEqual({ text: 'waiting 1h', tone: 'hot' })
  })
  it('is neutral for parked and muted for stale', () => {
    expect(urgencyChip(model({ liveness: 'parked' }), T0 + 3 * 3600_000).tone).toBe('neutral')
    expect(urgencyChip(model({ liveness: 'stale' }), T0 + 100 * 3600_000).tone).toBe('muted')
  })
  it('is blocked for a board row and muted once answered', () => {
    expect(urgencyChip(model({ kind: 'row' }), T0)).toEqual({ text: 'blocked', tone: 'blocked' })
    expect(urgencyChip(model({ answered: true }), T0).tone).toBe('muted')
  })
})

describe('relMs', () => {
  it('renders compact ages', () => {
    expect(relMs(30_000)).toBe('moments')
    expect(relMs(5 * 60_000)).toBe('5m')
    expect(relMs(3 * 3600_000)).toBe('3h')
    expect(relMs(50 * 3600_000)).toBe('2d')
  })
})

// §6: ONE freshness/age system — the row chip and the Live dot must never
// disagree about what "3h" or "aging" means.
describe('freshnessTone / ageChip', () => {
  it('classifies on the shared thresholds', () => {
    expect(freshnessTone(FRESH_MS - 1)).toBe('fresh')
    expect(freshnessTone(FRESH_MS)).toBe('aging')
    expect(freshnessTone(AGING_MS - 1)).toBe('aging')
    expect(freshnessTone(AGING_MS)).toBe('quiet')
  })
  it('gives a row chip and a Live entry the same text for the same age', () => {
    const ageMs = 3 * 3600_000
    const live = ageChip(ageMs)
    expect(live).toEqual({ tone: 'quiet', text: relMs(ageMs) })
    const row = urgencyChip(rowModel({ kind: 'item', item: item(), liveness: 'waiting' }), T0 + ageMs)
    expect(row.text).toBe(`waiting ${live.text}`)
  })
})

// §7: what you SEE obeys the rail + search; what the badge COUNTS never does.
describe('needsYouEntries', () => {
  const items = [item({ id: 'q-api', project: 'api' })]
  const boards: AttentionBoard[] = [
    { id: 'b-web', project: 'web', title: 'Rollout', rows: [{ id: 'r-web', label: 'Deploy', status: 'blocked' }] },
    { id: 'b-api', project: 'api', title: 'Migration', rows: [{ id: 'r-api', label: 'Backfill', status: 'blocked' }] },
  ]
  it('drops another project rows from the rendered list but not from the count', () => {
    const scoped = boards.filter((b) => b.project === 'api')
    const rendered = needsYouEntries(items, scoped, T0, new Set<string>())
    expect(rendered.map((e) => (e.kind === 'row' ? e.row.id : e.item.id))).toEqual(['r-api', 'q-api'])
    expect(attentionCount(items, boards, T0, new Set<string>())).toBe(3)
  })
  it('folds extra entries through the same ordering', () => {
    const extra = [{ kind: 'item' as const, item: item({ id: 'ans', reply: 'go' }), liveness: 'parked' as const }]
    const out = needsYouEntries(items, [], T0, new Set<string>(), extra)
    expect(out.map((e) => (e.kind === 'item' ? e.item.id : ''))).toEqual(['q-api', 'ans'])
  })
})

describe('staleFoldLabel', () => {
  it('names the collapsed decide-later fold', () => {
    expect(staleFoldLabel(3)).toBe('stale — decide later (3)')
    expect(staleFoldLabel(1)).toBe('stale — decide later (1)')
  })
})

// spec §10: the row-staging pin (Task 9's orderedIds) only protects the list if
// renderNeedsYou actually runs its entries through it BEFORE paginating. This is
// wiring inside app.js, which — like the rest of the shell — has no DOM test
// harness in this repo (see test/shell.test.ts), so the check is source-level:
// the same pattern already used to pin renderNeedsYou/jumpToCard/openTriage wiring.
describe('renderNeedsYou reorders through the poll-suspension pin before paginating (spec §10)', () => {
  const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  const start = js.indexOf('function renderNeedsYou')
  const fn = js.slice(start, js.indexOf('function staleFoldEl', start))

  it('runs the entries through orderedIds', () => {
    expect(start, 'renderNeedsYou is missing').toBeGreaterThan(-1)
    expect(fn).toContain('orderedIds(')
  })

  it('reorders BEFORE paginating — reordering after slicing cannot stop a new row landing under the pointer', () => {
    expect(fn.indexOf('orderedIds(')).toBeLessThan(fn.indexOf('paginate('))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `fnm exec --using=24 -- npx vitest run test/rowview.test.ts -t 'maps a blocked board row to a row model carrying the board link'`
Expected: FAIL with `Error: Failed to load url ../public/rowview.js (resolved id: ../public/rowview.js). Does the file exist?`

- [ ] **Step 3: Write minimal implementation**

```js
// public/rowview.js
// Pure view-model for the Needs-you compact rows (spec §3). No DOM: line-2
// selection, stream/agent disambiguation, the urgency chip and the single age
// vocabulary stay unit-testable; app.js only turns these models into elements.
import { starOption } from './star.js'
import { attentionEntries, sortNeedsYou, ESCALATE_MS } from './attention.js'
import { projectMonogram } from './colors.js'

// Line 2 is what makes one-tap defensible (§5): you accept what you just read.
// The item's own detail wins; otherwise the recommended option's detail.
export function secondaryLine(item) {
  if (item.detail) return item.detail
  const rec = starOption(item)
  return rec && rec.detail ? rec.detail : ''
}

function countDistinct(entities, field) {
  const map = new Map()
  for (const e of entities) {
    const set = map.get(e.project) ?? new Set()
    set.add(e[field] ?? '')
    map.set(e.project, set)
  }
  return new Map([...map].map(([project, set]) => [project, set.size]))
}

// project -> how many distinct streams it has; a single-stream project must
// not pay for a stream suffix on every row.
export function streamCounts(entities) {
  return countDistinct(entities, 'stream')
}

// same treatment for agents: flattening the old agent <h4> must not lose
// attribution when two agents share a project (§15).
export function agentCounts(entities) {
  return countDistinct(entities, 'agent')
}

export function rowModel(entry, { streams = new Map(), agents = new Map(), showProject = true } = {}) {
  if (entry.kind === 'row') {
    const { row, board } = entry
    return {
      kind: 'row',
      id: row.id,
      project: board.project,
      projectLabel: showProject ? projectMonogram(board.project) : '',
      stream: (streams.get(board.project) ?? 0) > 1 ? (board.stream ?? '') : '',
      agent: (agents.get(board.project) ?? 0) > 1 ? (board.agent ?? '') : '',
      title: row.label,
      secondary: row.note ?? '',
      liveness: 'blocked',
      boardId: board.id,
      boardTitle: board.title,
      created_at: null,
      answered: false,
    }
  }
  const it = entry.item
  return {
    kind: 'item',
    id: it.id,
    project: it.project,
    projectLabel: showProject ? projectMonogram(it.project) : '',
    stream: (streams.get(it.project) ?? 0) > 1 ? (it.stream ?? '') : '',
    agent: (agents.get(it.project) ?? 0) > 1 ? (it.agent ?? '') : '',
    title: it.title,
    secondary: secondaryLine(it),
    liveness: entry.liveness,
    boardId: null,
    boardTitle: null,
    created_at: it.created_at,
    answered: Boolean(it.reply),
  }
}

// One time vocabulary shared with the Live freshness dots (§6) — never a raw
// age ramp: only a live asking session earns heat.
export function urgencyChip(model, nowMs) {
  if (model.kind === 'row') return { text: 'blocked', tone: 'blocked' }
  if (model.answered) return { text: 'answered', tone: 'muted' }
  const age = nowMs - Date.parse(model.created_at)
  if (model.liveness === 'waiting') return { text: `waiting ${relMs(age)}`, tone: age >= ESCALATE_MS ? 'hot' : 'warm' }
  if (model.liveness === 'stale') return { text: `stale ${relMs(age)}`, tone: 'muted' }
  return { text: `parked ${relMs(age)}`, tone: 'neutral' }
}

export function relMs(ms) {
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'moments'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

// The Live surface used to keep its own thresholds and its own "3h 20m"
// formatter. §6 wants one system: these are it, and renderLive consumes them.
export const FRESH_MS = 60 * 1000
export const AGING_MS = 5 * 60 * 1000

export function freshnessTone(ageMs) {
  if (ageMs < FRESH_MS) return 'fresh'
  if (ageMs < AGING_MS) return 'aging'
  return 'quiet'
}

export function ageChip(ageMs) {
  return { tone: freshnessTone(ageMs), text: relMs(ageMs) }
}

// The rendered Needs-you list: the attention set over the boards the user is
// actually looking at, plus any extra entries (Task 12's awaiting-pickup foot),
// through the one ordering rule. The tab count deliberately uses the UNFILTERED
// data instead — see Task 8's tabCounts (§7 filter-blindness).
export function needsYouEntries(items, boards, nowMs, liveSessionIds, extra = []) {
  return sortNeedsYou([...attentionEntries(items, boards, nowMs, liveSessionIds), ...extra], nowMs)
}

// Stale = nobody is listening and it is older than STALE_MS. It must stay
// reachable (never deleted) but must not sit in the active list (§6).
export function staleFoldLabel(n) {
  return `stale — decide later (${n})`
}
```

```ts
// public/rowview.d.ts
import type { AttentionBoard, AttentionEntry, AttentionItem, LiveSessionIds } from './attention.js'

export interface RowOption { label: string; detail?: string; recommended?: boolean }

export interface RowItem {
  id: string
  project: string
  stream?: string
  agent?: string
  kind?: string
  title: string
  detail?: string
  status?: string
  session?: string | null
  options?: RowOption[] | null
  reply?: string | null
  reply_seen_at?: string | null
  created_at: string
}

export interface RowBoard { id: string; project: string; stream?: string; agent?: string; title: string }
export interface RowRow { id: string; label: string; note?: string; status?: string }

export type Liveness = 'waiting' | 'parked' | 'stale'
export type Entry =
  | { kind: 'item'; item: RowItem; liveness: Liveness }
  | { kind: 'row'; row: RowRow; board: RowBoard }

export interface RowModel {
  kind: 'item' | 'row'
  id: string
  project: string
  projectLabel: string
  stream: string
  agent: string
  title: string
  secondary: string
  liveness: string
  boardId: string | null
  boardTitle: string | null
  created_at: string | null
  answered: boolean
}

export interface RowModelOpts {
  streams?: Map<string, number>
  agents?: Map<string, number>
  showProject?: boolean
}

export function secondaryLine(item: RowItem): string
export function streamCounts(entities: Array<{ project: string; stream?: string }>): Map<string, number>
export function agentCounts(entities: Array<{ project: string; agent?: string }>): Map<string, number>
export function rowModel(entry: Entry, opts?: RowModelOpts): RowModel
export function urgencyChip(model: RowModel, nowMs: number): { text: string; tone: string }
export function relMs(ms: number): string
export const FRESH_MS: number
export const AGING_MS: number
export function freshnessTone(ageMs: number): 'fresh' | 'aging' | 'quiet'
export function ageChip(ageMs: number): { tone: 'fresh' | 'aging' | 'quiet'; text: string }
export function needsYouEntries(
  items: AttentionItem[],
  boards: AttentionBoard[],
  nowMs: number,
  liveSessionIds: LiveSessionIds,
  extra?: AttentionEntry[],
): AttentionEntry[]
export function staleFoldLabel(n: number): string
```

`public/app.js:1` — **edit the existing import lines** (one statement per module; add the two
new ones below them). The `/attention.js` line already exists from Tasks 7-8 and the
`/colors.js` line from Task 7 — add names to them, never a second import from the same module:

```js
import { attentionCount, countsByProject, staleEntries } from '/attention.js'
import { projectColor, projectMonogram } from '/colors.js'
import { createStagedSend } from '/star.js'
import { ageChip, agentCounts, needsYouEntries, relMs, rowModel, staleFoldLabel, streamCounts, urgencyChip } from '/rowview.js'
```

Immediately below the import block, keep `paginateGroups` alive without a call site:

```js
void paginateGroups // kept exported+tested (spec §15); the viewer no longer calls it
```

`public/app.js:106-111` — in `render()`, swap the needs-you wiring. The filtered+searched
`boards` go to the renderer; Task 8's `tabCounts` loop keeps counting `lastData` and stays
untouched — do not add a `setCount('needsYou', …)` here. There is no `renderArchived(archived)`
call to keep: Task 6 deleted the function and Task 8's wiring never re-added it:

```js
  renderNeedsYou(g, boards, Date.now())
  renderGroups('notes', g.notes)
  renderDone(g.done)
  renderBoards(boards)
```

`public/app.js:121-128` — `rel()` stops being a second age formatter:

```js
// one age vocabulary for every surface (§6): rows, chips, Live and tooltips all
// format through relMs()
function rel(iso) {
  return relMs(Date.now() - Date.parse(iso))
}
```

`public/app.js:437-438` — in `renderLive`'s active loop, replace the `ageMs`/`fresh` pair:

```js
    const { tone: fresh } = ageChip(Date.now() - Date.parse(a.updated_at))
```

`public/app.js:485-486` — the same replacement in the idle-fold loop (keep the comment above it):

```js
      const { tone: fresh } = ageChip(Date.now() - Date.parse(a.updated_at))
```

`public/app.js:489-518` — replace `renderGroups` wholesale with the flat renderer plus the new
needs-you list. `liveSessionIds()` and `themeName()` come from Task 7 — they are **not**
re-declared here:

```js
// dismissing noise must not cost an expansion: staged 5s, undoable, flushed on blur
const stagedDismiss = new Set() // item ids inside their undo window — survives the poll rebuild
const dismissStage = createStagedSend({
  delayMs: 5000,
  setTimeoutFn: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeoutFn: (h) => window.clearTimeout(h),
  send: ({ id }) => { stagedDismiss.delete(id); act(id, 'dismiss') },
})

// the one staged-dismiss entry point: the row ✕ and Task 17's `x` key both call
// this, so mouse and keyboard share one undo window
function stageDismiss(id) {
  if (stagedDismiss.has(id)) return
  stagedDismiss.add(id)
  dismissStage.stage(`dismiss:${id}`, { id })
  render()
}

function undoDismiss(id) {
  if (!dismissStage.undo(`dismiss:${id}`)) return false
  stagedDismiss.delete(id)
  render()
  return true
}

// flat, ranked, two-line rows — no project/agent heading levels (§3, §15)
function renderNeedsYou(g, boardsInView, nowMs) {
  const host = document.getElementById('needsYouList')
  const items = g.needsYou.flatMap((gr) => gr.items)
  const live = liveSessionIds()
  // §7: the LIST is scoped by the rail + search (boardsInView); the tab count is
  // computed from lastData by Task 8 and never sees this slice
  const unordered = needsYouEntries(items, boardsInView, nowMs, live)
  // §10: run every entry through Task 9's poll-suspension pin BEFORE paginating —
  // this is what stops a freshly-arrived row from jumping into the visible slice
  // while the pointer is over the list. orderedIds() only ever returns ids that
  // were already pinned or that hovering:false let through, so entries that got
  // staged simply do not appear in `ordered` until the pointer leaves.
  const entryById = new Map(unordered.map((e) => [e.kind === 'row' ? e.row.id : e.item.id, e]))
  const entries = orderedIds([...entryById.keys()]).map((id) => entryById.get(id)).filter(Boolean)
  const entities = [...items, ...boardsInView]
  const opts = {
    streams: streamCounts(entities),
    agents: agentCounts(entities),
    showProject: !projectFilter, // a single selected project needs no monogram (§2)
  }
  const { visible, remaining } = paginate(entries, shown.needsYou)
  host.innerHTML = entries.length ? '' : `<p class="empty">${emptyMsg('Nothing needs you.')}</p>`
  for (const e of visible) host.appendChild(needsRowEl(rowModel(e, opts), e, nowMs))
  if (remaining > 0) host.appendChild(moreButton('needsYou', remaining))
  const stale = staleEntries(items, nowMs, live)
  if (stale.length) host.appendChild(staleFoldEl(stale, opts, nowMs))
}

// nobody is listening and it is older than STALE_MS: out of the active list and
// out of every count, but one click away — never deleted (§6)
function staleFoldEl(entries, opts, nowMs) {
  const fold = document.createElement('details')
  fold.className = 'stale-fold'
  const summary = document.createElement('summary')
  summary.textContent = staleFoldLabel(entries.length)
  fold.appendChild(summary)
  for (const e of entries) fold.appendChild(needsRowEl(rowModel(e, opts), e, nowMs))
  return fold
}

function needsRowEl(m, entry, nowMs) {
  const el = document.createElement('div')
  el.className = `nrow nrow-${m.kind}${m.answered ? ' answered' : ''}${stagedDismiss.has(m.id) ? ' staged' : ''}`
  el.dataset.cardId = m.id
  el.tabIndex = 0
  const chip = urgencyChip(m, nowMs)
  const color = pcolor(m.project)
  const glyph = m.kind === 'row' ? `<button class="nrow-glyph" title="open board: ${esc(m.boardTitle ?? '')}">🚧</button>` : ''
  const projBit = m.projectLabel ? `<span class="nrow-proj" title="${esc(m.project)}">${esc(m.projectLabel)}</span>` : ''
  const agentBit = m.agent ? `<span class="nrow-agent">${esc(m.agent)}</span>` : ''
  const streamBit = m.stream ? `<span class="nrow-stream">${esc(m.stream)}</span>` : ''
  el.innerHTML = `
    <div class="nrow-l1">
      <span class="pdot" style="background:${color.dot}" title="${esc(m.project)}"></span>
      ${projBit}
      ${glyph}
      <span class="nrow-title" title="${esc(m.title)}">${esc(m.title)}</span>
      <span class="chip chip-${chip.tone}">${esc(chip.text)}</span>
      <span class="nrow-star"></span>
      <button class="nrow-dismiss" title="Dismiss (x)" aria-label="Dismiss">✕</button>
      <span class="nrow-caret">▸</span>
    </div>
    <div class="nrow-l2"><span class="nrow-sec">${esc(m.secondary)}</span>${agentBit}${streamBit}</div>`
  el.style.setProperty('--wash', color.wash)
  const boardBtn = el.querySelector('.nrow-glyph')
  if (boardBtn) boardBtn.addEventListener('click', (ev) => { ev.stopPropagation(); jumpToCard('boards', m.boardId) })
  el.querySelector('.nrow-dismiss').addEventListener('click', (ev) => {
    ev.stopPropagation()
    if (m.kind === 'item') stageDismiss(m.id)
  })
  if (stagedDismiss.has(m.id)) {
    const undo = btn('Undo dismiss', () => undoDismiss(m.id))
    undo.className = 'undo-btn'
    el.querySelector('.nrow-l2').replaceChildren(document.createTextNode('Dismissed — '), undo)
  }
  return el
}

// notes keep a card list, but flat: no project h3, no agent h4 (§15)
function renderGroups(sectionId, groups) {
  const host = document.querySelector(`#${sectionId} .groups`)
  const items = groups.flatMap((gr) => gr.items)
  const { visible, remaining } = paginate(items, shown[sectionId])
  host.innerHTML = items.length ? '' : `<p class="empty">${emptyMsg('Nothing here.')}</p>`
  for (const it of visible) host.appendChild(itemEl(it))
  if (remaining > 0) host.appendChild(moreButton(sectionId, remaining))
}
```

`public/app.js:777-783` — drop `underAgentHead` (the agent now rides on the row chip):

```js
function itemEl(it, done = false) {
  const el = document.createElement('details')
  const answered = it.kind === 'question' && it.status === 'open' && it.reply
  el.className = `item ${it.kind}${answered ? ' answered' : ''}`
  const stream = it.stream ? ` · ${esc(it.stream)}` : ''
  const meta = `${esc(it.agent)}${stream}`
```

`public/style.css` — append at EOF (no `@media` block here; Task 18 owns responsive):

```css
.nrow { display: flex; flex-direction: column; gap: 1px; padding: 7px 10px; border-radius: 8px; border: 1px solid color-mix(in srgb, CanvasText 10%, transparent); margin-bottom: 6px; background: var(--wash, transparent); cursor: pointer; }
.nrow:focus-visible { outline: 2px solid LinkText; outline-offset: 1px; }
.nrow.answered { opacity: .55; }
.nrow.staged { opacity: .45; }
.nrow-l1 { display: flex; align-items: center; gap: 8px; min-width: 0; }
.nrow-title { font-weight: 600; font-size: 14px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nrow-l2 { display: flex; align-items: baseline; gap: 8px; font-size: 12.5px; opacity: .6; min-width: 0; padding-left: 18px; }
.nrow-sec { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nrow-agent, .nrow-stream { flex-shrink: 0; opacity: .8; font-variant: all-small-caps; }
.nrow-proj { font-size: 10px; letter-spacing: .06em; font-weight: 700; opacity: .55; flex-shrink: 0; }
.pdot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
.nrow-glyph { border: none; background: transparent; cursor: pointer; font-size: 13px; padding: 0; }
.nrow-caret { font-size: 10px; opacity: .4; }
.nrow[data-open="1"] .nrow-caret { transform: rotate(90deg); }
.nrow-dismiss { border: none; background: transparent; color: inherit; cursor: pointer; font-size: 12px; opacity: 0; }
.nrow:hover .nrow-dismiss, .nrow:focus-within .nrow-dismiss { opacity: .5; }
.nrow-dismiss:hover { opacity: 1; }
.chip { font-size: 11px; padding: 1px 8px; border-radius: 999px; white-space: nowrap; border: 1px solid transparent; }
.chip-hot { background: color-mix(in srgb, crimson 16%, transparent); color: color-mix(in srgb, crimson 75%, CanvasText); border-color: color-mix(in srgb, crimson 40%, transparent); }
.chip-warm { background: color-mix(in srgb, goldenrod 16%, transparent); color: color-mix(in srgb, goldenrod 80%, CanvasText); }
.chip-neutral { background: color-mix(in srgb, CanvasText 8%, transparent); opacity: .7; }
.chip-muted { opacity: .45; }
.chip-blocked { background: color-mix(in srgb, crimson 12%, transparent); color: color-mix(in srgb, crimson 70%, CanvasText); }
.undo-btn { font-size: 11.5px; padding: 1px 8px; border-radius: 6px; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); background: transparent; color: inherit; cursor: pointer; }
.stale-fold { margin-top: 10px; opacity: .6; }
.stale-fold > summary { cursor: pointer; font-size: 12px; letter-spacing: .02em; padding: 4px 0; list-style: none; }
.stale-fold > summary::before { content: "▸ "; font-size: 10px; }
.stale-fold[open] > summary::before { content: "▾ "; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `fnm exec --using=24 -- sh -c 'npx vitest run test/rowview.test.ts && npx tsc --noEmit'`
Expected: PASS — every suite green, `tsc --noEmit` silent

- [ ] **Step 5: Commit**

```bash
git add public/rowview.js public/rowview.d.ts test/rowview.test.ts public/app.js public/style.css
git commit -m "feat(viewer): flat two-line compact rows for Needs you

Flattens the project/agent heading nesting into ranked two-line rows with
a project monogram, an agent chip for multi-agent projects, one shared age
vocabulary with Live, and a collapsed stale fold at the foot."
```

---

### Task 11: One card component, two entry points (inline accordion + lightbox)

**Files:**
- Create: `public/card.js`
- Create: `public/card.d.ts`
- Test: `test/card.test.ts`
- Modify: `public/app.js:1` (add the `/card.js` import line; add `classifyLiveness` to the existing `/attention.js` import line)
- Modify: `public/app.js:283-290` (lightbox mounts the shared card builder instead of `itemEl`)
- Modify: `public/app.js:716-775` (`answerEl` — use `optionOrder` as the single ordering rule; line 719)
- Modify: `public/app.js:777-816` (`itemEl` delegates to the new `itemCardEl`)
- Modify: `public/app.js` `needsRowEl` (added in Task 10) — single-open accordion mount
- Modify: `public/style.css` (append card styles at EOF)

**Interfaces:**
- Consumes: `rowModel`, `urgencyChip` from `/rowview.js`; `pcolor(name)` from Task 7 (the persisted-color wrapper — do not call `projectColor()` directly); `classifyLiveness(item, nowMs, liveSessionIds)` from `/attention.js`; `openRowId`, `setOpenRow(id)`, `renderIfIdle()` from Task 9 (this task declares no expansion state of its own); `liveSessionIds()`, `themeName()` from Task 7; existing `answerEl(it)`, `rowCardEl(b, r)`, `esc()`, `btn()`, `act()` in app.js
- Produces: `optionOrder(options) -> Option[]`, `recommendedWarning(options) -> string | null`, `cardSections(it, { done }) -> { detail, context, annotation, reply, options, recWarning, showAnswer, showActions, answered }` (from `public/card.js`); `itemCardEl(it, { done, nowMs, liveness, header })`, `rowCardBodyEl(entry, m, nowMs)`, `toggleRow(el, m, entry, nowMs)`, `changeAnswer(it)` in app.js

- [ ] **Step 1: Write the failing test**

```ts
// test/card.test.ts
import { describe, it, expect } from 'vitest'
import { optionOrder, recommendedWarning, cardSections } from '../public/card.js'
import type { CardItem } from '../public/card.js'

const base: CardItem = {
  id: 'i1', kind: 'question', status: 'open', title: 'Drop the column?',
  detail: 'one line', context: 'why this came up', annotation: null,
  options: null, reply: null, reply_context: null, reply_seen_at: null,
}
const item = (over: Partial<CardItem> = {}): CardItem => ({ ...base, ...over })

describe('optionOrder', () => {
  it('puts the recommended option first and keeps the rest stable', () => {
    const opts = [{ label: 'A' }, { label: 'B' }, { label: 'C', recommended: true }]
    expect(optionOrder(opts).map((o) => o.label)).toEqual(['C', 'A', 'B'])
  })
  it('returns an empty array for null options', () => {
    expect(optionOrder(null)).toEqual([])
  })
})

describe('recommendedWarning', () => {
  it('is null for zero or one recommendation', () => {
    expect(recommendedWarning(null)).toBeNull()
    expect(recommendedWarning([{ label: 'A', recommended: true }, { label: 'B' }])).toBeNull()
  })
  it('warns when the agent marked more than one', () => {
    expect(recommendedWarning([{ label: 'A', recommended: true }, { label: 'B', recommended: true }]))
      .toBe('2 options are marked recommended — one-tap accept is disabled')
  })
})

describe('cardSections', () => {
  it('surfaces context as its own labeled block', () => {
    expect(cardSections(item()).context).toBe('why this came up')
    expect(cardSections(item({ context: '' })).context).toBe('')
  })
  it('shows the answer surface only for an open unanswered question', () => {
    expect(cardSections(item()).showAnswer).toBe(true)
    expect(cardSections(item({ reply: 'go' })).showAnswer).toBe(false)
    expect(cardSections(item({ kind: 'note' })).showAnswer).toBe(false)
    expect(cardSections(item(), { done: true }).showAnswer).toBe(false)
  })
  it('exposes the reply and the answered flag once replied', () => {
    const s = cardSections(item({ reply: 'go ahead' }))
    expect(s.answered).toBe(true)
    expect(s.reply).toBe('go ahead')
  })
  it('hides actions on a done card and carries the multi-recommendation warning', () => {
    expect(cardSections(item(), { done: true }).showActions).toBe(false)
    const s = cardSections(item({ options: [{ label: 'A', recommended: true }, { label: 'B', recommended: true }] }))
    expect(s.recWarning).toContain('2 options are marked recommended')
    expect(s.options.length).toBe(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `fnm exec --using=24 -- npx vitest run test/card.test.ts -t 'surfaces context as its own labeled block'`
Expected: FAIL with `Error: Failed to load url ../public/card.js (resolved id: ../public/card.js). Does the file exist?`

- [ ] **Step 3: Write minimal implementation**

```js
// public/card.js
// Which sections the unified item card shows (spec §4). Pure so the one
// component behind the inline accordion and the triage lightbox has a single,
// tested definition of "what belongs on a card".

// Recommended first, everything else in author order (stable sort).
export function optionOrder(options) {
  return [...(options ?? [])].sort((a, b) => (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0))
}

// The store does not validate this — two recommendations kills the safe star (§5.1).
export function recommendedWarning(options) {
  const n = (options ?? []).filter((o) => o.recommended).length
  return n > 1 ? `${n} options are marked recommended — one-tap accept is disabled` : null
}

export function cardSections(it, { done = false } = {}) {
  const open = it.status === 'open'
  const answered = it.kind === 'question' && open && Boolean(it.reply)
  return {
    detail: it.detail ?? '',
    context: it.context ?? '',
    annotation: it.annotation ?? '',
    reply: answered ? it.reply : '',
    options: optionOrder(it.options),
    recWarning: it.kind === 'question' && !answered ? recommendedWarning(it.options) : null,
    showAnswer: !done && it.kind === 'question' && open && !it.reply,
    showActions: !done,
    answered,
  }
}
```

```ts
// public/card.d.ts
export interface CardOption { label: string; detail?: string; recommended?: boolean }

export interface CardItem {
  id: string
  kind?: string
  status?: string
  title: string
  detail?: string
  context?: string
  annotation?: string | null
  options?: CardOption[] | null
  reply?: string | null
  reply_context?: string | null
  reply_seen_at?: string | null
}

export interface CardSections {
  detail: string
  context: string
  annotation: string
  reply: string
  options: CardOption[]
  recWarning: string | null
  showAnswer: boolean
  showActions: boolean
  answered: boolean
}

export function optionOrder(options: CardOption[] | null | undefined): CardOption[]
export function recommendedWarning(options: CardOption[] | null | undefined): string | null
export function cardSections(it: CardItem, opts?: { done?: boolean }): CardSections
```

`public/app.js:1` — add the `/card.js` import line and extend the existing `/attention.js`
line with `classifyLiveness` (still one import statement per module):

```js
import { attentionCount, classifyLiveness, countsByProject, staleEntries } from '/attention.js'
import { cardSections, optionOrder } from '/card.js'
```

`public/app.js:777-816` — add `itemCardEl` and make `itemEl` a thin `<details>` wrapper around it:

```js
// THE card (§4): meta → title → detail → labeled CONTEXT → options → answer →
// actions. Mounted inline by the Needs-you accordion and by the triage lightbox.
function itemCardEl(it, { done = false, nowMs = Date.now(), liveness = 'parked', header = true } = {}) {
  const el = document.createElement('div')
  el.className = `card card-${it.kind}`
  const s = cardSections(it, { done })
  const color = pcolor(it.project)
  const chip = urgencyChip(
    { kind: 'item', liveness, created_at: it.created_at, answered: s.answered }, nowMs)
  const head = header ? `
    <div class="meta card-meta">
      <span class="pdot" style="background:${color.dot}"></span>
      <span>${esc(it.project)}</span> · <span>${esc(it.agent)}</span>${it.stream ? ` · <span>${esc(it.stream)}</span>` : ''}
      <span class="chip chip-${chip.tone}">${esc(chip.text)}</span>
    </div>
    <div class="card-title">${esc(it.title)}</div>` : ''
  el.innerHTML = `
    ${head}
    ${s.detail ? `<div class="detail card-detail">${esc(s.detail)}</div>` : ''}
    ${s.context ? `<div class="card-context"><div class="card-context-label">CONTEXT</div><div class="card-context-body">${esc(s.context)}</div></div>` : ''}
    ${s.annotation ? `<div class="annotation">📝 ${esc(s.annotation)}</div>` : ''}
    ${s.recWarning ? `<div class="rec-warning">⚠ ${esc(s.recWarning)}</div>` : ''}
    ${s.reply ? `<div class="reply-block">↩ ${esc(s.reply)}${it.reply_context ? `<div class="reply-context">context: ${esc(it.reply_context)}</div>` : ''}<span class="pickup ${it.reply_seen_at ? 'picked' : 'awaiting'}">${it.reply_seen_at ? '✓ picked up' : '● waiting for agent pickup'}</span></div>` : ''}`
  if (s.showAnswer) el.appendChild(answerEl(it))
  if (s.showActions) {
    const actions = document.createElement('div')
    actions.className = 'actions'
    actions.appendChild(btn('Resolve', () => act(it.id, 'resolve')))
    actions.appendChild(btn('Dismiss', () => act(it.id, 'dismiss')))
    if (s.answered) actions.appendChild(btn('Change answer', () => changeAnswer(it)))
    actions.appendChild(btn('Note', async () => {
      const text = prompt('Your note:')
      if (text != null) { await fetch(`/api/items/${it.id}/annotate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }); load() }
    }))
    el.appendChild(actions)
  }
  return el
}

async function changeAnswer(it) {
  draftReplies[it.id] = it.reply
  draftReplyContexts[it.id] = it.reply_context ?? ''
  await fetch(`/api/items/${it.id}/reply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '' }) })
  load()
}

// notes / done keep a collapsible card; the body is the same component
function itemEl(it, done = false) {
  const el = document.createElement('details')
  const answered = it.kind === 'question' && it.status === 'open' && it.reply
  el.className = `item ${it.kind}${answered ? ' answered' : ''}`
  const stream = it.stream ? ` · ${esc(it.stream)}` : ''
  el.innerHTML = `
    <summary class="card-summary">
      <div class="meta"><span class="caret"></span>${esc(it.agent)}${stream}</div>
      <div class="title">${esc(it.title)}</div>
    </summary>`
  cardify(el, it.id)
  el.appendChild(itemCardEl(it, { done, header: false }))
  return el
}
```

`public/app.js:283-290` — the lightbox mounts the same builder:

```js
    const data = findEntryData(triageDeck.entries[triageDeck.index])
    if (data.it) {
      card.appendChild(itemCardEl(data.it, {
        nowMs: Date.now(),
        liveness: classifyLiveness(data.it, Date.now(), liveSessionIds()),
      }))
    } else {
      card.appendChild(rowCardEl(data.b, data.r))
    }
```

`public/app.js:719` — one ordering rule inside `answerEl`:

```js
  const opts = optionOrder(it.options)
```

`public/app.js` `needsRowEl` (Task 10) — single-open accordion over **Task 9's** `openRowId`.
There is no second expansion variable and no bare `render()`: the mount happens in place, so
it survives the suspension gate `setOpenRow` arms. Add these two helpers next to `needsRowEl`:

```js
// the inline expanded body — one card component, mounted under the row (§4)
function rowCardBodyEl(entry, m, nowMs) {
  const body = document.createElement('div')
  body.className = 'nrow-card'
  body.addEventListener('click', (ev) => ev.stopPropagation()) // clicks in the card must not collapse it
  body.appendChild(entry.kind === 'row'
    ? rowCardEl(entry.board, entry.row)
    : itemCardEl(entry.item, { nowMs, liveness: m.liveness }))
  return body
}

// Single-open accordion. `setOpenRow` (Task 9) owns the flag and the poll gate;
// the DOM is patched in place because a re-render is exactly what the gate is
// there to suspend. Collapsing hands the poll its pending data back.
function toggleRow(el, m, entry, nowMs) {
  const wasOpen = openRowId === m.id
  setOpenRow(wasOpen ? null : m.id)
  for (const other of document.querySelectorAll('.nrow[data-open="1"]')) {
    other.removeAttribute('data-open')
    const card = other.querySelector('.nrow-card')
    if (card) card.remove()
  }
  if (wasOpen) { renderIfIdle(); return }
  el.dataset.open = '1'
  el.appendChild(rowCardBodyEl(entry, m, nowMs))
}
```

and, inside `needsRowEl` just before `return el`:

```js
  el.addEventListener('click', (ev) => {
    if (ev.target.closest('button, input, a')) return
    toggleRow(el, m, entry, nowMs)
  })
  el.addEventListener('keydown', (ev) => {
    if (ev.target !== el) return
    if (ev.key === 'Enter') { ev.preventDefault(); toggleRow(el, m, entry, nowMs) }
    if (ev.key === 'Escape' && openRowId === m.id) { ev.preventDefault(); toggleRow(el, m, entry, nowMs) }
  })
  // a full render (poll or user action) rebuilds the open row from openRowId
  if (openRowId === m.id) {
    el.dataset.open = '1'
    el.appendChild(rowCardBodyEl(entry, m, nowMs))
  }
```

`public/style.css` — append:

```css
.card { display: block; }
.card-meta { display: flex; align-items: center; gap: 6px; }
.card-title { font-weight: 600; font-size: 16px; margin: 4px 0 2px; }
.card-detail { margin-bottom: 8px; }
.card-context { margin: 8px 0; padding: 8px 10px; border-radius: 8px; background: color-mix(in srgb, CanvasText 5%, transparent); }
.card-context-label { font-size: 10px; letter-spacing: .09em; text-transform: uppercase; opacity: .5; margin-bottom: 3px; }
.card-context-body { font-size: 13px; opacity: .85; white-space: pre-wrap; }
.rec-warning { font-size: 12px; margin-top: 6px; color: color-mix(in srgb, goldenrod 80%, CanvasText); }
.nrow-card { margin: 8px 0 2px; padding: 10px 12px 4px 18px; border-top: 1px solid color-mix(in srgb, CanvasText 10%, transparent); cursor: default; }
.nrow[data-open="1"] { background: color-mix(in srgb, CanvasText 4%, transparent); }
.nrow[data-open="1"] .nrow-l2 { white-space: normal; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `fnm exec --using=24 -- sh -c 'npx vitest run test/card.test.ts && npx tsc --noEmit'`
Expected: PASS — 9 tests green, `tsc --noEmit` silent

- [ ] **Step 5: Commit**

```bash
git add public/card.js public/card.d.ts test/card.test.ts public/app.js public/style.css
git commit -m "feat(viewer): one unified item card behind the row accordion and the lightbox"
```

---

### Task 12: Wire the safe ★ into rows (staged send, undo, flush)

**Files:**
- Modify: `public/rowview.js` (append `SECONDARY_BUDGET`, `rowStarOption`, `stagedLabel`, `undoRefusal`, `awaitingPickupEntries`; extend its existing `./star.js` and `./attention.js` import lines)
- Modify: `public/rowview.d.ts` (declare the five new exports)
- Modify: `test/rowview.test.ts` (append the star/undo/awaiting suites)
- Modify: `public/app.js:1` (extend the existing `/star.js` and `/rowview.js` import lines)
- Modify: `public/app.js` `needsRowEl` (fill the `.nrow-star` slot added in Task 10)
- Modify: `public/app.js` `renderNeedsYou` (one line — pass the awaiting-pickup entries as `extra`)
- Modify: `public/app.js:700-712` (`sendReply` — unchanged call, reused by the staged sender)
- Modify: `public/app.js` init block (Task 8 owns it — **add exactly one line**, `initStagedFlush()`, after `initSearch()`)
- Modify: `public/style.css` (append star styles at EOF)

**Interfaces:**
- Consumes: `starOption(item)`, `canUndo(item)`, `createStagedSend({delayMs,setTimeoutFn,clearTimeoutFn,send})` from `/star.js`; `classifyLiveness(item, nowMs, liveSessionIds)` from `/attention.js`; `needsYouEntries(…, extra)` from `/rowview.js` (Task 10); `sendReply(id, text, context)` (app.js:700), `changeAnswer(it)` (Task 11), `draftReplyContexts` (app.js:697), `liveSessionIds()` (Task 7), `dismissStage` (Task 10)
- Produces: `SECONDARY_BUDGET: number`, `rowStarOption(model, item) -> Option | null`, `stagedLabel(staged) -> string`, `undoRefusal(item, nowMs) -> string | null`, `awaitingPickupEntries(items, nowMs, liveSessionIds) -> Entry[]`; `initStagedFlush()` in app.js

- [ ] **Step 1: Write the failing test**

```ts
// test/rowview.test.ts — append to the file created in Task 10
import {
  SECONDARY_BUDGET, rowStarOption, stagedLabel, undoRefusal, awaitingPickupEntries,
} from '../public/rowview.js'

describe('rowStarOption', () => {
  const withOpts = (opts: RowItem['options'], detail = 'short') => {
    const it2 = item({ options: opts, detail })
    return { it2, m: rowModel({ kind: 'item', item: it2, liveness: 'waiting' }) }
  }
  it('returns the single recommended option', () => {
    const { it2, m } = withOpts([{ label: 'Roll forward', recommended: true }, { label: 'Revert' }])
    expect(rowStarOption(m, it2)?.label).toBe('Roll forward')
  })
  it('is null when the agent marked two recommendations', () => {
    const { it2, m } = withOpts([{ label: 'A', recommended: true }, { label: 'B', recommended: true }])
    expect(rowStarOption(m, it2)).toBeNull()
  })
  it('is null when line 2 blows the one-line budget', () => {
    const { it2, m } = withOpts([{ label: 'A', recommended: true }], 'x'.repeat(SECONDARY_BUDGET + 1))
    expect(rowStarOption(m, it2)).toBeNull()
  })
  it('is null for a blocked board row and for an answered item', () => {
    const rowM = rowModel({
      kind: 'row', row: { id: 'r1', label: 'Deploy' }, board: { id: 'b1', project: 'web', title: 'Rollout' },
    })
    expect(rowStarOption(rowM, item())).toBeNull()
    const answered = item({ reply: 'go', options: [{ label: 'A', recommended: true }] })
    expect(rowStarOption(rowModel({ kind: 'item', item: answered, liveness: 'parked' }), answered)).toBeNull()
  })
})

describe('stagedLabel', () => {
  it('names what was accepted', () => {
    expect(stagedLabel({ label: 'Roll forward' })).toBe('Sent: Roll forward')
  })
})

describe('undoRefusal', () => {
  it('is null while the reply is still un-picked-up', () => {
    expect(undoRefusal(item({ reply: 'go' }), T0)).toBeNull()
  })
  it('explains the lost race once the agent picked it up', () => {
    const picked = item({ reply: 'go', reply_seen_at: new Date(T0).toISOString() })
    expect(undoRefusal(picked, T0 + 2 * 60_000))
      .toBe('Picked up 2m ago — answering again will not un-do it')
  })
})

describe('awaitingPickupEntries', () => {
  it('keeps only replied questions the agent has not picked up', () => {
    const items = [
      item({ id: 'a', reply: 'go' }),
      item({ id: 'b', reply: 'go', reply_seen_at: new Date(T0).toISOString() }),
      item({ id: 'c' }),
      item({ id: 'd', kind: 'note', reply: 'go' }),
    ]
    const entries = awaitingPickupEntries(items, T0, new Set<string>())
    expect(entries.map((e) => (e.kind === 'item' ? e.item.id : ''))).toEqual(['a'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `fnm exec --using=24 -- npx vitest run test/rowview.test.ts -t 'is null when the agent marked two recommendations'`
Expected: FAIL with `SyntaxError: The requested module '/Users/shariqhirani/Development/agent-inbox/public/rowview.js' does not provide an export named 'SECONDARY_BUDGET'`

- [ ] **Step 3: Write minimal implementation**

Extend the two import lines already at the head of `public/rowview.js` (Task 10) — no second
import from either module:

```js
import { canUndo, starOption } from './star.js'
import { attentionEntries, classifyLiveness, sortNeedsYou, ESCALATE_MS } from './attention.js'
```

Append to `public/rowview.js`:

```js
// Gate 2 of the safe star (§5): you may only one-tap what the row actually
// showed you, so a line-2 that would ellipsize kills the star.
export const SECONDARY_BUDGET = 140

export function rowStarOption(model, item) {
  if (model.kind !== 'item' || model.answered) return null
  if (model.secondary.length === 0 || model.secondary.length > SECONDARY_BUDGET) return null
  return starOption(item)
}

export function stagedLabel(staged) {
  return `Sent: ${staged.label}`
}

// Undo cannot win the race against a picked-up reply — say so instead of lying.
export function undoRefusal(item, nowMs) {
  if (canUndo(item)) return null
  return `Picked up ${relMs(nowMs - Date.parse(item.reply_seen_at))} ago — answering again will not un-do it`
}

// Replying does not resolve (§5): answered questions leave the active set and
// sit dimmed at the foot until the agent picks the answer up.
export function awaitingPickupEntries(items, nowMs, liveSessionIds) {
  return items
    .filter((i) => i.kind === 'question' && (i.status ?? 'open') === 'open' && i.reply && !i.reply_seen_at)
    .map((i) => ({ kind: 'item', item: i, liveness: classifyLiveness(i, nowMs, liveSessionIds) }))
}
```

Append to `public/rowview.d.ts`:

```ts
export const SECONDARY_BUDGET: number
export function rowStarOption(model: RowModel, item: RowItem): RowOption | null
export function stagedLabel(staged: { label: string }): string
export function undoRefusal(item: RowItem, nowMs: number): string | null
export function awaitingPickupEntries(items: RowItem[], nowMs: number, liveSessionIds: Set<string>): Entry[]
```

`public/app.js:1` — extend the two existing import lines (adding names, not new statements):

```js
import { canUndo, createStagedSend } from '/star.js'
import {
  ageChip, agentCounts, awaitingPickupEntries, needsYouEntries, relMs, rowModel, rowStarOption,
  stagedLabel, staleFoldLabel, streamCounts, undoRefusal, urgencyChip,
} from '/rowview.js'
```

Add the staged sender next to `dismissStage` (Task 10):

```js
const REPLY_DELAY_MS = 5000
const stagedStars = new Map() // item id → { label } inside its undo window
const starStage = createStagedSend({
  delayMs: REPLY_DELAY_MS,
  setTimeoutFn: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeoutFn: (h) => window.clearTimeout(h),
  // exactly the call the option pill makes today (app.js:726) — no new endpoint
  send: ({ id, label, context }) => { stagedStars.delete(id); sendReply(id, label, context) },
})

// a staged send must never be lost to a closing tab
function initStagedFlush() {
  const flushStaged = () => { starStage.flush(); dismissStage.flush() }
  window.addEventListener('beforeunload', flushStaged)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushStaged() })
}
```

`public/app.js` `renderNeedsYou` — one line: the awaiting-pickup group rides in as `extra`,
so `sortNeedsYou` drops it into the dimmed foot bucket:

```js
  const entries = needsYouEntries(items, boardsInView, nowMs, live, awaitingPickupEntries(items, nowMs, live))
```

`public/app.js` `needsRowEl` — fill the star slot (place just before the `stagedDismiss` block):

```js
  const slot = el.querySelector('.nrow-star')
  const staged = stagedStars.get(m.id)
  const opt = m.kind === 'item' ? rowStarOption(m, entry.item) : null
  if (staged) {
    el.classList.add('staged')
    const label = document.createElement('span')
    label.className = 'sent-label'
    label.textContent = `${stagedLabel(staged)} — `
    const undo = btn('Undo', () => {
      if (starStage.undo(`star:${m.id}`)) { stagedStars.delete(m.id); render(); return }
      const refusal = undoRefusal(entry.item, Date.now())
      if (refusal) { label.textContent = `${refusal} ` } else changeAnswer(entry.item)
    })
    undo.className = 'undo-btn'
    slot.replaceChildren(label, undo)
  } else if (opt) {
    const star = btn('★', () => {
      stagedStars.set(m.id, { label: opt.label })
      starStage.stage(`star:${m.id}`, { id: m.id, label: opt.label, context: draftReplyContexts[m.id] ?? '' })
      render()
    })
    star.className = 'star-btn'
    star.setAttribute('aria-label', `Answer: ${opt.label}`)
    star.title = `Answer: ${opt.label}`
    star.addEventListener('click', (ev) => ev.stopPropagation())
    slot.replaceChildren(star)
  } else if (m.answered && !canUndo(entry.item)) {
    const note = document.createElement('span')
    note.className = 'pickup picked'
    note.textContent = '✓ picked up'
    slot.replaceChildren(note)
  }
```

`public/app.js` init block — Task 8 owns that block; insert **exactly one line**,
`initStagedFlush()`, immediately after `initSearch()`. Do not re-quote or reorder the block,
and do not reference the deleted `initSections`.

`public/style.css` — append:

```css
.star-btn { border: none; background: transparent; color: color-mix(in srgb, goldenrod 85%, CanvasText); cursor: pointer; font-size: 14px; line-height: 1; padding: 0 2px; opacity: .75; }
.star-btn:hover, .star-btn:focus-visible { opacity: 1; transform: scale(1.15); }
.nrow-star { display: flex; align-items: center; gap: 4px; font-size: 11.5px; white-space: nowrap; }
.sent-label { opacity: .7; }
.nrow.staged .nrow-title { text-decoration: line-through; text-decoration-thickness: 1px; opacity: .7; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `fnm exec --using=24 -- sh -c 'npx vitest run test/rowview.test.ts && npx tsc --noEmit'`
Expected: PASS — every suite green, `tsc --noEmit` silent

- [ ] **Step 5: Commit**

```bash
git add public/rowview.js public/rowview.d.ts test/rowview.test.ts public/app.js public/style.css
git commit -m "feat(viewer): safe one-tap star with staged send, undo and blur flush"
```

---

### Task 13: Boards tab as a matrix

**Files:**
- Create: `public/boards.js`
- Create: `public/boards.d.ts`
- Test: `test/boards.test.ts`
- Modify: `public/app.js` — `rowCardEl` (split the shared `rowAnswerEl` out of it)
- Modify: `public/app.js` — `renderBoards` + `renderArchived` collapse into one Boards-tab renderer that owns the tab header and the archived fold
- Modify: `public/app.js` — `boardEl` → matrix (kills the `window.prompt()` annotation path)
- Modify: `public/app.js` — delete `renderRowToggle` and its call in `render()`
- Modify: `public/app.js` — `archiveBtn` (a board the human archives by hand must not linger)
- Modify: `public/style.css` — append the Boards chrome + matrix CSS at EOF (no `@media` blocks here; Task 18 owns those)

This task is the SOLE owner of the Boards tab chrome. Task 6 emits only
`<section class="panel" id="boards"><div class="boards"></div></section>` — no
`#rowTabs`, no `.panel-tools`, no static archived fold — so the hide-completed
toggle and the archived fold are built here, in JS.

**Interfaces:**
- Consumes: `isBlockedRowAttention(row) -> boolean` from `public/attention.js` (Task 3); `pcolor(name) -> { dot, wash }` and `themeName() -> 'light' | 'dark'` from Task 7 (the persisted-color wrapper — do not call `projectColor()` directly); `triageDeck` and `triageRemoveCurrent()` from the existing triage lightbox (`app.js:187-227`); existing `paginate(items, limit) -> { visible, remaining }` from `public/search.js`.
- Produces: `boardRowsView(board, opts) -> Array<{ row, num, needsAnswer }>`, `progressLabel(progress) -> { primary, secondary, complete }`, `hiddenDoneCount(board, opts) -> number`, `lingeringBoards(prevActiveIds, boards, archived) -> Board[]` (all in `public/boards.js`); in `app.js`: `rowAnswerEl(b, r, onSaved?) -> HTMLElement`, `rowPanelEl(b, r, readOnly) -> HTMLElement`, `boardsHeader() -> HTMLElement`, `renderBoards(boards, archived) -> void`.

- [ ] **Step 1: Write the failing test**

Create `test/boards.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { boardRowsView, progressLabel, hiddenDoneCount, lingeringBoards } from '../public/boards.js'

type Row = Parameters<typeof boardRowsView>[0]['rows'][number]

const row = (over: Partial<Row> & { id: string; status: Row['status'] }): Row => ({
  label: 'Row', note: '', context: '', annotation: null, annotation_unseen: false, ...over,
})

const board = (rows: Row[]) => ({
  id: 'b1',
  rows,
  progress: { done: rows.filter((r) => r.status === 'done').length, countable: rows.length, fraction: rows.length ? rows.filter((r) => r.status === 'done').length / rows.length : 0 },
})

describe('boardRowsView', () => {
  const b = board([
    row({ id: 'r1', status: 'done', label: 'Ship' }),
    row({ id: 'r2', status: 'blocked', label: 'Creds' }),
    row({ id: 'r3', status: 'tracked', label: 'Docs' }),
  ])

  it('numbers rows by their ORIGINAL position even when done rows are hidden', () => {
    const view = boardRowsView(b, { hideCompleted: true })
    expect(view.map((v) => v.row.id)).toEqual(['r2', 'r3'])
    expect(view.map((v) => v.num)).toEqual([2, 3])
  })

  it('keeps done rows when hideCompleted is off, or when this board opted back in', () => {
    expect(boardRowsView(b, { hideCompleted: false }).map((v) => v.num)).toEqual([1, 2, 3])
    expect(boardRowsView(b, { hideCompleted: true, showDone: true }).map((v) => v.num)).toEqual([1, 2, 3])
  })

  it('flags a blocked row as needing an answer', () => {
    const v = boardRowsView(b).find((x) => x.row.id === 'r2')!
    expect(v.needsAnswer).toBe(true)
  })

  it('clears needsAnswer once the human annotation has been seen by the agent', () => {
    const seen = board([row({ id: 'r2', status: 'blocked', annotation: 'use the staging key', annotation_unseen: false })])
    const unseen = board([row({ id: 'r2', status: 'blocked', annotation: 'use the staging key', annotation_unseen: true })])
    expect(boardRowsView(seen)[0]!.needsAnswer).toBe(false)
    expect(boardRowsView(unseen)[0]!.needsAnswer).toBe(true)
  })

  it('never flags a non-blocked row', () => {
    expect(boardRowsView(b).filter((v) => v.needsAnswer).map((v) => v.row.id)).toEqual(['r2'])
  })
})

describe('progressLabel', () => {
  it('makes done/countable primary and % secondary', () => {
    expect(progressLabel({ done: 3, countable: 5, fraction: 0.6 })).toEqual({ primary: '3/5', secondary: '60%', complete: false })
  })
  it('marks complete only when there is something countable', () => {
    expect(progressLabel({ done: 4, countable: 4, fraction: 1 }).complete).toBe(true)
    expect(progressLabel({ done: 0, countable: 0, fraction: 0 }).complete).toBe(false)
  })
  it('rounds the percentage', () => {
    expect(progressLabel({ done: 1, countable: 3, fraction: 1 / 3 }).secondary).toBe('33%')
  })
})

describe('hiddenDoneCount', () => {
  const b = board([row({ id: 'a', status: 'done' }), row({ id: 'b', status: 'done' }), row({ id: 'c', status: 'missing' })])
  it('counts the done rows currently hidden', () => {
    expect(hiddenDoneCount(b, { hideCompleted: true })).toBe(2)
  })
  it('is 0 when nothing is being hidden', () => {
    expect(hiddenDoneCount(b, { hideCompleted: false })).toBe(0)
    expect(hiddenDoneCount(b, { hideCompleted: true, showDone: true })).toBe(0)
  })
})

// spec §9: a board that hits 100% is archived by its agent moments later. If the
// card simply disappeared, the human would watch work vanish mid-glance — so a
// board seen ACTIVE earlier in this session lingers as "completed — archived".
describe('lingeringBoards', () => {
  const prog = (done: number, countable: number) => ({ done, countable, fraction: countable ? done / countable : 0 })
  const bd = (id: string, done: number, countable: number) => ({ id, progress: prog(done, countable) })

  it('lingers a completed board that was active this session and has since been archived', () => {
    expect(lingeringBoards(new Set(['b1']), [], [bd('b1', 3, 3)]).map((b) => b.id)).toEqual(['b1'])
  })
  it('does not linger a board that is still active — it renders in the main list', () => {
    expect(lingeringBoards(new Set(['b1']), [bd('b1', 3, 3)], [bd('b1', 3, 3)])).toEqual([])
  })
  it('does not linger an archive this session never saw active', () => {
    expect(lingeringBoards(new Set(), [], [bd('b9', 4, 4)])).toEqual([])
  })
  it('does not linger an incomplete board — only the 100% auto-archive vanishes mid-glance', () => {
    expect(lingeringBoards(new Set(['b2']), [], [bd('b2', 1, 4)])).toEqual([])
    expect(lingeringBoards(new Set(['b3']), [], [bd('b3', 0, 0)])).toEqual([])
  })
  it('accepts a plain array of previously-active ids', () => {
    expect(lingeringBoards(['b1'], [], [bd('b1', 2, 2)]).map((b) => b.id)).toEqual(['b1'])
  })
})

// rowCardEl mounts both in the triage lightbox (triageDeck open) and, since
// Task 11, inline in the Needs-you list (triageDeck null). Saving a blocked-row
// answer from the list must not throw just because there is no deck entry to
// remove — app.js has no DOM test harness in this repo (see test/shell.test.ts),
// so this is a source-level pin on the guard.
describe('rowCardEl never calls triageRemoveCurrent without a deck open', () => {
  const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  const start = js.indexOf('function rowCardEl')
  const fn = js.slice(start, start + 800) // rowCardEl's whole body fits comfortably in this window

  it('rowCardEl exists and guards the onSaved callback on triageDeck', () => {
    expect(start, 'rowCardEl is missing').toBeGreaterThan(-1)
    expect(fn).toContain('if (triageDeck) triageRemoveCurrent()')
  })

  it('never passes the bare triageRemoveCurrent reference as onSaved — that throws when the deck is closed', () => {
    expect(js).not.toContain('rowAnswerEl(b, r, triageRemoveCurrent)')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `fnm exec --using=24 -- npx vitest run test/boards.test.ts`
Expected: FAIL with `Cannot find module '../public/boards.js'` (and, before that, the tsc-side error `Cannot find module '../public/boards.js' or its corresponding type declarations`).

- [ ] **Step 3: Write minimal implementation**

Create `public/boards.js`:

```js
// Pure board-matrix helpers (spec §9). No DOM: the Boards tab renders from these.
// Sibling public modules are imported RELATIVELY so the same file resolves in the
// browser (/boards.js → /attention.js) and under vitest.
import { isBlockedRowAttention } from './attention.js'

// hide-completed hides `done` rows unless this board opted back in; `num` keeps the
// ORIGINAL 1-based index so "row N" references stay stable when rows are hidden.
export function boardRowsView(board, { hideCompleted = false, showDone = false } = {}) {
  return board.rows
    .map((row, i) => ({ row, num: i + 1, needsAnswer: isBlockedRowAttention(row) }))
    .filter(({ row }) => !(hideCompleted && !showDone && row.status === 'done'))
}

// done/countable is the primary reading; the percentage is secondary (spec §9).
export function progressLabel(progress) {
  return {
    primary: `${progress.done}/${progress.countable}`,
    secondary: `${Math.round(progress.fraction * 100)}%`,
    complete: progress.fraction === 1 && progress.countable > 0,
  }
}

// how many done rows this board is currently hiding — drives its "N hidden — show" hint
export function hiddenDoneCount(board, { hideCompleted = false, showDone = false } = {}) {
  if (!hideCompleted || showDone) return 0
  return board.rows.filter((r) => r.status === 'done').length
}

// Boards the human watched reach 100% and that their agent then archived. They
// stay on screen for the rest of the session instead of blinking out of the list
// (spec §9) — `prevActiveIds` is every board id seen active so far this session.
export function lingeringBoards(prevActiveIds, boards, archived) {
  const seen = new Set(prevActiveIds)
  const live = new Set(boards.map((b) => b.id))
  return archived.filter((b) =>
    seen.has(b.id) && !live.has(b.id) && b.progress.fraction === 1 && b.progress.countable > 0)
}
```

Create `public/boards.d.ts`:

```ts
export type RowStatus = 'done' | 'partial' | 'missing' | 'tracked' | 'na' | 'blocked'

export interface BoardRowLike {
  id: string
  label: string
  status: RowStatus
  note?: string
  context?: string
  annotation?: string | null
  annotation_unseen?: boolean
}

export interface ProgressLike { done: number; countable: number; fraction: number }
export interface BoardLike { id: string; rows: BoardRowLike[]; progress: ProgressLike }
export interface RowsViewOpts { hideCompleted?: boolean; showDone?: boolean }

export function boardRowsView(
  board: BoardLike,
  opts?: RowsViewOpts,
): Array<{ row: BoardRowLike; num: number; needsAnswer: boolean }>
export function progressLabel(progress: ProgressLike): { primary: string; secondary: string; complete: boolean }
export function hiddenDoneCount(board: BoardLike, opts?: RowsViewOpts): number
export function lingeringBoards<T extends { id: string; progress: ProgressLike }>(
  prevActiveIds: Iterable<string>,
  boards: Array<{ id: string }>,
  archived: T[],
): T[]
```

In `public/app.js`, add ONE new import line at the top:

```js
import { boardRowsView, progressLabel, hiddenDoneCount, lingeringBoards } from '/boards.js'
```

`pcolor(name)` is already declared (Task 7, wrapping `projectColor` with
`localStorage` persistence) — consume it directly. Do not call `projectColor()`
here, do not add a second `/colors.js` import, and do not re-declare a theme
or color helper.

Replace `rowCardEl` with a card that delegates its input to a shared answer row. This
MUST preserve Task 9's poll-suspension wiring — the original `rowCardEl` input listener
called `resumeRender()` on every keystroke so a non-empty row draft holds the poll; losing
that here would silently let the 3s rebuild eat an in-progress answer:

```js
// rows the user expanded in the matrix (context + answer panel), by row id —
// the board DOM is rebuilt every poll, so open state lives out here
const openRows = new Set()

// The ONE write path for a row annotation — single-line input, no window.prompt.
// Shared by the boards matrix and the triage card (spec §7).
function rowAnswerEl(b, r, onSaved) {
  const row = document.createElement('div')
  row.className = 'reply-row'
  const input = document.createElement('input')
  input.className = 'reply-input'
  input.placeholder = r.status === 'blocked' ? 'tell the agent how to proceed…' : 'your note on this row…'
  input.value = rowDrafts[r.id] ?? ''
  input.addEventListener('input', () => { rowDrafts[r.id] = input.value; resumeRender() })
  input.addEventListener('focus', () => { rowFocusId = r.id })
  const save = async () => {
    if (!input.value.trim()) return
    delete rowDrafts[r.id]
    if (rowFocusId === r.id) rowFocusId = null
    await fetch(`/api/boards/${b.id}/rows/${r.id}/annotate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: input.value.trim() }),
    })
    // the row stays blocked until the agent picks the note up — the human's part
    // is done, so the caller decides what to drop
    onSaved?.()
    load()
  }
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save() })
  row.appendChild(input)
  row.appendChild(btn('Send', save))
  if (rowFocusId === r.id) requestAnimationFrame(() => {
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  })
  return row
}

// the inline expansion under a matrix row: long context + existing annotation + answer
function rowPanelEl(b, r, readOnly = false) {
  const wrap = document.createElement('div')
  wrap.className = 'row-panel'
  wrap.innerHTML = `
    ${r.context ? `<div class="row-context-body">${esc(r.context)}</div>` : ''}
    ${r.annotation ? `<div class="annotation">📝 ${esc(r.annotation)}${r.annotation_unseen ? '<span class="unseen" title="Not yet seen by the agent">●</span>' : ''}</div>` : ''}`
  if (!readOnly) wrap.appendChild(rowAnswerEl(b, r))
  return wrap
}

// `rowCardEl` mounts in TWO places: the triage lightbox (where `triageDeck` is
// open) and, since Task 11, the inline Needs-you accordion (where it is `null`).
// Guard the onSaved callback here, at the definition, so neither call site has
// to know which context it is in — answering a blocked row from the list must
// not throw just because there is no deck to remove it from.
function rowCardEl(b, r) {
  const wrap = document.createElement('div')
  wrap.className = 'lb-row-card'
  wrap.innerHTML = `
    <div class="meta">🚧 blocked row · ${esc(b.title)} <span class="board-id">#${esc(b.id.slice(0, 6))}</span></div>
    <div class="title">${esc(r.label)}</div>
    ${r.note ? `<div class="detail">${esc(r.note)}</div>` : ''}
    ${r.context ? `<div class="detail lb-context">${esc(r.context)}</div>` : ''}
    ${r.annotation ? `<div class="annotation">📝 ${esc(r.annotation)}</div>` : ''}`
  wrap.appendChild(rowAnswerEl(b, r, () => { if (triageDeck) triageRemoveCurrent() }))
  return wrap
}
```

Replace `renderBoards` **and** `renderArchived` with a single Boards-tab renderer
that builds its own header, folds archived boards in, and keeps just-completed
boards on screen:

```js
let showArchived = false            // session-only: the archived fold is not persisted
const sessionActiveBoards = new Set() // board ids seen active at some point this session (§9)

// the Boards tab header — this tab's only chrome, built here because the shell
// ships an empty panel (no #rowTabs, no .panel-tools)
function boardsHeader() {
  const bar = document.createElement('div')
  bar.className = 'tab-header'
  const t = btn('hide completed rows', () => {
    hideCompleted = !hideCompleted
    localStorage.setItem(HIDE_DONE_KEY, String(hideCompleted))
    render()
  })
  t.className = `header-toggle${hideCompleted ? ' active' : ''}`
  bar.appendChild(t)
  return bar
}

function renderBoards(boards, archived) {
  const host = document.querySelector('#boards .boards')
  host.innerHTML = ''
  host.appendChild(boardsHeader())
  for (const b of boards) sessionActiveBoards.add(b.id)
  // a board that reaches 100% is archived by its agent seconds later; it lingers
  // here as a "completed — archived" card so finished work never blinks out (§9)
  const lingering = lingeringBoards(sessionActiveBoards, boards, archived)
  const lingerIds = new Set(lingering.map((b) => b.id))
  if (!boards.length && !lingering.length) host.insertAdjacentHTML('beforeend', `<p class="empty">${emptyMsg('No boards.')}</p>`)
  const { visible, remaining } = paginate(boards, shown.boards)
  for (const b of visible) host.appendChild(boardEl(b))
  if (remaining > 0) host.appendChild(moreButton('boards', remaining))
  for (const b of lingering) host.appendChild(boardEl(b, true, true))
  const rest = archived.filter((b) => !lingerIds.has(b.id))
  if (rest.length) {
    // un-archive is the only undo for Archive, so archived boards fold in here —
    // they must never become unreachable (spec §9)
    const fold = document.createElement('details')
    fold.className = 'archived-fold'
    fold.open = showArchived
    fold.addEventListener('toggle', () => { showArchived = fold.open })
    fold.innerHTML = `<summary>show archived (${rest.length})</summary>`
    const page = paginate(rest, shown.archived)
    for (const b of page.visible) fold.appendChild(boardEl(b, true))
    if (page.remaining > 0) fold.appendChild(moreButton('archived', page.remaining))
    host.appendChild(fold)
  }
}
```

Replace `boardEl` with the matrix:

```js
function boardEl(b, archived = false, lingering = false) {
  const el = document.createElement('details')
  const p = progressLabel(b.progress)
  el.className = `board${p.complete ? ' complete' : ''}${archived ? ' archived' : ''}${lingering ? ' lingering' : ''}`
  const stream = b.stream ? ` · ${esc(b.stream)}` : ''
  const c = pcolor(b.project)
  const hidden = hiddenDoneCount(b, { hideCompleted, showDone: showDoneBoards.has(b.id) })
  el.innerHTML = `
    <summary class="card-summary">
      <div class="board-head">
        <div class="board-title"><span class="caret"></span><span class="proj-dot" style="background:${c.dot}"></span>${esc(b.title)}<span class="board-id" title="board id">#${esc(b.id.slice(0, 6))}</span></div>
        <div class="board-meta">${esc(b.project)}${stream} · ${esc(b.agent)}</div>
      </div>
      <div class="bar"><div class="bar-fill" style="width:${p.secondary}"></div></div>
      <div class="bar-label"><strong class="prog-primary">${p.primary}</strong> done <span class="prog-secondary">${p.secondary}</span>${p.complete ? '<span class="complete-badge">✓ complete</span>' : ''}${lingering ? '<span class="linger-badge">completed — archived</span>' : ''}${hidden ? `<span class="hidden-hint" title="show this board's completed rows">· ${hidden} done hidden — show</span>` : ''}</div>
    </summary>`
  cardify(el, b.id)
  const hint = el.querySelector('.hidden-hint')
  if (hint) hint.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation() // don't toggle the surrounding <details>
    showDoneBoards.has(b.id) ? showDoneBoards.delete(b.id) : showDoneBoards.add(b.id)
    render()
  })
  const table = document.createElement('table')
  table.className = 'board-table matrix'
  for (const { row: r, num, needsAnswer } of boardRowsView(b, { hideCompleted, showDone: showDoneBoards.has(b.id) })) {
    const tr = document.createElement('tr')
    tr.className = `board-row${needsAnswer ? ' needs-answer' : ''}${openRows.has(r.id) ? ' open' : ''}`
    // one-line note only; the long context lives behind the row click
    tr.innerHTML = `
      <td class="row-num">${num}</td>
      <td class="row-glyph ${r.status}" title="${esc(r.status)}">${GLYPH[r.status] || ''}</td>
      <td class="row-label">${esc(r.label)}</td>
      <td class="row-note"><span class="note-line">${esc(r.note)}</span>${r.context ? '<span class="more-dot" title="has context — click the row">…</span>' : ''}${r.annotation ? `<span class="annotation-dot" title="${esc(r.annotation)}">📝${r.annotation_unseen ? '<span class="unseen">●</span>' : ''}</span>` : ''}</td>`
    const actionTd = document.createElement('td')
    actionTd.className = 'row-action'
    const toggle = () => {
      openRows.has(r.id) ? openRows.delete(r.id) : openRows.add(r.id)
      render()
    }
    if (needsAnswer && !archived) {
      const a = btn('Answer', toggle)
      a.className = 'answer-btn'
      actionTd.appendChild(a)
    } else if (r.context || !archived) {
      const a = btn(openRows.has(r.id) ? '▾' : '▸', toggle)
      a.className = 'row-expand'
      actionTd.appendChild(a)
    }
    tr.appendChild(actionTd)
    tr.addEventListener('click', (e) => { if (!e.target.closest('button, input')) toggle() })
    table.appendChild(tr)
    if (openRows.has(r.id)) {
      const ptr = document.createElement('tr')
      ptr.className = 'row-panel-row'
      const td = document.createElement('td')
      td.colSpan = 5
      td.appendChild(rowPanelEl(b, r, archived))
      ptr.appendChild(td)
      table.appendChild(ptr)
    }
  }
  el.appendChild(table)
  const actions = document.createElement('div')
  actions.className = 'actions'
  if (archived) {
    actions.appendChild(btn('Un-archive', async () => { await fetch(`/api/boards/${b.id}/unarchive`, { method: 'POST' }); load() }))
  } else {
    actions.appendChild(archiveBtn(b.id))
  }
  el.appendChild(actions)
  return el
}
```

In `archiveBtn`, forget the board the moment the HUMAN archives it — lingering is
for the agent's auto-archive, not for a card the human just chose to put away. Add
one line immediately before the `await fetch(.../archive…)` call:

```js
      sessionActiveBoards.delete(boardId)
```

Delete `renderRowToggle` entirely and its call in `render()` — the `#rowTabs` host
it wrote into no longer exists, so leaving it would throw on the first render. In
`render()`, there is only the single-arg `renderBoards(boards)` call left by Task
10 (Tasks 8 and 10 never wire a separate `renderArchived` call, so there is nothing
to merge away) — give it the archived list too:

```js
  renderBoards(boards, archived)
```

There is no `setCount('archived', …)` call anywhere in the count wiring to delete —
the archived fold lives inside the Boards panel and has no tab of its own, and Task
8's `tabCounts` loop only ever iterates `TAB_IDS`. Keep `setCount('boards', …)` as
the tab wiring leaves it.

Append the Boards chrome + matrix CSS to `public/style.css` (`.tab-header` /
`.header-toggle` are declared here once and reused by the Needs-you header in
Task 14):

```css
.tab-header { display: flex; justify-content: flex-end; gap: 8px; margin: 0 0 10px; }
.header-toggle { font: inherit; font-size: 12px; padding: 2px 11px; border-radius: 999px; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); background: transparent; color: inherit; cursor: pointer; opacity: .6; }
.header-toggle:hover { opacity: 1; }
.header-toggle.active { opacity: 1; border-color: LinkText; color: LinkText; }
.proj-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 7px; vertical-align: baseline; }
.prog-primary { font-variant-numeric: tabular-nums; opacity: .95; }
.prog-secondary { opacity: .5; margin-left: 6px; font-size: 11.5px; }
.board-table.matrix .row-glyph { width: 1%; text-align: center; font-size: 17px; line-height: 1.2; padding-right: 10px; }
.board-table.matrix .row-label { font-weight: 600; white-space: nowrap; }
.board-table.matrix .row-note { opacity: .75; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 0; }
.board-table.matrix .board-row { cursor: pointer; }
.board-table.matrix .board-row:hover td { background: color-mix(in srgb, CanvasText 4%, transparent); }
.board-table.matrix tr.needs-answer td { background: color-mix(in srgb, crimson 8%, transparent); }
.board-table.matrix tr.needs-answer .row-label { color: color-mix(in srgb, crimson 72%, CanvasText); }
.more-dot { opacity: .45; margin-left: 6px; }
.annotation-dot { margin-left: 8px; font-size: 11px; opacity: .7; }
.answer-btn { font: inherit; font-size: 11.5px; padding: 1px 10px; border-radius: 999px; border: 1px solid color-mix(in srgb, crimson 45%, transparent); background: transparent; color: inherit; cursor: pointer; font-weight: 600; }
.row-expand { font: inherit; font-size: 11px; padding: 1px 6px; border: none; background: transparent; color: inherit; opacity: .4; cursor: pointer; }
.row-panel-row td { padding: 6px 10px 10px 34px !important; }
.row-panel { font-size: 12.5px; }
.row-context-body { white-space: pre-wrap; opacity: .75; padding-left: 10px; border-left: 2px solid color-mix(in srgb, CanvasText 15%, transparent); margin-bottom: 6px; }
.archived-fold > summary { cursor: pointer; font-size: 12.5px; opacity: .5; margin: 14px 0 8px; }
.archived-fold > summary:hover { opacity: .85; }
.board.archived { opacity: .72; }
.board.lingering { opacity: 1; }
.linger-badge { margin-left: 8px; font-size: 11px; opacity: .6; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 999px; padding: 0 8px; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `fnm exec --using=24 -- npx vitest run test/boards.test.ts && fnm exec --using=24 -- npm run typecheck`
Expected: PASS (21 assertions green across `boardRowsView`, `progressLabel`, `hiddenDoneCount` and `lingeringBoards`; typecheck clean)

- [ ] **Step 5: Commit**

```bash
git add public/boards.js public/boards.d.ts test/boards.test.ts public/app.js public/style.css
git commit -m "feat(viewer): boards tab as a real matrix with inline row answers

Big status glyph column, bold label, one-line note, context on row click.
Blocked rows tint and expand into the shared answer card, replacing the
window.prompt annotation path. The tab builds its own header (hide completed)
and archived fold, renderRowToggle is gone, and a board auto-archived at 100%
lingers as 'completed — archived' for the session instead of vanishing.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 14: Notes read-state, note expiry, and the calm empty state

Everything visible in this task hangs off Task 10's `renderNeedsYou` — after
Task 10 nothing calls `renderGroups('needsYou', …)` any more, so the Triage
button, the calm empty state and the unread-notes chip are wired into
`renderNeedsYou` and its host `#needsYouList`.

**Files:**
- Create: `public/notes.js`
- Create: `public/notes.d.ts`
- Test: `test/notes.test.ts`
- Test: `test/tabs.test.ts` (Notes count becomes unread-only)
- Modify: `public/app.js` — `load()` (age notes before anything reads them)
- Modify: `public/app.js` — notes read-state (`NOTES_SEEN_KEY`, `markNotesSeen`)
- Modify: `public/app.js` — `renderNeedsYou` (header + calm empty state + foot chip)
- Modify: `public/app.js` — `renderGroups` tail (mark notes seen once the tab is on screen)
- Modify: `public/app.js` — the `tabCounts({ … })` argument in `render()` (one added property)
- Modify: `public/style.css` — append the calm-state + notes-chip CSS at EOF

**Interfaces:**
- Consumes: `NOTE_AGE_MS` from `public/attention.js` (Task 3); `selectTab(id)` and `activeTab` from Task 8; `renderNeedsYou`'s host `#needsYouList`, its `entries` array and its pager from Task 10; the existing `openTriage()` deck (`app.js`).
- Produces: `partitionNotes(notes, nowMs) -> { fresh, aged }`, `unreadNotes(notes, lastSeenIso, nowMs) -> Item[]`, `unreadNoteCount(notes, lastSeenIso, nowMs) -> number`, `ambientChips(items, boards, nowMs, lastSeenIso) -> Array<{ key, label }>` (all `public/notes.js`); in `app.js`: `ageNotes(g, nowMs)`, `markNotesSeen()`, `needsYouHeader()`, `renderNeedsYouExtras(host)`, `renderEmptyState(host)`.

- [ ] **Step 1: Write the failing test**

Create `test/notes.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { partitionNotes, unreadNotes, unreadNoteCount, ambientChips } from '../public/notes.js'

const NOW = Date.parse('2026-07-24T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const DAY = 24 * 3600e3

const note = (id: string, createdAgoMs: number) => ({
  id, kind: 'note' as const, status: 'open' as const, project: 'api', title: id,
  created_at: ago(createdAgoMs), reply: null, reply_seen_at: null,
})

describe('partitionNotes', () => {
  it('ages notes older than 7 days out of the notes bucket', () => {
    const { fresh, aged } = partitionNotes([note('new', DAY), note('old', 8 * DAY)], NOW)
    expect(fresh.map((n) => n.id)).toEqual(['new'])
    expect(aged.map((n) => n.id)).toEqual(['old'])
  })
  it('keeps a note that is exactly at the boundary', () => {
    const { fresh } = partitionNotes([note('edge', 7 * DAY)], NOW)
    expect(fresh.map((n) => n.id)).toEqual(['edge'])
  })
})

describe('unreadNotes', () => {
  const notes = [note('a', 2 * DAY), note('b', 1 * DAY), note('c', 9 * DAY)]
  it('counts everything when the user has never looked', () => {
    expect(unreadNotes(notes, null, NOW).map((n) => n.id)).toEqual(['a', 'b'])
  })
  it('counts only notes created after the last look', () => {
    expect(unreadNotes(notes, ago(1.5 * DAY), NOW).map((n) => n.id)).toEqual(['b'])
  })
  it('never counts an aged-out note as new', () => {
    expect(unreadNotes(notes, ago(30 * DAY), NOW).map((n) => n.id)).toEqual(['a', 'b'])
  })
  it('unreadNoteCount agrees with unreadNotes', () => {
    expect(unreadNoteCount(notes, ago(1.5 * DAY), NOW)).toBe(1)
    expect(unreadNoteCount([], null, NOW)).toBe(0)
  })
})

describe('ambientChips', () => {
  const items = [
    { ...note('n1', DAY) },
    { id: 'q1', kind: 'question', status: 'open', project: 'api', title: 'q', created_at: ago(DAY), reply: 'yes', reply_seen_at: null },
    { id: 'q2', kind: 'question', status: 'open', project: 'api', title: 'q', created_at: ago(DAY), reply: 'yes', reply_seen_at: ago(60e3) },
    { id: 'm1', kind: 'done', status: 'open', project: 'api', title: 'shipped', created_at: ago(DAY), reply: null, reply_seen_at: null },
  ]
  const boards = [
    { id: 'b1', project: 'api', progress: { done: 2, countable: 2, fraction: 1 } },
    { id: 'b2', project: 'api', progress: { done: 1, countable: 4, fraction: 0.25 } },
  ]

  it('returns discrete chips, not one joined string', () => {
    const chips = ambientChips(items, boards, NOW, null)
    expect(chips.map((c) => c.key)).toEqual(['awaiting', 'notes', 'milestones', 'boards'])
    expect(chips.map((c) => c.label)).toEqual([
      '1 answered · awaiting agent', '1 new note', '1 milestone', '2 boards · 1 complete',
    ])
  })
  it('drops chips whose count is zero', () => {
    expect(ambientChips([], [], NOW, null)).toEqual([])
  })
  it('drops the notes chip once they have been seen', () => {
    expect(ambientChips(items, boards, NOW, ago(0)).map((c) => c.key)).not.toContain('notes')
  })
  it('pluralises', () => {
    const two = [note('n1', DAY), note('n2', DAY)]
    expect(ambientChips(two, [], NOW, null)[0]!.label).toBe('2 new notes')
  })
})

// The triage deck survives (spec §15) but the old #now strip that used to open it
// is gone, so the Needs-you header is now its ONLY entry point. Assert it exists
// and that nothing opens the deck by itself (tenet 1: opt-in, never self-opening).
describe('triage stays reachable from Needs-you', () => {
  const appJs = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')

  it('the Needs-you header carries the opt-in Triage button', () => {
    expect(appJs).toMatch(/function needsYouHeader\(\)[\s\S]*?btn\('Triage →', openTriage\)/)
  })
  it('renderNeedsYou renders that header', () => {
    expect(appJs).toMatch(/function renderNeedsYou\([^)]*\)\s*\{[\s\S]*?needsYouHeader\(\)/)
  })
  it('the auto-opening #now strip is not back', () => {
    expect(appJs).not.toContain('renderNow')
  })
})
```

In `test/tabs.test.ts` (Task 8), append the unread-only semantics for the Notes
count — the tab number now means "new since you last looked", not "notes in view":

```ts
describe('Notes count is unread-only (spec §8)', () => {
  it('reports the unread note count, not how many notes are on screen', () => {
    const c = tabCounts({
      globalAttention: 0,
      unreadNotes: 1,
      scoped: { boards: [], notes: [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }], done: [] },
    })
    expect(c.notes).toBe(1)
  })
  it('is 0 once every note has been seen, even with notes in the list', () => {
    const c = tabCounts({
      globalAttention: 0,
      unreadNotes: 0,
      scoped: { boards: [], notes: [{ id: 'n1' }, { id: 'n2' }], done: [] },
    })
    expect(c.notes).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `fnm exec --using=24 -- npx vitest run test/notes.test.ts test/tabs.test.ts`
Expected: FAIL — `test/notes.test.ts` cannot resolve `../public/notes.js`, and the two new `test/tabs.test.ts` cases fail because `app.js` still passes the raw scoped note list.

- [ ] **Step 3: Write minimal implementation**

Create `public/notes.js`:

```js
// Notes: read-state + expiry (spec §8) and the calm state's ambient counts (§7).
// Pure — no DOM, no storage; the viewer passes `nowMs` and the last-seen stamp in.
import { NOTE_AGE_MS } from './attention.js'

// Notes older than NOTE_AGE_MS stop being notes and age into Done, so the tab
// count can come back down instead of growing forever.
export function partitionNotes(notes, nowMs) {
  const cutoff = nowMs - NOTE_AGE_MS
  const fresh = []
  const aged = []
  for (const n of notes) (Date.parse(n.created_at) >= cutoff ? fresh : aged).push(n)
  return { fresh, aged }
}

// "new since you last looked" — an aged-out note is never new.
export function unreadNotes(notes, lastSeenIso, nowMs) {
  const { fresh } = partitionNotes(notes, nowMs)
  return lastSeenIso ? fresh.filter((n) => n.created_at > lastSeenIso) : fresh
}

export function unreadNoteCount(notes, lastSeenIso, nowMs) {
  return unreadNotes(notes, lastSeenIso, nowMs).length
}

const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`

// Ambient status for the "Nothing needs you" panel, as DISCRETE chips. None of
// these is attention (spec §7) — they are the things you may glance at and leave.
export function ambientChips(items, boards, nowMs, lastSeenIso) {
  const open = items.filter((i) => i.status === 'open')
  const awaiting = open.filter((i) => i.kind === 'question' && i.reply && !i.reply_seen_at).length
  const milestones = open.filter((i) => i.kind === 'done').length
  const unread = unreadNoteCount(open.filter((i) => i.kind === 'note'), lastSeenIso, nowMs)
  const complete = boards.filter((b) => b.progress.fraction === 1 && b.progress.countable > 0).length
  const chips = []
  if (awaiting) chips.push({ key: 'awaiting', label: `${awaiting} answered · awaiting agent` })
  if (unread) chips.push({ key: 'notes', label: `${unread} new note${unread > 1 ? 's' : ''}` })
  if (milestones) chips.push({ key: 'milestones', label: plural(milestones, 'milestone') })
  if (boards.length) chips.push({ key: 'boards', label: `${plural(boards.length, 'board')}${complete ? ` · ${complete} complete` : ''}` })
  return chips
}
```

Create `public/notes.d.ts`:

```ts
export interface NoteLike {
  id: string
  kind?: string
  status?: string
  created_at: string
  reply?: string | null
  reply_seen_at?: string | null
}
export interface BoardProgressLike { progress: { done: number; countable: number; fraction: number } }

export function partitionNotes<T extends NoteLike>(notes: T[], nowMs: number): { fresh: T[]; aged: T[] }
export function unreadNotes<T extends NoteLike>(notes: T[], lastSeenIso: string | null, nowMs: number): T[]
export function unreadNoteCount(notes: NoteLike[], lastSeenIso: string | null, nowMs: number): number
export function ambientChips(
  items: NoteLike[],
  boards: BoardProgressLike[],
  nowMs: number,
  lastSeenIso: string | null,
): Array<{ key: string; label: string }>
```

In `public/app.js` add ONE new import line at the top (`/attention.js` is already
imported by earlier tasks — do not add a second import from it):

```js
import { partitionNotes, unreadNoteCount, ambientChips } from '/notes.js'
```

Add the notes read-state next to the other localStorage keys:

```js
const NOTES_SEEN_KEY = 'agent-inbox-notes-seen'
let notesSeenAt = localStorage.getItem(NOTES_SEEN_KEY) || null
function markNotesSeen() {
  notesSeenAt = new Date().toISOString()
  localStorage.setItem(NOTES_SEEN_KEY, notesSeenAt)
}
```

In `load()`, age notes once, before anything reads the data, so every count
downstream derives from the same partition — replace the `lastData = { g, … }`
assignment with:

```js
    lastData = { g: ageNotes(g, Date.now()), boards, archived, activity }
```

and define it next to `allItems`:

```js
// notes age into Done after NOTE_AGE_MS (spec §8) — done at the door so the
// Notes tab, the Done tab and search all agree
function ageNotes(g, nowMs) {
  const aged = []
  const notes = g.notes
    .map((gr) => {
      const part = partitionNotes(gr.items, nowMs)
      aged.push(...part.aged)
      return { ...gr, items: part.fresh }
    })
    .filter((gr) => gr.items.length > 0)
  return { ...g, notes, done: [...g.done, ...aged] }
}
```

Add the Needs-you header, the foot chip and the calm empty state (place them just
above `renderNeedsYou`):

```js
// The Needs-you header: opt-in triage only (tenet 1) — a button, never a flow
// that opens itself. With the old #now strip gone this is the deck's only door.
function needsYouHeader() {
  const bar = document.createElement('div')
  bar.className = 'tab-header'
  const tri = btn('Triage →', openTriage)
  tri.className = 'triage-btn'
  bar.appendChild(tri)
  return bar
}

// one quiet chip at the very foot of the Needs-you list — notes are seen in the
// flow the user actually opens, without entering the attention set (spec §8)
function renderNeedsYouExtras(host) {
  const notes = lastData.g.notes.flatMap((gr) => gr.items)
  const n = unreadNoteCount(notes, notesSeenAt, Date.now())
  if (!n) return
  const chip = btn(`${n} new note${n > 1 ? 's' : ''}`, () => selectTab('notes'))
  chip.className = 'notes-chip'
  host.appendChild(chip)
}

// the calm state: no red, no call to action, ambient counts as discrete chips
function renderEmptyState(host) {
  const panel = document.createElement('div')
  panel.className = 'calm-panel'
  panel.innerHTML = '<div class="calm-head">Nothing needs you</div>'
  const chips = ambientChips(allItems(lastData.g), lastData.boards, Date.now(), notesSeenAt)
  if (chips.length) {
    const row = document.createElement('div')
    row.className = 'calm-chips'
    for (const c of chips) {
      const s = document.createElement('span')
      s.className = `calm-chip chip-${c.key}`
      s.textContent = c.label // ambient labels are agent-derived counts — textContent, never innerHTML
      row.appendChild(s)
    }
    panel.appendChild(row)
  }
  host.appendChild(panel)
}
```

Wire all three into Task 10's `renderNeedsYou` (host `#needsYouList`). Replace its
host-reset line

```js
  host.innerHTML = entries.length ? '' : `<p class="empty">${emptyMsg('Nothing needs you.')}</p>`
```

with:

```js
  host.innerHTML = ''
  host.appendChild(needsYouHeader())
  if (!entries.length) {
    // a search that matched nothing still says so; an empty INBOX gets the calm panel
    if (searchQuery.trim()) host.insertAdjacentHTML('beforeend', `<p class="empty">${emptyMsg('Nothing needs you.')}</p>`)
    else renderEmptyState(host)
  }
```

and add one line at the end of `renderNeedsYou`, after its `moreButton` pager:

```js
  renderNeedsYouExtras(host)
```

At the end of `renderGroups` (which now renders only the Notes tab), mark notes
seen once they are actually on screen:

```js
  if (sectionId === 'notes' && activeTab === 'notes') markNotesSeen()
```

Marking AFTER the render means this pass still shows the badge and the next poll
clears it.

Finally, feed the unread count into the tab wiring: add ONE property to the
`tabCounts({ … })` argument object in `render()`, immediately after
`globalAttention:`:

```js
    unreadNotes: unreadNoteCount(g.notes.flatMap((gr) => gr.items), notesSeenAt, Date.now()),
```

Append to `public/style.css` (`.tab-header` and `.triage-btn` already exist —
Task 13 and the original stylesheet respectively; do not redeclare them):

```css
.calm-panel { border: 1px solid color-mix(in srgb, seagreen 22%, transparent); background: color-mix(in srgb, seagreen 6%, transparent); border-radius: 10px; padding: 22px 18px; text-align: center; }
.calm-head { font-size: 15px; opacity: .75; }
.calm-chips { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; margin-top: 12px; }
.calm-chip { font-size: 12px; padding: 2px 10px; border-radius: 999px; border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); opacity: .6; }
.notes-chip { display: block; width: 100%; margin: 14px 0 2px; padding: 6px; font: inherit; font-size: 12.5px; background: transparent; border: 1px dashed color-mix(in srgb, CanvasText 20%, transparent); border-radius: 6px; color: inherit; opacity: .5; cursor: pointer; }
.notes-chip:hover { opacity: .85; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `fnm exec --using=24 -- npx vitest run test/notes.test.ts test/tabs.test.ts && fnm exec --using=24 -- npm run typecheck`
Expected: PASS (16 assertions green in `test/notes.test.ts`, `test/tabs.test.ts` green including the two unread-only cases; typecheck clean)

- [ ] **Step 5: Commit**

```bash
git add public/notes.js public/notes.d.ts test/notes.test.ts test/tabs.test.ts public/app.js public/style.css
git commit -m "feat(viewer): note read-state, 7-day note expiry, calm empty state

Notes get a last-seen stamp so the tab count means 'new since you last
looked'; unread notes surface as one quiet chip at the foot of Needs-you and
notes older than NOTE_AGE_MS age into Done. An empty Needs-you list renders a
calm panel whose ambient counts are discrete chips, and the opt-in Triage
button moves into the Needs-you header — the deck's only remaining door.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 15: Search across tabs (per-tab and per-project match counts)

**Files:**
- Create: `public/tabsearch.js`
- Create: `public/tabsearch.d.ts`
- Test: `test/tabsearch.test.ts`
- Modify: `public/app.js` — `render()` (compute the unscoped match index, paint tab + rail counts)
- Modify: `public/app.js` — the hand-rolled live haystack mapping → `liveEntity`
- Modify: `public/app.js` — `emptyMsg` (never a bare "no matches")
- Modify: `public/app.js` — `initSearch` (the query persists across tab and project changes)
- Modify: `public/style.css` — append the match-badge CSS at EOF

**Interfaces:**
- Consumes: `searchMatches(entities, query, filterFn) -> Set<string> | null` from `public/search.js` (unchanged); `selectTab(id)` and `activeTab` from Task 8; `railProjects({ items, boards, archived, activity }) -> string[]` from Task 7; the rail row markup `button.rail-tab[data-project=<key>]` containing `span.rail-match` (Task 7).
- Produces: `liveEntity(activity) -> HaystackEntity`, `searchIndex(data, query, filterFn) -> { needsYou, notes, done, boards, live }` (each `Set<string> | null`), `tabMatchCounts(data, query, filterFn) -> Record<tab, number | null>`, `projectMatchCounts(data, query, filterFn) -> Map<string, number>`, `otherTabMatches(counts, activeTab) -> Array<{ tab, n }>` (all `public/tabsearch.js`); in `app.js`: `setTabMatch(tab, n)`, `setRailMatch(project, n)`.

- [ ] **Step 1: Write the failing test**

Create `test/tabsearch.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import uFuzzy from '@leeoniya/ufuzzy'
import { liveEntity, searchIndex, tabMatchCounts, projectMatchCounts, otherTabMatches } from '../public/tabsearch.js'

const uf = new uFuzzy({ intraMode: 1 })
const fuzzy = (hay: string[], needle: string) => uf.filter(hay, needle)

const data = {
  g: {
    needsYou: [{ project: 'api', items: [{ id: 'q1', title: 'rotate the auth token', project: 'api', agent: 'claude' }] }],
    notes: [{ project: 'web', items: [{ id: 'n1', title: 'auth cookie workaround', project: 'web', agent: 'claude' }] }],
    done: [{ id: 'd1', title: 'billing migration', project: 'web', agent: 'claude' }],
  },
  boards: [{ id: 'b1', title: 'Auth rollout', project: 'api', agent: 'claude', rows: [{ label: 'Deploy', note: '' }] }],
  archived: [{ id: 'b2', title: 'Old auth spike', project: 'infra', agent: 'claude', rows: [] }],
  activity: [
    { session: 's1', project: 'infra', agent: 'claude', stream: '', doing: 'wiring auth headers', detail: '', children: [] },
    { session: 's2', project: 'web', agent: 'codex', stream: '', doing: 'writing docs', detail: '', children: [{ name: 'sub', doing: 'lint' }] },
  ],
}

describe('liveEntity', () => {
  it('flattens a session (and its children) into a haystack-shaped entity', () => {
    const e = liveEntity(data.activity[1]!)
    expect(e.id).toBe('s2')
    expect(e.title).toBe('writing docs')
    expect(e.detail).toBe('sub lint')
  })
})

describe('searchIndex', () => {
  it('returns null per tab when there is no query (everything shows)', () => {
    const idx = searchIndex(data, '  ', fuzzy)
    expect(idx.needsYou).toBeNull()
    expect(idx.boards).toBeNull()
    expect(idx.live).toBeNull()
  })
  it('indexes each tab independently, across the whole dataset', () => {
    const idx = searchIndex(data, 'auth', fuzzy)
    expect([...idx.needsYou!]).toEqual(['q1'])
    expect([...idx.notes!]).toEqual(['n1'])
    expect([...idx.boards!].sort()).toEqual(['b1', 'b2'])
    expect([...idx.live!]).toEqual(['s1'])
    expect([...idx.done!]).toEqual([])
  })
})

describe('tabMatchCounts', () => {
  it('counts matches behind every tab, not just the active one', () => {
    expect(tabMatchCounts(data, 'auth', fuzzy)).toEqual({ needsYou: 1, boards: 2, live: 1, notes: 1, done: 0 })
  })
  it('is all-null with no query', () => {
    expect(tabMatchCounts(data, '', fuzzy)).toEqual({ needsYou: null, boards: null, live: null, notes: null, done: null })
  })
})

describe('projectMatchCounts', () => {
  it('counts matching entities per project across all tabs', () => {
    const m = projectMatchCounts(data, 'auth', fuzzy)
    expect(m.get('api')).toBe(2)   // q1 + b1
    expect(m.get('web')).toBe(1)   // n1
    expect(m.get('infra')).toBe(2) // b2 + s1
  })
  it('is empty with no query', () => {
    expect(projectMatchCounts(data, '', fuzzy).size).toBe(0)
  })
})

describe('otherTabMatches', () => {
  it('lists the tabs holding matches you are not looking at', () => {
    const counts = { needsYou: 0, boards: 2, live: 1, notes: 1, done: 0 }
    expect(otherTabMatches(counts, 'needsYou')).toEqual([{ tab: 'boards', n: 2 }, { tab: 'live', n: 1 }, { tab: 'notes', n: 1 }])
  })
  it('is empty when nothing matches anywhere else', () => {
    expect(otherTabMatches({ needsYou: 3, boards: 0, live: 0, notes: 0, done: 0 }, 'needsYou')).toEqual([])
  })
  it('is empty with no query (null counts)', () => {
    expect(otherTabMatches({ needsYou: null, boards: null, live: null, notes: null, done: null }, 'needsYou')).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `fnm exec --using=24 -- npx vitest run test/tabsearch.test.ts`
Expected: FAIL with `Cannot find module '../public/tabsearch.js'`

- [ ] **Step 3: Write minimal implementation**

Create `public/tabsearch.js`:

```js
// Cross-tab search accounting (spec §12). With content behind tabs, a scoped
// search produces confident false negatives — so a query is always measured
// against the WHOLE dataset, per tab and per project, whatever is on screen.
// search.js stays untouched: searchMatches/haystackFor are shape-agnostic and
// every shape here is mapped onto that same haystack contract.
import { searchMatches } from './search.js'

const TABS = ['needsYou', 'boards', 'live', 'notes', 'done']

// one haystack-shaped entity per live session, children folded into `detail`
export function liveEntity(a) {
  return {
    id: a.session,
    title: a.doing,
    project: a.project,
    agent: a.agent,
    stream: a.stream,
    detail: [a.detail, ...(a.children ?? []).flatMap((c) => [c.name, c.doing])].filter(Boolean).join(' '),
  }
}

const items = (groups) => groups.flatMap((gr) => gr.items)

// { tab -> Set of matching ids | null }. Unscoped by project/agent on purpose:
// tab counts must stay honest while the rail narrows the visible list.
export function searchIndex(data, query, filterFn) {
  const hit = (ents) => searchMatches(ents, query, filterFn)
  return {
    needsYou: hit(items(data.g.needsYou)),
    notes: hit(items(data.g.notes)),
    done: hit(data.g.done),
    boards: hit([...data.boards, ...data.archived]),
    live: hit((data.activity ?? []).map(liveEntity)),
  }
}

export function tabMatchCounts(data, query, filterFn) {
  const idx = searchIndex(data, query, filterFn)
  const out = {}
  for (const t of TABS) out[t] = idx[t] === null ? null : idx[t].size
  return out
}

export function projectMatchCounts(data, query, filterFn) {
  const out = new Map()
  const idx = searchIndex(data, query, filterFn)
  if (idx.needsYou === null) return out // no query → no per-project search badges
  const hit = new Set(TABS.flatMap((t) => [...idx[t]]))
  const bump = (p) => out.set(p, (out.get(p) ?? 0) + 1)
  for (const it of [...items(data.g.needsYou), ...items(data.g.notes), ...data.g.done]) if (hit.has(it.id)) bump(it.project)
  for (const b of [...data.boards, ...data.archived]) if (hit.has(b.id)) bump(b.project)
  for (const a of data.activity ?? []) if (hit.has(a.session)) bump(a.project)
  return out
}

// the tabs holding matches the user is NOT currently looking at — this is what
// makes a bare "no matches" impossible
export function otherTabMatches(counts, activeTab) {
  return TABS
    .filter((t) => t !== activeTab && (counts[t] ?? 0) > 0)
    .map((t) => ({ tab: t, n: counts[t] }))
}
```

Create `public/tabsearch.d.ts`:

```ts
import type { HaystackEntity } from './search.js'

export type TabName = 'needsYou' | 'boards' | 'live' | 'notes' | 'done'
export type FilterFn = (haystack: string[], needle: string) => number[] | null

export interface ActivityLike {
  session: string
  project: string
  agent?: string
  stream?: string
  doing?: string
  detail?: string
  children?: Array<{ name?: string; doing?: string }>
}

export interface SearchData {
  g: {
    needsYou: Array<{ items: Array<HaystackEntity & { project: string }> }>
    notes: Array<{ items: Array<HaystackEntity & { project: string }> }>
    done: Array<HaystackEntity & { project: string }>
  }
  boards: Array<HaystackEntity & { project: string }>
  archived: Array<HaystackEntity & { project: string }>
  activity?: ActivityLike[]
}

export function liveEntity(a: ActivityLike): HaystackEntity
export function searchIndex(data: SearchData, query: string, filterFn: FilterFn): Record<TabName, Set<string> | null>
export function tabMatchCounts(data: SearchData, query: string, filterFn: FilterFn): Record<TabName, number | null>
export function projectMatchCounts(data: SearchData, query: string, filterFn: FilterFn): Map<string, number>
export function otherTabMatches(counts: Record<TabName, number | null>, activeTab: TabName): Array<{ tab: TabName; n: number }>
```

In `public/app.js` add ONE new import line at the top (`railProjects` is already on
the existing `import { … } from '/rail.js'` line from Task 7 — consume that
binding, do not import it twice):

```js
import { liveEntity, tabMatchCounts, projectMatchCounts, otherTabMatches } from '/tabsearch.js'
```

Add the badge painters and the module-level count cache next to `setCount`:

```js
let matchCounts = { needsYou: null, boards: null, live: null, notes: null, done: null }

// a small "N" beside a tab label — how many matches hide behind THAT tab
function setTabMatch(tab, n) {
  const el = document.querySelector(`#tabs .tab[data-tab="${tab}"]`)
  if (!el) return
  let badge = el.querySelector('.match-count')
  if (n === null || n === 0) { badge?.remove(); return }
  if (!badge) {
    badge = document.createElement('span')
    badge.className = 'match-count'
    el.appendChild(badge)
  }
  badge.textContent = String(n)
}

// the rail row already ships an empty <span class="rail-match"> (Task 7) — this
// only fills it in, so the rail's own markup stays the single source of truth
function setRailMatch(project, n) {
  const el = document.querySelector(`#rail button.rail-tab[data-project="${CSS.escape(project)}"] .rail-match`)
  if (!el) return
  el.textContent = n ? String(n) : ''
  el.hidden = !n
}
```

In `render()`, compute the unscoped counts right after the visible slice is
derived — i.e. after `const { g, boards, archived } = applySearch(filterData(lastData))`
and after `renderRail()` has (re)built the rail rows, so the painters have
something to write into. `applySearch` is unchanged; it still scopes only what is
*visible*:

```js
  // counts are computed against lastData, NOT the filtered slice: selecting a
  // project or a tab narrows the list, never the search signal (spec §12)
  matchCounts = tabMatchCounts(lastData, searchQuery, fuzzyFilter)
  for (const [tab, n] of Object.entries(matchCounts)) setTabMatch(tab, n)
  const projMatches = projectMatchCounts(lastData, searchQuery, fuzzyFilter)
  const projects = railProjects({
    items: allItems(lastData.g), boards: lastData.boards, archived: lastData.archived, activity: lastData.activity,
  })
  for (const p of projects) setRailMatch(p, projMatches.get(p) ?? 0)
```

Replace the hand-rolled live haystack (the inline `pillLive.map((a) => ({ id: a.session, … }))`
object literal) with the shared mapper:

```js
  const liveMatched = searchMatches(pillLive.map(liveEntity), searchQuery, fuzzyFilter)
```

Replace `emptyMsg` so a tab can never claim there are no matches while another tab
holds some:

```js
// section empty-state text: search-aware, and never a BARE "no matches" — it
// always points at the tabs that do have hits (spec §12)
function emptyMsg(base) {
  const q = searchQuery.trim()
  if (!q) return base
  const elsewhere = otherTabMatches(matchCounts, activeTab)
  const where = elsewhere.map(({ tab, n }) => `${n} in ${TAB_LABEL[tab]}`).join(' · ')
  return `No matches for &ldquo;${esc(q)}&rdquo; here${where ? ` — <span class="match-elsewhere">${where}</span>` : ' or in any other tab'}`
}

const TAB_LABEL = { needsYou: 'Needs you', boards: 'Boards', live: 'Live', notes: 'Notes', done: 'Done' }
```

`activeTab` is Task 8's module-level tab state — read it, never re-declare it.

Replace `initSearch` so the query survives tab and project changes — it lives in
module state and is re-applied to the box after any shell rebuild:

```js
function initSearch() {
  const input = document.getElementById('search')
  input.value = searchQuery // the query persists across tab and project changes
  let t = null
  input.addEventListener('input', () => {
    clearTimeout(t)
    t = setTimeout(() => { searchQuery = input.value; resetPaging(); render() }, 120)
  })
}
```

Verify nothing clears it: `grep -n "searchQuery = ''" public/app.js` must return only
the declaration near the top of the file. Neither the rail's project handler nor
`selectTab` may touch `searchQuery` or the input's value.

Append to `public/style.css`:

```css
.match-count { display: inline-block; min-width: 16px; margin-left: 6px; padding: 0 5px; border-radius: 999px; font-size: 10.5px; font-variant-numeric: tabular-nums; background: color-mix(in srgb, LinkText 18%, transparent); color: LinkText; }
.rail-match { margin-left: auto; font-size: 10.5px; opacity: .7; font-variant-numeric: tabular-nums; color: LinkText; }
.match-elsewhere { opacity: .85; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `fnm exec --using=24 -- npx vitest run test/tabsearch.test.ts test/search.test.ts && fnm exec --using=24 -- npm run typecheck`
Expected: PASS — `test/tabsearch.test.ts` green and `test/search.test.ts` still green (including `paginateGroups`, which stays exported and tested even though the viewer no longer calls it)

- [ ] **Step 5: Commit**

```bash
git add public/tabsearch.js public/tabsearch.d.ts test/tabsearch.test.ts public/app.js public/style.css
git commit -m "feat(viewer): search across tabs with per-tab and per-rail match counts

A query is measured against the whole dataset, so no tab can render a bare
'no matches' while hits sit behind another one; the empty state names where
they are. Per-project counts land in the rail's .rail-match slot and the query
persists across tab and project changes. search.js is untouched.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 16: Badge + deep link (spec §11)

**Files:**
- Create: `public/badge.js`
- Create: `public/badge.d.ts`
- Test: `test/badge.test.ts`
- Modify: `public/app.js` — a NEW `/badge.js` import line (the `/attention.js` import line is NOT touched — `attentionCount` is already on it from Task 8, and this task needs no other name from that module), `render()` (call `applyBadge()` first), `load()` (boot focus), and the bottom init block (Task 8 owns it — insert EXACTLY ONE line, `initFocusHash()` after `initSearch()`)
- Modify: `electron/main.cjs:19-32` (requires + module handles), `electron/main.cjs:108-138` (`startAttentionWatch`)
- Verify only, no edit: `scripts/package-app.sh` (must keep staging `public/`)

**Interfaces:**
- Consumes: `attentionCount(items, boards, nowMs, liveSessionIds) -> number` and `isBlockedRowAttention(row) -> boolean` from `public/attention.js` (Task 3); `selectTab(id)` from Task 8 (`id ∈ 'needsYou'|'boards'|'live'|'notes'|'done'` — it sets `activeTab` AND shows the panel); `setOpenRow(id)` from Task 9; `allItems(g)`, `projectFilter`/`PROJECT_KEY`, `agentFilter`/`FILTER_KEY` and `render()` from app.js.
- Produces: `titleWithBadge(base: string, count: number) -> string` (**this module is the sole owner of the document-title badge** — `public/tabs.js` deliberately exports no `titlePrefix`), `focusHashFor(id: string) -> string`, `parseFocusHash(hash: string) -> { id: string } | null`; and in app.js `focusItem(id) -> void` (wired to the notification click and the URL hash), `applyBadge() -> void`, `initFocusHash() -> void`.

- [ ] **Step 1: Write the failing test**

```ts
// test/badge.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { titleWithBadge, focusHashFor, parseFocusHash } from '../public/badge.js'

describe('titleWithBadge', () => {
  it('prefixes the count when the attention set is non-empty', () => {
    expect(titleWithBadge('Agent Inbox', 3)).toBe('(3) Agent Inbox')
  })
  it('is the bare title at zero — the badge must be able to reach zero (tenet 2)', () => {
    expect(titleWithBadge('Agent Inbox', 0)).toBe('Agent Inbox')
  })
  it('never renders a negative or fractional count', () => {
    expect(titleWithBadge('Agent Inbox', -2)).toBe('Agent Inbox')
    expect(titleWithBadge('Agent Inbox', 2.7)).toBe('(2) Agent Inbox')
    expect(titleWithBadge('Agent Inbox', Number.NaN)).toBe('Agent Inbox')
  })
})

describe('focus hash', () => {
  it('round-trips an id', () => {
    expect(parseFocusHash(focusHashFor('abc-123'))).toEqual({ id: 'abc-123' })
  })
  it('encodes ids containing slashes so the hash stays parseable', () => {
    expect(focusHashFor('a/b')).toBe('#item/a%2Fb')
    expect(parseFocusHash('#item/a%2Fb')).toEqual({ id: 'a/b' })
  })
  it('parses a hash with no leading #', () => {
    expect(parseFocusHash('item/xyz')).toEqual({ id: 'xyz' })
  })
  it('ignores unrelated or empty hashes', () => {
    expect(parseFocusHash('#boards')).toBeNull()
    expect(parseFocusHash('#item/')).toBeNull()
    expect(parseFocusHash('')).toBeNull()
  })
})

// The Electron dock badge dynamically imports public/attention.js and
// public/badge.js from REPO_ROOT = path.resolve(__dirname, '..'), which inside
// the packaged .app is the STAGED root (Contents/Resources/app). If the
// packaging script ever stops copying public/ there, or starts using an asar
// archive, those imports fail and the dock badge silently freezes. Pin both.
describe('packaged app can resolve public/ from REPO_ROOT', () => {
  const sh = readFileSync(new URL('../scripts/package-app.sh', import.meta.url), 'utf8')
  it('stages public/ alongside electron/ and dist/', () => {
    expect(sh).toContain('cp -R "$ROOT/dist" "$ROOT/public" "$ROOT/electron" "$STAGE/"')
  })
  it('packages unarchived, so plain file paths resolve at runtime', () => {
    expect(sh).toContain('--no-asar')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `fnm exec --using=24 -- npx vitest run test/badge.test.ts`
Expected: FAIL with `Error: Failed to load url ../public/badge.js (resolved id: /Users/shariqhirani/Development/agent-inbox/public/badge.js)`

- [ ] **Step 3: Write minimal implementation**

```js
// public/badge.js
// Pure badge + deep-link helpers (spec §11). No DOM — the caller owns
// document.title and location.hash.

// The browser's ambient signal: `(3) Agent Inbox`. The count is always the
// GLOBAL attention set, never the filtered view (§7 filter-blindness).
export function titleWithBadge(base, count) {
  const n = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0
  return n > 0 ? `(${n}) ${base}` : base
}

// A link that survives a reload: #item/<id>.
export function focusHashFor(id) {
  return `#item/${encodeURIComponent(String(id))}`
}

export function parseFocusHash(hash) {
  const m = /^#?item\/(.+)$/.exec(String(hash ?? ''))
  if (!m || !m[1]) return null
  try {
    return { id: decodeURIComponent(m[1]) }
  } catch {
    return { id: m[1] } // malformed escape — take it literally rather than lose the link
  }
}
```

```ts
// public/badge.d.ts
export function titleWithBadge(base: string, count: number): string
export function focusHashFor(id: string): string
export function parseFocusHash(hash: string): { id: string } | null
```

- [ ] **Step 4: Run test to verify it passes**

Run: `fnm exec --using=24 -- npx vitest run test/badge.test.ts`
Expected: PASS

- [ ] **Step 5: Wire the browser badge + focusItem into app.js**

Imports — this task needs no new name from `/attention.js`: `attentionCount` is
already on that import line (Task 8), so **do not touch it** — by this point in
the plan it also carries `classifyLiveness` (Task 11) and `staleEntries` (Task
10); re-quoting the line here without those names would delete them and break
every render that uses them. Add only the one new line for the new module:

```js
import { titleWithBadge, focusHashFor, parseFocusHash } from '/badge.js'
```

Add this block after `allItems` (`public/app.js:41-43`):

```js
const BASE_TITLE = 'Agent Inbox'

// The document-title badge is GLOBAL — filters narrow the list, never the
// signal (spec §7). Zero attention ⇒ the bare title, so the badge can rest.
// This is the ONLY writer of document.title in the product.
function applyBadge() {
  const live = new Set((lastData.activity ?? []).map((a) => a.session))
  const n = attentionCount(allItems(lastData.g), lastData.boards, Date.now(), live)
  document.title = titleWithBadge(BASE_TITLE, n)
}

// Which tab holds an item — a deep link must land on the right one.
function tabForItem(it) {
  if (lastData.g.notes.some((gr) => gr.items.some((x) => x.id === it.id))) return 'notes'
  if (lastData.g.done.some((x) => x.id === it.id)) return 'done'
  return 'needsYou'
}

// Notification click / URL hash entry point (spec §11): select the item's
// project, switch to its tab, expand it, scroll to it.
function focusItem(id) {
  if (!lastData) return
  const item = allItems(lastData.g).find((i) => i.id === id)
  const board = [...lastData.boards, ...lastData.archived].find((b) => b.id === id)
  const target = item ?? board
  if (!target) return
  projectFilter = target.project
  localStorage.setItem(PROJECT_KEY, target.project)
  agentFilter = null
  localStorage.removeItem(FILTER_KEY)
  selectTab(board ? 'boards' : tabForItem(item)) // Task 8: sets activeTab AND shows the panel
  setOpenRow(id)                                  // Task 9: single-open accordion
  const hash = focusHashFor(id)
  if (location.hash !== hash) location.hash = hash // survives reload
  render()
  requestAnimationFrame(() => {
    const el = document.querySelector(`[data-card-id="${CSS.escape(id)}"]`)
    if (!el) return
    if (el.tagName === 'DETAILS') el.open = true
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    if (typeof el.focus === 'function') el.focus({ preventScroll: true })
  })
}

let bootFocusDone = false

function applyFocusHash() {
  const f = parseFocusHash(location.hash)
  if (f) focusItem(f.id)
}

function initFocusHash() {
  window.addEventListener('hashchange', applyFocusHash)
}
```

In `render()` (`public/app.js:69`), make `applyBadge()` the **first statement of the function body**, ahead of `renderRail()` / the tab-count work — the title must be refreshed even if a later renderer throws.

In `load()` (`public/app.js:23-39`), immediately after the `renderIfIdle()` call (Task 9 replaced the bare `render()` there) add:

```js
    if (!bootFocusDone) { bootFocusDone = true; applyFocusHash() }
```

Init block (owned by Task 8) — insert **exactly one line**, `initFocusHash()`, after `initSearch()`.

- [ ] **Step 6: Wire the Electron dock badge and notification click**

`electron/main.cjs:19-32` — add ESM module handles below the existing requires. `REPO_ROOT` is already `path.resolve(__dirname, '..')` (`main.cjs:29`); inside the packaged `.app` that is `Contents/Resources/app`, the staged root — see Step 7 for why `public/` is there. A failed import must be **loud**: a silently swallowed one freezes the dock badge forever, which is exactly the failure the badge exists to prevent.

```js
// One attention predicate for the whole product (spec §7 / tenet 3): the dock
// badge imports the very module the viewer renders from. ESM from CJS →
// dynamic import, started once and awaited per poll.
const ATTENTION_PATH = path.join(REPO_ROOT, 'public', 'attention.js')
const BADGE_PATH = path.join(REPO_ROOT, 'public', 'badge.js')

for (const p of [ATTENTION_PATH, BADGE_PATH]) {
  if (!existsSync(p)) {
    console.error(`[agent-inbox] FATAL: missing ${p}. The packaged app must stage public/ next to electron/ (scripts/package-app.sh) — dock badge will be disabled.`)
  }
}

let attentionModsFailed = false
const attentionMods = Promise.all([
  import(pathToFileURL(ATTENTION_PATH).href),
  import(pathToFileURL(BADGE_PATH).href),
]).then(([attention, badge]) => ({ ...attention, ...badge }))

attentionMods.catch((err) => {
  attentionModsFailed = true
  // LOUD, once: never let the badge stop updating in silence.
  console.error('[agent-inbox] FATAL: could not load the attention/badge modules — dock badge disabled', err)
  if (typeof app.setBadgeCount === 'function') app.setBadgeCount(0)
})
```

`electron/main.cjs:108-138` — replace the body of `startAttentionWatch`'s interval with:

```js
function startAttentionWatch(win) {
  let known = null // ids seen on the previous poll; null until the first one
  setInterval(async () => {
    if (attentionModsFailed) return // already logged once — don't spam every 3s
    let mods
    try {
      mods = await attentionMods
    } catch {
      return // the .catch above owns the (loud) reporting
    }
    const { attentionCount, isBlockedRowAttention, focusHashFor } = mods
    try {
      const g = await (await fetch(`${URL_BASE}api/items`)).json()
      const boards = await (await fetch(`${URL_BASE}api/boards`)).json()
      const activity = await (await fetch(`${URL_BASE}api/activity`)).json()
      const items = [
        ...g.needsYou.flatMap((gr) => gr.items),
        ...g.notes.flatMap((gr) => gr.items),
        ...g.done,
      ]
      const liveSessions = new Set(activity.map((a) => a.session))
      // The badge is the §7 attention set — annotated-and-seen blocked rows and
      // stale items are OUT, so the count can return to zero.
      const count = attentionCount(items, boards, Date.now(), liveSessions)
      if (typeof app.setBadgeCount === 'function') app.setBadgeCount(count)
      const entries = [
        ...g.needsYou.flatMap((gr) => gr.items).filter((i) => !i.reply)
          .map((q) => ({ id: `q:${q.id}`, itemId: q.id, text: q.title })),
        ...boards.flatMap((b) => b.rows.filter(isBlockedRowAttention)
          .map((r) => ({ id: `r:${r.id}`, itemId: b.id, text: `🚧 ${b.title} · ${r.label}` }))),
      ]
      const fresh = known === null ? [] : entries.filter((e) => !known.has(e.id))
      known = new Set(entries.map((e) => e.id))
      // Per-item notifications stay (owner's call) — informational only.
      if (fresh.length && Notification.isSupported()) {
        console.log(`[agent-inbox] notifying: ${fresh.length} new (${fresh[0].text})`)
        // No action buttons: a notification never mutates state (spec §11 / tenet 1).
        const note = new Notification({
          title: fresh.length === 1 ? 'Agent Inbox — needs you' : `Agent Inbox — ${fresh.length} new need you`,
          body: fresh.slice(0, 3).map((f) => f.text).join('\n'),
        })
        const hash = fresh.length === 1 ? focusHashFor(fresh[0].itemId) : null
        note.on('click', () => {
          if (win.isMinimized()) win.restore()
          win.show()
          win.focus()
          // Clicking only opens the app — and, for a single item, lands on it.
          if (hash) win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch((err) => {
            console.error('[agent-inbox] deep link failed', err)
          })
        })
        note.show()
      }
    } catch { /* viewer briefly unreachable — retry next tick */ }
  }, 3000)
}
```

- [ ] **Step 7: Verify the packaging script really stages `public/`**

`scripts/package-app.sh` needs **no edit** — confirm it, don't change it. What it does today: line 22 is
`cp -R "$ROOT/dist" "$ROOT/public" "$ROOT/electron" "$STAGE/"`, so `build/stage/` gets `public/`,
`electron/` and `dist/` as siblings; line 45 writes a staged `package.json` with `main: 'electron/main.cjs'`;
lines 55-58 run `@electron/packager … --no-asar`, so at runtime `__dirname` is
`…/Agent Inbox.app/Contents/Resources/app/electron`, `REPO_ROOT` is `…/Resources/app`, and
`REPO_ROOT/public/attention.js` is a real file on disk. New files under `public/` (including
`badge.js`) are picked up automatically by the recursive copy — nothing to add.

Run: `fnm exec --using=24 -- npx vitest run test/badge.test.ts -t "packaged app"`
Expected: PASS (both assertions — the `cp -R` line and `--no-asar`)

Then confirm end-to-end on a real bundle:

```bash
npm run package:app
ls "out/Agent Inbox-darwin-arm64/Agent Inbox.app/Contents/Resources/app/public/attention.js" \
   "out/Agent Inbox-darwin-arm64/Agent Inbox.app/Contents/Resources/app/public/badge.js"
```

Expected: both paths listed. Launch the app and confirm the console prints no
`[agent-inbox] FATAL:` line and the dock badge tracks the viewer's title count.

- [ ] **Step 8: Run the full suite and typecheck**

Run: `fnm exec --using=24 -- npm test && fnm exec --using=24 -- npm run typecheck`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add public/badge.js public/badge.d.ts test/badge.test.ts public/app.js electron/main.cjs
git commit -m "feat(viewer): trustworthy badge + focusItem deep link

Spec §11: document.title gets a '(3) Agent Inbox' prefix from the GLOBAL
attention set (public/badge.js is the single owner — tabs.js exports no
titlePrefix), and the Electron dock uses app.setBadgeCount fed by the same
public/attention.js predicate, so the badge can reach zero. The dock's
dynamic import of public/ now fails LOUDLY instead of silently freezing the
badge, and a test pins scripts/package-app.sh to keep staging public/
--no-asar so REPO_ROOT resolves inside the .app. Notification click (kept,
informational only, no action buttons) sets #item/<id>, which focusItem()
resolves into project + tab + expand + scroll, and which survives a reload.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 17: Keyboard + accessibility (spec §13)

**Files:**
- Create: `public/keys.js`
- Create: `public/keys.d.ts`
- Test: `test/keys.test.ts`
- Modify: `public/app.js` — a NEW `/keys.js` import line and the existing `/card.js` import line (add `optionOrder` to it); `public/app.js:303-309` (retire the triage-only keydown, including its `'t'` opener — `initKeys` owns `t` now); Task 7's `renderRail()` and Task 8's `initTabs()` (roving-tablist wiring); Task 10's `needsRowEl` (liveness glyph on the chip); Task 12's star slot (accessible name); the bottom init block (Task 8 owns it — insert EXACTLY ONE line, `initKeys()` after `initSearch()`)
- Modify: `public/style.css` — append a small focus/selection block at EOF (no `@media` rules; those are Task 18's alone)
- Modify: `test/shell.test.ts` — the triage-reachability assertion moves with `'t'`: it no longer checks for `e.key === 't'` in `app.js` (that literal is gone; Task 6's `initTriage` listener lost its `'t'` branch and its replacement lives in `public/keys.js`, which has its own test)

**Interfaces:**
- Consumes: `setOpenRow(id)` and `openRowId` from Task 9; `render()`; `optionOrder(options)` from `public/card.js` (Task 11) so keyboard numbers match the on-screen order; `rowStarOption(m, item)` from `public/rowview.js` and the `.nrow-star` slot from Task 12; `dismissStage` / `stagedDismiss` (the staged 5s-undo dismiss path) from Task 10; the liveness strings `'waiting'|'parked'|'stale'` produced by `classifyLiveness` in `public/attention.js` (Task 3); the shell's `#rail` / `#tabs` / `#needsYouList` hosts (Task 6) and the `.nrow[data-card-id]` / `.nrow-card` markup (Task 10); existing `sendReply(id, text, context)` (`app.js:700`), `act(id, action)` (`app.js:833`), `openTriage()`, `triageDeck` / `findEntryData(entry)` / `renderTriage()` / `closeTriage()` (`app.js:187-310`).
- Produces: `keyAction(key: string, ctx?: KeyContext) -> KeyIntent | null`, `rovingIndex(current: number, key: string, count: number) -> number`, `ariaAnswerLabel(option) -> string | null`, `livenessGlyph(liveness) -> { glyph: string, text: string }`, `KEYS`; and in app.js `selectRow(id)`, `keyTargetItem()` (the reply target for the keyboard — the deck's on-screen entry while `triageDeck` is open, `selectedItem()` otherwise), `runIntent(intent)`, `dismissRowStaged(id)`, `initKeys()`, `wireTablist(host, orientation)`.

- [ ] **Step 1: Write the failing test**

```ts
// test/keys.test.ts
import { describe, it, expect } from 'vitest'
import { keyAction, rovingIndex, ariaAnswerLabel, livenessGlyph } from '../public/keys.js'

describe('keyAction — list keys', () => {
  it('j/ArrowDown move down, k/ArrowUp move up', () => {
    expect(keyAction('j', {})).toEqual({ type: 'move', delta: 1 })
    expect(keyAction('ArrowDown', {})).toEqual({ type: 'move', delta: 1 })
    expect(keyAction('k', {})).toEqual({ type: 'move', delta: -1 })
    expect(keyAction('ArrowUp', {})).toEqual({ type: 'move', delta: -1 })
  })
  it('Enter expands, x dismisses, e resolves, / focuses search', () => {
    expect(keyAction('Enter', {})).toEqual({ type: 'expand' })
    expect(keyAction('x', {})).toEqual({ type: 'dismiss' })
    expect(keyAction('e', {})).toEqual({ type: 'resolve' })
    expect(keyAction('/', {})).toEqual({ type: 'search' })
  })
  it('1-4 pick option N — but only options that exist', () => {
    expect(keyAction('1', { optionCount: 3 })).toEqual({ type: 'option', index: 0 })
    expect(keyAction('3', { optionCount: 3 })).toEqual({ type: 'option', index: 2 })
    expect(keyAction('4', { optionCount: 3 })).toBeNull()
    expect(keyAction('1', { optionCount: 0 })).toBeNull()
  })
  it('returns null for unmapped keys', () => {
    expect(keyAction('q', {})).toBeNull()
    expect(keyAction('5', { optionCount: 9 })).toBeNull()
  })
})

describe('keyAction — never steal a keystroke from an input', () => {
  it('is inert while typing, except Escape which blurs', () => {
    expect(keyAction('j', { typing: true })).toBeNull()
    expect(keyAction('x', { typing: true })).toBeNull()
    expect(keyAction('1', { typing: true, optionCount: 3 })).toBeNull()
    expect(keyAction('Escape', { typing: true })).toEqual({ type: 'blur' })
  })
})

// The Now strip's "Triage →" button is gone (Task 6); 't' is the deck's only
// remaining door, and it must not fight the deck's own keys once open.
describe("keyAction — 't' opens the triage deck", () => {
  it('opens the deck when it is closed', () => {
    expect(keyAction('t', {})).toEqual({ type: 'openDeck' })
  })
  it('is inert once the deck is already open — deck keys own the keyboard there', () => {
    expect(keyAction('t', { deckOpen: true })).toBeNull()
  })
  it('never steals a "t" typed into a field', () => {
    expect(keyAction('t', { typing: true })).toBeNull()
  })
})

describe('keyAction — the Escape ladder', () => {
  it('closes the deck first, then collapses, then clears the selection', () => {
    expect(keyAction('Escape', { deckOpen: true, expanded: true })).toEqual({ type: 'closeDeck' })
    expect(keyAction('Escape', { expanded: true })).toEqual({ type: 'collapse' })
    expect(keyAction('Escape', {})).toEqual({ type: 'clearSelection' })
  })
})

describe('keyAction — the triage deck keeps the same keys as the list', () => {
  it('maps j/k and the arrows onto deck navigation', () => {
    expect(keyAction('j', { deckOpen: true })).toEqual({ type: 'deckNext' })
    expect(keyAction('ArrowRight', { deckOpen: true })).toEqual({ type: 'deckNext' })
    expect(keyAction('k', { deckOpen: true })).toEqual({ type: 'deckPrev' })
    expect(keyAction('ArrowLeft', { deckOpen: true })).toEqual({ type: 'deckPrev' })
  })
  it('still accepts an option by number inside the deck', () => {
    expect(keyAction('2', { deckOpen: true, optionCount: 2 })).toEqual({ type: 'option', index: 1 })
  })
})

describe('rovingIndex — tablist roving focus', () => {
  it('wraps forward and back', () => {
    expect(rovingIndex(0, 'ArrowDown', 3)).toBe(1)
    expect(rovingIndex(2, 'ArrowDown', 3)).toBe(0)
    expect(rovingIndex(0, 'ArrowUp', 3)).toBe(2)
    expect(rovingIndex(1, 'ArrowRight', 3)).toBe(2)
    expect(rovingIndex(1, 'ArrowLeft', 3)).toBe(0)
  })
  it('Home/End jump to the ends and unmapped keys hold', () => {
    expect(rovingIndex(2, 'Home', 4)).toBe(0)
    expect(rovingIndex(0, 'End', 4)).toBe(3)
    expect(rovingIndex(2, 'a', 4)).toBe(2)
  })
  it('is safe on an empty tablist', () => {
    expect(rovingIndex(0, 'ArrowDown', 0)).toBe(0)
  })
})

describe('ariaAnswerLabel — the star says what it sends', () => {
  it('reads "Answer: <label>"', () => {
    expect(ariaAnswerLabel({ label: 'Ship it', recommended: true })).toBe('Answer: Ship it')
  })
  it('is null with no option — no star, no name', () => {
    expect(ariaAnswerLabel(null)).toBeNull()
    expect(ariaAnswerLabel({})).toBeNull()
  })
})

describe('livenessGlyph — colour is never the only carrier', () => {
  it('gives every state a glyph AND text', () => {
    expect(livenessGlyph('waiting')).toEqual({ glyph: '◉', text: 'waiting' })
    expect(livenessGlyph('parked')).toEqual({ glyph: '◌', text: 'parked' })
    expect(livenessGlyph('stale')).toEqual({ glyph: '·', text: 'stale' })
  })
  it('degrades rather than rendering a bare colour', () => {
    expect(livenessGlyph('nonsense')).toEqual({ glyph: '·', text: 'nonsense' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `fnm exec --using=24 -- npx vitest run test/keys.test.ts`
Expected: FAIL with `Error: Failed to load url ../public/keys.js (resolved id: /Users/shariqhirani/Development/agent-inbox/public/keys.js)`

- [ ] **Step 3: Write minimal implementation**

```js
// public/keys.js
// Pure keyboard mapping and accessible-name helpers (spec §13). No DOM: the
// caller hands in the key plus what is on screen and gets back an intent.

export const KEYS = {
  next: ['j', 'ArrowDown'],
  prev: ['k', 'ArrowUp'],
}

// ctx: { typing, deckOpen, expanded, optionCount }
export function keyAction(key, ctx = {}) {
  const { typing = false, deckOpen = false, expanded = false, optionCount = 0 } = ctx
  if (key === 'Escape') {
    if (typing) return { type: 'blur' }
    if (deckOpen) return { type: 'closeDeck' }
    if (expanded) return { type: 'collapse' }
    return { type: 'clearSelection' }
  }
  if (typing) return null // an input owns every other keystroke
  // the Now strip's "Triage →" button is gone (Task 6) — 't' is the deck's only
  // remaining door, and it only opens: an already-open deck owns its own keys
  if (key === 't' && !deckOpen) return { type: 'openDeck' }
  if (deckOpen) {
    if (key === 'ArrowRight' || KEYS.next.includes(key)) return { type: 'deckNext' }
    if (key === 'ArrowLeft' || KEYS.prev.includes(key)) return { type: 'deckPrev' }
  } else {
    if (KEYS.next.includes(key)) return { type: 'move', delta: 1 }
    if (KEYS.prev.includes(key)) return { type: 'move', delta: -1 }
  }
  if (key === 'Enter') return { type: 'expand' }
  // accepting a recommendation by keyboard costs the same as reading it
  if (/^[1-4]$/.test(key)) {
    const index = Number(key) - 1
    return index < optionCount ? { type: 'option', index } : null
  }
  if (key === 'x') return { type: 'dismiss' }
  if (key === 'e') return { type: 'resolve' }
  if (key === '/') return { type: 'search' }
  return null
}

// Roving focus for a tablist (rail + top tabs): exactly one tab is tabbable and
// the arrows move between them.
export function rovingIndex(current, key, count) {
  if (count <= 0) return 0
  const wrap = (i) => ((i % count) + count) % count
  switch (key) {
    case 'ArrowDown':
    case 'ArrowRight':
      return wrap(current + 1)
    case 'ArrowUp':
    case 'ArrowLeft':
      return wrap(current - 1)
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return current
  }
}

// The star's accessible name must say what one tap sends.
export function ariaAnswerLabel(option) {
  return option && option.label ? `Answer: ${option.label}` : null
}

// Every colour-coded state also carries a glyph AND text.
const LIVENESS = {
  waiting: { glyph: '◉', text: 'waiting' },
  parked: { glyph: '◌', text: 'parked' },
  stale: { glyph: '·', text: 'stale' },
}

export function livenessGlyph(liveness) {
  return LIVENESS[liveness] ?? { glyph: '·', text: String(liveness ?? '') }
}
```

```ts
// public/keys.d.ts
export interface KeyContext {
  typing?: boolean
  deckOpen?: boolean
  expanded?: boolean
  optionCount?: number
}

export type KeyIntent =
  | { type: 'move'; delta: number }
  | { type: 'expand' }
  | { type: 'collapse' }
  | { type: 'clearSelection' }
  | { type: 'blur' }
  | { type: 'option'; index: number }
  | { type: 'dismiss' }
  | { type: 'resolve' }
  | { type: 'search' }
  | { type: 'deckPrev' }
  | { type: 'deckNext' }
  | { type: 'closeDeck' }
  | { type: 'openDeck' }

export const KEYS: { next: string[]; prev: string[] }
export function keyAction(key: string, ctx?: KeyContext): KeyIntent | null
export function rovingIndex(current: number, key: string, count: number): number
export function ariaAnswerLabel(option: { label?: string } | null | undefined): string | null
export function livenessGlyph(liveness: string): { glyph: string; text: string }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `fnm exec --using=24 -- npx vitest run test/keys.test.ts`
Expected: PASS

- [ ] **Step 5: Wire the single keyboard handler into app.js**

Add ONE new import line, and **edit** the existing `/card.js` import line (Task 11 created it) to pull in `optionOrder` — the keyboard's 1-4 must number the options in exactly the order the card paints them:

```js
import { keyAction, rovingIndex, ariaAnswerLabel, livenessGlyph } from '/keys.js'
import { cardSections, optionOrder, recommendedWarning } from '/card.js'
```

Add this block just above `function btn(` (`public/app.js:818`):

```js
// ── keyboard (spec §13) ─────────────────────────────────────────────────────
// ONE handler for the list and the triage deck, so the deck's keys and the
// list's keys can never drift apart.
let selectedId = null    // the row the keyboard is on
let returnFocusId = null // row that gets focus back when its card collapses

function rowEls() {
  return [...document.querySelectorAll('#needsYouList .nrow[data-card-id]')]
}

function selectRow(id) {
  selectedId = id
  for (const el of rowEls()) {
    const on = el.dataset.cardId === id
    el.classList.toggle('selected', on)
    el.setAttribute('aria-selected', String(on))
    el.tabIndex = on ? 0 : -1
    if (on) el.focus({ preventScroll: false })
  }
}

function selectedItem() {
  if (!selectedId || !lastData) return null
  return allItems(lastData.g).find((i) => i.id === selectedId) ?? null
}

// The keyboard's reply target. `selectedId` is the LIST's selection — while the
// triage deck is open that is a different row than whatever the lightbox is
// showing, so a bare `selectedItem()` would let '1'-'4' answer the wrong item
// (a wrong-item write). While the deck is open, the target is always the
// entry currently on screen in it.
function keyTargetItem() {
  if (triageDeck) return findEntryData(triageDeck.entries[triageDeck.index])?.it ?? null
  return selectedItem()
}

// Same staged 5s-undo path the ✕ button uses (Task 10) — a keyboard dismiss
// must be exactly as reversible as a mouse dismiss.
function dismissRowStaged(id) {
  if (stagedDismiss.has(id)) return
  stagedDismiss.add(id)
  dismissStage.stage(`dismiss:${id}`, { id })
  render()
}

function runIntent(intent) {
  const ids = rowEls().map((el) => el.dataset.cardId)
  const it = keyTargetItem()
  switch (intent.type) {
    case 'move': {
      if (!ids.length) return
      const at = ids.indexOf(selectedId)
      const from = at < 0 ? (intent.delta > 0 ? -1 : ids.length) : at
      selectRow(ids[Math.max(0, Math.min(ids.length - 1, from + intent.delta))])
      return
    }
    case 'expand':
      if (!selectedId) return
      returnFocusId = selectedId
      setOpenRow(selectedId)
      render()
      requestAnimationFrame(() => {
        const card = document.querySelector(`.nrow[data-card-id="${CSS.escape(selectedId)}"] .nrow-card`)
        if (card) { card.tabIndex = -1; card.focus({ preventScroll: true }) }
      })
      return
    case 'collapse': {
      const back = returnFocusId ?? selectedId
      returnFocusId = null
      setOpenRow(null)
      render()
      if (back) requestAnimationFrame(() => selectRow(back)) // focus RETURNS to the row
      return
    }
    case 'clearSelection':
      selectRow(null)
      return
    case 'option': {
      const o = optionOrder(it?.options)[intent.index]
      if (o && it) sendReply(it.id, o.label, draftReplyContexts[it.id] ?? '')
      return
    }
    case 'dismiss':
      if (it) dismissRowStaged(it.id) // items only; a blocked board row is not dismissible
      return
    case 'resolve':
      if (selectedId) act(selectedId, 'resolve')
      return
    case 'search':
      document.getElementById('search').focus()
      return
    case 'blur':
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur()
      return
    case 'deckPrev':
      triageDeck.index = Math.max(0, triageDeck.index - 1)
      renderTriage()
      return
    case 'deckNext':
      triageDeck.index = Math.min(triageDeck.entries.length - 1, triageDeck.index + 1)
      renderTriage()
      return
    case 'closeDeck':
      closeTriage()
      return
    case 'openDeck':
      openTriage() // the Now strip's button is gone (Task 6) — 't' is the deck's door now
      return
  }
}

function initKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    // Task 10's row already handles Enter/Escape/x when the row itself has
    // focus and calls preventDefault(); don't run the action twice.
    if (e.defaultPrevented) return
    const t = e.target
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
    // optionCount must come from the SAME target runIntent will answer — the
    // deck entry while it's open, the list selection otherwise — or a
    // keyboard '1'-'4' can validate against one item and answer another.
    const intent = keyAction(e.key, {
      typing,
      deckOpen: !!triageDeck,
      expanded: openRowId != null,
      optionCount: optionOrder(keyTargetItem()?.options).length,
    })
    if (!intent) return
    e.preventDefault()
    runIntent(intent)
  })
}

// Rail and top tabs are real tablists with roving focus.
function wireTablist(host, orientation) {
  if (!host) return
  host.setAttribute('role', 'tablist')
  host.setAttribute('aria-orientation', orientation)
  if (host.dataset.tablist === '1') return // listener attaches once; rebuilds reuse it
  host.dataset.tablist = '1'
  host.addEventListener('keydown', (e) => {
    const tabs = [...host.querySelectorAll('[role="tab"]')]
    const i = tabs.indexOf(document.activeElement)
    if (i < 0) return
    const next = rovingIndex(i, e.key, tabs.length)
    if (next === i) return
    e.preventDefault()
    tabs[i].tabIndex = -1
    tabs[next].tabIndex = 0
    tabs[next].focus()
  })
}
```

Delete the deck-only listener at `public/app.js:303-309` (the `document.addEventListener('keydown', …)` inside `initTriage`) — `initKeys` now owns every key, including `Escape`/`ArrowLeft`/`ArrowRight` in the deck and the `'t'` opener that listener also carried (Task 6's `if (!triageDeck && !typing && e.key === 't')` branch goes with it; `keyAction`'s `openDeck` intent replaces it).

**Rail (Task 7's `renderRail`).** `renderPills` is gone; the roving wiring goes at the end of `renderRail`, right after the loop that appends the `button.rail-tab` elements. Each tab already carries `role="tab"` and `aria-selected`; add the roving tabIndex and register the host. `renderRail` names its host `host` (`const host = document.getElementById('rail')`) — there is no local variable named `rail`, so use `host`, not `rail`:

```js
  for (const b of host.querySelectorAll('.rail-tab')) {
    b.tabIndex = b.getAttribute('aria-selected') === 'true' ? 0 : -1
  }
  wireTablist(host, 'vertical')
```

**Top tabs (Task 8's `initTabs`).** Same treatment for the horizontal strip — add inside `initTabs`, after the click listeners are attached:

```js
  for (const t of document.querySelectorAll('#tabs .tab')) {
    t.setAttribute('role', 'tab')
    t.tabIndex = t.dataset.tab === activeTab ? 0 : -1
  }
  wireTablist(document.getElementById('tabs'), 'horizontal')
```

and, in `selectTab(id)` (Task 8), keep the roving index in sync with the selection by adding one line beside the existing `aria-selected` update:

```js
  for (const t of document.querySelectorAll('#tabs .tab')) t.tabIndex = t.dataset.tab === id ? 0 : -1
```

**Star accessible name (Task 12's `.nrow-star` slot).** Replace the two hard-coded template strings with the shared helper so the name has one source:

```js
    star.setAttribute('aria-label', ariaAnswerLabel(opt) ?? 'Answer')
    star.title = ariaAnswerLabel(opt) ?? 'Answer'
```

**Liveness glyph (Task 10's `needsRowEl`).** The urgency chip is colour-toned; give it a non-colour carrier too. In the `el.innerHTML` template, replace the chip span with:

```js
      <span class="chip chip-${chip.tone}"><span aria-hidden="true">${livenessGlyph(m.liveness).glyph}</span> ${esc(chip.text)}</span>
```

(`chip.tone` is a fixed internal token, `m.liveness` only ever indexes the `LIVENESS` table, and the agent-authored `chip.text` still goes through `esc()`.)

Init block (owned by Task 8) — insert **exactly one line**, `initKeys()`, after `initSearch()`.

**Retarget the stale shell assertion.** Task 6's `test/shell.test.ts` pins
`e.key === 't'` inside `app.js` — that literal is gone now that the triage-only
keydown listener is deleted and `'t'` is handled by `keyAction`/`runIntent`
instead. Edit that test so it checks what still has to be true (the deck stays
reachable) instead of a string that no longer exists:

```ts
  it('keeps the triage deck reachable now that the Now strip is gone', () => {
    expect(js).toContain('openTriage()')
  })
```

**Pin the wrong-item fix with a wiring test.** Append this to `test/keys.test.ts`
— it exercises the app.js wiring this step just added, so add the `readFileSync`
import alongside the existing ones and this `describe` at the end of the file:

```ts
import { readFileSync } from 'node:fs'

// spec §13 regression: keyboard '1'-'4' must answer whatever the triage deck is
// SHOWING, not whatever the list still has selected underneath it. app.js has no
// DOM test harness in this repo (see test/shell.test.ts), so this is source-level.
describe('app.js wiring — deck-open keyboard options target the deck entry, not the list selection', () => {
  const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')

  it('defines keyTargetItem, deriving from the deck entry while triageDeck is open', () => {
    const start = js.indexOf('function keyTargetItem')
    expect(start, 'keyTargetItem is missing').toBeGreaterThan(-1)
    const fn = js.slice(start, start + 400)
    expect(fn).toContain('triageDeck')
    expect(fn).toContain('findEntryData(triageDeck.entries[triageDeck.index])')
  })

  it('runIntent resolves its target through keyTargetItem(), not a bare selectedItem()', () => {
    const start = js.indexOf('function runIntent')
    const body = js.slice(start, js.indexOf('function initKeys'))
    expect(body).toContain('keyTargetItem()')
    expect(body).not.toContain('const it = selectedItem()')
  })

  it("initKeys computes optionCount from the same target — 1-4 can't validate against one item and answer another", () => {
    const start = js.indexOf('function initKeys')
    const body = js.slice(start, js.indexOf('function wireTablist'))
    expect(body).toContain('optionCount: optionOrder(keyTargetItem()?.options).length')
  })
})
```

Run: `fnm exec --using=24 -- npx vitest run test/keys.test.ts test/shell.test.ts`
Expected: PASS — the pure `keyAction`/`rovingIndex`/etc. suite from Step 4 stays
green, the new wiring describe passes now that Step 5 exists, and the retargeted
shell assertion passes now that `'t'` has moved out of `app.js`.

- [ ] **Step 6: Add the focus / selection styling**

Append to the end of `public/style.css` (no `@media` rules here — Task 18 owns every responsive block, and it appends after this one):

```css
/* ── focus + keyboard selection (spec §13) ───────────────────────────────── */
:where(button, a, [tabindex]):focus-visible { outline: 2px solid LinkText; outline-offset: 2px; border-radius: 6px; }
#needsYouList .nrow.selected { background: color-mix(in srgb, LinkText 8%, transparent); }
#needsYouList .nrow.selected:focus-visible { outline-offset: 0; }
[role="tab"][aria-selected="true"] { font-weight: 600; }
```

- [ ] **Step 7: Run the full suite and typecheck**

Run: `fnm exec --using=24 -- npm test && fnm exec --using=24 -- npm run typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add public/keys.js public/keys.d.ts test/keys.test.ts test/shell.test.ts public/app.js public/style.css
git commit -m "feat(viewer): keyboard map and accessibility pass

Spec §13: j/k move, Enter expands, 1-4 pick option N (ordered by card.js's
optionOrder so numbers match the screen), x dismiss, e resolve, / search, t
opens the triage deck (moved off the deleted Now strip), Esc collapses — as
ONE pure mapping (public/keys.js) shared by the needs-you list and the triage
deck, so the two can't drift. While the deck is open, keyboard option-numbers
target the entry the deck is showing (keyTargetItem), not whatever the list
still has selected underneath it. The keyboard dismiss goes through the same
staged 5s-undo path as the ✕ button. #rail and #tabs become real tablists
with roving focus, focus is taken on expand (.nrow-card) and returned to the
.nrow on collapse, the star's accessible name reads 'Answer: <label>' from
one helper, and the urgency chip carries a glyph beside its colour.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 18: Responsive shell (spec §14)

**Files:**
- Create: `public/layout.js`
- Create: `public/layout.d.ts`
- Test: `test/layout.test.ts`
- Modify: `public/style.css` — **append the responsive block at EOF**. This task is the sole owner of every `@media` rule in the file; Task 6's rewritten shell emits none, and the old `@media (max-width: 700px) { #sidebar { display: none; } }` was deleted with the sidebar in Task 6.
- Modify: `public/app.js` — a NEW `/layout.js` import line, a `layout` module-level mode + `initResponsive()` placed above Task 7's `renderRail`, the label line inside `renderRail`, and the bottom init block (Task 8 owns it — insert EXACTLY ONE line, `initResponsive()` after `initSearch()`)

**Interfaces:**
- Consumes: `projectMonogram(name) -> string` from `public/colors.js` (Task 4); Task 7's `renderRail()` and its `#rail > button.rail-tab > span.rail-dot + span.rail-name + span.rail-badge + span.rail-match` markup plus `input.rail-filter`; the shell's `#tabs .tab` and `#needsYouList` (Task 6/8); Task 10's `.nrow-card`; `render()`.
- Produces: `NARROW_MAX = 900`, `layoutMode(width: number) -> 'narrow'|'wide'`, `railLabel(name: string, mode: 'narrow'|'wide') -> string`; and in app.js `initResponsive()` plus the module-level `layout` mode read by `renderRail`.

- [ ] **Step 1: Write the failing test**

```ts
// test/layout.test.ts
import { describe, it, expect } from 'vitest'
import { layoutMode, railLabel, NARROW_MAX } from '../public/layout.js'
import { projectMonogram } from '../public/colors.js'

describe('layoutMode', () => {
  it('breaks at ~900px', () => {
    expect(NARROW_MAX).toBe(900)
  })
  it('is wide above the breakpoint', () => {
    expect(layoutMode(1200)).toBe('wide')
    expect(layoutMode(901)).toBe('wide')
  })
  it('is narrow at and below the breakpoint', () => {
    expect(layoutMode(NARROW_MAX)).toBe('narrow')
    expect(layoutMode(480)).toBe('narrow')
  })
})

describe('railLabel', () => {
  it('is the full project name when wide', () => {
    expect(railLabel('agent-inbox', 'wide')).toBe('agent-inbox')
  })
  it('collapses to the monogram in the narrow dot column', () => {
    expect(railLabel('agent-inbox', 'narrow')).toBe(projectMonogram('agent-inbox'))
    expect(railLabel('agent-inbox', 'narrow').length).toBeLessThanOrEqual(2)
  })
  it('keeps the All and unknown pseudo-projects labelled', () => {
    expect(railLabel('All', 'wide')).toBe('All')
    expect(railLabel('unknown', 'narrow')).toBe(projectMonogram('unknown'))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `fnm exec --using=24 -- npx vitest run test/layout.test.ts`
Expected: FAIL with `Error: Failed to load url ../public/layout.js (resolved id: /Users/shariqhirani/Development/agent-inbox/public/layout.js)`

- [ ] **Step 3: Write minimal implementation**

```js
// public/layout.js
// Pure responsive decisions (spec §14). Relative specifier so the same module
// resolves in the browser (both files are served from /) and in vitest.
import { projectMonogram } from './colors.js'

export const NARROW_MAX = 900

export function layoutMode(width) {
  return Number(width) <= NARROW_MAX ? 'narrow' : 'wide'
}

// The narrow rail is a dot column: monogram only. The full name stays on
// title/aria-label so the label never disappears entirely (§2: colour is never
// the only carrier).
export function railLabel(name, mode) {
  return mode === 'narrow' ? projectMonogram(name) : String(name)
}
```

```ts
// public/layout.d.ts
export const NARROW_MAX: number
export function layoutMode(width: number): 'narrow' | 'wide'
export function railLabel(name: string, mode: 'narrow' | 'wide'): string
```

- [ ] **Step 4: Run test to verify it passes**

Run: `fnm exec --using=24 -- npx vitest run test/layout.test.ts`
Expected: PASS

- [ ] **Step 5: Append the responsive block to style.css**

Append at the very end of `public/style.css` — this is the file's only `@media` block, and it must come last so it wins over the shell (Task 6), boards chrome (Task 13) and focus rules (Task 17) above it:

```css
/* ── responsive (spec §14) ──────────────────────────────────────────────────
   The only @media block in the file. Under ~900px the rail becomes a monogram
   dot column, the tabs a scrollable segmented control, and the expanded card
   full-width. Class names track the rail contract: .rail-name / .rail-badge /
   .rail-match / .rail-filter, and Task 10's .nrow-card. */
@media (max-width: 900px) {
  body { padding: 0 10px 48px; }
  .layout { gap: 10px; }
  #rail { width: 46px; flex-shrink: 0; }
  #rail .rail-tab { position: relative; justify-content: center; gap: 0; padding: 8px 0; }
  #rail .rail-name { flex: none; font-size: 11px; font-weight: 600; letter-spacing: .02em; text-overflow: clip; }
  #rail .rail-badge { position: absolute; top: 1px; right: 3px; font-size: 10px; padding: 0 4px; }
  #rail .rail-match { display: none; }
  #rail .rail-filter { display: none; }
  #tabs { display: flex; flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch; }
  #tabs::-webkit-scrollbar { display: none; }
  #tabs .tab { flex: 0 0 auto; white-space: nowrap; }
  #needsYouList .nrow-card { width: 100%; max-width: none; padding-inline: 10px; }
  .lb-panel { width: 96vw; max-height: 92vh; }
  .search-box { flex: 1; min-width: 0; }
  header { gap: 8px; padding: 10px 0; }
}
```

- [ ] **Step 6: Make the rail label mode-aware in app.js**

Add ONE new import line:

```js
import { layoutMode, railLabel, NARROW_MAX } from '/layout.js'
```

Add immediately above `renderRail` (Task 7):

```js
// ── responsive (spec §14) ───────────────────────────────────────────────────
let layout = layoutMode(window.innerWidth)

function initResponsive() {
  const mq = window.matchMedia(`(max-width: ${NARROW_MAX}px)`)
  const apply = () => {
    const next = mq.matches ? 'narrow' : 'wide'
    if (next === layout) return
    layout = next
    if (lastData) render() // the rail's labels change shape, so rebuild it
  }
  mq.addEventListener('change', apply)
  apply()
}
```

Inside `renderRail` (Task 7), where the `.rail-name` span is filled, run the label through `railLabel` and keep the full project name on `title`/`aria-label` (`textContent`/`setAttribute` are inherently safe — no `innerHTML`, so no `esc()` needed here):

```js
    name.className = 'rail-name'
    name.textContent = railLabel(e.label, layout)
    b.title = e.label
    b.setAttribute('aria-label', e.label)
```

`renderRail` already memoises on a signature (`const sig = JSON.stringify([entries, projectFilter, th])`); add `layout` to it so a breakpoint change actually rebuilds the rail:

```js
  const sig = JSON.stringify([entries, projectFilter, th, layout])
```

Init block (owned by Task 8) — insert **exactly one line**, `initResponsive()`, after `initSearch()`.

- [ ] **Step 7: Run the full suite and typecheck**

Run: `fnm exec --using=24 -- npm test && fnm exec --using=24 -- npm run typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add public/layout.js public/layout.d.ts test/layout.test.ts public/app.js public/style.css
git commit -m "feat(viewer): responsive shell under 900px

Spec §14: the rail collapses to a monogram dot column (.rail-name shrinks,
.rail-badge overlays the corner, .rail-filter and .rail-match hide), the top
tabs become a scrollable segmented control, and the expanded .nrow-card goes
full-width. The single @media block lives at the end of style.css so it wins
over the shell, boards and focus rules above it. The breakpoint decision and
the rail's narrow label are pure and tested.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 19: Live as an always-visible footer strip (spec §16)

Replaces the Live **tab** with a footer strip. Live is ambient presence, not triage: behind a
tab you never see it, because a tab is a place you must decide to visit.

**Files:**
- Create: `public/livebar.js`, `public/livebar.d.ts`, `test/livebar.test.ts`
- Modify: `public/index.html` (drop the Live tab button + `#live` panel; add the footer)
- Modify: `public/tabs.js` (TAB_IDS drops `'live'`; `tabCounts` drops the `live` key)
- Modify: `public/app.js` (`renderLive` retargets; add `renderLiveBar`; drop `setPresence`)
- Modify: `public/style.css` (append strip + drawer rules; NO `@media` — Task 18 owns those)
- Modify: `test/tabs.test.ts`, `test/shell.test.ts` (TAB_IDS + markup assertions)

**Interfaces:**
- Consumes: `freshnessTone(ageMs)`, `relMs(ms)`, `ageChip(ageMs)` from `public/rowview.js`
  (reuse them — spec §6 requires ONE freshness scale, not a second); `esc()`, `openLive`,
  `renderLive`'s existing entry markup in `app.js`.
- Produces: `liveSummary(activity, nowMs) -> { count:number, tone:string, label:string, sessions:Array<{session:string,label:string,tone:string}> }`
  (`public/livebar.js`); in `app.js`: `renderLiveBar(entries)`, `toggleLiveDrawer(open?)`.

- [ ] **Step 1: Write the failing test**

Create `test/livebar.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { liveSummary } from '../public/livebar.js'

const NOW = Date.parse('2026-07-24T12:00:00.000Z')
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const sess = (o: Partial<Record<string, unknown>> = {}) => ({
  session: 's1', project: 'oris', agent: 'claude-code', stream: '', doing: 'working',
  detail: '', children: [], idle: false, updated_at: at(1000), started_at: at(60_000), ...o,
})

describe('liveSummary', () => {
  it('counts only non-idle sessions and labels them project/agent', () => {
    const s = liveSummary([sess(), sess({ session: 's2', project: 'api', idle: true })], NOW)
    expect(s.count).toBe(1)
    expect(s.label).toBe('1 working')
    expect(s.sessions).toEqual([{ session: 's1', label: 'oris/claude-code', tone: 'fresh' }])
  })

  it('pluralises', () => {
    const s = liveSummary([sess(), sess({ session: 's2', project: 'api' })], NOW)
    expect(s.label).toBe('2 working')
  })

  it('reads idle when nothing is running — the strip still renders', () => {
    const s = liveSummary([sess({ idle: true })], NOW)
    expect(s.count).toBe(0)
    expect(s.tone).toBe('idle')
    expect(s.label).toBe('no agents running')
    expect(s.sessions).toEqual([])
  })

  it('empty activity is idle, never a crash', () => {
    expect(liveSummary([], NOW).label).toBe('no agents running')
    expect(liveSummary(undefined as never, NOW).label).toBe('no agents running')
  })

  it('strip tone is the FRESHEST session — one live agent must not read as quiet', () => {
    const s = liveSummary([sess({ updated_at: at(10 * 60_000) }), sess({ session: 's2', updated_at: at(500) })], NOW)
    expect(s.tone).toBe('fresh')
  })

  it('per-session tones use the shared freshness scale', () => {
    const s = liveSummary([
      sess({ session: 'a', updated_at: at(500) }),
      sess({ session: 'b', updated_at: at(2 * 60_000) }),
      sess({ session: 'c', updated_at: at(30 * 60_000) }),
    ], NOW)
    expect(s.sessions.map((x) => x.tone)).toEqual(['fresh', 'aging', 'quiet'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `fnm exec --using=24 -- npx vitest run test/livebar.test.ts`
Expected: FAIL — `Cannot find module '../public/livebar.js'`

- [ ] **Step 3: Write minimal implementation**

Create `public/livebar.js`:

```js
// The Live footer strip's summary line (spec §16). Pure: no DOM, no clock —
// the caller passes nowMs. Live is ambient presence, so this never produces a
// number that reads as a to-do.
import { freshnessTone } from '/rowview.js'

/**
 * @param {Array<any>} activity rows from /api/activity
 * @param {number} nowMs
 * @returns {{count:number,tone:string,label:string,sessions:Array<{session:string,label:string,tone:string}>}}
 */
export function liveSummary(activity, nowMs) {
  const rows = Array.isArray(activity) ? activity : []
  const active = rows.filter((a) => a && !a.idle)
  const sessions = active.map((a) => ({
    session: a.session,
    label: `${a.project}/${a.agent}`,
    tone: freshnessTone(nowMs - Date.parse(a.updated_at)),
  }))
  // the strip takes the FRESHEST tone: one actively-working agent must not be
  // hidden behind a quieter one
  const rank = { fresh: 0, aging: 1, quiet: 2 }
  const tone = sessions.length
    ? sessions.reduce((best, s) => (rank[s.tone] < rank[best] ? s.tone : best), 'quiet')
    : 'idle'
  return {
    count: active.length,
    tone,
    label: active.length ? `${active.length} working` : 'no agents running',
    sessions,
  }
}
```

Create `public/livebar.d.ts`:

```ts
export interface LiveSessionSummary { session: string; label: string; tone: string }
export interface LiveSummary { count: number; tone: string; label: string; sessions: LiveSessionSummary[] }
export function liveSummary(activity: unknown[], nowMs: number): LiveSummary
```

- [ ] **Step 4: Run test to verify it passes**

Run: `fnm exec --using=24 -- npx vitest run test/livebar.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Wire the strip, the drawer, and remove the tab**

`public/index.html` — delete `<button class="tab" ... data-tab="live" ...>` from the tab strip
and delete `<section class="panel" id="live" ...>`. Immediately after `</div>` closing
`.layout`, add:

```html
  <footer id="liveBar">
    <button id="liveStrip" type="button" aria-expanded="false" aria-controls="liveDrawer">
      <span class="live-dot idle" id="liveStripDot"></span>
      <span class="live-label" id="liveStripLabel">no agents running</span>
      <span class="live-sessions" id="liveStripSessions"></span>
      <span class="live-caret" aria-hidden="true">▴</span>
    </button>
    <div id="liveDrawer" class="live-drawer" hidden><div class="live-list"></div></div>
  </footer>
```

`public/tabs.js` — `export const TAB_IDS = ['needsYou', 'boards', 'notes', 'done']` and delete
the `live: null` entry from `tabCounts`'s return. Keep `livePresence` exported (still used).

`public/app.js`:
- `renderLive`'s host becomes `document.querySelector('#liveDrawer .live-list')`.
- Delete `setPresence` and its call (the tab dot it wrote to no longer exists).
- Add, next to `renderLive`:

```js
// The always-visible footer strip (spec §16). Ambient only: never steals focus,
// never auto-expands, and its number never reads as a to-do.
function renderLiveBar(entries) {
  const s = liveSummary(entries, Date.now())
  const dot = document.getElementById('liveStripDot')
  const label = document.getElementById('liveStripLabel')
  const list = document.getElementById('liveStripSessions')
  if (!dot || !label || !list) return
  dot.className = `live-dot ${s.tone}`
  label.textContent = s.label
  list.replaceChildren()
  for (const x of s.sessions) {
    const el = document.createElement('span')
    el.className = `live-session ${x.tone}`
    el.textContent = x.label // agent-authored: textContent, never innerHTML
    list.appendChild(el)
  }
}

function toggleLiveDrawer(open) {
  const strip = document.getElementById('liveStrip')
  const drawer = document.getElementById('liveDrawer')
  if (!strip || !drawer) return
  const next = open ?? drawer.hidden
  drawer.hidden = !next
  strip.setAttribute('aria-expanded', String(next))
  if (!next) strip.focus() // return focus on collapse (spec §13)
}

function initLiveBar() {
  const strip = document.getElementById('liveStrip')
  if (!strip) return
  strip.addEventListener('click', () => toggleLiveDrawer())
  document.addEventListener('keydown', (e) => {
    const drawer = document.getElementById('liveDrawer')
    if (e.key === 'Escape' && drawer && !drawer.hidden) { toggleLiveDrawer(false) }
  })
}
```

- In `render()`, call `renderLiveBar(live)` alongside the existing `renderLive(live)`.
- Add `import { liveSummary } from '/livebar.js'` by EDITING the existing import block (one
  import statement per module — never add a second).
- Insert exactly ONE line into the canonical init block: `initLiveBar()` after `initGear()`.

`public/style.css` — append (no `@media`):

```css
/* Live footer strip (spec §16): ambient presence, always visible. */
#liveBar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 50; }
#liveStrip { display: flex; align-items: center; gap: 8px; width: 100%; height: 28px; padding: 0 12px;
  border: none; border-top: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
  background: Canvas; color: inherit; font: inherit; font-size: 12px; cursor: pointer; text-align: left; }
#liveStrip:hover { background: color-mix(in srgb, CanvasText 4%, Canvas); }
#liveStrip .live-label { opacity: .75; }
#liveStrip .live-sessions { display: flex; gap: 10px; overflow: hidden; opacity: .6; min-width: 0; }
#liveStrip .live-session { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#liveStrip .live-caret { margin-left: auto; opacity: .5; }
#liveStrip[aria-expanded="true"] .live-caret { transform: rotate(180deg); }
.live-dot.idle { background: color-mix(in srgb, CanvasText 30%, transparent); }
/* the drawer rises OVER the content: nothing reflows, scroll position survives */
.live-drawer { position: fixed; left: 0; right: 0; bottom: 28px; max-height: 46vh; overflow: auto;
  background: Canvas; border-top: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
  box-shadow: 0 -12px 32px color-mix(in srgb, CanvasText 18%, transparent); padding: 10px 12px; }
main { padding-bottom: 34px; } /* the fixed strip must never cover the last row */
```

`test/tabs.test.ts` / `test/shell.test.ts` — update TAB_IDS expectations to the four tabs, drop
the `live` count assertion, and assert the new markup: `#liveBar`, `#liveStrip[aria-expanded]`,
`#liveDrawer[hidden]`, and that `data-tab="live"` is GONE.

- [ ] **Step 6: Verify and commit**

Run:
```
fnm exec --using=24 -- npx vitest run test/livebar.test.ts test/tabs.test.ts test/shell.test.ts
fnm exec --using=24 -- npm run typecheck
fnm exec --using=24 -- npm test
```
Expected: all green (281 passing before this task, plus the new livebar tests).

```bash
git add public/livebar.js public/livebar.d.ts public/index.html public/tabs.js public/app.js public/style.css test/livebar.test.ts test/tabs.test.ts test/shell.test.ts
git commit -m "feat(viewer): Live becomes an always-visible footer strip"
```
