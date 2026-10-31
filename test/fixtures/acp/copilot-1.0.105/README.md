# Copilot CLI 1.0.105 ACP transcripts (#412 spike)

Recorded on 2026-10-31 by the driven-sessions spike against a real
`copilot --acp --stdio` (GitHub Copilot CLI 1.0.105, macOS arm64, npm install).
The findings are in
[`docs/superpowers/specs/2026-10-31-copilot-acp-spike.md`](../../../../docs/superpowers/specs/2026-10-31-copilot-acp-spike.md).
Step 2's fake ACP agent can replay them.

## Format

One JSON object per line, in the order the client saw them:

| `dir` | Meaning |
|---|---|
| `c2a` | `msg` is a JSON-RPC message the client wrote to the agent's stdin |
| `a2c` | `msg` is a JSON-RPC message the agent wrote to stdout |
| `stderr` | `line` is one line of the agent's stderr (none were written) |
| `note` | the recorder's own marker (`event`: `spawn`, `pid`, `prompt-start`, `prompt-end` with timings, `stdin-close`, `exit`, …) |

`t` is milliseconds since the recorder spawned the agent.

## Sanitizing

- The spike's scratch folder is `<SPIKE>` and the home folder `<HOME>`. Session cwds were
  `<SPIKE>/repo`, a throwaway git repository with a trivial `package.json`.
- Model lists (`availableModels` and the `model` config option) are cut to `auto`,
  `claude-sonnet-5.5` and `claude-haiku-4.5`. Every other byte of each message is as recorded.
- Token-shaped strings were redacted; none were found.
- Streamed chunks can split a path across messages, where a line-by-line replacement cannot
  match it. Those were rewritten over the joined stream: the scratch folder's path becomes
  `<SPIKE>` and the local username `<user>`, in the chunk where the match starts, and the rest
  of the match is removed from the chunks it ran into. Some chunks' `text` is empty as a result.
  The public GitHub handle `shariqh` is kept, as in the `ssh -T` greeting.
- The only `session-state` paths left are Copilot's own folder for the driven session inside
  the scratch `COPILOT_HOME` (`<SPIKE>/copilot-home/session-state/<ACP session id>/plan.md`).
  They are evidence of where plan mode writes its plan.
- `COPILOT_HOME` was a scratch folder, so the `agent-inbox` MCP server registered there wrote to a
  scratch hub, never a real one.

## Files

| File | Shows |
|---|---|
| `initialize-and-session-new.jsonl` | `initialize`, `session/new` (modes, config options), stdin-close exit |
| `prompt-idle-push-midturn-cancel.jsonl` | a prompt, a pushed prompt after 30 s idle, a second prompt mid-turn, `session/cancel`, the turn after a cancel |
| `push-after-long-idle.jsonl` | a pushed prompt after 10 min idle |
| `permissions-and-set-mode.jsonl` | shell and edit `session/request_permission`, Deny, `session/set_mode` to plan/autopilot/agent, plan mode without an exit tool, an invalid mode id |
| `mode-flag-ignored-and-load-replay.jsonl` | `--mode plan` ignored by `session/new`; `session/load` history replay; `session/list` |
| `autopilot-then-close.jsonl`, `load-restores-autopilot.jsonl` | autopilot set, then `session/load` in a new process restores autopilot with allow-all on |
| `registered-mcp-preallowed-and-client-mcp-rejected.jsonl` | the registered `agent-inbox` server pre-allowed by `--allow-tool agent-inbox`; client stdio `mcpServers` ignored; `--deny-tool write` |
| `mcp-and-url-permissions-and-prompt-during-approval.jsonl` | MCP and URL permission requests; a prompt sent while a permission request is unanswered |
| `cancel-during-approval.jsonl` | `session/cancel` while a permission request is unanswered |
| `write-glob-preallowed.jsonl` | `--allow-tool 'write(<dir>/**)'` approving edits without a request |
| `captured-env-npm-test-and-ssh.jsonl` | a session on a `$SHELL -i -l -c` env capture: `npm test`, `which node`, `ssh -T`, `git ls-remote` over SSH |
| `nested-cli.jsonl` | the driven agent starting a nested `copilot -p` |
| `slash-commands-change-permissions.jsonl` | `/allow-all`, `/autopilot`, `/plan` sent as prompt text |
| `slash-command-framing.jsonl` | a leading space still runs `/allow-all`; a framed message does not |
