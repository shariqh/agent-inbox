'use strict'
// Tailscale, read-only, for the hub's remote-entry controller (#617, PR 2c; electron/remote-entry.cjs
// is the controller and the only module that requires this one). Split from it for size only.
//
// Design: docs/superpowers/specs/2026-11-17-remote-inbox-design.md §3.2 "Serve's shape, checked by
// main"; architecture notes in docs/architecture/remote-inbox.md. This file finds the command line
// at three fixed paths and runs it with exactly three argument lists, argv only, never a shell. It
// never changes Tailscale's configuration, and it logs nothing.
const { existsSync } = require('node:fs')
const childProcess = require('node:child_process')

const OUTPUT_MAX = 1024 * 1024
// the whole peer list: a real tailnet with 531 peers printed 822 KB, so it gets its own, larger cap
const PEERS_OUTPUT_MAX = 16 * 1024 * 1024
const RUN_TIMEOUT_MS = 5_000

// Shown to the person to remove a background Serve configuration, never run. The `off` form is
// from Tailscale's documentation; it has not yet been seen in real output.
const REMOVAL_HINT = 'tailscale serve --https=443 off'

// The third is the App Store or standalone app's own binary: a Mac with no command-line install has
// only that one. It answers `version`, `status --json` and `status --json --peers=false` correctly
// (seen on a real machine, Tailscale 1.102.4), but only as a command line: see CLI_ENV.
const TAILSCALE_PATHS = Object.freeze([
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
])
// The only three argument lists this module ever runs. runTailscale takes a key, never a list.
// `self` leaves the peers out: this node, its user and its tags are all it needs, and the full list
// can pass 1 MiB on a large tailnet, which would switch sharing off. `peers` is the full list, for
// the connecting Mac to find the hub among its peers (the next PR; there is no peer parser here).
const TAILSCALE_ARGS = Object.freeze({
  self: Object.freeze(['status', '--json', '--peers=false']),
  serve: Object.freeze(['serve', 'status', '--json']),
  peers: Object.freeze(['status', '--json']),
})
const OUTPUT_CAPS = Object.freeze({ self: OUTPUT_MAX, serve: OUTPUT_MAX, peers: PEERS_OUTPUT_MAX })
const RUN_OPTIONS = Object.freeze({ timeout: RUN_TIMEOUT_MS, encoding: 'utf8', shell: false, windowsHide: true })
// Tailscale's app binary is the app and the command line in one file. It picks between them from
// its environment (SHLVL, TERM, TERM_PROGRAM, PS1), and an app opened from Finder has none of
// those: the binary then prints "The Tailscale GUI failed to start" and exits 0, which read as
// Tailscale that cannot be read (seen on a real Mac with only that binary, 2026-11-18; from a shell
// the same run answers). This variable is Tailscale's documented way to ask for the command line
// (tailscale.com/kb/1080/cli). It is added to this app's own environment for the one run, and it
// changes nothing for a real command-line install.
const CLI_ENV = Object.freeze({ TAILSCALE_BE_CLI: '1' })

// The viewer's reader rules for a host and a login (src/viewer-remote.ts), shared with the controller.
const HOST_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const chars = (text) => Array.from(text).length
const plainText = (value, max) => typeof value === 'string' && chars(value) >= 1 && chars(value) <= max && !CONTROL.test(value)
const validHost = (host) => typeof host === 'string' && host.length <= 253 && HOST_PATTERN.test(host)
  && /[a-z]/.test(host.slice(host.lastIndexOf('.') + 1))
// Tailscale's placeholder user for tagged devices: never a person's login, whatever Self.Tags says
const PLACEHOLDER_LOGIN = 'tagged-devices'
const FORMAT = /\p{Cf}/u
const EDGE_SPACE = /^\s|\s$/u

// ── Tailscale, read-only ───────────────────────────────────────────────────

/** The first of the fixed paths that exists, else null. Never a search, never a configured path. */
function tailscaleCli(exists = existsSync) {
  for (const candidate of TAILSCALE_PATHS) {
    try {
      if (exists(candidate)) return candidate
    } catch {
      // a check that throws is a path that is not there
    }
  }
  return null
}

/** One read: `self`, `serve` or `peers`, argv only, no shell, 5 seconds, its own output cap, asked for as a command line (CLI_ENV). Resolves `{ ok, text }` or `{ ok: false, reason }`. */
function runTailscale(which, deps) {
  const args = Object.hasOwn(TAILSCALE_ARGS, which) ? TAILSCALE_ARGS[which] : null
  if (!args) return Promise.resolve({ ok: false, reason: 'failed' })
  const cap = OUTPUT_CAPS[which]
  const cli = tailscaleCli(deps.exists ?? existsSync)
  if (!cli) return Promise.resolve({ ok: false, reason: 'no_cli' })
  return new Promise((resolve) => {
    let done = false
    let guard = null
    const finish = (result) => {
      if (done) return
      done = true
      if (guard !== null) (deps.clearTimeout ?? clearTimeout)(guard)
      resolve(result)
    }
    // a second limit, in case the command line ignores the first
    guard = (deps.setTimeout ?? setTimeout)(() => finish({ ok: false, reason: 'failed' }), RUN_TIMEOUT_MS + 1_000)
    guard?.unref?.()
    try {
      const execFile = deps.execFile ?? childProcess.execFile
      execFile(cli, [...args], { ...RUN_OPTIONS, maxBuffer: cap, env: { ...process.env, ...CLI_ENV } }, (error, stdout) => {
        if (error) return finish({ ok: false, reason: 'failed' })
        const text = typeof stdout === 'string' ? stdout : Buffer.isBuffer(stdout) ? stdout.toString('utf8') : null
        if (text === null || Buffer.byteLength(text) > cap) return finish({ ok: false, reason: 'failed' })
        finish({ ok: true, text })
      })
    } catch {
      finish({ ok: false, reason: 'failed' })
    }
  })
}

/**
 * This node from `tailscale status --json`: `{ ok, host, login }`, or `{ ok: false, reason }`.
 * Self.UserID is a number while the User map's keys are strings; it is read from the JSON text so
 * an ID past 2^53 keeps its digits. A tagged node is decided from Self.Tags: its UserID still
 * resolves to a placeholder user, whose login (`tagged-devices`) is refused even without Tags.
 * Never throws: output nested too deep for the reviver reads as not JSON.
 */
function parseTailnetSelf(text) {
  try {
    return readSelf(text)
  } catch {
    return { ok: false, reason: 'not_json' }
  }
}

function readSelf(text) {
  let value
  try {
    value = JSON.parse(text, (key, raw, context) => (
      key === 'UserID' && typeof raw === 'number' && !Number.isSafeInteger(raw) && typeof context?.source === 'string' ? context.source : raw))
  } catch {
    return { ok: false, reason: 'not_json' }
  }
  if (!isObject(value) || !isObject(value.Self)) return { ok: false, reason: 'not_json' }
  if (value.BackendState !== 'Running') return { ok: false, reason: 'not_running' }
  const self = value.Self
  const tags = self.Tags
  if (!(tags === undefined || tags === null || (Array.isArray(tags) && tags.length === 0))) return { ok: false, reason: 'tagged' }
  if (typeof self.DNSName !== 'string' || self.DNSName.replace(/\.$/, '') === '') return { ok: false, reason: 'no_dns_name' }
  const host = self.DNSName.toLowerCase().replace(/\.$/, '')
  if (!validHost(host)) return { ok: false, reason: 'bad_host' }
  const id = self.UserID
  const key = Number.isSafeInteger(id) && id > 0 ? String(id) : typeof id === 'string' && /^[1-9]\d{0,19}$/.test(id) ? id : null
  const user = key !== null && isObject(value.User) && Object.hasOwn(value.User, key) ? value.User[key] : null
  const login = isObject(user) ? user.LoginName : undefined
  if (typeof login === 'string' && login.toLowerCase() === PLACEHOLDER_LOGIN) return { ok: false, reason: 'tagged' }
  // the reader's rule, and no format character or edge space: a person reads it, and it must match exactly
  if (!plainText(login, 254) || FORMAT.test(login) || EDGE_SPACE.test(login)) return { ok: false, reason: 'no_login' }
  return { ok: true, host, login }
}

const SERVE_KEYS = new Set(['TCP', 'Web', 'AllowFunnel', 'Foreground', 'Services'])
// the keys a TCP entry and a web handler may hold (ServeConfig's TCPPortHandler and HTTPHandler)
const TCP_KEYS = new Set(['HTTPS', 'HTTP', 'TCPForward', 'TerminateTLS', 'ProxyProtocol'])
const HANDLER_KEYS = new Set(['Path', 'Proxy', 'Text', 'AcceptAppCaps', 'Redirect'])
// a real configuration is about 8 levels deep (a foreground session adds 2); past this, unknown
const MAX_DEPTH = 32

/** A Web or AllowFunnel key as host:port, lowercased, a trailing dot on the host dropped. */
const hostKey = (key) => key.toLowerCase().replace(/\.:(\d+)$/, ':$1')

/**
 * Visits every key and string inside `value` with an explicit stack, never recursion, so output
 * nested 100,000 deep cannot overflow the stack. `visit` returns true to stop. Gives
 * `{ found, depth }`: whether `visit` stopped it, and the deepest level seen.
 */
function walk(value, visit) {
  const stack = [[value, 0]]
  let depth = 0
  while (stack.length > 0) {
    const [node, level] = stack.pop()
    if (level > depth) depth = level
    if (typeof node === 'string') {
      if (visit(node)) return { found: true, depth }
    } else if (Array.isArray(node)) {
      for (const child of node) stack.push([child, level + 1])
    } else if (isObject(node)) {
      for (const [key, child] of Object.entries(node)) {
        if (visit(key)) return { found: true, depth }
        stack.push([child, level + 1])
      }
    }
  }
  return { found: false, depth }
}

/** A port as written: plain decimal digits only (Go reads a leading zero; a service name is not a number). */
const portNumber = (text) => (typeof text === 'string' && /^\d{1,5}$/.test(text) ? Number(text) : null)

/** `TCPForward`'s port: `host:port` or `[v6]:port`. Null when it is not that shape with a decimal port. */
function forwardPort(target) {
  if (typeof target !== 'string') return null
  const match = target.match(/^(?:\[[^\]]*\]|[^:[\]]+):([^:]*)$/)
  return match ? portNumber(match[1]) : null
}

/** A handler's `Proxy` port: `http`, `https` or `https+insecure` URL, the scheme's default when none is written. Null otherwise. */
function proxyPort(target) {
  if (typeof target !== 'string') return null
  const match = target.match(/^(http|https|https\+insecure):\/\/(?:\[[^\]]*\]|[^/:?#[\]]+)(?::([^/?#]*))?(?:[/?#].*)?$/)
  if (!match) return null
  if (match[2] === undefined) return match[1] === 'http' ? 80 : 443
  return portNumber(match[2])
}

/**
 * `tailscale serve status --json` for `host` and the entry's loopback `port`: `{ ok: true }` only
 * for exactly one handler for host:443, at `/`, with only `Proxy: http://127.0.0.1:<port>`; 443
 * exactly `{ HTTPS: true }`; nothing else that reaches the port; no Funnel on host:443; and no key
 * or shape this build does not recognise. Otherwise `{ ok: false, reason, present }`, where
 * `present` says some configuration names host:443 or the port. Unknown is never ok.
 */
function parseServeStatus(text, host, port) {
  const target = typeof host === 'string' ? host.toLowerCase() : ''
  if (!validHost(target) || !Number.isInteger(port) || port < 1024 || port > 65535) return { ok: false, reason: 'bad_request', present: false }
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'unreadable', present: false }
  }
  const ours = `${target}:443`
  // for the removal hint only: any key or string naming host:443, or naming the port as text
  const portText = new RegExp(`(?:^|:)0*${port}(?![0-9])`)
  const scan = walk(value, (text_) => hostKey(text_).includes(ours) || portText.test(text_))
  const present = scan.found
  const no = (reason) => ({ ok: false, reason, present })

  if (walk(value, () => false).depth > MAX_DEPTH) return no('unknown_shape')
  if (!isObject(value)) return no('unknown_shape')
  if (Object.keys(value).some((key) => !SERVE_KEYS.has(key))) return no('unknown_shape')
  // A foreground session or a service carries its own handlers: not checked here, so never ok. So a
  // foreground `tailscale serve` on any port, or any Tailscale Service, switches sharing off, and the
  // reason says which (`foreground`, `services`).
  if (value.Foreground !== undefined && !(isObject(value.Foreground) && Object.keys(value.Foreground).length === 0)) return no('foreground')
  if (value.Services !== undefined && !(isObject(value.Services) && Object.keys(value.Services).length === 0)) return no('services')
  const tcp = value.TCP === undefined ? {} : value.TCP
  const web = value.Web === undefined ? {} : value.Web
  const funnel = value.AllowFunnel === undefined ? {} : value.AllowFunnel
  if (!isObject(tcp) || !isObject(web) || !isObject(funnel)) return no('unknown_shape')

  // a TCP forward to the port, on any port, with or without TLS: client-sent headers would reach the gate
  for (const entry of Object.values(tcp)) {
    if (!isObject(entry) || Object.keys(entry).some((key) => !TCP_KEYS.has(key))) return no('unknown_shape')
    if (entry.TCPForward !== undefined) {
      const forwarded = forwardPort(entry.TCPForward)
      if (forwarded === null) return no('unknown_shape')
      if (forwarded === port) return no('tcp_forward')
    }
  }
  for (const [key, on] of Object.entries(funnel)) {
    if (hostKey(key) === ours && on !== false) return no('funnel')
  }
  const mine = []
  for (const [key, entry] of Object.entries(web)) {
    if (!isObject(entry)) return no('unknown_shape')
    if (hostKey(key) === ours) {
      mine.push(entry)
      continue
    }
    // another origin's handler that proxies to the port: its requests would carry that origin
    if (Object.keys(entry).some((name) => name !== 'Handlers') || !isObject(entry.Handlers)) return no('unknown_shape')
    for (const handler of Object.values(entry.Handlers)) {
      if (!isObject(handler) || Object.keys(handler).some((name) => !HANDLER_KEYS.has(name))) return no('unknown_shape')
      if (handler.Proxy === undefined) continue
      const proxied = proxyPort(handler.Proxy)
      if (proxied === null) return no('unknown_shape')
      if (proxied === port) return no('other_proxy')
    }
  }
  if (mine.length > 1) return no('duplicate_host')
  if (mine.length === 0) return no('no_handler')
  const entry = mine[0]
  if (Object.keys(entry).some((key) => key !== 'Handlers') || !isObject(entry.Handlers)) return no('unknown_shape')
  const paths = Object.keys(entry.Handlers)
  if (paths.length === 0) return no('no_handler')
  // another path shares the Inbox's origin and would pass the gate's Origin check
  if (paths.length !== 1 || paths[0] !== '/') return no('other_path')
  const handler = entry.Handlers['/']
  if (!isObject(handler) || Object.keys(handler).length !== 1 || !Object.hasOwn(handler, 'Proxy')) return no('handler_fields')
  if (handler.Proxy !== `http://127.0.0.1:${port}`) return no('wrong_target')
  const https = tcp['443']
  if (!isObject(https) || Object.keys(https).length !== 1 || https.HTTPS !== true) return no('not_https')
  return { ok: true }
}

module.exports = {
  REMOVAL_HINT,
  TAILSCALE_ARGS,
  TAILSCALE_PATHS,
  isObject,
  parseServeStatus,
  parseTailnetSelf,
  plainText,
  runTailscale,
  tailscaleCli,
  validHost,
}
