import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { insertItem, resolveItem, listPending, markReplySeen, answerItem, upsertBoard, updateBoardRow, findBoard, archiveBoard, getBoard, listBoards, markBoardRead, markAnnotationDelivered, markHandledDelivered, listPendingRows, upsertActivity, endActivity, touchActivity, recordActivityCall } from './store.js'
import type { BoardWithRows } from './store.js'
import { makeContextLedger, deliverContext, shapeBoard, summariseBoard, rowKey, itemKey } from './shape.js'
import { makeScope } from './scope.js'
import { copilotWatchLaunch } from './watch.js'

// The 5-minute liveness tick, hoisted OUT of its setInterval callback on purpose
// (#45). This is the line the two-stamp distinction rests on — it moves
// `updated_at` and must NEVER move `last_call_at` — and inline in an anonymous
// callback it was unreachable from any test: a `recordActivityCall` added beside
// it there restored the original "claim never decays" bug with the whole suite
// still green. Named, it can be fired directly; test/live-tick.test.ts asserts
// what it does over 12 modelled hours of silence AND that the timer's body is
// nothing but this call.
export function livenessTick(db: Database.Database, session: string): void {
  try { touchActivity(db, session) } catch { /* presence must never break the server */ }
}

export function buildMcpServer(db: Database.Database, cwd: string): McpServer {
  const server = new McpServer({ name: 'agent-inbox', version: '0.1.0' })
  const scope = makeScope(cwd)
  // issue #42 — what THIS SERVER PROCESS has already handed over. Per-process,
  // NOT per session or per agent: this server is long-lived and a subagent's
  // calls are served by its parent CLI's process, so a fan-out shares one
  // ledger. That is why every trimmed context stays recoverable on demand
  // (`pending({full:true})`, `board_get({title, full:true})`) — the ledger only
  // decides whether the common case is cheap. See src/shape.ts.
  const ledger = makeContextLedger()
  const clientName = (): string | undefined => server.server.getClientVersion()?.name
  // one id per SERVER PROCESS, used as the session id for the live-activity view.
  // NOT one per agent session: a subagent's calls are served by its parent CLI's
  // long-lived process (measured — servers observed running 4+ days), so a
  // fan-out shares this id. Presence therefore tracks the CLI, not the agent.
  const sessionId = randomUUID()

  // ── session presence (issue #28): the session itself is a Live row ──
  // Registered after the initialize handshake (clientInfo is only populated
  // then), heartbeated by the server so an idle session never goes stale,
  // upgraded/reverted by the status tool, ended when this process exits.
  //
  // `claim: false` is load-bearing, not decoration. This runs TWICE — on the
  // initialize notification and again on an unconditional 2-second fallback — and
  // an agent that reports its first phase inside that window had the claim wiped
  // two seconds later, which is precisely what the `status` description's "it
  // re-asserts instantly" promises cannot happen. Registration says only "this
  // session is here": scope, liveness, not-ended. `doing`/`idle`/`detail`/
  // `children` belong to the agent, and only `status` writes them.
  const registerPresence = (): void => {
    try {
      const s = scope.get(clientName())
      upsertActivity(db, { session: sessionId, project: s.project, stream: s.stream, agent: s.agent, doing: 'open', idle: true, claim: false })
    } catch { /* presence must never break the server */ }
  }

  // Every tool call is proof of WORK, not merely of life — the freshness dot in
  // the viewer's open-sessions fold turns green for a session that's actively
  // conversing. Issue #45: this is the ONLY thing that writes `last_call_at`,
  // and that is the entire distinction between "this process is alive" and
  // "this agent is doing something". The timer below must never call it.
  const heartbeat = (): void => {
    try { recordActivityCall(db, sessionId) } catch { /* ignore */ }
  }
  server.server.oninitialized = registerPresence
  setTimeout(registerPresence, 2000).unref() // fallback if no initialized notification arrives
  // liveness only: keeps the session listed (a crashed process still falls out
  // of listActivity's 15-minute window) while letting its `doing` claim go cold.
  // One call, and it must stay one call — see livenessTick above.
  setInterval(() => livenessTick(db, sessionId), 5 * 60000).unref()
  process.on('exit', () => {
    try { endActivity(db, sessionId) } catch { /* ignore */ }
  })
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(0))

  server.registerTool(
    'flag',
    {
      description:
        'Raise an item for the human. Use kind="question" whenever you are about to STOP and WAIT on the human — a decision, a missing credential, an ambiguity you cannot resolve, or a recommendation / next step you are ending your turn on ("recommend X — go?", "want me to ...?", "say the word"). The test is not whether you are mid-conversation; it is whether your next move depends on their answer — such a moment left only in chat is invisible, so flag it (a recommendation in your last paragraph does NOT reach them). kind="note" = a non-blocking assumption, caveat, or workaround they should see; kind="done" = a finished milestone (shipped / merged / deployed), used sparingly, NOT routine progress. Keep it glanceable: title is the ask or finding itself in one line (aim under ~80 chars), detail is ONE line (the why or impact), and everything long — background, files/PRs/links, the context a cold reader needs — goes in context, which renders collapsed so length there is free. For a question, ALWAYS include 2-4 options when the answer has discernible choices: your recommendation first with recommended:true, each a short label plus a detail explaining the tradeoff; the human can pick one, compare them, or answer freely. Copilot question responses include a `watch` launch contract: immediately run its `shell_command` as a detached async background task using the returned mode, detach, shell_id, and timeout_seconds values. Do not wait synchronously. Its completion notification wakes the session; then call pending() immediately, act on the reply, and resolve the question. Other clients continue using their native wake path. One question, two channels: never ask the same decision twice in two places — if the human answers you in chat rather than on the card, record it with the answer tool so the inbox converges. project/stream/agent are inferred automatically.',
      inputSchema: {
        kind: z.enum(['question', 'note', 'done']),
        title: z.string().min(1),
        detail: z.string().optional(),
        context: z.string().optional(),
        stream: z.string().optional(),
        options: z
          .array(z.object({ label: z.string().min(1), detail: z.string().optional(), recommended: z.boolean().optional() }))
          .max(5)
          .optional(),
      },
    },
    async ({ kind, title, detail, context, stream, options }) => {
      heartbeat()
      const s = scope.get(clientName())
      // issue #30 — a per-call `stream` override changes which BRANCH this item
      // was raised on, so the issue has to follow it. scope.issueFor owns the
      // override-then-infer precedence; branch-parsing policy never leaks in here.
      const branch = stream ?? s.stream
      const id = insertItem(db, {
        project: s.project,
        stream: branch,
        agent: s.agent,
        repo: s.repo,
        issue_ref: scope.issueFor(branch),
        // stamp the asking session so the viewer can tell "waiting" (this
        // session is still in /api/activity) from "parked" (agent long gone)
        session: sessionId,
        kind,
        title,
        detail,
        context,
        options,
      })
      const result = kind === 'question' && s.agent === 'copilot'
        ? { id, watch: copilotWatchLaunch(id) }
        : { id }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    },
  )

  server.registerTool(
    'resolve',
    {
      description: 'Mark one of your own inbox items resolved once it is moot (you answered it yourself, or the caveat no longer applies).',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      heartbeat()
      resolveItem(db, id)
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }
    },
  )

  server.registerTool(
    'pending',
    {
      description:
        'Poll for everything the human has said to you in this project — the ONE polling call; you do not need board_get to hear from them. Returns {items, rows}. items = your open questions, each with its reply (null until the human answers — reply may be one of your options or their own free-text direction; follow it either way) plus optional reply_context, and `annotation` if they pinned a side-note to the card — read that too. rows = what the human has said or DONE on your tracking boards, each {board_title, label, note, annotation, handled_at, …}. Two shapes arrive here and you must act on both: `annotation` is the human answering that row in words, and `handled_at` is the human telling you THEY HAVE DONE THE THING you blocked on — the account is created, the video is recorded, the key exists now. A row can carry either or both. Either way, go and check/continue the work and then flip the row’s status with board_row — THAT STATUS CHANGE IS WHAT TELLS THEM YOU DID, and it is the only thing that takes the row off their screen. Never answer a `handled_at` row by re-sending it as `blocked` with the same ask. NOTHING here is handed over only once, so nothing is lost if you are busy or if a sibling session polls first: a question keeps coming back until you `resolve` it, and a `blocked` row keeps coming back until you change its status. That means you WILL see the same answer again — `annotation_seen_at`/`annotation_seen_by`/`handled_seen_at` on a row (and `reply_seen_at` on an item) mean it reached SOME agent, very often a sibling session sharing your agent name rather than you, so a stamp is NEVER a reason to skip it: if the row is still `blocked`, or the question still open, it is not done and it may well be yours to do. The stamp only tells you someone else may be working it too; the status change (or `resolve`) is the real signal. Poll between work steps rather than blocking. If the human answered you in chat instead, record it with the answer tool — but an inbox reply you have not picked up here always wins over one given in chat. Polling is cheap on purpose: everything the HUMAN wrote or marked (reply, reply_context, annotation, handled_at) comes back in full every time, but agent-authored `context` is handed over only ONCE — after that a row or item carries `context_chars` instead, its size as JS counts it (UTF-16 code units, so an emoji counts 2). That "once" is per SERVER PROCESS, and a fan-out of subagents shares one: a sibling’s poll can consume a delivery you never received, so `context_chars` is NOT proof you have the text. Whenever you are missing context you actually need, ask for it — `pending({full:true})` returns every context in this payload in full, and `board_get({title, full:true})` returns one board’s rows in full. Nothing is ever unreachable, so never guess at backstory you were not given.',
      inputSchema: { full: z.boolean().optional() },
    },
    async ({ full }) => {
      heartbeat()
      const s = scope.get(clientName())
      const items = listPending(db, s.project)
      for (const it of items) if (it.reply && !it.reply_seen_at) markReplySeen(db, it.id, it.replied_at)
      // issue #37 — the human's board-row notes had NO delivery path: pending()
      // was items-only, so an agent following the contract perfectly still never
      // saw one. The store decides WHAT is still pending (gated on the row being
      // unacknowledged, not on the delivery stamp — see listPendingRows).
      //
      // This filter does exactly one thing, and it is not "deliver once": it
      // DROPS text the human replaced between the read above and the write here.
      // `markAnnotationDelivered` pins the version it was read at, so `false`
      // means the note is no longer what the human wrote — handing that over is
      // the harm, and the newer text stays queued for the next poll. A row that
      // was already delivered returns `true` and is handed over again on purpose.
      //
      // Two halves since #36 — the words and the "I did my part" mark — each
      // pinned to the version the read returned, and SHORT-CIRCUITED in that
      // order. If the annotation moved, the mark is left unstamped too, so a
      // dropped row is never half-recorded as delivered. (The reverse race
      // stamps the annotation on a row it then drops; the row is still blocked,
      // so the next poll carries both — at-least-once is what absorbs it.)
      const rows = listPendingRows(db, s.project).filter((r) => {
        if (r.annotation && !markAnnotationDelivered(db, r.row_id, r.annotated_at, s.agent)) return false
        if (r.handled_at && !markHandledDelivered(db, r.row_id, r.handled_at, s.agent)) return false
        return true
      })
      // issue #42 — at-least-once is about the HUMAN's words, not the agent's own
      // backstory. The annotation/reply comes back on every poll for as long as
      // #37 says it should; `context` is handed over on its first delivery out of
      // this PROCESS and reduced to `context_chars` after that. Shaped AFTER the
      // CAS filter above, so a row dropped for being stale is never recorded as
      // delivered.
      //
      // `full: true` is the recovery path for BOTH shapes, items included: the
      // ledger is per-process and a fan-out shares it, so an agent can hold a
      // `context_chars` for text a sibling consumed. Asking is always allowed and
      // always answered — that is what keeps the ledger an optimisation rather
      // than a delivery guarantee it cannot make.
      return {
        content: [{ type: 'text', text: JSON.stringify({
          items: items.map((it) => deliverContext(it, itemKey(it.id), ledger, { full })),
          rows: rows.map((r) => deliverContext(r, rowKey(r.row_id), ledger, { full })),
        }) }],
      }
    },
  )

  // issue #29 — the second answer channel. A question flagged here is the SAME
  // question you asked in chat, so an answer given out loud has to land on the
  // item too, or the human keeps seeing an open question they already settled.
  server.registerTool(
    'answer',
    {
      description:
        'Record an answer the HUMAN gave you in CHAT onto one of your open inbox questions, so the inbox stops showing it unanswered. This is NOT for answering your own question — if the question became moot, call resolve instead; writing an answer here removes the item from the human’s attention list, so inventing one hides a real question from them. id comes from flag’s return value or from pending. Returns {ok:true}, or {ok:false, reason} — reason "unread_inbox_answer" means they ALSO answered in the inbox and you have not read it: that answer is returned alongside the refusal and it wins, so follow it, and call pending() so the card stops telling them you are still waiting to read it. Other reasons: "empty" (no text), "not_found", "not_a_question", "not_open". Recording an answer is not resolving — once you have acted on it, call resolve.',
      inputSchema: { id: z.string(), text: z.string(), context: z.string().optional() },
    },
    async ({ id, text, context }) => {
      heartbeat()
      // no project scope check on purpose: an answering session's inferred project
      // can legitimately differ from the asking one (different cwd, subagent,
      // worktree), and losing the human's answer is worse than a cross-project
      // write only an id typo can cause. kind/status/precedence guard the rest.
      const out = answerItem(db, id, text, context)
      return { content: [{ type: 'text', text: JSON.stringify(out) }] }
    },
  )

  server.registerTool(
    'status',
    {
      description:
        'Ephemeral "what am I doing right now" for the human\'s live view — NOT for tasks (use boards) or attention (use flag). Call at meaningful PHASE changes only, not every step: starting a long effort, entering a new phase, fanning out subagents, wrapping up. children is a full-replace list of the subagents you are running ({name, doing, state?}) — resend the current set whenever it changes; the human can expand them under your entry. Times are stamped server-side; never call this just because time passed. Call with done:true when the effort ends — your entry reverts to an idle presence row. Your session stays listed for as long as it is running, but the CLAIM decays: after ~30 minutes with no MCP calls from you at all, "doing" reverts to open on its own, so a claim can never outlive the work. You do not need to keep it alive — just say what you are doing at your next real phase change, and it re-asserts instantly.',
      inputSchema: {
        doing: z.string().min(1).optional(),
        detail: z.string().optional(),
        children: z.array(z.object({ name: z.string().min(1), doing: z.string(), state: z.string().optional() })).max(32).optional(),
        done: z.boolean().optional(),
      },
    },
    async ({ doing, detail, children, done }) => {
      heartbeat()
      const s = scope.get(clientName())
      if (done) {
        // the effort is over but the session lives on — revert to open presence
        upsertActivity(db, { session: sessionId, project: s.project, stream: s.stream, agent: s.agent, doing: 'open', idle: true, children: [] })
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }
      }
      if (!doing) throw new Error('doing is required unless done: true')
      upsertActivity(db, { session: sessionId, project: s.project, stream: s.stream, agent: s.agent, doing, detail, children })
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }
    },
  )

  server.registerTool(
    'register',
    {
      description:
        'Override the auto-inferred project/stream for this session when detection is wrong. repo ("owner/name" on github.com) and issue (a number) override the source link the inbox shows beside your items — set issue when the branch name does not name it.',
      inputSchema: {
        project: z.string().optional(),
        stream: z.string().optional(),
        repo: z.string().optional(),
        issue: z.number().int().positive().optional(),
      },
    },
    async ({ project, stream, repo, issue }) => {
      heartbeat()
      scope.override({ project, stream, repo, issue })
      return { content: [{ type: 'text', text: JSON.stringify(scope.get(clientName())) }] }
    },
  )

  server.registerTool(
    'whoami',
    { description: 'Report this session’s current project/stream/agent scope.', inputSchema: {} },
    async () => {
      heartbeat()
      return { content: [{ type: 'text', text: JSON.stringify(scope.get(clientName())) }] }
    },
  )

  // Issue #44 — the six values are unchanged (they are in every existing DB, in
  // public/attention.js and in the CSS), but ONE of them is an escalation and
  // its name does not say so: "blocked" ordinarily means "blocked BY
  // something". The description rides on the FIELD, not just the tool, because
  // that is the text a model reads while filling in an enum — and the negative
  // example is the load-bearing half: the observed mistake was a row blocked on
  // a release candidate that did not exist yet, which no human could act on.
  const rowStatus = z
    .enum(['done', 'partial', 'missing', 'tracked', 'na', 'blocked'])
    .describe(
      'Row status. done|partial|missing|tracked|na are purely descriptive. blocked is the ONE that escalates: it means this row is waiting on the HUMAN and nobody else, and it sits in their attention banner until they answer it or mark that they have DONE it (pending() delivers both). Work stuck on something a person cannot unblock — a failing test, a build or release that does not exist yet, another PR, a long job — is `partial` (or `tracked`) with the reason in note, NEVER blocked. Moving a row OUT of blocked and later back INTO blocked is a NEW request and discards the human’s "I did my part" mark, so do it only when you really are asking for something else.',
    )

  server.registerTool(
    'board_upsert',
    {
      description:
        'Create or replace a tracking board (a titled table the human watches). Idempotent by title within this project — re-send the whole table to refresh it. Rows are matched by label; the human’s per-row notes survive, and a row you leave OUT is deleted (so keep labels stable). status: done|partial|missing|tracked|na|blocked — five of those merely describe the row; "blocked" is an ESCALATION meaning this row is waiting on the HUMAN and nobody else, and it sits in their attention banner until they answer. Being stuck is not being blocked: a failing test, a build or release that does not exist yet, another PR, a long job — none of those are things a person can unblock, so they are `partial` (or `tracked`) with the reason in note. note is the one-line summary; context is optional long-form backstory (reasoning, history) shown collapsed. Leaving `context` off a row KEEPS whatever is stored there — reads hand you `context_chars`, not the text, so omission can never mean delete; pass context:"" to clear it deliberately. Re-sending a row as "blocked" is NOT an acknowledgement of the human’s answer on it — you are still asserting you are blocked; act on what they left (pending() delivers it: an annotation, and/or `handled_at` meaning they went and DID the thing) and send a different status. Their annotation and their `handled_at` mark both survive every re-send of the whole table, so you can never wipe them by omission.',
      inputSchema: {
        title: z.string().min(1),
        rows: z.array(z.object({ label: z.string().min(1), status: rowStatus, note: z.string().optional(), context: z.string().optional() })),
      },
    },
    async ({ title, rows }) => {
      heartbeat()
      const s = scope.get(clientName())
      const out = upsertBoard(db, { project: s.project, stream: s.stream, agent: s.agent, title, rows, repo: s.repo, issueRef: s.issue })
      return { content: [{ type: 'text', text: JSON.stringify(out) }] }
    },
  )

  server.registerTool(
    'board_row',
    {
      description:
        'Update or add ONE row of a tracking board by label, without re-sending the whole table. Creates the board (and row) if missing; a new row defaults to status "tracked". Omitted status/note/context leave the existing value. context is optional long-form backstory shown collapsed. status "blocked" means the row needs the HUMAN and nobody else — it escalates into their attention banner, so put what you need from them in note. Use it for nothing else: work stuck on a failing test, on a build or release that does not exist yet, or on another PR is `partial` (or `tracked`) with the reason in note, because there is nothing there for a person to do. pending() delivers their answer — words (`annotation`), or `handled_at` meaning they have gone and DONE what you asked. FLIP THE ROW’S STATUS ONCE YOU HAVE ACTED — that status change is what tells them you did, and until it happens they keep seeing the row marked "delivered to you". Changing this row from a non-blocked status back to "blocked" counts as a fresh ask and clears their "I did my part" mark, so never do it as a way of nagging about the same thing.',
      inputSchema: { title: z.string().min(1), label: z.string().min(1), status: rowStatus.optional(), note: z.string().optional(), context: z.string().optional() },
    },
    async ({ title, label, status, note, context }) => {
      heartbeat()
      const s = scope.get(clientName())
      const out = updateBoardRow(db, { project: s.project, stream: s.stream, agent: s.agent, title, label, status, note, context, repo: s.repo, issueRef: s.issue })
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
      heartbeat()
      const s = scope.get(clientName())
      const board = findBoard(db, s.project, title)
      if (board) archiveBoard(db, board.id)
      return { content: [{ type: 'text', text: JSON.stringify({ ok: board !== undefined }) }] }
    },
  )

  server.registerTool(
    'board_get',
    {
      description:
        'Re-read a tracking board’s state before updating it. You do NOT need this to hear from the human — pending() delivers their per-row notes AND their `handled_at` marks ("I have done my part on this row"). Rows carry annotation_unseen: true on notes not yet delivered to any agent; reading marks the rows in the payload delivered, marks included. With a title: that board, rows and all. Without: a SUMMARY of your active boards in this project — titles, row labels, statuses, notes and the human’s annotations, no row context (and it delivers every annotation in the project at once, so prefer the titled form). Returns {found:false} if the titled board does not exist. The human’s annotation and `handled_at` mark are ALWAYS returned in full. Agent-authored row `context` is not: a row shows `context_chars` instead — its size as JS counts it (UTF-16 code units, so an emoji counts 2) — and `full: true` WITH a title returns the real text for that board. Ask for it whenever you actually need the backstory (most updates do not) — it is also how you recover context a sibling subagent’s poll consumed before you saw it. Re-sending a row through board_upsert WITHOUT its context keeps the stored text; it is not deleted by omission.',
      inputSchema: { title: z.string().optional(), full: z.boolean().optional() },
    },
    async ({ title, full }) => {
      heartbeat()
      const s = scope.get(clientName())
      // issue #37 — per-ROW delivery, exactly like pending(). markBoardRead still
      // records "an agent read this board", but it no longer marks any annotation
      // seen: board-level read-marking is what silenced rows the agent never
      // looked at. The payload is built BEFORE stamping on purpose, so this read
      // still reports annotation_unseen: true for what it is handing over.
      const deliver = (b: BoardWithRows): void => {
        for (const r of b.rows) {
          if (r.annotation && !r.annotation_seen_at) markAnnotationDelivered(db, r.id, r.annotated_at, s.agent)
          // #36 — the mark is delivered by this read too, or the human's card
          // would say "waiting for agent pickup" about something an agent is
          // holding in its hands right now.
          if (r.handled_at && !r.handled_seen_at) markHandledDelivered(db, r.id, r.handled_at, s.agent)
        }
        markBoardRead(db, b.id)
      }
      // issue #42 — the shape is decided AFTER delivery, never instead of it:
      // every annotation in the payload is stamped exactly as before, whichever
      // form was asked for. Only agent-authored `context` changes hands here.
      if (title === undefined) {
        const boards = listBoards(db).filter((b) => b.project === s.project)
        for (const b of boards) deliver(b)
        // "what are my boards" is a summary — naming a board is what buys rows
        // with their context, so `full` here is refused out loud rather than
        // silently ignored.
        const summary = boards.map(summariseBoard)
        const payload = full === true ? { boards: summary, full_requires_title: true } : { boards: summary }
        return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
      }
      const board = getBoard(db, s.project, title)
      if (board) deliver(board)
      return {
        content: [{ type: 'text', text: JSON.stringify(board ? shapeBoard(board, { full, ledger }) : { found: false }) }],
      }
    },
  )

  return server
}
