# Tracking Boards — follow-up backlog

> **Now tracked as GitHub issues [#1–#6](https://github.com/shariqh/agent-inbox/issues)** —
> the issues are the source of truth; this file is the original review context.

Boards v1 (store + MCP write tools + viewer + human annotations) is built and whole-branch-reviewed (Ready to merge). These follow-ups came out of a review of how boards fit the human↔agent attention loop. Priority is my assessment; reorder freely.

The through-line: **v1 is a one-way channel** — the agent writes, the human watches. The high-value follow-ups make it **two-way**.

## P1 — close the loop

- [x] **Agent read access (`board_get`).** MCP tool so the agent can read a board's current state, INCLUDING the human's per-row annotations. Without it, human notes are write-only-to-the-void from the agent's side. `board_get({title?})` → one board (or all active boards for the project) with rows + annotations + progress. *(SHIPPED.)*
- [ ] **Row context dropdown.** *(#1)* An optional long-form `context` field per row (distinct from the one-line `note`), rendered as a collapsed `<details>` the human expands. Handles the "context is a long iterative chat" case: the agent drops the reasoning/history in `context`, the row stays scannable, the human expands when they need it. Needs: `board_rows.context` column, a `context?` param on `board_upsert`/`board_row`, and a `<details>` in the viewer.

## P2 — awareness & safety

- [ ] **"Unseen by agent" marker on annotations.** *(#2)* Builds on `board_get`: stamp when the agent last read a board; mark human annotations added since as "unseen" (a dot in the viewer, and surfaced in `board_get`) so BOTH sides know whether the agent has picked up a note yet. This is the real answer to "how do you know I put something there."
- [ ] **Human-addressable row references.** *(#3)* Show a short, stable id in the viewer (board short-id + row number, or the label) so the human can point the agent at a specific line item ("board BDC row 7") in chat.
- [ ] **Archive safety.** *(#4)* Confirm-on-archive, an un-archive action, and an "Archived" view/section so an accidental archive is recoverable from the screen (today it just vanishes; only the DB has it).

## P3 — nice-to-have

- [ ] **Escalate a row into "Needs you".** *(#5)* Let a row marked (e.g.) `blocked`/needs-input surface in the attention section, not just inside the board — so a board can actively ask for the human, like `flag(kind:question)` does.
- [ ] **"Done"/complete board treatment.** *(#6)* A visual for a 100% board (and optional auto-archive when complete), so finished boards clear themselves out.

## Notes on current behavior (answers to the questions that spawned this)

- Boards never appear in "Needs you"; that section is `flag(kind:question)` only.
- Archive fires immediately, no confirm, no un-archive in the UI (recoverable only in the DB).
- Rows are keyed by `label` (stable) + `position`; no short human id shown yet.
- The human's annotation IS visually distinct in the viewer (a `📝 …` line under the agent's note); the gap is on the AGENT side (no read tool) — P1 fixes that.
- "Notes" section = the existing `flag(kind:'note')` inbox, unrelated to boards.
