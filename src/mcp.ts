import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { insertItem, resolveItem, listPending, markReplySeen, answerItem, upsertBoard, updateBoardRow, advanceBoardRow, findBoard, archiveBoard, getBoard, listBoards, markBoardRead, markAnnotationDelivered, markHandledDelivered, listPendingRows, upsertActivity, endActivity, touchActivity, recordActivityCall } from './store.js'
import type { ActionOwner, BoardRow, BoardWithRows, QuestionOption } from './store.js'
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
  const server = new McpServer({ name: 'agent-inbox', version: '1.2.3' })
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

  const responseOption = z.object({
    label: z.string().min(1),
    detail: z.string().optional(),
    recommended: z.boolean().optional(),
  })
  const actionOwner = z.enum(['decision', 'task', 'approval']).describe(
    'Who owns the human-facing action: decision = the human chooses; task = the human performs it; approval = the human approves and the agent acts.',
  )
  const impactField = z.string().max(180).describe('Why this matters now: the one downstream result or dependency this action unblocks.')
  const nextAfterField = z.string().max(180).describe('What happens immediately after the human responds or completes the task.')
  const summaryDescription = 'TL;DR: one sentence in plain language explaining what changed, what is not finished, or what needs a decision. Write for someone returning without the technical history. Example: "The release is ready, but still needs your approval." Put commit hashes, file paths, test counts, and technical terms such as CAS or converged in context, not the summary.'
  const rowWatch = (row: Pick<BoardRow, 'id' | 'label' | 'action_version'>, project: string) => ({
    row_id: row.id,
    label: row.label,
    action_version: row.action_version,
    ...copilotWatchLaunch(row.id, { rowActionVersion: row.action_version, project }),
  })
  const boardWatchDescription = ' Copilot: a new blocked action returns a host-owned watch (or watches for a full board). Immediately launch each returned shell_command as the specified detached background task; the MCP server never launches it. On completion follow on_completion, then acknowledge the response with a status change and outcome. Routine edits do not start another watch; use board_get({title, watch:true}) to re-arm after a timeout or session restart.'

  const requireActionShape = (
    label: string,
    owner: ActionOwner | null | undefined,
    impact: string,
    options: QuestionOption[] | null | undefined,
  ): void => {
    if (!owner || !impact.trim()) {
      throw new Error(`"${label}" requires action_owner and a one-line impact`)
    }
    const count = options?.length ?? 0
    if (owner === 'task' && count > 0) {
      throw new Error(`task "${label}" must omit options`)
    }
    if (owner !== 'task' && (count < 2 || count > 4)) {
      throw new Error(`${owner} "${label}" requires 2-4 options`)
    }
  }

  server.registerTool(
    'flag',
    {
      description:
        'Raise an item for the human. Use kind="question" whenever you are about to STOP and WAIT on the human — a decision, a missing credential, an ambiguity you cannot resolve, or a recommendation / next step you are ending your turn on ("recommend X — go?", "want me to ...?", "say the word"). ONE ASK, ONE SURFACE: if an existing board row already represents this same dependency, set that row to blocked instead and DO NOT create a question item; use a question item only when no existing board row owns the ask. The test is not whether you are mid-conversation; it is whether your next move depends on their answer — such a moment left only in chat is invisible, so flag it. kind="note" = a non-blocking assumption/caveat/workaround; kind="done" = a finished milestone, used sparingly. A question must carry: title = the ask, detail = one-sentence TL;DR, next_step = ONE concrete human action, action_owner = decision (they choose) | task (they do it) | approval (they approve and the agent acts), impact = why it matters now, and optional next_after = what immediately follows. decision/approval requires 2-4 options (recommendation first); task must omit options. Put all history, reasoning, files, PRs and links in collapsed context. Copilot question responses include a `watch` launch contract: immediately run its `shell_command` as a detached background task using the returned values; on completion call pending(). One question, two channels: if the human answers in chat, record it with answer. project/stream/agent are inferred automatically.',
      inputSchema: {
        kind: z.enum(['question', 'note', 'done']),
        title: z.string().min(1).max(120),
        detail: z.string().min(1).max(240).describe(summaryDescription),
        next_step: z.string().min(1).max(180).describe('The ONE concrete action the human should take now. Start with a verb; use "No action" for informational items.'),
        action_owner: actionOwner.optional(),
        impact: impactField.optional(),
        next_after: nextAfterField.optional(),
        context: z.string().optional(),
        stream: z.string().optional(),
        options: z
          .array(responseOption)
          .max(4)
          .optional(),
      },
    },
    async ({ kind, title, detail, next_step, action_owner, impact, next_after, context, stream, options }) => {
      heartbeat()
      if (kind === 'question') requireActionShape(title, action_owner, impact ?? '', options)
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
        next_step,
        action_owner,
        impact,
        next_after,
        context,
        options,
      })
      const result = kind === 'question' && s.agent === 'copilot'
        ? { id, watch: copilotWatchLaunch(id, { project: s.project }) }
        : { id }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    },
  )

  server.registerTool(
    'resolve',
    {
      description: 'Mark one of your own inbox items resolved once you acted on the human response or it became moot. Include outcome as the one-line result so the human can see what happened after their answer.',
      inputSchema: { id: z.string(), outcome: z.string().max(240).optional() },
    },
    async ({ id, outcome }) => {
      heartbeat()
      resolveItem(db, id, outcome)
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }
    },
  )

  server.registerTool(
    'pending',
    {
      description:
        'Poll for everything the human has said to you in this project — the ONE polling call. Returns {items, rows}. Read reply_kind/annotation_kind: answer = act normally; clarify = rewrite the ask (for a board use board_advance on the same label/version; for an item resolve and raise a corrected replacement); decline = stop/cancel the proposed path and acknowledge it with an outcome. handled_at means the human completed their task. snoozed_until means they deferred an unanswered ask; do not nag or treat it as an answer. After acting, resolve an item with outcome or move a row out of blocked with outcome. If another human step remains, use board_advance rather than stacking another row. Questions reappear until resolve; blocked rows reappear until status changes, so delivery stamps are never acknowledgements. Human words are always returned; agent context is handed over once per SERVER PROCESS and recoverable with pending({full:true}) or board_get({title, full:true}); context_chars uses UTF-16 code units.',
      inputSchema: {
        full: z.boolean().optional(),
        project: z.string().min(1).optional().describe('Read responses for this project without changing the session scope. Use the project in a watcher launch contract after a restart or scope change.'),
      },
    },
    async ({ full, project }) => {
      heartbeat()
      const s = scope.get(clientName())
      const responseProject = project ?? s.project
      const items = listPending(db, responseProject)
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
      const rows = listPendingRows(db, responseProject).filter((r) => {
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
      inputSchema: {
        id: z.string(),
        text: z.string(),
        context: z.string().optional(),
        kind: z.enum(['answer', 'clarify', 'decline']).optional(),
      },
    },
    async ({ id, text, context, kind }) => {
      heartbeat()
      // no project scope check on purpose: an answering session's inferred project
      // can legitimately differ from the asking one (different cwd, subagent,
      // worktree), and losing the human's answer is worse than a cross-project
      // write only an id typo can cause. kind/status/precedence guard the rest.
      const out = answerItem(db, id, text, context, kind)
      return { content: [{ type: 'text', text: JSON.stringify(out) }] }
    },
  )

  server.registerTool(
    'status',
    {
      description:
        'Ephemeral "what am I doing right now" for the human\'s live view — NOT for tasks (use boards) or attention (use flag). Call at meaningful PHASE changes only, not every step: starting a long effort, entering a new phase, fanning out subagents, wrapping up. children is a full-replace list of the subagents you are running ({name, doing, state?}) — resend the current set whenever it changes; the human can expand them under your entry. Times are stamped server-side; never call this just because time passed. Call with done:true when the effort ends — your entry reverts to an idle presence row. Your session stays listed for as long as it is running, but the CLAIM decays: after ~30 minutes with no MCP calls from you at all, "doing" reverts to open on its own, so a claim can never outlive the work. You do not need to keep it alive — just say what you are doing at your next real phase change, and it re-asserts instantly.',
      inputSchema: {
        doing: z.string().min(1).optional().describe('A short, recognizable task name in plain language, such as "Fixing missed Inbox replies". Report actual work, not a PR hash or a review transcript.'),
        detail: z.string().optional().describe('One sentence about the current step or what remains. This is a self-reported update, not automatic tracking of every agent.'),
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
      registerPresence()
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
      'Row status. done|partial|missing|tracked|na are descriptive. blocked is the ONE escalation: waiting on the HUMAN and nobody else. A blocked row requires note, next_step, action_owner and impact; decision/approval requires 2-4 options, task omits options. The row is the ask — ONE ASK, ONE SURFACE, never a duplicate question item. Work stuck on a failing test, missing build, another PR or long job is partial/tracked, NEVER blocked. Moving into blocked is a NEW request and archives the prior action; use board_advance when deliberately chaining the same stable row.',
    )
  const rowNote = z.string().max(240).describe(summaryDescription)
  const rowNextStep = z.string().max(180).describe('The ONE concrete action the human should take now. Required and non-empty when status is blocked.')
  const rowOptions = z.array(responseOption).max(4)
    .refine((options) => options.length === 0 || options.length >= 2, 'options must be empty or contain 2-4 choices')
    .describe('For a decision-shaped blocked row, 2-4 direct choices; put the recommended choice first with recommended:true. Omit for a task the human must perform.')

  const requireBlockedShape = (
    label: string,
    status: string,
    note: string,
    nextStep: string,
    owner: ActionOwner | null | undefined,
    impact: string,
    options: QuestionOption[] | null | undefined,
  ): void => {
    if (status !== 'blocked') return
    if (!note.trim() || !nextStep.trim()) {
      throw new Error(`blocked row "${label}" requires a one-sentence note (TL;DR) and one concrete next_step`)
    }
    requireActionShape(label, owner, impact, options)
  }

  server.registerTool(
    'board_upsert',
    {
      description:
        'Create or refresh a tracking board. Idempotent by title; rows match stable labels and omitted ROWS are deleted. Every existing board MUST carry board_version and every existing row MUST carry its current revision from board_get/pending; stale snapshots abort the whole write. blocked means waiting on the HUMAN and is itself the ask — ONE ASK, ONE SURFACE, never a duplicate question item. Every blocked row requires note (TL;DR), next_step, action_owner and impact; decision/approval requires 2-4 options, task omits options. A failing test, missing build, another PR or long job is partial/tracked, never blocked. context is collapsed background. Omitted agent fields preserve stored values; context:"", next_step:"" and options:[] clear deliberately. Routine re-sends never erase the human annotation or handled_at ("I did my part"). When acknowledging a response, move the row out of blocked and include outcome; when another human step follows, use board_advance.' + boardWatchDescription,
      inputSchema: {
        title: z.string().min(1),
        board_version: z.number().int().positive().optional().describe('Required for an existing board; use revision from board_get.'),
        rows: z.array(z.object({
          label: z.string().min(1),
          status: rowStatus,
          revision: z.number().int().positive().optional().describe('Required for every existing row; use the row revision from board_get/pending.'),
          note: rowNote.optional(),
          next_step: rowNextStep.optional(),
          action_owner: actionOwner.optional(),
          impact: impactField.optional(),
          next_after: nextAfterField.optional(),
          options: rowOptions.optional(),
          outcome: z.string().max(240).optional(),
          context: z.string().optional(),
        })).refine(
          (rows) => new Set(rows.map((row) => row.label)).size === rows.length,
          'row labels must be unique',
        ),
      },
    },
    async ({ title, board_version, rows }) => {
      heartbeat()
      const s = scope.get(clientName())
      const existing = getBoard(db, s.project, title)
        ?? listBoards(db, { status: 'archived' }).find((board) => board.project === s.project && board.title === title)
      if (existing && board_version === undefined) {
        throw new Error(`existing board "${title}" requires board_version ${existing.revision}`)
      }
      const newActions = new Map<string, number>()
      for (const row of rows) {
        const previous = existing?.rows.find((candidate) => candidate.label === row.label)
        if (previous && row.revision === undefined) {
          throw new Error(`existing row "${row.label}" requires revision ${previous.revision}`)
        }
        const newAsk = row.status === 'blocked' && previous?.status !== 'blocked'
        if (newAsk) newActions.set(row.label, (previous?.action_version ?? 0) + 1)
        requireBlockedShape(
          row.label,
          row.status,
          row.note ?? (newAsk ? '' : previous?.note ?? ''),
          row.next_step ?? (newAsk ? '' : previous?.next_step ?? ''),
          row.action_owner ?? (newAsk ? null : previous?.action_owner),
          row.impact ?? (newAsk ? '' : previous?.impact ?? ''),
          row.options ?? (newAsk ? null : previous?.options),
        )
      }
      const out = upsertBoard(db, {
        project: s.project,
        stream: s.stream,
        agent: s.agent,
        title,
        rows,
        expectedVersion: board_version,
        repo: s.repo,
        issueRef: s.issue,
      })
      const watches = s.agent === 'copilot' && newActions.size
        ? getBoard(db, s.project, title)?.rows
          .filter((row) => row.status === 'blocked' && newActions.get(row.label) === row.action_version)
          .map((row) => rowWatch(row, s.project)) ?? []
        : []
      return { content: [{ type: 'text', text: JSON.stringify({
        ...out, ...(watches.length ? { watches } : {}),
      }) }] }
    },
  )

  server.registerTool(
    'board_row',
    {
      description:
        'Update or add ONE board row by stable label. Existing rows require expected_revision from board_get/pending; a stale revision is refused. Omitted fields preserve the current value. blocked means the row needs the HUMAN and nobody else; it requires note, next_step, action_owner and impact. decision/approval requires 2-4 options; task omits options. The row is the ask — ONE ASK, ONE SURFACE, never a duplicate question item. A failing test, missing build or another PR is partial/tracked, not blocked. After pending delivers answer/clarify/decline/handled_at, either move the row out of blocked with outcome or use board_advance for the next human step. A nonblocked→blocked transition is a NEW request and archives the prior action.' + boardWatchDescription,
      inputSchema: {
        title: z.string().min(1),
        board_version: z.number().int().positive().optional().describe('Required when the board already exists; use revision from board_get.'),
        label: z.string().min(1),
        expected_revision: z.number().int().positive().optional().describe('Required when the row already exists; use revision from board_get/pending.'),
        status: rowStatus.optional(),
        note: rowNote.optional(),
        next_step: rowNextStep.optional(),
        action_owner: actionOwner.optional(),
        impact: impactField.optional(),
        next_after: nextAfterField.optional(),
        options: rowOptions.optional(),
        outcome: z.string().max(240).optional(),
        context: z.string().optional(),
      },
    },
    async ({ title, board_version, label, expected_revision, status, note, next_step, action_owner, impact, next_after, options, outcome, context }) => {
      heartbeat()
      const s = scope.get(clientName())
      const existingBoard = getBoard(db, s.project, title)
        ?? listBoards(db, { status: 'archived' }).find((board) => board.project === s.project && board.title === title)
      const existing = existingBoard?.rows.find((row) => row.label === label)
      if (existingBoard && board_version === undefined) {
        throw new Error(`existing board "${title}" requires board_version ${existingBoard.revision}`)
      }
      const nextStatus = status ?? existing?.status ?? 'tracked'
      if (existing && expected_revision === undefined) {
        throw new Error(`existing row "${label}" requires expected_revision ${existing.revision}`)
      }
      const newAsk = nextStatus === 'blocked' && existing?.status !== 'blocked'
      requireBlockedShape(
        label,
        nextStatus,
        note ?? (newAsk ? '' : existing?.note ?? ''),
        next_step ?? (newAsk ? '' : existing?.next_step ?? ''),
        action_owner ?? (newAsk ? null : existing?.action_owner),
        impact ?? (newAsk ? '' : existing?.impact ?? ''),
        options ?? (newAsk ? null : existing?.options),
      )
      const out = updateBoardRow(db, {
        project: s.project,
        stream: s.stream,
        agent: s.agent,
        title,
        label,
        expectedBoardVersion: board_version,
        expectedRevision: expected_revision,
        status,
        note,
        next_step,
        action_owner,
        impact,
        next_after,
        options,
        outcome,
        context,
        repo: s.repo,
        issueRef: s.issue,
      })
      const watch = s.agent === 'copilot' && newAsk
        ? rowWatch({ id: out.rowId, label, action_version: (existing?.action_version ?? 0) + 1 }, s.project)
        : undefined
      return { content: [{ type: 'text', text: JSON.stringify({ ...out, watch }) }] }
    },
  )

  server.registerTool(
    'board_advance',
    {
      description:
        'Advance an existing board row into its NEXT human action without changing its stable label. Use this after the human answered/declined/requested clarification and more human work remains. It atomically archives the prior step (including their response and pickup state), clears the old response/snooze/outcome, increments action_version, and installs a fresh blocked action. board_version and expected_revision are required so a sibling agent cannot overwrite newer board, human or agent state. action_owner=task must omit options; decision/approval requires 2-4 options.' + boardWatchDescription,
      inputSchema: {
        title: z.string().min(1),
        label: z.string().min(1),
        board_version: z.number().int().positive(),
        expected_revision: z.number().int().positive(),
        note: rowNote,
        next_step: rowNextStep,
        action_owner: actionOwner,
        impact: impactField,
        next_after: nextAfterField.optional(),
        options: rowOptions.optional(),
        context: z.string().optional(),
      },
    },
    async ({ title, label, board_version, expected_revision, note, next_step, action_owner, impact, next_after, options, context }) => {
      heartbeat()
      requireBlockedShape(label, 'blocked', note, next_step, action_owner, impact, options)
      const s = scope.get(clientName())
      const previous = getBoard(db, s.project, title)?.rows.find((row) => row.label === label)
      const out = advanceBoardRow(db, {
        project: s.project,
        title,
        label,
        expectedBoardVersion: board_version,
        expectedRevision: expected_revision,
        note,
        next_step,
        action_owner,
        impact,
        next_after,
        options,
        context,
      })
      const watch = s.agent === 'copilot' && previous && out.ok
        ? rowWatch({ ...previous, action_version: out.action_version }, s.project)
        : undefined
      return { content: [{ type: 'text', text: JSON.stringify({ ...out, watch }) }] }
    },
  )

  server.registerTool(
    'board_archive',
    {
      description: 'Archive a finished tracking board so it drops off the human’s active view. Resolved by title within this project.',
      inputSchema: { title: z.string().min(1), board_version: z.number().int().positive() },
    },
    async ({ title, board_version }) => {
      heartbeat()
      const s = scope.get(clientName())
      const board = findBoard(db, s.project, title)
      const ok = board ? archiveBoard(db, board.id, board_version) : false
      return { content: [{ type: 'text', text: JSON.stringify({ ok }) }] }
    },
  )

  server.registerTool(
    'board_get',
    {
      description:
        'Re-read a tracking board before updating it. pending() already delivers human responses/handled_at. With a title: full row state; without: a summary of active boards. Board revision protects full snapshots/archive state; row revision is the CAS token for board_row/board_advance; action_version numbers chained steps. history_count says prior steps exist but history text is viewer-only and never sent to agents. Human response fields are always returned. Agent context is replaced by context_chars unless a titled read uses full: true (its size is UTF-16 code units, so an emoji counts 2).',
      inputSchema: {
        title: z.string().optional(),
        full: z.boolean().optional(),
        watch: z.boolean().optional().describe('Copilot only: with a title, return host-owned watches for this board’s blocked actions. Use to re-arm after a timeout or restart; do not launch a second copy of a watch already running.'),
      },
    },
    async ({ title, full, watch }) => {
      heartbeat()
      const s = scope.get(clientName())
      if (watch && (title === undefined || s.agent !== 'copilot')) {
        throw new Error('watch requires a board title and a Copilot client; other hosts use their hook adapter')
      }
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
        ?? listBoards(db, { status: 'archived' }).find((candidate) => candidate.project === s.project && candidate.title === title)
      if (board) deliver(board)
      const watches = watch && board?.status === 'active'
        ? board.rows.filter((row) => row.status === 'blocked').map((row) => rowWatch(row, s.project))
        : undefined
      const payload = board ? shapeBoard(board, { full, ledger }) : { found: false }
      return {
        content: [{ type: 'text', text: JSON.stringify({ ...payload, ...(watches ? { watches } : {}) }) }],
      }
    },
  )

  return server
}
