// The agent kit's example (#539; docs/agent-kit.md): one skill, `echo`, that returns the message
// in upper case and contacts nothing. It is the smallest agent `meshctl check --strict` accepts at
// the publishable level once `meshctl key create echo --apply` has given it a key, and CI proves
// it (packages/mesh/test/kit.test.ts). Run it from packages/mesh after `npm run build`:
//   node dist/examples/echo/agent.js --port 4500 --token-file ~/echo.token
import { fileURLToPath } from 'node:url'
import { ConfigError } from '../../files.js'
import { meshCard, readToken, startKitAgent } from '../../kit/index.js'
import type { KitAgent, Run } from '../../kit/index.js'
import { meshDir } from '../../mesh-config.js'

type Json = Record<string, unknown>
const MAX_CHARS = 4000

/** Nothing per copy but the interface URL and the keys this copy signs with. */
export const echoCard = (url: string, keys: Json[]): Json => meshCard({
  name: 'echo', description: 'An example agent built with the agent-inbox agent kit: it returns your message in upper case.', version: '1.0.0',
  provider: { organization: 'agent-inbox', url: 'https://shariqh.github.io/agent-inbox/' },
  id: 'shariqh.github.io/agent-inbox/examples/echo', streaming: true,
  inputModes: ['text/plain'], outputModes: ['text/plain'],
  skills: [{ id: 'echo', name: 'echo', description: 'Returns the message text in upper case.', tags: ['example', 'text'], egress: 'none', residency: 'any' }],
}, url, keys)

export const echo: Run = async (input, _options, _signal, onState) => {
  if (!input.trim() || input.length > MAX_CHARS) return { state: 'rejected', reason: 'empty-or-too-long' }
  onState('echoing')
  return { state: 'completed', text: input.toUpperCase() }
}

/** `--port <1-65535> --token-file <path>`: 0 when it stops on a signal, 1 when it refuses to start or fails, 4 on a usage error. */
export async function main(args: string[], env: NodeJS.ProcessEnv, write: (text: string) => void): Promise<number> {
  const flag = (name: string): string | undefined => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined)
  const port = Number(flag('--port'))
  const tokenFile = flag('--token-file')
  if (args.length !== 4 || !Number.isInteger(port) || port < 1 || port > 65535 || !tokenFile) {
    write('usage: echo --port <1-65535> --token-file <path>\n')
    return 4
  }
  let agent: KitAgent
  try {
    // startKitAgent installs the output guard, its lines to `write`, before the port opens
    agent = await startKitAgent({ agent: 'echo', meshDir: meshDir(env), port, token: readToken(tokenFile), card: echoCard, run: echo, write: (line) => write(`${line}\n`) })
  } catch (error) {
    write(`echo: ${error instanceof ConfigError ? error.message : 'internal error'}\n`)
    return 1
  }
  write(`echo: listening on ${agent.url}\n`)
  await new Promise<void>((resolve) => { for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => resolve()) })
  await agent.stop()
  write('echo: stopped\n')
  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2), process.env, (text) => process.stderr.write(text)))
