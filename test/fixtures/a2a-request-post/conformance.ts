// request-post conformance (#500; docs/superpowers/specs/2026-11-07-request-post-a2a-agent-design.md
// §3, §4.3, §5, §10 R1). Node core only and erasable TypeScript, so Node 24 runs it as is and
// the private service vendors this folder unchanged. Each check returns the problems it found;
// an empty list means the object conforms. R3's client runs the same key vectors.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// The extension's URIs, preferred first (publishable-agent design §6, C6 and C8): the card declares
// the Pages one; a client accepts a card declaring either and sends metadata under the one it
// declares, and the service reads metadata under either, never both. C10 drops the old URN.
export const EXTENSIONS = ['https://shariqh.github.io/agent-inbox/ext/request-post/v1', 'urn:agent-inbox:ext:request-post:v1']
const PROFILE = 'https://shariqh.github.io/agent-inbox/ext/profile/v1'
// publishable-agent design §8: the id, and per skill what leaves with the input (a store the
// operator chooses, never named) and where the work may run
const PROFILE_SKILLS = {
  'request-post': { egress: [{ purpose: 'storage', hosts: 'operator', sends: 'input' }], residency: 'caller-mesh' },
  'request-post-status': { egress: [{ purpose: 'storage', hosts: 'operator', sends: 'metadata' }], residency: 'caller-mesh' },
}
export const PHASES = ['awaiting-go', 'queued', 'drafting', 'in-review', 'ready-for-human', 'proposed', 'needs-fix', 'failed', 'rejected', 'published']
export const FINAL_PHASES = ['awaiting-go', 'ready-for-human', 'proposed', 'needs-fix', 'failed', 'rejected', 'published']
const HUMAN_PHASES = ['awaiting-go', 'ready-for-human', 'proposed']
const SOCIAL = ['x-thread', 'x-standalone', 'linkedin']
const BUSY = ['rate-limit', 'lock', 'daily-budget']
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/
const PR_URL = /github\.com\/[^/\s]+\/[^/\s]+\/pull\//i
const CONTROLS = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/
const B32 = 'abcdefghijklmnopqrstuvwxyz234567'

type Json = Record<string, unknown>
export type KeyInput = { brand: string; channels: string[]; title: string; slug?: string; sourceUrl?: string }

const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string')
const https = (v: unknown): boolean => typeof v === 'string' && /^https:\/\/[^\s/]+/.test(v)
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const opt = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** §5: NFKC, whitespace collapsed, lower-cased. */
export function normaliseTitle(title: string): string {
  return title.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** §5's pre-image: the version, the brand, the sorted channels and one identity line; never the brief. */
export function keyPreimage(r: KeyInput): string {
  const channels = [...r.channels].sort()
  const identity = channels.includes('blog') ? `slug:${r.slug ?? ''}` : r.sourceUrl !== undefined ? `url:${r.sourceUrl}` : `title:${normaliseTitle(r.title)}`
  return ['request-post/v1', r.brand, channels.join(','), identity].join('\n')
}

/** The first 26 characters of the pre-image's SHA-256 in RFC 4648 base32, lower-cased. */
export function requestKey(r: KeyInput): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const byte of createHash('sha256').update(keyPreimage(r), 'utf8').digest()) {
    value = (value << 8) | byte
    bits += 8
    for (; bits >= 5 && out.length < 26; bits -= 5) out += B32[(value >>> (bits - 5)) & 31]
  }
  return out
}

/** The request-post extension `card` declares, under its preferred URI. */
const extensionOf = (card: unknown): Json | undefined => {
  const exts = list(obj(obj(card).capabilities).extensions).map(obj)
  for (const uri of EXTENSIONS) {
    const ext = exts.find((e) => e.uri === uri)
    if (ext) return ext
  }
  return undefined
}
const extParams = (card: unknown): Json => obj(extensionOf(card)?.params)
// no "", [], {} or null, and no `"required": false` (publishable-agent design §3.10)
const unstable = (v: unknown): boolean => v === null || v === '' || (typeof v === 'object' && (!Object.values(v).length || Object.values(v).some(unstable)))

export function checkCard(card: unknown): string[] {
  const c = obj(card)
  const p = extParams(card)
  const caps = obj(c.capabilities)
  const problems: string[] = []
  if (c.name !== 'request-post' || typeof c.version !== 'string') problems.push('name or version')
  if (!list(c.supportedInterfaces).map(obj).some((i) => i.protocolBinding === 'JSONRPC' && i.protocolVersion === '1.0' && typeof i.url === 'string')) problems.push('interface')
  if (obj(c.capabilities).streaming !== false || obj(c.capabilities).pushNotifications !== false) problems.push('capabilities')
  if (!Object.values(obj(c.securitySchemes)).some((s) => obj(obj(s).httpAuthSecurityScheme).scheme === 'Bearer')) problems.push('bearer scheme')
  if (!same(list(c.skills).map((s) => obj(s).id).sort(), ['request-post', 'request-post-status'])) problems.push('skills')
  if (p.api !== 1) problems.push('extension api')
  if (!strs(p.brands) || !p.brands.length || !strs(p.categories) || !p.categories.length) problems.push('brands or categories')
  if (!strs(p.channels) || !same([...p.channels].sort(), ['blog', ...SOCIAL].sort())) problems.push('channels')
  if (!Number.isSafeInteger(p.maxBriefBytes) || (p.maxBriefBytes as number) < 1 || (p.maxBriefBytes as number) > 8192) problems.push('maxBriefBytes')
  // publishable-agent design §8 (C8): a provider, the profile with public keys only (none on an
  // unsigned copy), the bearer role "call", and a canonical-stable card
  const provider = obj(c.provider)
  if (typeof provider.organization !== 'string' || !https(provider.url)) problems.push('provider')
  const profile = list(caps.extensions).map(obj).filter((e) => e.uri === PROFILE)
  const { keys, ...declared } = obj(profile[0]?.params)
  const publicKeys = keys === undefined || (Array.isArray(keys) && keys.length >= 1 && keys.length <= 4 && keys.every((k) => Object.keys(obj(k)).sort().join() === 'crv,kty,x,y'))
  if (profile.length !== 1 || !same(declared, { id: 'shariqh.github.io/agent-inbox/request-post', skills: PROFILE_SKILLS }) || !publicKeys) problems.push('profile')
  const { signatures: _s, ...unsigned } = c
  if (unstable(unsigned) || list(caps.extensions).some((e) => obj(e).required === false)) problems.push('not canonical-stable')
  return problems
}

/** §3.2: the fields a filing request gets wrong, sorted; the text part is the field `brief`. */
export function invalidFields(meta: Json, brief: unknown, card: unknown): string[] {
  const p = extParams(card)
  const bad = new Set<string>()
  const ch = meta.channels
  const blog = strs(ch) && ch.length === 1 && ch[0] === 'blog'
  if (!(typeof meta.brand === 'string' && list(p.brands).includes(meta.brand))) bad.add('brand')
  if (!blog && !(strs(ch) && ch.length && new Set(ch).size === ch.length && ch.every((c) => SOCIAL.includes(c)))) bad.add('channels')
  if (typeof meta.title !== 'string' || !meta.title.trim() || [...meta.title].length > 120) bad.add('title')
  if (typeof meta.idempotencyKey !== 'string' || !meta.idempotencyKey || meta.idempotencyKey.length > 128 || CONTROLS.test(meta.idempotencyKey)) bad.add('idempotencyKey')
  if (typeof brief !== 'string' || !brief.trim() || Buffer.byteLength(brief) > Math.min(Number(p.maxBriefBytes) || 8192, 8192) || CONTROLS.test(brief)) bad.add('brief')
  if (blog) {
    if (!(typeof meta.category === 'string' && list(p.categories).includes(meta.category))) bad.add('category')
    if (typeof meta.slug !== 'string' || meta.slug.length > 80 || !SLUG.test(meta.slug)) bad.add('slug')
    for (const field of ['sourceUrl', 'media']) if (meta[field] !== undefined) bad.add(field)
  } else {
    if (meta.sourceUrl !== undefined && !https(meta.sourceUrl)) bad.add('sourceUrl')
    if (meta.media !== undefined && !(Array.isArray(meta.media) && meta.media.length <= 4 && meta.media.every(https))) bad.add('media')
  }
  for (const [field, value] of [...Object.entries(meta), ['brief', brief]] as Array<[string, unknown]>) {
    if (PR_URL.test(JSON.stringify(value ?? ''))) bad.add(field)
  }
  // §5: a key other than the derived one only with `keyOverride: true` (meshctl --key)
  const derived = typeof meta.brand === 'string' && strs(ch) && typeof meta.title === 'string'
    ? requestKey({ brand: meta.brand, channels: ch, title: meta.title, slug: opt(meta.slug), sourceUrl: opt(meta.sourceUrl) })
    : undefined
  if (meta.keyOverride !== true && meta.idempotencyKey !== derived) bad.add('idempotencyKey')
  return [...bad].sort()
}

const taskData = (task: Json): Json => {
  const status = obj(task.status)
  const parts = status.state === 'TASK_STATE_COMPLETED' ? list(obj(list(task.artifacts)[0]).parts) : list(obj(status.message).parts)
  return obj(parts.map(obj).find((part) => part.data !== undefined)?.data)
}

/** The exit a client gives a task (§3.3). */
export function exitFor(task: unknown): number {
  const t = obj(task)
  const data = taskData(t)
  const state = obj(t.status).state
  if (state === 'TASK_STATE_COMPLETED') return data.code === 0 ? 0 : 13
  if (state === 'TASK_STATE_REJECTED') return data.code === 12 ? 12 : data.reason === 'conflict' ? 16 : 11
  return 13
}

function checkCall(x: Json, skill: string): { problems: string[]; meta: Json; text: unknown; task: Json; data: Json } {
  const problems: string[] = []
  const req = obj(x.request)
  const res = obj(x.response)
  const message = obj(obj(req.params).message)
  const parts = list(message.parts)
  const metadata = obj(message.metadata)
  const keys = Object.keys(metadata)
  const meta = obj(metadata[keys[0] ?? ''])
  const task = obj(obj(res.result).task)
  const data = taskData(task)
  if (req.jsonrpc !== '2.0' || req.method !== 'SendMessage' || obj(obj(req.params).configuration).returnImmediately === true) problems.push('request: a blocking SendMessage')
  if (message.role !== 'ROLE_USER' || parts.length !== 1 || typeof obj(parts[0]).text !== 'string' || message.taskId !== undefined) problems.push('request: one text part')
  if (keys.length !== 1 || !EXTENSIONS.includes(keys[0]!)) problems.push('request: metadata')
  if (meta.skill !== skill) problems.push('request: skill')
  if (res.jsonrpc !== '2.0' || res.id !== req.id) problems.push('response: id')
  if (typeof task.id !== 'string' || typeof task.contextId !== 'string') problems.push('response: task')
  if (exitFor(task) !== x.exit || data.code !== x.exit) problems.push(`exit: ${exitFor(task)} is not ${String(x.exit)}`)
  const artifacts = list(task.artifacts).map(obj)
  if (obj(task.status).state === 'TASK_STATE_COMPLETED') {
    const text = obj(list(artifacts[0]?.parts)[0]).text
    if (artifacts.length !== 1 || typeof text !== 'string' || text.includes('\n')) problems.push('response: one artifact with a one-line text part')
  } else if (artifacts.length) problems.push('response: an artifact on a task that did not complete')
  return { problems, meta, text: obj(parts[0]).text, task, data }
}

/** One §3.3 row: a request-post request and its response, or a client-only exit. */
export function checkExchange(exchange: unknown, card: unknown): string[] {
  const x = obj(exchange)
  if (x.clientOnly === true) {
    return [4, 14, 15].includes(x.exit as number) && x.request === undefined && x.response === undefined && typeof x.note === 'string' ? [] : ['client-only row']
  }
  const { problems, meta, text, task, data } = checkCall(x, 'request-post')
  const invalid = invalidFields(meta, text, card)
  const refusedInvalid = x.exit === 11 && data.reason === 'invalid'
  if (!refusedInvalid && invalid.length) problems.push(`request: invalid ${invalid.join(', ')}`)
  if (meta.keyOverride !== undefined && meta.keyOverride !== true) problems.push('request: keyOverride is sent only as true')
  if (x.exit === 0) {
    if (typeof data.created !== 'boolean' || typeof data.pageId !== 'string' || !https(data.url) || data.readBack !== 'ok') problems.push('data: created, pageId, url, readBack')
    if (data.requestKey !== meta.idempotencyKey || data.brand !== meta.brand || !same(data.channels, meta.channels)) problems.push('data: requestKey, brand, channels')
    if (!PHASES.includes(data.phase as string) || (data.created === true && (data.phase === 'awaiting-go') !== same(meta.channels, ['blog']))) problems.push('data: phase')
  } else if (refusedInvalid) {
    if (!invalid.length || !same(data.fields, invalid)) problems.push('data: fields')
    for (const [field, values] of Object.entries(obj(data.allowed))) if (!invalid.includes(field) || !strs(values)) problems.push('data: allowed')
  } else if (x.exit === 11) {
    if (data.reason !== 'screen' || !strs(data.classes) || !data.classes.length || !data.classes.every((c) => SLUG.test(c))) problems.push('data: screen classes')
  } else if (x.exit === 12) {
    if (!BUSY.includes(data.reason as string) || !Number.isSafeInteger(data.retryAfterMs) || (data.retryAfterMs as number) <= 0) problems.push('data: busy reason and retryAfterMs')
  } else if (x.exit === 13) {
    if (data.outcome !== 'unknown' || (data.pageId !== undefined && typeof data.pageId !== 'string')) problems.push('data: outcome')
  } else if (x.exit === 16) {
    const c = obj(data.conflict)
    if (typeof c.pageId !== 'string' || !https(c.url) || !PHASES.includes(c.phase as string)) problems.push('data: conflict')
  }
  if (x.exit !== 0 && x.exit !== 16) {
    // a refusal names the field or class, never a value: no request field, and no value-like word of the brief
    const words = typeof text === 'string' ? text.split(/\s+/).map((w) => w.replace(/^\W+|\W+$/g, '')).filter((w) => w.length >= 4 && /[\d@.:/]/.test(w)) : []
    const values = [text, meta.title, meta.slug, meta.sourceUrl, ...list(meta.media), ...words].filter((v): v is string => typeof v === 'string' && v.length >= 4)
    const said = JSON.stringify(task)
    if (values.some((v) => said.includes(JSON.stringify(v).slice(1, -1)))) problems.push('response: echoes a value from the request')
  }
  return problems
}

/** One request-post-status read and its snapshot (§3.3, §4.3). */
export function checkStatus(exchange: unknown, card: unknown): string[] {
  const { problems, meta, data: s } = checkCall(obj(exchange), 'request-post-status')
  const channels = list(extParams(card).channels)
  if ((typeof meta.requestKey === 'string') === (typeof meta.pageId === 'string')) problems.push('request: requestKey or pageId')
  if (!PHASES.includes(s.phase as string)) problems.push('phase')
  if (s.phase === 'awaiting-go' ? s.status !== null || list(s.drafts).length || s.prUrl !== undefined : typeof s.status !== 'string') problems.push('status')
  if (s.agentState !== undefined && typeof s.agentState !== 'string') problems.push('agentState')
  if (s.prUrl !== undefined && !https(s.prUrl)) problems.push('prUrl')
  if (!Array.isArray(s.drafts) || !s.drafts.map(obj).every((d) => typeof d.pageId === 'string' && https(d.url) && channels.includes(d.channel) && typeof d.status === 'string')) problems.push('drafts')
  const error = obj(s.error)
  if (s.error !== undefined && (typeof error.text !== 'string' || [...error.text].length > 500 || CONTROLS.test(error.text) || error.untrusted !== true)) problems.push('error')
  if (HUMAN_PHASES.includes(s.phase as string) && (typeof s.humanAction !== 'string' || !s.humanAction)) problems.push('humanAction')
  if (s.final !== FINAL_PHASES.includes(s.phase as string)) problems.push('final')
  return problems
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
