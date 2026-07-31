## Copilot CLI wake behavior

- A Copilot `flag(kind:"question")` response includes a `watch` object. Immediately launch
  `watch.shell_command` as a detached async background task using the returned mode,
  detach, shell ID, and timeout. Do not wait synchronously.
- End the turn normally. The background command's completion notification wakes the
  owning Copilot session when the Inbox answer arrives.
- On completion, call `pending()` immediately, act on the response, then `resolve` the
  question. The human must not need to send another chat message.
- Do not launch a watcher for notes, milestones, or blocked board rows; those responses do
  not include the per-question launch contract.
