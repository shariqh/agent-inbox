// The unslop and unslop-code agent process (#483, unslop design §4.2-§4.5, §7.2),
// one agent per process, chosen by `--profile`: reads its private files, refuses to
// start unless mesh.json's `agents.<profile>` names a loopback endpoint, serves A2A there, and exits within one minute of that key
// going or the caller token changing (a disable and enable writes a new one, which
// this process would otherwise refuse until it stopped), or after 30 idle minutes. A profile
// names its model backend inline (`baseUrl`, `apiKey`) or by a model server's name (`server`, an
// entry of mesh/servers.json, model servers step 1): such an agent also stops within a minute of
// that entry changing or going, so its next call starts it with the new settings. An inline
// profile's agent never reads servers.json. Every path derives from the mesh dir. The
// log gets one JSON line per task with sizes, timings and classes: never text,
// never a matched value, never the token or the API key.
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { startServer } from './a2a.js'
import type { Skill } from './a2a.js'
import { checkBaseUrl } from './backend.js'
import type { Post, Sampling } from './backend.js'
import { ConfigError, appendPrivate, localDate, readPrivate, writePrivate } from './files.js'
import { fixed, home, readApiKey, strings } from './key-source.js'
import type { KeySource } from './key-source.js'
import { SERVER_NAME, isClaudeServer, meshDir, meshFile, readMesh, readServers } from './mesh-config.js'
import type { ServerEntry, ServersRead } from './mesh-config.js'
import { createRulesLoader } from './rules.js'
import { codeSkill, unslopSkill } from './skills.js'
import { runUnslop } from './unslop.js'
import { runCodeSlop } from './unslop-code.js'

export const GATE_MS = 60_000
export const IDLE_MS = 30 * 60_000
const DAILY_TASKS = 200
const DAILY_MODEL_MS = 180 * 60_000

type BackendProfile = { baseUrl: string; apiKey?: KeySource; model?: string; sampling?: Partial<Sampling> }
type Profile = BackendProfile & { skill: string; terms?: string[]; allowEmails?: string[]; customerPaths?: string[] }
export type StopReason = 'mesh.json' | 'token' | 'server' | 'idle' | 'signal'
export type AgentOptions = {
  meshDir: string
  profile: string
  env?: NodeJS.ProcessEnv
  now?: () => number
  every?: (ms: number, fn: () => void) => () => void
  post?: Post
}
export type Agent = { port: number; exited: Promise<StopReason>; stop(reason: StopReason): Promise<void> }

/** The port of `agents.<name>.endpoint`, which must be http://127.0.0.1:<port>. */
export function endpointPort(dir: string, name: AgentName = 'unslop'): number {
  const read = readMesh(meshFile(dir))
  if (read.kind !== 'present') throw new ConfigError(`mesh.json is missing or unreadable: run meshctl enable --${name}`)
  const agents = (read.doc as { agents?: Record<string, { endpoint?: unknown } | undefined> }).agents
  const endpoint = agents && Object.hasOwn(agents, name) ? agents[name]?.endpoint : undefined
  if (endpoint === undefined) throw new ConfigError(`mesh.json has no agents.${name}: run meshctl enable --${name}`)
  const port = Number(/^http:\/\/127\.0\.0\.1:(\d{1,5})\/?$/.exec(String(endpoint))?.[1])
  // port 80 is out: clients drop `:80` from Host, and the Host check is exact
  if (!(port >= 1 && port <= 65535) || port === 80) throw new ConfigError(`agents.${name}.endpoint must be http://127.0.0.1:<port>`)
  return port
}

function parseJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T
  } catch {
    throw new ConfigError('the profile is not valid JSON')
  }
}

// fixed words for a refused servers.json, as src/mesh-config.ts's SERVERS_REASONS words them
const SERVERS_REFUSED: Record<Extract<ServersRead, { kind: 'refused' }>['reason'], string> = {
  'not-regular': 'is not a regular file', 'not-private': 'is not a file you own that only you can read', 'too-large': 'is too large',
  unreadable: 'cannot be read', 'not-json': 'is not valid JSON', 'not-object': 'is not a JSON object', 'no-schema': 'has no valid "schema"',
  'newer-schema': 'was written by a newer Agent Inbox', 'unknown-key': 'holds a key this build does not know', 'no-servers': 'has no "servers" object',
  'too-many': 'holds too many servers', 'bad-name': 'holds a bad server name', 'bad-entry': 'holds a server that is not an object',
  'bad-kind': 'holds a kind this build does not know', 'bad-base-url': 'holds a bad baseUrl', 'bad-api-key': 'holds a bad apiKey',
}

/** The entry of the model server `server` in mesh/servers.json; a refusal names the server, never a value. */
function serverEntry(dir: string, server: string): ServerEntry {
  const read = readServers(dir)
  if (read.kind === 'missing') throw new ConfigError(`the profile names the server ${server}, but mesh/servers.json is missing: run meshctl server add ${server}`)
  if (read.kind === 'refused') throw new ConfigError(`the profile names the server ${server}, but mesh/servers.json ${SERVERS_REFUSED[read.reason]}: run meshctl server list`)
  if (!Object.hasOwn(read.servers, server)) throw new ConfigError(`the profile names the server ${server}, which mesh/servers.json does not hold: run meshctl server list`)
  return read.servers[server]!
}
/** What the gate compares: the entry's address and key source, or its kind. */
const entryKey = (entry: ServerEntry): string => JSON.stringify(isClaudeServer(entry) ? ['claude-code'] : [entry.baseUrl, entry.apiKey ?? null])

/** Resolves the server a profile names (startAgent records what it resolved, for the gate). */
type Lookup = (server: string) => ServerEntry

/**
 * The backend a profile names: either `server` (a model server's name) or the inline `baseUrl`
 * with its optional `apiKey`, never both and never neither. The error names the profile and the rule.
 */
function backendOf(p: BackendProfile & { server?: unknown }, agent: AgentName, lookup: Lookup): { baseUrl: string; apiKey?: KeySource } {
  const named = Object.hasOwn(p, 'server')
  if (named && (Object.hasOwn(p, 'baseUrl') || Object.hasOwn(p, 'apiKey'))) {
    throw new ConfigError(`the ${agent} profile holds both \`server\` and an inline \`baseUrl\` or \`apiKey\`: keep one (meshctl enable --${agent} --server <name> rewrites it)`)
  }
  if (named) {
    if (typeof p.server !== 'string' || !SERVER_NAME.test(p.server)) throw new ConfigError(`the ${agent} profile's \`server\` is not a server name`)
    const entry = lookup(p.server)
    if (isClaudeServer(entry)) throw new ConfigError(`the ${agent} profile names the server ${p.server}, which is Claude Code on this Mac: this build cannot use it`)
    return entry
  }
  if (typeof p.baseUrl !== 'string') throw new ConfigError(`the ${agent} profile needs a \`baseUrl\` or a \`server\``)
  fixed(() => checkBaseUrl(p.baseUrl))
  return { baseUrl: p.baseUrl, apiKey: p.apiKey }
}

function parseProfile(text: string, lookup: Lookup): Profile {
  const p = parseJson<Profile>(text)
  if (!p || typeof p !== 'object' || typeof p.skill !== 'string' || !isAbsolute(home(p.skill))) throw new ConfigError('the profile needs an absolute `skill` folder')
  const backend = backendOf(p, 'unslop', lookup)
  for (const key of ['terms', 'allowEmails', 'customerPaths'] as const) if (p[key] !== undefined && !strings(p[key])) throw new ConfigError(`the profile's \`${key}\` must be a list of strings`)
  return { ...p, baseUrl: backend.baseUrl, apiKey: backend.apiKey, skill: home(p.skill) }
}

function createBudget(file: string, now: () => number): { take(): boolean; spend(ms: number): void } {
  let state = { date: '', tasks: 0, modelMs: 0 }
  try {
    const saved = JSON.parse(readPrivate(file, true) ?? '{}') as typeof state
    if (typeof saved.date === 'string' && Number.isFinite(saved.tasks) && Number.isFinite(saved.modelMs)) state = saved
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
  }
  const roll = (): void => {
    const date = localDate(now())
    if (state.date !== date) state = { date, tasks: 0, modelMs: 0 }
  }
  return {
    take: () => {
      roll()
      if (state.tasks >= DAILY_TASKS || state.modelMs >= DAILY_MODEL_MS) return false
      state.tasks++
      writePrivate(file, JSON.stringify(state))
      return true
    },
    spend: (ms) => {
      roll()
      state.modelMs += ms
      writePrivate(file, JSON.stringify(state))
    },
  }
}

/** What a profile's agent needs once its profile, port and token are read. */
type Context = { root: string; env: NodeJS.ProcessEnv; now: () => number; post?: Post; log: (entry: object) => void }
/** Per agent: parse its profile (first, so a bad profile is reported before the token), then build its skill. */
type AgentDef = (profileText: string, lookup: Lookup) => (c: Context) => Skill<any, any>

const AGENTS = {
  unslop: (text, lookup) => {
    const profile = parseProfile(text, lookup)
    return ({ root, env, now, post, log }) => {
      const denyFile = join(root, 'unslop-deny.txt')
      readPrivate(denyFile, true)
      const apiKey = readApiKey(profile.apiKey, env)
      const loadRules = createRulesLoader(profile.skill)
      let rules = fixed(loadRules)
      let loadedAt = new Date(now()).toISOString()
      const currentRules = (): ReturnType<typeof loadRules> => {
        const next = loadRules()
        if (next.sha256 !== rules.sha256) loadedAt = new Date(now()).toISOString()
        rules = next
        return next
      }
      return unslopSkill({
        rules: () => {
          const r = currentRules()
          return { rulesSha256: r.sha256, bytes: Buffer.byteLength(r.text), loadedAt }
        },
        run: async (task, onState) => {
          const r = currentRules()
          const deny = readPrivate(denyFile, true) ?? ''
          const result = await runUnslop(task, {
            profile: {
              baseUrl: profile.baseUrl, apiKey, model: profile.model, sampling: profile.sampling, terms: profile.terms,
              screen: { deny, allowEmails: profile.allowEmails, customerPaths: profile.customerPaths },
            },
            rules: r, post, now, log, onState,
          })
          return r.stale ? { ...result, skillStale: true } : result
        },
      })
    }
  },
  // no skill folder, no deny list and no rules: its questions are built in (src/code-prompt.ts)
  'unslop-code': (text, lookup) => {
    const p = parseJson<BackendProfile>(text)
    if (!p || typeof p !== 'object') throw new ConfigError('the unslop-code profile needs a `baseUrl` or a `server`')
    const backend = backendOf(p, 'unslop-code', lookup)
    return ({ env, now, post, log }) => {
      const apiKey = readApiKey(backend.apiKey, env)
      const profile = { baseUrl: backend.baseUrl, apiKey, model: p.model, sampling: p.sampling }
      return codeSkill({ run: (task, onState) => runCodeSlop(task, { profile, post, now, log, onState }) })
    }
  },
} satisfies Record<string, AgentDef>
export type AgentName = keyof typeof AGENTS
export const isAgentName = (name: string): name is AgentName => Object.hasOwn(AGENTS, name)

export async function startAgent(o: AgentOptions): Promise<Agent> {
  const name = o.profile
  if (!isAgentName(name)) throw new ConfigError('the profiles are unslop and unslop-code')
  const now = o.now ?? Date.now
  const env = o.env ?? process.env
  const port = endpointPort(o.meshDir, name)
  const root = join(o.meshDir, 'mesh')
  // only a profile that names a server reads servers.json, and the gate re-reads only that entry
  let named: { server: string; key: string } | undefined
  const lookup: Lookup = (server) => {
    const entry = serverEntry(o.meshDir, server)
    named = { server, key: entryKey(entry) }
    return entry
  }
  const build: ReturnType<AgentDef> = AGENTS[name](readPrivate(join(root, 'wrappers', `${name}.json`)), lookup)
  const tokenFile = join(root, 'tokens', name)
  const token = readPrivate(tokenFile).trim()
  if (!/^[\x21-\x7E]{32,}$/.test(token)) throw new ConfigError('the token must be at least 32 printable characters')
  const log = (entry: object): void => {
    try {
      appendPrivate(join(root, 'logs', `${name}-${localDate(now())}.log`), JSON.stringify({ at: new Date(now()).toISOString(), ...entry }))
    } catch {
      process.stderr.write('agent-inbox-wrap: could not write the task log\n')
    }
  }
  const skill = build({ root, env, now, post: o.post, log })
  const budget = createBudget(join(root, `${name}-budget.json`), now)
  const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

  const server = await startServer({ host: '127.0.0.1', port, tokens: [token], version, skill, budget, log, now })

  let finished: (reason: StopReason) => void = () => {}
  const exited = new Promise<StopReason>((resolve) => { finished = resolve })
  let stopping: Promise<void> | undefined
  const every = o.every ?? ((ms, fn) => {
    const timer = setInterval(fn, ms)
    return () => clearInterval(timer)
  })
  const stop = (reason: StopReason): Promise<void> => {
    stopping ??= (async () => {
      cancelTick()
      await server.close()
      finished(reason)
    })()
    return stopping
  }
  const cancelTick = every(GATE_MS, () => {
    let on = false
    let sameToken = false
    try {
      on = endpointPort(o.meshDir, name) === port
    } catch {}
    try {
      sameToken = readPrivate(tokenFile).trim() === token
    } catch {}
    let sameServer = true
    if (named) {
      try {
        sameServer = entryKey(serverEntry(o.meshDir, named.server)) === named.key
      } catch {
        sameServer = false
      }
    }
    if (!on) void stop('mesh.json')
    else if (!sameToken) void stop('token')
    else if (!sameServer) void stop('server')
    else if (server.idleMs() >= IDLE_MS) void stop('idle')
  })
  return { port, exited, stop }
}

/** The agent-inbox-wrap command: prints only this package's fixed messages, never a value. */
export async function main(args: string[], env: NodeJS.ProcessEnv, write: (text: string) => void): Promise<number> {
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const profile = flag('--profile')
  if (args.length !== 4 || flag('--agent') !== 'openai-compatible' || !profile || !isAgentName(profile)) {
    write('usage: agent-inbox-wrap --agent openai-compatible --profile unslop|unslop-code\n')
    return 4
  }
  let agent: Agent
  try {
    agent = await startAgent({ meshDir: meshDir(env), profile, env })
  } catch (error) {
    write(`agent-inbox-wrap: ${error instanceof ConfigError ? error.message : 'internal error'}\n`)
    return 1
  }
  write(`agent-inbox-wrap: ${profile} listening on http://127.0.0.1:${agent.port}\n`)
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => void agent.stop('signal'))
  write(`agent-inbox-wrap: stopped (${await agent.exited})\n`)
  return 0
}
