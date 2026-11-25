// Child process for the made-agent runner's gate tests (made agents D2): startMade with the gate
// ticking every MADE_GATE_MS and, when MADE_IDLE_MS is set, that idle limit. Only the runner's own
// fixed lines and the kit's guard reach stderr.
import { startMade } from '../src/made-agent.js'

const env = process.env
const made = await startMade({
  meshDir: env['AGENT_INBOX_MESH_DIR']!, id: env['MADE_ID']!,
  every: (_ms, fn) => { const timer = setInterval(fn, Number(env['MADE_GATE_MS'])); return () => clearInterval(timer) },
  ...(env['MADE_IDLE_MS'] ? { idleLimitMs: Number(env['MADE_IDLE_MS']) } : {}),
})
process.stderr.write(`made: listening on http://127.0.0.1:${made.port}/\n`)
process.stderr.write(`made: stopped (${await made.exited})\n`)
