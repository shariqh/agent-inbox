// One standalone kit agent (docs/agent-kit.md): its token checked, the output guard installed,
// its keys read and its card signed once, all before the port opens, then the front door over the
// kit's executor. An agent with its own lifecycle (web search's mesh.json gate and idle exit)
// wires the same pieces itself, guard included.
import { loadSigningKeys } from '../card-signing.js'
import { ConfigError, readPrivate } from '../files.js'
import { servedCard } from './card.js'
import { createExecutor } from './executor.js'
import type { Executor, Run } from './executor.js'
import { startFrontDoor } from './front-door.js'
import type { RequestSpec } from './front-door.js'
import { guardOutput } from './guard.js'

type Json = Record<string, unknown>
const TOKEN = /^[\x21-\x7E]{32,}$/
const SHORT_TOKEN = 'the token must be at least 32 printable characters'

/** The bearer token in `path` (a 0600 file you own), at least 32 printable characters. */
export function readToken(path: string): string {
  const token = readPrivate(path).trim()
  if (!TOKEN.test(token)) throw new ConfigError(SHORT_TOKEN)
  return token
}

export type KitAgentOptions = {
  /** The agent's name: its key files are `<mesh dir>/mesh/keys/<agent>.jwk` (and `-next.jwk`), from `meshctl key create <agent>`. */
  agent: string
  meshDir: string
  /** 0 picks a free port. */
  port: number
  /** At least 32 printable characters; `readToken` reads one from a file. */
  token: string
  /** The card at `url` listing `keys`, usually `meshCard(spec, url, keys)`. */
  card: (url: string, keys: Json[]) => Json
  run: Run
  request?: RequestSpec
  proofLabel?: string
  log?: (entry: Json) => void
  /** Where the output guard's fixed lines go, one per call without a newline; stderr by default. */
  write?: (line: string) => void
}
export type KitAgent = { port: number; url: string; open(): number; stop(): Promise<void> }

// The guard is per process: the first start installs it, and an uncaught error fails every
// running agent's open tasks with the fixed reason "internal", then exits 1.
const running = new Set<Executor>()
let guarded = false

export async function startKitAgent(o: KitAgentOptions): Promise<KitAgent> {
  if (!TOKEN.test(o.token)) throw new ConfigError(SHORT_TOKEN)
  if (!guarded) {
    guarded = true
    guardOutput(o.write ?? ((line) => process.stderr.write(`${line}\n`)), () => {
      try {
        for (const executor of running) executor.failAll('internal')
      } finally {
        setTimeout(() => process.exit(1), 100)
      }
    })
  }
  // a key file that breaks a rule stops the start before the port opens; none serves the card unsigned
  const keys = loadSigningKeys(o.meshDir, o.agent)
  const executor = createExecutor(o.run, o.log ?? (() => {}), { artifact: o.agent, extension: o.request?.extensions[0] })
  const door = await startFrontDoor({
    port: o.port, tokens: [o.token], executor, busy: () => executor.open() > 0, request: o.request, proofLabel: o.proofLabel,
    card: (url) => servedCard((listed) => o.card(url, listed), keys),
  })
  running.add(executor)
  return {
    port: door.port, url: door.url, open: () => executor.open(),
    stop: async () => {
      running.delete(executor)
      executor.failAll('agent-stopped')
      await door.close()
    },
  }
}
