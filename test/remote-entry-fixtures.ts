// test/remote-entry-fixtures.ts: shared by the hub controller's tests (#617, PR 2c,
// electron/remote-entry.cjs).
//
// Deliberately NOT named *.test.ts: it is imported, never collected.
//
// Every value is synthetic: `hub.example.ts.net`, `owner@example.com`, `laptop`. No test runs
// the real `tailscale`: every run goes through `fakeTailscale`, which records each call so a
// test file can assert, once all its tests ran, that only the two allowed argument lists ever
// reached it.
//
// Where the Tailscale shapes come from:
// - `tailscale status --json` (selfStatus, taggedStatus): the fields are as observed on a real
//   machine running Tailscale 1.102 (Self.DNSName with a trailing dot, Self.UserID a number while
//   the User map's keys are strings, a tagged node's UserID still resolving to a placeholder user,
//   BackendState). The values are synthetic.
// - `tailscale serve status --json`: two shapes are FROM A REAL RUN (Tailscale 1.102.4, macOS,
//   2026-11-17; host replaced): `{}` with nothing configured, and goodServe() below, the exact
//   output after `tailscale serve --bg 4320` (no AllowFunnel, Foreground or Services key). Every
//   other configured shape (each variant in test/serve-state.test.ts) is written from Tailscale's
//   documentation of `ServeConfig` (AllowFunnel, TCPForward, TerminateTLS, a second path,
//   Foreground, Services, AcceptAppCaps), NOT from a real run.
import { HOST, LOGIN } from './remote-fixtures.js'

export { HOST, LOGIN }
export const USER_ID = 7004356810051234

/** `tailscale status --json` for an untagged hub signed in as LOGIN (the fields this module reads, plus some it ignores). */
export function selfStatus(over: Record<string, unknown> = {}, self: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Version: '1.102.0-synthetic',
    BackendState: 'Running',
    Self: { ID: 'nSynthetic', HostName: 'hub', DNSName: `${HOST}.`, UserID: USER_ID, Online: true, ...self },
    User: { [String(USER_ID)]: { ID: USER_ID, LoginName: LOGIN, DisplayName: 'Owner' } },
    CertDomains: [HOST],
    ...over,
  }
}

/** A tagged node: Tags set, and its UserID still resolves to Tailscale's placeholder user for tagged devices. */
export function taggedStatus(): Record<string, unknown> {
  return selfStatus({ User: { '9001': { ID: 9001, LoginName: 'tagged-devices', DisplayName: 'Tagged Devices' } } }, { UserID: 9001, Tags: ['tag:server'] })
}

/** The one good Serve shape for HOST and `port`: from a real run of `tailscale serve --bg 4320` (host replaced). */
export function goodServe(port = 4320, host = HOST): Record<string, unknown> {
  return {
    TCP: { '443': { HTTPS: true } },
    Web: { [`${host}:443`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } },
  }
}

export interface TailscaleCall { file: string; args: string[]; options: Record<string, unknown> }

/** Every call any fake below received, in this test file. */
export const tailscaleCalls: TailscaleCall[] = []

type Answer = unknown | { error: NodeJS.ErrnoException & { killed?: boolean } } | { raw: string }
type ExecFile = (file: string, args: readonly string[], options: Record<string, unknown>, callback: (error: Error | null, stdout: string, stderr: string) => void) => void

/**
 * A stand-in for child_process.execFile. `self` answers `status --json`, `serve` answers
 * `serve status --json`; each may be a value (sent as JSON), `{ raw }` (sent as is), `{ error }`,
 * or a function of the call count giving one of those. Anything else is answered with an error.
 */
export function fakeTailscale(answers: { self?: Answer | ((n: number) => Answer); serve?: Answer | ((n: number) => Answer) } = {}): ExecFile & { calls: TailscaleCall[] } {
  const calls: TailscaleCall[] = []
  const count = { self: 0, serve: 0 }
  const fake = ((file, args, options, callback) => {
    const call = { file, args: [...args], options }
    calls.push(call)
    tailscaleCalls.push(call)
    const which = args.join(' ') === 'status --json' ? 'self' : args.join(' ') === 'serve status --json' ? 'serve' : null
    if (which === null) {
      queueMicrotask(() => callback(Object.assign(new Error('unexpected arguments'), { code: 2 }), '', ''))
      return
    }
    count[which] += 1
    const given = answers[which]
    const answer = typeof given === 'function' ? (given as (n: number) => Answer)(count[which]) : given
    queueMicrotask(() => {
      if (answer === undefined) callback(Object.assign(new Error('Command failed'), { code: 1 }), '', 'not configured')
      else if (answer && typeof answer === 'object' && 'error' in answer) callback((answer as { error: Error }).error, '', '')
      else if (answer && typeof answer === 'object' && 'raw' in answer) callback(null, (answer as { raw: string }).raw, '')
      else callback(null, JSON.stringify(answer), '')
    })
  }) as ExecFile & { calls: TailscaleCall[] }
  fake.calls = calls
  return fake
}

/** Only the first fixed path exists. */
export const cliExists = (path: string): boolean => path === '/usr/local/bin/tailscale'

/** The two argument lists, and nothing else, ever (design §3.2: the app never changes Tailscale). */
export const ALLOWED_ARGS = [['status', '--json'], ['serve', 'status', '--json']]
