# Design: run each driven session in its own git worktree (#432)

**Date:** 2026-11-03
**Status:** Design only; nothing here is built. The questions for Shariq are in §10.
**Scope of this PR:** this document. No source, test or workflow changes.
**Related:** #412 and its design
([`2026-10-31-driven-sessions-design.md`](2026-10-31-driven-sessions-design.md)) §3–§9, §11
step 3 and §14; [`2026-11-02-sessions-runtime-design.md`](2026-11-02-sessions-runtime-design.md);
`docs/architecture/driven-sessions.md` (Edits in the worktree, #433). Facts were checked against
`origin/main` at da9440be and against real `git worktree` runs in scratch repositories
(Appendix A).

---

## §0 — Summary

1. **Goal.** Hand Agent Inbox several tasks at once without touching the human's checkout. Today
   a launch runs in the chosen folder itself, so two launches collide and edit the checkout. Here,
   each launch can instead run in a new linked worktree on its own branch.
2. **The driver creates the worktree,** after main's native confirmation has shown its path and
   branch. It runs `git -C <checkout> worktree add --lock --reason <r> -b <branch> <path> <base
   sha>`, argv only. The `git` comes from the captured login PATH and is trust-checked like
   `copilot`. The base is the checkout's current `HEAD` commit.
3. **The launch's `cwd` becomes the worktree.** Resume, Edits in the worktree, ancestry, the logs and
   older drivers therefore work unchanged. Nullable columns record the checkout, the branch, the
   base, whether the worktree was removed, and a summary written at each turn end.
4. **Nothing is removed automatically.** Remove worktree has its own native confirmation. It runs
   `git worktree remove` without `--force`, unless the human chooses to discard changes they were
   shown. Agent Inbox never deletes a branch a session has used.
5. **Four PRs,** about 800 production lines in all (§9).

## §1 — Where the worktree lives, and its branch

**Root:** `<hub dir>/worktrees` by default (`~/.agent-inbox/worktrees`). Settings → Agent
sessions → **Worktree folder** changes it through main's own folder dialog, stored as an optional
field of `session-launch.json` (schema 1; older apps keep unknown fields). The owner can set
`~/Development/copilot-worktrees` to match his CLI agents; nothing assumes it exists. **Beside the
repository** (`<repo>-worktrees/`) is rejected: it writes into the checkout's parent, which may be
another repository or a synced folder. No repository convention exists to read.

**Path:** `<root>/<repo>/<slug>-<short>`. `<short>` is the launch id's first 8 hex digits. `<repo>`
is the folder's project name if it matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, else its basename
if that matches, else `repo`. `<slug>` is the task's first line in lowercase ASCII letters and
digits, other runs turned into `-`, at most 32 characters cut at a `-`, or `session` if empty.

**Branch:** `agent-inbox/<slug>-<short>`, matching `^agent-inbox/[a-z0-9]+(-[a-z0-9]+)*-[0-9a-f]{8}$`,
which `git check-ref-format` accepts by construction (A6). Main builds it and the driver re-checks
it. Main makes the launch id before the confirmation (today, after), so the dialog shows the final
names. A collision refuses with no retry: `-b` fails on an existing branch and on a non-empty path
(A3), and main refuses any existing path. The branch carries the task's first words, which matter
on a public remote; the confirmation shows it. A human-chosen slug can come later as one more
validated field.

**Path rules,** checked by main before the confirmation and again by the driver: the root is a real
directory owned by the user, not group- or world-writable, and not inside the checkout (as real
paths). No component is a symlink: git records the resolved path (A9), so the driver creates
`<root>/<repo>` `0700`, refuses a symlink, and requires `realpath(<path>) === <path>` after the add.
The path holds none of `( ) * ? [ ] { } , \` or a control character, so `editsFolder` accepts it.

## §2 — Who creates it, and when

| | Main, after Start | **The driver, before its status line (recommended)** |
|---|---|---|
| A trusted `git` | New code: the trust check exists only in `driver-cli.ts` | `findExecutable('git', spec.env.PATH)`, as for `copilot` |
| A refusal after creation (cap, pin, host) | Main must undo a worktree for a driver that refused | The driver undoes its own fresh worktree |
| Recording it | Main has no store | `createLaunch` in the same process |
| Tests | Electron fakes | Real `git` in `scratchDir()` repositories |

**`runLaunch`, for a `new` spec with `worktree`:**
1. `claimDriverSlot`.
2. `git rev-parse --show-toplevel` must equal the spec's real `cwd`. This refuses a subfolder, a bare
   repository (A11) and a folder outside any repository.
3. `rev-parse --verify HEAD^{commit}`. An unborn `HEAD` refuses with "This repository has no commits
   yet" (A10). `symbolic-ref -q HEAD` is recorded as `base_ref`; it is null when `HEAD` is detached.
4. The §1 checks, then the add, bounded at 120 s.
5. The `realpath` check, then `createLaunch` with `cwd` set to the worktree.
6. As today: pin, resolve the host, `editsFolder(cwd)`, spawn `copilot`.

A later refusal's `undoRow` also runs `worktree unlock`, then `remove --force`. That is safe, because
only git and the checkout hook have touched the folder. It then runs `update-ref -d refs/heads/<branch>
<base sha>`, a compare-and-delete that spares a moved branch. The worktree goes first, because git
deletes a branch even while another worktree has it checked out (A8).

**Timing.** Main's status-line timeout becomes 150 s for a worktree launch (a large checkout takes
time); others keep 30 s. A failure reaches the New session dialog as git's message, `displaySafe`.

**Git's environment** is `childEnv(spec.env)` plus `GIT_TERMINAL_PROMPT=0`; turn-end reads add
`GIT_OPTIONAL_LOCKS=0`. The add runs the repository's `post-checkout` hook (A1), as a terminal does;
it stays on, because LFS and husky setups rely on it, and the confirmation says so. Main still
captures the env in the checkout, since the worktree does not exist yet; per-folder version
managers read the same committed files. Copilot starts in a folder it has never seen: the spike ran
every session in a fresh scratch repository with a scratch `COPILOT_HOME` (spike, "Isolation") and
met no trust step; PR 1's real-session check confirms it.

**Dirty checkouts.** A worktree starts from the last commit: uncommitted and untracked changes stay
in the checkout (A2), and ignored files such as `node_modules` are absent. The confirmation says so,
and the driver logs a `checkout_dirty` notice with the count.

## §3 — The request, the confirmation and the spec

- **The request.** `launchRequest` gains one optional field, `worktree: true`. The renderer never
  sends a path, branch or root; main derives them from what it already checks (the known folder or
  its own dialog, the task, the launch id). Main also requires `<folder>/.git` to be a directory or a
  regular file, using `lstat` and no git.
- **The confirmation** gains three lines through `displayLine`: `Worktree: <path>`; `Branch:
  <branch>, from your checkout's last commit. Uncommitted changes stay in your checkout.`; and
  `Creating it runs your repository's checkout hooks.` A fourth line warns when another running
  launch uses the folder without a worktree (`/api/launches` serves `cwd`).
- **The spec** stays at `v: 1`. A `new` spec gains the optional field `worktree: { path, branch }`,
  and `cwd` stays the checkout. An older driver refuses the unknown field (exit 65), so it fails
  closed. Main only runs this release’s runtime (#412 design §14.6).
- **The edits mode is unchanged.** `editsFolder(cwd)` now covers only the worktree. Its four `.git`
  denies cover the worktree's `.git` **file** (`gitdir: <checkout>/.git/worktrees/<leaf>`, A1),
  as #433 checked against Copilot; writes to the checkout's `.git` fall outside the folder, so they
  ask. The mode's copy changes from "the project folder" to "the session's folder (its worktree,
  when it has one)", in both copies a test holds equal.
- **Git's own guard.** Git will not check out a branch another worktree has (A4), so the agent cannot
  check out `main` while the human's checkout is on it. A shell `git branch -f` could still move it,
  and shell commands ask.

## §4 — Storage

One migration adds seven nullable columns to `launches`: `checkout_root` (the checkout it was made
from), `worktree_path` (equal to `cwd`), `branch`, `base_sha`, `base_ref` (the checkout's branch at
the start, null when detached), `worktree_removed_at`, and `worktree_summary` (§6, written from
PR 4). Adding them together changes the trigger text once.

- **Snapshots.** `launches` is a whole-table domain (no `columns` in `SNAPSHOT_DOMAINS.launches`), so
  `REVIEWED_COLUMNS` does not apply. Its update trigger names every live column (A12), so the
  migration adds one trigger name. `test/fixtures/snapshot-triggers.txt` gains it, nothing is
  dropped, and the triggers stay last.
- **What is served.** `launchView` passes the new columns through, since none is secret.
- **Kept worktrees.** `listLaunches` also returns up to 50 ended launches whose worktree is kept, and
  `createLaunch`'s 30-day prune skips them, so the hub never loses track of a worktree on disk.
- **`listLaunchFolders`** leaves out roots that equal a `worktree_path`. A session's items record its
  worktree as `repo_root` (#324), and agents' worktrees do not belong in New session's list.
- **Project and stream.** The project is inferred from the checkout, which has the same origin. The
  stream is the branch. The session's MCP server infers the same from the worktree.

## §5 — Lifecycle and concurrency

- **Locked while the session holds it.** The add passes `--lock --reason "agent-inbox launch
  <short>"`, so a hand-run `git worktree remove` or `prune` (or another agent cleaning up) cannot
  take a running or parked session's folder (A5). The driver unlocks at end, in its own exit
  path; a parked launch stays locked. A lost launch's Close runs no git, so it stays locked;
  Remove unlocks first.
- **End, Stop and Close keep the worktree.** The drawer shows its branch and path.
- **Remove worktree** is offered on ended launches only; Stop on a parked launch ends it. The flow:
  1. Main captures the env in the checkout, as Resume does.
  2. Main runs the runtime's `driver-cli.js worktree inspect <id> <hub>`. Inspect re-reads the row
     and requires `git worktree list --porcelain` to show that path on that branch. It returns the
     count of uncommitted paths, the commits ahead of `base_ref` (or `base_sha`), whether the
     branch has an upstream, and a hash of `status --porcelain=v1 -z`.
  3. A native dialog says: "The branch and its N commits stay in your repository. Ignored files such
     as node_modules are deleted." Its buttons are **Remove**, **Discard N changes and remove** (when
     dirty) and Cancel.
  4. `worktree remove <id> <hub> [--discard <hash>]` unlocks and runs `git worktree remove`. Git
     refuses a dirty worktree without `--force` (A7). The driver adds `--force` only while the hash
     still matches, then sets `worktree_removed_at`.
- **Remove, never prune.** `prune` would also clean other tools' stale entries. `remove` handles a
  folder deleted by hand, and only its own entry (A7).
- **No branch is deleted** once a session has run. `branch -d` for merged branches can come later.
- **Resume** keeps today's refusal, "The session's folder does not exist any more", now naming the
  branch. Only a deletion by hand reaches it, because Remove refuses parked launches. Re-creating the
  worktree from the branch can come later; Copilot's session would see only the committed state.
- **Unchanged:** pins, prunes, Setup, Uninstall and app quit. Worktrees are never under the runtime
  root, drivers keep running in theirs, and kept worktrees stay.
- **Concurrency.** Two launches in one repository are allowed, each in its own worktree; git
  serializes its own ref and admin writes, and a lock error refuses with git's message, never
  retried in a loop. Parked launches hold no slot. `MAX_DRIVERS = 2` was partly about launches
  sharing a folder. **Recommended:** Settings → Agent sessions → **At most N sessions at once**,
  main-owned, 1–8, default 4, sent as the spec's optional `maxDrivers`; the step-2 terminal driver
  keeps 2. `claimDriverSlot` already counts every fresh `driver:` lease against the caller's own
  cap, so drivers with different caps can share a hub.

## §6 — Hooks for milestone piece 2 (results)

- **The driver writes the summary; the viewer never runs git.** At each turn end, at park and at end,
  the driver writes `worktree_summary`, `{ v: 1, at, head, branch, ahead, behind, files, dirty }`,
  allowing 10 s per command. `branch` is the current one (the agent can switch); `ahead` and
  `behind` come from `rev-list --left-right --count <base_ref|base_sha>...HEAD` (A13); `files`
  counts `diff --name-only <base_sha>...HEAD`; `dirty` counts `status --porcelain=v1 -z` entries.
  The store writes the summary only on a change, so `/api/launches` is rebuilt only then. A failed
  read keeps the last one.
- **Open in Terminal.** Main runs `/usr/bin/open -a Terminal -- <path>`, argv only. The path comes
  from a fresh row read and must equal `realDirectory(path)`, with the worktree not removed.
- **Open PR.** The `gh` poller already links a PR by head branch for items whose stream is that
  branch. The page joins the launch's `branch` and repository to it, so nothing new polls.

## §7 — Security

The renderer sends only `worktree: true`; main and the driver each validate the path and branch.
The worktree is created only after Start, on a confirmation that showed both. Git runs with argv
only and no shell, as a trusted binary from the captured PATH. Symlinked and odd paths are refused,
never escaped. Remove has its own confirmation, and discarding changes is a separate button bound
to the status the human saw. #412 §8's threat model is unchanged: a session with shell access could
always run `git worktree` itself.

## §8 — The off contract (§9) and mixed versions

**Off means off.** While the switch is off: (a) MCP is unchanged; (b) the page draws no checkbox
and makes no new read; (c) no dependency is added; (d) the migration adds nullable columns to an
empty table, `/api/launches` stays `[]` and the trigger fixture gains one name; (e) main reads no
worktree setting, runs no git and creates no folder.

**Mixed versions.** An older driver resuming a worktree launch runs in `cwd` with the right edits
rule, but neither unlocks nor summarizes. Older viewers ignore the new columns. An older build's
prune can drop a kept worktree's ended row; the worktree stays, locked, with a reason that names
Agent Inbox. An older driver refuses a worktree spec.

## §9 — PR split

| PR | Ships | Size |
|---|---|---|
| 1. Driver and store | `src/worktree.ts` (checks, git runner, create, undo); the spec field; `runLaunch` order and undo; the migration; the `listLaunches`, prune and `listLaunchFolders` rules; unlock at end | ≈ 260 prod, 2–3 days |
| 2. Start in a worktree | `launchRequest`; the launch id before the confirmation; path and branch plan; confirmation lines; 150 s status; the root setting; the New session checkbox, drawer line and mode copy; `driven-sessions.md` | ≈ 220 prod, 2 days |
| 3. Remove and open | `driver-cli.js worktree inspect\|remove`; IPC `removeWorktree(id)` and `openWorktree(id)` (exact arity, `launch` grant); both confirmations; drawer buttons | ≈ 200 prod, 2 days |
| 4. Summary and cap | The turn-end `worktree_summary`; the cap setting and `maxDrivers` | ≈ 120 prod, 1 day |

**Tests.**
- **PR 1** (real git in `scratchDir()` repositories; `test/driver-run.test.ts` with the fake
  `copilot`): a worktree launch records its columns and runs `copilot` there; a dirty checkout is
  allowed; an unborn or bare repository, a subfolder, an existing branch or path, a symlinked root,
  a root inside the checkout and a pattern character are refused; a refusal after creation leaves
  no worktree, branch or lock, and a moved branch survives; unlocked at end, locked while parked;
  the trigger fixture and the §8 (d) bytes; the folder, prune and list rules; a spec without
  `worktree` behaves as today.
- **PR 2:** `launchRequest` refuses any path, branch or root field; slugs from Unicode and empty
  tasks; the confirmation through `displayLine`; the off DOM test, and no git or folder while off;
  the copy-equality test.
- **PR 3** (real git): inspect and remove on clean, untracked, modified, ignored-only, hand-deleted
  and locked worktrees; a stale `--discard` hash refused; Remove refuses running and parked
  launches; IPC arity and grant refusals; the `open` argv pin.
- **PR 4:** the summary after a commit, an edit and a branch switch; no rebuild without a change;
  the cap from the spec, two drivers with different caps, and the terminal's 2.

## §10 — Questions for Shariq

1. **New worktree on by default** in New session when the folder is a repository? *Recommended:
   yes.* That is the milestone's point; unticking it keeps today's behaviour.
2. **Where:** `~/.agent-inbox/worktrees/<repo>/<slug>-<short>`, with Settings → Worktree folder?
   *Recommended: yes.* Set it to `~/Development/copilot-worktrees` to match your CLI agents.
3. **Base:** only your checkout's current `HEAD` commit, for now? *Recommended: yes.* It needs no
   network and works with no remote. "The default branch as last fetched" can be added later.
4. **Session cap:** replace the fixed 2 with a setting of 1–8, default 4? *Recommended: yes.*
   Approvals, not folders, are now the limit, and parked sessions hold no slot.

## Appendix A — Verification log

Scratch repositories in this session's files folder, with `git version 2.54.0 (Apple Git-157)` and
a scratch `GIT_CONFIG_GLOBAL`, on 2026-11-03. Rows 12, 14 and 15 are from the code.

| # | Fact |
|---|---|
| 1 | `add --lock --reason r -b B P <sha>` creates parent folders; `P/.git` is a file `gitdir: <repo>/.git/worktrees/<leaf>`; `post-checkout` runs. (A2) The checkout's uncommitted and untracked changes are not carried |
| 3 | An existing branch fails (`a branch named … already exists`), and so does a non-empty path; an empty folder is accepted. (A4) Checking out a branch another worktree has fails (`is already used by worktree`) |
| 5 | `remove` refuses a locked worktree (`use 'remove -f -f' … or unlock first`); `list --porcelain` shows `locked <reason>`. (A6) `check-ref-format --branch` accepts `agent-inbox/fix-tests-1a2b3c4d`, refuses `agent-inbox/-x..y` |
| 7 | `remove` without `--force` refuses modified or untracked files but deletes ignored-only content; it removes a clean worktree with commits and keeps the branch; it cleans the entry of a folder deleted by hand |
| 8 | `update-ref -d <ref> <old>` refuses a moved ref, yet deletes a ref checked out in another worktree |
| 9 | Under a symlinked parent, git records the resolved path. (A10) `rev-parse --verify -q HEAD^{commit}` fails in an unborn repository. (A11) A bare repository has no top level, and `safe.bareRepository=explicit` refuses it |
| 12 | `launches` is a whole-table domain whose update trigger names every live column (`SNAPSHOT_DOMAINS`, `snapshotDomainTriggers`) |
| 13 | `rev-list --left-right --count main...HEAD` gives behind and ahead; `status --porcelain=v1 -z` lists the changes |
| 14 | `MAX_DRIVERS = 2`; `claimDriverSlot` checks the caller's `max`; the status line times out at 30 s (`driver-cli.ts`, `store.ts`, `driver-process.cjs`) |
| 15 | `listLaunchFolders` reads `repo_root` from items and boards; `inferRepoRoot` is `--show-toplevel`; ended rows are pruned after 30 days and 50 are listed (`store.ts`, `infer.ts`) |
