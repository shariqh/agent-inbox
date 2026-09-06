## Copilot CLI wake behavior

- A Copilot `flag(kind:"question")` response includes a `watch` object. New blocked
  actions from `board_row` and `board_advance` also return `watch`; `board_upsert`
  returns a `watches` array for its new blocked actions. Immediately launch each
  returned `shell_command` as a detached async background task using its mode,
  detach, shell ID, and timeout. Do not wait synchronously or start another copy
  of a watcher that is already running.
- End the turn normally. The background command's completion notification wakes the
  owning Copilot session when the Inbox answer arrives.
- On completion, follow `on_completion`. It names the original response project;
  `pending({project:"..."})` can retrieve that answer even if this session's scope
  changed. Act on the response, then resolve the question or change the board row
  status and record an outcome. Before updating a board in a different project,
  use `register` to select that project. Delivery alone is not acknowledgement.
- A timeout is not an answer and does not complete the request. For a board still
  waiting, call `board_get({title, watch:true})` to obtain fresh watches. This also
  restores watches when taking over a board after a session restart. Each watch
  is tied to one row action and stops when that action is replaced or closed.
- Do not invent a shell poller or launch a watcher for notes and milestones.
  Use only returned launch contracts. The human must not need to send another
  chat message after answering in the Inbox.
