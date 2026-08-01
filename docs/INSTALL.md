# Install

## 1. Build
```sh
npm install && npm run build
```

## 2. Install the MCP server and agent instructions

The recommended installer handles both pieces. It is a dry run unless `--apply` is
present, verifies Node 24 against the built runtime, backs up every instruction file it
changes, and owns only content between `<!-- agent-inbox:begin -->` /
`<!-- agent-inbox:end -->`.

```sh
npm run install:agents                              # dry run for both hosts
npm run install:agents -- --apply                   # Claude + Copilot
npm run install:agents -- --apply --target claude   # Claude only
npm run install:agents -- --apply --target copilot  # Copilot only
npm run install:agents -- --apply --force           # replace existing MCP entries
npm run install:agents -- --apply --uninstall       # remove managed entries/blocks
```

MCP registration cannot itself inject instructions into a host: `mcp add` stores a
transport command and arguments, while global prompts belong to each host. The installer
is the explicit, auditable one-command equivalent—it performs both operations without
changing anything during package install, build, or Electron launch.

The Electron app exposes the same choices in **Setup**. Select both hosts,
Claude only, or Copilot only, then choose **Install now**, **Copy prompt for
agent**, or **Copy terminal command**. The direct button calls the same audited
installer and is available only in an Electron window backed by the viewer
process that app started; browser tabs and reused third-party localhost pages
never receive command-execution access.

### Host-specific behavior

<details>
<summary><strong>Claude Code</strong></summary>

The installer writes the shared [`reporting-snippet.md`](reporting-snippet.md) plus
[`instructions/claude-code.md`](instructions/claude-code.md) to
`~/.claude/CLAUDE.md`. Claude questions do not return the Copilot `watch` contract.
Automatic idle-session pickup comes from the optional hooks in step 5.

**If you already import the snippet, the installer will not inline it again.** Claude Code
resolves `@path` imports, so a line like

```
@/ABSOLUTE/PATH/TO/agent-inbox/docs/reporting-snippet.md
```

anywhere in `~/.claude/CLAUDE.md` (outside the managed block) already keeps you on the live
file. When the installer sees one, its block carries only the Claude appendix plus a line
saying where the snippet came from — a second, inlined copy would both double the tokens and
freeze a snapshot that goes stale the next time the snippet changes. The dry run says so
explicitly before you apply. Delete the import and the next run puts the snippet back;
`--uninstall` removes the block either way and never touches your import line.

Only a directive Claude Code would really follow, to really this file, counts. It has to be
a line whose first non-blank character is `@` (up to three spaces of indent), outside any
code fence or indented code block — so documenting the import inside your own instructions
does not count as having it. And the path has to resolve to this checkout's snippet:
absolute, `~/…` or relative (relative to the directory of the file holding the line, as
Claude Code resolves it), through symlinks and `..` if you like. A stale path left behind
when the checkout moved, a URL, a different file that merely ends in the same name, or
anything else that fails to resolve all inline instead — a duplicate is only wasteful,
whereas trusting a broken import would leave you with no reporting instructions at all.

</details>

<details>
<summary><strong>GitHub Copilot CLI</strong></summary>

The installer writes the shared [`reporting-snippet.md`](reporting-snippet.md) plus
[`instructions/copilot-cli.md`](instructions/copilot-cli.md) to
`~/.copilot/copilot-instructions.md`. Copilot questions return an exact-item detached
watcher command; its background completion wakes the owning session.

Copilot CLI has no import mechanism, so the snippet is **always** inlined here — an `@path`
line in `copilot-instructions.md` is inert text, not a live reference. Re-run the installer
after the snippet changes to pick the new text up.

</details>

### Manual MCP registration

**Claude Code:**
```sh
claude mcp add --scope user agent-inbox -- node /ABSOLUTE/PATH/TO/agent-inbox/dist/mcp-server.js
```

> **Node 24 required.** `better-sqlite3`'s native binding does not build/load under Node 26+, so the server must be spawned with Node 24. If your default `node` is newer, register the **absolute path to your Node 24 binary** instead of bare `node`, e.g. `$(fnm exec --using=24 -- node -p process.execPath 2>/dev/null || echo ~/.local/share/fnm/node-versions/v24.*/installation/bin/node)`. (There is no `fnm which` — fnm answers `unrecognized subcommand 'which'`, so that form silently falls through to the glob.)

**Copilot CLI:**
```sh
copilot mcp add agent-inbox -- /ABSOLUTE/PATH/TO/NODE24 /ABSOLUTE/PATH/TO/agent-inbox/dist/mcp-server.js
```

Verify: in a repo, run the agent and call the `whoami` tool — it should report that repo's project and branch.

## 3. Run the viewer
```sh
npm run view   # http://localhost:4319
```
Leave it running (or wrap as a login item / Electron app later).

## 4. Add instructions manually (only if you skipped the installer)

Paste `docs/reporting-snippet.md` plus the matching file under `docs/instructions/` into
the host's global instructions. The installer is preferred because it can update its
marked block idempotently without duplicating or overwriting personal instructions.

## 5. Optional: the backstop hooks (issues #10 / #21)

Deterministic, no-AI Claude Code hooks that (a) raise an inbox item when a session sits blocked at a permission prompt and the agent never flagged it, and (b) bounce an idle agent back to work the moment you answer one of its questions. Full contract in [`docs/hooks.md`](hooks.md).

```sh
npm run install:hooks                         # DRY RUN — prints what it would write, changes nothing
npm run install:hooks -- --apply              # write it (timestamped backup of ~/.claude/settings.json first)
npm run install:hooks -- --apply --migrate    # also retire the older hand-written agent-inbox-*.sh Stop hooks
npm run install:hooks -- --apply --uninstall  # remove every agent-inbox entry again
```

Requires `jq`. Nothing about this runs from `npm install`, `npm run build` or the Electron app, and new hook registrations are picked up only on a **fresh** Claude Code session.

> **Node 24, again.** The installer resolves a Node 24 binary, **proves it** by running `dist/hook-cli.js selftest`, and only then bakes the absolute path into `settings.json`. It refuses to write if that fails. Do not hand-write `"command": "node"` — a hook spawned under Node 26 cannot load `better-sqlite3` and dies silently on every invocation, forever. Override the choice with `AGENT_INBOX_NODE=/abs/path/to/node24`.

To turn the hooks off without uninstalling them, set `AGENT_INBOX_HOOKS=0` in your environment.
