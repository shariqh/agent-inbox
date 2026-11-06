#!/usr/bin/env node
// agent-inbox-wrap (#483, unslop design §4.1): `--agent openai-compatible
// --profile unslop` runs the unslop agent on the loopback endpoint mesh.json
// names. Exit 0 when it stops (idle, mesh.json key gone, a signal), 1 when it
// refuses to start, 4 on a usage error. Nothing it prints holds task text.
import { startAgent } from './agent.js'
import { meshDir } from './mesh-config.js'

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
if (args.length !== 4 || flag('--agent') !== 'openai-compatible' || !flag('--profile')) {
  process.stderr.write('usage: agent-inbox-wrap --agent openai-compatible --profile unslop\n')
  process.exit(4)
}
try {
  const agent = await startAgent({ meshDir: meshDir(), profile: flag('--profile')! })
  process.stderr.write(`agent-inbox-wrap: unslop listening on http://127.0.0.1:${agent.port}\n`)
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => void agent.stop('signal'))
  process.stderr.write(`agent-inbox-wrap: stopped (${await agent.exited})\n`)
  process.exit(0)
} catch (error) {
  process.stderr.write(`agent-inbox-wrap: ${(error as Error).message}\n`)
  process.exit(1)
}
