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
- A timeout (exit 124) is not an answer and does not complete the request. Re-arm
  it: re-run the same command for a question, and for a board still waiting, call
  `board_get({title, watch:true})` to obtain fresh watches. Each re-arm of the same
  unanswered ask waits longer: 30 minutes, then 1, 2 and 4 hours. `board_get` also
  restores watches when taking over a board after a session restart. Each watch
  is tied to one row action and stops when that action is replaced or closed.
- Exit 3 means the human chose "I'll take a while" and asked you to stop waiting.
  Do not re-arm that watcher, and `board_get` returns none for that row; their
  answer still arrives through `pending()` or chat. When they give a time instead,
  the running watcher waits quietly until then; a snooze does the same, though one
  longer than a day still times out once a day.
- Do not invent a shell poller or launch a watcher for notes and milestones.
  Use only returned launch contracts. Unless the human asked you to stop waiting,
  they must not need to send another chat message after answering in the Inbox.
- Setting or changing a plan's or row's `issue` link is routine row content: it starts no
  watch and needs no re-arm. Only a new blocked action returns a `watch`.
