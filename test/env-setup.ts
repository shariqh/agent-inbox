// test/env-setup.ts — Vitest setupFile (#617): no test starts with the developer's tmux in its
// environment. A suite run inside tmux inherits TMUX and TMUX_PANE, and an MCP server a test builds
// or spawns reads them to find its tmux session, which starts the developer's real `tmux`. A test
// that wants them sets them itself, on a server it controls (test/session-place.test.ts,
// test/mcp.integration.test.ts); readers that touch nothing are test/quiet-place.ts.
//
// Deliberately NOT named *.test.ts: it is loaded by vitest.config.ts, never collected.
delete process.env['TMUX']
delete process.env['TMUX_PANE']
