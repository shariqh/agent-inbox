# Agent Inbox — reporting instructions (paste into global agent instructions)

You have an `agent-inbox` MCP server. Use it to surface things the human would
otherwise miss in the terminal firehose, and to keep standing status they can
watch live. For customer-facing drafts, also use it as the review-before-send
source of truth. project/stream/agent are inferred automatically.

## Flags (one-shot attention)

Call `flag` when:
- **One ask, one surface.** If an existing tracking-board row already represents the
  dependency, set that row to `blocked` and do **not** create a question item for the same
  ask. Use a question item only when no board row already owns it.
- **`kind: "question"`** — you are about to pause and wait on the human: a decision,
  a missing credential, an ambiguity you cannot resolve yourself. One flag per real
  blocker; put the actual question in `title`, a one-sentence TL;DR in `detail`, the ONE
  concrete action the human should take in `next_step`, why it matters in `impact`,
  what happens after in `next_after`, and long background in `context`. Set
  `action_owner` to `decision` (they choose), `task` (they do it), or `approval`
  (they approve and you act). Start `next_step` with a verb and do not bundle multiple asks.
  `decision`/`approval` requires 2-4 answers; `task` has no options. When sensible answers
  exist, ALWAYS attach 2-4 `options` — your recommendation first with `recommended: true`,
  each with a short `label` and a `detail` explaining the tradeoff. The human can pick
  one, compare them, or answer in their own words. **Options now buy more than clarity:**
  they become one-click buttons on the desktop notification itself, so the human can answer
  without opening the app at all. A question with no options can only be answered by someone
  who stops what they are doing and goes to the inbox — so write `label`s that stand alone
  out of context, because that button may be the entire question they ever see. If a Copilot question flag returns a
  `watch` object, **immediately launch `watch.shell_command` as a detached async background
  command** using the returned `mode`, `detach`, `shell_id`, and `timeout_seconds`; do not
  wait for it synchronously. The background completion notification wakes your session when
  the answer lands. On that notification, call `pending()` immediately, act on the answer,
  and resolve the question. Clients without a returned watcher keep using their native wake
  path. Also **poll `pending()`** between work steps: it returns `{ items, rows }` — your open questions with `reply` once answered (an
  option label or free text — follow it either way), plus optional `reply_context` when they
  attach extra direction with their answer, **and `rows`: the human's per-row notes on your
  boards** (see Boards below). Act on both: call `resolve` after handling a question item,
  and move a board row out of `blocked` after handling its response. `pending()` is the ONE poll —
  everything they have said to you arrives through it. Do
  not park forever waiting in the terminal. If you end a turn with a Copilot question still
  open, the returned watcher must already be running; do not tell the human they need to
  message you again.
  **One question, two channels.** A flagged question IS the question you are asking in
  chat — never open a second, independent prompt for a decision you already flagged; point
  at the flag instead. If they answer you in chat, call `answer({ id, text, context? })` so
  the inbox stops showing it open and unread. If that comes back
  `{ ok:false, reason:"unread_inbox_answer" }` they also answered in the inbox and you have
  not read it — poll `pending()` and follow that one; the inbox wins.
  Read `reply_kind`: `clarify` means resolve this wording and raise a corrected replacement
  question; `decline` means stop/cancel the proposed path and resolve with an `outcome`.
  `snoozed_until` means the human deferred the ask; do not nag or treat it as an answer.
- **`kind: "note"`** — you made a notable **assumption**, took a **workaround**, hit a
  **caveat**, or left **tech debt** the human should know about but that does NOT block
  you. Do not flag routine progress or things visible in the diff.
- **`kind: "done"`** — a completed **milestone** worth announcing (shipped, merged,
  deployed). Use sparingly — it is NOT for routine progress.

**Keep every item glanceable.** Every flag has distinct fields: `title` is the ask or finding
itself in one line (aim under ~80 chars), `detail` is a one-sentence TL;DR of the current
state, `next_step` is the ONE concrete action the human should take now, `impact` says why
it matters, and `next_after` says what follows. Use
`next_step: "No action"` for a pure FYI or milestone. If you catch yourself writing a
paragraph into any of those fields, compress it and move the body into `context`.
Agent-authored long-form text supports paragraphs, explicit line breaks, simple `-`/`*`
bullets, `1.` numbered lists, and safe `http://`/`https://` autolinks. It does not render
general Markdown or raw HTML. Keep titles, TL;DRs, notes, and action fields short and
action-first; use that small structure for the reasoning and history in collapsed
`context`. Fenced command/code presentation remains a separate follow-up and must not be
assumed until that renderer ships.
**Always provide `context`** — the background a human returning cold needs
to act without asking you anything: what you were working on, why this came up, relevant
files/PRs/links. They may read the item hours later with zero memory of the task; it
renders as a collapsed dropdown, so length is fine. Do not flag more than the human
needs — a noisy inbox gets ignored. One `done` flag per shipped thing: re-flagging an
identical open milestone title is deduped, not stacked. If a question you raised
resolves itself before they answer, call `resolve` with its id.

**The end-of-turn rule — flag decisions, don't bury them.** The test is not "am I still
chatting?" — it's **"am I about to stop and wait on the human?"** If your next move depends
on their answer and you are ending your turn, that is a question — flag it, **even
mid-conversation, even if you just answered something.** This catches the case agents miss
most: you end on a **recommendation** to accept ("I'd do X"), a **next step awaiting
go-ahead** ("want me to…?", "say the word", "should I…?"), or you hand back a **decision**.
A recommendation in the last paragraph of a great analysis is invisible — no banner, no
badge, no triage, and it will not wake you when they answer; flagging it (with `options`)
does all three. Writing it in chat **and** flagging is right — the flag is what makes it
survive, so don't choose between them. *Example: you conclude "I'd add the tour row and
file the issue — go?" → `flag(kind:"question", title:"Add the feature-tour gate row + file
the --handbook issue?", options:[Do both (rec), Just the row, Just the issue, Not now])`.*

## Boards (standing status the human watches)

For a **multi-item effort** where the human would otherwise have to ask "what's the
status?" — a test-coverage matrix, a rollout/QA checklist, a migration's file list, a
review's findings — keep a **board** (a titled table of rows) instead of burying it in
prose. Do this **proactively**, without being asked:

- **`board_upsert({ title, rows })`** — create or refresh the WHOLE table (idempotent by
  title). Existing boards require `board_version`; re-send the full table whenever status
  changes. Each row is
  `{ label, status, revision?, note?, next_step?, action_owner?, impact?, next_after?, options?, outcome?, context? }`,
  `status ∈ done | partial | missing | tracked | na | blocked`.
  `blocked` means the row needs the HUMAN and nobody else — it escalates into their attention
  banner. Every blocked row MUST have `note` as a one-sentence TL;DR and `next_step` as
  the ONE concrete action the human can take now, plus `action_owner` and `impact`.
  Start it with a verb; split multiple asks into separate rows. If the blocker is a
  **decision/approval**, attach 2-4 `options` (recommendation first); if it is a **task**
  the human must perform, omit options so
  the viewer offers “I’ve done my part.” The blocked row is itself the ask:
  **one ask, one surface** — never also create a question item for that dependency.
  **Being stuck is not being blocked:** a failing
  test, a build or release that does not exist yet, another PR — no person can unblock those, so
  they are `partial` (or `tracked`) with the reason in `note`.
  `pending()` delivers their response kind too: `answer`, `clarify`, or `decline`.
  A row comes back as an `annotation` (words/choice), or `handled_at` — **the human telling you THEY have gone and
  DONE the thing** you blocked on. Both mean their part is finished; **flip the row's status
  once you have acted and include `outcome` — that status change/result tells them you did.**
  A clarification request is NOT a final answer: rewrite the same stable row with
  `board_advance({ board_version, expected_revision, ...fresh action fields })`. If their answer creates
  another human step, use `board_advance` again rather than stacking a second row. A decline
  normally becomes `na` with an outcome saying what was cancelled. Until you acknowledge, they
  see the row sitting there marked "delivered to you", which is exactly what it is — and
  `pending()` keeps handing you the same note on every poll, so nothing is lost when a
  sibling session polls first. `annotation_seen_at`/`annotation_seen_by` mean the note reached
  **some** agent — often a sibling session sharing your name, not you — so a stamp is never a
  reason to skip it. **If the row is still `blocked`, it is not done.** Act on it, then flip the
  status and it stops coming back. Moving a row out of `blocked` and later back into it is a
  NEW request and archives the previous step, so never do that just to nag about the same ask.
  Keep `label` stable — rows are matched by label, and the human's notes stick to the label.
  Every EXISTING row update must carry the current row `revision` from `board_get`/`pending`;
  a mismatch is a stale sibling and the write is refused.
  `note` is the TL;DR, `next_step` is the action, `impact` is why now, and `next_after`
  is the immediate follow-up; put long-form backstory (reasoning, history, links) in
  `context` — the human sees it as a collapsed dropdown, so the row stays scannable.
  Example decision row: `label: "#334 PR-X0 spec (#582)"`,
  `note: "The spec is settled and every review gate is green."`,
  `next_step: "Choose whether to merge PR #582."`,
  `action_owner: "approval"`, `impact: "Unblocks PR-X"`,
  `options: [Merge PR #582 (recommended), Hold]`; the six review rounds belong in `context`.
- **`board_row({ title, label, expected_revision, status?, ..., outcome? })`** — update one
  existing row; when acknowledging the human, move it out of `blocked` and record the result.
- **`board_advance({ title, label, board_version, expected_revision, ...fresh action })`** — atomically archive
  the prior step and reuse the same row for the next human action.
- **`board_get({ title? })`** — read a board back, **including the human's per-row notes**.
  Call it when you (re)start work on a tracked effort, and before updating a board. You do
  not need it to HEAR from them — `pending()` delivers their notes — so prefer the titled
  form; the title-less one summarises every board in the project at once.
  **Reads do not return `context`.** The human's `annotation` always comes back in full, but
  the `context` YOU wrote comes back as `context_chars` (its size) — you wrote it, so you are
  not charged to read it again. `board_get({ title, full: true })` returns the real text if you
  genuinely need it; `pending({ full: true })` does the same for items. `context_chars` is not
  proof you have the text, only that text exists. Row `revision` is the CAS token for writes;
  `action_version` numbers chained steps; `history_count` says prior steps exist without shipping them.
- **`board_archive({ title })`** — when the effort is finished.
  Existing boards require the current `board_version`.

Prefer updating an existing board (same title) over spawning new ones. One board per
effort; let it track from start to done. A board is the durable, always-current answer —
maintain it as the work moves, not just at the end.

## Draft review / approval loop

For customer-facing emails and other sendable copy, treat the board as the single
source of truth before anything is sent.

- Keep one stable board title for the active review queue, such as `Email draft review`.
- Use one row per draft/thread. Keep the row label stable, and put the draft's
  subject/customer/thread key in the label.
- Put the draft body, relevant context, and any open questions in the row `context`;
  use `note` for a one-sentence TL;DR and `next_step` for the exact approval/action needed.
- Set `status: tracked` while drafting, `blocked` when you need the human to decide
  something, and `done` once the final draft has been approved and sent.
- If a draft row already represents a concrete blocker, set that row to `blocked` and
  ask through the row only. If no board row owns the ask, raise a
  `flag({ kind: "question" })` with 2-4 options when possible. Never create both for the
  same dependency.
- Treat that flag as the ONE question across both channels. Poll `pending()` for an
  inbox answer; if the human answers in chat, record it with `answer({ id, text })`.
- Before sending, call `pending()` and re-read the titled board for full draft context.
  Do not rely on a separate chat thread or scattered notes as the approval record.

## Live status (ephemeral presence)

Your session appears in the human's Live view automatically (an idle presence row —
no action needed from you). For **long-running work** — especially multi-agent fan-outs
the human loses the mental model of — call `status({ doing, detail?, children?, done? })`
at meaningful **phase changes only** (never on a timer, never per step): starting a long effort, entering a new
phase, spawning or finishing subagents, wrapping up. `children` is a **full-replace**
list of your currently-running subagents (`{ name, doing, state? }`) — resend the current
set when it changes; the human sees them nested under your entry. Only the top-level
manager reports — subagents stay silent. Call `status({ done: true })` when the effort
ends; if your process dies instead, its entry drops out on its own within ~15 minutes, so
a crash never leaves a ghost. This is ambient glass for the human, not tracking — boards
remain the durable record.

**A claim goes quiet after ~30 minutes with no MCP call of any kind**, and your row reverts
to idle — otherwise a session that finished hours ago sits there advertising work it is no
longer doing. Your row does NOT disappear; only the claim does. This is still not a reason
to call `status` on a timer: any tool call keeps it fresh, so ordinary work holds it
automatically. It only bites on a genuinely silent stretch — a long build, a deep fan-out
where the children do the work — and the fix is a phase-change `status({ doing })` when you
come back up for air, which you should be sending anyway. Re-asserting is instant.

## Subagents

When you delegate work to subagents whose pauses/assumptions/tracked status the human
would care about, pass these rules along in the subagent's instructions — subagents
don't inherit this file automatically in all harnesses.
