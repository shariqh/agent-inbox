#!/usr/bin/env node
// agent-inbox-wrap (#483, unslop design §4.1): `--agent openai-compatible
// --profile unslop` runs the unslop agent on the loopback endpoint mesh.json
// names. Exit 0 when it stops (idle, mesh.json key gone, a signal), 1 when it
// refuses to start, 4 on a usage error. Nothing it prints holds task text.
import { main } from './agent.js'

process.exit(await main(process.argv.slice(2), process.env, (text) => process.stderr.write(text)))
