# Agent Inbox — reporting instructions (paste into global agent instructions)

You have an `agent-inbox` MCP server. Use it to surface things the human would
otherwise miss in the terminal firehose, and to keep standing status they can
watch live. project/stream/agent are inferred automatically.

## Flags (one-shot attention)

Call `flag` when:
- **`kind: "question"`** — you are about to pause and wait on the human: a decision,
  a missing credential, an ambiguity you cannot resolve yourself. One flag per real
  blocker; put the actual question in `title`, a one-line why in `detail`, long background in
`context`. When sensible answers
  exist, ALWAYS attach 2-4 `options` — your recommendation first with `recommended: true`,
  each with a short `label` and a `detail` explaining the tradeoff. The human can pick
  one, compare them, or answer in their own words. Then **poll `pending()`** between work
  steps: it returns `{ items, rows }` — your open questions with `reply` once answered (an
  option label or free text — follow it either way), plus optional `reply_context` when they
  attach extra direction with their answer, **and `rows`: the human's per-row notes on your
  boards** (see Boards below). Act on both, then call `resolve`. `pending()` is the ONE poll —
  everything they have said to you arrives through it. Do
  not park forever waiting in the terminal. If you end a turn with a question still
  open, say so in chat ("I'll pick your answer up next time you message me") and call
  `pending()` first thing on your next turn, so they know the contract.
  **One question, two channels.** A flagged question IS the question you are asking in
  chat — never open a second, independent prompt for a decision you already flagged; point
  at the flag instead. If they answer you in chat, call `answer({ id, text, context? })` so
  the inbox stops showing it open and unread. If that comes back
  `{ ok:false, reason:"unread_inbox_answer" }` they also answered in the inbox and you have
  not read it — poll `pending()` and follow that one; the inbox wins.
- **`kind: "note"`** — you made a notable **assumption**, took a **workaround**, hit a
  **caveat**, or left **tech debt** the human should know about but that does NOT block
  you. Do not flag routine progress or things visible in the diff.
- **`kind: "done"`** — a completed **milestone** worth announcing (shipped, merged,
  deployed). Use sparingly — it is NOT for routine progress.

**Keep every item glanceable.** `title` is the ask or finding itself in one line (aim
under ~80 chars) — not a preamble; `detail` is *one* line (the why, the impact, or what
happens next). If you catch yourself writing a paragraph into `title` or `detail`, compress
the headline and move the body into `context` — the viewer ranks `title` first, so prose in
`detail` buries the signal. **Always provide `context`** — the background a human returning cold needs
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
  title). Re-send the full table whenever status changes. Each row is
  `{ label, status, note?, context? }`, `status ∈ done | partial | missing | tracked | na | blocked`.
  `blocked` means the row needs the HUMAN and nobody else — it escalates into their attention
  banner; put what you need from them in `note`. **Being stuck is not being blocked:** a failing
  test, a build or release that does not exist yet, another PR — no person can unblock those, so
  they are `partial` (or `tracked`) with the reason in `note`.
  `pending()` delivers their annotation; **flip the row's status
  once you have acted — that status change is what tells them you did.** Until you do, they
  see the row sitting there marked "delivered to you", which is exactly what it is — and
  `pending()` keeps handing you the same note on every poll, so nothing is lost when a
  sibling session polls first. `annotation_seen_at`/`annotation_seen_by` mean the note reached
  **some** agent — often a sibling session sharing your name, not you — so a stamp is never a
  reason to skip it. **If the row is still `blocked`, it is not done.** Act on it, then flip the
  status and it stops coming back.
  Keep `label` stable — rows are matched by label, and the human's notes stick to the label.
  `note` is the one-line summary; put long-form backstory (reasoning, history, links) in
  `context` — the human sees it as a collapsed dropdown, so the row stays scannable.
- **`board_row({ title, label, status?, note?, context? })`** — flip a single row without
  resending all.
- **`board_get({ title? })`** — read a board back, **including the human's per-row notes**.
  Call it when you (re)start work on a tracked effort, and before updating a board. You do
  not need it to HEAR from them — `pending()` delivers their notes — so prefer the titled
  form; the title-less one reads every board in the project at once.
- **`board_archive({ title })`** — when the effort is finished.

Prefer updating an existing board (same title) over spawning new ones. One board per
effort; let it track from start to done. A board is the durable, always-current answer —
maintain it as the work moves, not just at the end.

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

## Subagents

When you delegate work to subagents whose pauses/assumptions/tracked status the human
would care about, pass these rules along in the subagent's instructions — subagents
don't inherit this file automatically in all harnesses.
