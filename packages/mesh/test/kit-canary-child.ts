// Child process for the kit's canary test (#539): a kit agent whose run tries to leak its input
// through console calls, a warning, a thrown error and a rejected promise nobody awaits. Only
// `startKitAgent` guards the output here; this file installs nothing of its own.
import { echoCard } from '../src/examples/echo/agent.js'
import { startKitAgent } from '../src/kit/index.js'
import type { Run } from '../src/kit/index.js'

const never = new Promise<never>(() => {})
const run: Run = async (input) => {
  const kind = input.split(' ')[0]
  if (kind === 'console') {
    console.error('run failed on', new Error(input))
    console.warn(input)
    console.log({ input })
    process.emitWarning(input)
    return { state: 'completed', text: 'ok' }
  }
  if (kind === 'throw') throw new Error(`stage failed on ${input}`)
  if (kind === 'reject') {
    void Promise.reject(new Error(input))
    return never
  }
  return { state: 'completed', text: input.toUpperCase() }
}

const agent = await startKitAgent({ agent: 'echo', meshDir: process.env['AGENT_INBOX_MESH_DIR']!, port: 0, token: process.env['KIT_TOKEN']!, card: echoCard, run })
process.stderr.write(`kit: listening on ${agent.url}\n`)
