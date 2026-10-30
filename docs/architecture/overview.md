---
paths:
  - "src/mcp-server.ts"
  - "src/viewer-server.ts"
  - "src/prstate.ts"
  - "src/issue-poller.ts"
  - "src/stamp.ts"
  - "src/agent-hosts.ts"
  - "src/issue-graph.ts"
  - "src/hook-cli.ts"
  - "src/watch-cli.ts"
  - "public/issue-key.js"
  - "scripts/stage-runtime.mjs"
applyTo: "src/mcp-server.ts,src/viewer-server.ts,src/prstate.ts,src/issue-poller.ts,src/stamp.ts,src/agent-hosts.ts,src/issue-graph.ts,src/hook-cli.ts,src/watch-cli.ts,public/issue-key.js,scripts/stage-runtime.mjs"
---

# Architecture overview and process boundaries

The processes, what each may import, and where the boundaries between them sit.

Moved out of `CLAUDE.md` and `.github/copilot-instructions.md` by #379, nearly verbatim. Claude Code and Copilot CLI load this file automatically when they read or edit a file matching the `paths`/`applyTo` globs above (through the symlinks in `.claude/rules/` and `.github/instructions/`); anyone else should read it before changing those files.

## In brief

- **Shared data hub:** `src/store.ts` owns the schema, migrations, WAL connection,
  and every database read/write. The default database is
  `~/.agent-inbox/inbox.db`; `AGENT_INBOX_DB` overrides it.
- **Agent path:** `src/mcp-server.ts` opens the store and connects
  `buildMcpServer()` from `src/mcp.ts` over stdio. `src/scope.ts` and
  `src/infer.ts` lazily infer project, branch, client, GitHub repo, and issue
  identity. One long-lived server process represents a CLI process; parent and
  subagents may share its session id and context-delivery ledger.
- **Human path:** `src/viewer-server.ts` creates the Hono API in `src/viewer.ts`,
  starts the viewer-only PR poller, and serves `public/`. The frontend is native
  browser ESM with no bundler. Electron stages `dist/`, `public/`, and `electron/`
  and rebuilds `better-sqlite3` for Electron's ABI.
- **Strict process boundaries:** `src/prstate.ts`, `src/issue-poller.ts` (#103)
  and `src/stamp.ts` are viewer-process concerns; they must not enter the MCP
  import graph. The two `gh` pollers share one tick (issues first, then PRs
  with a 45-second start deadline) and one busy guard.
  `src/shape.ts` trims agent-facing MCP read payloads and must not affect viewer
  API payloads. `src/hook.ts`/`hook-cli.ts` and `src/watch.ts`/`watch-cli.ts` are
  separate host adapters that still access data through `store.ts`.
  `src/agent-hosts.ts` (#197) is viewer-process-only and read-only: it keeps only
  the `agent-inbox` entry of each host config (and agent-inbox hook entries), never
  returns or logs anything else, and never spawns a process — not even a host CLI.
  Its runtime rule must stay the installer's ownership rule; a test pins agreement.
  `src/issue-graph.ts` and `public/issue-key.js` (#103) are pure; the MCP server
  admits them (with `public/source.js`/`esc.js`) only for the titled `board_get`
  `issue_rel` summary, and a test pins the transitive stdio MCP import graph.
  `scripts/stage-runtime.mjs` stages the `public/` modules `dist/` reaches, so a
  runtime payload can load them. Every shipped `node_modules` copy is pruned by
  `scripts/prune-node-modules.mjs` before it is tested, manifested or signed
  (#291): better-sqlite3 keeps only `package.json`, `lib/` and its addon, every
  package loses typings, source maps and markdown, and license and notice files
  always stay. The thin-app gates refuse an unpruned copy, and the macOS runtime
  signing list is exactly `bin/node` and the addon. Every package ships only US and
  British English Electron locales (#292): `scripts/prune-electron-locales.mjs` keeps
  `en.lproj` and `en_GB.lproj` on macOS and `locales/en-US.pak` and `en-GB.pak` on Linux
  and Windows, once, right after `@electron/packager` and before anything checks, hashes
  or signs the app; the thin-app, assembly and final-DMG gates refuse an app with any
  other locale, without either of those, or reaching either through a linked folder.
  Electron seeds a new profile's spellchecker from that locale, so on Linux and Windows
  `electron/spellcheck-languages.cjs` sets the system's languages at startup on a profile
  with none in the system's first language (a seeded `en-GB` for Commonwealth English
  users stays); macOS keeps its own `NSSpellChecker`. The Linux folder gate (which the
  DEB and AppImage verifiers re-run on their extracted inner apps) and the macOS thin,
  signed-app and final-DMG gates refuse any group- or other-writable entry and any
  setuid, setgid or sticky bit (#378, `scripts/tree-modes.mjs`); only a package's
  extracted `chrome-sandbox` may be `04755`.
