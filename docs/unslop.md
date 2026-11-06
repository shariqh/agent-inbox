# unslop through the local agent

Agent Inbox can run the `unslop` editing skill as a local A2A agent (#483, mesh phase
M2a). Copilot CLI, Claude Code or a plain shell sends a public draft to it, and the
agent edits the draft with a local model by the same `rules.md` the skill uses
in-session. Code, not the model, checks that facts, links, numbers, negations and
conditions survived the edit. If the check fails twice, you get the original back.

It is opt-in and off by default. The design is
[`docs/superpowers/specs/2026-11-06-unslop-a2a-agent-design.md`](superpowers/specs/2026-11-06-unslop-a2a-agent-design.md);
the implementation notes are in [`docs/architecture/mesh.md`](architecture/mesh.md).

**What may go to the agent:** a PR description, an issue, release notes, public
documentation or a blog post. **What never goes to it:** email, customer text and
private material. Those are edited in-session. Assistants may call the agent on
their own for the public kinds; the privacy screen and the declared `--kind` are the
only checks, and neither can catch every private draft.

## Turn it on (from a checkout)

Use Node 24 in every step (`fnm use 24`).

1. Build the root and the agent package:

   ```sh
   npm ci && npm run build
   (cd packages/mesh && npm ci && npm run build)
   ```

2. Preview, then apply:

   ```sh
   npm run meshctl -- enable --unslop
   npm run meshctl -- enable --unslop --apply
   ```

   This writes the caller token, a profile template, the shim `<mesh dir>/bin/unslop`
   and the `agents.unslop` key in `mesh.json`. `<mesh dir>` is `~/.agent-inbox` unless
   `AGENT_INBOX_MESH_DIR` (or `AGENT_INBOX_DB`) says otherwise. The endpoint is
   `http://127.0.0.1:4420`; pass `--port <n>` for another port.

3. Fill in the profile, `<mesh dir>/mesh/wrappers/unslop.json` (keep it mode 0600). The
   agent refuses to start until you replace each `FILL IN` value:
   - `skill`: the absolute path of your unslop skill folder, the one that holds
     `rules.md` and `SKILL.md`.
   - `baseUrl`: the base URL of your OpenAI-compatible model server, `https://`
     (`http://` only on a loopback address). The agent calls only
     `<baseUrl>/v1/chat/completions`.
   - `apiKey`: where the key comes from: `{ "file": "/absolute/path" }` (a 0600 file),
     `{ "command": ["/absolute/path", "arg"] }` (run without a shell; its stdout is the
     key) or `{ "env": "NAME" }`. Remove `apiKey` if the server needs no key. The agent
     is started by whichever shell calls it first, often an assistant's, so an
     environment variable set only in your interactive shell may be missing there.
     Prefer the file or command form.
   - Leave `model` (`chat-long`), `sampling` and `start` as written. `start` is the
     command meshctl runs to start the agent; if Node or the checkout moves, run
     `enable --unslop --apply` again and copy the `start` it prints.
   - Optional: `terms` (product terms the edit must keep), `allowEmails` (addresses or
     `@domain`s the screen allows) and `customerPaths` (customer notes folders).

4. Optional but recommended: list customer names and domains, one per line, in
   `<mesh dir>/mesh/unslop-deny.txt` (mode 0600). The screen refuses any draft that
   names one. The file stays on your Mac and is never committed.

Nothing starts the agent at install, build or app start. The first call starts it, and
it exits after 30 idle minutes.

## Call it

```sh
<mesh dir>/bin/unslop --kind pr --report report.json < draft.md > edited.md
```

`--kind` is one of `pr`, `issue`, `release-notes`, `docs` (public documentation only)
and `blog`. The draft comes on stdin (or `--in <file>`), at most 12 KiB. `--timeout`
defaults to 280 seconds, so give the shell at least 300. The command never reads the
terminal and never asks anything. Progress (`waiting`, `editing`, `checking`,
`retrying`) and a summary go to stderr.

| Exit | Meaning | stdout |
|---|---|---|
| 0 | Rewritten, or already fine | the edited text |
| 10 | Kept the original (the check failed twice, or the answer was cut off or empty) | empty |
| 11 | Refused: kind, size, the privacy screen or the daily budget | empty |
| 12 | Busy: the queue is full or the model server is loading or busy | empty |
| 13 | Failed: unreachable, timed out (the task is cancelled) or lost | empty |
| 14 | Off, no agent, a stale shim or an agent that needs rebuilding | empty |
| 4 | Usage | empty |

On anything but 0, edit the original in-session; don't retry. `--report <file>` gets
the result as JSON (mode 0600, never through a symlink): `status`, `model`,
`rulesSha256`, `attempts`, the hard check results, `warnings` (such as a changed
`may`), any refusal classes and timings. After exit 0, read its `warnings` before you
use the text.

## The caller's `SKILL.md`

Split the skill into two files in its one folder: `rules.md` holds today's `SKILL.md`
body (the editing rules) unchanged, and `SKILL.md` keeps its frontmatter and becomes
the routing text below. Keep your existing email completion check where the last
section says. Replace `<mesh dir>` with the real path, usually `~/.agent-inbox`.

```markdown
---
(your existing frontmatter, unchanged)
---

# unslop

The editing rules are in `rules.md` beside this file. If it is not there, read
`~/.copilot/skills/unslop/rules.md`.

## Where the text is edited

1. Email, customer text and private material never go to the unslop agent. Edit them
   in-session with `rules.md`. When unsure, edit in-session.
2. For a PR description, an issue, release notes, public documentation or a blog post,
   write the draft to a file and run, with a shell timeout of at least 300 seconds:

   <mesh dir>/bin/unslop --kind <pr|issue|release-notes|docs|blog> --report <report file> < <draft file>

   - Exit 0: use stdout as the edited text, and check the report's `warnings`.
   - Any other exit, or none within the timeout: ignore stdout and edit the original
     in-session with `rules.md`. Do not retry.
3. Anything else: edit in-session with `rules.md`.

## Email

(your existing email completion check, unchanged: it runs in-session)
```

### Rollout checks

- Copilot reads every folder in `~/.copilot/skills`, so a stale backup copy of the skill
  there can shadow the real one. Delete any backup copy of `unslop` under
  `~/.copilot/skills`.
- Link the same folder into `~/.claude/skills/unslop/` for Claude Code.
- In a fresh session of each, confirm `unslop` resolves to that folder (`copilot skill
  list`, and Claude Code's skill list), and ask each assistant to read `rules.md` beside
  its `SKILL.md`.
- **Shell check:** have Copilot run the shim on a public draft from its sync and async
  shells, and Claude Code from its Bash tool. Each must exit 0 within its shell timeout
  without touching the terminal.

## Turn it off

```sh
npm run meshctl -- disable --unslop          # preview
npm run meshctl -- disable --unslop --apply
```

This removes the `agents.unslop` key (keeping a backup of `mesh.json`), the shim and the
token. A running agent exits within a minute. The profile, logs, budget and deny list
stay; add `--purge` to remove them too. With the key gone, `unslop` exits 14 without
starting anything or opening a connection, and the skill edits in-session.
