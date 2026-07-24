# Agent Inbox — Design (v1)

> Working name `agent-inbox` (placeholder — rename freely). Standalone repo.

**Goal:** One durable, cross-project, cross-tool "what needs my attention" inbox that my coding agents (Claude Code, Copilot CLI) write to themselves via MCP — so open questions and easily-missed notes stop scrolling past in the CLI firehose.

**One-liner:** Agents call one MCP tool (`flag`) mid-work; every flag lands in a single local store; a viewer shows the whole cross-project inbox grouped by *Needs you* / *Notes*.

---

## Why this exists (and why not just use Agent View)

Claude Code's native **Agent View** (`claude agents`) already solves cross-project *status* monitoring for **Claude Code only** — grouped Needs-input/Working/Done, extracted blocking question, inline reply, notification hooks. It's free and excellent. Two things it does not do, which are this tool's entire reason to exist:

1. **Cross-tool.** I run **Copilot CLI** too. Agent View can't see it. A unified attention view has to span both.
2. **Non-blocking notes.** Agent View surfaces what an agent is *blocked on*. It does not surface the agent's asides — "I assumed X," "this is tech debt," "couldn't do Y, worked around it." Those are exactly the "notes I miss," and you cannot extract them from raw logs without a second AI.

**No second AI.** The whole tool is dumb infra: a store + a viewer + a thin MCP server. Zero model calls. The only intelligence is the agent *already running*, which knows the difference between chatter and "you should see this," and files it as a normal tool call.

---

## Scope

**v1 (this spec):**
- Local-only. stdio MCP server + local SQLite hub + local web viewer.
- Write + triage: agents `flag` items; I read, `resolve`, dismiss, annotate in the viewer.
- Two kinds: `question` (needs my answer/decision) and `note` (non-blocking FYI).
- Auto-inferred attribution (project / stream / agent) — agent only supplies content.

**Explicitly out of v1 (planned later, seams left in place):**
- **Answer-back** (reply to an agent from the viewer) — v2. Adds a `pending` tool the agent polls.
- **Remote mode** (run on a remote host, tunnel-exposed, phone access, cloud agents) — v2. Adds HTTP transport + auth; the `register` seam already covers identity when the server can't see the client's cwd.
- **`done`/milestone bucket** — opt-in later; omitted now to keep the inbox high-signal.
- **Notification hooks backstop** (Claude Code Stop/needs-input hooks → deterministic event) — later nicety for status even when an agent forgets to flag.
- **Electron packaging** — the viewer is built as a plain local web app so it wraps into an Electron window unchanged.

---

## Architecture — hub and spoke

```
  claude in ~/dev/social-agent  ─┐
  copilot in ~/dev/oris         ─┼─►  ~/.agent-inbox/inbox.db  ──►  viewer (localhost)
  claude in ~/dev/anything      ─┘        (the single hub)          all projects, one screen
```

Three components, one shared file:

### 1. MCP server (stdio)
- One binary, installed once, registered at **user scope** in each CLI's MCP config (`claude mcp add --scope user agent-inbox …` + Copilot's global equivalent). Auto-attaches to every agent session in every repo. No per-repo setup.
- Spawned per agent session by the CLI, inheriting that session's `cwd` — which is *only* used to label flags, never to store them.
- Identity is bound to the MCP session, Solo-style: inferred at startup, overridable via `register`. Subsequent tool calls inherit the scope; the agent never re-declares project/stream.

### 2. Store — SQLite hub
- Single file at `~/.agent-inbox/inbox.db`, **WAL mode** (many short-lived stdio server instances write concurrently; WAL handles it).
- Path override via `AGENT_INBOX_DB` env (tests point it at a temp file).
- `better-sqlite3` (synchronous, zero-ceremony, ideal for this write pattern).

### 3. Viewer — local web app
- A tiny long-running local process (Hono) serving `localhost:PORT`, reading the same `inbox.db`.
- Groups: **Needs you** (open `question`s) pinned top, **Notes** (open `note`s) below, collapsible per project; resolved items tucked into a "Done" drawer.
- Each item: resolve / dismiss / add a private annotation. Polling refresh (~3s) — no websockets in v1.
- Plain HTML/CSS/JS front-end so the same bundle later drops into an Electron window.

---

## Data model

One item = one row in `items`:

| column | type | meaning |
|---|---|---|
| `id` | text (uuid) | primary key |
| `project` | text | codebase — inferred from git remote name or `cwd` basename (e.g. `social-agent`) |
| `stream` | text | agent run within it — inferred from `git branch --show-current` (e.g. `feat/blog-published-at-merge`); `''` if none |
| `agent` | text | who raised it — from MCP `initialize` `clientInfo.name` (`claude-code` / `copilot` / `unknown`) |
| `kind` | text | `question` \| `note` |
| `title` | text | one-line summary shown in the list |
| `detail` | text | optional longer body (markdown) |
| `status` | text | `open` \| `resolved` \| `dismissed` |
| `annotation` | text | my private note added in the viewer; nullable |
| `created_at` | text (ISO) | set server-side |
| `resolved_at` | text (ISO) | nullable |

Indexes: `(status, project)`, `(created_at)`.

### Status ownership — who clears the inbox

Two lanes, no overlap of intent:
- **Agents raise, and self-resolve when moot.** An agent `flag`s what happened, and may `resolve` its own item when it becomes obsolete (answered its own question, or the caveat no longer applies) — so stale items don't sit in my face.
- **I triage.** In the viewer I `resolve` items I've acted on, `dismiss` items I don't care about, and annotate.

The agent is the source of truth for *what happened*; the inbox is *my* surface for clearing it. Keeping `dismissed` distinct from `resolved` is deliberate: my **dismiss rate is the noise signal** — lots of dismissed notes means the reporting snippet (below) is over-flagging and needs tightening.

---

## MCP tool contracts

Deliberately tiny. The agent's whole job in the common case is one `flag` call.

### `flag`
```
flag({ kind: 'question' | 'note', title: string, detail?: string, stream?: string })
  → { id: string }
```
- Inserts an `open` item, attributed to the **session's** inferred `project` / `agent` and inferred (or supplied) `stream`.
- The single call agents make constantly. Instruction to agents: *call this the instant you'd otherwise pause to ask in the terminal (`question`), or whenever you make a notable assumption / caveat / workaround you'd want seen (`note`).*

### `resolve`
```
resolve({ id: string }) → { ok: true }
```
- Marks an item `resolved`. An agent may close its own item once it moves past it; mostly I resolve from the viewer.

### `register`
```
register({ project?: string, stream?: string }) → { project: string, stream: string, agent: string }
```
- Optional. Overrides the session's inferred scope when auto-detect is wrong, and is the seam remote mode reuses (a server that can't see the client's `cwd` requires this). Returns the resolved scope.

### `whoami`
```
whoami() → { project: string, stream: string, agent: string }
```
- Debug: report the session's current scope. No side effects.

**Auto-inference (at session start / first call):**
- `project` ← git remote basename of `cwd`, else `cwd` basename, else `'unknown'`.
- `stream` ← `git branch --show-current` in `cwd`, else `''`.
- `agent` ← `initialize` handshake `clientInfo.name`, normalized; else `'unknown'`.
- Any of these overridable per session via `register`, per call via `flag`'s `stream`.

---

## Data flow (end to end)

1. Once: `claude mcp add --scope user agent-inbox <cmd>` (+ Copilot global config). A short reporting-instruction snippet is added to my global agent instructions (Claude `~/.claude/CLAUDE.md`, Copilot equivalent).
2. I start an agent in any repo. The CLI spawns the stdio inbox server as a child (inheriting that repo's `cwd`); the server infers project/stream/agent.
3. Mid-work the agent hits an open question or makes a notable assumption → calls `flag({ kind, title, detail? })`.
4. Row inserted into `~/.agent-inbox/inbox.db`, tagged with the inferred scope.
5. The viewer (already running on `localhost`) polls the DB and shows the item under its project, in Needs-you or Notes.
6. I triage: resolve / dismiss / annotate. (Answering the agent still happens in the actual terminal — answer-back is v2.)

---

## Error handling

- **Can't infer project** (no git, odd cwd) → `project = 'unknown'`; item still lands (never lose a flag). Viewer shows an "unknown" bucket.
- **DB locked** (concurrent writers) → WAL + a short busy-timeout retry; `flag` is a single tiny insert, so contention is minimal. A write that still fails returns an MCP error to the agent but never crashes the server.
- **Viewer stale** → polling reconciles within one interval; no push needed in v1.
- **Agent never calls `flag`** → acknowledged dependency, not a code failure. Mitigation: the reporting-instruction snippet in global agent instructions. The optional Claude Code hooks backstop (status only) is a later add. This is the one behavioral (not architectural) risk and is called out deliberately.
- **`resolve` unknown id** → `{ ok: true }` idempotent no-op (agents retrying must be safe).

---

## Testing

- **Inference unit tests** — project/stream/agent resolution from a fixture repo (temp dir with/without git, with/without a branch), including the `'unknown'` fallbacks.
- **Store unit tests** — insert / resolve / dismiss / annotate against a temp DB (`AGENT_INBOX_DB`); WAL concurrent-write smoke (two writers, no loss).
- **MCP handler tests** — `flag`/`resolve`/`register`/`whoami` handlers with a mocked session scope; assert rows written with correct attribution, idempotent `resolve`.
- **MCP round-trip integration** — spin the stdio server, drive it with an MCP client, `flag` → assert the row in a temp DB; `whoami` reflects a prior `register`.
- **Viewer tests** — grouping/render logic from a seeded DB (Needs-you vs Notes vs Done, per-project collapse); resolve/dismiss/annotate endpoints mutate the row.

**Tech stack:** Node 24, TS ESM (`.js` specifiers), `@modelcontextprotocol/sdk`, `better-sqlite3`, Hono (viewer), Vitest. Mirrors social-agent conventions so the tooling is familiar.

---

## Resolved decisions

1. **Name** — `agent-inbox`. Kept.
2. **Viewer launch** — plain localhost web app on a fixed default port, started via `npm run view`. Electron is a later wrap of the same bundle, not in v1.
3. **Statuses** — keep both `resolved` and `dismissed` in v1 (see *Status ownership* above): agents raise + self-resolve when moot; I resolve/dismiss/annotate as triage; dismiss-rate is the noise signal.
4. **Reporting snippet** — the global-instruction text telling agents *when* to `flag` is the lever for signal quality. It gets its **own plan task**, iterated separately from the code (ships as a documented snippet I paste into `~/.claude/CLAUDE.md` and Copilot's global instructions).
