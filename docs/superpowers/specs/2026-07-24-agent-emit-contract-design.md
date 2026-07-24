# Design: the agent-emit contract (Track A of the inbox UX redesign)

**Date:** 2026-07-24
**Status:** approved, implementing
**Scope chosen:** sharpen the reporting snippet + add teeth to the `flag` MCP tool
description. NO structural validation in the store/MCP layer (preserves the fail-open
"never lose a flag" invariant).

## Problem

The inbox is "becoming a bunch of words" and losing its seeable / actionable /
understandable value. The root cause is at the **source** — what agents emit — not only in
the viewer:

1. **Under-flagging the decision.** The single highest-value moment — a decision only the
   human can make — often never becomes an inbox item. Concrete failure (an Oris session):
   an agent did a strong multi-paragraph analysis and ended on *"say the word and both are
   done"* with obvious options, but it went out as the last paragraph of prose and was
   lost. The current end-of-turn rule invites the wrong judgment: *"asking in chat is fine
   while actively conversing."* The agent had just answered a question, so flagging felt
   unnecessary.
2. **Over-wording everything else.** When things do get flagged, `title`/`detail` carry
   paragraphs, so the actionable signal drowns.

## Fix

Two prose/contract changes, one source of truth. `docs/reporting-snippet.md` feeds both the
user's global agent instructions (via `@import`) and the in-app Setup section, so editing it
updates both. The `flag` tool description in `src/mcp.ts` is read by every agent on every
call — including agents whose harness never loaded the pasted snippet (the likely reason the
Oris agent never saw the rule), so the same contract is mirrored there.

### Change 1 — reporting snippet: reframe the end-of-turn rule

Replace the current one-paragraph rule with a **stop-and-wait test**:

> **The end-of-turn rule — flag decisions, don't bury them.** The test is not "am I still
> chatting?" — it's **"am I about to stop and wait on the human?"** If your next move
> depends on their answer and you are ending your turn, that is a question — flag it, **even
> mid-conversation, even if you just answered something.** This catches the case agents miss
> most: you end on a **recommendation** to accept ("I'd do X"), a **next step awaiting
> go-ahead** ("want me to…?", "say the word", "should I…?"), or you hand back a
> **decision**. A recommendation in the last paragraph of a great analysis is invisible — no
> banner, no badge, no triage, and it will not wake you when they answer; flagging it (with
> `options`) does all three. Writing it in chat **and** flagging is right — the flag is what
> makes it survive, so don't choose between them. *Example: you conclude "I'd add the tour
> row and file the issue — go?" → `flag(kind:"question", title:"Add the feature-tour gate
> row + file the --handbook issue?", options:[{label:"Do both", recommended:true},
> {label:"Just the row"}, {label:"Just the issue"}, {label:"Not now"}])`.*

### Change 2 — reporting snippet: a length contract ("keep every item glanceable")

Sharpen the existing "keep title short" sentence into an explicit contract:

> **Keep every item glanceable.** `title` is the ask or finding itself, in one line (aim
> under ~80 chars) — not a preamble; `detail` is *one* line (the why, the impact, or what
> happens next). If you catch yourself writing a paragraph into `title` or `detail`,
> compress the headline and move the body into `context` — the viewer ranks `title` first,
> so prose in `detail` buries the signal.

Plus a small clarity fix to the `kind:"question"` bullet: title = the question, `detail` =
a one-line why, `context` = long background (the current text says "context in `detail`",
which conflates the two fields).

### Change 3 — `src/mcp.ts`: teeth in the `flag` tool description

Rewrite the tool's own description string to embed the stop-and-wait test, the terse-field
shape, and "always include 2-4 options for a question with discernible choices." No schema
shape change (fields stay kind/title/detail/context/stream/options), so no behavior change
and no risk to the fail-open write path.

## Non-goals (queued elsewhere)

- Deterministic forgotten-flag backstop → issue #10 (a later, larger track).
- Viewer-side ranking / glanceable cards → Track B.
- Structural validation / auto-trim → explicitly declined to keep writes fail-open.

## Testing

This is a prose/contract change with **no code logic change** — the `flag` schema and write
path are untouched, so it is guarded by keeping the existing suite green (88 tests,
including the real MCP round-trip that exercises `flag` + `options` + `pending`) rather than
a new unit test. The real validation is behavioral (do agents flag decisions and stay
terse), which is not unit-testable; it will be observed in use.

## Rollout

Single commit touching `docs/reporting-snippet.md` + `src/mcp.ts` (+ this spec). Because the
snippet is imported into the user's global instructions, the change takes effect for new
agent sessions immediately; already-running sessions pick it up on their next start.
