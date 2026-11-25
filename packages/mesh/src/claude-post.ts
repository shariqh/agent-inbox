// The model call for a Claude Code server (Claude Code as a model server, D3): a Post that runs
// the installed claude program once in its print mode, with everything switched off, in place of
// an HTTP request. It takes the OpenAI-style body the callers already build (requestBody), reads
// the model and the first system and user messages from it, and ignores the URL, the headers,
// max_tokens, sampling and chat_template_kwargs. The program runs without a shell, asynchronously,
// in an empty folder, with an allow-listed environment (so no ANTHROPIC_* variable reaches it: it
// runs on the person's Claude sign-in or not at all), the user text on stdin. Its one JSON object
// is mapped to the HttpReply `classify` reads, so the callers need no change. Its error sentence,
// its stderr and its path are never forwarded, logged or printed.
import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { transportError } from './backend.js'
import type { HttpReply, Post } from './backend.js'

/** The models a Claude Code server takes, as `--model` names them. */
export const CLAUDE_MODELS: readonly string[] = ['haiku', 'sonnet', 'opus']
/** The only variables the program is given, each when set. */
const CLAUDE_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL']
/** One call's ceiling, whatever time the task has left. */
export const CALL_MAX_MS = 120_000
const STDOUT_MAX = 1024 * 1024
const KILL_GRACE_MS = 2000
/** The callers' own default speed: a shaped rate never reads below it. */
const FLOOR_TOKENS_PER_S = 44

export type ClaudePostOptions = { program: string; env: NodeJS.ProcessEnv; cwd: string; spawn?: typeof nodeSpawn }

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)

/** The model and the first system and user messages of a requestBody, or undefined. */
function request(body: string): { model: string; system: string; user: string } | undefined {
  try {
    const parsed = obj(JSON.parse(body))
    const messages = Array.isArray(parsed.messages) ? parsed.messages.map(obj) : []
    const system = messages.find((m) => m.role === 'system')?.content
    const user = messages.find((m) => m.role === 'user')?.content
    const model = parsed.model
    return typeof model === 'string' && typeof system === 'string' && typeof user === 'string' ? { model, system, user } : undefined
  } catch {
    return undefined
  }
}

/**
 * The HttpReply for the program's stdout, or undefined when it is not the one JSON object. An
 * answer becomes an OpenAI-shaped 200; an error a bare status (its sentence is dropped).
 */
function reply(stdout: string, wallMs: number): HttpReply | undefined {
  let out: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(stdout)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    out = parsed as Record<string, unknown>
  } catch {
    return undefined
  }
  if (out.is_error === true) {
    const status = out.api_error_status
    return { status: Number.isInteger(status) && (status as number) >= 400 && (status as number) <= 599 ? (status as number) : 400, body: '{}' }
  }
  if (out.is_error !== false || typeof out.result !== 'string') return undefined
  const usage = obj(out.usage)
  const [input, created, read, output] = [num(usage.input_tokens), num(usage.cache_creation_input_tokens), num(usage.cache_read_input_tokens), num(usage.output_tokens)]
  const counts = {
    ...(input !== undefined && created !== undefined && read !== undefined ? { prompt_tokens: input + created + read } : {}),
    ...(output !== undefined ? { completion_tokens: output } : {}),
  }
  // the start-up counts as prompt time, so no model load is booked, and the rate never reads
  // below the callers' default: a short answer after a second of waiting must not stop a run
  const api = num(out.duration_api_ms)
  const timings = api === undefined ? undefined : {
    prompt_ms: Math.max(0, wallMs - api), predicted_ms: api, predicted_n: Math.max(output ?? 0, Math.ceil((FLOOR_TOKENS_PER_S * api) / 1000)),
  }
  return {
    status: 200,
    body: JSON.stringify({
      choices: [{ message: { role: 'assistant', content: out.result }, finish_reason: 'stop' }],
      ...(Object.keys(counts).length ? { usage: counts } : {}),
      ...(timings ? { timings } : {}),
    }),
  }
}

/** A Post that runs `program` once per call; `spawn` is a test seam. */
export function claudePost(options: ClaudePostOptions): Post {
  const spawn = options.spawn ?? nodeSpawn
  const env = Object.fromEntries(CLAUDE_ENV.filter((name) => options.env[name] !== undefined).map((name) => [name, options.env[name]]))
  return (_url, body, _headers, { timeoutMs, signal }) => new Promise((resolve, reject) => {
    const asked = request(body)
    if (!asked) return reject(transportError('invalid'))
    if (signal?.aborted) return reject(transportError('aborted'))
    const argv = ['-p', '--safe-mode', '--tools', '', '--system-prompt', asked.system, '--model', asked.model, '--no-session-persistence', '--output-format', 'json']
    const started = performance.now()
    let child: ChildProcess
    try {
      child = spawn(options.program, argv, { cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    } catch {
      return reject(transportError('unreachable'))
    }
    let settled = false
    let killer: NodeJS.Timeout | undefined
    const stop = (): void => {
      child.kill('SIGTERM')
      killer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
      killer.unref()
    }
    const finish = (error?: Error, value?: HttpReply): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(value!)
    }
    const fail = (reason: 'deadline' | 'aborted' | 'too-large'): void => {
      if (settled) return
      stop()
      finish(transportError(reason))
    }
    const onAbort = (): void => fail('aborted')
    const deadline = setTimeout(() => fail('deadline'), Math.max(0, Math.min(timeoutMs, CALL_MAX_MS)))
    signal?.addEventListener('abort', onAbort, { once: true })
    const chunks: Buffer[] = []
    let size = 0
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > STDOUT_MAX) fail('too-large')
      else chunks.push(chunk)
    })
    // stderr is drained and dropped; a stdin the program closed early is not an error here
    child.stderr?.resume()
    child.stdin?.on('error', () => {})
    child.on('error', () => finish(transportError('unreachable')))
    child.on('close', () => {
      clearTimeout(killer)
      if (settled) return
      const got = reply(Buffer.concat(chunks).toString('utf8'), performance.now() - started)
      if (got) finish(undefined, got)
      else finish(transportError('unreachable'))
    })
    child.stdin?.end(asked.user)
  })
}
