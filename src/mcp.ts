import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { insertItem, resolveItem, listPending, markReplySeen, markItemAnnotationDelivered, answerItem, upsertBoard, updateBoardRow, advanceBoardRow, findBoard, archiveBoard, getBoard, getBoardByTitle, listBoards, markBoardRead, markAnnotationDelivered, markHandledDelivered, listPendingRows, upsertActivity, endActivity, touchActivity, recordActivityCall, listIssueSnapshots, listSourceLinks } from './store.js'
import type { ActionOwner, BoardRow, BoardWithRows, IssueLink, QuestionOption } from './store.js'
import { makeContextLedger, deliverContext, shapeBoard, summariseBoard, rowKey, itemKey, agentItem } from './shape.js'
import type { BoardIssueRelations } from './shape.js'
import { issueRelations } from './issue-graph.js'
import { issueKey, issueKeyFor } from '../public/issue-key.js'
import { indexLinks, linkFor } from '../public/source.js'
import { makeScope } from './scope.js'
import { copilotWatchLaunch, rowWatchedAsk, watchStoppedForGood } from './watch.js'
import type { WatchedAsk } from './watch.js'
import { AGENT_INBOX_VERSION } from './version.js'
import { detectServerSource } from './server-source.js'

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

// Issue #103 PR2 (§10) — every accepted way to name an issue, normalized to
// `owner/name#N`. Anything else is refused with the list, never guessed.
const ISSUE_FORMS = 'owner/name#123; #123 or 123 (this session’s GitHub repository); https://github.com/owner/name/issues/123; or "" to clear'

function normalizeIssue(value: string, sessionRepo: string | null): IssueLink | null {
  if (value === '') return null
  const text = value.trim()
  const qualified = /^([\w.-]+\/[\w.-]+)#([1-9]\d{0,9})$/.exec(text)
    ?? /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d{0,9})\/?$/i.exec(text)
  const bare = /^#?([1-9]\d{0,9})$/.exec(text)
  let why = 'is not an issue reference'
  if (bare && !sessionRepo) why = 'needs a repository, and this session has no GitHub repository'
  const repo = qualified ? qualified[1]! : bare && sessionRepo ? sessionRepo : null
  const number = Number(qualified ? qualified[2] : bare?.[1])
  if (repo !== null) {
    if (issueKey(repo, number)) return { repo: repo.toLowerCase(), number }
    why = 'is not a valid GitHub issue'
  }
  throw new Error(`issue "${value}" ${why}. Accepted forms: ${ISSUE_FORMS}`)
}

export function buildMcpServer(db: Database.Database, cwd: string): McpServer {
  const server = new McpServer({ name: 'agent-inbox', version: AGENT_INBOX_VERSION })
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
  //
  // Issue #197: it also records which build this server runs — the version the
  // handshake reports, and whether it runs from an installed agent runtime or a
  // checkout (detected once, here) — so Live can say which sessions need a
  // restart and what would update each one. That rides on this existing write
  // and never counts as activity.
  const build = { server_version: AGENT_INBOX_VERSION, server_source: detectServerSource(import.meta.url) }
  // Issue #253 — and which process started this server. Claude Code starts a
  // stdio server and its hooks directly, so a hook finds the servers of its own
  // session by its parent pid; the server's own pid lets it check they still run.
  const host = () => ({ host_pid: process.ppid, server_pid: process.pid })
  const registerPresence = (): void => {
    try {
      const s = scope.get(clientName())
      upsertActivity(db, { session: sessionId, project: s.project, stream: s.stream, agent: s.agent, doing: 'open', idle: true, claim: false, ...build, ...host() })
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
  // Every handled signal exits through the one 'exit' handler above. SIGHUP is how
  // a closed terminal tab or window ends this process (#162): left at Node's default
  // disposition it kills the process without emitting 'exit', leaving a ghost Live
  // row and an open span. SIGKILL cannot be handled; the read-time caps cover it.
  for (const sig of ['SIGHUP', 'SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(0))

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
  // `ask` is passed only on a re-arm: it sizes the wait from how long that ask
  // has already waited (issue #217). A brand-new action starts at the base wait.
  const rowWatch = (row: Pick<BoardRow, 'id' | 'label' | 'action_version'>, project: string, ask?: WatchedAsk) => ({
    row_id: row.id,
    label: row.label,
    action_version: row.action_version,
    ...copilotWatchLaunch(row.id, { rowActionVersion: row.action_version, project, ask }),
  })
  const boardWatchDescription = ' Copilot: a new blocked action returns a host-owned watch (or watches for a full board). Immediately launch each returned shell_command as the specified detached background task; the MCP server never launches it. On completion follow on_completion, then acknowledge the response with a status change and outcome. Routine edits do not start another watch; use board_get({title, watch:true}) to re-arm after a timeout or session restart, and each re-arm of an unchanged ask waits longer. If the watcher says the human asked you to stop waiting, do not re-arm it.'

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
        'Raise an item for the human. Use kind="question" whenever you are about to STOP and WAIT on the human — a decision, a missing credential, an ambiguity you cannot resolve, or a recommendation / next step you are ending your turn on ("recommend X — go?", "want me to ...?", "say the word"). ONE ASK, ONE SURFACE: if an existing board row already represents this same dependency, set that row to blocked instead and DO NOT create a question item; use a question item only when no existing board row owns the ask. The test is not whether you are mid-conversation; it is whether your next move depends on their answer — such a moment left only in chat is invisible, so flag it. kind="note" = a non-blocking assumption/caveat/workaround; kind="done" = a finished milestone, used sparingly. A question must carry: title = the ask, detail = one-sentence TL;DR, next_step = ONE concrete human action, action_owner = decision (they choose) | task (they do it) | approval (they approve and the agent acts), impact = why it matters now, and optional next_after = what immediately follows. decision/approval requires 2-4 options (recommendation first); task must omit options. Put all history, reasoning, files, PRs and links in collapsed context. Copilot question responses include a `watch` launch contract: immediately run its `shell_command` as a detached background task using the returned values; on completion call pending() as its on_completion says. A timeout is not an answer: re-run the same command, which waits longer each time; if the human asked you to stop waiting, do not re-arm. One question, two channels: if the human answers in chat, record it with answer. project/stream/agent are inferred automatically.',
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
        // issue #157 — where the branch is pushed; only worth a git call when
        // there is a base repo to link against at all
        head_repo: s.repo ? scope.headFor(branch) : null,
        // issue #324 — the folder its repo-relative paths open against, read
        // live (worktrees and checkouts move); null when none is found
        repo_root: scope.rootFor(),
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
      description: 'Mark one of your own inbox items resolved once its work is complete or it became moot, not merely because you picked up an annotation. For ANY item with response/annotation history, pass expected_response_revision from the exact pending item or successful answer result you handled. Missing or stale revisions return ok:false (response_revision_required or response_changed): use pending({item_id:id}) to re-read the current open item, handle the correction, then retry with its revision. This also recovers informational feedback another reader already picked up and annotations the human cleared. Another caller reading new text never authorizes your older snapshot. Items with no response history can still be resolved without a revision. Include outcome as the one-line result so the human can see what happened.',
      inputSchema: {
        id: z.string(),
        outcome: z.string().max(240).optional(),
        expected_response_revision: z.number().int().nonnegative().optional()
          .describe('response_revision of the exact item response you handled, from pending or answer. Required after any reply or annotation history, including clears. Recover current state with pending({item_id:id}); never substitute a sibling’s revision without handling its response.'),
      },
    },
    async ({ id, outcome, expected_response_revision }) => {
      heartbeat()
      const result = resolveItem(db, id, outcome, { expectedRevision: expected_response_revision })
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    },
  )

  server.registerTool(
    'pending',
    {
      description:
        'Poll for human responses in this project — the ONE polling call. Returns {items, rows}. Items include open questions plus unpicked annotations on open notes/milestones. Informational feedback (including a clear: empty annotation with annotated_at) normally leaves this queue after pickup; it does not create human attention or auto-resolve the item. Use pending({item_id:id}) to re-read one current open item even after pickup, including its response_revision; this targeted read returns no board rows. Pickup means handed to a reader, not acted on by the intended session, and informational feedback has no new automatic host-wake guarantee. Questions reappear until resolve; blocked rows until status changes. Read reply_kind/annotation_kind: answer = act normally; clarify = rewrite the ask; decline = cancel and record an outcome. handled_at means the human completed their task; snoozed_until means they deferred it; pinned_at means they set it aside with no time: keep the ask open and do not re-ask; an answer still arrives through pending(). When the item itself is complete, resolve with outcome and expected_response_revision from the exact response handled; move a board row out of blocked with outcome, or use board_advance for its next human step. Changed snapshots are withheld rather than handing over superseded words. Human text is never trimmed. Agent context is handed over once per SERVER PROCESS, recoverable with pending({full:true}), pending({item_id:id,full:true}), or board_get({title, full:true}); context_chars counts UTF-16 code units.',
      inputSchema: {
        full: z.boolean().optional(),
        project: z.string().min(1).optional().describe('Read responses for this project without changing the session scope. Use the project in a watcher launch contract after a restart or scope change.'),
        item_id: z.string().min(1).optional().describe('Re-read this open item in the selected project, including already-picked-up or cleared annotation state and its response_revision. Returns no board rows; add full:true to recover its agent-authored context.'),
      },
    },
    async ({ full, project, item_id }) => {
      heartbeat()
      const s = scope.get(clientName())
      const responseProject = project ?? s.project
      const items = listPending(db, responseProject, { includeInformational: true, itemId: item_id })
        .filter((it) => it.kind === 'question'
          ? markReplySeen(db, it.id, it.replied_at, it.response_revision, s.agent)
          : markItemAnnotationDelivered(db, it.id, it.response_revision, s.agent))
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
      const rows = item_id === undefined ? listPendingRows(db, responseProject).filter((r) => {
        const version = { row: r.revision, board: r.board_revision }
        if ((r.annotation || r.annotation_kind) && !markAnnotationDelivered(db, r.row_id, r.annotated_at, s.agent, version)) return false
        if (r.handled_at && !markHandledDelivered(db, r.row_id, r.handled_at, s.agent, version)) return false
        return true
      }) : []
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
          items: items.map((it) => deliverContext(agentItem(it), itemKey(it.id), ledger, { full })),
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
        'Record an answer the HUMAN gave you in CHAT onto one of your open inbox questions, so the inbox stops showing it unanswered. This is NOT for answering your own question — if the question became moot, call resolve instead; writing an answer here removes the item from the human’s attention list, so inventing one hides a real question from them. id comes from flag’s return value or from pending. Returns {ok:true, response_revision}, or {ok:false, reason} — reason "unread_inbox_answer" means they ALSO answered in the inbox and you have not read it: that answer is returned alongside the refusal and it wins, so follow it, and call pending() so the card stops telling them you are still waiting to read it. Other reasons: "empty" (no text), "not_found", "not_a_question", "not_open". Recording an answer is not resolving — once you have acted on it, call resolve with expected_response_revision from this successful result or the pending response you handled.',
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
      // Both writes carry the build too (#197): if the day-old sweep removed this
      // row while the machine slept, the next status call recreates it whole.
      if (done) {
        // the effort is over but the session lives on — revert to open presence
        upsertActivity(db, { session: sessionId, project: s.project, stream: s.stream, agent: s.agent, doing: 'open', idle: true, children: [], ...build, ...host() })
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }
      }
      if (!doing) throw new Error('doing is required unless done: true')
      upsertActivity(db, { session: sessionId, project: s.project, stream: s.stream, agent: s.agent, doing, detail, children, ...build, ...host() })
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
  // Issue #103 §8 — a GitHub dependency is never a human blocker; slice 2 §3.3
  // says the same of another step of the plan (`waits_on`).
  const NOT_BLOCKED_BY_DEPENDENCY = 'Waiting on another GitHub issue (GitHub\'s \'blocked by\') or on another step (`waits_on`) is tracked or partial, never blocked.'
  const rowStatus = z
    .enum(['done', 'partial', 'missing', 'tracked', 'na', 'blocked'])
    .describe(
      'Row status. done|partial|missing|tracked|na are descriptive. blocked is the ONE escalation: waiting on the HUMAN and nobody else. A blocked row requires note, next_step, action_owner and impact; decision/approval requires 2-4 options, task omits options. The row is the ask — ONE ASK, ONE SURFACE, never a duplicate question item. Work stuck on a failing test, missing build, another PR or long job is partial/tracked, NEVER blocked. ' + NOT_BLOCKED_BY_DEPENDENCY + ' Moving into blocked is a NEW request and archives the prior action; use board_advance when deliberately chaining the same stable row.',
    )
  const issueField = (what: string) => z.string().max(300).describe(
    `${what} Accepted forms: ${ISSUE_FORMS}. Stored and echoed as owner/name#N. Omitted keeps the stored link; "" clears it. board_advance and a move into blocked keep it. A PR that closes several issues is never guessed: link explicitly. Agent Inbox never edits GitHub relationships; use gh issue edit.`,
  )
  const rowIssue = issueField('The GitHub issue this row tracks: its only issue link.')
  // Issue #103 slice 2 (§4) — the agent's own sequencing of steps within one
  // plan. The store refuses unknown labels and cycles with the reason.
  const rowWaitsOn = z.array(z.string().min(1)).max(20).describe(
    'Labels of other rows in this plan that this row waits on: at most 20 entries as sent; duplicates collapse and order does not matter. Omitted keeps the stored list; [] clears it. board_advance and a move into blocked keep it. Each label you add must name another row of this plan: a row cannot wait on itself, and a write that would make the plan’s waits_on circular is refused. A label whose row is later removed is kept and draws nothing until a row with that label returns. waits_on never makes a row blocked and never asks the human for anything, so it never reaches their attention: a row that only waits on another step is tracked or partial; blocked remains for a separate human action.',
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
        'Create or refresh a tracking board. Idempotent by title; rows match stable labels and omitted ROWS are deleted. Every existing board MUST carry board_version and every existing row MUST carry its current revision from board_get/pending; stale snapshots abort the whole write. blocked means waiting on the HUMAN and is itself the ask — ONE ASK, ONE SURFACE, never a duplicate question item. Every blocked row requires note (TL;DR), next_step, action_owner and impact; decision/approval requires 2-4 options, task omits options. A failing test, missing build, another PR or long job is partial/tracked, never blocked. context is collapsed background. Omitted agent fields preserve stored values; context:"", next_step:"" and options:[] clear deliberately. Routine re-sends never erase the human annotation or handled_at ("I did my part"). When acknowledging a response, move the row out of blocked and include outcome; when another human step follows, use board_advance. issue pins the plan to a GitHub issue, outranking its PR and branch issue; rows[].issue links a row. rows[].waits_on names the other rows of this plan a row waits on (omitted keeps, [] clears). ' + NOT_BLOCKED_BY_DEPENDENCY + boardWatchDescription,
      inputSchema: {
        title: z.string().min(1),
        board_version: z.number().int().positive().optional().describe('Required for an existing board; use revision from board_get.'),
        issue: issueField('Pins this plan to a GitHub issue (for example an umbrella issue), outranking its PR and branch issue.').optional(),
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
          issue: rowIssue.optional(),
          waits_on: rowWaitsOn.optional(),
        })).refine(
          (rows) => new Set(rows.map((row) => row.label)).size === rows.length,
          'row labels must be unique',
        ),
      },
    },
    async ({ title, board_version, issue, rows }) => {
      heartbeat()
      const s = scope.get(clientName())
      const issuePin = issue === undefined ? undefined : normalizeIssue(issue, s.repo)
      const linked = rows.map((row) => ({ ...row, issue: row.issue === undefined ? undefined : normalizeIssue(row.issue, s.repo) }))
      const existing = getBoardByTitle(db, s.project, title)
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
        rows: linked,
        expectedVersion: board_version,
        repo: s.repo,
        issueRef: s.issue,
        headRepo: s.repo ? scope.headFor(s.stream) : null,
        // issue #324 — a null (none found) keeps the plan's stored folder
        repoRoot: scope.rootFor(),
        issuePin,
        // issue #306 — this server's presence id, so the Dashboard puts the plan on its lane
        session: sessionId,
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
        'Update or add ONE board row by stable label. Existing rows require expected_revision from board_get/pending; a stale revision is refused. Omitted fields preserve the current value. blocked means the row needs the HUMAN and nobody else; it requires note, next_step, action_owner and impact. decision/approval requires 2-4 options; task omits options. The row is the ask — ONE ASK, ONE SURFACE, never a duplicate question item. A failing test, missing build or another PR is partial/tracked, not blocked. After pending delivers answer/clarify/decline/handled_at, either move the row out of blocked with outcome or use board_advance for the next human step. A nonblocked→blocked transition is a NEW request and archives the prior action. issue links the row to a GitHub issue; waits_on names the other rows of this plan it waits on. ' + NOT_BLOCKED_BY_DEPENDENCY + boardWatchDescription,
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
        issue: rowIssue.optional(),
        waits_on: rowWaitsOn.optional(),
      },
    },
    async ({ title, board_version, label, expected_revision, status, note, next_step, action_owner, impact, next_after, options, outcome, context, issue, waits_on }) => {
      heartbeat()
      const s = scope.get(clientName())
      const issueLink = issue === undefined ? undefined : normalizeIssue(issue, s.repo)
      const existingBoard = getBoardByTitle(db, s.project, title)
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
        issue: issueLink,
        waits_on,
        repo: s.repo,
        issueRef: s.issue,
        headRepo: s.repo ? scope.headFor(s.stream) : null,
        repoRoot: scope.rootFor(),
        session: sessionId,
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
        'Advance an existing board row into its NEXT human action without changing its stable label. Use this after the human answered/declined/requested clarification and more human work remains. It atomically archives the prior step (including their response and pickup state), clears the old response/snooze/outcome, increments action_version, and installs a fresh blocked action. board_version and expected_revision are required so a sibling agent cannot overwrite newer board, human or agent state. action_owner=task must omit options; decision/approval requires 2-4 options. The row keeps its GitHub issue link and waits_on. ' + NOT_BLOCKED_BY_DEPENDENCY + boardWatchDescription,
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
        agent: s.agent,
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

  // Issue #103 PR2 (§10) — issue_rel for a titled read, from the cache the
  // viewer's poller fills; this process never reaches GitHub. Only certain
  // identities, decided exactly as the viewer's chips decide them.
  const boardIssueRelations = (board: BoardWithRows): BoardIssueRelations | undefined => {
    const planLink = board.repo && board.issue_pin_number === null ? linkFor(indexLinks(listSourceLinks(db)), board) : null
    const plan = issueKeyFor(board, planLink)
    const rows = new Map<string, string>()
    for (const row of board.rows) {
      const identity = issueKeyFor(row, null)
      if (identity?.certain) rows.set(row.id, identity.key)
    }
    const keys = new Set(rows.values())
    if (plan?.certain) keys.add(plan.key)
    if (!keys.size) return undefined
    const rel = issueRelations(listIssueSnapshots(db), keys, Date.now())
    const byRow = new Map<string, NonNullable<BoardIssueRelations['plan']>>()
    for (const [id, key] of rows) {
      const found = rel.get(key)
      if (found) byRow.set(id, found)
    }
    return { plan: plan?.certain ? rel.get(plan.key) : undefined, rows: byRow }
  }

  server.registerTool(
    'board_get',
    {
      description:
        'Re-read a tracking board before updating it. pending() already delivers human responses/handled_at. With a title: full row state; without: a summary of active boards. Board revision protects full snapshots/archive state; row revision is the CAS token for board_row/board_advance; action_version numbers chained steps. history_count says prior steps exist but history text is viewer-only and never sent to agents. Human response fields are always returned. A response changed during the read triggers a fresh snapshot; if it keeps changing, retry the read after the tool error. Rows are never silently omitted from a board snapshot. Agent context is replaced by context_chars unless a titled read uses full: true (its size is UTF-16 code units, so an emoji counts 2). A titled read echoes each plan pin and row link as issue ("owner/name#N") and each row’s waits_on (the labels of the rows it waits on, as stored) when it has one, and, when the viewer has cached GitHub data, adds issue_rel: { key, parent?, children?: { total, done }, waits_on_issues?, unblocks?, checked_at, stale, unavailable } — keys and counts only, never titles. issue_rel.waits_on_issues holds GitHub issue keys: that issue’s OPEN blockers on GitHub ("blocked by"), sorted, at most 50; issue_rel.unblocks counts the open issues it blocks. Both appear only while GitHub’s dependency data for that issue is known and at most 7 days old, so their absence means unknown, never none. They are read-only and distinct from the row’s own writable waits_on step labels: never copy issue keys into waits_on, and a GitHub dependency is never a reason to mark a row blocked (waiting on another issue is tracked or partial).',
      inputSchema: {
        title: z.string().optional(),
        full: z.boolean().optional(),
        watch: z.boolean().optional().describe('Copilot only: with a title, return host-owned watches for this board’s blocked actions. Use to re-arm after a timeout or restart; each re-arm of an unchanged ask waits longer. A row whose watch the human stopped gets none. Do not launch a second copy of a watch already running.'),
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
      const deliver = (b: BoardWithRows): boolean => {
        for (const r of b.rows) {
          const version = { row: r.revision, board: b.revision }
          if ((r.annotation || r.annotation_kind) && !markAnnotationDelivered(db, r.id, r.annotated_at, s.agent, version)) return false
          if (r.handled_at && !markHandledDelivered(db, r.id, r.handled_at, s.agent, version)) return false
        }
        markBoardRead(db, b.id)
        return true
      }
      // issue #42 — the shape is decided AFTER delivery, never instead of it:
      // every annotation in the payload is stamped exactly as before, whichever
      // form was asked for. Only agent-authored `context` changes hands here.
      // Retry the WHOLE snapshot: dropping one stale row would make a later
      // full-board upsert delete it. Bound retries rather than waiting forever.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (title === undefined) {
          const boards = listBoards(db).filter((b) => b.project === s.project)
          if (!boards.every(deliver)) continue
          const summary = boards.map(summariseBoard)
          const payload = full === true ? { boards: summary, full_requires_title: true } : { boards: summary }
          return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
        }
        const board = getBoardByTitle(db, s.project, title)
        if (board && !deliver(board)) continue
        const watches = watch && board?.status === 'active'
          ? board.rows.filter((row) => row.status === 'blocked')
            .map((row) => ({ row, ask: rowWatchedAsk(row) }))
            .filter(({ ask }) => !watchStoppedForGood(ask))
            .map(({ row, ask }) => rowWatch(row, s.project, ask))
          : undefined
        const payload = board ? shapeBoard(board, { full, ledger, issues: boardIssueRelations(board) }) : { found: false }
        return {
          content: [{ type: 'text', text: JSON.stringify({ ...payload, ...(watches ? { watches } : {}) }) }],
        }
      }
      throw new Error('Board responses changed during the read; retry board_get before acting or updating.')
    },
  )

  return server
}
