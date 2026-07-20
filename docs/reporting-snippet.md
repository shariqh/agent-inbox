# Agent Inbox — reporting instructions (paste into global agent instructions)

You have an `agent-inbox` MCP server. Use it to surface things the human would
otherwise miss in the terminal firehose, and to keep standing status they can
watch live. project/stream/agent are inferred automatically.

## Flags (one-shot attention)

Call `flag` when:
- **`kind: "question"`** — you are about to pause and wait on the human: a decision,
  a missing credential, an ambiguity you cannot resolve yourself. One flag per real
  blocker; put the actual question in `title`, context in `detail`. When sensible answers
  exist, ALWAYS attach 2-4 `options` — your recommendation first with `recommended: true`,
  each with a short `label` and a `detail` explaining the tradeoff. The human can pick
  one, compare them, or answer in their own words. Then **poll `pending()`** between work
  steps: it returns your open questions with `reply` once answered (an option label or
  free text — follow it either way), and call `resolve` once you have acted on it. Do
  not park forever waiting in the terminal.
- **`kind: "note"`** — you made a notable **assumption**, took a **workaround**, hit a
  **caveat**, or left **tech debt** the human should know about but that does NOT block
  you. Do not flag routine progress or things visible in the diff.
- **`kind: "done"`** — a completed **milestone** worth announcing (shipped, merged,
  deployed). Use sparingly — it is NOT for routine progress.

Keep `title` to one short line (aim under ~80 chars); `detail` is the short visible
elaboration. **Always provide `context`** — the background a human returning cold needs
to act without asking you anything: what you were working on, why this came up, relevant
files/PRs/links. They may read the item hours later with zero memory of the task; it
renders as a collapsed dropdown, so length is fine. Do not flag more than the human
needs — a noisy inbox gets ignored. One `done` flag per shipped thing: re-flagging an
identical open milestone title is deduped, not stacked. If a question you raised
resolves itself before they answer, call `resolve` with its id.

**The end-of-turn rule:** asking in chat is fine while the human is actively conversing —
but if your turn would END on a question, flag it instead. A question in scrollback is
invisible to their banner, badge, and triage; a flagged one pings them and wakes you when
answered.

## Boards (standing status the human watches)

For a **multi-item effort** where the human would otherwise have to ask "what's the
status?" — a test-coverage matrix, a rollout/QA checklist, a migration's file list, a
review's findings — keep a **board** (a titled table of rows) instead of burying it in
prose. Do this **proactively**, without being asked:

- **`board_upsert({ title, rows })`** — create or refresh the WHOLE table (idempotent by
  title). Re-send the full table whenever status changes. Each row is
  `{ label, status, note?, context? }`, `status ∈ done | partial | missing | tracked | na | blocked`.
  `blocked` means the row needs the HUMAN — it escalates into their attention banner; put
  what you need in `note`, watch `board_get` for their annotation, then set a new status.
  Keep `label` stable — rows are matched by label, and the human's notes stick to the label.
  `note` is the one-line summary; put long-form backstory (reasoning, history, links) in
  `context` — the human sees it as a collapsed dropdown, so the row stays scannable.
- **`board_row({ title, label, status?, note?, context? })`** — flip a single row without
  resending all.
- **`board_get({ title? })`** — read a board back, **including the human's per-row notes**.
  Call it when you (re)start work on a tracked effort, and before updating a board, to
  pick up anything the human left for you — then act on it. This is how you see their input.
- **`board_archive({ title })`** — when the effort is finished.

Prefer updating an existing board (same title) over spawning new ones. One board per
effort; let it track from start to done. A board is the durable, always-current answer —
maintain it as the work moves, not just at the end.

## Subagents

When you delegate work to subagents whose pauses/assumptions/tracked status the human
would care about, pass these rules along in the subagent's instructions — subagents
don't inherit this file automatically in all harnesses.
