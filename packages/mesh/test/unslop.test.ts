// The unslop task pipeline and backend client (#483, unslop design §6-§8, U2a)
// against an in-process fake OpenAI-compatible server on 127.0.0.1.
import { createServer } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkBaseUrl, maxTokens } from '../src/backend.js'
import { runUnslop } from '../src/unslop.js'
import type { UnslopEnv, UnslopLog, UnslopTask } from '../src/unslop.js'

type Body = { model: string; messages: Array<{ role: string; content: string }>; [key: string]: unknown }
type Fake = { status?: number; json?: unknown } | 'hang'

const CANARY = 'Zq7canary'
const RULES = { text: '# Rules\nCut filler words. RULES-MARKER', sha256: 'f'.repeat(64) }
const NONCE = 'ab'.repeat(16)
const INPUT = 'See https://example.com/docs for v2.5.0. It does not ship today, and it is really very important.\n'
const GOOD = 'See https://example.com/docs for v2.5.0. It does not ship today, and it is important.\n'
const BAD = 'See https://example.com/docs for v2.5.0. It ships today, and it is important.\n'

let server: Server
let base: string
let requests: Array<{ body: Body; headers: IncomingHttpHeaders }>
let replies: Array<(body: Body) => Fake>

const reply = (content: string, choice: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Fake => ({
  json: { model: 'chat-long', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content }, ...choice }], usage: { completion_tokens: 40 }, ...extra },
})
const queue = (...fakes: Array<Fake | ((body: Body) => Fake)>): void => {
  replies.push(...fakes.map((f) => (typeof f === 'function' ? f : () => f)))
}

beforeEach(async () => {
  requests = []
  replies = []
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body
      requests.push({ body, headers: req.headers })
      const fake = (replies.shift() ?? (() => ({ status: 500, json: {} })))(body)
      if (fake === 'hang') return
      res.writeHead(fake.status ?? 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(fake.json ?? {}))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  expect(requests.filter((r) => 'tools' in r.body || 'tool_choice' in r.body)).toEqual([])
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function setup(overrides: Partial<UnslopEnv> = {}): { env: UnslopEnv; clock: { t: number }; logs: UnslopLog[] } {
  const clock = { t: 1000 }
  const logs: UnslopLog[] = []
  const env: UnslopEnv = {
    profile: { baseUrl: base, apiKey: 'test-key' }, rules: RULES,
    now: () => clock.t, random: (n) => Buffer.alloc(n, 0xab), log: (e) => logs.push(e), ...overrides,
  }
  return { env, clock, logs }
}
const task = (text = INPUT, extra: Partial<UnslopTask> = {}): UnslopTask => ({ text, kind: 'pr', taskId: 't1', ...extra })

describe('backend request', () => {
  it('sends the pinned model and sampling, thinking off, no tools, and a bounded max_tokens', async () => {
    queue(reply(GOOD))
    const { env } = setup()
    const result = await runUnslop(task(), env)
    expect(result).toMatchObject({ code: 0, status: 'rewritten', text: GOOD, model: 'chat-long', attempts: 1, rulesSha256: RULES.sha256 })
    expect(result.hard.urls).toBe('ok')
    const [{ body, headers }] = requests as [typeof requests[number]]
    expect(body).toMatchObject({
      model: 'chat-long', temperature: 0.2, top_p: 0.9, presence_penalty: 0, stream: false,
      chat_template_kwargs: { enable_thinking: false }, max_tokens: maxTokens(INPUT),
    })
    expect(Object.keys(body).sort()).toEqual(['chat_template_kwargs', 'max_tokens', 'messages', 'model', 'presence_penalty', 'stream', 'temperature', 'top_p'])
    expect(headers.authorization).toBe('Bearer test-key')
    expect(maxTokens('x'.repeat(12 * 1024))).toBe(5581)
    expect(maxTokens('x'.repeat(30_000))).toBe(6144)
  })

  it('uses the profile sampling and model when it sets them', async () => {
    queue(reply(GOOD))
    const { env } = setup()
    env.profile = { ...env.profile, model: 'other', sampling: { temperature: 0.7 } }
    await runUnslop(task(), env)
    expect(requests[0]!.body).toMatchObject({ model: 'other', temperature: 0.7, top_p: 0.9, presence_penalty: 0 })
  })

  it('puts the rules after the preamble and the input only between the nonce lines', async () => {
    queue(reply(GOOD))
    const { env } = setup()
    await runUnslop(task(), env)
    const [system, user] = requests[0]!.body.messages as [{ role: string; content: string }, { role: string; content: string }]
    expect(system.role).toBe('system')
    expect(system.content).toMatch(/^You are a copy editor[\s\S]*instruction[\s\S]*RULES-MARKER$/)
    expect(system.content).not.toContain('v2.5.0')
    expect(user.content).toBe(`TEXT ${NONCE} BEGIN\n${INPUT}\nTEXT ${NONCE} END`)
  })

  it('accepts https or loopback http only, and refuses others without a request', async () => {
    expect(checkBaseUrl('https://models.example/').href).toBe('https://models.example/v1/chat/completions')
    expect(checkBaseUrl('https://models.example/llm/').href).toBe('https://models.example/llm/v1/chat/completions')
    expect(checkBaseUrl('http://127.0.0.1:9/').href).toBe('http://127.0.0.1:9/v1/chat/completions')
    expect(checkBaseUrl('http://[::1]:9').href).toBe('http://[::1]:9/v1/chat/completions')
    for (const bad of ['http://models.example', 'http://localhost:9', 'http://127.0.0.1.evil.example', 'http://10.0.0.2', 'ftp://127.0.0.1', 'https://u:p@models.example', 'https://models.example/?x=1', 'nope']) {
      expect(() => checkBaseUrl(bad), bad).toThrow()
    }
    const { env } = setup()
    env.profile = { ...env.profile, baseUrl: 'http://models.example' }
    expect(await runUnslop(task(), env)).toMatchObject({ code: 13, status: 'failed', reason: 'backend-url', attempts: 0 })
    expect(requests).toHaveLength(0)
  })
})

describe('answers', () => {
  it.each([500, 502, 503])('a %i is busy at once, never retried', async (status) => {
    queue({ status, json: { error: 'loading' } }, reply(GOOD))
    const result = await runUnslop(task(), setup().env)
    expect(result).toMatchObject({ code: 12, status: 'busy', reason: 'backend-5xx' })
    expect(result.text).toBeUndefined()
    expect(requests).toHaveLength(1)
  })

  it.each([
    ['truncated', reply(GOOD.slice(0, 20), { finish_reason: 'length' })],
    ['reasoning-only', reply('', { message: { role: 'assistant', content: '', reasoning_content: 'thinking' } })],
    ['empty', reply('   ')],
    ['tool-call', reply('', { finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'x', arguments: '{}' } }] } })],
    ['nonce', reply(`${GOOD}\nTEXT ${NONCE} END`)],
    ['oversized', reply(GOOD.repeat(3) + 'x'.repeat(1024))],
  ])('%s keeps the original without a retry', async (reason, fake) => {
    queue(fake, reply(GOOD))
    expect(await runUnslop(task(), setup().env)).toMatchObject({ code: 10, status: 'kept-original', reason, text: INPUT, attempts: 1 })
    expect(requests).toHaveLength(1)
  })

  it('maps a 4xx and a malformed body to failed', async () => {
    queue({ status: 404, json: {} }, { json: { choices: [] } })
    expect(await runUnslop(task(), setup().env)).toMatchObject({ code: 13, reason: 'backend-http-404' })
    expect(await runUnslop(task(), setup().env)).toMatchObject({ code: 13, reason: 'backend-bad-response' })
  })

  it('removes one code fence wrapped around the whole answer', async () => {
    queue(reply('```markdown\n' + GOOD + '```'))
    expect(await runUnslop(task(), setup().env)).toMatchObject({ code: 0, status: 'rewritten', text: GOOD })
  })

  it('returns unchanged text as unchanged', async () => {
    queue(reply(`\n${INPUT.trim()}`))
    expect(await runUnslop(task(), setup().env)).toMatchObject({ code: 0, status: 'unchanged', text: INPUT })
  })

  it('keeps the original when the text is too complex to check', async () => {
    const many = Array.from({ length: 520 }, (_, i) => `Item ${i}.`).join('\n')
    queue(reply(many.replace('Item 0.', 'Item zero.')))
    expect(await runUnslop(task(many), setup().env)).toMatchObject({ code: 10, reason: 'too-complex' })
  })

  it('fails on an unreachable backend and on the task deadline', async () => {
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const port = (closed.address() as AddressInfo).port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    const { env } = setup({ now: undefined })
    env.profile = { ...env.profile, baseUrl: `http://127.0.0.1:${port}` }
    expect(await runUnslop(task(), env)).toMatchObject({ code: 13, reason: 'unreachable' })

    queue('hang')
    const started = performance.now()
    expect(await runUnslop(task(INPUT, { budgetMs: 150 }), setup({ now: undefined }).env)).toMatchObject({ code: 13, reason: 'deadline' })
    expect(performance.now() - started).toBeLessThan(2000)
  })

  it('stops on cancel', async () => {
    queue('hang')
    const abort = new AbortController()
    const run = runUnslop(task(INPUT, { signal: abort.signal }), setup().env)
    await new Promise((resolve) => setTimeout(resolve, 50))
    abort.abort()
    expect(await run).toMatchObject({ code: 13, reason: 'cancelled' })
  })
})

describe('refusals before any network', () => {
  it.each([
    ['kind', task(INPUT, { kind: 'email' })],
    ['screen', task(`Hi Jane,\n\nThe fix ships Friday ${CANARY}.\n\nBest,\nShariq`)],
    ['size', task('a'.repeat(12 * 1024 + 1))],
    ['control-bytes', task('Line one\r\nLine two\u0007')],
    ['control-bytes', task('Broken \uD800 text')],
    ['empty', task(' \n')],
  ])('%s is refused without a call', async (reason, t) => {
    const result = await runUnslop(t, setup().env)
    expect(result).toMatchObject({ code: 11, status: 'rejected', reason, attempts: 0 })
    expect(result.text).toBeUndefined()
    expect(requests).toHaveLength(0)
  })

  it('accepts exactly 12 KiB with tabs and newlines', async () => {
    const text = 'Tab\there.\n'.padEnd(12 * 1024, 'a')
    queue(reply(text))
    expect(await runUnslop(task(text), setup().env)).toMatchObject({ code: 0, status: 'unchanged' })
  })
})

describe('fidelity and retry', () => {
  it('retries a failed check once with the values to keep, then passes', async () => {
    queue(reply(BAD), reply(GOOD))
    const states: string[] = []
    const result = await runUnslop(task(), setup({ onState: (s) => states.push(s) }).env)
    expect(result).toMatchObject({ code: 0, status: 'rewritten', text: GOOD, attempts: 2 })
    expect(states).toEqual(['editing', 'checking', 'retrying', 'checking'])
    const retry = requests[1]!.body.messages[1]!.content
    expect(retry).toContain('keep these values in this order')
    expect(retry).toContain(`KEEP ${NONCE} BEGIN\nnot\nKEEP ${NONCE} END`)
    expect(retry.endsWith(`TEXT ${NONCE} BEGIN\n${INPUT}\nTEXT ${NONCE} END`)).toBe(true)
  })

  it('keeps the original after two failed checks, with the reasons', async () => {
    queue(reply(BAD), reply(BAD.replace('v2.5.0', 'v2.6.0')))
    const result = await runUnslop(task(), setup().env)
    expect(result).toMatchObject({ code: 10, status: 'kept-original', reason: 'fidelity', text: INPUT, attempts: 2 })
    expect(result.failures!.map((f) => f.class).sort()).toEqual(['negations', 'numbers'])
    expect(result.hard).toMatchObject({ negations: 'failed', numbers: 'failed', urls: 'ok' })
  })

  it('skips the retry when the time left does not cover its output limit', async () => {
    const { env, clock } = setup()
    queue(() => {
      clock.t += 5000
      return reply(BAD)
    })
    // at the default 44 tok/s, this input's limit needs about 7 s; 5 s are left
    expect(await runUnslop(task(INPUT, { budgetMs: 10_000 }), env)).toMatchObject({ code: 10, reason: 'fidelity-no-time', attempts: 1 })
    expect(requests).toHaveLength(1)
  })

  it('retries in the same time when the box reports a fast speed, and splits load from model time', async () => {
    const { env, clock } = setup()
    const timings = { timings: { prompt_n: 100, prompt_ms: 200, predicted_n: 1000, predicted_ms: 1000 } }
    queue(() => {
      clock.t += 5000
      return reply(BAD, {}, timings)
    }, () => {
      clock.t += 1500
      return reply(GOOD, {}, timings)
    })
    const result = await runUnslop(task(INPUT, { budgetMs: 10_000, queuedMs: 7 }), env)
    expect(result).toMatchObject({ code: 0, attempts: 2, ms: { queued: 7, load: 3800, model: 2700, check: 0 } })
  })
})

describe('determinism and logs', () => {
  it('gives the same result and requests for the same clock and random', async () => {
    const run = async (): Promise<unknown> => {
      queue(reply(BAD), reply(GOOD))
      const result = await runUnslop(task(), setup().env)
      return { result, bodies: requests.splice(0).map((r) => r.body) }
    }
    expect(await run()).toEqual(await run())
  })

  it('never logs text or a matched value', async () => {
    const text = `Read https://example.com/${CANARY} for v2.5.0. It does not ship, as "${CANARY}" says.\n`
    queue(reply(text.replace(`/${CANARY}`, '/other').replace('does not ship', 'ships')), reply(text.replace(`/${CANARY}`, '/other')))
    const { env, logs } = setup()
    const kept = await runUnslop(task(text), env)
    expect(JSON.stringify(kept.failures)).toContain(CANARY)
    queue(reply(text.replace('Read', 'See').replace(`"${CANARY}"`, CANARY)))
    expect(JSON.stringify((await runUnslop(task(text), env)).warnings)).toContain(CANARY)
    await runUnslop(task(`Hi ${CANARY},\n\nThe fix ships.\n\nThanks,\nShariq`), env)
    await runUnslop(task(`token: ${CANARY}9f8e7d6c5b4a`), env)
    expect(logs.map((l) => [l.code, l.reason])).toEqual([[10, 'fidelity'], [0, undefined], [11, 'screen'], [11, 'screen']])
    expect(logs[0]).toMatchObject({ taskId: 't1', kind: 'pr', bytesIn: Buffer.byteLength(text), model: 'chat-long', rulesSha256: RULES.sha256 })
    expect(logs[1]!.warnings).toContain('short-quote')
    const all = JSON.stringify(logs)
    expect(all).not.toContain(CANARY)
    expect(all).not.toContain('test-key')
  })
})
