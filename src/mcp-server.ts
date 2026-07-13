#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { openDb } from './store.js'
import { buildMcpServer } from './mcp.js'

const db = openDb()
const server = buildMcpServer(db, process.cwd())
const transport = new StdioServerTransport()
await server.connect(transport)
