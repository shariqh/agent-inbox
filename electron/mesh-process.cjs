'use strict'
// Agent setup in the app, step 2a: the bridge from the page to the person's own `meshctl`.
//
// The page names an operation from a fixed list and its values; it never sends a command, a
// path or a secret. Main checks every value, builds the one argv that operation maps to, and
// runs the program the person's own shim names (`<mesh dir>/bin/meshctl`, written by
// scripts/install-agents.sh), the same program their terminal runs:
//
//   [<node the shim names>, <meshctl.js the shim names>, ...the operation's argv]
//
// The shim's shell text is never executed: it is read (a regular file of this user's, no group
// or other write bit, at most 4 KiB), its marker and its node='…' and meshctl='…' lines must
// have the installer's exact shapes, and both paths must be regular files. No shell, cwd the
// person's home, a minimal environment, stdin closed, a 30 second limit, stdout capped at
// 256 KiB and stderr drained and never kept. meshctl's JSON is rebuilt field by field into a fixed answer;
// anything else is a fixed failure word. Files (a key, a token) are chosen in main's own
// picker and named to the page only by a random handle and their base name. Nothing here logs.
const fs = require('node:fs')
const path = require('node:path')
const { randomBytes } = require('node:crypto')

const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux'])
const SHIM_MAX = 4096
const PATH_MAX = 1024
const TIMEOUT_MS = 30_000
// as Setup (setup-process.cjs): SIGTERM to the group, then SIGKILL this long after
const FORCE_KILL_MS = 10_000
const STDOUT_MAX = 256 * 1024
const HANDLE_MAX = 16
const HANDLE_TTL_MS = 15 * 60 * 1000
const FILE_NAME_MAX = 80
const URL_MAX = 2048
// the caps on what reaches the page
const LINE_MAX = 4096
const STEPS_MAX = 32
const NOTES_MAX = 32
const SERVERS_MAX = 32
const AGENTS_MAX = 8
const WORD_MAX = 40
const BASE_URL_MAX = 2048
const MODELS_MAX = 50
const MODEL_MAX = 64
// an added agent's card summary: card text cut in UTF-16 units (the command caps it at 80, 300
// and 200 characters plus `…`, so these leave room for characters outside the BMP), 16 skills
const CARD_WORD_MAX = 162
const CARD_TEXT_MAX = 602
const SKILL_TEXT_MAX = 402
const SKILLS_MAX = 16

const MARKER = /^# agent-inbox meshctl shim \(#540\), kind=(runtime|checkout), written by install-agents\.sh\. Do not edit\.$/
// a single-quoted absolute path with no quote, backslash, `$`, backtick or control character
const SHIM_PATH = (name) => new RegExp(`^${name}='(/[^'"\\\\$\`\\x00-\\x1f\\x7f]*)'$`)
const SHIM_NODE = SHIM_PATH('node')
const SHIM_SCRIPT = SHIM_PATH('meshctl')

const SERVER_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/
const MODEL_NAME = /^[A-Za-z0-9._:/-]{1,64}$/
const HANDLE = /^[0-9a-f]{32}$/
const CONTROL = /[\x00-\x1f\x7f-\x9f]/
// card text: a control character, or a format character (Unicode Cf, such as U+202E or U+200B)
const CARD_UNSAFE = /[\x00-\x1f\x7f-\x9f\p{Cf}]/u
const MODEL_AGENTS = new Set(['unslop', 'unslop-code'])
const DISABLE_AGENTS = new Set(['unslop', 'unslop-code', 'request-post'])
const KEY_KINDS = new Set(['file', 'command', 'env', 'none'])
// a server at an address, or Claude Code on this Mac (no address, no key)
const SERVER_KINDS = new Set(['http', 'claude-code'])
// a check's failure: the address kind's five, and Claude Code's program not found or not signed in
const CHECK_FAILURES = new Set(['unreachable', 'unauthorized', 'not-a-model-server', 'timeout', 'key', 'no-program', 'signed-out'])
const PURPOSES = new Set(['key', 'token'])
// where an added agent runs, as add's card summary says it
const REACHES = new Set(['loopback', 'tailnet', 'public'])

// add's own rules (src/mesh-entry.ts addedPlace and idRefusal), copied: this file loads only
// Node's own modules. An address is http://127.0.0.1:<port> or https:// on a DNS name of at most
// 253 characters, as written (lower case, no written-out default port), with an optional plain path.
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const PLAIN_PATH = '(?:/(?!\\.\\.?(?:/|$))[A-Za-z0-9._~-]+)*/?'
const LOOPBACK_PLACE = new RegExp(`^http://127\\.0\\.0\\.1:([1-9]\\d{0,4})${PLAIN_PATH}$`)
const NAMED_PLACE = new RegExp(`^https://((?:${LABEL}\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?)(?::([1-9]\\d{0,4}))?${PLAIN_PATH}$`)
const AGENT_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
const BUILT_IN_AGENTS = new Set(['unslop', 'unslop-code', 'request-post', 'web-search'])
const PIN = /^[0-9a-f]{64}$/
const LOOPBACK_PREFIX = 'http://127.0.0.1:'

/**
 * Every word a refusal or failure carries, and nothing else.
 * - the window: unavailable (no grant: another page, another Mac's Inbox, a reused viewer)
 * - the request: invalid (a value broke its rule), handle (an unknown or expired file handle)
 * - the gates: busy (a run or a picker is in flight), setup (Setup runs), updating (an update
 *   installs), quitting
 * - the program: unsupported (this platform), environment (a relative AGENT_INBOX_DB),
 *   not-installed (no shim), unsafe (a symlink, not a regular file, not this user's, writable by
 *   others or too large), unrecognized (not the installer's shape), stale (a path it names is not
 *   a regular file)
 * - the run: outdated (it does not know the command: exit 2 and no JSON), output (no JSON, or
 *   too much), timeout, failed (it could not be started)
 * - the picker: cancelled
 */
const REASONS = new Set([
  'unavailable', 'invalid', 'handle', 'busy', 'setup', 'updating', 'quitting',
  'unsupported', 'environment', 'not-installed', 'unsafe', 'unrecognized', 'stale',
  'outdated', 'output', 'timeout', 'failed', 'cancelled',
])

const failure = (reason) => ({ ok: false, reason })
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** A string cut to `max` UTF-16 units, never ending on half a surrogate pair. */
function cut(text, max) {
  return text.length <= max ? text : text.slice(0, max).replace(/[\ud800-\udbff]$/, '')
}

/**
 * The mesh dir by meshctl's own rule (src/mesh-config.ts meshDir): an absolute
 * AGENT_INBOX_MESH_DIR, else the folder of AGENT_INBOX_DB, else <home>/.agent-inbox. A relative
 * AGENT_INBOX_DB is refused: main and the child would resolve it against different folders.
 */
function meshDirOf(env, home) {
  const configured = env.AGENT_INBOX_MESH_DIR
  if (configured && path.isAbsolute(configured)) return { dir: configured }
  const db = env.AGENT_INBOX_DB
  if (db) return path.isAbsolute(db) ? { dir: path.dirname(db) } : { reason: 'environment' }
  if (typeof home !== 'string' || !path.isAbsolute(home)) return { reason: 'environment' }
  return { dir: path.join(home, '.agent-inbox') }
}

/**
 * The environment meshctl runs with: system folders, who and where, and the mesh dir's variables.
 * TAILSCALE_BE_CLI makes the Tailscale app's own binary answer as a command line when it is run
 * from an app Finder opened (electron/remote-tailscale.cjs sets the same): meshctl falls back on
 * that binary to read this Mac's tailnet, and Homebrew's `tailscale` is not on this PATH.
 */
function meshEnv(env) {
  const out = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TAILSCALE_BE_CLI: '1' }
  for (const name of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG']) if (env[name]) out[name] = env[name]
  if (env.AGENT_INBOX_MESH_DIR && path.isAbsolute(env.AGENT_INBOX_MESH_DIR)) out.AGENT_INBOX_MESH_DIR = env.AGENT_INBOX_MESH_DIR
  if (env.AGENT_INBOX_DB && path.isAbsolute(env.AGENT_INBOX_DB)) out.AGENT_INBOX_DB = env.AGENT_INBOX_DB
  return out
}

const unsafeStat = (stat, uid) => !stat.isFile() || stat.uid !== uid || (stat.mode & 0o022) !== 0 || stat.size > SHIM_MAX

/**
 * Reads `<dir>/bin/meshctl` without following a link and returns the node and the script it
 * names, `{ ok: true, node, script }`, or `{ ok: false, reason }`. Never throws.
 */
function readShim({ dir, uid, fsImpl = fs }) {
  const shim = path.join(dir, 'bin', 'meshctl')
  let stat
  try {
    stat = fsImpl.lstatSync(shim)
  } catch (err) {
    return failure(err && err.code === 'ENOENT' ? 'not-installed' : 'unsafe')
  }
  if (stat.isSymbolicLink() || unsafeStat(stat, uid)) return failure('unsafe')
  let text
  let fd = null
  try {
    fd = fsImpl.openSync(shim, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    // the file that was opened, checked again: the path may have changed since the lstat
    if (unsafeStat(fsImpl.fstatSync(fd), uid)) return failure('unsafe')
    const buffer = Buffer.alloc(SHIM_MAX + 1)
    let length = 0
    for (let read = -1; read !== 0 && length < buffer.length;) {
      read = fsImpl.readSync(fd, buffer, length, buffer.length - length, null)
      length += read
    }
    if (length > SHIM_MAX) return failure('unsafe')
    text = buffer.subarray(0, length).toString('utf8')
  } catch {
    return failure('unsafe')
  } finally {
    if (fd !== null) try { fsImpl.closeSync(fd) } catch { /* closed */ }
  }
  const lines = text.split('\n')
  if (text.includes('\r') || lines[0] !== '#!/bin/sh' || !MARKER.test(lines[1] ?? '')) return failure('unrecognized')
  const node = SHIM_NODE.exec(lines[2] ?? '')?.[1]
  const script = SHIM_SCRIPT.exec(lines[3] ?? '')?.[1]
  if (!node || !script || node.length > PATH_MAX || script.length > PATH_MAX) return failure('unrecognized')
  for (const file of [node, script]) {
    try {
      if (!fsImpl.statSync(file).isFile()) return failure('stale')
    } catch {
      return failure('stale')
    }
  }
  return { ok: true, node, script }
}

/** A URL meshctl may be given: http(s), no credentials, at most 2048 characters, no control character or space. */
function isUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > URL_MAX || value.startsWith('-')) return false
  if (CONTROL.test(value) || /\s/.test(value)) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

/**
 * An added agent's card address (or its endpoint), by add's own rule: a loopback port is 1-65535
 * and never 80, a name's port never 443, the address parses as a URL (a malformed punycode label
 * does not) and its parsed host is at most 253 characters; plus this bridge's own cap of 2048.
 */
function isPlace(value) {
  if (typeof value !== 'string' || value.length > URL_MAX) return false
  const loopback = LOOPBACK_PLACE.exec(value)
  const named = loopback ? null : NAMED_PLACE.exec(value)
  if (!loopback && !named) return false
  const port = loopback ? loopback[1] : named[2]
  if (port !== undefined && (Number(port) > 65535 || Number(port) === (loopback ? 80 : 443))) return false
  let host
  try {
    host = new URL(value).hostname
  } catch {
    return false
  }
  return host.length <= 253
}

const isAgentId = (value) => typeof value === 'string' && AGENT_ID.test(value) && !BUILT_IN_AGENTS.has(value)
const isServer = (value) => typeof value === 'string' && SERVER_NAME.test(value)
const isModel = (value) => typeof value === 'string' && MODEL_NAME.test(value) && !value.startsWith('-')
const isKey = (value) => value === 'none' || (typeof value === 'string' && HANDLE.test(value))

/**
 * The fixed operations: the keys each takes (`required`, then `optional`), each key's rule, the
 * answer's kind, and its argv. `apply` is a writing operation's required boolean.
 */
const OPERATIONS = Object.freeze({
  servers: { kind: 'servers', required: [], argv: () => ['server', 'list', '--json'] },
  'check-server': { kind: 'check', required: ['name'], argv: (v) => ['server', 'check', v.name, '--json'] },
  'add-server': {
    kind: 'plan', required: ['name', 'baseUrl', 'key', 'apply'],
    argv: (v, file) => ['server', 'add', v.name, '--base-url', v.baseUrl, ...keyArgs(v.key, file), '--json'],
  },
  // Claude Code on this Mac: a name only; the command finds the program and its sign-in itself
  'add-claude-server': { kind: 'plan', required: ['name', 'apply'], argv: (v) => ['server', 'add', v.name, '--claude-code', '--json'] },
  'adopt-server': { kind: 'plan', required: ['name', 'from', 'apply'], argv: (v) => ['server', 'add', v.name, '--from', v.from, '--move', '--json'] },
  'set-server': {
    kind: 'plan', required: ['name', 'apply'], optional: ['baseUrl', 'key'],
    argv: (v, file) => [
      'server', 'set', v.name, ...(v.baseUrl === undefined ? [] : ['--base-url', v.baseUrl]), ...(v.key === undefined ? [] : keyArgs(v.key, file)), '--json',
    ],
  },
  'remove-server': { kind: 'plan', required: ['name', 'apply'], argv: (v) => ['server', 'remove', v.name, '--json'] },
  'enable-model-agent': {
    kind: 'plan', required: ['agent', 'server', 'model', 'apply'],
    argv: (v) => ['enable', `--${v.agent}`, '--server', v.server, '--model', v.model, '--json'],
  },
  'enable-request-post': {
    kind: 'plan', required: ['endpoint', 'token', 'apply'],
    argv: (v, file) => ['enable', '--request-post', '--endpoint', v.endpoint, '--token-file', file(v.token, 'token'), '--json'],
  },
  // never --purge
  disable: { kind: 'plan', required: ['agent', 'apply'], argv: (v) => ['disable', `--${v.agent}`, '--json'] },
  // an agent by its card address: the check is add's dry run with no --id (it fetches the card once
  // and writes nothing, so it takes no apply); the add names the checked id and pin, never --move
  'check-agent': {
    kind: 'add', required: ['address'], optional: ['token'],
    argv: (v, file) => ['add', v.address, ...tokenArgs(v.token, file), '--json'],
  },
  'add-agent': {
    kind: 'add', required: ['address', 'id', 'pin', 'apply'], optional: ['token'],
    argv: (v, file) => ['add', v.address, '--id', v.id, ...tokenArgs(v.token, file), '--expect-pin', v.pin, '--json'],
  },
  'remove-agent': { kind: 'plan', required: ['id', 'apply'], argv: (v) => ['remove', v.id, '--json'] },
})

function keyArgs(key, file) {
  return key === 'none' ? ['--no-key'] : ['--key-file', file(key, 'key')]
}

function tokenArgs(token, file) {
  return token === undefined ? [] : ['--token-file', file(token, 'token')]
}

const RULES = {
  name: isServer,
  server: isServer,
  model: isModel,
  baseUrl: isUrl,
  endpoint: isUrl,
  key: isKey,
  token: (value) => typeof value === 'string' && HANDLE.test(value),
  from: (value) => MODEL_AGENTS.has(value),
  apply: (value) => typeof value === 'boolean',
  address: isPlace,
  id: isAgentId,
  pin: (value) => typeof value === 'string' && PIN.test(value),
}
const AGENT_RULES = { 'enable-model-agent': MODEL_AGENTS, disable: DISABLE_AGENTS }

/**
 * The checked values of one operation, a fresh object, or null: exactly the operation's keys,
 * each by its rule; a string value that starts with `-` is refused everywhere.
 */
function checkedValues(operation, values) {
  if (typeof operation !== 'string' || !Object.hasOwn(OPERATIONS, operation) || !isPlainObject(values)) return null
  const spec = OPERATIONS[operation]
  const allowed = [...spec.required, ...(spec.optional ?? [])]
  const keys = Object.keys(values)
  if (keys.some((key) => !allowed.includes(key)) || spec.required.some((key) => !Object.hasOwn(values, key))) return null
  const out = {}
  for (const key of keys) {
    const value = Object.getOwnPropertyDescriptor(values, key)?.value
    if (typeof value === 'string' && value.startsWith('-')) return null
    const rule = key === 'agent' ? (v) => AGENT_RULES[operation]?.has(v) === true : RULES[key]
    if (!rule || !rule(value)) return null
    out[key] = value
  }
  // set-server changes the address, the key source, or both
  if (operation === 'set-server' && out.baseUrl === undefined && out.key === undefined) return null
  // a token file goes only to an agent on this Mac: a remote agent that needs one is added in a terminal
  if (out.address !== undefined && out.token !== undefined && !out.address.startsWith(LOOPBACK_PREFIX)) return null
  return out
}

/**
 * The argv for an operation, `{ argv, kind }`, or `{ reason }`: invalid values, or a file handle
 * `pathOf(handle, purpose)` does not know (it answers the path, or null).
 */
function meshArgv(operation, values, pathOf) {
  const checked = checkedValues(operation, values)
  if (!checked) return { reason: 'invalid' }
  let unknown = false
  const file = (handle, purpose) => {
    const found = pathOf(handle, purpose)
    if (typeof found !== 'string') unknown = true
    return found ?? ''
  }
  const spec = OPERATIONS[operation]
  const argv = spec.argv(checked, file)
  if (unknown) return { reason: 'handle' }
  if (checked.apply === true) argv.push('--apply')
  return { argv, kind: spec.kind }
}

// ── answers ──────────────────────────────────────────────────────────────────

const isStrings = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string')
const lines = (value, count) => value.slice(0, count).map((line) => cut(line, LINE_MAX))

function planAnswer(parsed, code) {
  if (!isPlainObject(parsed) || typeof parsed.applied !== 'boolean' || !isStrings(parsed.steps)) return failure('output')
  if ((parsed.refused !== undefined && typeof parsed.refused !== 'string') || (parsed.notes !== undefined && !isStrings(parsed.notes))) return failure('output')
  const out = { ok: code === 0 && parsed.refused === undefined, applied: parsed.applied, steps: lines(parsed.steps, STEPS_MAX) }
  if (parsed.refused !== undefined) out.refused = cut(parsed.refused, LINE_MAX)
  if (parsed.notes !== undefined) out.notes = lines(parsed.notes, NOTES_MAX)
  return out
}

// A row's kind: a command older than the Claude Code kind prints none, and every row it knows is an address server
function serverRow(row) {
  if (!isPlainObject(row) || typeof row.name !== 'string' || typeof row.baseUrl !== 'string' || !KEY_KINDS.has(row.key) || !isStrings(row.agents)) return null
  if (row.kind !== undefined && !SERVER_KINDS.has(row.kind)) return null
  return {
    name: cut(row.name, WORD_MAX),
    kind: row.kind ?? 'http',
    baseUrl: cut(row.baseUrl, BASE_URL_MAX),
    key: row.key,
    agents: row.agents.slice(0, AGENTS_MAX).map((agent) => cut(agent, WORD_MAX)),
  }
}

function serversAnswer(parsed, code) {
  if (!isPlainObject(parsed) || !Array.isArray(parsed.servers) || !isStrings(parsed.inline)) return failure('output')
  if (parsed.refused !== undefined && typeof parsed.refused !== 'string') return failure('output')
  const servers = parsed.servers.slice(0, SERVERS_MAX).map(serverRow)
  if (servers.includes(null)) return failure('output')
  const out = { ok: code === 0 && parsed.refused === undefined, servers, inline: parsed.inline.slice(0, AGENTS_MAX).map((agent) => cut(agent, WORD_MAX)) }
  if (parsed.refused !== undefined) out.refused = cut(parsed.refused, LINE_MAX)
  return out
}

function checkAnswer(parsed, code) {
  if (!isPlainObject(parsed)) return failure('output')
  // `{ server, refused }`: the server could not be checked
  if (parsed.refused !== undefined) {
    if (typeof parsed.refused !== 'string') return failure('output')
    return { ok: false, reachable: false, models: [], skipped: 0, refused: cut(parsed.refused, LINE_MAX) }
  }
  if (typeof parsed.reachable !== 'boolean' || !isStrings(parsed.models)) return failure('output')
  if (parsed.failure !== undefined && !CHECK_FAILURES.has(parsed.failure)) return failure('output')
  if (parsed.kind !== undefined && !SERVER_KINDS.has(parsed.kind)) return failure('output')
  const skipped = Number.isSafeInteger(parsed.skipped) && parsed.skipped >= 0 ? parsed.skipped : 0
  const out = { ok: code === 0 && parsed.reachable, reachable: parsed.reachable, models: parsed.models.slice(0, MODELS_MAX).map((id) => cut(id, MODEL_MAX)), skipped }
  if (parsed.failure !== undefined) out.failure = parsed.failure
  // an older command names no kind: the page goes by its own server list then
  if (parsed.kind !== undefined) out.kind = parsed.kind
  return out
}

// Card text: a string with no control or format character, cut; null when it is not one. The
// command has already cleaned it, so such a character means the output is not what it prints.
const cardText = (value, max) => (typeof value === 'string' && !CARD_UNSAFE.test(value) ? cut(value, max) : null)

function cardSkill(raw) {
  if (!isPlainObject(raw)) return null
  const id = cardText(raw.id, CARD_WORD_MAX)
  if (id === null) return null
  const out = { id }
  for (const [key, max] of [['name', CARD_WORD_MAX], ['description', SKILL_TEXT_MAX]]) {
    if (raw[key] === undefined) continue
    const text = cardText(raw[key], max)
    if (text === null) return null
    out[key] = text
  }
  return out
}

/** add's card summary rebuilt field by field, or null when any field breaks its rule. */
function addCard(raw) {
  if (!isPlainObject(raw)) return null
  const out = {}
  if (raw.id !== undefined) {
    if (!isAgentId(raw.id)) return null
    out.id = raw.id
  }
  for (const [key, max] of [['name', CARD_WORD_MAX], ['description', CARD_TEXT_MAX], ['version', CARD_WORD_MAX], ['publisher', CARD_WORD_MAX]]) {
    if (raw[key] === undefined) continue
    const text = cardText(raw[key], max)
    if (text === null) return null
    out[key] = text
  }
  // the endpoint passed the address rule, and only an endpoint on this Mac is a loopback one
  if (!REACHES.has(raw.reach) || !isPlace(raw.endpoint) || (raw.reach === 'loopback') !== raw.endpoint.startsWith(LOOPBACK_PREFIX)) return null
  if (typeof raw.signed !== 'boolean' || (raw.keysNew !== undefined && typeof raw.keysNew !== 'boolean')) return null
  if (!Array.isArray(raw.skills) || typeof raw.pin !== 'string' || !PIN.test(raw.pin)) return null
  const skills = raw.skills.slice(0, SKILLS_MAX).map(cardSkill)
  if (skills.includes(null)) return null
  out.reach = raw.reach
  out.endpoint = raw.endpoint
  out.signed = raw.signed
  if (raw.keysNew !== undefined) out.keysNew = raw.keysNew
  out.skills = skills
  out.pin = raw.pin
  return out
}

/**
 * An add's plan and its card. A card that breaks a rule fails the answer, refused or not; a plan
 * with no refusal carries a card with an id (the one it adds), and a refusal may come without one.
 */
function addAnswer(parsed, code) {
  const plan = planAnswer(parsed, code)
  if (plan.reason !== undefined) return plan
  if (parsed.card === undefined) return plan.refused === undefined ? failure('output') : plan
  const card = addCard(parsed.card)
  if (!card || (plan.refused === undefined && card.id === undefined)) return failure('output')
  return { ...plan, card }
}

const ANSWERS = { plan: planAnswer, servers: serversAnswer, check: checkAnswer, add: addAnswer }

/** The answer for meshctl's stdout and exit code: its one JSON object rebuilt for `kind`, or a failure word. */
function meshAnswer(kind, stdout, code) {
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return failure(code === 2 ? 'outdated' : 'output')
  }
  return ANSWERS[kind](parsed, code)
}

// ── the run ──────────────────────────────────────────────────────────────────

/**
 * Runs `node script ...argv` once and resolves `{ code, stdout }` or `{ reason }` (`failed`,
 * `output`, `timeout`, `quitting`). Never rejects. `onCancel(cancel)` hands over the stop a quit
 * calls.
 */
function runMeshctl({
  node, script, argv, cwd, env, spawnImpl, killImpl = process.kill.bind(process), timeoutMs = TIMEOUT_MS, forceKillMs = FORCE_KILL_MS,
  onCancel = () => {},
}) {
  let child
  try {
    child = spawnImpl(node, [script, ...argv], {
      cwd, env, shell: false, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    return Promise.resolve({ reason: 'failed' })
  }
  return new Promise((resolve) => {
    let done = false
    let stopping = null
    let stdout = ''
    let stdoutBytes = 0
    let timer = null
    let forceTimer = null
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearTimeout(forceTimer)
      resolve(result)
    }
    const signal = (name) => {
      try {
        killImpl(-child.pid, name)
      } catch {
        try { child.kill(name) } catch { /* gone */ }
      }
    }
    const stop = (reason) => {
      if (done || stopping) return
      stopping = reason
      signal('SIGTERM')
      forceTimer = setTimeout(() => {
        signal('SIGKILL')
        finish({ reason })
      }, forceKillMs)
    }
    child.on('error', () => finish({ reason: stopping ?? 'failed' }))
    child.stdout.on('error', () => {})
    child.stderr.on('error', () => {})
    child.stdout.on('data', (chunk) => {
      if (stopping) return
      stdoutBytes += chunk.length
      if (stdoutBytes > STDOUT_MAX) {
        stop('output')
        return
      }
      stdout += chunk.toString('utf8')
    })
    // drained and dropped: nothing from stderr is kept, so none of it reaches the page or a log
    child.stderr.resume()
    child.on('close', (code) => finish(stopping ? { reason: stopping } : { code, stdout }))
    onCancel(() => stop('quitting'))
    timer = setTimeout(() => stop('timeout'), timeoutMs)
  })
}

// ── chosen files ─────────────────────────────────────────────────────────────

/**
 * The files the person chose in main's picker, by random handle: at most 16 (a 17th forgets the
 * oldest), each for 15 minutes, all forgotten by `clear()`.
 */
function createFileHandles({ now = Date.now, randomHex = () => randomBytes(16).toString('hex') } = {}) {
  const handles = new Map()
  const sweep = () => {
    const at = now()
    for (const [handle, entry] of handles) if (at - entry.at >= HANDLE_TTL_MS) handles.delete(handle)
  }
  return Object.freeze({
    add(file, purpose) {
      sweep()
      while (handles.size >= HANDLE_MAX) handles.delete(handles.keys().next().value)
      let handle = randomHex()
      while (handles.has(handle)) handle = randomHex()
      handles.set(handle, { file, purpose, at: now() })
      return handle
    },
    /** The path for a live handle chosen for `purpose`, else null. */
    lookup(handle, purpose) {
      sweep()
      const entry = typeof handle === 'string' ? handles.get(handle) : undefined
      return entry && entry.purpose === purpose ? entry.file : null
    },
    clear() {
      handles.clear()
    },
    size() {
      sweep()
      return handles.size
    },
  })
}

/** A chosen file's path: absolute, at most 1024 characters, no control character. */
const isChosenPath = (file) => typeof file === 'string' && path.isAbsolute(file) && file.length <= PATH_MAX && !CONTROL.test(file)

// ── the bridge ───────────────────────────────────────────────────────────────

/**
 * What the three channels do once main's sender check and grant have passed. `gate` is a
 * createInstallGate() of its own (one run at a time, stopped by `beginQuit()`); `isQuitting`,
 * `isSetupRunning` and `isUpdateInstalling` are the app's other gates; `choose(purpose)` is
 * main's picker, resolving an absolute path or null.
 */
function createMeshBridge({
  platform = process.platform, env = () => process.env, home, uid = () => process.getuid?.(), fsImpl = fs, spawnImpl, killImpl,
  timeoutMs, forceKillMs, gate, choose, isQuitting, isSetupRunning, isUpdateInstalling, now = Date.now, randomHex,
}) {
  const handles = createFileHandles({ now, ...(randomHex ? { randomHex } : {}) })
  // every revoke starts a new generation: a picker that was open across it chose nothing
  let generation = 0
  let picking = false
  const quitting = () => isQuitting() || gate.quitting()

  function program() {
    if (!SUPPORTED_PLATFORMS.has(platform)) return failure('unsupported')
    const dir = home()
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return failure('environment')
    const where = meshDirOf(env(), dir)
    if (!where.dir) return failure(where.reason)
    const id = uid()
    if (!Number.isInteger(id)) return failure('unsupported')
    return readShim({ dir: where.dir, uid: id, fsImpl })
  }

  return Object.freeze({
    available() {
      if (quitting()) return { available: false, reason: 'quitting' }
      if (isUpdateInstalling()) return { available: false, reason: 'updating' }
      const shim = program()
      return shim.ok ? { available: true } : { available: false, reason: shim.reason }
    },

    // Nothing awaits between the checks and gate.run(), so no other run starts in the gap.
    async run(operation, values) {
      if (quitting()) return failure('quitting')
      const built = meshArgv(operation, values, (handle, purpose) => handles.lookup(handle, purpose))
      if (built.reason) return failure(built.reason)
      if (isSetupRunning()) return failure('setup')
      if (isUpdateInstalling()) return failure('updating')
      if (gate.running()) return failure('busy')
      const shim = program()
      if (!shim.ok) return failure(shim.reason)
      const started = gate.run((onCancel) => runMeshctl({
        node: shim.node, script: shim.script, argv: built.argv, cwd: home(), env: meshEnv(env()), spawnImpl, killImpl, timeoutMs, forceKillMs, onCancel,
      }))
      if (started.refused) return failure(started.refused === 'quitting' ? 'quitting' : 'busy')
      const ran = await started.promise
      return ran.reason ? failure(ran.reason) : meshAnswer(built.kind, ran.stdout, ran.code)
    },

    async chooseFile(purpose) {
      if (!PURPOSES.has(purpose)) return failure('invalid')
      if (quitting()) return failure('quitting')
      if (picking) return failure('busy')
      picking = true
      const asked = generation
      let file
      try {
        file = await choose(purpose)
      } catch {
        return failure('failed')
      } finally {
        picking = false
      }
      // the window lost its grant, or a quit began, while the picker was open
      if (asked !== generation || quitting()) return failure('unavailable')
      if (file === null || file === undefined) return failure('cancelled')
      if (!isChosenPath(file)) return failure('invalid')
      return { ok: true, handle: handles.add(file, purpose), name: cut(path.basename(file), FILE_NAME_MAX) }
    },

    /** The window lost its grant (a navigation, a reload, a crash, closing): every chosen file is forgotten. */
    revoke() {
      generation += 1
      handles.clear()
    },

    /** A quit began: nothing starts again, the run in flight is stopped; settles once nothing runs. */
    beginQuit() {
      generation += 1
      handles.clear()
      return gate.beginQuit()
    },
  })
}

// ── the channels ─────────────────────────────────────────────────────────────

/**
 * The three channels, each with an exact number of arguments, waiting for a re-proof of the
 * window in flight, and answering only a sender `isGranted(event)` accepts (main: the owned
 * viewer window's own top frame on the viewer origin, while it holds the grant). Anything else,
 * the view showing another Mac's Inbox included, gets the same `unavailable` and calls nothing.
 */
function registerMeshIpc({ ipcMain, bridge, settled, isGranted }) {
  ipcMain.handle('agent-inbox:mesh-available', async (event, ...args) => {
    if (args.length !== 0) return { available: false, reason: 'invalid' }
    await settled()
    if (!isGranted(event)) return { available: false, reason: 'unavailable' }
    return bridge.available()
  })
  ipcMain.handle('agent-inbox:mesh-run', async (event, ...args) => {
    if (args.length !== 2) return failure('invalid')
    await settled()
    if (!isGranted(event)) return failure('unavailable')
    return bridge.run(args[0], args[1])
  })
  ipcMain.handle('agent-inbox:mesh-choose-file', async (event, ...args) => {
    if (args.length !== 1) return failure('invalid')
    await settled()
    if (!isGranted(event)) return failure('unavailable')
    return bridge.chooseFile(args[0])
  })
}

module.exports = {
  CHECK_FAILURES, KEY_KINDS, OPERATIONS, REACHES, REASONS, SERVER_KINDS, createFileHandles, createMeshBridge, meshAnswer, meshArgv, meshDirOf, meshEnv, readShim, registerMeshIpc, runMeshctl,
}
