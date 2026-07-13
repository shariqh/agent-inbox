# Agent Inbox — reporting instructions (paste into global agent instructions)

You have an `agent-inbox` MCP server with a `flag` tool. Use it to surface things
the human would otherwise miss in the terminal firehose. project/stream/agent are
inferred automatically — you only pass kind, title, and optionally detail.

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
