import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { insertItem, resolveItem, listPending, markReplySeen, answerItem, upsertBoard, updateBoardRow, findBoard, archiveBoard, getBoard, listBoards, markBoardRead, upsertActivity, endActivity, touchActivity } from './store.js'
import { makeScope } from './scope.js'

export function buildMcpServer(db: Database.Database, cwd: string): McpServer {
  const server = new McpServer({ name: 'agent-inbox', version: '0.1.0' })
  const scope = makeScope(cwd)
  const clientName = (): string | undefined => server.server.getClientVersion()?.name
  // this stdio server lives exactly as long as its agent session — its own id
  // IS the session id for the live-activity view
  const sessionId = randomUUID()

  // ── session presence (issue #28): the session itself is a Live row ──
  // Registered after the initialize handshake (clientInfo is only populated
  // then), heartbeated by the server so an idle session never goes stale,
  // upgraded/reverted by the status tool, ended when this process exits.
  const registerPresence = (): void => {
    try {
      const s = scope.get(clientName())
      upsertActivity(db, { session: sessionId, project: s.project, stream: s.stream, agent: s.agent, doing: 'open', idle: true })
    } catch { /* presence must never break the server */ }
  }

  // every tool call is proof of life — the freshness dot in the viewer's
  // open-sessions fold turns green for a session that's actively conversing
  const heartbeat = (): void => {
    try { touchActivity(db, sessionId) } catch { /* ignore */ }
  }
  server.server.oninitialized = registerPresence
  setTimeout(registerPresence, 2000).unref() // fallback if no initialized notification arrives
  setInterval(() => {
    try { touchActivity(db, sessionId) } catch { /* ignore */ }
  }, 5 * 60000).unref()
  process.on('exit', () => {
    try { endActivity(db, sessionId) } catch { /* ignore */ }
  })
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(0))

  server.registerTool(
    'flag',
    {
      description:
        'Raise an item for the human. Use kind="question" whenever you are about to STOP and WAIT on the human — a decision, a missing credential, an ambiguity you cannot resolve, or a recommendation / next step you are ending your turn on ("recommend X — go?", "want me to ...?", "say the word"). The test is not whether you are mid-conversation; it is whether your next move depends on their answer — such a moment left only in chat is invisible, so flag it (a recommendation in your last paragraph does NOT reach them). kind="note" = a non-blocking assumption, caveat, or workaround they should see; kind="done" = a finished milestone (shipped / merged / deployed), used sparingly, NOT routine progress. Keep it glanceable: title is the ask or finding itself in one line (aim under ~80 chars), detail is ONE line (the why or impact), and everything long — background, files/PRs/links, the context a cold reader needs — goes in context, which renders collapsed so length there is free. For a question, ALWAYS include 2-4 options when the answer has discernible choices: your recommendation first with recommended:true, each a short label plus a detail explaining the tradeoff; the human can pick one, compare them, or answer freely. After flagging a question, poll the pending tool for the reply. One question, two channels: never ask the same decision twice in two places — if the human answers you in chat rather than on the card, record it with the answer tool so the inbox converges. project/stream/agent are inferred automatically.',
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
      heartbeat()
      resolveItem(db, id)
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }
    },
  )

  server.registerTool(
    'pending',
    {
      description:
        'Poll for the human’s answers to your open questions in this project. Returns every open question with its reply (null until the human answers — reply may be one of your options or their own free-text direction; follow it either way) and optional reply_context for extra instructions. Fetching a replied question marks it picked-up, so the human sees you got it. When you have acted on a reply, call resolve on that item. Poll between work steps rather than blocking. If the human answered you in chat instead, record it with the answer tool — but an inbox reply you have not picked up here always wins over one given in chat.',
      inputSchema: {},
    },
    async () => {
      heartbeat()
      const s = scope.get(clientName())
      const items = listPending(db, s.project)
      for (const it of items) if (it.reply && !it.reply_seen_at) markReplySeen(db, it.id)
      return { content: [{ type: 'text', text: JSON.stringify({ items }) }] }
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
        'Ephemeral "what am I doing right now" for the human\'s live view — NOT for tasks (use boards) or attention (use flag). Call at meaningful PHASE changes only, not every step: starting a long effort, entering a new phase, fanning out subagents, wrapping up. children is a full-replace list of the subagents you are running ({name, doing, state?}) — resend the current set whenever it changes; the human can expand them under your entry. Times are stamped server-side; never call this just because time passed. Call with done:true when the effort ends — your entry disappears. Entries silently expire if not updated for ~15 minutes.',
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

  const rowStatus = z.enum(['done', 'partial', 'missing', 'tracked', 'na', 'blocked'])

  server.registerTool(
    'board_upsert',
    {
      description:
        'Create or replace a tracking board (a titled table the human watches). Idempotent by title within this project — re-send the whole table to refresh it. Rows are matched by label; the human’s per-row notes survive. status: done|partial|missing|tracked|na. note is the one-line summary; context is optional long-form backstory (reasoning, history) shown collapsed.',
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
        'Update or add ONE row of a tracking board by label, without re-sending the whole table. Creates the board (and row) if missing; a new row defaults to status "tracked". Omitted status/note/context leave the existing value. context is optional long-form backstory shown collapsed. status "blocked" means the row needs the HUMAN — it escalates into their attention banner; put what you need in note, then watch board_get for their annotation and set a new status once unblocked.',
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
        'Read a tracking board back, INCLUDING the human’s per-row notes (annotations). Call this to see whether the human left you any notes, or to re-read a board’s state before updating it. Rows carry annotation_unseen: true on annotations written since your last read — act on those. Reading marks the board read. With a title: that board. Without: all your active boards in this project. Returns {found:false} if the titled board does not exist.',
      inputSchema: { title: z.string().optional() },
    },
    async ({ title }) => {
      heartbeat()
      const s = scope.get(clientName())
      if (title === undefined) {
        const boards = listBoards(db).filter((b) => b.project === s.project)
        for (const b of boards) markBoardRead(db, b.id)
        return { content: [{ type: 'text', text: JSON.stringify({ boards }) }] }
      }
      const board = getBoard(db, s.project, title)
      if (board) markBoardRead(db, board.id)
      return { content: [{ type: 'text', text: JSON.stringify(board ?? { found: false }) }] }
    },
  )

  return server
}
