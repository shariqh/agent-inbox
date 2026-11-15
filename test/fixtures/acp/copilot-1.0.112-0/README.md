# Copilot CLI 1.0.112-0 ACP transcripts (#586 phase 2, PR 2)

Recorded on 2026-11-15 by the chat-load check against a real `copilot --acp --stdio`
(GitHub Copilot CLI 1.0.112-0, macOS arm64, npm install). The spec asked for 1.0.108; this is
the version that was installed, and Copilot was not updated for the check. The findings are in
[`docs/superpowers/specs/2026-10-31-copilot-acp-spike.md`](../../../../docs/superpowers/specs/2026-10-31-copilot-acp-spike.md),
section "2026-11-15: loading a terminal-made chat". `test/driver.test.ts` replays them through
`test/acp-fake.ts`'s `recorded` option.

## How the chats were made

Two chats were made in Copilot's own terminal UI (`copilot --model claude-haiku-4.5`, driven
through tmux), never with `copilot -p` or ACP, in a scratch `COPILOT_HOME`:

- chat `…c001`, in a scratch git repository `<SCRATCH>/repo`: an `echo`, a `touch` approved with
  "Yes, and don't ask again for `touch` in this repo", and a file create approved once;
- chat `…c002`, in a plain folder `<SCRATCH>/plain`: a `touch` approved for that folder, then
  `/allow-all on`.

Every Copilot process started from `env -i` with only `HOME`, `USER`, `LOGNAME`, `TERM`, `LANG`,
`PATH`, `TMPDIR`, `COPILOT_HOME` and `COPILOT_AUTO_UPDATE=false`. The keychain login worked there.
The ACP argv was `copilot --acp --stdio --model claude-haiku-4.5`.

## Format

As in [`../copilot-1.0.105/`](../copilot-1.0.105/README.md): one JSON object per line, `dir` is
`c2a`, `a2c`, `stderr` (none were written) or `note`, and `t` is milliseconds since the recorder
spawned the agent. Two notes are new:

| `event` | Meaning |
|---|---|
| `listing` | the chat's `session-state/<id>/` folder at that point (`label`): each entry's name, size and mtime, and the body of each `inuse.*` file. `loaderPid` is the process the client spawned. |
| `load-replayed`, `load-result` | whether the load answered with a result, and how many updates came before it |

## Sanitizing

- The scratch folder is `<SCRATCH>`, also where Copilot cut a title to `...<tail of the path>`.
  Streamed chunks that split the path were rewritten over the joined stream, as in 1.0.105's
  README, so some chunks' `text` is empty.
- The two terminal chats' ids are `0c4a7000-0000-4000-8000-00000000c001` and `…c002`, and the fresh
  ACP session's is `…a001`. `9b2c6a1e-4d3f-4e8a-9c71-2f5e8d0a6b13` was made up for the unknown-id
  load. Tool call and message ids are as recorded.
- Model lists are cut to `auto`, `claude-sonnet-5.5` and `claude-haiku-4.5`. Every other byte is as
  recorded.
- No token-shaped string, home path, username or real chat was found; none of these chats is
  anyone's real work.

## Files

| File | Shows |
|---|---|
| `load-terminal-chat.jsonl` | `initialize` (`loadSession: true`), `session/list` listing the terminal chat, `session/load` replaying its history before the result, `set_mode #agent`, one prompt in which the location-approved `touch` runs with no request and a file create asks; listings before and after the load, after the prompt and after exit |
| `load-other-cwd.jsonl` | the same chat loaded with another `cwd`: accepted, `pwd` runs in the new folder |
| `load-unknown-id.jsonl` | `-32002` for an id Copilot never saw |
| `load-effort-setting.jsonl` | with `effortLevel` in `settings.json`: `session/load` answers, `session/new` is refused over the reasoning effort |
| `load-while-terminal-holds.jsonl` | a load answered while the terminal still held the chat (its `inuse.<pid>.lock` in the listing) |
| `load-allow-all-from-terminal.jsonl` | a chat left with `/allow-all on` loads with `allow_all: on`; `set_mode #agent` leaves it on; `set_config_option allow_all off` turns it off |
| `new-session-location-approval.jsonl` | a fresh `session/new` in the repository: the terminal's location approval for `touch` applies there too |

## What changed in the chat folder

From the listings and snapshots of the whole `session-state/<id>/` folder:

- `session/load` alone changed nothing: the folder was byte-identical after it, and no lock was taken.
  A load followed by `set_mode` and `set_config_option`, with no prompt, left `workspace.yaml` as it was.
- At the first prompt the host wrote `inuse.<pid>.lock` (holding its own pid, the native binary's) and
  an empty `inuse.<pid>.hold`, and appended to `events.jsonl` (a `session.resume` event first). Both
  files went at exit.
- `workspace.yaml` after the first prompt: `client_name` stayed `github/cli`; `last_client_name`
  became the ACP client's `clientInfo.name`; `updated_at` moved. With another `cwd`, `cwd` and
  `git_root` were rewritten to that folder.
- The terminal's "don't ask again" approvals are not in the chat folder at all. They are in
  `$COPILOT_HOME/permissions-config.json`, under `locations.<folder>.tool_approvals`, and the chat's
  `events.jsonl` records each as a `permission.completed` with `result.kind:
  "approved-for-location"`.
