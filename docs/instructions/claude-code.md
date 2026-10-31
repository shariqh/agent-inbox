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
- A board's `issue` links (plan pin and row links) and rows' `waits_on` belong to the agent like
  any other row field; Claude Code needs no hook for them, and they never wake a session.
- The hooks also wake this session for a message the human sends it from Agent Inbox: `Stop`
  bounces the agent back once per message, and `asyncRewake` resumes an idle session within the
  watch window. Call `pending()`, act on each message, then `ack_message` it with an outcome.
