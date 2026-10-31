// test/acp-fake.ts — a fake Copilot ACP agent for the driver's tests (#412).
//
// It speaks newline-delimited JSON-RPC over two in-memory streams and answers
// with frames replayed from the spike's recorded Copilot 1.0.105 transcripts
// (test/fixtures/acp/copilot-1.0.105/): the initialize and session/new results,
// set_mode's update-then-result order, a load's history replay, the permission
// request shape and the config option updates. A test scripts what each prompt
// does. Deliberately NOT named *.test.ts: it is imported, never collected.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

const FIXTURES = join(new URL('.', import.meta.url).pathname, 'fixtures', 'acp', 'copilot-1.0.105')

type Json = Record<string, unknown>
interface Entry { t: number; dir: string; msg?: Json }

export const MODE = {
  agent: 'https://agentclientprotocol.com/protocol/session-modes#agent',
  plan: 'https://agentclientprotocol.com/protocol/session-modes#plan',
  autopilot: 'https://agentclientprotocol.com/protocol/session-modes#autopilot',
}

export function fixture(name: string): Entry[] {
  return readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Entry)
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function resultOf(name: string, method: string): Json {
  const entries = fixture(name)
  const request = entries.find((e) => e.dir === 'c2a' && e.msg?.method === method)!
  return clone(entries.find((e) => e.dir === 'a2c' && e.msg?.id === request.msg!.id && 'result' in e.msg!)!.msg!.result as Json)
}

function updateOf(name: string, kind: string): Json {
  const found = fixture(name).find((e) => e.dir === 'a2c' && ((e.msg?.params as Json | undefined)?.update as Json | undefined)?.sessionUpdate === kind)!
  return clone((found.msg!.params as Json).update as Json)
}

const INITIALIZE = resultOf('initialize-and-session-new', 'initialize')
const SESSION_NEW = resultOf('initialize-and-session-new', 'session/new')
const CONFIG_UPDATE = updateOf('permissions-and-set-mode', 'config_option_update')
const PERMISSION = clone(fixture('permissions-and-set-mode').find((e) => e.msg?.method === 'session/request_permission')!.msg!.params as Json)
const TOOL_CALL = updateOf('permissions-and-set-mode', 'tool_call')

/** A config_option_update as Copilot sends it, with the mode and allow_all set. */
export function configUpdate(mode: string, allowAll: 'on' | 'off'): Json {
  const update = clone(CONFIG_UPDATE)
  for (const option of update.configOptions as Json[]) {
    if (option.id === 'mode') option.currentValue = mode
    if (option.id === 'allow_all') option.currentValue = allowAll
  }
  return update
}

/** The recorded shell permission request; `options` may be replaced. */
export function permissionRequest(session: string, options?: unknown[]): Json {
  return { ...clone(PERMISSION), sessionId: session, ...(options ? { options } : {}) }
}

export function toolCall(): Json {
  return clone(TOOL_CALL)
}

export interface FakeAgent {
  /** The driver's input (the agent's stdout) and output (the agent's stdin). */
  stdout: PassThrough
  stdin: PassThrough
  session: string
  /** Every message the driver wrote, in order. */
  received: Json[]
  mode: string
  allowAll: 'on' | 'off'
  /** Writes messages to the driver as ONE chunk, so it reads them together. */
  send(...messages: Json[]): void
  update(update: Json): void
  respond(id: unknown, result: unknown): void
  /** Resolves when the driver has written a message matching `match` (from index `from`). */
  waitFor(match: (m: Json) => boolean, from?: number): Promise<Json>
  prompts(): string[]
  exited: Promise<unknown>
  exit(): void
  kill: (signal: NodeJS.Signals) => void
}

export interface FakeScript {
  /** What a prompt does; the default answers end_turn at once. */
  onPrompt?: (fake: FakeAgent, id: unknown, text: string) => void
  /** Overrides the mode a session starts or loads in. */
  initial?: { mode: string; allowAll: 'on' | 'off' }
  /** Replays the recorded load history before answering session/load. */
  loadReplay?: boolean
  /** Whether set_mode #agent out of autopilot also turns allow_all off (Copilot does). */
  keepAllowAll?: boolean
  /** An agent that answers set_config_option allow_all=off without turning it off. */
  ignoreAllowAllOff?: boolean
}

export function fakeAgent(script: FakeScript = {}): FakeAgent {
  const stdout = new PassThrough()
  const stdin = new PassThrough()
  let exitNow!: () => void
  const exited = new Promise<unknown>((resolve) => { exitNow = () => resolve(undefined) })
  const waiters: Array<{ match: (m: Json) => boolean; from: number; resolve: (m: Json) => void }> = []
  let openPrompt: unknown = null
  const fake: FakeAgent = {
    stdout, stdin, session: '55ba6944-a05f-4a11-8892-86c375399e94', received: [],
    mode: script.initial?.mode ?? MODE.agent, allowAll: script.initial?.allowAll ?? 'off',
    send(...messages) {
      stdout.write(messages.map((m) => `${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`).join(''))
    },
    update(update) {
      fake.send({ method: 'session/update', params: { sessionId: fake.session, update } })
    },
    respond(id, result) {
      if (id === openPrompt) openPrompt = null
      fake.send({ id, result })
    },
    waitFor(match, from = 0) {
      const found = fake.received.slice(from).find(match)
      if (found) return Promise.resolve(found)
      return new Promise((resolve) => waiters.push({ match, from, resolve }))
    },
    prompts() {
      return fake.received.filter((m) => m.method === 'session/prompt')
        .map((m) => (((m.params as Json).prompt as Json[])[0]!.text as string))
    },
    exited,
    exit() { exitNow() },
    kill: () => exitNow(),
  }
  const setMode = (mode: string) => {
    fake.mode = mode
    if (mode === MODE.autopilot) fake.allowAll = 'on'
    else if (!script.keepAllowAll) fake.allowAll = 'off'
  }
  let buffer = ''
  stdin.setEncoding('utf8')
  stdin.on('data', (chunk: string) => {
    buffer += chunk
    for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, end)) as Json
      buffer = buffer.slice(end + 1)
      fake.received.push(message)
      for (const waiter of [...waiters]) {
        if (fake.received.length > waiter.from && waiter.match(message)) {
          waiters.splice(waiters.indexOf(waiter), 1)
          waiter.resolve(message)
        }
      }
      handle(message)
    }
  })
  stdin.on('end', () => exitNow())

  const handle = (m: Json) => {
    const params = (m.params ?? {}) as Json
    switch (m.method) {
      case 'initialize': return fake.respond(m.id, INITIALIZE)
      case 'session/new': {
        const result = clone(SESSION_NEW)
        result.sessionId = fake.session
        ;(result.modes as Json).currentModeId = fake.mode
        for (const o of result.configOptions as Json[]) {
          if (o.id === 'mode') o.currentValue = fake.mode
          if (o.id === 'allow_all') o.currentValue = fake.allowAll
        }
        return fake.respond(m.id, result)
      }
      case 'session/load': {
        fake.session = params.sessionId as string
        const replay = fixture('load-restores-autopilot')
        const frames: Json[] = []
        if (script.loadReplay) {
          for (const e of replay) {
            if (e.dir !== 'a2c' || e.msg?.method !== 'session/update') continue
            if (e.t > 1118) break
            frames.push({ ...clone(e.msg), params: { ...clone(e.msg.params as Json), sessionId: fake.session } })
          }
        }
        const result = clone(replay.find((e) => e.dir === 'a2c' && e.msg?.id === 2)!.msg!.result as Json)
        ;(result.modes as Json).currentModeId = fake.mode
        for (const o of result.configOptions as Json[]) {
          if (o.id === 'mode') o.currentValue = fake.mode
          if (o.id === 'allow_all') o.currentValue = fake.allowAll
        }
        return fake.send(...frames, { id: m.id, result })
      }
      case 'session/set_mode': {
        const mode = params.modeId as string
        if (!Object.values(MODE).includes(mode)) {
          return fake.send({ id: m.id, error: { code: -32602, message: `Invalid mode '${mode}'.` } })
        }
        setMode(mode)
        // Copilot: the mode update, then (here) the config update, then the result (spike §4)
        return fake.send(
          { method: 'session/update', params: { sessionId: fake.session, update: { sessionUpdate: 'current_mode_update', currentModeId: mode } } },
          { method: 'session/update', params: { sessionId: fake.session, update: configUpdate(fake.mode, fake.allowAll) } },
          { id: m.id, result: {} },
        )
      }
      case 'session/set_config_option': {
        if (params.configId === 'allow_all' && !script.ignoreAllowAllOff) fake.allowAll = params.value as 'on' | 'off'
        return fake.send(
          { method: 'session/update', params: { sessionId: fake.session, update: configUpdate(fake.mode, fake.allowAll) } },
          { id: m.id, result: { configOptions: (configUpdate(fake.mode, fake.allowAll).configOptions) } },
        )
      }
      case 'session/prompt': {
        // a second prompt during a turn cancels the running one (spike §3)
        if (openPrompt !== null) fake.respond(openPrompt, { stopReason: 'cancelled' })
        openPrompt = m.id
        const text = ((params.prompt as Json[])[0]!.text as string)
        if (script.onPrompt) return script.onPrompt(fake, m.id, text)
        fake.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } })
        return fake.respond(m.id, { stopReason: 'end_turn', usage: { totalTokens: 1 } })
      }
      case 'session/cancel':
        if (openPrompt !== null) fake.respond(openPrompt, { stopReason: 'cancelled' })
        return
      default:
    }
  }
  return fake
}
