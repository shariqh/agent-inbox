#!/usr/bin/env node
// agent-inbox-wrap (#483, unslop design §4.1; web search design §2.1): `--agent
// openai-compatible --profile unslop` runs the unslop agent and `--agent web-search
// --profile web-search` the web search agent, each on the loopback endpoint
// mesh.json names. Each agent is loaded only for its own `--agent`, so unslop's
// start never loads `@a2a-js/sdk`. Exit 0 when it stops (idle, mesh.json key
// gone, a signal), 1 when it refuses to start, 4 on a usage error. Nothing it
// prints holds task text.
const args = process.argv.slice(2)
const agent = args.indexOf('--agent') >= 0 ? args[args.indexOf('--agent') + 1] : undefined
const { main } = agent === 'web-search' ? await import('./web-search/agent.js') : await import('./agent.js')

process.exit(await main(args, process.env, (text) => process.stderr.write(text)))
