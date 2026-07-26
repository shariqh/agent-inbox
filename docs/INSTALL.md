# Install

## 1. Build
```sh
npm install && npm run build
```

## 2. Register the MCP server at user scope (once, applies to every repo)

**Claude Code:**
```sh
claude mcp add --scope user agent-inbox -- node /ABSOLUTE/PATH/TO/agent-inbox/dist/mcp-server.js
```

> **Node 24 required.** `better-sqlite3`'s native binding does not build/load under Node 26+, so the server must be spawned with Node 24. If your default `node` is newer, register the **absolute path to your Node 24 binary** instead of bare `node`, e.g. `$(fnm which 24 2>/dev/null || echo ~/.local/share/fnm/node-versions/v24.*/installation/bin/node)`.

**Copilot CLI:** add to its global MCP config (`~/.copilot/mcp-config.json`):
```json
{
  "mcpServers": {
    "agent-inbox": { "command": "node", "args": ["/ABSOLUTE/PATH/TO/agent-inbox/dist/mcp-server.js"] }
  }
}
```

Verify: in a repo, run the agent and call the `whoami` tool — it should report that repo's project and branch.

## 3. Run the viewer
```sh
npm run view   # http://localhost:4319
```
Leave it running (or wrap as a login item / Electron app later).

## 4. Add the reporting snippet
Paste `docs/reporting-snippet.md` into your global agent instructions (`~/.claude/CLAUDE.md` and Copilot's global instructions) so agents know *when* to flag.

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
