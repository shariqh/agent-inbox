# Agent Inbox — reporting instructions (paste into global agent instructions)

You have an `agent-inbox` MCP server. Use it to surface things the human would
otherwise miss in the terminal firehose, and to keep standing status they can
watch live. project/stream/agent are inferred automatically.

## Flags (one-shot attention)

Call `flag` when:
- **`kind: "question"`** — you are about to pause and wait on the human: a decision,
  a missing credential, an ambiguity you cannot resolve yourself. One flag per real
  blocker; put the actual question in `title`, options/context in `detail`.
- **`kind: "note"`** — you made a notable **assumption**, took a **workaround**, hit a
  **caveat**, or left **tech debt** the human should know about but that does NOT block
  you. Do not flag routine progress or things visible in the diff.

Keep `title` to one line. Do not flag more than the human needs — a noisy inbox gets
ignored. If a question you raised resolves itself before they answer, call `resolve`
with its id.

## Boards (standing status the human watches)

For a **multi-item effort** where the human would otherwise have to ask "what's the
status?" — a test-coverage matrix, a rollout/QA checklist, a migration's file list, a
review's findings — keep a **board** (a titled table of rows) instead of burying it in
prose. Do this **proactively**, without being asked:

- **`board_upsert({ title, rows })`** — create or refresh the WHOLE table (idempotent by
  title). Re-send the full table whenever status changes. Each row is
  `{ label, status, note }`, `status ∈ done | partial | missing | tracked | na`. Keep
  `label` stable — rows are matched by label, and the human's notes stick to the label.
- **`board_row({ title, label, status?, note? })`** — flip a single row without resending all.
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
