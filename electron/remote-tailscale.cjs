'use strict'
// Tailscale, read-only, for the hub's remote-entry controller (#617, PR 2c; electron/remote-entry.cjs
// is the controller and the only module that requires this one). Split from it for size only.
//
// Design: docs/superpowers/specs/2026-11-17-remote-inbox-design.md §3.2 "Serve's shape, checked by
// main"; architecture notes in docs/architecture/remote-inbox.md. This file finds the command line
// at three fixed paths and runs it with exactly two argument lists, argv only, never a shell. It
// never changes Tailscale's configuration, and it logs nothing.
const { existsSync } = require('node:fs')
const childProcess = require('node:child_process')

const OUTPUT_MAX = 1024 * 1024
const RUN_TIMEOUT_MS = 5_000

// Shown to the person to remove a background Serve configuration, never run. The `off` form is
// from Tailscale's documentation; it has not yet been seen in real output.
const REMOVAL_HINT = 'tailscale serve --https=443 off'

const TAILSCALE_PATHS = Object.freeze([
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
])
// The only two argument lists this module ever runs. runTailscale takes a key, never a list.
const TAILSCALE_ARGS = Object.freeze({
  self: Object.freeze(['status', '--json']),
  serve: Object.freeze(['serve', 'status', '--json']),
})
const RUN_OPTIONS = Object.freeze({ timeout: RUN_TIMEOUT_MS, maxBuffer: OUTPUT_MAX, encoding: 'utf8', shell: false, windowsHide: true })

// The viewer's reader rules for a host and a login (src/viewer-remote.ts), shared with the controller.
const HOST_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const chars = (text) => Array.from(text).length
const plainText = (value, max) => typeof value === 'string' && chars(value) >= 1 && chars(value) <= max && !CONTROL.test(value)
const validHost = (host) => typeof host === 'string' && host.length <= 253 && HOST_PATTERN.test(host)
  && /[a-z]/.test(host.slice(host.lastIndexOf('.') + 1))


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

/** One read: `self` or `serve`, argv only, no shell, 5 seconds, 1 MiB. Resolves `{ ok, text }` or `{ ok: false, reason }`. */
function runTailscale(which, deps) {
  const args = TAILSCALE_ARGS[which]
  if (!args) return Promise.resolve({ ok: false, reason: 'failed' })
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
      execFile(cli, [...args], { ...RUN_OPTIONS }, (error, stdout) => {
        if (error) return finish({ ok: false, reason: 'failed' })
        const text = typeof stdout === 'string' ? stdout : Buffer.isBuffer(stdout) ? stdout.toString('utf8') : null
        if (text === null || Buffer.byteLength(text) > OUTPUT_MAX) return finish({ ok: false, reason: 'failed' })
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
 * an ID past 2^53 keeps its digits. A tagged node is decided from Self.Tags alone: its UserID
 * still resolves to a placeholder user, whose login is never returned.
 */
function parseTailnetSelf(text) {
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
  if (!plainText(login, 254)) return { ok: false, reason: 'no_login' }
  return { ok: true, host, login }
}

const SERVE_KEYS = new Set(['TCP', 'Web', 'AllowFunnel', 'Foreground', 'Services'])

/** A Web or AllowFunnel key as host:port, lowercased, a trailing dot on the host dropped. */
const hostKey = (key) => key.toLowerCase().replace(/\.:(\d+)$/, ':$1')

/** Whether any string inside `value` names `port` (`127.0.0.1:4320`, `localhost:4320`, `http://…:4320/x`, `4320`). */
function namesPort(value, port) {
  const pattern = new RegExp(`(?:^|:)${port}(?![0-9])`)
  const walk = (node) => {
    if (typeof node === 'string') return pattern.test(node)
    if (Array.isArray(node)) return node.some(walk)
    if (isObject(node)) return Object.values(node).some(walk)
    return false
  }
  return walk(value)
}

/** Whether any key or string inside `value` names `host:443`: a Serve configuration the removal hint is for. */
function namesHost(value, host) {
  const wanted = `${host}:443`
  const walk = (node) => {
    if (typeof node === 'string') return hostKey(node).includes(wanted)
    if (Array.isArray(node)) return node.some(walk)
    if (isObject(node)) return Object.entries(node).some(([key, child]) => hostKey(key).includes(wanted) || walk(child))
    return false
  }
  return walk(value)
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
  const present = namesHost(value, target) || namesPort(value, port)
  const no = (reason) => ({ ok: false, reason, present })
  const ours = `${target}:443`

  if (!isObject(value)) return no('unknown_shape')
  if (Object.keys(value).some((key) => !SERVE_KEYS.has(key))) return no('unknown_shape')
  // a foreground session or a service carries its own handlers: not checked here, so never ok
  if (value.Foreground !== undefined && !(isObject(value.Foreground) && Object.keys(value.Foreground).length === 0)) return no('foreground')
  if (value.Services !== undefined && !(isObject(value.Services) && Object.keys(value.Services).length === 0)) return no('services')
  const tcp = value.TCP === undefined ? {} : value.TCP
  const web = value.Web === undefined ? {} : value.Web
  const funnel = value.AllowFunnel === undefined ? {} : value.AllowFunnel
  if (!isObject(tcp) || !isObject(web) || !isObject(funnel)) return no('unknown_shape')

  // a TCP forward to the port, on any port, with or without TLS: client-sent headers would reach the gate
  for (const entry of Object.values(tcp)) {
    if (!isObject(entry)) return no('unknown_shape')
    if (namesPort(entry, port)) return no('tcp_forward')
  }
  for (const [key, on] of Object.entries(funnel)) {
    if (hostKey(key) === ours && on !== false) return no('funnel')
  }
  const mine = []
  for (const [key, entry] of Object.entries(web)) {
    if (!isObject(entry)) return no('unknown_shape')
    if (hostKey(key) === ours) mine.push(entry)
    // another origin's handler that reaches the port: its requests would carry that origin
    else if (namesPort(entry, port)) return no('other_proxy')
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
