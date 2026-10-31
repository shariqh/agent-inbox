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

- The server declares Claude Code's `claude/channel` capability and pushes a
  message notice into a Claude Code session (#411, research preview); only a
  Claude Code client sees the capability or its instructions, and the notice
  carries a message id, never text.
- `@sessions` and `@mesh` are reserved projects (#412): `register` refuses one, and
  `flag`, `pending`, `answer`, `resolve` and every `board_*` tool refuse a scope, a
  `project` argument or an item id in one. A session a driver holds a fresh
  `driven:` lease for gets `woken: "pushed"` and no watch contract.

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
- **Claude Code channels push a message notice, and only to Claude Code (issue #411,
  research preview).** `src/channel.ts`. The `McpServer` is built with
  `capabilities.experimental['claude/channel'] = {}` and `instructions` saying what an
  event means, as Claude Code's channels reference requires. The SDK sends both to every
  client and refuses to change capabilities once connected, so `mcp.ts` replaces the
  initialize handler with one that calls the SDK's own `_oninitialize` and, for any client
  `inferAgent` does not call `claude-code`, strips the capability and the instructions:
  Copilot's handshake, context and `tools/list` stay as they were
  (`test/mcp.integration.test.ts` fails if an SDK upgrade drops `_oninitialize`, which
  would fall back to declaring both to everyone). After the handshake a Claude Code client
  starts `startChannelPush`: every 2 s one indexed read of the server's own open message ids
  (`listOpenMessages(db, [sessionId])`, through `store.ts`), and one
  `notifications/claude/channel` per id it has not pushed, `{ content: <fixed notice>,
  meta: { message_id } }`. Never the text: delivery, isolation and the record stay
  `pending()` and `ack_message`. The pushed set is in memory (bounded by the open ids, so
  the schema is unchanged); a failed send is retried next tick, a sent one never repeated.
  Claude Code acknowledges nothing and says nothing in its handshake about listening
  (measured on v2.1.312: the initialize request is byte-identical with and without the
  flag), so the loop runs for every Claude Code client, and one that is not listening drops
  the notice silently. Presence records the closest local evidence instead: `push_wake`
  (below) from the launch flags of the Claude Code process that started the server
  (`inferProcessArgs(process.ppid)`: `/proc` on Linux, `ps` on macOS, captured, once).
  So `push_wake` can only err one way in practice: a wrapper process, a session hosted by
  Claude Code's background daemon (parent `claude bg-spare … claim.sock`, which carries none
  of the user's flags) or another registration name reads as absent, and absent means
  unknown, never "won't wake". (The one false positive: on macOS `ps` joins the arguments
  with spaces, so a quoted prompt that contains the flag tokens reads as true; Linux reads
  `/proc` exactly.) The loop is stopped when the connection closes (`server.server.onclose`)
  and never started after it.
  Two traps. The server's name is the registration's, which the server never learns, so
  presence recognises only `server:agent-inbox`, the name the installer registers. And
  Claude Code's v2 MCP runtime will not register a channel server that negotiates protocol
  revision 2026-07-28: SDK 1.x answers on the earlier revision, so upgrading
  `@modelcontextprotocol/sdk` to 2.x turns the push off (`MCP_PROTOCOL_NEGOTIATION=legacy`
  is Claude Code's escape hatch).
- **Reserved projects are unreachable from MCP (issue #412, driven sessions §4.2, mesh
  §10.3).** A driver files its approval alerts in `@sessions` (and the mesh will file its
  asks in `@mesh`) under the driven agent's own MCP session, so no session in the asks' real
  project wakes on them, and an older server's `resolve` can never count as Deny. Exactly
  those two names (`isReservedProject` in `store.ts`): a folder with no remote can be named
  with a leading `@`. `mcp.ts` refuses with one fixed message: `register` with a reserved
  project; `flag`, `pending` and every `board_*` tool when the session's scope is one
  (`agentScope()`, which covers an inferred folder name too), `pending` also for a reserved
  `project` argument; `answer` and `resolve` for an item filed in one. The store backs it
  up: `listPending`, `listPendingRows` and `listUnansweredBoardRows` return nothing for a
  reserved project, whoever calls them. `status` and `whoami` are not refused (presence is
  not attention). An older server lacks the refusals, so an agent that registers
  `@sessions` on one can read the alerts; the design's threat model accepts that.
- **A driven session is told its answers are pushed (issue #412, §5.3).** `isDrivenSession`
  reads the session's `driven:<session>` lease in `hook_watch_claims`, fresh for 90 s,
  which a driver refreshes every 30 s. While it holds, `flag` (a question), `pending`,
  `board_upsert`/`board_row`/`board_advance` (a new ask) and `board_get({watch:true})` add
  `woken: "pushed"` and return no `watch`/`watches`: the driver pushes each answer ping and
  message as a new turn, so a watcher would only cost a wake. The lease is read fresh on
  every call; tool descriptions are unchanged, so `tools/list` is byte-identical.
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
