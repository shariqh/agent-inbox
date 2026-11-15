---
paths:
  - "src/chat-index.ts"
  - "src/chat-parse.ts"
  - "public/chats.js"
  - "public/chats-view.js"
applyTo: "src/chat-index.ts,src/chat-parse.ts,public/chats.js,public/chats-view.js"
---

# Chat index, `GET /api/chats` and the Chats tab (#586)

PR 1 of the chat directory: the viewer server lists the Claude Code and Copilot CLI chats on this Mac from their metadata. PR 2 adds the Chats tab, which lists them with a copy-resume-command control ([Chats tab](#chats-tab-pr-2)). Resume in Terminal and the terminal setting come in a later PR and build on this API.

Both modules are **viewer process only**. `src/chat-parse.ts` is pure (no import, clock, process or disk, pinned by `test/chat-parse.test.ts`). `src/chat-index.ts` holds the file reads, the cache, liveness and the response body. Neither may enter the stdio MCP import graph (`test/prstate.test.ts`).

## What is read

| | Claude Code | Copilot CLI |
|---|---|---|
| Chats | `~/.claude/projects/<slug>/<uuid>.jsonl` | `~/.copilot/session-state/<uuid>/workspace.yaml` |
| Read | the first and last 64 KiB (`CHAT_WINDOW_BYTES`) of each transcript, or the whole file when it fits in one window | the whole `workspace.yaml` (at most 64 KiB) |
| Keys and records | `cwd` (first seen), `gitBranch` (last), `timestamp` (first and last), `entrypoint` (first); records `custom-title`, `ai-title` and `pr-link` | `id`, `cwd`, `git_root`, `branch`, `repository`, `name`, `user_named`, `client_name`, `created_at`, `updated_at` |
| Live | `~/.claude/sessions/<pid>.json` (`pid`, `sessionId`, `startedAt`) | an `inuse.<pid>.lock` file in the chat folder |
| Retention | `cleanupPeriodDays` in `~/.claude/settings.json` | none |

A record is parsed, the named fields are copied and the record is dropped. The tail window's first line and the head window's last line are cut mid-line, so they are dropped (a head that holds the whole file keeps its last line). A line longer than a window is never parsed.

Title rules:

- **Claude:** the last `custom-title` (a name the user typed), else the last `ai-title`. The brief asked for the last `ai-title`; a typed name outranks it because it is the user's own. A title is one line, free of control and bidi characters, at most 200 characters. `titleAuto` is always `false`.
- **Copilot:** `name` is the title of every chat that has one. It is Copilot's own display name for the chat (what its resume picker shows) and the source the approved design in #586 names. When the user did not name the chat (`user_named` is not `true`), Copilot sets `name` to **the opening of the chat's first prompt**, and the entry has `titleAuto: true`. That opening is the only prompt text the index ever returns. It is reduced to the first non-empty line, whitespace collapsed, control, bidi and zero-width characters removed, and cut to at most 120 characters (119 and an ellipsis `…` when it was longer). Nothing else from a chat's messages is read or returned. A name the user typed has `titleAuto: false`. A chat with no `name` has `title: null` and `titleAuto: false`.

A strict YAML subset reads `workspace.yaml`: only column-0 `key: value` lines for the keys above, with plain, `'single'` and `"double"` scalars and `|`, `|-`, `>`, `>-` blocks. Anything else (flow collections, anchors, tags, a nested map, a duplicate key, an unknown escape) leaves that key missing and the others still read. There is no YAML dependency. Each line is split by a prefix match and a linear blank trim, never one regex with a lazy value between two blank runs, which backtracks cubically on `key:` + thousands of blanks + a lone `\r`; `parseGitOrigin` follows the same rule. A line holding a `\r`, U+2028 or U+2029 past the key is left unread.

## What is never read

- Message records beyond the two windows, and any message text. The tests plant a `SECRET` marker in user, assistant and `last-prompt` records and on the second line of an automatic Copilot name, and check it never comes back.
- `events.jsonl` is only `lstat`ed (its existence and mtime). It is never opened. `session.db`, `sessions-index.json` (it holds `firstPrompt`) and a lock file's contents are never opened either.
- Nothing is read at server start. The first read is the first API request.

## Never written, never spawned

The index does not write to either tool's folders, and it starts no process. The project name comes from git's own files (below), because `git remote get-url origin` over this Mac's folders took 11 seconds. `inferProject` is always called with an explicit origin (`string | null`), since only `undefined` makes it run git. A source test pins `chat-index.ts`'s exact import list (so `./infer.js` supplies `inferProject` and nothing else, not `inferStream`, `inferRepo` or `remoteUrl`) and the two-argument call.

Every read opens the file with `O_NOFOLLOW | O_NONBLOCK`, then `fstat` must show a regular file owned by this user, and then it reads at most its cap. Symlinks, FIFOs and other special files, unreadable files and oversized ones are skipped; nothing throws. The two root folders may be symlinks (the user's own setup); everything inside them is never followed. A folder or file name must be a lowercase UUID (a transcript is `<uuid>.jsonl`; a Claude project folder matches `[A-Za-z0-9_-][\w.-]*`) before it reaches a path join. Copilot's `pending-session:…` and `optimistic-…` folders are not chats.

The index is **POSIX-only for now**: `cleanPath` accepts absolute `/…` paths only and the temp-folder rule knows POSIX roots, so `read()` returns an empty list on Windows.

## Entry

`{ id, tool, title, titleAuto, project, cwd, branch, createdAt, lastActiveAt, live, pr, hidden }`.

- `title` is described under Title rules. `titleAuto` is `true` only for Copilot's automatic name, so a UI can tell it from a name a person chose.
- `cwd` is the folder the chat started in (Claude: the first `cwd` seen, Copilot: `cwd`), which `--resume` needs. It is null when the files do not say.
- `lastActiveAt` is the **later** of the newest timestamp the tool wrote and a file mtime: for Claude the transcript's mtime (the last 64 KiB can be one huge tool result with no complete record), for Copilot `events.jsonl`'s mtime, which is `lstat`ed on every read because an append to it does not change the folder's mtime and `updated_at` lags a resumed chat.
- `pr` is the last valid `pr-link` record (`https://github.com/<owner>/<repo>/pull/<n>`), Claude only.

### Project

`project = inferProject(folder, origin ?? slug ?? null)`, matching how the MCP server names a project (the origin URL's last path segment, else the folder name), so a worktree such as `widget-wt-x` is `widget`.

- `folder` is Copilot's `git_root ?? cwd`, or Claude's `cwd`.
- `origin` is read from git's files when the folder still exists, walking up at most 10 levels to the first `.git`. A `.git` directory gives its `config`; a `.git` file's `gitdir:` pointer gives a gitdir whose `commondir` leads to the shared `config`. The `url` under `[remote "origin"]` is the origin. Pointer files are capped at 4 KiB, a config at 64 KiB, and the result is cached per folder for 60 seconds, misses included. A folder that is gone is not walked, because a parent could belong to an unrelated repository.
- `slug` is Copilot's `repository` (the chat's own repository), or the Claude `pr-link` repository, when it matches `owner/name`. The Claude slug counts only when the chat's folder is gone: a folder that exists but is not a git repository is named after the folder, as the MCP server names it, and a PR in another repository must not rename it.
- With no folder at all the project is `unknown`.

### Live

A liveness check is `process.kill(pid, 0)` only: EPERM counts as alive, ESRCH as dead. A pid must be an integer from 2 to 2^31−1 (`kill(0)` and `kill(-1)` signal process groups, and pid 1 is always alive). Boot time is `now − os.uptime()`.

- **Claude:** `<pid>.json` is at most 16 KiB, its `pid` equals the file name, its `sessionId` is a UUID, the pid is alive, and `startedAt`, when it is a number, is not before boot (minus 5 seconds). A chat is live if any such file names it.
- **Copilot:** an `inuse.<pid>.lock` that is a regular file, with a live pid and an mtime not before boot (minus 5 seconds). If one pid holds locks in several folders, only the newest lock counts. Stale locks (a crashed session leaves one behind) are the normal case.

These are the reused-pid checks the files allow: a pid from before this boot, and one pid in two sessions. A pid reused within one boot by an unrelated process cannot be told apart from the files.

## Hidden by default

`hidden` lists why a chat is left out of the default list; `?all=1` includes every chat.

| Reason | Rule |
|---|---|
| `temp` | the chat's folder is `/tmp`, `/private/tmp`, `/var/folders` or `/private/var/folders`, or under one |
| `non-interactive` | Claude: the entrypoint starts with `sdk-` (`sdk-cli`, print mode); `cli` and `claude-vscode` are interactive. Copilot: `client_name` is present and is neither `github/cli` nor `github/autopilot` (so `agent-inbox-driver` is hidden) |
| `empty` | Copilot only: no `events.jsonl`, which means nothing was ever said in the folder |
| `folder-gone` | the chat's `cwd` no longer exists on disk, or the files name no `cwd` at all |

`folder-gone` exists because Resume needs the folder: `--resume` runs in the chat's own `cwd`, so a chat whose folder was deleted cannot be resumed in place. The default list is then the chats that can be continued. The rule:

- Only a folder that is not there is gone: `stat` says `ENOENT`, or a path component is a file (`ENOTDIR`), or the path is a symlink loop (`ELOOP`) or too long to exist (`ENAMETOOLONG`), or the path is not a directory. A folder that exists but cannot be read or searched (permissions) is **not** gone, because the chat resumes once that is fixed.
- It is the chat's `cwd` that counts, not the folder the project name comes from (Copilot's `git_root` when it has one). The check reuses the existence result the origin cache already holds for the folder, so a chat adds no stat of its own; only a Copilot chat whose `cwd` differs from its `git_root` adds one more, cached the same way. The result is cached for 60 seconds with the origin, so a folder that is deleted or restored shows within a minute.

Decisions beyond the issue's two reasons (temp, non-interactive), made while building PR 1 and open to change:

- `empty` hides 254 Copilot folders on this Mac that hold no event and no name.
- **No `remote` reason.** The issue lists cloud sessions (`mc_task_id`) as a non-goal, but 73 of the 74 folders with `mc_task_id` hold a local `events.jsonl`, and 19 of those are ordinary local `github/cli` chats. Hiding them for that key would hide real chats.
- **`folder-gone` is a hidden reason, not a UI filter.** `client_name` does not separate Copilot's one-shot automated runs from interactive chats (no `workspace.yaml` key does), and Resume needs the folder, so chats without one are hidden by default like the other reasons and `?all=1` lists them.
- A Claude `custom-title` outranks the last `ai-title`.

## Bounds and cache

- Per file, keyed by mtime and size: transcripts, `workspace.yaml` files and session files. A Copilot folder's lock list is keyed by the folder's mtime. A transcript that only grew keeps an earlier title and PR when the new tail has none, because a live chat's title scrolls out of the tail window as the chat grows. That carry-over applies only when both reads were windowed and the first cwd and start time are unchanged: a chat that fits in one window is read whole and its fresh parse wins (so a rename or a second PR shows), and a file replaced at the same size is not merged with the old entry. Keys a pass did not see are dropped.
- A warm read does `lstat` calls and a few small rereads of files that changed, and nothing else.
- Caps per read, each of which sets `truncated`: 2,000 Claude project folders, 10,000 Claude transcripts, 20,000 Copilot folders, and 64 MiB of uncached reads (Claude files are read newest first, so the budget goes to recent chats; an over-budget file keeps showing its older read, or is left out and finishes on the next read). The response is capped at 2,000 chats (`MAX_CHATS`).
- Reads are synchronous, like the rest of the viewer.

## API

`GET /api/chats` follows the viewer's local-only Host and Origin rules (`viewer-network.md`) and sends `Cache-Control: no-store`.

```
{ chats: ChatEntry[], counts: { total, hidden, claude, copilot, live }, truncated: boolean, retention: { claudeDays: number } }
```

- Sorted by `lastActiveAt` descending (null last, then by id). Hidden chats are left out unless `?all=1`. Any other `all` value is a 400 `{ ok: false, error: 'expected ?all=1' }`.
- `counts` are over the full index, before the hidden filter and the cap.
- `retention.claudeDays` is `cleanupPeriodDays` from `~/.claude/settings.json` when it is a positive number, else 30. The file is the user's own config and often a symlink into a dotfiles repository, which Claude Code follows, so it is read through a link (still a regular file this user owns, at most 64 KiB). Claude Code deletes chats after that many days; Copilot keeps its chats until deleted.

## Measured on the author's Mac (counts and times only)

31 Claude transcripts and 1,512 Copilot folders; the default list shows 71 of the 1,543 chats (11 Claude, 60 Copilot). Hidden, some overlapping: 26 `temp`, 26 `non-interactive`, 254 `empty` and 1,211 `folder-gone` (8 Claude, 1,203 Copilot). A cold read took about 0.4 seconds and a warm read 20 to 25 milliseconds, taken with the machine under ordinary load (an earlier read, before `folder-gone`, opened 1,574 files and read about 5 MB in 0.65 to 0.9 seconds under heavy load). Nothing was truncated.

## Chats tab (PR 2)

A tab after History (`G C`, `#chats`) lists the chats as a table. `public/chats.js` is the pure model (reading the body, sort, search, filters, the home folder, labels, the fetch rule and the resume command); `public/chats-view.js` is the DOM; `app.js` only wires them.

**Reads.** `/api/chats` is read when the panel is entered from another tab or from Settings and no list is loaded or the last one is over 60 seconds old, and on Refresh, Retry and either change of Show all. Re-selecting the open tab reads nothing. `load()` and the 3 s poll never read it. Each read takes a sequence number and only the newest is applied, so turning Show all on or off mid-read never shows the other set. A failed read keeps the last list ("Couldn't refresh chats (500). Showing the last list.") with Retry; with no list it says "Couldn't load chats (500)." Refresh is `aria-disabled` while a read runs, so a focused button keeps focus.

**Painting.** The view repaints `#chats` alone. `render()` calls its `paint()` from `paintEditableSurfaces` while the panel shows (or on a full frame), and a settled read or a control paints the region directly, as search paints its results, so a Chats read never rebuilds another tab. `renderIfIdle` and `reloadAndPaint`/`forceRender` stay the only entries into `render()`. The view's version joins `frameInputs()` through `chatsView.state()`. The header and table are built once, so the search box keeps its value, caret and focus across every paint. Rows are keyed `tool:id` (`data-chat-key`, which `public/selection.js` matches by identity) and change only where their chat did; a direct paint keeps a text selection with `captureSelection`/`restoreSelection`, and waits while a press is down inside the region (at most the app's 1 s press grace), so a row is never moved or removed between pointerdown and click.

**Table.** Sorted by `lastActiveAt`, newest first (no time last, then id). Columns: tool (Claude Code or Copilot), title, project, branch (with the PR as a link), folder, last active (relative, with the exact local time in `title`), Live and the Copy control. Copilot's automatic name (`titleAuto`) and a missing title ("Untitled") are muted (`.chats-quiet`); the automatic one says so in its `title`. The folder shows the home folder as `~`: the API carries no home folder, so `inferHome` takes the one `/Users/<name>` or `/home/<name>` prefix the listed folders share (none or several show full paths); the full path is always in the cell's `title`. Below 620px of list width each row becomes two lines (tool, title, Live over project, branch, folder, last active, Copy), through the `chats-list` container. The row is a wrapping flex row rather than a grid, so the folder takes the space left on line 2 and moves to a line of its own when under 12em is left; at phone width a content-sized grid squeezed it to nothing. Title, project, branch and folder break anywhere, so a long unbroken name never scrolls the page sideways. A branch recorded as `HEAD` (a folder that is not a repository, or a detached checkout) names no branch, so the cell is empty. Below 620px the project filter takes a line of its own and its select shrinks with it.

**Search and filters.** One box matches title, project, branch, the raw folder and its `~` form (case-insensitive substring, trimmed). Tool (All, Claude Code, Copilot) and project (the projects in the loaded list) filters combine with it, and the count line says "Showing 2 of 5 chats". They are window-local, never persisted, and kept across tab switches and reads; a project that leaves the list resets to All. The rail's project and agent lens does not apply here, because chat project names come from the index.

**Show all.** The switch label says how many chats the default list leaves out ("Show all (3 hidden)", from `counts.hidden`). On, it reads `?all=1`, and each hidden chat carries a neutral chip per reason: Temp folder, Non-interactive, Empty, Folder gone. With no chat in the default list the empty state says how many are hidden.

**Copy resume.** `resumeCommand` builds `cd '<folder>' && claude --resume <id>` or `cd '<folder>' && copilot --resume=<id>`. The id must be a lowercase UUID; the folder must be an absolute path with no C0, DEL, C1, U+2028 or U+2029 character, and it is single-quoted for a POSIX shell with each `'` written as `'\''`. Anything else gives no command. A test runs each hostile folder through `/bin/sh`. The control (`aria-disabled`, so its reason stays reachable by focus and tooltip) is unavailable with a reason in its `title`: a chat with no folder ("The chat's files name no folder to resume in."; the index also marks it `folder-gone`, so this is checked first), a folder that is gone, or an id or folder that cannot be quoted safely. A live chat still copies; its `title` is the command, then a second line warning that resuming opens a second copy. Copying goes through structured-copy's `writeClipboard`, and the label reads "Copied" or "Copy failed" for 1.5 s; a paint never writes the label, so a poll cannot cut that short.

**Notes.** Above the table: "Claude Code deletes chats that have been untouched for N days. Agent Inbox does not copy them." (`retention.claudeDays`), and, when `truncated` is true, that the list is incomplete.

**Untrusted text.** Title, project, branch and folder reach the DOM only through `textContent` and attributes, never `innerHTML`, `esc()`-built HTML or the structured-text renderer. The one markup write is the PR link, from `textLinkHtml()` and only when `githubRef(url)` is a github.com pull request.

**Deep link.** `#chats` opens the tab on boot and on `hashchange`. The viewer never writes it, as tab clicks never write a hash, so a reload on `#chats` reopens Chats as `#item/<id>` reopens its item.

**Show session** is left out: nothing the viewer already holds links a chat id to a session card (`activity.session` is the MCP server's own id, a chat entry carries no pid, and a launch's ACP session is not served).

## Not in this PR

Resume in Terminal and the terminal setting, resuming inside Agent Inbox, Show session, and the Dashboard's link to the Chats tab.
