# Workspace hygiene

Agent sessions in this repository leave worktrees, branches, build outputs, test
scratch directories and old runtimes behind. Left alone they add up: the first sweep
(2026-10-20) found 14 agent worktrees, 24 merged local branches, 31 merged remote
branches, a 3.5 GB `build/` in the main checkout and about 680,000 test scratch
entries (roughly 130 GiB) in `$TMPDIR`.

The rule: **the session that merges a PR or publishes a release cleans up after it,
before it reports the work complete.** Delete only what the checks below prove is safe.
When a check fails or you are unsure, keep the item and report it.

Paths below use these names:

```sh
MAIN=~/Development/agent-inbox                        # the owner's main checkout
WT=~/Development/copilot-worktrees/agent-inbox        # agent worktrees
```

## Never touch

- The live checkout's working tree: `dist/` (a running MCP server loads it),
  `node_modules/`, tracked files, and the owner's untracked files (for example
  `.joblog.txt`, `.rfqa/`). Ref-only git commands in it are fine: `git worktree prune`,
  `git remote prune origin`, and deleting verified local branches.
- `~/.agent-inbox/` data: `inbox.db*`, `hook-state/`, logs, `install-agents.lock`, and any
  leftover `upgrade-*` folder. Runtimes are removed only through the installer
  (see [Runtimes](#runtimes)).
- Runtimes that a host registration or hook still references.
- The installed app (`/Applications/Agent Inbox.app`) and the app-managed folders
  `~/Library/Application Support/Agent Inbox`, `…/agent-inbox` and `…/Electron`.
- `~/.claude*` and `~/.copilot*` configuration, and never print their contents.
- `~/.copilot/session-state/` (session artifacts).
- Other repositories' worktrees and other sessions' worktrees, branches and scratch
  directories.
- Work of any open PR, and anything an in-flight session or reviewer is using.
- Anything modified in the last 2 hours, unless your own session made it.

## When is a branch or worktree safe to delete?

A worktree must be **clean** (`git -C <path> status --porcelain` prints nothing; ignored
build outputs do not count), its PR (if any) must be **merged or closed**, and its HEAD
must pass at least one of these checks:

```sh
H=$(git -C <path> rev-parse HEAD)
git -C "$MAIN" fetch origin --prune

# (a) reachable from main
git -C "$MAIN" merge-base --is-ancestor "$H" origin/main

# (b) contained in the head of a merged or closed PR
gh pr list --state all --head <branch> --json number,state,headRefOid
git -C "$MAIN" fetch origin pull/<n>/head          # if the head commit is missing
git -C "$MAIN" merge-base --is-ancestor "$H" <pr-head-oid>

# (c) every commit is patch-equivalent in main (only "-" lines)
git -C "$MAIN" cherry origin/main "$H"

# (d) pushed: an existing remote branch contains it
git -C "$MAIN" branch -r --contains "$H"
```

Squash merges make (a) fail even for merged work, so (b) and (c) are the usual proof.
A branch with no PR and a `+` line in `git cherry` holds work that exists nowhere else:
`gh api repos/shariqh/agent-inbox/commits/<sha>/pulls` answering HTTP 422 means GitHub
has never seen it. Keep it and ask the owner. If the owner wants the space back without
losing that work, save it first, then remove the worktree and branch as below:

```sh
B=<session artifact folder>/<name>.bundle
git -C "$MAIN" bundle create "$B" <branch> ^origin/main
git -C "$MAIN" bundle verify -q "$B"                  # must print "is okay"
git -C "$MAIN" bundle list-heads "$B"                 # must list the branch at its tip
```

## After a PR merges or closes

1. Verify the live PR state (`gh pr view <n> --json state,headRefOid`).
2. Run the checks above, then remove the worktree with git, never with `rm -rf`:

   ```sh
   git -C "$MAIN" worktree remove "$WT/<dir>"
   git -C "$MAIN" branch -D <branch>
   ```

   If `git worktree remove` refuses because of untracked files that are not ignored,
   keep the worktree and report the files.
3. Delete the remote branch if GitHub did not. `delete_branch_on_merge` is on
   (since 2026-10-20), so GitHub removes a merged PR's branch itself; a closed,
   unmerged PR's branch, or one GitHub could not delete, remains. Delete it only when
   its tip still equals the PR head and no open PR uses it as a base:

   ```sh
   git -C "$MAIN" ls-remote --heads origin <branch>      # tip must equal headRefOid
   gh pr list --state open --json number,baseRefName     # no open PR based on it
   git -C "$MAIN" push origin --delete <branch>
   ```

   A remote branch that moved after its PR merged is kept and reported.
4. Remove the PR's scratch directories and the reviewers' `/tmp/review-<n>`,
   `/tmp/delta-<n>` and similar trees. A reviewer tree registered as a worktree goes
   through `git worktree remove`.
5. `git -C "$MAIN" worktree prune && git -C "$MAIN" remote prune origin`.

## After a release publishes

- Remove the release, gate and verification worktrees and their branches with the steps
  above.
- Delete downloaded release assets, `SHA256SUMS.txt`, `update-manifest.json(.sig)` copies
  and other files fetched only to verify the release.
- Delete old `build/` outputs (staged apps, DMGs, AppImages, `.deb` files, runtime
  payloads, Node toolchains, audit trees). `build/` is ignored and regenerable, but first
  confirm nothing runs from it:

  ```sh
  ps -axo pid,command | grep -F "$MAIN/build" | grep -v grep
  timeout 60 lsof +D "$MAIN/build"
  ```

- Keep the Electron download cache for the version `package-lock.json` pins and for any
  version an open PR or kept worktree still pins.

## Tests and reviews

- Tests make scratch directories with `scratchDir()` from `test/scratch.ts` (#240, #245).
  The `test/scratch-setup.ts` setupFile removes each file's leftovers when the file ends,
  and some files also call `removeScratchDirs()` from `afterEach`. Directories a test
  makes any other way must be removed by that test.
- Reviewers create their trees under `/tmp/review-<n>` (or another name that carries the
  PR number) and delete them, or `git worktree remove` them, when the review ends.
- Agents put logs and diagnostics in their session artifact folder, not in `/tmp` or the
  repository.

## Runtimes

Setup installs runtime payloads under `~/.agent-inbox/runtime/<runtime-id>/`. Never delete
one with `rm -rf`. `scripts/install-agents.sh --apply` prunes old runtimes itself, under the
setup lock, keeping the current runtime and the newest previous one and skipping any runtime
a host config still uses. To remove every runtime nothing uses (#294), run a runtime's own
`prune-runtimes.sh`: without `--apply` it is a dry run that lists what it would remove and
changes nothing; with `--apply` it removes them under the setup lock, through the runtime
prune, keeping the runtime it runs from and any runtime a host config or a running process
still uses. Setup's Runtimes section offers the same removal with one button in the app.
Interrupted prunes leave `.trash-*` folders that the next install or prune
removes.

```sh
R=~/.agent-inbox/runtime
bash "$R/<runtime-id>/scripts/prune-runtimes.sh"           # dry run: what would go, and why the rest stays
bash "$R/<runtime-id>/scripts/prune-runtimes.sh" --apply   # remove them
```

`<runtime-id>` must be a runtime that carries the script (1.7.0 or later); the app's own
copy is `"/Applications/Agent Inbox.app/Contents/Resources/app/runtime/<platform-arch>/scripts/prune-runtimes.sh"`.
"Uses" is one rule, shared with the installer's own prune: a host config
(`~/.claude.json` in every scope, `~/.claude/settings.json`, `~/.claude/settings.local.json`,
`~/.copilot/mcp-config.json` or Claude Desktop's config) naming the runtime's id, unless as
a path to nothing, or a launcher in one leading into it, through a symlink or whatever its
spelling; or a running process naming its id. A config it cannot
read means nothing is removed. Project-scope configs (`<project>/.mcp.json`,
`<project>/.claude/settings*.json`) are not read.

To see what is there and what is still referenced (read-only; `references` names the
config files that use a runtime, never what is in them):

```sh
R=~/.agent-inbox/runtime
fnm exec --using=24 -- node "$MAIN/scripts/runtime-payload.mjs" list --runtime-root "$R"
fnm exec --using=24 -- node "$MAIN/scripts/runtime-config.mjs" references \
  --runtime-root "$R" --runtime-id <id> --home ~
```

Leave the decision to remove a runtime to the owner.

## Periodic sweep

Run this when a sweep is requested, or after a burst of merges. Inventory first, then
delete only what passes the checks.

1. Worktrees: `git -C "$MAIN" worktree list --porcelain` and every directory in `$WT`,
   including unregistered ones. For each, record branch, size, last change, clean or
   dirty, PR state and which of checks (a)–(d) passes.
2. Build outputs: `build/`, `out/`, packaged apps, DMGs and AppImages in worktrees and in
   the main checkout.
3. Local branches: `git -C "$MAIN" branch -vv`, especially `[gone]` ones and those
   without a worktree.
4. Remote branches: `git -C "$MAIN" ls-remote --heads origin` compared with PR states.
   Never `main`, tags, or open-PR branches.
5. Temp leftovers in `$TMPDIR` and `/tmp` older than 2 hours whose names this
   repository's tests make (`<prefix>XXXXXX`, where `<prefix>` is a literal passed to
   `mkdtemp`/`scratchDir` in `test/`, `scripts/`, `src/` or `electron/`, such as
   `inbox-dom-`, `hooks-home-`, `setup-fs-`, `agent-runtime-<version>-` or
   `agent-inbox-install.`). Delete each entry by absolute path; never run a glob on `/tmp`.
   Skip a prefix that another repository on the machine also uses.
6. Runtimes: `list` and `references` as above.
7. Caches: `~/Library/Caches/electron` and `~/.electron-gyp` versions against
   `package-lock.json`, open PRs and kept worktrees, and against other repositories.
8. Docker, if running: containers and images made for this repository's Linux packaging
   tests (its workflows run on GitHub runners, so normally none).
9. Anything else attributable to the repository, such as `~/Library/Logs` entries or dev
   Electron userData under another name. Report app-managed folders; do not delete them.

A dry-run helper that automates this inventory is proposed in #248.

## Ownership

- The session that merges a PR or publishes a release does its cleanup before reporting
  the work complete, and lists what it removed and what it kept in that report.
- A session never removes another session's worktree, branch or scratch tree while that
  work is open or recent. It reports them instead.
- Anything that needs the owner's decision (unpushed local-only commits, a moved remote
  branch, an unreferenced runtime, shared caches) is reported with its size and the
  exact command to run.
