// The agent cards view's server side (design
// docs/superpowers/specs/2026-11-09-agent-cards-view-design.md §3, §4). Viewer-only, like
// prstate.ts: nothing in the stdio MCP graph may reach it (test/prstate.test.ts). It reads
// `mesh.json` lazily, by mesh-config.ts's rule, only when a page reads /api/version or
// /api/mesh/agents (one lstat per 5 s at most; no timer, no fs.watch), and fetches each
// configured agent's card from the configured endpoint only, on a trigger: an open or a
// Refresh. It never starts an agent, never sends a token and never opens mesh/tokens or
// mesh/wrappers. Every user-facing reason and fix lives here, so no viewer, page or
// Electron file names the clients or the command (test/mesh.test.ts's text guard).
import { lstatSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { LookupFunction } from 'node:net'
import { cardJson, checkCard, summarizeCard } from './agent-card.js'
import { loopbackPort, meshFile, readMesh, requestPostEndpoint } from './mesh-config.js'

type Agent = 'unslop' | 'request-post'
type State = 'unchecked' | 'checking' | 'up' | 'not-running' | 'unreachable' | 'not-a-card' | 'mismatch' | 'invalid'
type Where = 'local' | 'tailnet' | 'ssh-tunnel' | null
type Shown = { summary: ReturnType<typeof summarizeCard>; json: string }
type Result = { state: State; reason: string | null; fix: string | null; checkedAt: number | null; card: Shown | null }

const AGENTS: readonly Agent[] = ['unslop', 'request-post']
const CARD_MAX = 64 * 1024
const STAT_EVERY_MS = 5_000
const DEADLINE_MS: Record<Agent, number> = { unslop: 3_000, 'request-post': 5_000 }
const SKIP_MS = { open: 60_000, refresh: 5_000 }
const FIX: Record<Agent, string> = { unslop: 'rebuild packages/mesh', 'request-post': 'update agent-inbox or the service' }
const UNCHECKED: Result = { state: 'unchecked', reason: 'press Refresh', fix: null, checkedAt: null, card: null }
const OFF = { on: false, agents: [] }

interface Rec {
  name: Agent
  endpoint: string | null
  profile: string | null
  result: Result
  good: { at: number; card: Shown } | null
  running: Promise<void> | null
}

interface Config { count: number; others: number; recs: Map<Agent, Rec> }

export interface MeshAgentsOpts {
  /** the mesh dir, from mesh-config.ts's meshDir() */
  dir: string
  /** test seams: the clock and the name lookup a request uses */
  now?: () => number
  lookup?: LookupFunction
}

export interface MeshAgents {
  /** `/api/version`'s `mesh` key, or undefined when the mesh shows nothing */
  version(): { agents: number } | undefined
  /** `GET /api/mesh/agents`'s body. Never starts a check. */
  body(): object
  /** Runs the trigger's checks and waits for them; false when `name` is not configured. */
  trigger(trigger: 'open' | 'refresh', name?: string): Promise<boolean>
}

const where = (name: Agent, endpoint: string | null): Where =>
  name === 'unslop' ? 'local' : !endpoint ? null : endpoint.startsWith('https:') ? 'tailnet' : 'ssh-tunnel'

const fail = (state: State, reason: string): Omit<Result, 'checkedAt'> => ({ state, reason, fix: null, card: null })

// Fixed words for a failed exchange, never a socket's message (§2.4).
function failWords(name: Agent, code: string): Omit<Result, 'checkedAt'> {
  if (code === 'ECONNREFUSED') return name === 'unslop' ? fail('not-running', 'starts on its first call') : fail('unreachable', 'connection refused')
  if (code === 'timeout') return fail('unreachable', `no answer in ${DEADLINE_MS[name] / 1000} s`)
  if (/^(ENOTFOUND|EAI_)/.test(code)) return fail('unreachable', 'does not resolve (is this Mac on the tailnet?)')
  if (/^(ERR_TLS|ERR_SSL|CERT_|UNABLE_TO|DEPTH_ZERO|SELF_SIGNED|HOSTNAME_MISMATCH)/.test(code)) return fail('unreachable', 'TLS handshake failed')
  return fail('unreachable', 'connection cut')
}

function notACard(name: Agent, why: string): Omit<Result, 'checkedAt'> {
  return fail('not-a-card', name === 'unslop' ? `something other than the unslop agent answers (${why})` : why)
}

/**
 * One `GET /.well-known/agent-card.json` to the configured endpoint: `agent: false` (no
 * keep-alive, no proxy), `Host` the endpoint's authority, no token, cookie or Origin, no
 * redirect, 64 KiB at most, and one wall-clock timer over lookup, connect, TLS, headers and
 * body that destroys the request, so a server that drips bytes still ends at the deadline.
 */
function fetchCard(name: Agent, endpoint: string, lookup: LookupFunction | undefined): Promise<Omit<Result, 'checkedAt'>> {
  const base = new URL(endpoint)
  const tls = base.protocol === 'https:'
  return new Promise((done) => {
    let settled = false
    const finish = (result: Omit<Result, 'checkedAt'>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.destroy()
      done(result)
    }
    const read = (res: IncomingMessage): void => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400) return finish(notACard(name, 'redirect, not followed'))
      if (name === 'request-post' && (status === 401 || status === 403)) return finish(fail('unreachable', `the service refused this device (HTTP ${status})`))
      if (status !== 200) return finish(notACard(name, `HTTP ${status}`))
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        if ((size += chunk.length) > CARD_MAX) finish(notACard(name, 'larger than 64 KiB'))
        else chunks.push(chunk)
      })
      res.on('end', () => {
        let card: unknown
        try {
          card = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch { /* not JSON */ }
        if (!card || typeof card !== 'object' || Array.isArray(card)) return finish(notACard(name, 'not JSON'))
        let shown: Shown
        try {
          // once per check, not per read; a card nested past the stack's depth cannot be shown
          shown = { json: cardJson(card), summary: summarizeCard(card) }
        } catch {
          return finish(notACard(name, 'nested too deeply'))
        }
        const why = checkCard(card, name)
        finish(why ? { state: 'mismatch', reason: why, fix: FIX[name], card: shown } : { state: 'up', reason: null, fix: null, card: shown })
      })
      res.on('close', () => finish(failWords(name, 'cut')))
    }
    const req = (tls ? httpsRequest : httpRequest)({
      host: base.hostname, port: base.port || (tls ? 443 : 80), method: 'GET', path: '/.well-known/agent-card.json',
      agent: false, lookup, servername: tls ? base.hostname : undefined,
      headers: { host: base.host, accept: 'application/json' },
    }, read)
    req.on('error', (error: NodeJS.ErrnoException) => finish(failWords(name, error.code ?? 'error')))
    const timer = setTimeout(() => finish(failWords(name, 'timeout')), DEADLINE_MS[name])
    req.end()
  })
}

export function meshAgents(opts: MeshAgentsOpts): MeshAgents {
  const now = opts.now ?? Date.now
  const file = meshFile(opts.dir)
  let statAt = -Infinity
  let identity: string | undefined
  let config: Config | null = null

  // §3.2: at most one lstat per 5 s, and a re-read by readMesh() only when the file's
  // identity, size or times changed. A changed endpoint starts a fresh record.
  function read(): Config | null {
    if (now() - statAt < STAT_EVERY_MS) return config
    statAt = now()
    let id = 'missing'
    try {
      const s = lstatSync(file)
      id = [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':')
    } catch { /* missing or unreadable: off */ }
    if (id === identity) return config
    identity = id
    const mesh = id === 'missing' ? undefined : readMesh(file)
    const agents = mesh?.kind === 'present' ? mesh.doc['agents'] : undefined
    const entries = agents && typeof agents === 'object' && !Array.isArray(agents) ? Object.entries(agents) : []
    const recs = new Map<Agent, Rec>()
    for (const [key, value] of entries) {
      if (!AGENTS.includes(key as Agent)) continue
      const name = key as Agent
      const entry = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
      const port = name === 'unslop' ? loopbackPort(entry['endpoint']) : undefined
      const endpoint = (name === 'unslop' ? port && `http://127.0.0.1:${port}` : requestPostEndpoint(entry['endpoint'])) || null
      const named = entry['profile']
      const profile = name === 'unslop' && typeof named === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(named) ? named : null
      const old = config?.recs.get(name)
      const rec: Rec = old && old.endpoint === endpoint ? old : {
        name, endpoint, profile, good: null, running: null,
        result: endpoint ? UNCHECKED : { state: 'invalid', reason: null, fix: 'run npm run meshctl -- status', checkedAt: null, card: null },
      }
      rec.profile = profile
      recs.set(name, rec)
    }
    config = recs.size ? { count: recs.size, others: entries.length - recs.size, recs } : null
    return config
  }

  // One check per agent at a time: a trigger that finds one running waits for it.
  function check(rec: Rec): Promise<void> {
    if (!rec.running && rec.endpoint) {
      rec.running = fetchCard(rec.name, rec.endpoint, opts.lookup).then((result) => {
        const at = now()
        if (result.state === 'up' && result.card) rec.good = { at, card: result.card }
        rec.result = { ...result, checkedAt: at }
        rec.running = null
      })
    }
    return rec.running ?? Promise.resolve()
  }

  function view(rec: Rec) {
    const r = rec.result
    const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString())
    return {
      key: `mesh.json:${rec.name}`, name: rec.name, where: where(rec.name, rec.endpoint), endpoint: rec.endpoint, profile: rec.profile,
      state: rec.running ? 'checking' : r.state, reason: rec.running ? null : r.reason, fix: rec.running ? null : r.fix,
      checkedAt: iso(r.checkedAt),
      card: r.card?.summary ?? null,
      cardJson: r.card?.json ?? null,
      // a failure never reports the last good card as current (§4.7)
      lastSeen: rec.good && r.state !== 'up' ? { at: iso(rec.good.at), card: rec.good.card.summary } : null,
    }
  }

  return {
    version: () => {
      const cfg = read()
      return cfg ? { agents: cfg.count } : undefined
    },
    body: () => {
      const cfg = read()
      if (!cfg) return OFF
      return { on: true, agents: [...cfg.recs.values()].sort((a, b) => a.name.localeCompare(b.name)).map(view), others: cfg.others }
    },
    trigger: async (trigger, name) => {
      const recs = [...(read()?.recs.values() ?? [])].filter((rec) => name === undefined || rec.name === name)
      if (name !== undefined && !recs.length) return false
      const due = (rec: Rec) => rec.running || rec.result.checkedAt === null || now() - rec.result.checkedAt >= SKIP_MS[trigger]
      await Promise.all(recs.filter(due).map(check))
      return true
    },
  }
}
