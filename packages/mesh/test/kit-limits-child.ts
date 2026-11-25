// Child process for the kit's limits test (made agents D2): a kit agent started with the body limit
// in KIT_BODY_MAX (none: the default) whose run answers with the input's length, and which writes
// `idle <ms>`, its startKitAgent idleMs(), to stderr on each SIGUSR2.
import { echoCard } from '../src/examples/echo/agent.js'
import { startKitAgent } from '../src/kit/index.js'

const bodyMax = process.env['KIT_BODY_MAX'] ? Number(process.env['KIT_BODY_MAX']) : undefined
const agent = await startKitAgent({
  agent: 'echo', meshDir: process.env['AGENT_INBOX_MESH_DIR']!, port: 0, token: process.env['KIT_TOKEN']!, card: echoCard,
  run: async (input) => ({ state: 'completed', text: String(input.length) }), ...(bodyMax === undefined ? {} : { bodyMax }),
})
process.on('SIGUSR2', () => process.stderr.write(`idle ${agent.idleMs()}\n`))
process.stderr.write(`kit: listening on ${agent.url}\n`)
