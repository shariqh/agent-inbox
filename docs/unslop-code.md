# unslop-code through the local agent

Agent Inbox can run a second local A2A agent, `unslop-code` (#652), beside
[unslop](unslop.md). After a coding agent writes or edits JavaScript or TypeScript in a git
repository, the command sends the files the change touched to the agent. The agent's model (a
local one, or Claude Code on this Mac: see [model servers](model-servers.md)) answers with line
numbers only, and code decides: a line goes only when the change added
it, it holds one whole-line `//` comment and nothing else, and the guards in
`packages/mesh/src/code-slop.ts` allow it. The result is a deletions-only patch. Code is never
rewritten; other things the model noticed come back as suggestions, which nothing applies.

In a test file, a short comment that names what the next lines check stays. Section dividers and
step numbers still go.

It is opt-in and off by default. The implementation notes are in
[`docs/architecture/mesh.md`](architecture/mesh.md) (the unslop-code sections).

## Turn it on (from a checkout)

Use Node 24 in every step (`fnm use 24`).

1. Build the root and the agent package:

   ```sh
   npm ci && npm run build
   (cd packages/mesh && npm ci && npm run build)
   ```

   Expect both builds to end without errors. `enable` refuses until
   `packages/mesh/dist/wrap.js` exists.

2. Preview, then apply:

   ```sh
   npm run meshctl -- enable --unslop-code
   npm run meshctl -- enable --unslop-code --apply
   ```

   The preview lists five steps and ends with `Nothing changed. Re-run with --apply.` The apply
   writes, in this order: the caller token `<mesh dir>/mesh/tokens/unslop-code` (kept if it is
   there), the profile `<mesh dir>/mesh/wrappers/unslop-code.json` (never overwritten), the shim
   `<mesh dir>/bin/unslop-code`, the routing skill `<mesh dir>/skills/unslop-code/SKILL.md`
   (below), and last the `agents.unslop-code` key in `mesh.json`. `<mesh dir>` is
   `~/.agent-inbox` unless `AGENT_INBOX_MESH_DIR` (or `AGENT_INBOX_DB`) says otherwise. The
   endpoint is `http://127.0.0.1:4421`; pass `--port <n>` for another port. A port that another
   entry in `mesh.json` already uses (unslop's 4420, say) is refused.

3. Check the profile (keep it mode 0600). It holds `baseUrl`, `apiKey`, `model` (`coder-next`),
   `sampling` (temperature 0) and `start`:
   - When the unslop profile (`<mesh dir>/mesh/wrappers/unslop.json`) exists, is yours, is mode
     0600 and has a filled-in `baseUrl`, the new profile takes its `baseUrl` and its `apiKey`
     source from it, so there is nothing to fill in. The preview says so and prints neither
     value. `apiKey` is where the key comes from (`{ "file": … }`, `{ "command": [ … ] }` or
     `{ "env": … }`), never the key itself.
   - Otherwise it holds `FILL IN` placeholders, which the agent refuses until you replace them,
     as in unslop's profile: `baseUrl` is the `https://` base URL of an OpenAI-compatible model
     server (`http://` only on a loopback address), and `apiKey` is a key source as above, or
     no `apiKey` at all when the server needs no key.
   - Leave `start` as written: it is the command the client runs to start the agent. If Node or
     the checkout moves, run `enable --unslop-code --apply` again and copy the `start` it prints.
   - In place of `baseUrl` and `apiKey`, the profile can name a model server you added once with
     `meshctl server add`: `"server": "<name>"`. `enable --unslop-code --server <name>` writes it
     (and `--model <name>` sets the model); when unslop's profile names a server, the new profile
     names the same one. See [Model servers](model-servers.md).

4. Link the routing skill into the assistants' skill folders, as for unslop:

   ```sh
   npm run meshctl -- skills link             # preview
   npm run meshctl -- skills link --apply
   ```

   This links `~/.claude/skills/unslop-code` and `~/.agents/skills/unslop-code` to the
   generated folder. Allow the shim the way unslop's docs describe
   ([Allow the shim](unslop.md#allow-the-shim)), with `unslop-code` in place of `unslop`, for
   example `Bash(~/.agent-inbox/bin/unslop-code:*)` in Claude Code.

Nothing starts the agent at install, build or app start. The first call starts it, and it exits
after 30 idle minutes, within a minute of `disable --unslop-code --apply`, or when its token
changes.

**If something's off**

- `enable` says `wrap.js is missing`: build `packages/mesh` (step 1) and run it again.
- `enable` says the port is another entry's endpoint: pass `--port` with a free port.
- The command exits 14 and says `the agent did not start`: read
  `<mesh dir>/mesh/logs/unslop-code-agent.log`; a profile with `FILL IN` values is the usual cause.
- `meshctl status` prints one line for unslop-code: whether it is on, and whether the profile,
  token and shim are there.

## Call it

Run it from inside the repository, after the change is written and before it is committed:

```sh
<mesh dir>/bin/unslop-code --report report.json              # print the patch
<mesh dir>/bin/unslop-code --apply --report report.json      # and apply it
```

| Option | What it does |
|---|---|
| `--base <ref>` | Look at what the working tree holds beyond the merge base of `<ref>` and `HEAD` (a whole branch's change), instead of beyond `HEAD`. |
| `--apply` | Apply the patch to the working tree with `git apply`. Without it nothing in the repository is written. |
| `--no-suggest` | Skip the suggestions question. |
| `--report <file>` | Write the agent's result and the patch as JSON (mode 0600, never through a symlink). |
| `--timeout <seconds>` | 1 to 600; default 280, so give the shell at least 300. |
| `-- <path>…` | Look only at these paths (files or folders, taken literally, relative to where you run it). |

What it prints:

- **stdout:** the patch, and nothing else. It is empty when nothing is removed, and on every exit
  but 0, except when `--apply` was refused (exit 13), when the patch is still printed.
- **stderr:** one summary line (the files looked at, the comment lines removed, the
  suggestions, and, when the agent reports them, `; N calls, I tokens in, O out` at its end), then each suggestion as `<path>:<line> <kind>` (`defensive`, `trycatch`, `cast`,
  `nesting` or `other`), then each file the agent skipped or did not reach and each file the
  command left out, with its reason. Paths and the agent's words are printed without control
  characters.

`--apply` applies the patch only when every file in it still has the bytes that were sent (it
reads them again and compares), and only after `git apply --check` accepts it. Otherwise nothing
is applied, the patch is still printed, and the exit is 13 with a line that says which file
changed. It applies to the working tree only, never to the index. A patch from the agent that
does anything but delete lines of files that were sent is refused the same way (exit 13), and
then nothing is printed.

The command never reads stdin or a terminal and never prompts.

### What is collected and sent

By default, the change is what the working tree holds beyond `HEAD`: tracked files, staged or
not, plus untracked files that are not ignored, each wholly added. A repository with no commit
yet counts everything as added. With `--base <ref>` it is everything beyond the merge base of
`<ref>` and `HEAD`. Paths after `--` limit it.

Git runs without a shell, with external diff drivers and textconv off, renames off (a renamed
file counts as a new file), colour off and zero context. Each file's added line numbers come from
the diff's hunk headers, and its text from the working tree, byte for byte. The command never
changes the index (`GIT_OPTIONAL_LOCKS=0`).

Sent, for each file: its path from the repository's top, its text and its added line numbers.
The agent shows the model only windows of 20 lines around the added lines, never the path.

Never sent:

- files that are not `.js .mjs .cjs .jsx .ts .mts .cts .tsx`;
- deleted files, binary files (a NUL byte, or binary to git), symlinks, submodules, files that
  are not UTF-8 text and files outside the repository;
- files whose change only deleted lines.

The agent also skips, with its reason in the report, a file in which its screen sees a key or a
token, and a path its patch writer cannot take (one with a space, a quote or a backslash). Do not
rely on that screen: never run the command on files that hold secrets or customer material.

### Limits

- At most 40 files in one run. With more, the command exits 11 and says to pass paths after
  `--`; nothing is sent.
- A file over 256 KiB is left out and named on stderr.
- The request stays under the agent's 4 MiB limit: files that do not fit are left out and named.
- The agent's own limits apply too: 200 tasks and 180 model-minutes a day, counted apart from
  unslop's, and 600 seconds of work per task, less 5 seconds kept for the answer to reach the
  command within its `--timeout`.

### Exit codes

| Exit | Meaning | stdout |
|---|---|---|
| 0 | It ran: the patch is printed (applied with `--apply`); it may be empty | the patch |
| 11 | Refused: not a git repository, no file it can read with added lines, more than 40 files, or the agent refused (every file skipped, the daily budget) | empty |
| 12 | Busy: the queue is full or the model server is loading or busy | empty |
| 13 | Failed, timed out (the task is cancelled), the patch was not deletions-only, or `--apply` was refused | empty, or the patch when `--apply` was refused |
| 14 | Off, no agent, another process on the agent's port, or an agent that needs rebuilding | empty |
| 18 | The shim is stale (its Node or `meshctl.js` is gone): run `meshctl enable --unslop-code --apply` again. The shim itself exits 18, before the client runs | empty |
| 4 | Usage | empty |

Before it sends the token or any file, the command checks that whatever answers on the port
holds the caller token, as unslop's does: the card request carries a random challenge, and the
agent answers with an HMAC of it keyed by the token and labelled `unslop-code/v1`, so the unslop
agent cannot answer for it. Without the right answer it exits 14 with "another process holds
the unslop-code port", and only the challenge was sent. Then the card must be unslop-code's: its
name, its skill and the extension `urn:agent-inbox:ext:unslop-code:v1` with `api: 1`.

On anything but 0, carry on without it; do not retry. The report, when written, holds the
agent's result (each file's status, removed lines, lines a guard kept with the reason, and
suggestions, plus the model, the number of questions and timings) and the patch.

## The routing skill

An assistant finds the agent through a routing skill: `enable --unslop-code --apply` writes it to
`<mesh dir>/skills/unslop-code/SKILL.md` from fixed text in `src/mesh-skills.ts`, and
`disable --unslop-code --apply` removes it. Don't edit it: meshctl rewrites it, keeping a changed
copy under `<mesh dir>/backups/skills/`. It has no `rules.md` link; the questions are built into
the agent. This is the text, with `<mesh dir>` replaced by the mesh dir's path (`~/.agent-inbox`
when the mesh dir is inside your home folder, the absolute path otherwise). That path is the only
thing meshctl substitutes.

```markdown
---
name: unslop-code
description: Remove the comments an AI coding agent adds that a maintainer would not write, from the JavaScript and TypeScript files a change touched. Use after writing or editing code in a git repository and before committing it.
---

# unslop-code

Run this once after you have written or edited code in a git repository, before you commit:

    <mesh dir>/bin/unslop-code --apply --report <report file>

Give the command a shell timeout of at least 300 seconds. Run it from inside the repository. Do not check that the file exists first, and add no redirection.

- It looks at the lines your change added in JavaScript and TypeScript files, removes whole-line comments that only restate the code or narrate steps, and changes nothing else. It never rewrites code.
- Exit 0: it ran. Read the report. `suggestions` lists other things it noticed, each with a file, a line and a kind. They are suggestions: look at each line and decide yourself; never apply one without reading the code.
- Any other exit, or no answer within the timeout: carry on without it. Do not retry. Tell the person in one line that unslop-code was not used, with the exit code or "timeout" and the last line it printed.
- Exit 18: the same, and also tell the person to run `meshctl enable --unslop-code --apply` again.
- If `<mesh dir>/bin/unslop-code` does not exist, the agent is off: say so in one line and carry on.

Never send it files that hold secrets or customer material; it skips a file in which it sees a key or a token, but do not rely on that.
```

## What this Mac keeps

- The agent's own files under `<mesh dir>/mesh/`: `unslop-code-budget.json` and
  `logs/unslop-code-<date>.log` (one line per task: sizes, counts, timings and class names;
  never a path, a line of code, the token or the key), and the client's start log
  `logs/unslop-code-agent.log`.
- One run record per call in `<mesh dir>/mesh/runs/unslop-code-<date>.jsonl`, written by the
  meshctl entry once the command has found the agent's switch on, whatever the exit: the op
  (`clean`), the end time and duration, the exit code and outcome word, the status, reason,
  model and task id, the files sent, the bytes sent, the comment lines removed, the number of
  suggestions and the timings. Never a path and never text. Records older than 30 days are
  deleted by a later call or by the next `meshctl enable` or `disable`. To delete them now:

  ```sh
  npm run meshctl -- forget-runs --unslop-code           # preview
  npm run meshctl -- forget-runs --unslop-code --apply
  ```

None of these names collides with unslop's: each agent's switch deletes only its own files.

## Where it shows in the app

The app's Agent cards tab draws this agent as it draws unslop: a card under **Yours** (tagged
Built in, with where it runs, its state and the line of what it does), and a page with its Run
history and its Details. It is drawn once `meshctl enable --unslop-code --apply` has written
`agents.unslop-code`. The tab checks its card on entering the tab and on Refresh, with the same
3 s deadline as unslop; when nothing answers it says the agent starts on its first call, which is
true: nothing starts it ahead of a call. A card that is not unslop-code's (another program on the
port, or a build whose card the client cannot use) shows as not an agent card or as a mismatch,
with the same fix words as unslop. The page's usage line reads `<mesh dir>/mesh/unslop-code-budget.json`,
counted apart from unslop's. Run history reads `<mesh dir>/mesh/runs/unslop-code-<date>.jsonl`: each row
says its outcome (cleaned, nothing to remove, refused, busy, failed, unavailable or interrupted) and, in
its details, the files sent, the comment lines removed, the suggestions, the kilobytes sent, the model
and the timings. A row never holds a path or any text.

In the app's own window the tab also turns it on and off with the same commands: **Set up** on its
Marketplace card picks a model server and a model (from the server's list, or typed when the server
cannot be asked), **Check** shows the dry run's steps, and **Turn on** applies them. Once it is on,
its page has **Change server** and **Turn off** (`disable` without `--purge`). The terminal steps
above and below do the same.

## Turn it off

```sh
npm run meshctl -- disable --unslop-code          # preview
npm run meshctl -- disable --unslop-code --apply
```

This removes the `agents.unslop-code` key (keeping a backup of `mesh.json`), the shim, the
token, the routing skill and meshctl's links to it. A running agent exits within a minute. The
profile, logs, budget and run records stay; add `--purge` to remove them too. unslop's key and
files are never touched. With the key gone, `unslop-code` exits 14 without starting anything or
opening a connection, and the skill tells the assistant to carry on without it.
