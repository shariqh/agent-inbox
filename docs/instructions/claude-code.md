## Claude Code wake behavior

- In Claude Code sessions only: Claude Code does **not** receive the Copilot `watch` launch
  contract, so do not create a detached watcher yourself. Copilot CLI must follow its returned
  `watch` launch contract.
- The optional Agent Inbox hooks are Claude's native wake path. Their `Stop` hook checks
  `pending()`, and `asyncRewake` resumes the session when an Inbox answer arrives.
- When a hook or system nudge says an answer arrived, call `pending()` immediately, act on
  the response, and acknowledge it with `resolve` or a board-row status change.
- Without the optional hooks, call `pending()` between work steps and first thing on the
  next turn. The MCP tools still work; only automatic idle-session wakeup is absent.
