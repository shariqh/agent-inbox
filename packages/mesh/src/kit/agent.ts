// One standalone kit agent (docs/agent-kit.md): its keys read and its card signed once, before
// the port opens, then the front door over the kit's executor. An agent with its own lifecycle
// (web search's mesh.json gate and idle exit) wires the same pieces itself.
import { loadSigningKeys } from '../card-signing.js'
import { ConfigError, readPrivate } from '../files.js'
import { servedCard } from './card.js'
import { createExecutor } from './executor.js'
import type { Run } from './executor.js'
import { startFrontDoor } from './front-door.js'
import type { RequestSpec } from './front-door.js'

type Json = Record<string, unknown>

/** The bearer token in `path` (a 0600 file you own), at least 32 printable characters. */
export function readToken(path: string): string {
  const token = readPrivate(path).trim()
  if (!/^[\x21-\x7E]{32,}$/.test(token)) throw new ConfigError('the token must be at least 32 printable characters')
  return token
}

export type KitAgentOptions = {
  /** The agent's name: its key files are `<mesh dir>/mesh/keys/<agent>.jwk` (and `-next.jwk`), from `meshctl key create <agent>`. */
  agent: string
  meshDir: string
  /** 0 picks a free port. */
  port: number
  token: string
  /** The card at `url` listing `keys`, usually `meshCard(spec, url, keys)`. */
  card: (url: string, keys: Json[]) => Json
  run: Run
  request?: RequestSpec
  proofLabel?: string
  log?: (entry: Json) => void
}
export type KitAgent = { port: number; url: string; open(): number; stop(): Promise<void> }

export async function startKitAgent(o: KitAgentOptions): Promise<KitAgent> {
  // a key file that breaks a rule stops the start before the port opens; none serves the card unsigned
  const keys = loadSigningKeys(o.meshDir, o.agent)
  const executor = createExecutor(o.run, o.log ?? (() => {}), { artifact: o.agent, extension: o.request?.extensions[0] })
  const door = await startFrontDoor({
    port: o.port, tokens: [o.token], executor, busy: () => executor.open() > 0, request: o.request, proofLabel: o.proofLabel,
    card: (url) => servedCard((listed) => o.card(url, listed), keys),
  })
  return {
    port: door.port, url: door.url, open: () => executor.open(),
    stop: async () => {
      executor.failAll('agent-stopped')
      await door.close()
    },
  }
}
