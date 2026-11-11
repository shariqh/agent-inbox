// Records test/fixtures/a2a-web-search/'s card and exchanges from W1's real server
// (web search design §11, §13 W2): the front door, the executor and the SDK over
// loopback, each run a fixed placeholder result. Ids, timestamps and the port are
// replaced by placeholders, so a re-recording is byte-identical unless the server's
// output changed; web-search-fixtures.test.ts re-records in memory and compares. The
// card is signed as the agent signs it at start (C7), by a P-256 key made for each
// recording and never written: the fixtures hold its public half and the signature
// only, so those two (and card.sha256, which covers the key list) change on every
// re-recording, and the comparison leaves them out.
// `node --import ./test/ts-hooks.mjs test/web-search-record.ts write` (in packages/mesh)
// rewrites the files; then regenerate MANIFEST.json as the fixtures' README says.
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CARD_PATH, cardHash, proofFor } from '../src/a2a-client.js'
import { thumbprint } from '../src/card-signing.js'
import type { SigningKey } from '../src/card-signing.js'
import { createExecutor, servedCard } from '../src/web-search/agent.js'
import type { Run, RunResult } from '../src/web-search/agent.js'
import { EXTENSION, startFrontDoor } from '../src/web-search/front-door.js'
import { WEB_SEARCH_EXTENSIONS } from '../src/a2a-client.js'

export const FIXTURES = fileURLToPath(new URL('../../../test/fixtures/a2a-web-search/', import.meta.url))
export const TOKEN = 'placeholder-token-'.padEnd(43, '0')
const NONCE = 'placeholder-nonce-'.padEnd(43, '0')
const PORT = 4421
const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
const AT = '2026-11-09T18:00:00.000Z'
type Json = Record<string, any>

const source = (n: number, mode: 'answer' | 'sources'): Json => ({
  n, url: `https://docs.example.com/releases/${n}`, host: 'docs.example.com', title: `Example runtime release notes, part ${n}`,
  snippet: 'Version 24 of the example runtime entered long-term support on 2025-10-28.',
  ...(mode === 'answer' ? { passages: ['Version 24 entered long-term support on 2025-10-28, and v24.11.0 is the first release in that line.'] } : {}),
  publishedAt: '2025-10-28', fetchedAt: '2026-11-02T08:00:00Z', retrievedAt: '2026-11-09T18:02:11Z', provider: 'searxng', engines: ['wikipedia'],
  ...(mode === 'answer' ? { pageText: 'ollama-fetch' } : {}), suspect: false,
})
const result = (mode: 'answer' | 'sources', n: number, extra: Json = {}): Json => ({
  code: 0, mode, untrusted: true, providers: ['searxng'], fallback: false, cache: 'miss',
  sources: Array.from({ length: n }, (_, i) => source(i + 1, mode)), warnings: [], ms: { queued: 0, search: 640, model: mode === 'answer' ? 9100 : 0, check: mode === 'answer' ? 4 : 0 }, ...extra,
})
const ANSWER = { text: 'Version 24 entered long-term support in October 2025 [1].', found: true, citations: [1], model: 'placeholder-model', attempts: 1 }
const completed = (data: Json): RunResult => ({
  state: 'completed', data,
  text: data.answer ? `${data.answer.text as string}\n\nSources:\n${(data.sources as Json[]).map((s) => `[${s.n as number}] ${s.title as string} — ${s.url as string}`).join('\n')}` : `${(data.sources as Json[]).length} source${(data.sources as Json[]).length === 1 ? '' : 's'}`,
})

type Scenario = { file: string; row: string; situation: string; exit: number; method: string; query: string; meta?: Json; uri?: string; configuration?: Json; states?: string[]; run: RunResult | 'throw' }
const Q = 'When did version 24 of the example runtime enter long-term support?'
const SCENARIOS: Scenario[] = [
  { file: '01-answer', row: 'answer', situation: 'An answer that passed the check; returnImmediately: false is accepted', exit: 0, method: 'SendMessage', query: Q, meta: { mode: 'answer', recency: 'any', maxSources: 5, sites: ['docs.example.com'], excludeSites: ['example.net'], fresh: false, timeoutMs: 90000 }, configuration: { returnImmediately: false, acceptedOutputModes: ['text/plain', 'application/json'] }, states: ['searching', 'answering', 'checking'], run: completed({ ...result('answer', 2), answer: ANSWER }) },
  { file: '02-sources', row: 'sources', situation: 'Sources in sources mode', exit: 0, method: 'SendMessage', query: Q, meta: { mode: 'sources' }, states: ['searching'], run: completed(result('sources', 2)) },
  { file: '03-no-results', row: 'no-results', situation: 'No results; the metadata is under the old URN, which the front door still reads (publishable-agent design §6)', exit: 0, method: 'SendMessage', query: 'example runtime release with no public notes', meta: { mode: 'sources' }, uri: WEB_SEARCH_EXTENSIONS[1], states: ['searching'], run: completed(result('sources', 0)) },
  { file: '04-sources-only', row: 'sources-only', situation: 'Sources only: an answer was asked for, but this copy has no model', exit: 10, method: 'SendMessage', query: Q, states: ['searching'], run: completed(result('answer', 1, { code: 10, warnings: ['synthesis-off'], ms: { queued: 0, search: 640, model: 0, check: 0 } })) },
  { file: '05-refused-screen', row: 'refused-screen', situation: 'Refused by the screen: the class is named, never the value', exit: 11, method: 'SendMessage', query: 'why does mail to person@mail.invalid bounce', run: { state: 'rejected', reason: 'screen', data: { code: 11, status: 'rejected', reason: 'screen', classes: ['email-address'] } } },
  { file: '06-refused-cap', row: 'refused-cap', situation: 'Refused: a daily cap', exit: 11, method: 'SendMessage', query: Q, run: { state: 'rejected', reason: 'daily-cap', data: { code: 11, status: 'rejected', reason: 'daily-cap' } } },
  { file: '07-busy', row: 'busy', situation: 'Busy: the queue is full', exit: 12, method: 'SendMessage', query: Q, run: { state: 'rejected', reason: 'queue-full', data: { code: 12, status: 'busy', reason: 'queue-full', retryAfterMs: 20000 } } },
  { file: '08-failed', row: 'failed', situation: 'Failed: SearXNG and Ollama both unreachable or erroring', exit: 13, method: 'SendMessage', query: Q, states: ['searching'], run: { state: 'failed', reason: 'providers-failed', data: { code: 13, status: 'failed', reason: 'providers-failed' } } },
  { file: '09-failed-internal', row: 'failed-internal', situation: 'Failed: an internal error; the executor never rejects, so no message leaks', exit: 13, method: 'SendMessage', query: Q, run: 'throw' },
  { file: '10-stream-answer', row: 'stream-answer', situation: 'Streaming: searching, answering, checking, then the artifact only with COMPLETED', exit: 0, method: 'SendStreamingMessage', query: Q, states: ['searching', 'answering', 'checking'], run: completed({ ...result('answer', 1), answer: ANSWER }) },
  { file: '11-stream-sources', row: 'stream-sources', situation: 'Streaming in sources mode', exit: 0, method: 'SendStreamingMessage', query: Q, meta: { mode: 'sources' }, states: ['searching'], run: completed(result('sources', 1)) },
  { file: '12-stream-refused', row: 'stream-refused', situation: 'Streaming: refused by the screen', exit: 11, method: 'SendStreamingMessage', query: 'why does mail to person@mail.invalid bounce', run: { state: 'rejected', reason: 'screen', data: { code: 11, status: 'rejected', reason: 'screen', classes: ['email-address'] } } },
  { file: '13-get-task', row: 'get-task', situation: "GetTask, the client's fallback when a stream drops", exit: 0, method: 'GetTask', query: Q, states: ['searching'], run: completed(result('sources', 1)) },
]
const CLIENT_ONLY = [
  { file: '20-off', row: 'off', situation: 'Off, no agent, a stale shim, the SDK not installed, a card mismatch, a failed identity check', exit: 14, clientOnly: true, note: 'Client-side only: no task exists. Without agents.web-search, or when the card or its identity proof does not match, the client sends nothing and exits 14 with empty stdout.' },
  { file: '21-usage', row: 'usage', situation: 'Usage, a terminal on stdin', exit: 4, clientOnly: true, note: 'Client-side only: a usage error or a terminal on stdin exits 4 before any connection.' },
]

/** Ids become numbered placeholder UUIDs in order of appearance, timestamps one instant, the port 4421. */
export function normalise(value: unknown): unknown {
  const ids = new Map<string, string>()
  const walk = (v: unknown, key?: string): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x))
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]))
    if (typeof v !== 'string') return v
    if (key === 'timestamp') return AT
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)) {
      if (!ids.has(v)) ids.set(v, `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, '0')}`)
      return ids.get(v)
    }
    return v.replace(/127\.0\.0\.1:\d+/g, `127.0.0.1:${PORT}`)
  }
  return walk(value)
}

function http(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

/** A signing key for one recording, never written anywhere. */
export function recordingKey(): SigningKey {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = privateKey.export({ format: 'jwk' })
  return { kid: thumbprint({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }), key: privateKey }
}

/** Every recorded file, by its path in the fixtures folder, with its exact text. */
export async function record(key: SigningKey = recordingKey()): Promise<Map<string, string>> {
  let current: Scenario | undefined
  const run: Run = async (_query, _options, _signal, onState) => {
    const s = current!
    for (const state of s.states ?? []) {
      onState(state)
      await new Promise((resolve) => setImmediate(resolve))
    }
    if (s.run === 'throw') throw new Error('placeholder failure')
    return structuredClone(s.run)
  }
  const executor = createExecutor(run, () => {})
  // signed over the placeholder URL the fixtures hold, so the recorded signature verifies
  const door = await startFrontDoor({ port: 0, tokens: [TOKEN], card: () => servedCard(`http://127.0.0.1:${PORT}/`, VERSION, [key]), executor, busy: () => false })
  const out = new Map<string, string>()
  const put = (rel: string, value: unknown): void => { out.set(rel, `${JSON.stringify(normalise(value), null, 2)}\n`) }
  try {
    const headers = { authorization: `Bearer ${TOKEN}`, 'a2a-version': '1.0', 'content-type': 'application/json' }
    const cardRes = await http(door.port, 'GET', CARD_PATH, { 'a2a-mesh-challenge': NONCE })
    const served = JSON.parse(cardRes.body) as Json
    put('card.json', served)
    out.set('card.sha256', `${cardHash(normalise(served) as Json)}\n`)
    const bad = await http(door.port, 'GET', CARD_PATH, { 'a2a-mesh-challenge': 'short' })
    put('exchanges/30-identity.json', {
      row: 'identity', situation: 'The identity challenge (§10.1): the proof is HMAC-SHA256(token, "web-search/v1\\n" + nonce) in base64url; only then does the client send the token', token: TOKEN, exitOnMismatch: 14,
      challenge: { request: { method: 'GET', path: CARD_PATH, headers: { 'A2A-Mesh-Challenge': NONCE } }, response: { status: cardRes.status, headers: { 'A2A-Mesh-Proof': cardRes.headers['a2a-mesh-proof'] }, body: served } },
      malformed: { request: { method: 'GET', path: CARD_PATH, headers: { 'A2A-Mesh-Challenge': 'short' } }, response: { status: bad.status, headers: { 'A2A-Mesh-Proof': bad.headers['a2a-mesh-proof'] ?? null } } },
    })
    if (proofFor(TOKEN, NONCE) !== cardRes.headers['a2a-mesh-proof']) throw new Error('the server gave no valid proof')
    for (const [i, s] of SCENARIOS.entries()) {
      current = s
      const id = `rpc-${String(i + 1).padStart(2, '0')}`
      const message = { messageId: `msg-${String(i + 1).padStart(2, '0')}`, role: 'ROLE_USER', parts: [{ text: s.query }], ...(s.meta ? { metadata: { [s.uri ?? EXTENSION]: s.meta } } : {}) }
      const send = { jsonrpc: '2.0', id, method: s.method === 'GetTask' ? 'SendMessage' : s.method, params: { message, ...(s.configuration ? { configuration: s.configuration } : {}) } }
      const sent = await http(door.port, 'POST', '/', headers, JSON.stringify(send))
      const head = { row: s.row, situation: s.situation, exit: s.exit, headers: { 'A2A-Version': '1.0' } }
      if (s.method === 'GetTask') {
        const task = (JSON.parse(sent.body) as Json).result.task as Json
        const get = { jsonrpc: '2.0', id, method: 'GetTask', params: { id: task.id } }
        put(`exchanges/${s.file}.json`, { ...head, request: get, response: JSON.parse((await http(door.port, 'POST', '/', headers, JSON.stringify(get))).body) })
      } else if (s.method === 'SendStreamingMessage') {
        put(`exchanges/${s.file}.json`, { ...head, request: send, events: sent.body.split('\n\n').filter(Boolean).map((e) => JSON.parse(e.replace(/^data: /, ''))) })
      } else {
        put(`exchanges/${s.file}.json`, { ...head, request: send, response: JSON.parse(sent.body) })
      }
    }
    for (const c of CLIENT_ONLY) {
      const { file, ...rest } = c
      put(`exchanges/${file}.json`, rest)
    }
  } finally {
    await door.close()
  }
  return out
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'write') {
  for (const [rel, text] of await record()) {
    mkdirSync(dirname(join(FIXTURES, rel)), { recursive: true })
    writeFileSync(join(FIXTURES, rel), text)
  }
}
