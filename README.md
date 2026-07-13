# agent-inbox

A durable, cross-project, cross-tool "what needs my attention" inbox for coding agents.

Agents (Claude Code, Copilot CLI) write to it themselves over MCP — one `flag` tool,
called mid-work — so open questions and easily-missed notes stop scrolling past in the
CLI firehose. A local viewer shows the whole cross-project inbox grouped by
*Needs you* / *Notes*. No second AI: the tool is a store + a viewer + a thin MCP server.

Design: [`docs/superpowers/specs/2026-07-12-agent-inbox-design.md`](docs/superpowers/specs/2026-07-12-agent-inbox-design.md).

Status: v1 shipped — local stdio MCP inbox (`flag`/`resolve`/`register`/`whoami`) + web viewer. See [Install & register](docs/INSTALL.md).

## Setup
- [Install & register](docs/INSTALL.md)
- [Reporting snippet for agents](docs/reporting-snippet.md)
