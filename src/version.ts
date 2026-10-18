// The Agent Inbox release version, in one place (issue #197).
//
// The MCP server reports it in its initialize handshake AND records it on its
// Live presence row; a checkout's viewer compares sessions against it. A release
// bumps this line together with package.json — test/release-pipeline.test.ts
// pins the two to each other.
//
// A leaf module on purpose: no imports, so both the stdio MCP graph and the
// viewer can read it without pulling either one's dependencies into the other.
export const AGENT_INBOX_VERSION = '1.3.1'
