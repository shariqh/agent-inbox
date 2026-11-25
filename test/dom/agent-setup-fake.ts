// A stand-in for the local window's mesh bridge (`agentInboxMesh`, electron/setup-preload.cjs) for
// the Agent cards tab's set-up screens (agent setup in the app, step 2b): it records every operation
// with its values, answers each as the preload would, and can hold an answer to show a run in flight.
// Nothing runs: no command, no file, no home.
type Json = Record<string, unknown>

/** The built-ins that are not on, as src/mesh-agents.ts answers them (D8). */
export const OFFERED: Record<string, Json> = {
  unslop: { name: 'unslop', blurb: 'Copy-edits public text by the unslop rules.', needs: 'model-server' },
  'unslop-code': { name: 'unslop-code', blurb: 'Removes the comments an AI coding agent adds to code.', needs: 'model-server' },
  'request-post': { name: 'request-post', blurb: 'Files a post request with your publishing service.', needs: 'address-and-token' },
}
export const ALL_OFFERED = [OFFERED['unslop']!, OFFERED['unslop-code']!, OFFERED['request-post']!]

export const server = (name: string, over: Json = {}): Json => ({ name, baseUrl: `http://127.0.0.1:8080/${name}`, key: 'none', agents: [], ...over })

export const HANDLE = 'a1'.repeat(16)

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
    file: { ok: true, handle: HANDLE, name: 'server.key' } as Json,
  }
  const value = {
    available: async () => s.available,
    run: async (operation: string, values: Json) => {
      s.calls.push([operation, values])
      if (s.hold) await s.hold
      const answer = s.answers[operation]
      if (answer) return answer(values)
      if (operation === 'servers') return { ok: true, servers: s.servers, inline: s.inline }
      if (operation === 'check-server') return { ok: true, reachable: true, models: ['model-a', 'model-b'], skipped: 0 }
      return { ok: true, applied: values['apply'] === true, steps: values['apply'] === true ? [] : ['Write mesh.json'] }
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
