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
