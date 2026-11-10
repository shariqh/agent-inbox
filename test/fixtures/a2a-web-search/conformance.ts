// web-search conformance (#505; docs/superpowers/specs/2026-11-09-web-search-a2a-agent-design.md
// §4, §6, §7.1, §11). Node core only and erasable TypeScript, so Node 24 runs it as is and a
// homelab copy can vendor this folder unchanged. Each check returns the problems it found; an
// empty list means the object conforms.
import { createHash, createHmac } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export const EXTENSION = 'urn:agent-inbox:ext:web-search:v1'
const PARAMS = { api: 1, modes: ['answer', 'sources'], recency: ['any', 'day', 'week', 'month', 'year'], maxSources: 10, maxQueryChars: 400, maxSites: 5, maxExcludeSites: 10 }
const META = ['mode', 'recency', 'maxSources', 'sites', 'excludeSites', 'fresh', 'timeoutMs']
const METHODS = ['SendMessage', 'SendStreamingMessage', 'GetTask', 'CancelTask']
const STATES = ['searching', 'answering', 'checking']
const WARNINGS = ['synthesis-off', 'model-busy', 'model-loading', 'truncated', 'check-failed']
const FORBIDDEN = ['taskId', 'contextId', 'referenceTaskIds', 'pushNotificationConfig', 'taskPushNotificationConfig', 'tenant', 'historyLength', 'blocking', 'extensions']
const VERSION = /^1\.0(?:\.\d+)?$/
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/
const UNSAFE = /[\x00-\x08\x0B-\x1F\x7F-\x9F\u200B-\u200F\u202A-\u202E\u2028\u2029\u2060-\u2069\uFEFF]/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/
const TERMINAL = ['TASK_STATE_COMPLETED', 'TASK_STATE_REJECTED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED']

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string')
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const short = (v: unknown, max: number): boolean => typeof v === 'string' && [...v].length <= max && !UNSAFE.test(v)
const keysDeep = (v: unknown): string[] => Array.isArray(v) ? v.flatMap(keysDeep)
  : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keysDeep(x)]) : []

const jcs = (v: unknown): string => Array.isArray(v) ? `[${v.map(jcs).join(',')}]`
  : v && typeof v === 'object' ? members(v as Json, () => true) : JSON.stringify(v)
const members = (o: Json, keep: (key: string) => boolean, value: (key: string) => string = (key) => jcs(o[key])): string =>
  `{${Object.keys(o).filter(keep).sort().map((key) => `${JSON.stringify(key)}:${value(key)}`).join(',')}}`

/**
 * §4.1: SHA-256 of the card's JCS form as received, without `signatures` and every
 * `supportedInterfaces[].url`. No SDK normalisation: one rule for every agent (#556).
 */
export function cardHash(card: unknown): string {
  const c = obj(card)
  const canonical = members(c, (key) => key !== 'signatures', (key) => {
    const value = c[key]
    if (key !== 'supportedInterfaces' || !Array.isArray(value)) return jcs(value)
    return `[${value.map((i) => (i && typeof i === 'object' && !Array.isArray(i) ? members(i as Json, (k) => k !== 'url') : jcs(i))).join(',')}]`
  })
  return createHash('sha256').update(canonical).digest('hex')
}

/** §10.1: the identity proof, HMAC-SHA256(token, "web-search/v1\n" + nonce) in base64url. */
export const proofFor = (token: string, nonce: string): string => createHmac('sha256', token).update(`web-search/v1\n${nonce}`).digest('base64url')

export function checkCard(card: unknown): string[] {
  const c = obj(card)
  const caps = obj(c.capabilities)
  const ext = list(caps.extensions).map(obj).find((e) => e.uri === EXTENSION)
  const problems: string[] = []
  if (c.name !== 'web-search' || typeof c.version !== 'string') problems.push('name or version')
  const ifaces = list(c.supportedInterfaces).map(obj)
  if (ifaces.length !== 1 || ifaces[0]!.protocolBinding !== 'JSONRPC' || !VERSION.test(String(ifaces[0]!.protocolVersion)) || typeof ifaces[0]!.url !== 'string') problems.push('interface')
  if (caps.streaming !== true || caps.pushNotifications !== false) problems.push('capabilities')
  const schemes = Object.entries(obj(c.securitySchemes)).filter(([, s]) => obj(obj(s).httpAuthSecurityScheme).scheme === 'Bearer').map(([k]) => k)
  if (!schemes.length || !list(c.securityRequirements).some((r) => schemes.some((k) => k in obj(obj(r).schemes)))) problems.push('bearer scheme')
  if (!same(c.defaultInputModes, ['text/plain']) || !strs(c.defaultOutputModes) || !['text/plain', 'application/json'].every((m) => (c.defaultOutputModes as string[]).includes(m))) problems.push('modes')
  const skills = list(c.skills).map(obj)
  if (skills.length !== 1 || skills[0]!.id !== 'web-search' || !strs(skills[0]!.tags)) problems.push('skills')
  if (!ext || !same(ext.params, PARAMS)) problems.push('extension')
  if (/synthesis|provider|model|searxng|ollama/i.test(JSON.stringify(card))) problems.push('a per-copy setting')
  return problems
}

/** §4.3: the data part of a COMPLETED task; `query` must not be echoed whole. `attempts` is 0 only for a NOT FOUND the model was never asked for (no source to give it). */
export function checkResult(data: unknown, query?: string): string[] {
  const d = obj(data)
  const problems: string[] = []
  const sources = list(d.sources).map(obj)
  const answerMode = d.mode === 'answer'
  if (d.code !== 0 && d.code !== 10) problems.push('code')
  if (d.mode !== 'answer' && d.mode !== 'sources') problems.push('mode')
  if (d.untrusted !== true) problems.push('untrusted')
  if (!strs(d.providers) || !d.providers.length || !d.providers.every((p) => ['searxng', 'ollama'].includes(p)) || d.fallback !== d.providers.includes('ollama')) problems.push('providers or fallback')
  if (d.cache !== 'hit' && d.cache !== 'miss') problems.push('cache')
  if (!strs(d.warnings) || !Object.values(obj(d.ms)).every((n) => Number.isSafeInteger(n) && (n as number) >= 0)) problems.push('warnings or ms')
  if (sources.length > 10 || sources.some((s, i) => s.n !== i + 1)) problems.push('sources: numbering')
  for (const s of sources) {
    let url: URL | undefined
    try {
      url = new URL(String(s.url))
    } catch {}
    if (!url || !/^https?:$/.test(url.protocol) || url.username || url.password || String(s.url).length > 2048 || s.host !== url.hostname || !/^[a-z0-9.-]+$/.test(String(s.host))) problems.push(`source ${String(s.n)}: url or host`)
    if (!short(s.title, 200) || !short(s.snippet, 400) || typeof s.suspect !== 'boolean') problems.push(`source ${String(s.n)}: title, snippet or suspect`)
    if (!['searxng', 'ollama'].includes(s.provider as string) || (s.engines !== undefined && (s.provider !== 'searxng' || !strs(s.engines)))) problems.push(`source ${String(s.n)}: provider or engines`)
    if (!ISO.test(String(s.retrievedAt)) || (s.fetchedAt !== undefined && !ISO.test(String(s.fetchedAt))) || (s.publishedAt !== undefined && !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(String(s.publishedAt)))) problems.push(`source ${String(s.n)}: dates`)
    if (answerMode ? !(strs(s.passages) && s.passages.every((p) => short(p, 2400)) && ['ollama-fetch', 'ollama-search', 'snippet'].includes(s.pageText as string)) : s.passages !== undefined || s.pageText !== undefined) problems.push(`source ${String(s.n)}: passages`)
  }
  const a = obj(d.answer)
  if (d.code === 0 && answerMode) {
    const cites = list(a.citations)
    if (!short(a.text, 4000) || typeof a.found !== 'boolean' || typeof a.model !== 'string' || !([1, 2].includes(a.attempts as number) || (a.attempts === 0 && a.found === false && !list(a.citations).length))) problems.push('answer')
    if (!cites.every((n) => Number.isSafeInteger(n) && (n as number) >= 1 && (n as number) <= sources.length) || /https?:|!\[|<[a-z/]/i.test(String(a.text))) problems.push('answer: citations or links')
  } else if (d.answer !== undefined) problems.push('answer: present without code 0 in answer mode')
  if (d.code === 10 && (!answerMode || !strs(d.warnings) || !d.warnings.some((w) => WARNINGS.includes(w)))) problems.push('sources only: a warning naming why')
  if (query && query.length >= 8 && JSON.stringify(d).includes(JSON.stringify(query).slice(1, -1))) problems.push('echoes the query')
  return problems
}

const dataOf = (task: Json): Json => {
  const parts = task.status && obj(task.status).state === 'TASK_STATE_COMPLETED' ? list(obj(list(task.artifacts)[0]).parts) : list(obj(obj(task.status).message).parts)
  return obj(parts.map(obj).find((p) => p.data !== undefined)?.data)
}

/** §4.4: the exit a client gives a finished task. */
export function exitFor(task: unknown): number {
  const t = obj(task)
  const state = obj(t.status).state
  const code = dataOf(t).code
  if (state === 'TASK_STATE_COMPLETED') return code === 0 || code === 10 ? code : 13
  if (state === 'TASK_STATE_REJECTED') return code === 12 ? 12 : 11
  return 13
}

/** A request the front door accepts: camelCase allowlist, one text part, `returnImmediately` false or absent. */
function checkRequest(req: Json): string[] {
  const problems: string[] = []
  const params = obj(req.params)
  const keys = keysDeep(params)
  if (req.jsonrpc !== '2.0' || !METHODS.includes(req.method as string) || !(typeof req.id === 'string' || Number.isSafeInteger(req.id))) problems.push('request: envelope')
  if (keys.some((k) => k.includes('_') || FORBIDDEN.includes(k)) || obj(params.configuration).returnImmediately === true) problems.push('request: a refused key')
  if (req.method === 'SendMessage' || req.method === 'SendStreamingMessage') {
    const m = obj(params.message)
    const parts = list(m.parts).map(obj)
    if (m.role !== 'ROLE_USER' || parts.length !== 1 || typeof parts[0]!.text !== 'string') problems.push('request: one text part')
    if (!Object.keys(obj(obj(m.metadata)[EXTENSION])).every((k) => META.includes(k)) || Object.keys(obj(m.metadata)).some((k) => k !== EXTENSION)) problems.push('request: metadata')
  } else if (!same(Object.keys(params), ['id'])) problems.push('request: id only')
  return problems
}

/** Folds a stream into its final task, checking the order of §3.2 item 4. */
function foldStream(events: Json[], problems: string[]): Json {
  const results = events.map((e) => obj(e.result))
  const task = structuredClone(obj(results[0]?.task))
  if (obj(task.status).state !== 'TASK_STATE_SUBMITTED') problems.push('stream: starts with the SUBMITTED task')
  results.slice(1).forEach((r, i, rest) => {
    if (r.artifactUpdate) {
      if (obj(obj(rest[i + 1]?.statusUpdate).status).state !== 'TASK_STATE_COMPLETED') problems.push('stream: an artifact before COMPLETED')
      task.artifacts = [obj(r.artifactUpdate).artifact]
    } else {
      const status = obj(obj(r.statusUpdate).status)
      if (status.state === 'TASK_STATE_WORKING' && !STATES.includes(String(obj(list(obj(status.message).parts)[0]).text))) problems.push('stream: a WORKING message')
      if (TERMINAL.includes(obj(task.status).state as string)) problems.push('stream: an event after the end')
      task.status = status
    }
  })
  return task
}

/** One §4.4 row: a request with its response or stream, the identity challenge, or a client-only exit. */
export function checkExchange(exchange: unknown, card: unknown): string[] {
  const x = obj(exchange)
  if (x.clientOnly === true) return [4, 14].includes(x.exit as number) && x.request === undefined && typeof x.note === 'string' ? [] : ['client-only row']
  if (x.row === 'identity') {
    const ch = obj(x.challenge)
    const nonce = String(obj(obj(ch.request).headers)['A2A-Mesh-Challenge'])
    const problems = checkCard(obj(ch.response).body)
    if (!/^[\w-]{43}$/.test(nonce) || obj(obj(ch.response).headers)['A2A-Mesh-Proof'] !== proofFor(String(x.token), nonce)) problems.push('identity: proof')
    if (obj(obj(obj(x.malformed).response).headers)['A2A-Mesh-Proof'] !== null || x.exitOnMismatch !== 14) problems.push('identity: a malformed challenge gets no proof')
    return problems
  }
  const req = obj(x.request)
  const problems = checkRequest(req)
  if (!VERSION.test(String(obj(x.headers)['A2A-Version']))) problems.push('request: A2A-Version')
  const events = list(x.events).map(obj)
  if (x.response !== undefined === events.length > 0) problems.push('response or events')
  const replies = events.length ? events : [obj(x.response)]
  if (replies.some((r) => r.jsonrpc !== '2.0' || r.id !== req.id)) problems.push('response: id')
  if (keysDeep(replies).includes('history')) problems.push('response: history')
  const result = obj(replies[0]!.result)
  const task = events.length ? foldStream(events, problems) : obj(req.method === 'GetTask' ? result : result.task)
  const state = obj(task.status).state
  if (exitFor(task) !== x.exit) problems.push(`exit: ${exitFor(task)} is not ${String(x.exit)}`)
  const data = dataOf(task)
  if (data.code !== x.exit) problems.push('data: code')
  const query = String(obj(list(obj(obj(req.params).message).parts)[0]).text ?? '')
  if (state === 'TASK_STATE_COMPLETED') {
    const parts = list(obj(list(task.artifacts)[0]).parts).map(obj)
    if (list(task.artifacts).length !== 1 || parts.length !== 2 || typeof parts[0]!.text !== 'string' || (data.mode === 'sources' && String(parts[0]!.text).includes('\n'))) problems.push('response: one artifact, text then data')
    problems.push(...checkResult(data, query))
  } else {
    if (list(task.artifacts).length) problems.push('response: an artifact on a task that did not complete')
    if (x.exit === 11 && !(['shape', 'daily-cap', 'hourly-cap'].includes(data.reason as string) || (data.reason === 'screen' && strs(data.classes) && data.classes.length && data.classes.every((c) => SLUG.test(c))))) problems.push('data: refusal reason or classes')
    if (x.exit === 12 && !(Number.isSafeInteger(data.retryAfterMs) && (data.retryAfterMs as number) > 0)) problems.push('data: retryAfterMs')
    if (x.exit === 13 && typeof data.reason !== 'string') problems.push('data: reason')
    if (query.length >= 8 && JSON.stringify(replies).includes(JSON.stringify(query).slice(1, -1))) problems.push('response: echoes the query')
  }
  // the request's extension fields stay within the card's limits
  const p = obj(list(obj(obj(card).capabilities).extensions).map(obj).find((e) => e.uri === EXTENSION)?.params)
  const meta = obj(obj(obj(obj(req.params).message).metadata)[EXTENSION])
  if ((meta.mode !== undefined && !list(p.modes).includes(meta.mode)) || (meta.recency !== undefined && !list(p.recency).includes(meta.recency))
    || Number(meta.maxSources ?? 1) > Number(p.maxSources) || list(meta.sites).length > Number(p.maxSites) || list(meta.excludeSites).length > Number(p.maxExcludeSites)) problems.push('request: outside the card')
  return problems
}

/** A request the front door must refuse before the SDK, with the JSON-RPC error it gets. */
export function checkRefusal(refusal: unknown): string[] {
  const r = obj(refusal)
  const req = obj(r.request)
  const error = obj(r.error)
  const badVersion = !VERSION.test(String(obj(r.headers)['A2A-Version'] ?? ''))
  if (typeof r.name !== 'string') return ['name']
  if (badVersion) return error.code === -32009 ? [] : ['a wrong version is -32009']
  if (error.code !== -32602) return ['refused with -32602']
  return checkRequest(req).length ? [] : ['the request would be accepted']
}

/** MANIFEST.json's `files`: every file in the folder but the manifest, with its SHA-256. */
export function manifestFiles(dir: string): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name)
      const rel = relative(dir, path).split('\\').join('/')
      if (statSync(path).isDirectory()) walk(path)
      else if (rel !== 'MANIFEST.json') files[rel] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
  walk(dir)
  return files
}

/** The files whose checksum differs from MANIFEST.json, or that only one side lists. */
export function checkManifest(dir: string): string[] {
  const listed = obj(obj(JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8'))).files)
  const actual = manifestFiles(dir)
  return [...new Set([...Object.keys(listed), ...Object.keys(actual)])].sort().filter((f) => listed[f] !== actual[f])
}

// `node conformance.ts manifest > MANIFEST.json` rewrites the manifest after a fixture changes.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'manifest') {
  const dir = fileURLToPath(new URL('.', import.meta.url))
  process.stdout.write(`${JSON.stringify({ schema: 1, algorithm: 'sha256', files: manifestFiles(dir) }, null, 2)}\n`)
}
