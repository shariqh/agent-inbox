// A stand-in for the local window's mesh bridge (`agentInboxMesh`, electron/setup-preload.cjs) for
// the Agent cards tab's set-up screens (agent setup in the app, step 2b): it records every operation
// with its values, answers each as the preload would, and can hold an answer to show a run in flight.
// Nothing runs: no command, no file, no home.
import meshProcess from '../../electron/mesh-process.cjs'

type Json = Record<string, unknown>

/** The built-ins that are not on, as src/mesh-agents.ts answers them (D8). */
export const OFFERED: Record<string, Json> = {
  unslop: { name: 'unslop', blurb: 'Copy-edits public text by the unslop rules.', needs: 'model-server' },
  'unslop-code': { name: 'unslop-code', blurb: 'Removes the comments an AI coding agent adds to code.', needs: 'model-server' },
  'request-post': { name: 'request-post', blurb: 'Files a post request with your publishing service.', needs: 'address-and-token' },
}
export const ALL_OFFERED = [OFFERED['unslop']!, OFFERED['unslop-code']!, OFFERED['request-post']!]

// an address server's row as the command prints it, kind and all
export const server = (name: string, over: Json = {}): Json => ({ name, kind: 'http', baseUrl: `http://127.0.0.1:8080/${name}`, key: 'none', agents: [], ...over })
// the same row as a command older than the Claude Code kind prints it: no kind
export const olderServer = (name: string, over: Json = {}): Json => {
  const { kind: _kind, ...row } = server(name, over)
  return row
}
// Claude Code on this Mac, as the command prints its row: no address, no key
export const claudeServer = (name: string, over: Json = {}): Json => ({ name, kind: 'claude-code', baseUrl: '', key: 'none', agents: [], ...over })
// the models a Claude Code server answers, in the command's own (sorted) order
export const CLAUDE_MODELS = ['haiku', 'opus', 'sonnet']

/** The server list's answer, shaped by the real bridge from the command's own output. */
export const listed = (servers: Json[], inline: string[] = []): Json =>
  meshProcess.meshAnswer('servers', JSON.stringify({ servers, inline }), 0) as Json

/** A plan's answer (a dry run or the real one), shaped by the real bridge. */
export const planned = (apply: boolean): Json =>
  meshProcess.meshAnswer('plan', JSON.stringify({ applied: apply, steps: apply ? [] : ['Write mesh.json'] }), 0) as Json

export const HANDLE = 'a1'.repeat(16)

/**
 * A server check's answer, shaped by the real bridge (`meshAnswer`) from the command's own output and
 * exit code, so a test cannot hand the page an answer the app never gives. A check that ran and found
 * the server unusable exits 1: the bridge answers `ok: false` with the `failure` and no `reason`.
 */
export const checked = (failure?: string, models: string[] = ['model-a', 'model-b']): Json =>
  meshProcess.meshAnswer('check', JSON.stringify({
    server: 'local', kind: 'http', baseUrl: 'http://127.0.0.1:8080/local', key: 'none', reachable: failure === undefined,
    ...(failure === undefined ? {} : { failure }), models: failure === undefined ? models : [], skipped: 0,
  }), failure === undefined ? 0 : 1) as Json

/**
 * A Claude Code server's check, shaped by the real bridge: its kind, and the three model names or a
 * failure (no-program, signed-out, timeout). `kind: false`: as a command that names no kind prints it.
 */
export const checkedClaude = (failure?: string, { models = CLAUDE_MODELS, kind = true }: { models?: string[]; kind?: boolean } = {}): Json =>
  meshProcess.meshAnswer('check', JSON.stringify({
    server: 'claude', ...(kind ? { kind: 'claude-code' } : {}), baseUrl: '', key: 'none', reachable: failure === undefined,
    ...(failure === undefined ? {} : { failure }), models: failure === undefined ? models : [], skipped: 0,
  }), failure === undefined ? 0 : 1) as Json

export function fakeBridge(init: { available?: Json; servers?: Json[]; inline?: string[] } = {}) {
  const s = {
    available: init.available ?? { available: true },
    servers: init.servers ?? [],
    inline: init.inline ?? [],
    calls: [] as Array<[string, Json]>,
    picks: [] as string[],
    // an operation's answer, when a test sets one; else the defaults below
    answers: {} as Record<string, (values: Json) => Json>,
    // while set, every run waits for it
    hold: null as null | Promise<void>,
    // milliseconds every run takes before it answers, as the real bridge's does (it runs a command)
    delay: 0,
    file: { ok: true, handle: HANDLE, name: 'server.key' } as Json,
  }
  const value = {
    available: async () => s.available,
    run: async (operation: string, values: Json) => {
      s.calls.push([operation, values])
      if (s.delay) await new Promise<void>((done) => { setTimeout(done, s.delay) })
      if (s.hold) await s.hold
      const answer = s.answers[operation]
      if (answer) return answer(values)
      if (operation === 'servers') return listed(s.servers, s.inline)
      if (operation === 'check-server') return checked()
      return planned(values['apply'] === true)
    },
    chooseFile: async (purpose: string) => {
      s.picks.push(purpose)
      return s.file
    },
  }
  Object.defineProperty(window, 'agentInboxMesh', { configurable: true, value })
  return {
    s,
    /** every operation but the server list, as [operation, values] */
    ops: () => s.calls.filter(([operation]) => operation !== 'servers'),
    /** holds every run until the returned function is called */
    hold: () => {
      let release = () => {}
      s.hold = new Promise<void>((done) => { release = done })
      return () => {
        s.hold = null
        release()
      }
    },
  }
}

/**
 * Chrome drops focus to the body when the focused control becomes disabled; jsdom does not. This makes
 * jsdom do it, so a test sees what the real app does when a repaint disables the focused button.
 * Returns the function that stops it.
 */
export function blurWhenDisabled(): () => void {
  const watch = new MutationObserver(() => {
    const active = document.activeElement
    if (!(active instanceof HTMLButtonElement) || !active.disabled) return
    // jsdom will not blur a disabled control: enable it for the blur, then disable it again
    active.disabled = false
    active.blur()
    active.disabled = true
    watch.takeRecords()
  })
  watch.observe(document.body, { attributes: true, attributeFilter: ['disabled'], subtree: true })
  return () => watch.disconnect()
}
