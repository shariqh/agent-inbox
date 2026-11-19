'use strict'
// Open desk (#617 PR 4b; design docs/superpowers/specs/2026-11-17-remote-inbox-design.md §3.4,
// architecture notes in docs/architecture/remote-inbox.md, "Open desk").
//
// On a Mac that shows another Mac's Inbox (the hub), a session's Open desk button in the hub's page
// opens this Mac's terminal attached to that session's tmux session (its desk) on the hub. It runs
// one command template the owner typed in Settings on this Mac and confirmed in a native dialog
// (remote-connect.cjs, setDeskCommand); `{desk}` and `{attach}` are its only placeholders.
//
// The page names only a session. Main decides everything else, in this order, each with its own
// reason word: the sender is the hub view's top frame on the hub's own page (`unavailable`), the
// request is exactly `{ session }` (`bad_request`), that view is focused and had a key press or
// click under 5 seconds ago, used up by this open (`no_gesture`), at most one open per 2 seconds
// and three a minute, never two at once (`busy`), the stored active hub has a valid command
// (`no_command`), main reads the hub's own GET /api/activity through the hub fetch (`unreachable`),
// finds the session (`not_found`) and its pattern-checked desk (`no_desk`), the row's machine is the
// hub's (`not_on_hub`), then fills the template, writes a private script (`failed`) and opens it in
// Settings → Terminal's app (`terminal_failed`). Only the desk, after its pattern check, goes from
// the hub into the command; nothing else the hub or its page says does. A refusal logs its reason
// word, except the first three, which come before the gesture check and so log nothing.
//
// Policy only, with every dependency injected, so test/desk-open.test.ts runs no terminal, no
// fetch and no shell but the `sh` it parses quoting with.
const { randomBytes: nodeRandomBytes } = require('node:crypto')
const path = require('node:path')
const { PLACE, discard, isDeviceLabel, readJson, validDeskCommand } = require('./remote-connect-rules.cjs')
const { shellWord, writePrivateScript } = require('./chat-resume.cjs')
const { openInTerminal, terminalId, terminalName } = require('./terminal-launch.cjs')

// a session id as cards key them: UUIDs, and other keys such as `launch:<id>`
const SESSION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
// this module's own scripts only: chat resume's names never match, so neither sweeps the other's
const DESK_SCRIPT = /^desk-[0-9a-f]{16}\.command$/
const RANDOM_HEX = /^[0-9a-f]{16}$/
// the desk the confirmation dialog fills the command for
const EXAMPLE_DESK = 'example-desk'
const ACTIVITY_MAX = 5 * 1024 * 1024
const GAP_MS = 2_000
const PER_MINUTE = 3
const MINUTE_MS = 60_000
const FALLBACK_SHELL = '/bin/zsh'
// C0, DEL, C1 and the two Unicode line breaks: a shell path holding one is not used
const SHELL_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
// shells that do not accept `-l -i -c` together: never used, even when /etc/shells lists them
const UNSUPPORTED_SHELLS = new Set(['csh', 'tcsh'])
const PLACEHOLDERS = /\{(desk|attach)\}/g
const REASONS = Object.freeze([
  'unavailable', 'bad_request', 'no_gesture', 'busy', 'no_command', 'unreachable', 'not_found', 'no_desk', 'not_on_hub', 'failed', 'terminal_failed',
])
const OFF = Object.freeze({ open: false })

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * The template filled for `desk`, or null unless the template passes validDeskCommand and `desk` is
 * a place name. `{desk}` becomes the bare name (the pattern holds no shell character and no leading
 * `-`). `{attach}` becomes `tmux attach -t '=<desk>'` quoted once more as one shell word, because
 * `ssh` joins its arguments and the remote shell parses them again.
 */
function fillDeskCommand(template, desk) {
  if (!validDeskCommand(template) || typeof desk !== 'string' || !PLACE.test(desk)) return null
  const attach = shellWord(`tmux attach -t '=${desk}'`)
  // a replacer function, so no `$` sequence in the template is ever read as a pattern
  return template.replace(PLACEHOLDERS, (_match, name) => (name === 'desk' ? desk : attach))
}

/**
 * The native confirmation's words for `command`, filled for the example desk; null for a command that
 * fails its rule. `label` is the hub's name on this Mac, shown as text only and only when it passes the
 * store's label rule.
 */
function deskConfirmation(command, label) {
  const example = fillDeskCommand(command, EXAMPLE_DESK)
  if (example === null) return null
  const where = isDeviceLabel(label) ? `, to open a desk on ${label}` : ''
  return {
    message: 'Run this in your terminal when you press Open desk?',
    detail: `${example}\n\nIt runs on this Mac, in your login shell${where}.`,
    buttons: ['Save', 'Cancel'],
  }
}

/**
 * The shell the script runs the command in: `shell` when it is an absolute path with no control
 * character that `/etc/shells` (its text, `shells`) lists exactly, else /bin/zsh. `csh` and `tcsh`
 * (by basename) are never used: they do not accept `-l -i -c` together.
 */
function loginShell(shell, shells) {
  if (typeof shell !== 'string' || !path.posix.isAbsolute(shell) || SHELL_UNSAFE.test(shell) || typeof shells !== 'string') return FALLBACK_SHELL
  const listed = shells.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'))
  return listed.includes(shell) && !UNSUPPORTED_SHELLS.has(path.posix.basename(shell)) ? shell : FALLBACK_SHELL
}

/**
 * The whole script: `exec <shell> -l -i -c <command>`, both as single-quoted shell words, so the
 * command reaches the login shell exactly as filled. `-i` as well as `-l`: a shell function the
 * template calls usually lives in .zshrc, which a login shell alone does not read.
 */
function deskScript(shell, command) {
  return [
    '#!/bin/sh',
    '# Agent Inbox: Open desk (#617)',
    `exec ${shellWord(shell)} -l -i -c ${shellWord(command)}`,
    '',
  ].join('\n')
}

/** The session from exactly one plain object holding exactly `session`, a session id; else null. */
function deskRequest(args) {
  if (!Array.isArray(args) || args.length !== 1 || !isPlainObject(args[0])) return null
  const keys = Object.keys(args[0])
  if (keys.length !== 1 || keys[0] !== 'session') return null
  const { session } = args[0]
  return typeof session === 'string' && SESSION.test(session) ? session : null
}

/** The hub's activity rows through `fetchImpl`, or null: a failed or non-200 read, a body over 5 MB, or one that is not an array. */
async function readActivity(fetchImpl, url) {
  let response
  try {
    response = await fetchImpl(url, { method: 'GET' })
  } catch {
    return null
  }
  if (!response || typeof response !== 'object') return null
  if (response.status !== 200) {
    await discard(response)
    return null
  }
  const body = await readJson(response, ACTIVITY_MAX)
  return Array.isArray(body) ? body : null
}

/**
 * Main's handler for the two desk channels. Every dependency is an option: `platform`, `hubView()`
 * (its `trusts(event)` and `takeGesture(event)`), `storedHub()`, `hubFetch()` and `hubBase(id)` (the
 * connect controller's), `scriptDir`, `terminal: { read, run }`, `now`, `randomBytes`, `userShell`,
 * `readShells`, `writeScript` and `log`. No method rejects.
 */
function createDeskOpen(options) {
  const {
    platform, hubView, storedHub, hubFetch, hubBase, scriptDir, terminal,
  } = options
  const now = options.now ?? Date.now
  const randomBytes = options.randomBytes ?? nodeRandomBytes
  const userShell = options.userShell ?? (() => null)
  const readShells = options.readShells ?? (() => '')
  const writeScript = options.writeScript ?? ((dir, name, text) => writePrivateScript({ dir, name, text, pattern: DESK_SCRIPT, now }))
  const log = (line) => {
    try {
      options.log?.(line)
    } catch {
      // a logger that throws changes nothing
    }
  }
  // the opens that passed the rate check in the last minute, and whether one is running
  const opens = []
  let inFlight = false

  const clock = () => {
    try {
      const t = now()
      return Number.isFinite(t) ? t : Number.NaN
    } catch {
      return Number.NaN
    }
  }
  const view = () => {
    try {
      return hubView() ?? null
    } catch {
      return null
    }
  }
  // the reason word is all a refusal logs: no host, no session, nothing from the hub
  const refused = (reason) => {
    log(`desk-open: ${reason}`)
    return { ok: false, reason }
  }
  // the three refusals before the gesture check log nothing: a page calling in a loop must not write a line per call
  const unlogged = (reason) => ({ ok: false, reason })

  function trusted(event) {
    const current = view()
    try {
      return current !== null && current.trusts(event) === 'hub' ? current : null
    } catch {
      return null
    }
  }

  function mayOpen(t) {
    if (!Number.isFinite(t)) return false
    while (opens.length > 0 && !(t - opens[0] < MINUTE_MS)) opens.shift()
    if (opens.length >= PER_MINUTE) return false
    return opens.length === 0 || t - opens[opens.length - 1] >= GAP_MS
  }

  async function chosenTerminal() {
    try {
      return terminalId(await terminal.read())
    } catch {
      return 'terminal'
    }
  }

  function shellFor() {
    let shell = null
    let shells = ''
    try {
      shell = userShell()
    } catch {
      shell = null
    }
    try {
      shells = readShells()
    } catch {
      shells = ''
    }
    return loginShell(shell, shells)
  }

  async function openChecked(id, session) {
    const stored = await storedHub()
    if (!isObject(stored) || stored.id !== id || !validDeskCommand(stored.deskCommand)) return refused('no_command')
    // the hub's own list, read by main through the hub fetch: never data from the page
    const base = hubBase(id)
    const fetchImpl = typeof base === 'string' ? hubFetch() : null
    if (typeof fetchImpl !== 'function') return refused('unreachable')
    const rows = await readActivity(fetchImpl, `${base}api/activity`)
    if (rows === null) return refused('unreachable')
    const row = rows.find((entry) => isObject(entry) && entry.session === session)
    if (!row) return refused('not_found')
    if (typeof row.desk !== 'string' || !PLACE.test(row.desk)) return refused('no_desk')
    const machine = typeof row.machine === 'string' && PLACE.test(row.machine) ? row.machine : null
    const hubMachine = typeof stored.machine === 'string' ? stored.machine : null
    if (machine !== null && hubMachine !== null && machine !== hubMachine) return refused('not_on_hub')
    const command = fillDeskCommand(stored.deskCommand, row.desk)
    if (command === null) return refused('failed')
    const text = deskScript(shellFor(), command)
    const chosen = await chosenTerminal()
    let random = ''
    try {
      random = Buffer.from(randomBytes(8)).toString('hex')
    } catch {
      random = ''
    }
    if (!RANDOM_HEX.test(random)) return refused('failed')
    const file = writeScript(scriptDir, `desk-${random}.command`, text)
    if (typeof file !== 'string') return refused('failed')
    const opened = await openInTerminal({ terminal: chosen, kind: 'script', target: file, run: (argv) => Promise.resolve(terminal.run(argv)) })
    if (!opened.ok) return refused('terminal_failed')
    log('desk-open: opened')
    return opened.fellBackFrom
      ? { ok: true, notice: `${terminalName(opened.fellBackFrom)} could not be opened, so Terminal was opened instead.` }
      : { ok: true }
  }

  return Object.freeze({
    /** `{ open: true }` only for the hub view's top frame on the hub's page, on macOS, with no argument, while the active hub has a valid stored command. */
    async available(event, args) {
      try {
        if (platform !== 'darwin' || !Array.isArray(args) || args.length !== 0 || trusted(event) === null) return { ...OFF }
        const stored = await storedHub()
        if (!isObject(stored) || typeof stored.id !== 'string' || !validDeskCommand(stored.deskCommand)) return { ...OFF }
        return { open: typeof hubBase(stored.id) === 'string' }
      } catch {
        return { ...OFF }
      }
    },
    /** The checks in order (see the head of this file); `{ ok: true, notice? }` or `{ ok: false, reason }`. */
    async open(event, args) {
      const current = platform === 'darwin' ? trusted(event) : null
      if (current === null) return unlogged('unavailable')
      const session = deskRequest(args)
      if (session === null) return unlogged('bad_request')
      let id = null
      try {
        id = current.takeGesture(event)
      } catch {
        id = null
      }
      if (typeof id !== 'string') return unlogged('no_gesture')
      const t = clock()
      if (inFlight || !mayOpen(t)) return refused('busy')
      inFlight = true
      opens.push(t)
      try {
        return await openChecked(id, session)
      } catch {
        return refused('failed')
      } finally {
        inFlight = false
      }
    },
  })
}

module.exports = {
  ACTIVITY_MAX,
  DESK_SCRIPT,
  EXAMPLE_DESK,
  REASONS,
  SESSION,
  createDeskOpen,
  deskConfirmation,
  deskRequest,
  deskScript,
  fillDeskCommand,
  loginShell,
}
