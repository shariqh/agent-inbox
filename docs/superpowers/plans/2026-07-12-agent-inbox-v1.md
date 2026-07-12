# Agent Inbox v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local, cross-project, cross-tool attention inbox that coding agents write to over MCP (one `flag` tool), stored in one SQLite hub, viewed in a local web app grouped by *Needs you* / *Notes*.

**Architecture:** Hub-and-spoke. A stdio MCP server (spawned per agent session, inheriting the repo's cwd) auto-infers project/stream/agent and writes flags into a single SQLite file at `~/.agent-inbox/inbox.db`. A separate long-running Hono web app reads that same file and renders the cross-project inbox. No model calls anywhere — the tool is dumb infra.

**Tech Stack:** Node 24, TypeScript ESM (`.js` import specifiers), `@modelcontextprotocol/sdk` (stdio), `better-sqlite3` (WAL), Hono + `@hono/node-server` (viewer), Vitest.

## Global Constraints

- **Node >= 24**, ESM (`"type": "module"`). **TS imports use `.js` extensions** even for `.ts` sources.
- **Strict tsc**, `noUncheckedIndexedAccess: true`.
- **DB path** from `AGENT_INBOX_DB` env; default `~/.agent-inbox/inbox.db`. Always **WAL mode**, **busy_timeout 5000**.
- **`kind`** is exactly `'question' | 'note'`. **`status`** is exactly `'open' | 'resolved' | 'dismissed'`.
- **v1 is local-only and triage-only.** No answer-back, no remote/HTTP+auth mode, no `done` as a kind. Keep `register` — it is the identity seam v2 remote mode reuses.
- **No second AI / no model calls** in any component.
- **Viewer** is plain HTML/CSS/JS (no front-end framework/build) so it wraps to Electron unchanged. Default port **4319**, override via `AGENT_INBOX_PORT`.
- **Verify exact `@modelcontextprotocol/sdk` import paths** against the installed version (`node -e "import('@modelcontextprotocol/sdk/server/mcp.js').then(m=>console.log(Object.keys(m)))"`) before writing code against them; the paths below match SDK ≥1.x but confirm.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`
- Test: `test/scaffold.test.ts`

**Interfaces:**
- Produces: an installable, testable, type-checked project. `npm test` runs Vitest; `npm run typecheck` runs `tsc --noEmit`; `npm run mcp` / `npm run view` entry scripts (wired in later tasks).

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "agent-inbox",
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=24" },
  "bin": { "agent-inbox-mcp": "./dist/mcp-server.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "mcp": "tsx src/mcp-server.ts",
    "view": "tsx src/viewer-server.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@hono/node-server": "^1.13.0",
    "@modelcontextprotocol/sdk": "^1.12.0",
    "better-sqlite3": "^11.8.0",
    "hono": "^4.6.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^24.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": false
  },
  "include": ["src/**/*.ts", "test/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 15000,
  },
})
```

- [ ] **Step 4: Write the scaffold smoke test**

```ts
// test/scaffold.test.ts
import { describe, it, expect } from 'vitest'

describe('scaffold', () => {
  it('runs vitest and basic ESM', () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 5: Install deps and run**

Run: `cd ~/Development/agent-inbox && npm install && npm test`
Expected: `better-sqlite3` compiles its native binding, Vitest reports `1 passed`.

- [ ] **Step 6: Verify typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts test/scaffold.test.ts
git commit -m "chore: project scaffold (ts esm, vitest, better-sqlite3, hono)"
```

---

### Task 2: SQLite store module

**Files:**
- Create: `src/store.ts`
- Test: `test/store.test.ts`

**Interfaces:**
- Produces:
  - `type Kind = 'question' | 'note'`
  - `type Status = 'open' | 'resolved' | 'dismissed'`
  - `interface Item { id: string; project: string; stream: string; agent: string; kind: Kind; title: string; detail: string; status: Status; annotation: string | null; created_at: string; resolved_at: string | null }`
  - `interface NewItem { project: string; stream: string; agent: string; kind: Kind; title: string; detail?: string }`
  - `function defaultDbPath(): string`
  - `function openDb(path?: string): Database.Database` — opens, sets WAL + busy_timeout, migrates.
  - `function insertItem(db: Database.Database, item: NewItem): string` — returns new id.
  - `function resolveItem(db: Database.Database, id: string): void` — idempotent; sets status `resolved` + `resolved_at`.
  - `function dismissItem(db: Database.Database, id: string): void` — idempotent; sets status `dismissed`.
  - `function annotateItem(db: Database.Database, id: string, text: string): void`
  - `function listItems(db: Database.Database, opts?: { status?: Status }): Item[]` — newest first.

- [ ] **Step 1: Write the failing test**

```ts
// test/store.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openDb, insertItem, resolveItem, dismissItem, annotateItem, listItems } from '../src/store.js'

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-'))
  return openDb(join(dir, 'inbox.db'))
}

describe('store', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  it('inserts an open item and reads it back', () => {
    const id = insertItem(db, { project: 'social-agent', stream: 'main', agent: 'claude-code', kind: 'question', title: 'double jump or wall climb?' })
    const items = listItems(db)
    expect(items).toHaveLength(1)
    const it0 = items[0]!
    expect(it0.id).toBe(id)
    expect(it0.status).toBe('open')
    expect(it0.kind).toBe('question')
    expect(it0.detail).toBe('')
    expect(it0.annotation).toBeNull()
    expect(it0.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(it0.resolved_at).toBeNull()
  })

  it('resolve sets status + resolved_at, and is idempotent', () => {
    const id = insertItem(db, { project: 'p', stream: '', agent: 'copilot', kind: 'note', title: 'assumed X' })
    resolveItem(db, id)
    resolveItem(db, id) // no throw
    const it0 = listItems(db)[0]!
    expect(it0.status).toBe('resolved')
    expect(it0.resolved_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('dismiss sets status dismissed', () => {
    const id = insertItem(db, { project: 'p', stream: '', agent: 'claude-code', kind: 'note', title: 'tech debt here' })
    dismissItem(db, id)
    expect(listItems(db)[0]!.status).toBe('dismissed')
  })

  it('annotate stores my private note', () => {
    const id = insertItem(db, { project: 'p', stream: '', agent: 'claude-code', kind: 'question', title: 'which db?' })
    annotateItem(db, id, 'use sqlite')
    expect(listItems(db)[0]!.annotation).toBe('use sqlite')
  })

  it('listItems filters by status and returns newest first', () => {
    const a = insertItem(db, { project: 'p', stream: '', agent: 'claude-code', kind: 'note', title: 'first' })
    const b = insertItem(db, { project: 'p', stream: '', agent: 'claude-code', kind: 'note', title: 'second' })
    resolveItem(db, a)
    expect(listItems(db).map((i) => i.title)).toEqual(['second', 'first'])
    expect(listItems(db, { status: 'open' }).map((i) => i.id)).toEqual([b])
    expect(listItems(db, { status: 'resolved' }).map((i) => i.id)).toEqual([a])
  })

  it('resolve on unknown id is a no-op', () => {
    resolveItem(db, 'nope') // must not throw
    expect(listItems(db)).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/store.test.ts`
Expected: FAIL — cannot find module `../src/store.js`.

- [ ] **Step 3: Write `src/store.ts`**

```ts
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdirSync } from 'node:fs'

export type Kind = 'question' | 'note'
export type Status = 'open' | 'resolved' | 'dismissed'

export interface Item {
  id: string
  project: string
  stream: string
  agent: string
  kind: Kind
  title: string
  detail: string
  status: Status
  annotation: string | null
  created_at: string
  resolved_at: string | null
}

export interface NewItem {
  project: string
  stream: string
  agent: string
  kind: Kind
  title: string
  detail?: string
}

export function defaultDbPath(): string {
  return process.env.AGENT_INBOX_DB ?? join(homedir(), '.agent-inbox', 'inbox.db')
}

export function openDb(path: string = defaultDbPath()): Database.Database {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  migrate(db)
  return db
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      stream TEXT NOT NULL DEFAULT '',
      agent TEXT NOT NULL DEFAULT 'unknown',
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      annotation TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_items_status_project ON items(status, project);
    CREATE INDEX IF NOT EXISTS idx_items_created ON items(created_at);
  `)
}

export function insertItem(db: Database.Database, item: NewItem): string {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO items (id, project, stream, agent, kind, title, detail, status, created_at)
     VALUES (@id, @project, @stream, @agent, @kind, @title, @detail, 'open', @created_at)`,
  ).run({
    id,
    project: item.project,
    stream: item.stream,
    agent: item.agent,
    kind: item.kind,
    title: item.title,
    detail: item.detail ?? '',
    created_at: new Date().toISOString(),
  })
  return id
}

export function resolveItem(db: Database.Database, id: string): void {
  db.prepare(`UPDATE items SET status = 'resolved', resolved_at = ? WHERE id = ?`).run(new Date().toISOString(), id)
}

export function dismissItem(db: Database.Database, id: string): void {
  db.prepare(`UPDATE items SET status = 'dismissed' WHERE id = ?`).run(id)
}

export function annotateItem(db: Database.Database, id: string, text: string): void {
  db.prepare(`UPDATE items SET annotation = ? WHERE id = ?`).run(text, id)
}

export function listItems(db: Database.Database, opts: { status?: Status } = {}): Item[] {
  const rows = opts.status
    ? db.prepare(`SELECT * FROM items WHERE status = ? ORDER BY created_at DESC`).all(opts.status)
    : db.prepare(`SELECT * FROM items ORDER BY created_at DESC`).all()
  return rows as Item[]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/store.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts test/store.test.ts
git commit -m "feat: sqlite store (items schema, WAL, insert/resolve/dismiss/annotate/list)"
```

---

### Task 3: Auto-inference module

**Files:**
- Create: `src/infer.ts`
- Test: `test/infer.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `function inferProject(cwd: string): string` — git remote origin basename (strip `.git`), else cwd basename, else `'unknown'`.
  - `function inferStream(cwd: string): string` — current git branch, else `''`.
  - `function inferAgent(clientName: string | undefined): string` — `'claude-code'` if name contains `claude`, `'copilot'` if it contains `copilot`, else the raw name, else `'unknown'`.

- [ ] **Step 1: Write the failing test**

```ts
// test/infer.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { execFileSync } from 'node:child_process'
import { inferProject, inferStream, inferAgent } from '../src/infer.js'

function tmpGitRepo(opts: { remote?: string; branch?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'repo-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 't@t.dev'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir })
  execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], { cwd: dir })
  if (opts.branch) execFileSync('git', ['checkout', '-q', '-b', opts.branch], { cwd: dir })
  if (opts.remote) execFileSync('git', ['remote', 'add', 'origin', opts.remote], { cwd: dir })
  return dir
}

describe('inferProject', () => {
  it('uses the git remote origin basename', () => {
    const dir = tmpGitRepo({ remote: 'git@github.com:shariqh/social-agent.git' })
    expect(inferProject(dir)).toBe('social-agent')
  })
  it('falls back to cwd basename with no remote', () => {
    const dir = tmpGitRepo()
    expect(inferProject(dir)).toBe(basename(dir))
  })
  it('falls back to cwd basename outside any git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plain-'))
    expect(inferProject(dir)).toBe(basename(dir))
  })
})

describe('inferStream', () => {
  it('returns the current branch', () => {
    const dir = tmpGitRepo({ branch: 'feat/x' })
    expect(inferStream(dir)).toBe('feat/x')
  })
  it('returns empty string outside a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plain-'))
    expect(inferStream(dir)).toBe('')
  })
})

describe('inferAgent', () => {
  it('maps claude client names', () => {
    expect(inferAgent('claude-code')).toBe('claude-code')
    expect(inferAgent('Claude Code')).toBe('claude-code')
  })
  it('maps copilot client names', () => {
    expect(inferAgent('github-copilot-cli')).toBe('copilot')
  })
  it('passes through an unknown name, and defaults when absent', () => {
    expect(inferAgent('aider')).toBe('aider')
    expect(inferAgent(undefined)).toBe('unknown')
    expect(inferAgent('')).toBe('unknown')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/infer.test.ts`
Expected: FAIL — cannot find module `../src/infer.js`.

- [ ] **Step 3: Write `src/infer.ts`**

```ts
import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

export function inferProject(cwd: string): string {
  const remote = git(cwd, ['remote', 'get-url', 'origin'])
  if (remote) {
    const name = basename(remote.replace(/\.git$/, ''))
    if (name) return name
  }
  return basename(cwd) || 'unknown'
}

export function inferStream(cwd: string): string {
  return git(cwd, ['branch', '--show-current']) ?? ''
}

export function inferAgent(clientName: string | undefined): string {
  if (!clientName) return 'unknown'
  const lower = clientName.toLowerCase()
  if (lower.includes('claude')) return 'claude-code'
  if (lower.includes('copilot')) return 'copilot'
  return clientName
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/infer.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/infer.ts test/infer.test.ts
git commit -m "feat: auto-inference (project from remote/cwd, stream from branch, agent from clientInfo)"
```

---

### Task 4: MCP stdio server

**Files:**
- Create: `src/scope.ts`, `src/mcp.ts`, `src/mcp-server.ts`
- Test: `test/scope.test.ts`, `test/mcp.integration.test.ts`

**Interfaces:**
- Consumes: `openDb`, `insertItem`, `resolveItem`, `Kind` from `store.js`; `inferProject`, `inferStream`, `inferAgent` from `infer.js`.
- Produces:
  - `interface Scope { project: string; stream: string; agent: string }`
  - `function makeScope(cwd: string): { get(clientName: string | undefined): Scope; override(patch: { project?: string; stream?: string }): void }`
  - `function buildMcpServer(db, cwd): McpServer` — registers `flag`, `resolve`, `register`, `whoami`.

- [ ] **Step 1: Write the failing scope test**

```ts
// test/scope.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { makeScope } from '../src/scope.js'

describe('makeScope', () => {
  it('infers project/stream from cwd and agent from the client name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plain-'))
    const scope = makeScope(dir)
    const s = scope.get('claude-code')
    expect(s.project).toBe(basename(dir))
    expect(s.stream).toBe('')
    expect(s.agent).toBe('claude-code')
  })

  it('override replaces project/stream but agent still comes from the client', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plain-'))
    const scope = makeScope(dir)
    scope.override({ project: 'oris', stream: 'release' })
    const s = scope.get('github-copilot')
    expect(s.project).toBe('oris')
    expect(s.stream).toBe('release')
    expect(s.agent).toBe('copilot')
  })
})
```

- [ ] **Step 2: Run scope test to verify it fails**

Run: `npx vitest run test/scope.test.ts`
Expected: FAIL — cannot find module `../src/scope.js`.

- [ ] **Step 3: Write `src/scope.ts`**

```ts
import { inferProject, inferStream, inferAgent } from './infer.js'

export interface Scope {
  project: string
  stream: string
  agent: string
}

export function makeScope(cwd: string): {
  get(clientName: string | undefined): Scope
  override(patch: { project?: string; stream?: string }): void
} {
  let projectOverride: string | undefined
  let streamOverride: string | undefined
  return {
    get(clientName) {
      return {
        project: projectOverride ?? inferProject(cwd),
        stream: streamOverride ?? inferStream(cwd),
        agent: inferAgent(clientName),
      }
    },
    override(patch) {
      if (patch.project !== undefined) projectOverride = patch.project
      if (patch.stream !== undefined) streamOverride = patch.stream
    },
  }
}
```

- [ ] **Step 4: Run scope test to verify it passes**

Run: `npx vitest run test/scope.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Write `src/mcp.ts`**

Note: `server.server.getClientVersion()` returns the initializing client's `{ name, version }` after the handshake (undefined before). Confirm this accessor exists on the installed SDK (`McpServer.prototype.server` is the low-level `Server`; `getClientVersion()` is on it). If the accessor name differs, adapt — the behavior needed is "read the client name provided at initialize".

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type Database from 'better-sqlite3'
import { insertItem, resolveItem } from './store.js'
import { makeScope } from './scope.js'

export function buildMcpServer(db: Database.Database, cwd: string): McpServer {
  const server = new McpServer({ name: 'agent-inbox', version: '0.1.0' })
  const scope = makeScope(cwd)
  const clientName = (): string | undefined => server.server.getClientVersion()?.name

  server.registerTool(
    'flag',
    {
      description:
        'Raise an item for the human. kind="question" when you would otherwise pause to ask in the terminal; kind="note" for a non-blocking assumption, caveat, or workaround they should see. project/stream/agent are inferred automatically.',
      inputSchema: {
        kind: z.enum(['question', 'note']),
        title: z.string().min(1),
        detail: z.string().optional(),
        stream: z.string().optional(),
      },
    },
    async ({ kind, title, detail, stream }) => {
      const s = scope.get(clientName())
      const id = insertItem(db, {
        project: s.project,
        stream: stream ?? s.stream,
        agent: s.agent,
        kind,
        title,
        detail,
      })
      return { content: [{ type: 'text', text: JSON.stringify({ id }) }] }
    },
  )

  server.registerTool(
    'resolve',
    {
      description: 'Mark one of your own inbox items resolved once it is moot (you answered it yourself, or the caveat no longer applies).',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      resolveItem(db, id)
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }
    },
  )

  server.registerTool(
    'register',
    {
      description: 'Override the auto-inferred project/stream for this session when detection is wrong.',
      inputSchema: { project: z.string().optional(), stream: z.string().optional() },
    },
    async ({ project, stream }) => {
      scope.override({ project, stream })
      return { content: [{ type: 'text', text: JSON.stringify(scope.get(clientName())) }] }
    },
  )

  server.registerTool(
    'whoami',
    { description: 'Report this session’s current project/stream/agent scope.', inputSchema: {} },
    async () => ({ content: [{ type: 'text', text: JSON.stringify(scope.get(clientName())) }] }),
  )

  return server
}
```

- [ ] **Step 6: Write `src/mcp-server.ts` (stdio entry)**

```ts
#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { openDb } from './store.js'
import { buildMcpServer } from './mcp.js'

const db = openDb()
const server = buildMcpServer(db, process.cwd())
const transport = new StdioServerTransport()
await server.connect(transport)
```

- [ ] **Step 7: Confirm `zod` is available**

`@modelcontextprotocol/sdk` depends on `zod`, so it resolves transitively; if `npm run typecheck` cannot find it, add `"zod": "^3.23.0"` to dependencies and `npm install`.

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 8: Write the MCP round-trip integration test**

```ts
// test/mcp.integration.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { openDb, listItems } from '../src/store.js'

describe('mcp round-trip', () => {
  it('flag writes a row attributed to this session, and whoami reflects register', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mcp-')), 'inbox.db')
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', 'src/mcp-server.ts'],
      env: { ...process.env, AGENT_INBOX_DB: dbPath },
    })
    const client = new Client({ name: 'claude-code', version: '1.0.0' })
    await client.connect(transport)

    const flagRes = await client.callTool({ name: 'flag', arguments: { kind: 'question', title: 'which storage?' } })
    const { id } = JSON.parse((flagRes.content as Array<{ text: string }>)[0]!.text)
    expect(id).toBeTruthy()

    const who = await client.callTool({ name: 'register', arguments: { project: 'overridden' } })
    expect(JSON.parse((who.content as Array<{ text: string }>)[0]!.text).project).toBe('overridden')

    await client.close()

    const db = openDb(dbPath)
    const items = listItems(db)
    expect(items).toHaveLength(1)
    expect(items[0]!.title).toBe('which storage?')
    expect(items[0]!.agent).toBe('claude-code')
    expect(items[0]!.kind).toBe('question')
  })
})
```

- [ ] **Step 9: Run the integration test**

Run: `npx vitest run test/mcp.integration.test.ts`
Expected: PASS, 1 test. (It spawns the real stdio server via `tsx`.)

- [ ] **Step 10: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass, exit 0.

- [ ] **Step 11: Commit**

```bash
git add src/scope.ts src/mcp.ts src/mcp-server.ts test/scope.test.ts test/mcp.integration.test.ts package.json package-lock.json
git commit -m "feat: mcp stdio server (flag/resolve/register/whoami, session scope)"
```

---

### Task 5: Hono viewer

**Files:**
- Create: `src/group.ts`, `src/viewer.ts`, `src/viewer-server.ts`, `public/index.html`, `public/app.js`, `public/style.css`
- Test: `test/group.test.ts`, `test/viewer.test.ts`

**Interfaces:**
- Consumes: `openDb`, `listItems`, `resolveItem`, `dismissItem`, `annotateItem`, `Item` from `store.js`.
- Produces:
  - `interface Grouped { needsYou: ProjectGroup[]; notes: ProjectGroup[]; done: Item[] }` where `interface ProjectGroup { project: string; items: Item[] }`.
  - `function groupItems(items: Item[]): Grouped` — open `question`s → needsYou (grouped by project), open `note`s → notes (grouped by project), `resolved`+`dismissed` → done (flat, newest first).
  - `function createViewer(db): Hono` — routes: `GET /api/items` → `Grouped` JSON; `POST /api/items/:id/resolve|dismiss`; `POST /api/items/:id/annotate` (body `{ text }`); `GET /` and static assets from `public/`.

- [ ] **Step 1: Write the failing grouping test**

```ts
// test/group.test.ts
import { describe, it, expect } from 'vitest'
import { groupItems } from '../src/group.js'
import type { Item } from '../src/store.js'

function item(p: Partial<Item>): Item {
  return {
    id: p.id ?? 'x', project: p.project ?? 'p', stream: p.stream ?? '', agent: p.agent ?? 'claude-code',
    kind: p.kind ?? 'note', title: p.title ?? 't', detail: p.detail ?? '', status: p.status ?? 'open',
    annotation: p.annotation ?? null, created_at: p.created_at ?? '2026-07-12T00:00:00.000Z', resolved_at: p.resolved_at ?? null,
  }
}

describe('groupItems', () => {
  it('splits open questions and notes by project, and buckets closed items into done', () => {
    const g = groupItems([
      item({ id: '1', project: 'social-agent', kind: 'question', status: 'open', title: 'q1' }),
      item({ id: '2', project: 'social-agent', kind: 'note', status: 'open', title: 'n1' }),
      item({ id: '3', project: 'oris', kind: 'question', status: 'open', title: 'q2' }),
      item({ id: '4', project: 'oris', kind: 'note', status: 'resolved', title: 'done1' }),
      item({ id: '5', project: 'oris', kind: 'question', status: 'dismissed', title: 'done2' }),
    ])
    expect(g.needsYou.map((pg) => pg.project).sort()).toEqual(['oris', 'social-agent'])
    expect(g.needsYou.find((pg) => pg.project === 'social-agent')!.items.map((i) => i.id)).toEqual(['1'])
    expect(g.notes.map((pg) => pg.project)).toEqual(['social-agent'])
    expect(g.done.map((i) => i.id).sort()).toEqual(['4', '5'])
  })
})
```

- [ ] **Step 2: Run grouping test to verify it fails**

Run: `npx vitest run test/group.test.ts`
Expected: FAIL — cannot find module `../src/group.js`.

- [ ] **Step 3: Write `src/group.ts`**

```ts
import type { Item } from './store.js'

export interface ProjectGroup {
  project: string
  items: Item[]
}
export interface Grouped {
  needsYou: ProjectGroup[]
  notes: ProjectGroup[]
  done: Item[]
}

function byProject(items: Item[]): ProjectGroup[] {
  const map = new Map<string, Item[]>()
  for (const it of items) {
    const arr = map.get(it.project) ?? []
    arr.push(it)
    map.set(it.project, arr)
  }
  return [...map.entries()].map(([project, its]) => ({ project, items: its })).sort((a, b) => a.project.localeCompare(b.project))
}

export function groupItems(items: Item[]): Grouped {
  const open = items.filter((i) => i.status === 'open')
  return {
    needsYou: byProject(open.filter((i) => i.kind === 'question')),
    notes: byProject(open.filter((i) => i.kind === 'note')),
    done: items.filter((i) => i.status !== 'open'),
  }
}
```

- [ ] **Step 4: Run grouping test to verify it passes**

Run: `npx vitest run test/group.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 5: Write the failing viewer endpoint test**

```ts
// test/viewer.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openDb, insertItem, listItems } from '../src/store.js'
import { createViewer } from '../src/viewer.js'

function freshDb(): Database.Database {
  return openDb(join(mkdtempSync(join(tmpdir(), 'view-')), 'inbox.db'))
}

describe('viewer api', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

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
})
```

- [ ] **Step 6: Run viewer test to verify it fails**

Run: `npx vitest run test/viewer.test.ts`
Expected: FAIL — cannot find module `../src/viewer.js`.

- [ ] **Step 7: Write `src/viewer.ts`**

```ts
import { Hono } from 'hono'
import type Database from 'better-sqlite3'
import { listItems, resolveItem, dismissItem, annotateItem } from './store.js'
import { groupItems } from './group.js'

export function createViewer(db: Database.Database): Hono {
  const app = new Hono()

  app.get('/api/items', (c) => c.json(groupItems(listItems(db))))

  app.post('/api/items/:id/resolve', (c) => {
    resolveItem(db, c.req.param('id'))
    return c.json({ ok: true })
  })

  app.post('/api/items/:id/dismiss', (c) => {
    dismissItem(db, c.req.param('id'))
    return c.json({ ok: true })
  })

  app.post('/api/items/:id/annotate', async (c) => {
    const { text } = await c.req.json<{ text: string }>()
    annotateItem(db, c.req.param('id'), text)
    return c.json({ ok: true })
  })

  return app
}
```

- [ ] **Step 8: Run viewer test to verify it passes**

Run: `npx vitest run test/viewer.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 9: Write the front-end and node entry**

`public/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agent Inbox</title>
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <header><h1>Agent Inbox</h1><span id="status"></span></header>
  <main>
    <section id="needsYou"><h2>Needs you</h2><div class="groups"></div></section>
    <section id="notes"><h2>Notes</h2><div class="groups"></div></section>
    <details id="done"><summary>Done</summary><div class="items"></div></details>
  </main>
  <script src="/app.js"></script>
</body>
</html>
```

`public/app.js`:

```js
async function load() {
  try {
    const g = await (await fetch('/api/items')).json()
    renderGroups('needsYou', g.needsYou)
    renderGroups('notes', g.notes)
    renderDone(g.done)
    document.getElementById('status').textContent = ''
  } catch {
    document.getElementById('status').textContent = 'disconnected'
  }
}

function renderGroups(sectionId, groups) {
  const host = document.querySelector(`#${sectionId} .groups`)
  host.innerHTML = groups.length ? '' : '<p class="empty">Nothing here.</p>'
  for (const grp of groups) {
    const box = document.createElement('div')
    box.className = 'project'
    box.innerHTML = `<h3>${esc(grp.project)}</h3>`
    for (const it of grp.items) box.appendChild(itemEl(it))
    host.appendChild(box)
  }
}

function renderDone(items) {
  const host = document.querySelector('#done .items')
  host.innerHTML = items.length ? '' : '<p class="empty">Nothing yet.</p>'
  for (const it of items) host.appendChild(itemEl(it, true))
}

function itemEl(it, done = false) {
  const el = document.createElement('article')
  el.className = `item ${it.kind}`
  const stream = it.stream ? ` · ${esc(it.stream)}` : ''
  el.innerHTML = `
    <div class="meta">${esc(it.agent)}${stream}</div>
    <div class="title">${esc(it.title)}</div>
    ${it.detail ? `<div class="detail">${esc(it.detail)}</div>` : ''}
    ${it.annotation ? `<div class="annotation">📝 ${esc(it.annotation)}</div>` : ''}`
  if (!done) {
    const actions = document.createElement('div')
    actions.className = 'actions'
    actions.appendChild(btn('Resolve', () => act(it.id, 'resolve')))
    actions.appendChild(btn('Dismiss', () => act(it.id, 'dismiss')))
    actions.appendChild(btn('Note', async () => {
      const text = prompt('Your note:')
      if (text != null) { await fetch(`/api/items/${it.id}/annotate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }); load() }
    }))
    el.appendChild(actions)
  }
  return el
}

function btn(label, onClick) {
  const b = document.createElement('button')
  b.textContent = label
  b.addEventListener('click', onClick)
  return b
}

async function act(id, action) {
  await fetch(`/api/items/${id}/${action}`, { method: 'POST' })
  load()
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

load()
setInterval(load, 3000)
```

`public/style.css`:

```css
:root { color-scheme: light dark; --gap: 12px; }
* { box-sizing: border-box; }
body { font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 0 16px 48px; max-width: 900px; margin-inline: auto; }
header { display: flex; align-items: baseline; gap: 12px; padding: 16px 0; position: sticky; top: 0; background: Canvas; }
h1 { font-size: 20px; margin: 0; }
#status { color: crimson; font-size: 13px; }
h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .05em; opacity: .6; margin: 24px 0 8px; }
.project h3 { font-size: 13px; margin: 12px 0 6px; opacity: .8; }
.item { border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); border-left-width: 3px; border-radius: 8px; padding: 10px 12px; margin-bottom: var(--gap); }
.item.question { border-left-color: crimson; }
.item.note { border-left-color: goldenrod; }
.meta { font-size: 12px; opacity: .55; }
.title { font-weight: 600; margin: 2px 0; }
.detail, .annotation { font-size: 13px; opacity: .8; white-space: pre-wrap; }
.annotation { margin-top: 4px; opacity: .7; }
.actions { display: flex; gap: 8px; margin-top: 8px; }
.actions button { font-size: 12px; padding: 3px 10px; border-radius: 6px; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); background: transparent; cursor: pointer; }
.empty { opacity: .4; font-size: 13px; }
#done summary { cursor: pointer; margin-top: 24px; opacity: .6; }
```

`src/viewer-server.ts`:

```ts
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { openDb } from './store.js'
import { createViewer } from './viewer.js'

const db = openDb()
const app = createViewer(db)
app.get('/*', serveStatic({ root: './public' }))

const port = Number(process.env.AGENT_INBOX_PORT ?? 4319)
serve({ fetch: app.fetch, port })
console.log(`agent-inbox viewer on http://localhost:${port}`)
```

- [ ] **Step 10: Manually verify the viewer serves**

Run: `AGENT_INBOX_DB=/tmp/inbox-demo.db npm run view` then open `http://localhost:4319`.
Expected: page loads with "Needs you" / "Notes" / "Done" sections (empty). Stop with Ctrl-C.

- [ ] **Step 11: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass, exit 0.

- [ ] **Step 12: Commit**

```bash
git add src/group.ts src/viewer.ts src/viewer-server.ts public/ test/group.test.ts test/viewer.test.ts
git commit -m "feat: hono viewer (grouped inbox, resolve/dismiss/annotate, 3s polling)"
```

---

### Task 6: Install + reporting snippet docs

**Files:**
- Create: `docs/INSTALL.md`, `docs/reporting-snippet.md`
- Modify: `README.md` (link the two docs)

**Interfaces:**
- Consumes: the built `agent-inbox-mcp` bin and `npm run view` from earlier tasks.
- Produces: copy-paste registration commands + the flag-timing snippet. No code; the "test" is a manual accuracy check against the real CLIs.

- [ ] **Step 1: Write `docs/INSTALL.md`**

```markdown
# Install

## 1. Build
```sh
npm install && npm run build
```

## 2. Register the MCP server at user scope (once, applies to every repo)

**Claude Code:**
```sh
claude mcp add --scope user agent-inbox -- node /ABSOLUTE/PATH/TO/agent-inbox/dist/mcp-server.js
```

**Copilot CLI:** add to its global MCP config (`~/.config/github-copilot/mcp.json` or per the current Copilot CLI docs):
```json
{
  "mcpServers": {
    "agent-inbox": { "command": "node", "args": ["/ABSOLUTE/PATH/TO/agent-inbox/dist/mcp-server.js"] }
  }
}
```

Verify: in a repo, run the agent and call the `whoami` tool — it should report that repo's project and branch.

## 3. Run the viewer
```sh
npm run view   # http://localhost:4319
```
Leave it running (or wrap as a login item / Electron app later).

## 4. Add the reporting snippet
Paste `docs/reporting-snippet.md` into your global agent instructions (`~/.claude/CLAUDE.md` and Copilot's global instructions) so agents know *when* to flag.
```

- [ ] **Step 2: Write `docs/reporting-snippet.md`**

```markdown
# Agent Inbox — reporting instructions (paste into global agent instructions)

You have an `agent-inbox` MCP server with a `flag` tool. Use it to surface things
the human would otherwise miss in the terminal firehose. project/stream/agent are
inferred automatically — you only pass kind, title, and optionally detail.

Call `flag` when:
- **`kind: "question"`** — you are about to pause and wait on the human: a decision,
  a missing credential, an ambiguity you cannot resolve yourself. One flag per real
  blocker; put the actual question in `title`, options/context in `detail`.
- **`kind: "note"`** — you made a notable **assumption**, took a **workaround**, hit a
  **caveat**, or left **tech debt** the human should know about but that does NOT block
  you. Do not flag routine progress or things visible in the diff.

Keep `title` to one line. Do not flag more than the human needs — a noisy inbox gets
ignored. If a question you raised resolves itself before they answer, call `resolve`
with its id.
```

- [ ] **Step 3: Link the docs from `README.md`**

Add under the existing description:

```markdown
## Setup
- [Install & register](docs/INSTALL.md)
- [Reporting snippet for agents](docs/reporting-snippet.md)
```

- [ ] **Step 4: Manual accuracy check**

Confirm the `claude mcp add --scope user` syntax against `claude mcp add --help`, and the Copilot global MCP config path against current Copilot CLI docs. Correct the doc if either differs. (No automated test — docs task.)

- [ ] **Step 5: Commit**

```bash
git add docs/INSTALL.md docs/reporting-snippet.md README.md
git commit -m "docs: install/registration guide + agent reporting snippet"
```

---

## Notes for the executor

- **Native module:** `better-sqlite3` builds a native binding on `npm install`; if it fails, ensure Xcode CLT / build tools are present. It must load in the Vitest process (no mocking of SQLite — tests use real temp DBs).
- **SDK drift:** the two SDK-facing spots to sanity-check against the installed version are `McpServer.registerTool(...)` (Task 4, Step 5) and `server.server.getClientVersion()?.name` (Task 4, Step 5). If either differs, keep the *behavior* (register the four tools; read the client name from the initialize handshake) and adapt the call.
- **v2 seams to leave intact:** `register`/`whoami` (identity for future remote mode), the `Grouped.done` bucket (no `done` *kind*), and `AGENT_INBOX_DB`/`AGENT_INBOX_PORT` env overrides.
```
