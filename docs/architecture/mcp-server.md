---
paths:
  - "src/mcp.ts"
  - "src/mcp-server.ts"
  - "src/scope.ts"
  - "src/infer.ts"
  - "src/shape.ts"
applyTo: "src/mcp.ts,src/mcp-server.ts,src/scope.ts,src/infer.ts,src/shape.ts"
---

# MCP server, scope and agent-read shape

The stdio MCP server: process model, scope inference, the sacred stdout channel and agent-side payload trimming (#42).

Moved out of `CLAUDE.md` and `.github/copilot-instructions.md` by #379, nearly verbatim. Claude Code and Copilot CLI load this file automatically when they read or edit a file matching the `paths`/`applyTo` globs above (through the symlinks in `.claude/rules/` and `.github/instructions/`); anyone else should read it before changing those files.

## In brief

- MCP stdout is the protocol channel. Never add `console.log` in the MCP server
  path or let subprocess stdout inherit it. Capture subprocess output. Viewer
  logging is allowed. Hook CLI stdout/stderr and exit codes are also protocol
  contracts; preserve the exact behavior documented in `docs/hooks.md`.
- Keep network access out of the MCP process. Repository/branch identity is
  inferred locally; live PR and issue state is fetched only by the viewer's `gh`
  pollers (`src/prstate.ts`, `src/issue-poller.ts`).
  PR/check state is ambient information and must not enter the human-attention
  predicate.

## Invariants in detail

- **One process per CLI (stdio), one shared file.** A server is spawned per *client process*, not
  per agent session — a subagent's calls are served by its parent CLI's long-lived server
  (measured: servers observed running 4+ days), so a fan-out shares one process, one `sessionId`
  and one in-memory ledger. All instances write to the same `~/.agent-inbox/inbox.db`. Concurrency
  is handled by **WAL + `busy_timeout=5000`** set in `openDb` — keep both. Writes are single tiny
  inserts; this is WAL's happy path. `busy_timeout` never applies when a deferred transaction's
  read snapshot is promoted to the writer — that fails at once with `SQLITE_BUSY` or
  `SQLITE_BUSY_SNAPSHOT` — so any transaction that reads before it may write must be
  `.immediate()` (#154).
- **Session scope is Solo-style** (`src/scope.ts`): inferred lazily per call, overridable via
  `register`. The one memo is a FOUND origin remote (#159): once `git remote get-url origin`
  succeeds, the server reuses it for both `project` and `repo` for the process's life (the
  accepted cost: a later `git remote set-url` is not followed). A missing origin is never
  cached — it is re-read on every call, because `src/hook.ts` infers the project live on every
  hook event and the two must keep agreeing (a mid-session `git remote add origin`, or one
  transient git failure, must not pin the folder name). The branch (and the issue parsed from
  it) is re-read on every call because worktrees and checkouts move mid-session, so never
  cache the whole scope. Head inference (`headFor`, #157) stays outside both `get()` and that
  memo: it runs only on flag/board writes and reads git's push destination (and, #183, the
  branch's upstream ref) live, because it needs origin's PUSH url, which the cached fetch url
  cannot answer.
  The client name for `inferAgent` **must be read lazily** inside handlers
  (`server.server.getClientVersion()?.name`) — it's only populated after the initialize
  handshake. Capturing it at build time yields `undefined`/`'unknown'`. Don't regress this.
- **stdio channel is sacred.** The server speaks MCP over stdout — never `console.log` to
  stdout from server code, and any subprocess (e.g. git in `infer.ts`) must **capture**
  stdout (`stdio: ['ignore','pipe','ignore']`), never inherit it. A handler throw is fine:
  the SDK wraps it into `{ isError: true }` and the process survives.
- **Fail-open / never lose a flag.** If inference fails, attribute to `unknown` and still
  insert. If a write fails, surface an MCP error — don't crash.
- **`src/shape.ts` is AGENT-SIDE ONLY (issue #42).** `context` is written for the human
  and rendered collapsed, so agents write it generously — and every agent read used to pay
  for all of it. `shape.ts` is where the MCP read payloads are trimmed (`context` →
  `context_chars`, `full: true` to fetch); `store.ts` still returns whole rows and
  `src/viewer.ts` must never import it, so `/api/boards` and `/api/items` stay
  byte-identical for the human. **Only agent-authored `context` is ever trimmed** — the
  human's `annotation`/`reply`/`reply_context` is never omitted on any path, under any
  option. **The "handed over once" ledger is per-PROCESS, and that is all it can be.** Not
  per session and not per agent: the stdio server is long-lived, and a Claude Code
  subagent's MCP calls are served by the PARENT CLI's process — so a fan-out SHARES one
  ledger and the first sibling to poll consumes the delivery. (The persisted stamp is no
  better: `annotation_seen_by` is a CLIENT NAME every sibling shares.) MCP exposes no
  subagent identity to key on, so the ledger is **an optimisation, never a guarantee** —
  what makes that safe is that a trimmed context is ALWAYS recoverable on demand:
  `pending({full:true})` for items and rows, `board_get({title, full:true})` for a board.
  Keep both hatches, and keep them named in the tool descriptions. Do not re-assert
  "one process = one session"; it was measured and it is false.

## History (shipped since v1)

These landed after v1 and still hold invariants; the release history itself is in `CHANGELOG.md`.

- **Agent-read payload diet** *(#42)* — `src/shape.ts`. MCP reads omit agent-authored `context` and
  report `context_chars` instead; `board_get()` with no title is a summary; and a given context is
  handed over ONCE per server process (the human's words still come back on every poll — #37 is
  untouched). Two escape hatches, both named in the tool descriptions: `pending({full:true})` for
  items and rows, `board_get({title, full:true})` for a board. Measured against a copy of the live
  db (`JSON length / 3.6`, the issue's method): `board_get()` 11,493 → 2,604 tok (agent-inbox),
  14,818 → 3,955 (oris); the biggest single board 4,361 → 1,551, unchanged under `full:true`; and,
  with the project's 14 heavy rows synthetically blocked, 20 polls 136,791 → 52,568. It costs +477
  tok of tool definitions once per session. Agents still write generous `context` for the
  human; action-first TL;DR/next-step fields do not turn context into a terse status slot.
