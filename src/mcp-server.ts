#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { openDb } from './store.js'
import { buildMcpServer } from './mcp.js'
import { parseServerArgs } from './scope.js'

// #641: `--project <name>` fixes every session of this registration to one
// project. Anything else fails closed before the database opens or the
// transport connects, so nothing is ever written under an inferred project;
// the host shows the server as failed. No environment variable is read.
// scripts/install-agents.sh looks for the flag's name in this file before it
// registers an entry with it, so USAGE names it in code, not only in a comment.
const USAGE = 'usage: mcp-server.js [--project <name>]'
const args = parseServerArgs(process.argv.slice(2))
if ('error' in args) {
  process.stderr.write(`agent-inbox: ${args.error} (${USAGE})\n`)
  process.exit(1)
}
const db = openDb()
const server = buildMcpServer(db, process.cwd(), args.fixedProject === undefined ? {} : { fixedProject: args.fixedProject })
const transport = new StdioServerTransport()
await server.connect(transport)
