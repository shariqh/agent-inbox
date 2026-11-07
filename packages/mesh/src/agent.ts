// The unslop agent process (#483, unslop design §4.2-§4.5, §7.2): reads its
// private files, refuses to start unless mesh.json's `agents.unslop` names a
// loopback endpoint, serves A2A there, and exits within one minute of that key
// going or the caller token changing (a disable and enable writes a new one, which
// this process would otherwise refuse until it stopped), or after 30 idle minutes. Every path derives from the mesh dir. The
// log gets one JSON line per task with sizes, timings and classes: never text,
// never a matched value, never the token or the API key.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { startServer } from './a2a.js'
import { checkApiKey, checkBaseUrl } from './backend.js'
import type { Post, Sampling } from './backend.js'
import { ConfigError, appendPrivate, localDate, readPrivate, writePrivate } from './files.js'
import { meshDir, meshFile, readMesh } from './mesh-config.js'
import { createRulesLoader } from './rules.js'
import { runUnslop } from './unslop.js'

export const GATE_MS = 60_000
export const IDLE_MS = 30 * 60_000
const DAILY_TASKS = 200
const DAILY_MODEL_MS = 180 * 60_000

type KeySource = { env: string } | { file: string } | { command: string[] }
type Profile = {
  skill: string; baseUrl: string; apiKey?: KeySource; model?: string; sampling?: Partial<Sampling>
  terms?: string[]; allowEmails?: string[]; customerPaths?: string[]
}
export type StopReason = 'mesh.json' | 'token' | 'idle' | 'signal'
export type AgentOptions = {
  meshDir: string
  profile: string
  env?: NodeJS.ProcessEnv
  now?: () => number
  every?: (ms: number, fn: () => void) => () => void
  post?: Post
}
export type Agent = { port: number; exited: Promise<StopReason>; stop(reason: StopReason): Promise<void> }

/** The port of `agents.unslop.endpoint`, which must be http://127.0.0.1:<port>. */
export function endpointPort(dir: string): number {
  const read = readMesh(meshFile(dir))
  if (read.kind !== 'present') throw new ConfigError('mesh.json is missing or unreadable: run meshctl enable --unslop')
  const endpoint = (read.doc as { agents?: { unslop?: { endpoint?: unknown } } }).agents?.unslop?.endpoint
  if (endpoint === undefined) throw new ConfigError('mesh.json has no agents.unslop: run meshctl enable --unslop')
  const port = Number(/^http:\/\/127\.0\.0\.1:(\d{1,5})\/?$/.exec(String(endpoint))?.[1])
  // port 80 is out: clients drop `:80` from Host, and the Host check is exact
  if (!(port >= 1 && port <= 65535) || port === 80) throw new ConfigError('agents.unslop.endpoint must be http://127.0.0.1:<port>')
  return port
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string')
const home = (p: string): string => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)
/** Our own checks throw fixed messages; re-raise them as printable. */
const fixed = <T>(fn: () => T): T => {
  try {
    return fn()
  } catch (error) {
    throw error instanceof ConfigError ? error : new ConfigError((error as Error).message)
  }
}
const KEY_SHAPE = 'apiKey must be { env }, { file: absolute path } or { command: [absolute path, ...args] }'

function parseProfile(text: string): Profile {
  let p: Profile
  try {
    p = JSON.parse(text) as Profile
  } catch {
    throw new ConfigError('the profile is not valid JSON')
  }
  if (!p || typeof p !== 'object' || typeof p.skill !== 'string' || !isAbsolute(home(p.skill))) throw new ConfigError('the profile needs an absolute `skill` folder')
  if (typeof p.baseUrl !== 'string') throw new ConfigError('the profile needs a `baseUrl`')
  fixed(() => checkBaseUrl(p.baseUrl))
  for (const key of ['terms', 'allowEmails', 'customerPaths'] as const) if (p[key] !== undefined && !strings(p[key])) throw new ConfigError(`the profile's \`${key}\` must be a list of strings`)
  return { ...p, skill: home(p.skill) }
}

function readApiKey(source: KeySource | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (source === undefined) return undefined
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new ConfigError(KEY_SHAPE)
  let raw: string | undefined
  if ('env' in source && typeof source.env === 'string') raw = env[source.env]
  else if ('file' in source && typeof source.file === 'string' && isAbsolute(home(source.file))) raw = readPrivate(home(source.file))
  else if ('command' in source && strings(source.command) && source.command[0] && isAbsolute(source.command[0])) {
    try {
      // a fixed argv, no shell; stdout is the key and is never logged
      raw = execFileSync(source.command[0], source.command.slice(1), { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      throw new ConfigError('the API key command failed')
    }
  } else throw new ConfigError(KEY_SHAPE)
  if (!raw?.trim()) throw new ConfigError('the API key source is empty')
  return fixed(() => checkApiKey(raw))
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

export async function startAgent(o: AgentOptions): Promise<Agent> {
  if (o.profile !== 'unslop') throw new ConfigError('the only profile is unslop')
  const now = o.now ?? Date.now
  const env = o.env ?? process.env
  const port = endpointPort(o.meshDir)
  const root = join(o.meshDir, 'mesh')
  const profile = parseProfile(readPrivate(join(root, 'wrappers', 'unslop.json')))
  const tokenFile = join(root, 'tokens', 'unslop')
  const token = readPrivate(tokenFile).trim()
  if (!/^[\x21-\x7E]{32,}$/.test(token)) throw new ConfigError('the token must be at least 32 printable characters')
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
  const budget = createBudget(join(root, 'unslop-budget.json'), now)
  const log = (entry: object): void => {
    try {
      appendPrivate(join(root, 'logs', `unslop-${localDate(now())}.log`), JSON.stringify({ at: new Date(now()).toISOString(), ...entry }))
    } catch {
      process.stderr.write('agent-inbox-wrap: could not write the task log\n')
    }
  }
  const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

  const server = await startServer({
    host: '127.0.0.1', port, tokens: [token], version, budget, log, now,
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
        rules: r, post: o.post, now, log, onState,
      })
      return r.stale ? { ...result, skillStale: true } : result
    },
  })

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
      on = endpointPort(o.meshDir) === port
    } catch {}
    try {
      sameToken = readPrivate(tokenFile).trim() === token
    } catch {}
    if (!on) void stop('mesh.json')
    else if (!sameToken) void stop('token')
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
  if (args.length !== 4 || flag('--agent') !== 'openai-compatible' || !profile) {
    write('usage: agent-inbox-wrap --agent openai-compatible --profile unslop\n')
    return 4
  }
  let agent: Agent
  try {
    agent = await startAgent({ meshDir: meshDir(env), profile, env })
  } catch (error) {
    write(`agent-inbox-wrap: ${error instanceof ConfigError ? error.message : 'internal error'}\n`)
    return 1
  }
  write(`agent-inbox-wrap: unslop listening on http://127.0.0.1:${agent.port}\n`)
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => void agent.stop('signal'))
  write(`agent-inbox-wrap: stopped (${await agent.exited})\n`)
  return 0
}
